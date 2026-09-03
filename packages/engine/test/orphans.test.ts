import { describe, expect, it } from "vitest";
import { BUILDER_IDLE_MS } from "../src/golden.js";
import { reap } from "../src/orphans.js";
import type { Machine, MachineBackend, MachineState } from "../src/machine.js";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const OLD = new Date(NOW - 11 * 60_000).toISOString();
const YOUNG = new Date(NOW - 2 * 60_000).toISOString();
const PAST_BACKSTOP = new Date(NOW - BUILDER_IDLE_MS - 60_000).toISOString();
const ME = "h_me";

type Row = { id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } };

function stubBackend(rows: Row[] | (() => Row[])) {
  const killed: string[] = [];
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
    async list() { return typeof rows === "function" ? rows() : rows; },
    async deleteSnapshot() {},
  };
  return { backend, killed };
}

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
    expect(result).toEqual({ reaped: ["orphan-old"], spared: [] });
    expect(killed).toEqual(["orphan-old"]);
  });

  const builder = (labels: Record<string, string>): Record<string, string> => ({ wsp: "1", "wsp-builder": "1", ...labels });

  it.each([
    { name: "a builder this owner recorded", row: { id: "recorded", labels: builder({ "wsp-owner": ME, createdAt: YOUNG }) }, known: true, reaped: false, spared: false },
    { name: "a builder this owner made but lost the record of", row: { id: "owned", labels: builder({ "wsp-owner": ME, createdAt: YOUNG }) }, reaped: true, spared: false },
    { name: "another owner's young builder", row: { id: "foreign", labels: builder({ "wsp-owner": "h_other", createdAt: YOUNG }) }, reaped: false, spared: true },
    { name: "another owner's builder past the backstop", row: { id: "foreign-old", labels: builder({ "wsp-owner": "h_other", createdAt: PAST_BACKSTOP }) }, reaped: false, spared: true },
    { name: "an unowned builder past the backstop", row: { id: "orphan", labels: builder({ createdAt: PAST_BACKSTOP }) }, reaped: true, spared: false },
    { name: "an unowned builder inside the backstop", row: { id: "orphan-young", labels: builder({ createdAt: YOUNG }) }, reaped: false, spared: true },
    { name: "an unowned builder whose age cannot be read", row: { id: "ageless", labels: builder({}) }, reaped: false, spared: true },
    { name: "a paused builder of unknown owner", row: { id: "paused", state: "paused" as MachineState, labels: builder({ createdAt: PAST_BACKSTOP }) }, reaped: false, spared: false },
    { name: "a poc machine wearing our labels", row: { id: "experiment", labels: builder({ poc: "p1", createdAt: PAST_BACKSTOP }) }, reaped: false, spared: false },
  ])("$name: reaped=$reaped spared=$spared", async ({ row, known, reaped, spared }) => {
    const { backend, killed } = stubBackend([{ state: "running", ...row }]);
    const result = await reap({ backend, owner: ME, knownIds: known ? [row.id] : [], now: () => NOW });
    expect(result.reaped).toEqual(reaped ? [row.id] : []);
    expect(killed).toEqual(reaped ? [row.id] : []);
    expect(result.spared.map(b => b.id)).toEqual(spared ? [row.id] : []);
  });

  it("describes a spared builder with its owner, age and hourly rate, at the listed size or the default", async () => {
    const { backend } = stubBackend([
      { id: "foreign", state: "running", labels: builder({ "wsp-owner": "h_other", createdAt: YOUNG }), size: { cpu: 4, memMb: 8192 } },
      { id: "orphan-young", state: "running", labels: builder({ createdAt: YOUNG }) },
      { id: "ageless", state: "running", labels: builder({}) },
    ]);
    const { spared } = await reap({ backend, owner: ME, knownIds: [], now: () => NOW });
    expect(spared).toEqual([
      { id: "foreign", labels: builder({ "wsp-owner": "h_other", createdAt: YOUNG }), owner: "h_other", ageMs: 2 * 60_000, rateUsdPerHour: 4 * 0.035 + 8 * 0.01 },
      { id: "orphan-young", labels: builder({ createdAt: YOUNG }), ageMs: 2 * 60_000, rateUsdPerHour: 2 * 0.035 + 4 * 0.01 },
      { id: "ageless", labels: builder({}), rateUsdPerHour: 2 * 0.035 + 4 * 0.01 },
    ]);
  });

  it("honors a custom age threshold for workspaces, not for builders", async () => {
    const { backend, killed } = stubBackend([
      { id: "young-orphan", state: "running", labels: { wsp: "1", createdAt: YOUNG } },
      { id: "young-builder", state: "running", labels: builder({ createdAt: YOUNG }) },
    ]);
    const { reaped } = await reap({ backend, owner: ME, knownIds: [], olderThanMs: 60_000, now: () => NOW });
    expect(reaped).toEqual(["young-orphan"]);
    expect(killed).toEqual(["young-orphan"]);
  });

  it("kills nothing when the listing fails", async () => {
    const { backend, killed } = stubBackend(() => { throw new Error("list 502"); });
    await expect(reap({ backend, owner: ME, knownIds: [], now: () => NOW })).rejects.toThrow("list 502");
    expect(killed).toEqual([]);
  });
});
