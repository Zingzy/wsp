// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { effortsFor, everyModel, markedDefault, modelOf } from "../harness-picks.js";
import { AccessChoice } from "../thread-defaults.js";
import { listed } from "../wire/helpers.js";
import { WorkspaceOut } from "./workspace.js";

// --- harness catalog (what the composer's pickers may offer) -------------------

/** One value a harness's CLI accepts for a picker, as the CLI spells it; the label is what the picker shows. */
export const HarnessOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  /** What a picker's button says once this option is picked, where the label says more than a button has room for
   * (a mode named after the machine it touches); the menu row keeps the label. Absent, the button says the label. */
  short: z.string().optional(),
});
export type HarnessOption = z.infer<typeof HarnessOption>;

/** A model, with the subset of the catalog's efforts and context windows it takes; a list absent means all of them,
 * empty means the model takes none and the composer hides that section for it. */
export const HarnessModel = HarnessOption.extend({
  efforts: z.array(z.string()).optional(),
  /** The effort this model runs at when a turn names none, where the binary reports one per model rather than one
   * for the harness; read through effortsFor, which falls back to the catalog's own mark. */
  defaultEffort: z.string().optional(),
  contextWindows: z.array(z.string()).optional(),
  /** The model has a faster output the CLI turns on per turn; the composer offers Fast only on a model marked so. */
  fast: z.boolean().optional(),
  /** An id the person added by hand that this list did not carry. */
  added: z.literal(true).optional(),
});
export type HarnessModel = z.infer<typeof HarnessModel>;

export const HarnessCatalogSource = z.enum(["harness", "table"]);
export type HarnessCatalogSource = z.infer<typeof HarnessCatalogSource>;

/** Where wsp keeps the control one of a CLI's screen-only commands stands for: its sign-in road, the composer's model
 * and access pickers, wsp's own settings and docs. The composer's line for the command is written per control. */
export const ScreenControl = z.enum(["sign-in", "model", "access", "settings", "docs"]);
export type ScreenControl = z.infer<typeof ScreenControl>;
/** A command of a CLI that works only in its own interactive terminal, by name without its slash, and the wsp control
 * that serves the same intent. */
export const ScreenCommand = z.object({ name: z.string(), control: ScreenControl });
export type ScreenCommand = z.infer<typeof ScreenCommand>;

/** What one harness's CLI takes at launch. A list is empty when the CLI has no such flag or its values are open,
 * and the composer hides that picker; sessions.start refuses a value a non-empty list does not carry and passes any
 * value through where the list is empty. source says whether the binary on the workspace's machine answered or the
 * runtime's table stood in, and version is the binary's, else that harness's own table pin. */
