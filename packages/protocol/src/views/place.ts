// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { AgentSignInState } from "../agents-report.js";
import { KNOWN_HOSTS, PLACE_INSTALL, plural, thisComputer } from "../format.js";
import { RecipeFile } from "../recipe-file.js";
import { HERE_PLACE_ID, namesPlace, placeRenameRefusal, placeSshRefusal, placeSshOtherRefusal, placeSshUncheckedRefusal, placeLoginOtherRefusal, placeLoginUncheckedRefusal, placeLoginElsewhere, placeLoginElsewhereRemovedLine, type RefusalHalves } from "../place-word.js";
import { NAP_AFTER_MAX_MS, TURN_LIMIT_MAX_MS } from "../place-state.js";
import { isPlainPath, PortForward, RelayPort } from "../wire/limits.js";
import { MachineSizeOffer, WorkspaceSize } from "../wire/capabilities.js";
import { ProjectAddStage, ProjectView, WorkspaceAgents } from "./workspace.js";

/** The host opened or closed a forward; the runtime relays these to the app's socket and emits none itself. */
export const ForwardOpenEvent = z.object({ type: z.literal("forward.open"), forward: PortForward });
export const ForwardCloseEvent = z.object({ type: z.literal("forward.close"), workspaceId: z.string(), port: RelayPort });
export type ForwardEvent = z.infer<typeof ForwardOpenEvent> | z.infer<typeof ForwardCloseEvent>;

/** What a computer joining this host passes through when the host installs the agent on it over ssh, in order.
 * One list for the line a terminal prints and the rows the app draws, so neither invents a step the other has not
 * got. */
export const PlaceAddStep = z.enum(["connect", "host-key", "check", "chip", "root", "system", "disk", "reach", "wsp", "service", "join"]);
export type PlaceAddStep = z.infer<typeof PlaceAddStep>;

/** What each step reads as while it runs. The note beside it carries what the computer answered (its system, the
 * node it got), which is the step's own to say and never a second sentence about it. */
export const PLACE_ADD_WORDS: Record<PlaceAddStep, string> = {
  connect: "connecting over ssh",
  "host-key": `remembering the box's host key in ${KNOWN_HOSTS}`,
  check: "checking it can run wsp",
  chip: "reading its chip and system",
  root: "checking it logs in as root",
  system: "checking for systemd and cgroup v2",
  disk: "checking it has room for the base tools",
  reach: "checking it can reach this computer",
  wsp: "installing wsp",
  service: "starting the daemon",
  join: "waiting for it to connect to this computer",
};

/** Where the app's sheet says a step differently from the line a terminal prints. The host the app runs on need not
 * be a Mac, so the computer it runs on is this computer in both. `done` is read once a step is finished, where a
 * line under a check would otherwise say the wait it was in rather than the state it reached. */
export const PLACE_ADD_SHEET_WORDS: Partial<Record<PlaceAddStep, { word?: string; done?: string }>> = {
  "host-key": { word: `keeps the box's host key in ${KNOWN_HOSTS} here` },
  reach: { done: "reaches this computer" },
  wsp: { word: `installing wsp under ${PLACE_INSTALL.folder}` },
  service: { word: `starting the daemon as ${PLACE_INSTALL.service}` },
  join: { done: "connected to this computer" },
};

/** The word the app's sheet draws for a step in the state it is in. */
export function placeAddSheetWord(step: PlaceAddStep, state: "running" | "done"): string {
  const said = PLACE_ADD_SHEET_WORDS[step];
  return (state === "done" ? said?.done : undefined) ?? said?.word ?? PLACE_ADD_WORDS[step];
}

/** The kind a places.add refusal carries when the ssh login itself did not stand or the word typed names no login:
 * the one case where checking the user, the address or the key is the fix. */
export const PLACE_LOGIN_REFUSED_KIND = "login";

/** The kind an add is refused with for a computer this one has never dialled and nobody confirmed the key of. The
 * refusal carries the key the computer answered with as `hostKey`, which the record keeps, so a client offers it to
 * the person to trust and adds again with it. */
export const PLACE_HOST_KEY_KIND = "host-key";

/** The password a login's sudo asks for, typed by the person for one add, remove or update: fed to sudo over the
 * ssh connection's input, never written down, never logged and gone when the act ends. One line, as sudo reads it. */
export const SudoPassword = z.string().max(1024).regex(/^[^\n\r\0]*$/);

/** The kind an add is refused with where the login's sudo asks for a password: none was given, or sudo did not take
 * the one that was. A client asks the person for it once and adds again with it. */
export const PLACE_SUDO_KIND = "sudo";

/** How far the install on one computer has got, keyed by the id the request was answered with, so two installs at
 * once are two lists. A step that is running is the one with a spinner; one that is done carries its note. */
export const PlaceStageEvent = z.object({
  type: z.literal("place.stage"),
  addId: z.string(),
  step: PlaceAddStep,
  state: z.enum(["running", "done", "failed"]),
  note: z.string().optional(),
  /** The computer the step ran on, carried by the steps of a job on a computer this host already holds: a reader
   * that acts on a step rather than printing it needs the row and not the stream it rode. */
  placeId: z.string().optional(),
  /** How long the step took, once it ended. */
  ms: z.number().int().nonnegative().optional(),
});
export type PlaceStageEvent = z.infer<typeof PlaceStageEvent>;

