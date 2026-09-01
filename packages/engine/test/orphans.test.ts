import { describe, expect, it } from "vitest";
import { reap } from "../src/orphans.js";
import type { Machine, MachineBackend, MachineState } from "../src/machine.js";

const NOW = Date.parse("2026-09-01T12:00:00Z");
const OLD = new Date(NOW - 11 * 60_000).toISOString();
const YOUNG = new Date(NOW - 2 * 60_000).toISOString();

function stubBackend(rows: { id: string; state: MachineState; labels: Record<string, string> }[]) {
  const killed: string[] = [];
  const backend: MachineBackend = {
    capabilities: { liveCloneForks: true, ramPreservingPause: true, resize: true, previewUrls: true, signedUrls: true },
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
    async list() { return rows; },
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
    const reaped = await reap({ backend, knownIds: ["claimed"], now: () => NOW });
    expect(reaped).toEqual(["orphan-old"]);
    expect(killed).toEqual(["orphan-old"]);
  });

  it("honors a custom age threshold", async () => {
    const { backend, killed } = stubBackend([
      { id: "young-orphan", state: "running", labels: { wsp: "1", createdAt: YOUNG } },
    ]);
    const reaped = await reap({ backend, knownIds: [], olderThanMs: 60_000, now: () => NOW });
    expect(reaped).toEqual(["young-orphan"]);
    expect(killed).toEqual(["young-orphan"]);
  });
});