export const HarnessCatalog = z.object({
  harness: z.string(),
  label: z.string(),
  source: HarnessCatalogSource,
  version: z.string().nullable(),
  models: z.array(HarnessModel),
  /** Older models the CLI still runs by name, which the composer keeps under a fold at the end of the model menu; a
   * start takes one as it takes a model above. Read models and these together through everyModel. Absent is none. */
  legacyModels: z.array(HarnessModel).optional(),
  /** Whether the binary's own answer names its legacy models too, as Codex's model/list does, so one a live answer
   * leaves out is one it no longer runs; absent, the answer is the binary's current set and legacy models run by name. */
  legacyListed: z.boolean().optional(),
  /** Models the person took off this agent's picker, which the composer does not list and a start still takes by
   * name; read with the rest through everyModel. Absent is none. */
  hiddenModels: z.array(HarnessModel).optional(),
  /** The agent's own lists as they stood before the person's picker shaped the ones above and their defaults moved
   * the marks, so a client shaping a change, or reading what a reset falls back to, before the host answers puts each
   * model and mark where the host will. Absent where the person set nothing for this agent or its project. */
  unshaped: z.object({ models: z.array(HarnessModel), legacyModels: z.array(HarnessModel).optional(), efforts: z.array(HarnessOption), permissionModes: z.array(HarnessOption) }).optional(),
  efforts: z.array(HarnessOption),
  contextWindows: z.array(HarnessOption),
  permissionModes: z.array(HarnessOption),
  /** Whether a running turn of this harness takes a message (sessions.steer); false where the runtime's table alone
   * answers, since only the adapter on a machine knows. The composer picks send-now's road from this before the click. */
  steers: z.boolean(),
  /** Whether a person's name for one of this harness's sessions survives in the harness's own store (sessions.rename);
   * false where the runtime's table alone answers, since only the adapter on a machine knows. Read it through
   * keepsRename, which reads a table row as no answer rather than as a no. */
  renames: z.boolean(),
  /** Whether a message to this harness may carry an image; false where the runtime's table alone answers, since only
   * the adapter on a machine knows. Read it through readsImages, which reads a table row as no answer rather than as
   * a no: the composer offers the picker and the runtime answers with the agent's name if it turns out to read none. */
  images: z.boolean(),
  /** Whether wsp can hand this harness's launch an MCP server. Unlike the three above this is decided by the
   * adapter in this host and by no binary on a machine, so the table's own row is the answer and a caller may read
   * it before any workspace exists; a runtime test pins every row to its adapter's declaration. Read it through
   * takesMcpServers: absent is a no, since a catalog from before the field was declared knew of no such road. */
  mcpServers: z.boolean().optional(),
  /** This CLI's commands that work only in its own terminal, which a headless turn answers are not available. Like
   * mcpServers this is the adapter's own declaration and no binary's, so a table row is the answer and a client reads
   * it before any machine exists; absent is none. The composer lists none of them and sends nothing for one. */
  screenCommands: z.array(ScreenCommand).optional(),
  /** Whether an access picked while a turn of this harness runs reaches that turn. The adapter in this host declares
   * it, as with mcpServers, so the picker says what a pick does to the turn in front of the person before the pick
   * rather than under the box after it. Read it through movesRunningAccess: absent is a no. */
  movesAccess: z.boolean().optional(),
  /** Whether a person may ask this harness a question beside a thread (sessions.aside), answered on a copy of the
   * thread's session that nothing keeps. The adapter in this host declares it, as with mcpServers; absent is a no. */
  asides: z.boolean().optional(),
  /** The message that has this harness compact its own thread's context, run as a turn like any other message; the
   * adapter in this host declares it, as with mcpServers. Absent where wsp has no road to the agent's own compaction,
   * and nothing offers one. */
  compacts: z.string().optional(),
  /** Whether rewinding a thread of this harness cuts its conversation too, in the harness's own history; absent is a
   * no, and a rewind there puts back the files alone while the harness keeps every turn it ran. */
  rewindsConversation: z.boolean().optional(),
  /** Whether a rewind of this harness's thread cuts its conversation at a reply that named no anchor too, by counting
   * the turns after it in the harness's own history; absent is a no, and such a reply offers its files alone. */
  rewindsByCount: z.boolean().optional(),
  /** Set on the harness a start without one runs, so a client can pick its list without the catalog package. */
  isDefault: z.boolean().optional(),
  /** Why the binary described nothing, in its own adapter's words, when it ran and refused for a reason it can name
   * (no sign-in); absent when it simply did not answer, and on a catalog the binary filled. */
  refusal: z.string().optional(),
  /** The slug of the cheapest model this harness offers, the one a thread's title is asked of; it rides the row so a
   * harness added to the table names its own. Absent where the harness offers no model of its own, and the title
   * question runs on whatever the CLI would run without one. */
  smallModel: z.string().optional(),
  /** This CLI's mode that runs every tool without asking anyone, as it spells it, which the table marks as the mode a
   * thread starts at where nobody set another. Absent on a harness whose CLI has no such mode. */
  bypassMode: z.string().optional(),
  /** This CLI's mode that changes nothing, as it spells it, which a reviewer runs at: absent on a harness wsp can give
   * no read-only access, which reviews nothing. */
  readOnlyMode: z.string().optional(),
  /** Which of this CLI's own modes each of wsp's access words stands for. A word the row leaves out is one this agent
   * cannot take, refused where it is set and never stood in for by a looser mode; absent maps none. */
  access: z.record(AccessChoice, z.string()).optional(),
});
export type HarnessCatalog = z.infer<typeof HarnessCatalog>;