/** One install over ssh as the host keeps it while it runs and for a while after, so a window opened later, or the
 * same one after a reload, reads the steps and the refusal the window that asked read. `said` and `fix` are the
 * refusal's two halves; `kind` is the one it was stamped with. */
export const PlaceAddJob = z.object({
  addId: z.string(),
  address: z.string(),
  sshPort: z.number().int().optional(),
  startedAt: z.string(),
  state: z.enum(["running", "done", "failed"]),
  steps: z.array(z.object({ step: PlaceAddStep, state: z.enum(["running", "done", "failed"]), note: z.string().optional(), ms: z.number().int().nonnegative().optional() })),
  said: z.string().optional(),
  fix: z.string().optional(),
  kind: z.string().optional(),
  /** The computer the add made, once it joined. */
  placeId: z.string().optional(),
  /** The key a computer never dialled answered with, on an add refused under PLACE_HOST_KEY_KIND. */
  hostKey: z.string().optional(),
});
export type PlaceAddJob = z.infer<typeof PlaceAddJob>;

/** The job with one more step said, the one rule the host and the app both keep it by: the step's line replaced
 * where it stands, the job done once the computer joined, failed once a step failed. The setup that runs on behind
 * a join rides place.setup frames and is the computer's row's to say, not the add's. */
export function withPlaceStage(job: PlaceAddJob, e: Pick<PlaceStageEvent, "step" | "state" | "note" | "placeId" | "ms">): PlaceAddJob {
  const line = { step: e.step, state: e.state, ...(e.note !== undefined ? { note: e.note } : {}), ...(e.ms !== undefined ? { ms: e.ms } : {}) };
  const at = job.steps.findIndex(s => s.step === e.step);
  const steps = at === -1 ? [...job.steps, line] : job.steps.map((s, i) => (i === at ? line : s));
  if (e.step === "join" && e.state === "done") return { ...job, steps, state: "done", ...(e.placeId !== undefined ? { placeId: e.placeId } : {}) };
  if (e.state === "failed") return { ...job, steps, state: "failed", ...(job.said === undefined && e.note !== undefined ? { said: e.note } : {}) };
  return { ...job, steps };
}

/** One line of the doctor's computer road as the host that holds that computer's link says it, keyed by the id the
 * terminal minted for its own run: a road's lines ride the events channel to whoever asked for them, under the
 * stream they were said on. A host source's event and no member of the runtime's own union: it carries no sequence,
 * nothing retains it, and a socket that comes back later is not replayed it. */
export const DoctorLineEvent = z.object({
  type: z.literal("doctor.line"),
  doctorId: z.string(),
  line: z.string(),
  stream: z.enum(["out", "err"]),
});
export type DoctorLineEvent = z.infer<typeof DoctorLineEvent>;

export const PlaceKind = z.enum(["computer", "provider"]);
export type PlaceKind = z.infer<typeof PlaceKind>;

/** What the computers table calls one row's kind, which is finer than PlaceKind by one: the computer the host runs
 * on is named as its owner names it, a computer somebody joined is a box, and a provider account is a cloud. The
 * one table, so the command line's KIND column and the app read one word per row. */
export function computerKindWord(place: Pick<PlaceView, "id" | "kind">, platform: "darwin" | "linux"): string {
  if (place.id === HERE_PLACE_ID) return thisComputer(platform);
  return place.kind === "provider" ? "cloud" : "box";
}

/** A forward over the ssh login from a port on that computer's own loopback to this host's door, held by this host
 * for a computer that cannot reach it any other way: its link dials `http://127.0.0.1:<boxPort>`. The door's end is
 * read off the running host at each standing, never saved: a restarted host's door can sit on another port. */
export const PlaceBack = z.object({
  boxPort: z.number().int().min(1).max(65535),
});
export type PlaceBack = z.infer<typeof PlaceBack>;

/** How a computer this host holds is reached, off the road it was added on. `ssh` is the login the host logs in
 * as, which is also what a person types in their own terminal; `from` is where its last link dialled in from; `back`
 * is the forward it dials back through where it reaches this host no other way. A row with neither `ssh` nor `from`
 * is a computer that joined with a code and has never linked. */
export const PlaceRoad = z.object({
  ssh: z.string().max(300).optional(),
  from: z.string().max(300).optional(),
  back: PlaceBack.optional(),
});
export type PlaceRoad = z.infer<typeof PlaceRoad>;

/** What one dial of a computer came to: when it was dialled, whether anything answered, how long the frame that
 * answered took, and what the road said when nothing did (ssh's own line on the ssh road). The one shape the
 * answer is written in, so the button that asks and the row that keeps it read one thing. */
export const PlaceDialled = z.object({
  at: z.string(),
  answered: z.boolean(),
  roundTripMs: z.number().int().nonnegative().optional(),
  said: z.string().max(2000).optional(),
});
export type PlaceDialled = z.infer<typeof PlaceDialled>;

