// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { WorkspaceGlyph, WorkspaceTheme } from "../workspace-look.js";
import { portCloseDetail } from "../wire/helpers.js";
import { EventAsker, WorkspacePhase, WorkspaceStatus, WorkspaceView } from "./workspace.js";

// --- workspace / port / inbox events ----------------------------------------

/** A machine this runtime now has: a create that landed, or a record the sweep restored from the provider's
 * listing. Readers that meter the machine (the awake stretch, the auto-nap window) take it as the machine coming
 * up, so a change to a record a client already holds is never this event. */
export const WorkspaceCreatedEvent = z.object({ type: z.literal("workspace.created"), workspace: WorkspaceView });
/** The awaited steps of a create in the order the runtime reaches them; `failed` ends a create that threw. */
export const WorkspaceCreateStage = z.enum(["fork-requested", "hostname-set", "preview-route", "daemon-answering", "project-cloned", "ready", "failed"]);
export type WorkspaceCreateStage = z.infer<typeof WorkspaceCreateStage>;
/** Whether a line of a create's log is the step the create is waiting on, rather than a note on a step it already
 * took. A surface with one line for the whole create shows the last of these, so a cosmetic step's verdict never
 * stands where the create's state belongs. Takes the word a line carries, since the image build's own lines share
 * that log and are steps like any other. */
export const creationAwaits = (stage: string): boolean => stage !== "hostname-set";
/** Progress of one create, from the first request to ready or failed: the id the workspace will carry, its name, one
 * plain sentence per stage, the time since the create began, and a notice when a step did something worth reading
 * (a kept builder was stopped to make room at the machine cap). */
export const WorkspaceCreatingEvent = z.object({
  type: z.literal("workspace.creating"),
  workspaceId: z.string(),
  name: z.string(),
  stage: WorkspaceCreateStage,
  message: z.string(),
  elapsedMs: z.number(),
  notice: z.string().optional(),
  /** What the machine answered this step with, for the line's title: a guest's refusal is evidence a person may
   * need and never a sentence written at them, so no surface draws it as one. */
  detail: z.string().optional(),
  /** Set on a line saying what the step the create is on waits for, in the message's words. It comes once per ask,
   * so a surface showing the step draws the newest in the step's place and never as a step of its own. */
  waiting: z.literal(true).optional(),
  /** The thread this fork was asked for by, from the first stage: a create streams stages before the workspace has
   * a record, so the stream's tree rule reads who asked off the event rather than off a record that is not there
   * yet. Absent where a person asked for the machine. */
  askedBy: EventAsker.optional(),
});
export type WorkspaceCreatingEvent = z.infer<typeof WorkspaceCreatingEvent>;
/** found is set when the provider had already paused the machine and this host only followed it: the awake
 * stretch ended at the last instant the meter saw the machine awake, not at this event. */
export const WorkspaceNappedEvent = z.object({ type: z.literal("workspace.napped"), workspaceId: z.string(), found: z.boolean().optional() });
export const WorkspaceWokenEvent = z.object({
  type: z.literal("workspace.woken"),
  workspaceId: z.string(),
  machineId: z.string(),
});
/** The machine was replaced by a fresh golden fork carrying the vault: an
 * upgrade under a new size, or a rebuild of a zombie. Clients re-dial reach. */
export const WorkspaceUpgradedEvent = z.object({
  type: z.literal("workspace.upgraded"),
  workspaceId: z.string(),
  machineId: z.string(),
});
/** A person named the workspace: its record alone changed, and every client puts the name on the row it holds. The
 * machine was not touched, so nothing that meters it reads this. */
export const WorkspaceRenamedEvent = z.object({ type: z.literal("workspace.renamed"), workspaceId: z.string(), name: z.string() });
/** A person set the workspace's theme or its glyph: the record alone changed, and both facts travel whole so a
 * client never has to merge one key into what it holds. null on either is none picked. */
export const WorkspaceLookEvent = z.object({
  type: z.literal("workspace.look"),
  workspaceId: z.string(),
  theme: WorkspaceTheme.nullable(),
  glyph: WorkspaceGlyph.nullable(),
});
export const WorkspaceDeletedEvent = z.object({ type: z.literal("workspace.deleted"), workspaceId: z.string() });
/** The provider stopped knowing the machine: the workspace's phase is gone from here until a rebuild or a delete.
 * Sessions on it ended, the rate is 0, the idle window is dropped; reason carries the provider's words. */
export const WorkspaceGoneEvent = z.object({
  type: z.literal("workspace.gone"),
  workspaceId: z.string(),
  machineId: z.string(),
  reason: z.string(),
});

export const WorkspaceStatusEvent = z.object({ type: z.literal("workspace.status"), status: WorkspaceStatus });
/** A review workspace's draft moved: read off the reviewer's reply, edited by a person, or posted. */
export const WorkspaceReviewEvent = z.object({ type: z.literal("workspace.review"), workspaceId: z.string() });

/** A person marked a file of the workspace viewed or took the mark off: every mark it now holds, by path, against the
 * blob id the file's contents had when it was marked. */
export const WorkspaceViewedEvent = z.object({ type: z.literal("workspace.viewed"), workspaceId: z.string(), viewed: z.record(z.string(), z.string()) });

/** Awake-time cost tick. Computed locally from size and elapsed running time
 * (provider billing API integration is a later plan); zero rate while napping. */
export const WorkspaceCostEvent = z.object({
  type: z.literal("workspace.cost"),
  workspaceId: z.string(),
  phase: WorkspacePhase,
  /** Current burn: the size's awake rate while running, 0 while napping. */
  rateUsdPerHour: z.number(),
  /** Total awake milliseconds behind accruedUsd since metering began; carried across host restarts. */
  awakeMs: z.number(),
  /** The awake time so far billed stretch by stretch at the rate that held over each, so a machine replaced or a
   * wake never re-prices what came before it. */
  accruedUsd: z.number(),
  at: z.string(),
});
export type WorkspaceCostEvent = z.infer<typeof WorkspaceCostEvent>;

export const PortOpenEvent = z.object({
  type: z.literal("port.open"),
  workspaceId: z.string(),
  port: z.number(),
  pid: z.number().optional(),
  /** The listener's /proc/<pid>/comm; absent when the pid or its comm is unreadable. */
  process: z.string().optional(),
});

export const PortCloseEvent = z.object({ type: z.literal("port.close"), workspaceId: z.string(), port: z.number(), ...portCloseDetail });
export const InboxFileEvent = z.object({
  type: z.literal("inbox.file"),
  workspaceId: z.string(),
  path: z.string(),
  bytes: z.number(),
});
