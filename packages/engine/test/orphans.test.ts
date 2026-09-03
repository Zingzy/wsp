import { describe, expect, it } from "vitest";
import { BUILDER_IDLE_MS } from "../src/golden.js";
import { reap } from "../src/orphans.js";
import type { Machine, MachineBackend, MachineState } from "../src/machine.js";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const OLD = new Date(NOW - 11 * 60_000).toISOString();
const YOUNG = new Date(NOW - 2 * 60_000).toISOString();
const PAST_BACKSTOP = new Date(NOW - BUILDER_IDLE_MS - 60_000).toISOString();
const ME = "h_me";
const RATE = 2 * 0.035 + 4 * 0.01;

type Row = { id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } };

function stubBackend(rows: Row[] | (() => Row[])) {
  const killed: string[] = [];
  let listed = 0;
  const backend: MachineBackend = {
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true, containers: true },
    pricing: { rateUsdPerHour: (s: { cpu: number; memMb: number }) => s.cpu * 0.035 + (s.memMb / 1024) * 0.01, defaultSize: { cpu: 2, memMb: 4096 } },
    async create() { throw new Error("unused"); },
    async get(id) {
      return {
        id, kind: "sandbox", streamUrl: undefined,
        exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        snapshot: async () => "s", pause: async () => {}, resume: async () => {},
        kill: async () => { killed.push(id); },
        state: async () => "running" as const,
        downloadUrl: async () => "u", uploadUrl: async () => "u",
      } satisfies Machine;
    },
    async list() { listed++; return typeof rows === "function" ? rows() : rows; },
    async deleteSnapshot() {},
  };
  return { backend, killed, listed: () => listed };
}

const builder = (labels: Record<string, string>): Record<string, string> => ({ wsp: "1", "wsp-builder": "1", ...labels });
const workspace = (labels: Record<string, string>): Record<string, string> => ({ wsp: "1", ...labels });