/** The project a workspace on a computer you own is made with: a checkout on that computer, copied once for this
 * workspace and mounted read-write at `at` inside, the project's real path. The copy is the workspace's own from
 * the moment it is made: the checkout can be fetched, switched or built in and no workspace already made from it
 * sees any of it. Absent is a workspace of the computer with no project in it. */
export const WorkspaceCopy = z.object({
  from: z.string().min(1).refine(isPlainPath, "an absolute path on the computer"),
  at: z.string().min(1).refine(isPlainPath, "an absolute path inside the workspace"),
});
export type WorkspaceCopy = z.infer<typeof WorkspaceCopy>;

/** How a computer makes a workspace's copy of a checkout: reflink shares blocks with it, snapshot is a btrfs
 * subvolume snapshot of it, plain writes every byte and takes the time that takes. */
export const CopyWord = z.enum(["reflink", "snapshot", "plain"]);
export type CopyWord = z.infer<typeof CopyWord>;

/** One login the computer running a workspace keeps outside every one of them and mounts into this one at
 * `target`, read-write: signed in once on that computer, so a refresh inside any workspace there is the
 * computer's own refresh rather than a copy going stale. `source` is a file under that computer's own logins
 * directory, which its daemon says where it is and refuses a create that names anything else. */
export const MachineShare = z.object({
  source: z.string().min(1).refine(isPlainPath, "an absolute path on the computer"),
  target: z.string().min(1).refine(isPlainPath, "an absolute path inside the workspace"),
});
export type MachineShare = z.infer<typeof MachineShare>;

/** One folder the computer running a workspace mounts into it: the source on the computer, the path it lands at
 * inside, and whether the workspace may write through it. Unlike a share, which is one file of a login, this is a
 * folder both sides keep working in, which is what makes one project's memory the same memory in every workspace
 * of it on that computer. */
export const MachineBind = z.object({
  source: z.string().min(1).refine(isPlainPath, "an absolute path on the computer"),
  target: z.string().min(1).refine(isPlainPath, "an absolute path inside the workspace"),
  readOnly: z.boolean().optional(),
});
export type MachineBind = z.infer<typeof MachineBind>;

/** What a row of the recipe job puts on a computer you own: a tool or agent installed, a file of the person's own
 * landed in an agent's home there, or an MCP server written into an agent's config. */
export const PlaceProvisionKind = z.enum(["tool", "file", "server"]);
export type PlaceProvisionKind = z.infer<typeof PlaceProvisionKind>;

/** What each kind of row is called where a count of them is read. One table, so the row's word, the line a job
 * opens with and the log on that computer cannot name the same rows three ways. */
export const PROVISION_KIND_WORDS: Record<PlaceProvisionKind, string> = { tool: "tool", file: "file", server: "MCP server" };

/** A count of rows by kind as a person reads it, the kinds with none left out: `9 tools, 3 files, 5 MCP servers`.
 * Nothing but tools reads as it did before there was anything else. */
export function provisionCountWord(counts: Partial<Record<PlaceProvisionKind, number>>): string {
  const said = PlaceProvisionKind.options.flatMap(kind => ((counts[kind] ?? 0) > 0 ? [plural(counts[kind]!, PROVISION_KIND_WORDS[kind])] : []));
  return said.length === 0 ? plural(0, PROVISION_KIND_WORDS.tool) : said.join(", ");
}

/** What one row of the recipe came to on a computer you own. `present` is a row the computer already had at the
 * version asked, so nothing ran for it; `skipped` waited on a row that did not land, or was set aside by the plan. */
export const PlaceProvisionRow = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  outcome: z.enum(["installed", "present", "failed", "skipped"]),
  /** What this row puts there; absent reads as a tool, which is what every row was before files and servers had rows. */
  kind: PlaceProvisionKind.optional(),
  /** The setup step the row belongs to, which decides how its failure weighs. */
  step: z.lazy(() => PlaceSetupStep).optional(),
  note: z.string().optional(),
  /** On a row that did not land: what to do about it, beside the note that says what happened. */
  fix: z.string().optional(),
  /** On a server set aside for want of a yes to copying its keys: what they go by, names only. */
  keys: z.array(z.string().min(1)).optional(),
  ms: z.number().int().nonnegative().optional(),
  /** On an installed row: an earlier setup put it on, and the run that wrote the row found it there. */
  earlier: z.boolean().optional(),
  /** On a folder's row: the project wsp's add made there, by id, which is how a later setup and a remove tell it from
   * a project the person recorded there under the same name. */
  project: z.object({ id: z.string().min(1) }).optional(),
});
export type PlaceProvisionRow = z.infer<typeof PlaceProvisionRow>;

/** The GitHub step's one row, and the CLI whose login signs it in on a computer. */
export const GITHUB_ROW = "github";
export const GITHUB_CLI = "gh";
const SIGN_IN_ROW = "signins/";
/** The sign-ins step's row for one agent. */
export const signInRowId = (agent: string): string => `${SIGN_IN_ROW}${agent}`;
/** The catalog id whose login a row stands for: an agent's under the sign-ins step, gh for the GitHub row, else none. */
export const signInOfRow = (id: string): string | undefined => (id.startsWith(SIGN_IN_ROW) ? id.slice(SIGN_IN_ROW.length) : id === GITHUB_ROW ? GITHUB_CLI : undefined);