/** What a start or a review answers: the workspace it made, and the thread it opened there. */
export const StartResult = z.object({ workspace: z.lazy(() => WorkspaceOut), threadId: z.string(), sessionId: z.string() });
export type StartResult = z.infer<typeof StartResult>;
/** What a posted review answers: its page, the comments that went on lines, and those put into the body. */
export const ReviewPostResult = z.object({ url: z.string(), number: z.number().int().nonnegative(), comments: z.number().int().nonnegative(), folded: z.number().int().nonnegative() });
export type ReviewPostResult = z.infer<typeof ReviewPostResult>;

/** An MCP server as every agent's config names it and as a launch may carry it: the program and its arguments, run
 * over stdio. The catalog's config writers, the adapters that hand a server to a turn and the install that writes
 * one into a config file all read this shape, and none of them may import another, so it lives here. */
export interface McpServerSpec {
  command: string;
  args: readonly string[];
  /** The wsp server of a thread another thread started, which has no slate: the launch says nothing of one. Read by
   * the adapter that builds the launch and never put on its line, which a box's older wsp would refuse. */
  noSlate?: true;
}

/** What a start that names MCP servers for a harness whose adapter renders none for its CLI is refused with. The
 * servers cannot be dropped quietly: a thread launched without them looks like an agent that ignored the tools it
 * was told to call, which is the whole fault the cloud setup's own thread had. */
export function noMcpServersLine(harness: string): string {
  return `${harness} takes no MCP server with a launch, so its thread would run without them; open the thread on an agent that takes them`;
}

/** Why these servers cannot go to this agent's thread, or null when they can. Every road that hands a launch a
 * server asks this before a machine is asked for anything: the caller that picks the agent, and the runtime again
 * before the turn. `takes` is the adapter's own declaration. */
export function mcpServersBlocked(servers: Readonly<Record<string, McpServerSpec>> | undefined, takes: true | undefined, harness: string): string | null {
  if (servers === undefined || Object.keys(servers).length === 0) return null;
  return takes === true ? null : noMcpServersLine(harness);
}

/** Whether a rename of one of this harness's sessions is kept in its own store, as far as this catalog knows. The
 * answer is the adapter's on the machine, so a row the runtime's table stood in for is not a no: a client offers the
 * rename and the runtime answers unsupported if the adapter turns out to carry no write. */
export function keepsRename(catalog: HarnessCatalog | null | undefined): boolean {
  return catalog === null || catalog === undefined || catalog.source === "table" || catalog.renames;
}

/** Whether a message to this harness may carry an image, as far as this catalog knows. The answer is the adapter's on
 * the machine, so a row the runtime's table stood in for is not a no: the client offers the picker and the runtime
 * refuses in the agent's name if the adapter turns out to read none. */
export function readsImages(catalog: HarnessCatalog | null | undefined): boolean {
  return catalog === null || catalog === undefined || catalog.source === "table" || catalog.images;
}

/** Whether wsp can hand this harness's launch an MCP server. Unlike the three above, a table row is the answer and
 * not a stand-in: this is decided by the adapter in this host and by no binary, so a caller may read it before any
 * machine exists. Absent is a no, which is a catalog from before the field was declared. */
export function takesMcpServers(catalog: Pick<HarnessCatalog, "mcpServers"> | null | undefined): boolean {
  return catalog?.mcpServers === true;
}

/** Whether an access picked while a turn runs reaches that turn on this harness. The adapter's own declaration, like
 * takesMcpServers; absent is a no, which is a catalog from before the field was declared, and a pick then waits for
 * the person's next message. */
export function movesRunningAccess(catalog: Pick<HarnessCatalog, "movesAccess"> | null | undefined): boolean {
  return catalog?.movesAccess === true;
}

