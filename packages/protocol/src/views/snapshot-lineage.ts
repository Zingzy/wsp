// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { WorkspaceProject, WorkspaceView } from "./workspace.js";
import { GoldenVersion, SealedImage, SealedImageCopy } from "./golden-image.js";

// --- snapshot lineage (golden manifest as the rollback UI reads it) -----------

/** Every sealed version of one golden and the head new forks use. head is null
 * while the golden has never been sealed. The manifest is the truth here, never
 * a backend snapshot listing (list() is best-effort). */
export const SnapshotLineage = z.object({
  name: z.string(),
  head: z.number().nullable(),
  versions: z.array(GoldenVersion),
});
export type SnapshotLineage = z.infer<typeof SnapshotLineage>;

/** A workspace's disk with its project loaded, snapshotted so forks start a task with the project in place and no
 * upload. `golden` is the snapshot of the golden version at the root of its lineage, whatever it was forked from, so the
 * Lineage section lists it under that version; `version` is that version's number when a manifest knows the snapshot. */
export const ProjectGolden = z.object({
  snapshotId: z.string(),
  /** Every project on the disk when it was taken, oldest import first: a snapshot is the whole machine, so a fork of
   * it starts with all of them. The snapshot is named after the one the default folder rule would start a thread in. */
  projects: z.array(WorkspaceProject),
  golden: z.string(),
  version: z.number().int().optional(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  createdAt: z.string(),
  /** The place whose provider holds the snapshot; absent on one taken before places, which is the wired provider's. */
  place: z.string().optional(),
});
export type ProjectGolden = z.infer<typeof ProjectGolden>;

/** What a project golden's removal answers: the record that left, and whether the provider had already lost the
 * snapshot rather than deleting it now. */
export const ProjectGoldenRemoved = z.object({ projectGolden: ProjectGolden, alreadyGone: z.boolean() });
export type ProjectGoldenRemoved = z.infer<typeof ProjectGoldenRemoved>;

/** A project golden as the image view lists it: the record, and its size where the place's provider lists one. */
export const SealedProjectImage = ProjectGolden.extend({ sizeBytes: z.number().optional() });
export type SealedProjectImage = z.infer<typeof SealedProjectImage>;

/** What Settings > Image and `wsp image` draw: the record, every copy at every place, the project goldens under it.
 * Beside ProjectGolden because it carries them; the rest of the image shapes sit with the golden ones above. */
export const SealedImageView = z.object({
  image: SealedImage.nullable(),
  copies: z.array(SealedImageCopy),
  projects: z.array(SealedProjectImage),
});
export type SealedImageView = z.infer<typeof SealedImageView>;

/** One part of the listing: how many snapshots and what they hold. */
export const SnapshotGroup = z.object({ count: z.number(), bytes: z.number() });
export type SnapshotGroup = z.infer<typeof SnapshotGroup>;

/** Every snapshot on the account as the provider bills it: a snapshot is a full disk image, the free GB are shared
 * by all of them, and the rest costs usdPerGbMonth from billedFrom. Sizes come from the provider's snapshot
 * listing, never from a machine's requested disk. The three groups split that sum by who made each snapshot, since
 * the account is shared and the bill is not. */
export const SnapshotStorage = z.object({
  count: z.number(),
  totalBytes: z.number(),
  freeGb: z.number(),
  usdPerGbMonth: z.number(),
  billedFrom: z.string(),
  monthlyUsd: z.number(),
  /** This host's and in use: a golden version, a project golden or a live workspace names it, or this host took it
   * inside the grace a seal needs before the manifest records it. */
  kept: SnapshotGroup,
  /** This host's mark on the name and nothing names the id: what wsp doctor offers to delete. */
  orphans: SnapshotGroup,
  /** No mark of this host: another host's or a person's own, never touched. */
  others: SnapshotGroup,
});
export type SnapshotStorage = z.infer<typeof SnapshotStorage>;

/** Rollback only moves head. Workspaces already forked keep their machines and
 * image; the field says so on the wire so no client reads it as a fleet change. */
export const SnapshotRollbackResult = z.object({
  lineage: SnapshotLineage,
  existingWorkspaces: z.literal("untouched"),
});
export type SnapshotRollbackResult = z.infer<typeof SnapshotRollbackResult>;

/** The create's own answer: the workspace, and what the runtime had to do to make room for it (a builder kept
 * after a save, stopped at the machine cap), so the person who asked reads why. Absent when nothing was stopped. */
export const WorkspaceCreateResult = z.object({ workspace: WorkspaceView, notice: z.string().optional() });
export type WorkspaceCreateResult = z.infer<typeof WorkspaceCreateResult>;
