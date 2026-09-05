// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenManifest, GoldenVersion } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { retentionPlan, snapshotStorage } from "../src/snapshot-storage.js";
import { SNAPSHOT_STORAGE } from "../src/solari-backend.js";

const GB = 1e9;
const row = (id: string, gb: number) => ({ id, sizeBytes: gb * GB });
const version = (n: number, parent?: number): GoldenVersion => ({ version: n, snapshotId: `snap_v${n}`, baseTemplate: "base", setupSha: "s", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 }, ...(parent !== undefined ? { parentSnapshotId: `snap_v${parent}` } : {}) });
/** Versions sealed before parents were recorded: a linear chain by number. */
const manifest = (head: number, ...versions: number[]): GoldenManifest => ({ head, versions: versions.map(n => version(n)) });
/** Versions with their recorded parents, [version, parent]. */
const chained = (head: number, ...links: [number, number | undefined][]): GoldenManifest => ({ head, versions: links.map(([n, p]) => version(n, p)) });
const nobody = (): string[] => [];

describe("snapshot storage", () => {
  it("counts every snapshot on the account and bills the GB past the free tier at the published rate", () => {
    const s = snapshotStorage([row("a", 7.8), row("b", 8.5), row("c", 20), row("d", 3.84)], SNAPSHOT_STORAGE);
    expect(s.count).toBe(4);
    expect(s.totalBytes).toBe(40.14 * GB);
    expect(s.monthlyUsd).toBeCloseTo((40.14 - 10) * 0.05, 6);
    expect(s).toMatchObject({ freeGb: 10, usdPerGbMonth: 0.05, billedFrom: "2026-10-01" });
  });

  it("inside the free tier the monthly cost is zero, never negative", () => {
    expect(snapshotStorage([row("a", 7.8)], SNAPSHOT_STORAGE).monthlyUsd).toBe(0);
    expect(snapshotStorage([], SNAPSHOT_STORAGE)).toMatchObject({ count: 0, totalBytes: 0, monthlyUsd: 0 });
  });
});

describe("retention plan", () => {
  const rows = [row("snap_v1", 7.8), row("snap_v2", 8), row("snap_v3", 8.2), row("snap_v4", 8.5)];

  it("keeps the head and its recorded parent and offers the older ancestors oldest first, with what they hold and save", () => {
    const plan = retentionPlan(chained(4, [1, undefined], [2, 1], [3, 2], [4, 3]), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([4, 3]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 2]);
    expect(plan.guarded).toEqual([]);
    expect(plan.parentAssumed).toBe(false);
    expect(plan.freedBytes).toBe(15.8 * GB);
    // 32.5 GB billed at 22.5 over the free tier; 16.7 GB left bills 6.7 over it.
    expect(plan.savesUsdPerMonth).toBeCloseTo(15.8 * 0.05, 6);
  });

  it("after a rollback and an update the head keeps the version it was built from, not the one rolled back from, and the rest of that branch is left alone", () => {
    // v1 to v4, head rolled back to v2, then an update seals v5 from v2.
    const plan = retentionPlan(chained(5, [1, undefined], [2, 1], [3, 2], [4, 3], [5, 2]), [...rows, row("snap_v5", 9)], nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([5, 2]);
    expect(plan.drop.map(v => v.version)).toEqual([1]);
    expect(plan.parentAssumed).toBe(false);
  });

  it("versions sealed before parents were recorded chain by number, and the offer knows the kept parent was assumed", () => {
    const plan = retentionPlan(manifest(4, 1, 2, 3, 4), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([4, 3]);
    expect(plan.drop.map(v => v.version)).toEqual([1, 2]);
    expect(plan.parentAssumed).toBe(true);
    // A recorded parent on the head alone settles the kept pair; the older hops still chain by number.
    const mixed = retentionPlan(chained(5, [1, undefined], [2, undefined], [3, undefined], [4, undefined], [5, 2]), rows, nobody, SNAPSHOT_STORAGE);
    expect(mixed.keep.map(v => v.version)).toEqual([5, 2]);
    expect(mixed.drop.map(v => v.version)).toEqual([1]);
    expect(mixed.parentAssumed).toBe(false);
  });

  it("a recorded parent no longer in the manifest ends the chain: the head alone is kept and nothing is offered", () => {
    const plan = retentionPlan(chained(3, [1, undefined], [3, 9]), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([3]);
    expect(plan.drop).toEqual([]);
    expect(plan.parentAssumed).toBe(false);
  });

  it("a drop that lands inside the free GB saves nothing, and the parent is the next version down whatever its number", () => {
    const plan = retentionPlan(manifest(4, 1, 2, 4), [row("snap_v1", 3), row("snap_v2", 3), row("snap_v4", 3)], nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([4, 2]);
    expect(plan.drop.map(v => v.version)).toEqual([1]);
    expect(plan.freedBytes).toBe(3 * GB);
    expect(plan.savesUsdPerMonth).toBe(0);
  });

  it("never offers a version a workspace was forked from; it is named with the workspaces on it", () => {
    const forkedFrom = (id: string): string[] => (id === "snap_v1" ? ["alpha", "beta"] : []);
    const plan = retentionPlan(manifest(4, 1, 2, 3, 4), rows, forkedFrom, SNAPSHOT_STORAGE);
    expect(plan.drop.map(v => v.version)).toEqual([2]);
    expect(plan.guarded.map(g => [g.version.version, g.workspaces])).toEqual([[1, ["alpha", "beta"]]]);
    expect(plan.freedBytes).toBe(8 * GB);
  });

  it("with two versions or fewer there is nothing to offer", () => {
    const plan = retentionPlan(manifest(2, 1, 2), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([2, 1]);
    expect(plan.drop).toEqual([]);
    expect(plan.savesUsdPerMonth).toBe(0);
  });

  it("after a rollback alone the versions above the head are neither kept nor offered", () => {
    const plan = retentionPlan(manifest(2, 1, 2, 3, 4), rows, nobody, SNAPSHOT_STORAGE);
    expect(plan.keep.map(v => v.version)).toEqual([2, 1]);
    expect(plan.drop).toEqual([]);
  });

  it("a snapshot the listing does not carry counts as holding nothing", () => {
    const plan = retentionPlan(manifest(3, 1, 2, 3), [row("snap_v2", 8), row("snap_v3", 8)], nobody, SNAPSHOT_STORAGE);
    expect(plan.drop.map(v => v.version)).toEqual([1]);
    expect(plan.freedBytes).toBe(0);
    expect(plan.savesUsdPerMonth).toBe(0);
  });
});