/** Whatever carries a harness's screen-only commands: the catalog itself, or a caller that holds the list alone. */
export interface ScreenCommandsHolder {
  readonly screenCommands?: ReadonlyArray<ScreenCommand>;
}

/** The commands of this harness that work only in its CLI's own terminal; none for a catalog from before the field. */
export function screenCommandsOf(catalog: ScreenCommandsHolder | null | undefined): ReadonlyArray<ScreenCommand> {
  return catalog?.screenCommands ?? NO_SCREEN_COMMANDS;
}

const NO_SCREEN_COMMANDS: ReadonlyArray<ScreenCommand> = [];

/** The screen-only command a message would hand the CLI, or null. Only a slash that opens the whole message is a
 * command to the CLI; anywhere else it reads the words as text, so this reads the first word alone. */
export function screenCommandTyped(catalog: ScreenCommandsHolder | null | undefined, prompt: string): ScreenCommand | null {
  const name = /^\/(\S+)/.exec(prompt.trim())?.[1];
  if (name === undefined) return null;
  return screenCommandsOf(catalog).find(c => c.name === name) ?? null;
}

/** The picks a start names, as sessions.start carries them. */
export interface StartPicks {
  model?: string;
  effort?: string;
  permissionMode?: string;
  fast?: boolean;
}

/** Why a start asked for fast on a model that has no faster output. */
export const noFastLine = (model: string): string => `${model} has no fast mode; pick a model that offers it, or send without it`;

function checkedAgainst(catalog: HarnessCatalog, picks: StartPicks, model: string | undefined, runsOn: string | undefined): void {
  if (catalog.models.length > 0) listed(catalog.harness, "model", catalog.models, picks.model, catalog.legacyModels, catalog.hiddenModels);
  const chosen = modelOf(catalog, model);
  if (catalog.efforts.length > 0) listed(chosen?.efforts !== undefined ? chosen.label : catalog.harness, "effort", effortsFor(catalog, chosen), picks.effort);
  if (catalog.permissionModes.length > 0) listed(catalog.harness, "access mode", catalog.permissionModes, picks.permissionMode);
  const fastOn = modelOf(catalog, model ?? runsOn);
  if (picks.fast === true && fastOn !== null && fastOn.fast !== true) throw Object.assign(new Error(noFastLine(fastOn.label)), { kind: "invalid" });
}

/** The picks a start runs with, checked against the catalog: a value a list does not carry is refused naming the
 * list in the composer's words, and a list the CLI leaves empty (no such flag, or open values) takes any value. A
 * start that opens a thread without a model runs the one the catalog marks default, and without an effort the one
 * effortsFor marks for that model, so every door runs what the composer shows; a resume keeps the thread's own.
 * Without a catalog (a harness the runtime has no table row for) every value passes and no default is filled. Only
 * the three picks and fast come out, whatever else rides in; fast only where it was asked for. `runsOn` is the model a
 * resumed thread already runs on, which a fast asked for with no model named is checked against. */
export function startPicks(catalog: HarnessCatalog | undefined, picks: StartPicks, opensThread: boolean, runsOn?: string): StartPicks {
  const model = picks.model ?? (opensThread && catalog !== undefined ? markedDefault(everyModel(catalog))?.value : undefined);
  if (catalog !== undefined) checkedAgainst(catalog, picks, model, runsOn);
  const effort = picks.effort ?? (opensThread && catalog !== undefined ? markedDefault(effortsFor(catalog, modelOf(catalog, model)))?.value : undefined);
  // The access is filled in like the other two, so what the picker shows is what the CLI is told: an unnamed access
  // used to reach the adapter as nothing, which every adapter here reads as its own skip-everything flag. The mark
  // is the one markedFor placed from the person's defaults, else the table's own.
  const permissionMode = picks.permissionMode ?? (opensThread && catalog !== undefined ? markedDefault(catalog.permissionModes)?.value : undefined);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(picks.fast === true ? { fast: true } : {}),
  };
}