/** The rows of a job counted by kind, for the word above. */
export function provisionCounts(rows: readonly PlaceProvisionRow[]): Partial<Record<PlaceProvisionKind, number>> {
  const counts: Partial<Record<PlaceProvisionKind, number>> = {};
  for (const r of rows) {
    const kind = r.kind ?? "tool";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/** How a step's failure weighs on the computer: `blocks` stops the job there, `blocks-all` stops it only when every
 * row of the step failed, `needs-you` waits on the person and never stops anything, `important` lets the job finish
 * and reads Needs you, `fixable` lets it finish and is a row with Retry. */
export type SetupClass = "blocks" | "blocks-all" | "needs-you" | "important" | "fixable";

/** The few field shapes the setup's records repeat, made once: a schema is immutable, and each one made costs the
 * host its methods bound anew, which over the setup's records is a part of a megabyte held for good. */
const SETUP_TEXT = z.string();
const SETUP_NOTE = SETUP_TEXT.optional();
const SETUP_MS = z.number().int().nonnegative().optional();

/** What the job is on, step by step, and how a failure of each weighs. The checks and the install of wsp itself are
 * the add's own steps (PlaceAddStep); these are what the job does once the computer joined. */
export const SETUP_STEP_CLASS = {
  floor: "blocks",
  agents: "blocks-all",
  signins: "needs-you",
  clis: "fixable",
  skills: "fixable",
  mcp: "fixable",
  plugins: "fixable",
  configs: "fixable",
  folders: "important",
  github: "important",
  context: "fixable",
} as const satisfies Record<string, SetupClass>;
export const PlaceSetupStep = z.enum(Object.keys(SETUP_STEP_CLASS) as [keyof typeof SETUP_STEP_CLASS, ...(keyof typeof SETUP_STEP_CLASS)[]]);
export type PlaceSetupStep = z.infer<typeof PlaceSetupStep>;

/** Each step as a terminal and the app say it while it runs. */
export const SETUP_STEP_WORDS: Record<PlaceSetupStep, string> = {
  floor: "the base tools",
  agents: "the agents",
  signins: "the agents' sign-ins",
  clis: "the CLIs",
  skills: "the skills",
  mcp: "the agents' own files and MCP servers",
  plugins: "the plugins",
  configs: "git and the shell",
  folders: "the folders, as projects",
  github: "the GitHub sign-in",
  context: "what the agents read about this computer",
};

/** One step of the job as it stands: when it started while it runs, how long it took once it ended. */
export const PlaceSetupLine = z.object({
  step: PlaceSetupStep,
  state: z.enum(["running", "done", "failed", "skipped"]),
  note: SETUP_NOTE,
  ms: SETUP_MS,
  startedAt: SETUP_NOTE,
});
export type PlaceSetupLine = z.infer<typeof PlaceSetupLine>;

/** A sign-in waiting on the person: the page to open and the code to type there, and when the wait runs out. An
 * expired one is run again by a retry for a fresh page and code, never waited on. */
export const PlaceWait = z.object({
  row: SETUP_TEXT,
  label: SETUP_TEXT,
  url: SETUP_NOTE,
  code: SETUP_NOTE,
  expiresAt: SETUP_TEXT,
  state: z.enum(["waiting", "expired"]),
});
export type PlaceWait = z.infer<typeof PlaceWait>;

/** The setup job on a computer you own as it last stood, written after every step: `running` while steps go on,
 * `done` once every step ended (failed rows included), `failed` when a step that blocks failed, with why in `said`.
 * Step output never sits here: it is the computer's own log, read over the link. */
export const PlaceSetup = z.object({
  state: z.enum(["running", "done", "failed"]),
  /** The stream its frames ride as place.setup events. */
  addId: SETUP_TEXT,
  startedAt: SETUP_TEXT,
  finishedAt: SETUP_NOTE,
  steps: z.array(PlaceSetupLine),
  waiting: z.array(PlaceWait),
  said: SETUP_NOTE,
});
export type PlaceSetup = z.infer<typeof PlaceSetup>;

/** What the last setup came to: the hash of the picks it applied and every row's outcome, which a retry and the sync
 * read so a row the computer already had is never taken off it. */
export const PlaceApplied = z.object({
  hash: SETUP_TEXT,
  at: SETUP_TEXT,
  rows: z.array(PlaceProvisionRow),
  /** What this computer had for each row of the recipe it applied, keyed `<kind>/<row>` as a resolved recipe keys
   * them: the sync reads what changed off these. Absent on a computer set up before the sync. */
  items: z.record(SETUP_TEXT).optional(),
});
export type PlaceApplied = z.infer<typeof PlaceApplied>;

/** A computer out of step with the recipe it follows: `behind` until the sync reaches it, `running` while the sync
 * puts the change on it. `changes` names each row that moved, `<kind>/<row>`, added, changed or taken out. Absent on
 * a computer in step. */
export const PlaceSync = z.object({ state: z.enum(["behind", "running"]), changes: z.array(SETUP_TEXT), since: SETUP_TEXT });
export type PlaceSync = z.infer<typeof PlaceSync>;

/** How a setup ended, for the moment the person hears: ready, ready with something waiting on them or an important
 * row failed, or stopped by a step that blocks. */
export const SetupEnd = z.enum(["ready", "needs-you", "failed"]);
export type SetupEnd = z.infer<typeof SetupEnd>;

/** One frame of the setup job on a computer, on the stream the add or the resume that started it named: a step's
 * line as it moves, a sign-in that waits on the person, a row that landed after its step ended, or the end with how
 * it came out. */
export const PlaceSetupEvent = z.object({
  type: z.literal("place.setup"),
  addId: SETUP_TEXT,
  placeId: SETUP_TEXT,
  line: PlaceSetupLine.optional(),
  wait: PlaceWait.optional(),
  /** A row that landed after its step ended, a sign-in through or skipped: its wait is off, its outcome on the record. */
  landed: SETUP_NOTE,
  /** On a step's line: every step running at that moment, since after the base tools several run at once. */
  running: z.array(PlaceSetupStep).optional(),
  end: SetupEnd.optional(),
  /** On the end: why it failed, or what waits and what failed beside the rows that stood. */
  said: SETUP_NOTE,
});
export type PlaceSetupEvent = z.infer<typeof PlaceSetupEvent>;

/** The sync on one computer moved: behind, under way with the step it is on, or in step again with what it applied.
 * `sync` absent is a computer in step with its recipe. */
export const PlaceSyncEvent = z.object({ type: z.literal("place.sync"), placeId: SETUP_TEXT, sync: PlaceSync.optional(), line: PlaceSetupLine.optional(), applied: PlaceApplied.optional() });
export type PlaceSyncEvent = z.infer<typeof PlaceSyncEvent>;

/** Which computers follow a recipe moved, or the recipe itself did: a follow, a recipe saved or taken away. What
 * watches a recipe's items here, and a page listing recipes, read it again. */
export const RecipesChangedEvent = z.object({ type: z.literal("recipes.changed"), slug: z.string() });
export type RecipesChangedEvent = z.infer<typeof RecipesChangedEvent>;

/** One line of an add as the command line and the tool stream it: a step of the install, then a step of the setup. */
export const AddLine = PlaceSetupLine.extend({ step: z.union([PlaceAddStep, PlaceSetupStep]) });
export type AddLine = z.infer<typeof AddLine>;

/** How far an add that has not reached Set up has got: `choosing` is a computer that joined and waits on the
 * person's picks, with the floor already on it. */
export const PendingStep = z.enum(["connect", "check", "wsp", "floor", "choosing"]);
export type PendingStep = z.infer<typeof PendingStep>;

/** One add from the first field to Set up, one per address: the choices so far, the computer it became once it
 * joined, and the refusal that stopped it where one did. */
export const PendingComputer = z.object({
  id: SETUP_TEXT,
  address: SETUP_TEXT,
  sshPort: z.number().int().optional(),
  name: SETUP_NOTE,
  placeId: SETUP_NOTE,
  step: PendingStep,
  choices: z.lazy(() => RecipeFile),
  /** The saved recipe the choices came from, by slug. */
  recipe: SETUP_NOTE,
  startedAt: SETUP_TEXT,
  failed: z.object({ said: SETUP_TEXT, fix: SETUP_NOTE }).optional(),
});
export type PendingComputer = z.infer<typeof PendingComputer>;

/** Threads at once on a computer: how many threads may run there together, root or child. */
export const ComputerCap = z.object({ threads: z.number().int().min(1) });
export type ComputerCap = z.infer<typeof ComputerCap>;
/** Machines at once and spend per day on a cloud. */
export const CloudCap = z.object({ machines: z.number().int().min(1), spendPerDayUsd: z.number().min(0) });
export type CloudCap = z.infer<typeof CloudCap>;
export const PlaceCap = z.union([ComputerCap, CloudCap]);
export type PlaceCap = z.infer<typeof PlaceCap>;
/** The numbers a person set on one place, each key absent until they set it. */
export const PlaceCapSet = ComputerCap.merge(CloudCap).partial();
export type PlaceCapSet = z.infer<typeof PlaceCapSet>;
/** Everything a person set on one place, each key absent until they set it and gone again once they reset it.
 * `napMs` is how long a workspace there with no window of its own runs quiet before it naps; null never naps it. */
export const PlaceSettings = PlaceCapSet.extend({
  napMs: z.number().int().min(60_000).max(NAP_AFTER_MAX_MS).nullable().optional(),
  /** How long one turn there may run before the runtime stops it; null never stops one. */
  turnLimitMs: z.number().int().min(3_600_000).max(TURN_LIMIT_MAX_MS).nullable().optional(),
  /** What the agents on a workspace there may ask of this host where the workspace holds no switch of its own: only
   * the parts the person set, so every other part follows AGENTS_ON as it reads now. */
  spawn: WorkspaceAgents.partial().optional(),
});
export type PlaceSettings = z.infer<typeof PlaceSettings>;
/** What a set asks for: the settings, with the agents switch as a patch over the parts the place holds. */
export const PlaceSettingsAsk = PlaceSettings;
export type PlaceSettingsAsk = z.infer<typeof PlaceSettingsAsk>;
/** What a set takes on a computer the person added beside its settings: a new name, a new ssh login and the recipe
 * it follows. */
export interface PlaceSetAlso {
  name?: string | undefined;
  ssh?: string | undefined;
  recipe?: string | undefined;
}
/** A setting on a place by the word the command line and the tool name it with, which a reset takes. */
export const PlaceSettingWord = z.enum(["threads", "machines", "spend", "nap", "turn-limit", "spawn", "max-depth"]);
export type PlaceSettingWord = z.infer<typeof PlaceSettingWord>;

/** The Macs a computer's icon tells apart. */
export const MacKind = z.enum(["macbook", "imac", "mac-mini", "mac-studio", "mac-pro"]);
export type MacKind = z.infer<typeof MacKind>;

/** Which Mac a product name ("MacBook Pro (14-inch, M5)") or a model identifier ("Macmini9,1") names. Apple
 * silicon's identifiers since 2022 ("Mac17,2") name no family, which is why the product name is read first. */
export function macKindOf(said: string): MacKind | undefined {
  const word = said.replace(/\s+/g, "").toLowerCase();
  if (word.startsWith("macbook")) return "macbook";
  if (word.startsWith("imac")) return "imac";
  if (word.startsWith("macmini")) return "mac-mini";
  if (word.startsWith("macstudio")) return "mac-studio";
  if (word.startsWith("macpro")) return "mac-pro";
  return undefined;
}

/** One row of wsp places: a computer of the person's own, this computer itself, or the provider this host forks on. */
export const PlaceView = z.object({
  id: z.string(),
  kind: PlaceKind,
  name: z.string(),
  /** The name the person gave this computer, a Mac's own "zingzy's MacBook Pro", drawn where the machine name is
   * not; absent where the computer keeps none. */
  label: z.string().optional(),
  /** Which Mac this computer is, read off its model where it is one. */
  mac: MacKind.optional(),
  default: z.boolean(),
  /** A computer: what it reported last. */
  os: z.string().optional(),
  shape: WorkspaceSize.optional(),
  diskFreeBytes: z.number().int().optional(),
  /** The engine a project's own containers run on there. Absent on a place that has never said what it is. */
  engine: z.enum(["none", "docker", "podman"]).optional(),
  /** How a workspace's copy of a project is made there, as that computer last reported it. Absent on a place
   * that runs no workspaces and on one that has never said. */
  copies: CopyWord.optional(),
  present: z.boolean().optional(),
  /** Whether a remove's leave takes the runtime's folder there, the copy of the image with it, as that computer last
   * reported: one added over ssh, whose add wrote what stood before it. Absent where it never said, and on a computer
   * joined with a code, which keeps both. */
  takesRuntime: z.boolean().optional(),
  joinedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  daemonVersion: z.number().int().optional(),
  /** Set while this computer runs an older daemon than this wsp deploys: the word placeDaemonBehind says it in, and
   * what brings it level, `wsp add <name> --update` on a joined computer and the road this wsp was installed by on
   * the computer the host runs on. */
  behind: z
    .object({
      word: z.string(),
      fix: z.string(),
      /** update where the host can run the fix itself (places.update on a joined computer), install where the
       * person runs it, so a page draws a button or a sentence without asking which kind of computer this is. */
      act: z.enum(["update", "install"]),
    })
    .optional(),
  /** The catalog ids of the agents that computer found on itself, as it last reported them. */
  agents: z.array(z.string()).optional(),
  /** What each of those agents answered its own version flag with, as that computer last reported it. */
  agentVersions: z.record(z.string()).optional(),
  /** One word per reported agent for whether a turn there needs a sign-in first, off that computer's last report and
   * any sign-in this host ran there since. Absent on a computer whose daemon is older than the logins list the word
   * is read from, which is unknown rather than none. */
  signIns: z.record(AgentSignInState).optional(),
  /** Where that computer keeps the logins every workspace on it shares, off what its backend last said. What the
   * sign-in on that computer points the tool's own store at, and what a create there shares in. Absent on a
   * computer that has not said yet and on a provider, which holds no file of this person's. */
  logins: z.string().optional(),
  /** A provider: its hourly rate for the default size. */
  rateUsdPerHour: z.number().optional(),
  /** Every size a workspace here may be asked for, each with this place's own rate for it, read off the backend
   * this host holds for the row. Absent on a place that offers no pick of its own, which is every computer the
   * person owns. A picker reads the row it is under, never one provider's list against another's prices. */
  sizes: z.array(MachineSizeOffer).optional(),
  /** How many forks run there and how many more a create can take now, by forkRoom; a napping fork runs nothing and
   * takes no room, and the workspace list is where it is counted. Absent on a place that forks nowhere. */
  forks: z.object({ running: z.number().int(), room: z.number().int() }).optional(),
  /** Whether a workspace can be forked here at all: a provider, or a computer somebody joined, which boots the
   * image or it is not joined at all. False is the computer the app itself runs on, which runs threads in its own
   * local mode and is never forked into. The one fact wsp new reads to decide which road a place takes, so no
   * line outside this list switches on a place's kind. */
  takesForks: z.boolean().optional(),
  /** Where the host expects that computer: the ssh login it was installed over, and the address its last link
   * dialled in from. A computer joined by typing a code has no login here, so the address is all there is. */
  road: PlaceRoad.optional(),
  /** The folder a turn there starts in and how long that computer had been up, as it last reported them, and when
   * that report was taken. Kept on the row so a computer that stopped answering reads what it last was rather than
   * nothing at all. The stamp is the uptime's: it grows while the computer is up, so it is dated by the report it
   * was read in and not by the last frame this host saw, which can be hours later. */
  home: z.string().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  reportedAt: z.string().optional(),
  /** What the last dial of this computer got. Kept on the row, so the answer stands after the window is closed
   * and opened again rather than living only in the button that asked. */
  dialled: PlaceDialled.optional(),
  /** Why nothing runs inside a copy there, off that computer's last report: its link stays up for the acts that
   * need no copy running. Absent while it runs workspaces. */
  blocked: z.string().optional(),
  /** Why a thread on that computer itself is launched with no wsp tools, off its last report: its daemon could not
   * open the door those threads reach the tools through. Absent where the door stands, and from a daemon older
   * than the door, whose row reads behind. */
  toolsBlocked: z.string().optional(),
  /** The copy of the image at this place while it is not standing: the stage sentence while a build runs there, the
   * reason after one stopped there. Absent once the copy stands, and on a place nothing was ever built at. */
  build: z.string().optional(),
  /** Set when `build` is the reason a build there stopped rather than the stage of one running. */
  buildStopped: z.boolean().optional(),
  /** Whether a copy of the image can stand here at all, by buildsImages over this place's own capabilities. Absent on
   * a joined computer that has not yet said what it forks with. */
  buildsImages: z.boolean().optional(),
  /** The setup job on this computer: the steps under way, then how each ended, and every sign-in waiting on the
   * person. Absent on a provider, on this computer itself, and on a computer nothing has set up yet. */
  setup: PlaceSetup.optional(),
  /** What the last setup came to, row by row. */
  applied: PlaceApplied.optional(),
  /** What this computer was set up with, saved as a recipe or not. */
  picks: RecipeFile.optional(),
  /** The saved recipe this computer follows, by slug, or none; absent on a computer set up before recipes. */
  recipe: z.string().optional(),
  /** Set while this computer is out of step with the recipe it follows. */
  sync: PlaceSync.optional(),
  /** The number set on this place, else its kind's default; absent only on a computer that has not said its shape. */
  cap: PlaceCap.optional(),
  /** The cap this place takes when the person sets none: one thread per THREAD_MEM_MB of a computer's memory up to twice
   * its cores, or a cloud's machines and spend. Absent where `cap` is. */
  capDefault: PlaceCap.optional(),
  /** What the person set on this place, which a reset takes back; absent while every setting is its default. */
  settings: PlaceSettings.optional(),
  /** How long a workspace here with no window of its own runs quiet before it naps, the person's or the default;
   * null where it never naps. Absent on the computer the host runs on, whose workspaces are folders. */
  napMs: z.number().int().nullable().optional(),
  /** The nap window this host gives a place nobody set one on: what a reset of `napMs` goes back to. Present where
   * `napMs` is. */
  napDefault: z.number().int().optional(),
  /** How long one turn here may run before the runtime stops it, the person's or the default; null where no limit
   * stops one. */
  turnLimitMs: z.number().int().nullable().optional(),
  /** The turn limit this kind of place has when nobody set one: what a reset of `turnLimitMs` goes back to. */
  turnLimitDefault: z.number().int().nullable().optional(),
  /** What the agents on a workspace here may ask of this host where it holds no switch of its own: the person's
   * setting for this place, else `spawnDefault`. */
  spawn: WorkspaceAgents.optional(),
  /** The switch a place nobody set one on gives its workspaces: what a reset of `spawn` goes back to. */
  spawnDefault: WorkspaceAgents.optional(),
  /** What its cap counts, at list time: threads running on a computer, machines holding a slot on a cloud. */
  running: z.number().int().nonnegative().optional(),
});
export type PlaceView = z.infer<typeof PlaceView>;

/** What one dial of a computer answers: what came back, the sentence the slot that asked says it in, and the row as
 * it now stands, since the host writes the answer on the record. The one home for the shape, so the door that
 * answers it and the client that parses it cannot spell it two ways. */
export const PlaceDial = z.object({
  dialled: PlaceDialled,
  line: z.string(),
  place: PlaceView,
});
export type PlaceDial = z.infer<typeof PlaceDial>;

/** What places.update answers: the daemon it moved the computer from and to where the computer was behind, absent
 * where it already ran this wsp's daemon. */
export const PlaceUpdateReply = z.object({
  name: z.string().min(1),
  daemon: z
    .object({
      from: z.number().int(),
      to: z.number().int(),
      road: z.enum(["link", "ssh"]),
      at: z.string(),
      kept: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});
export type PlaceUpdateReply = z.infer<typeof PlaceUpdateReply>;

const PlaceHeldRow = z.object({ name: z.string(), threads: z.number().int() });

/** What a remove of a computer takes with it: the forks wsp made there and the projects recorded on it, each with
 * its threads, and, one line each, the work among them that is on no remote yet, which stops a remove unforced. */
export const PlaceHolds = z.object({ forks: z.array(PlaceHeldRow), projects: z.array(PlaceHeldRow), unsaved: z.array(z.string()) });
export type PlaceHolds = z.infer<typeof PlaceHolds>;

/** What places.remove answers: whether a computer of that id was there, the forks and projects that went with it,
 * every line of what the sweep took off it, and the one line for a computer that was not connected to sweep. */
export const PlaceRemoved = z.object({ removed: z.boolean(), took: PlaceHolds.omit({ unsaved: true }).optional(), swept: z.array(z.string()), note: z.string().optional() });
export type PlaceRemoved = z.infer<typeof PlaceRemoved>;

export { HERE_PLACE_ID, namesPlace, placeRenameRefusal, placeSshRefusal, placeSshOtherRefusal, placeSshUncheckedRefusal, placeLoginOtherRefusal, placeLoginUncheckedRefusal, placeLoginElsewhere, placeLoginElsewhereRemovedLine, type RefusalHalves };

/** What one row of the places list holds of the person's money: the spend it has taken since midnight and since
 * the first of the month, over every workspace that stood on it then, deleted ones included, and what it is burning
 * right now over the ones still there. How many workspaces that is, the caller counts off its own list. */
export const PlaceSpend = z.object({ place: z.string(), todayUsd: z.number(), monthUsd: z.number(), rateUsdPerHour: z.number() });
export type PlaceSpend = z.infer<typeof PlaceSpend>;

/** A computer you own finished its join, with the address it dialled from as `ws` reported it. The view carries
 * what it said about itself, so the sheet fills its row off this one event. */
export const PlaceJoinedEvent = z.object({ type: z.literal("place.joined"), place: PlaceView, from: z.string() });
export const PlacePresentEvent = z.object({ type: z.literal("place.present"), placeId: z.string(), from: z.string() });
/** `said` is the runtime's own reason where it has one, as for a box whose kernel can no longer boot the image. */
export const PlaceAbsentEvent = z.object({ type: z.literal("place.absent"), placeId: z.string(), said: z.string().optional() });
export const PlaceRemovedEvent = z.object({ type: z.literal("place.removed"), placeId: z.string() });
/** A setting of a computer changed, from any window or the command line: the row as it now reads. */
export const PlaceChangedEvent = z.object({ type: z.literal("place.changed"), place: PlaceView });
/** An add that has not reached Set up moved, or went: `pending` as it now stands, absent once it became a computer
 * or was taken away. */
export const PlacePendingEvent = z.object({ type: z.literal("place.pending"), id: z.string(), pending: PendingComputer.optional() });
export type PlacePendingEvent = z.infer<typeof PlacePendingEvent>;

/** The five as one type, so the host's door and the app's fold read one shape. */
export type PlaceEvent = z.infer<typeof PlaceJoinedEvent> | z.infer<typeof PlacePresentEvent> | z.infer<typeof PlaceAbsentEvent> | z.infer<typeof PlaceRemovedEvent> | z.infer<typeof PlaceChangedEvent>;

/** A project was recorded, so every client's list follows without a refetch. */
export const ProjectAddedEvent = z.object({ type: z.literal("project.added"), project: ProjectView });
export type ProjectAddedEvent = z.infer<typeof ProjectAddedEvent>;

/** How far one add has got, one event per stage, so a client watching an add reads the clone, the seed and the
 * install as they happen rather than waiting on one reply. */
export const ProjectAddEvent = z.object({
  type: z.literal("project.add"),
  projectId: z.string(),
  computer: z.string(),
  stage: ProjectAddStage,
  message: z.string(),
  elapsedMs: z.number(),
});
export type ProjectAddEvent = z.infer<typeof ProjectAddEvent>;

/** Something the host did on its own that the person hears once, in a sentence of its own. */
export const HostNoticeEvent = z.object({ type: z.literal("host.notice"), message: z.string() });
/** A piece of a side question's answer as the harness writes it, under the askId the question carried. Passes by and
 * is kept nowhere: the reply to sessions.aside carries the whole answer. */
export const AsideTextEvent = z.object({ type: z.literal("aside.text"), workspaceId: z.string(), threadId: z.string().optional(), askId: z.string(), text: z.string() });
export type HostNoticeEvent = z.infer<typeof HostNoticeEvent>;

/** A project's record was dropped. */
export const ProjectRemovedEvent = z.object({ type: z.literal("project.removed"), projectId: z.string() });
export type ProjectRemovedEvent = z.infer<typeof ProjectRemovedEvent>;
