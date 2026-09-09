// SPDX-License-Identifier: AGPL-3.0-only
// The init job as every client reads it: wsp init's run on the host, from the
// first read of this computer through the screens, the build, the sign-ins,
// the seal and the first workspace. The terminal draws it in its six screens,
// the app in the modal behind the sidebar's cloud row, an agent over MCP as
// one object; there is one job and one view of it, and its rows and progress
// are the same numbers wherever they are shown.
import { z } from "zod";

/** How the recipe gets written: the person on the screens, or an agent's thread on this computer reading their usage. */
export const InitRoad = z.enum(["manual", "agent"]);
export type InitRoad = z.infer<typeof InitRoad>;

/** Where the job is. `agent` while the thread writes the recipe; `reading` while this computer is read; `answering`
 * while the screens wait for the person; then the build's own three stretches; `finishing` is the first workspace and
 * its import. */
export const InitPhase = z.enum(["agent", "reading", "answering", "building", "signing-in", "sealing", "finishing", "done", "failed", "cancelled"]);
export type InitPhase = z.infer<typeof InitPhase>;

/** The five screens a person answers; the sixth is the build, which the rows below draw. */
export const InitScreenId = z.enum(["agents", "tools", "also", "logins", "wsp"]);
export type InitScreenId = z.infer<typeof InitScreenId>;

export const InitChoice = z.object({ value: z.string(), label: z.string() });
export type InitChoice = z.infer<typeof InitChoice>;

/** One row of a screen, as the terminal's list draws it: a label, its size in bytes (null on a sized row nothing
 * measured, absent on a row with no size), a why between them, the group it sits under, the lines shown while it is
 * highlighted, whether its tick is locked, the words it cycles through instead of a tick when it takes an answer, and
 * on a sign-in row whose agent takes an API key, the variable the agent reads it from and whether the home holds one. */
export const InitScreenItem = z.object({
  id: z.string(),
  label: z.string(),
  size: z.number().nonnegative().nullable().optional(),
  why: z.string().optional(),
  group: z.string().optional(),
  detail: z.array(z.string()),
  lock: z.enum(["on", "off"]).optional(),
  choices: z.array(InitChoice).optional(),
  key: z.object({ name: z.string(), saved: z.boolean() }).optional(),
  /** A row's state as a word where its answer is fixed: a sign-in whose tool is off the image. */
  state: z.string().optional(),
  /** The catalog id whose mark leads the row where it is not the row's own id: a sign-in row's tool. */
  mark: z.string().optional(),
});
export type InitScreenItem = z.infer<typeof InitScreenItem>;

/** A footer line under a screen's rows, loud in a weight's colour when it carries one. */
export const InitFooterLine = z.object({ text: z.string(), tone: z.enum(["yellow", "yellowBright", "red"]).optional() });
export type InitFooterLine = z.infer<typeof InitFooterLine>;

export const InitScreen = z.object({
  id: InitScreenId,
  title: z.string(),
  top: z.string(),
  /** Where the screen sits in the six ("2/6"). */
  counter: z.string(),
  items: z.array(InitScreenItem),
  /** The rows ticked as the screen stands. */
  ticks: z.array(z.string()),
  /** Each answering row's answer, by row id. */
  answers: z.record(z.string()),
  footer: z.array(InitFooterLine),
  /** What the screen says with no rows at all. */
  empty: z.string().optional(),
  /** The noun the line under the card counts the ticked rows in ("agents", "tools"); absent on a screen with no tally. */
  tally: z.string().optional(),
});
export type InitScreen = z.infer<typeof InitScreen>;

/** What a row of the job is: a fact read off this computer while it is read, a stage of the image, a sign-in the
 * person finishes in their browser, a secret set on the machine, an agent here given the wsp tools, the first
 * workspace, the project landed on it. */
export const InitRowKind = z.enum(["fact", "stage", "sign-in", "secret", "agent", "workspace", "project"]);
export type InitRowKind = z.infer<typeof InitRowKind>;

export const InitRow = z.object({
  id: z.string(),
  kind: InitRowKind,
  /** A sign-in's tool, the catalog's sign-in row id, so a client picks its mark without reading the row id. */
  tool: z.string().optional(),
  label: z.string(),
  /** The state as a word the row prints. */
  state: z.string(),
  detail: z.string().optional(),
  /** A sign-in's page, the person's to open on this computer. */
  page: z.string().optional(),
  /** The code that page asks for, when the flow prints one. */
  code: z.string().optional(),
  /** How long the row ran, once it is over. */
  ms: z.number().optional(),
  /** A stage's latest lines, what the machine said while it ran, for the block under its row. */
  lines: z.array(z.string()).optional(),
});
export type InitRow = z.infer<typeof InitRow>;

/** Whether the host holds the provider key, never its value: the modal asks for nothing it has. The agents' keys sit
 * on the sign-ins screen's rows instead, each beside the agent that reads it. */
export const InitKeys = z.object({ solari: z.boolean() });
export type InitKeys = z.infer<typeof InitKeys>;

export const InitJob = z.object({
  id: z.string(),
  road: InitRoad,
  phase: InitPhase,
  keys: InitKeys,
  /** The screen the person is on, an index into screens; one past the last is the build's own question. Kept here so
   * a setup shut mid-step reopens where it was. */
  step: z.number().int().nonnegative(),
  /** Whether a cancel would stop the job now: not once the seal runs, since the snapshot and the save go to their end. */
  stoppable: z.boolean(),
  /** What the image's disk holds before any tick (the base and the files that travel) and the disk the build asks
   * the provider for, in bytes; absent when the provider reports no disk. */
  disk: z.object({ fixed: z.number().nonnegative(), total: z.number().positive() }).optional(),
  /** The five screens, filled once this computer is read; empty before. */
  screens: z.array(InitScreen),
  rows: z.array(InitRow),
  /** Rows over, rows in all: what the collapsed sidebar row counts. */
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  /** The tail of what the run said, the lines a terminal would have shown. */
  log: z.array(z.string()),
  /** The agent's thread, on the agent road. */
  thread: z.object({ id: z.string(), workspaceId: z.string() }).optional(),
  error: z.string().optional(),
  golden: z.object({ version: z.number().int() }).optional(),
  workspace: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type InitJob = z.infer<typeof InitJob>;

/** An agent on this computer the agent road can start: the catalog's id and name, and whether its config already
 * names the wsp tools. */
export const InitAgent = z.object({ id: z.string(), name: z.string(), configured: z.boolean() });
export type InitAgent = z.infer<typeof InitAgent>;

/** Every change to the job, as one whole view: a client draws the newest and needs no history. */
export const InitJobEvent = z.object({ type: z.literal("init.job"), job: InitJob });
export type InitJobEvent = z.infer<typeof InitJobEvent>;