describe("orphan reaper", () => {
  it("kills only unknown, wsp-labeled, running machines older than 10 min", async () => {
    const { backend, killed } = stubBackend([
      { id: "claimed", state: "running", labels: { wsp: "1", createdAt: OLD } },
      { id: "orphan-old", state: "running", labels: { wsp: "1", createdAt: OLD } },
      { id: "orphan-young", state: "running", labels: { wsp: "1", createdAt: YOUNG } },
      { id: "foreign", state: "running", labels: { poc: "ttl-test", createdAt: OLD } },
      { id: "unlabeled", state: "running", labels: {} },
      { id: "napping", state: "paused", labels: { wsp: "1", createdAt: OLD } },
      { id: "ageless", state: "running", labels: { wsp: "1" } },
    ]);
    const result = await reap({ backend, owner: ME, knownIds: ["claimed"], now: () => NOW });
    expect(result.reaped).toEqual([{ id: "orphan-old", labels: { wsp: "1", createdAt: OLD }, builder: false, reason: "orphan", ageMs: 11 * 60_000 }]);
    expect(result.spared.map(s => s.id)).toEqual(["orphan-young", "ageless"]);
    expect(killed).toEqual(["orphan-old"]);
  });

  it.each([
    // builders: own dies at any age, none dies past the six-hour backstop, foreign never
    { name: "a builder this owner recorded", row: { id: "recorded", labels: builder({ "wsp-owner": ME, createdAt: YOUNG }) }, known: true, verdict: "kept" },
    { name: "a builder this owner is still creating", row: { id: "inflight", labels: builder({ "wsp-owner": ME }) }, known: true, verdict: "kept" },
    { name: "a builder this owner made but lost the record of", row: { id: "owned", labels: builder({ "wsp-owner": ME, createdAt: YOUNG }) }, verdict: "own" },
    { name: "a builder this owner made, record and createdAt both gone", row: { id: "owned-ageless", labels: builder({ "wsp-owner": ME }) }, verdict: "own" },
    { name: "another owner's young builder", row: { id: "foreign", labels: builder({ "wsp-owner": "h_other", createdAt: YOUNG }) }, verdict: "spared" },
    { name: "another owner's builder past the backstop", row: { id: "foreign-old", labels: builder({ "wsp-owner": "h_other", createdAt: PAST_BACKSTOP }) }, verdict: "spared" },
    { name: "an unowned builder past the backstop", row: { id: "orphan", labels: builder({ createdAt: PAST_BACKSTOP }) }, verdict: "orphan" },
    { name: "an unowned builder inside the backstop", row: { id: "orphan-young", labels: builder({ createdAt: YOUNG }) }, verdict: "spared" },
    { name: "an unowned builder whose age cannot be read", row: { id: "ageless", labels: builder({}) }, verdict: "spared" },
    { name: "an unowned builder whose createdAt is garbage", row: { id: "garbage", labels: builder({ createdAt: "yesterday" }) }, verdict: "spared" },
    { name: "a paused builder of unknown owner", row: { id: "paused", state: "paused" as MachineState, labels: builder({ createdAt: PAST_BACKSTOP }) }, verdict: "kept" },
    { name: "a poc machine wearing our labels, owner included", row: { id: "experiment", labels: builder({ poc: "p1", "wsp-owner": ME, createdAt: PAST_BACKSTOP }) }, verdict: "kept" },
    // non-builders: own and none die past ten minutes, foreign never
    { name: "a workspace this owner made, past ten minutes", row: { id: "own-ws-old", labels: workspace({ "wsp-owner": ME, createdAt: OLD }) }, verdict: "own" },
    { name: "a workspace this owner made, inside ten minutes", row: { id: "own-ws-young", labels: workspace({ "wsp-owner": ME, createdAt: YOUNG }) }, verdict: "spared" },
    { name: "a workspace this owner made with a garbage createdAt", row: { id: "own-ws-garbage", labels: workspace({ "wsp-owner": ME, createdAt: "yesterday" }) }, verdict: "spared" },
    { name: "another owner's workspace past ten minutes", row: { id: "foreign-ws", labels: workspace({ "wsp-owner": "h_other", createdAt: PAST_BACKSTOP }) }, verdict: "spared" },
    { name: "an unowned workspace past ten minutes", row: { id: "orphan-ws", labels: workspace({ createdAt: OLD }) }, verdict: "orphan" },
    { name: "an unowned workspace inside ten minutes", row: { id: "orphan-ws-young", labels: workspace({ createdAt: YOUNG }) }, verdict: "spared" },
    { name: "an unowned workspace with a garbage createdAt", row: { id: "orphan-ws-garbage", labels: workspace({ createdAt: "yesterday" }) }, verdict: "spared" },
    { name: "a poc workspace wearing our owner", row: { id: "experiment-ws", labels: workspace({ poc: "p1", "wsp-owner": ME, createdAt: OLD }) }, verdict: "kept" },
  ])("$name: $verdict", async ({ row, known, verdict }) => {
    const { backend, killed } = stubBackend([{ state: "running", ...row }]);
    const result = await reap({ backend, owner: ME, knownIds: known ? [row.id] : [], now: () => NOW });
    const dies = verdict === "own" || verdict === "orphan";
    expect(killed).toEqual(dies ? [row.id] : []);
    expect(result.reaped.map(r => [r.id, r.reason])).toEqual(dies ? [[row.id, verdict]] : []);
    expect(result.spared.map(s => s.id)).toEqual(verdict === "spared" ? [row.id] : []);
  });

  it("describes a spared machine with whose it is, its age, its backstop and the rate at the listed size or the default", async () => {
    const { backend } = stubBackend([
      { id: "foreign", state: "running", labels: builder({ "wsp-owner": "h_other", createdAt: YOUNG }), size: { cpu: 4, memMb: 8192 } },
      { id: "orphan-young", state: "running", labels: builder({ createdAt: YOUNG }) },
      { id: "ageless", state: "running", labels: builder({}) },
      { id: "own-ws", state: "running", labels: workspace({ "wsp-owner": ME, createdAt: YOUNG }) },
    ]);
    const { spared } = await reap({ backend, owner: ME, knownIds: [], now: () => NOW });
    expect(spared).toEqual([
      { id: "foreign", labels: builder({ "wsp-owner": "h_other", createdAt: YOUNG }), builder: true, whose: "foreign", owner: "h_other", ageMs: 2 * 60_000, backstopMs: BUILDER_IDLE_MS, rateUsdPerHour: 4 * 0.035 + 8 * 0.01 },
      { id: "orphan-young", labels: builder({ createdAt: YOUNG }), builder: true, whose: "none", ageMs: 2 * 60_000, backstopMs: BUILDER_IDLE_MS, rateUsdPerHour: RATE },
      { id: "ageless", labels: builder({}), builder: true, whose: "none", backstopMs: BUILDER_IDLE_MS, rateUsdPerHour: RATE },
      { id: "own-ws", labels: workspace({ "wsp-owner": ME, createdAt: YOUNG }), builder: false, whose: "own", owner: ME, ageMs: 2 * 60_000, backstopMs: 10 * 60_000, rateUsdPerHour: RATE },
    ]);
  });

  it("honors a custom age threshold for workspaces, not for builders", async () => {
    const { backend, killed } = stubBackend([
      { id: "young-orphan", state: "running", labels: { wsp: "1", createdAt: YOUNG } },
      { id: "young-builder", state: "running", labels: builder({ createdAt: YOUNG }) },
    ]);
    const { reaped, spared } = await reap({ backend, owner: ME, knownIds: [], olderThanMs: 60_000, now: () => NOW });
    expect(reaped.map(r => r.id)).toEqual(["young-orphan"]);
    expect(spared.map(s => [s.id, s.backstopMs])).toEqual([["young-builder", BUILDER_IDLE_MS]]);
    expect(killed).toEqual(["young-orphan"]);
  });

  it("kills nothing when the listing fails", async () => {
    const { backend, killed } = stubBackend(() => { throw new Error("list 502"); });
    await expect(reap({ backend, owner: ME, knownIds: [], now: () => NOW })).rejects.toThrow("list 502");
    expect(killed).toEqual([]);
  });

  it("refuses an empty owner before listing anything", async () => {
    const { backend, killed, listed } = stubBackend([{ id: "orphan-young", state: "running", labels: builder({ createdAt: YOUNG }) }]);
    await expect(reap({ backend, owner: "", knownIds: [], now: () => NOW })).rejects.toThrow("owner id");
    expect(listed()).toBe(0);
    expect(killed).toEqual([]);
  });
});
