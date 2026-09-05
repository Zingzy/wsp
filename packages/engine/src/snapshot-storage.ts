// SPDX-License-Identifier: AGPL-3.0-only
// Snapshot storage as the provider bills it, and which of a golden's versions
// retention may offer to delete.
import type { GoldenManifest, GoldenVersion, SnapshotStorage } from "@wsp/protocol";
import type { SnapshotRow, SnapshotStoragePricing } from "./machine.js";

/** The provider quotes decimal GB: a 3839352227-byte snapshot lists as 3.84 GB. */
const GB = 1e9;

export function snapshotMonthlyUsd(totalBytes: number, pricing: SnapshotStoragePricing): number {
  return Math.max(0, totalBytes / GB - pricing.freeGb) * pricing.usdPerGbMonth;
}

export function snapshotStorage(rows: readonly SnapshotRow[], pricing: SnapshotStoragePricing): SnapshotStorage {
  const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0);
  return { count: rows.length, totalBytes, ...pricing, monthlyUsd: snapshotMonthlyUsd(totalBytes, pricing) };
}

/** Versions the head and its parent, so a rollback has one step back. */
export const RETENTION_KEEP = 2;

export interface RetentionPlan {
  /** The head and the ancestors under it that stay, newest first. */
  keep: GoldenVersion[];
  /** Older ancestors nothing was forked from: what the offer deletes, oldest first. */
  drop: GoldenVersion[];
  /** Older ancestors a workspace was forked from; each stays while that workspace exists. */
  guarded: { version: GoldenVersion; workspaces: string[] }[];
  /** What the listing says the dropped snapshots hold; a snapshot the listing lacks counts as nothing. */
  freedBytes: number;
  /** The monthly cost now minus the cost once they are gone, so a drop inside the free GB saves nothing. */
  savesUsdPerMonth: number;
}

/** Ancestors are the versions at or below the head; versions above it (a rolled-back head) are neither kept nor
 * offered, since nothing was built from the head through them. */
export function retentionPlan(
  manifest: GoldenManifest,
  rows: readonly SnapshotRow[],
  forkedFrom: (snapshotId: string) => string[],
  pricing: SnapshotStoragePricing,
  keepCount = RETENTION_KEEP,
): RetentionPlan {
  const ancestors = manifest.versions.filter(v => v.version <= manifest.head).sort((a, b) => b.version - a.version);
  const keep = ancestors.slice(0, keepCount);
  const older = ancestors.slice(keepCount).reverse();
  const drop: GoldenVersion[] = [];
  const guarded: RetentionPlan["guarded"] = [];
  for (const version of older) {
    const workspaces = forkedFrom(version.snapshotId);
    if (workspaces.length > 0) guarded.push({ version, workspaces });
    else drop.push(version);
  }
  const sizeOf = (id: string): number => rows.find(r => r.id === id)?.sizeBytes ?? 0;
  const totalBytes = rows.reduce((n, r) => n + r.sizeBytes, 0);
  const freedBytes = drop.reduce((n, v) => n + sizeOf(v.snapshotId), 0);
  return { keep, drop, guarded, freedBytes, savesUsdPerMonth: snapshotMonthlyUsd(totalBytes, pricing) - snapshotMonthlyUsd(totalBytes - freedBytes, pricing) };
}
