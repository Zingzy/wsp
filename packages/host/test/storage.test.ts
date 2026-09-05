// SPDX-License-Identifier: AGPL-3.0-only
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { describe, expect, it } from "vitest";
import { describeRetention, describeStorage, retentionOffer } from "../src/storage.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const GB = 1e9;
const PRICING = { freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" };
const version = (n: number) => ({ version: n, snapshotId: `snap_golden-v${n}`, baseTemplate: "base", setupSha: `sha${n}`, createdAt: `2026-08-${10 + n}T00:00:00.000Z`, smoke: { cmd: "true", exitCode: 0 } });

describe("the storage line", () => {
  it("says the count, the size the listing reports and the monthly cost above the free GB at the published rate", () => {
    expect(describeStorage({ count: 6, totalBytes: 49.8 * GB, ...PRICING, monthlyUsd: 39.8 * 0.05 })).toBe("storage: 6 snapshots, 49.8 GB; about $1.99/month above the free 10 GB from 2026-10-01");
  });

  it("inside the free GB it says there is nothing to pay, and one snapshot is singular", () => {
    expect(describeStorage({ count: 1, totalBytes: 7.8 * GB, ...PRICING, monthlyUsd: 0 })).toBe("storage: 1 snapshot, 7.8 GB; inside the free 10 GB, nothing to pay from 2026-10-01");
  });
});

describe("the retention line", () => {
  it("names what goes, what it holds, what it saves and what stays, in one line", () => {
    const plan = { keep: [version(4), version(3)], drop: [version(1), version(2)], guarded: [], freedBytes: 15.8 * GB, savesUsdPerMonth: 15.8 * 0.05 };
    expect(describeRetention(plan, PRICING)).toBe("Delete golden v1 and v2, 15.8 GB, saving about $0.79/month from 2026-10-01? v4 and v3 stay.");
  });

  it("a drop inside the free GB says nothing is saved yet; three versions read as a list", () => {
    const plan = { keep: [version(5), version(4)], drop: [version(1), version(2), version(3)], guarded: [], freedBytes: 3 * GB, savesUsdPerMonth: 0 };
    expect(describeRetention(plan, PRICING)).toBe("Delete golden v1, v2 and v3, 3.0 GB, inside the free 10 GB, so nothing saved yet? v5 and v4 stay.");
  });
});

describe("the retention offer over the stub backend", () => {
  /** Four sealed versions, sized as the listing reports them, and the streams wsp init would ask on. */
  async function golden(): Promise<{ rt: Runtime; backend: StubBackend; input: PassThrough; output: PassThrough; text: () => string; press: (k: string) => Promise<void> }> {
    const store = memoryStore();
    const backend = stubBackend();
    await store.put("goldens", "default", { head: 4, versions: [1, 2, 3, 4].map(version) });
    for (const n of [1, 2, 3, 4]) backend.snapshots.push({ id: `snap_golden-v${n}`, sizeBytes: (7 + n) * GB });
    const rt = createRuntime({ backend, store, adapters: {} });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    const press = async (k: string): Promise<void> => {
      input.write(k);
      await new Promise(r => setTimeout(r, 5));
    };
    return { rt, backend, input, output, text: () => stripVTControlCharacters(chunks.join("")), press };
  }
  const streams = (g: { input: PassThrough; output: PassThrough }): { input: PassThrough; output: PassThrough } => ({ input: g.input, output: g.output });

  it("under --yes the line is printed, taken as yes, the older ancestors are deleted, and the storage line follows", async () => {
    const g = await golden();
    await retentionOffer({ rt: g.rt, interactive: false, yes: true, ...streams(g) });
    const out = g.text();
    expect(out).toContain("Delete golden v1 and v2, 17.0 GB, saving about $0.85/month from 2026-10-01? v4 and v3 stay. Taken as yes (--yes).");
    expect(out).toContain("Deleted golden v1 and v2.");
    expect(out).toContain("storage: 2 snapshots, 21.0 GB; about $0.55/month above the free 10 GB from 2026-10-01");
    expect(g.backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v3", "snap_golden-v4"]);
    expect((await g.rt.golden.get())!.versions.map(v => v.version)).toEqual([3, 4]);
  });

  it("a version a running or paused workspace was forked from is named and never offered", async () => {
    const g = await golden();
    const alpha = await g.rt.workspaces.create({ golden: "snap_golden-v1", name: "alpha" });
    await g.rt.workspaces.nap(alpha.id);
    await retentionOffer({ rt: g.rt, interactive: false, yes: false, ...streams(g) });
    const out = g.text();
    expect(out).toContain("Golden v1 stays: workspace alpha was forked from it.");
    expect(out).toContain("Delete golden v2, 9.0 GB, saving about $0.45/month from 2026-10-01? v4 and v3 stay. Taken as yes (no terminal).");
    expect(g.backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v1", "snap_golden-v3", "snap_golden-v4"]);
    expect((await g.rt.golden.get())!.versions.map(v => v.version)).toEqual([1, 3, 4]);
  });

  it("interactive: No keeps every version; y deletes", async () => {
    const g = await golden();
    const asked = retentionOffer({ rt: g.rt, interactive: true, yes: false, ...streams(g) });
    await new Promise(r => setTimeout(r, 20));
    // The prompt wraps the question to the terminal's width.
    expect(g.text()).toContain("Delete golden v1 and v2, 17.0 GB, saving about $0.85/month from 2026-10-01?");
    expect(g.text()).toContain("v4 and v3 stay.");
    expect(g.text()).toContain("No keeps every version.");
    await g.press("n");
    await asked;
    expect(g.text()).toContain("Every golden version is kept.");
    expect(g.backend.snapshots).toHaveLength(4);

    const again = retentionOffer({ rt: g.rt, interactive: true, yes: false, ...streams(g) });
    await new Promise(r => setTimeout(r, 20));
    await g.press("y");
    await again;
    expect(g.text()).toContain("Deleted golden v1 and v2.");
    expect(g.backend.snapshots.map(r => r.id)).toEqual(["snap_golden-v3", "snap_golden-v4"]);
  });

  it("with two versions, or a backend that cannot list snapshots, nothing is said", async () => {
    const g = await golden();
    await g.rt.golden.prune();
    await retentionOffer({ rt: g.rt, interactive: false, yes: true, ...streams(g) });
    expect(g.text()).toBe("");
    const bare = stubBackend();
    const { listSnapshots: _l, ...rest } = bare;
    const rt = createRuntime({ backend: { ...rest, capabilities: { ...bare.capabilities, snapshotListing: false } }, store: memoryStore(), adapters: {} });
    await retentionOffer({ rt, interactive: false, yes: true, ...streams(g) });
    expect(g.text()).toBe("");
  });

  it("a listing the provider refuses keeps every version and says so", async () => {
    const g = await golden();
    g.backend.listSnapshots = async () => {
      throw new Error("502 Bad Gateway");
    };
    await retentionOffer({ rt: g.rt, interactive: false, yes: true, ...streams(g) });
    expect(g.text()).toContain("Snapshot storage was not read (502 Bad Gateway); every golden version is kept.");
    expect((await g.rt.golden.get())!.versions).toHaveLength(4);
  });
});
