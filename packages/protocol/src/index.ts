// The typed contract every client speaks: workspace/session views, the event
// union fanned out by the runtime, and the wire types for both servers (the
// runtime's serveRuntime and the in-VM daemon). The daemon package has no
// exported wire types, so these schemas are their one home; @wsp/daemon's
// handlers are the reference implementation they mirror.

import { z } from "zod";
import { ImageAttachment, ImageRecord } from "./attachments.js";
import { openingTitle, titleLine } from "./format.js";
import { rootsPathIn } from "./project-path.js";
import { shellQuote } from "./shell-quote.js";
import { WorkspaceGlyph, WorkspaceLook, WorkspaceTint } from "./workspace-look.js";

/** The one rule for a URL a guest may hand to the laptop: http or https in any
 * case, no whitespace or control characters, at most HTTP_URL_MAX bytes, and
 * it parses (so a hostname can always be read from it without throwing). The
 * machine is the untrusted side, so the host and the app apply it too. The
 * daemon carries a copy (it must not bundle this package); a test pins the two
 * equal. */
export const HTTP_URL_RE = /^https?:\/\/[^\s\x00-\x1f\x7f]+$/i;
export const HTTP_URL_MAX = 8192;
/** The most bytes one exec request body may carry, the backend's wrapper included: the provider answers 413 Payload
 * Too Large above 16 KiB (a 17,176 byte launch body was refused on 2026-09-06). Anything larger goes to the guest in
 * more than one exec or through an upload. */
export const EXEC_BODY_MAX = 16 * 1024;
/** How much of a detached command's output one poll exec reads; a full read is followed by another at once. */
export const EXEC_CHUNK_BYTES = 262_144;
/** How long a turn may do nothing at all before the runtime cuts it: no byte on its stream, no message from the
 * person, and no work in the process tree it started. It is the one rule that ends a turn the harness left hanging:
 * a fixed wall clock cut a build that was still working at 15 minutes on 2026-09-06. */
export const TURN_IDLE_MS = 10 * 60_000;
/** How hard the process tree a turn started has to be working for the turn to count as alive while it prints
 * nothing: ticks per second, where a tick is 10 ms of CPU or a megabyte of I/O anything the turn started moved. Five
 * percent of one core clears it, which a vitest batch or a packager does many times over; a harness process waking
 * on its own timers stays under it, so a turn nothing is working on is still cut at TURN_IDLE_MS. */
export const TURN_WORK_TICKS_PER_S = 5;
/** How long a permission prompt relayed into the chat waits for an answer before the runtime denies it in the
 * person's place. Well inside TURN_IDLE_MS: a waiting prompt writes no byte, so a wait past the idle cut would take
 * the turn with it and the thread would read as hung rather than as unanswered. */
export const PERMISSION_WAIT_MS = 5 * 60_000;
/** How long a thread sits idle before the sidebar folds it out of that workspace's shelf into its Archived group.
 * The fold reads the thread's own last activity, so a thread that takes a new turn leaves the archive by itself and
 * there is no archived flag anywhere to set or clear. */
export const THREAD_ARCHIVE_MS = 24 * 60 * 60_000;
/** The longest one turn may run however much it prints, a safety cap only; a per-workspace setting is a follow-up. */
export const TURN_WALL_MS = 6 * 60 * 60_000;
/** How long a harness gets to exit on its own after the result its turn ended on, before the runtime ends it and its
 * tree. Long enough for the harness to flush its own session store and go, short enough that a machine running turns
 * all day never carries more than the one it is on: seven finished turns' processes were found alive on one guest,
 * the oldest fourteen hours past its reply, and the box read load 25 while idle (2026-09-08). */
export const RUN_EXIT_MS = 10_000;
/** How long a turn's process gets to go on the graceful signal before its group is killed, on either road: what the
 * guest's reap waits between its TERM and its KILL, and what a host gives the turns on this computer as it stops. */
export const RUN_STOP_MS = 2_000;
/** The close code a host sends the clients on its own socket as it stops: the socket did not break under them, the
 * host let it go, so a command waiting on a turn says the host is restarting rather than that the turn failed. */
export const HOST_STOPPING_CLOSE = 4001;
export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > HTTP_URL_MAX || !HTTP_URL_RE.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/** The host of a URL that passed isHttpUrl (with its port, without userinfo), or undefined when it does not parse: never throws. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** A callback port the laptop can bind without root; the host refuses anything else before it listens. */
export const RelayPort = z.number().int().min(1024).max(65535);

/** A guest port the host forwards to this computer's loopback (localhost:<port>
 * here reaches the workspace's listener). The host holds them; the app lists
 * them and stops them. name is what the app shows: the workspace's, or the
 * builder's, since a builder's forwards carry the builder id. kind says why the
 * port is open: url, a link the workspace printed, which the app offers to
 * open; callback, a sign-in flow's redirect, which the app names and never
 * dials (a bare request would end the flow). */
export const PortForward = z.object({ workspaceId: z.string(), port: RelayPort, startedAt: z.string(), name: z.string(), kind: z.enum(["url", "callback"]) });
export type PortForward = z.infer<typeof PortForward>;

// --- backend capabilities ----------------------------------------------------

export const WorkspaceSize = z.object({ cpu: z.number(), memMb: z.number() });
export type WorkspaceSize = z.infer<typeof WorkspaceSize>;

/** One size a create may ask for, with what it costs awake. */
export const MachineSizeOffer = WorkspaceSize.extend({ rateUsdPerHour: z.number() });
export type MachineSizeOffer = z.infer<typeof MachineSizeOffer>;

/** Honest per-backend feature flags; the UI degrades based on these, never on probing. */
export const Capabilities = z.object({
  liveCloneForks: z.boolean(),
  ramPreservingPause: z.boolean(),
  resize: z.boolean(),
  previewUrls: z.boolean(),
  signedUrls: z.boolean(),
  /** Guests can run containers; false means services get installed natively. */
  containers: z.boolean(),
  /** A daemon link exists, so sign-in URLs a guest tool opens land in the laptop's browser and the
   * callback port is forwarded back; false means the person finishes sign-ins by copy and paste. */
  callbackRelay: z.boolean(),
  /** The provider lists every snapshot on the account with its size, so storage can be counted and priced. */
  snapshotListing: z.boolean(),
  /** The provider promotes a snapshot to a template that survives its own restarts, so a sealed version is recorded
   * as one and forked from it; false keeps every version on its snapshot. */
  templates: z.boolean(),
  /** Every size a create may ask for; a create that names another is refused with this list. A create that names
   * none takes the golden's size, which need not be on it. */
  sizes: z.array(MachineSizeOffer),
  /** The machine is the person's own, kept: its files, its sign-ins and its git checkouts outlive every turn, and
   * wsp neither made it nor throws it away. False on a fork wsp made, where a turn that wrecks the disk costs a
   * rebuild and nothing else. What a turn's access starts at reads this, not the workspace's kind. */
  kept: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

// --- views -----------------------------------------------------------------

/** pausing: the runtime is stashing the vault and asking the provider to pause; a send is refused from here on.
 * gone: the provider no longer knows the machine (deleted behind wsp, or expired); nothing bills and nothing
 * runs until a rebuild puts a fresh fork under the record or the workspace is deleted. */
export const WorkspacePhase = z.enum(["running", "pausing", "napping", "waking", "gone"]);
export type WorkspacePhase = z.infer<typeof WorkspacePhase>;

/** Backend vocabulary: a napping workspace's machine reads "paused" here.
 * Phase is the product word, machine state the provider word; clients render
 * phase and use machineState only for divergence (starting, gone). */
export const MachineState = z.enum(["starting", "running", "paused", "gone"]);
export type MachineState = z.infer<typeof MachineState>;

/** slow: the edge answered late or 502'd while the machine runs (a provider slow
 * spell, measured: 502 after 5 to 11 s with an open socket to the same guest
 * still working); it is not no-daemon (a prompt 502) and not unreachable (silence).
 * zombie: the provider reports the machine running, reach has been slow or
 * unreachable for minutes, and a bounded exec probe failed too; the guest is
 * dead behind a live control plane (measured twice at rest). Phase stays
 * running; status.reason carries the timings; workspaces.rebuild is the way out. */
export const ReachState = z.enum(["reachable", "no-daemon", "unreachable", "napping", "unsupported", "gone", "slow", "zombie"]);
export type ReachState = z.infer<typeof ReachState>;

export const ReachStatus = z.object({
  state: ReachState,
  url: z.string().optional(),
  expiresAt: z.number().optional(),
  /** The probe never left this computer (no DNS, no network), so nothing was learnt about the machine: state is the
   * last word the row showed, and the computer is offline. */
  offline: z.boolean().optional(),
});
export type ReachStatus = z.infer<typeof ReachStatus>;

/** What a browser needs to dial a workspace's daemon: the minted preview route
 * (edge token embedded, hourly expiry) and the daemon token the host minted at
 * start and wrote to the guest, sent as the socket's first frame, never in the
 * URL. No daemonToken means no daemon on that machine. */
export const DaemonReachView = z.object({
  url: z.string(),
  expiresAt: z.number(),
  daemonToken: z.string().optional(),
});
export type DaemonReachView = z.infer<typeof DaemonReachView>;

/** The same minted route for any other guest port, as a browser frames it. The
 * daemon token stays off this view: it opens the daemon's socket, not a page. */
export const PortReachView = DaemonReachView.omit({ daemonToken: true });
export type PortReachView = z.infer<typeof PortReachView>;

/** What the host saw fetching a guest port's route once, as a browser's frame
 * does: the status and the start of the body. A frame on another origin can
 * read neither, so the pane asks for this to explain a refusal (a dev server's
 * host check, the edge) instead of showing a white page. */
export const PortProbeView = z.object({ status: z.number().int(), body: z.string() });
export type PortProbeView = z.infer<typeof PortProbeView>;

/** The project a workspace holds: the folder the bundle landed at, named by its last segment, and when the bundle
 * landed. Set by an import, inherited by every fork of a project golden. */
export const WorkspaceProject = z.object({ name: z.string(), dest: z.string(), importedAt: z.string() });
export type WorkspaceProject = z.infer<typeof WorkspaceProject>;

/** What a workspace's machine is: cloud, a fork wsp made at a provider, or local, this computer itself. A missing
 * kind reads cloud, since every record written before local workspaces existed was one. The one fact every road
 * that varies by machine kind reads; nothing switches on it outside the backend registry. */
export const WorkspaceKind = z.enum(["cloud", "local"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

/** Where a request to a workspace verb came from: here, this computer's own app, CLI or MCP, or relayed from a
 * machine wsp runs. A local workspace answers only `here`; today no machine has a road into the host, so nothing
 * relays yet, and the rule is written and tested so it holds when one appears. */
export const WorkspaceOrigin = z.enum(["here", "relayed"]);
export type WorkspaceOrigin = z.infer<typeof WorkspaceOrigin>;

export const WorkspaceView = z.object({
  id: z.string(),
  name: z.string(),
  machineId: z.string(),
  phase: WorkspacePhase,
  /** cloud, a provider fork, or local, this computer; absent reads cloud (every record from before local existed). */
  kind: WorkspaceKind.optional(),
  /** Snapshot id of the image this workspace forks from: a golden version's, or a project golden's; empty on a local
   * workspace, which forks from no image. */
  golden: z.string(),
  createdAt: z.string(),
  project: WorkspaceProject.optional(),
  /** Claude session id of the last session, so the next send can --resume it. */
  claudeSessionId: z.string().optional(),
  /** Present when the machine streams a display (desktop kind); sandbox machines are headless. */
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** With phase gone: the provider's words when it stopped knowing the machine; every refusal quotes them. */
  gone: z.string().optional(),
  /** The hue a person picked for this workspace; absent is none, and nothing is tinted. */
  tint: WorkspaceTint.optional(),
  /** The glyph a person picked for this workspace; absent is none, and the state dot stands alone. */
  glyph: WorkspaceGlyph.optional(),
  /** One line for the machine's row while the runtime is doing something to the machine's daemon, or why the last
   * attempt failed; absent whenever there is nothing to say. Not persisted: it says what this process is doing. */
  daemonNote: z.string().optional(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/** WorkspaceView enriched with what the rail and meta panel render live. */
export const WorkspaceStatus = WorkspaceView.extend({
  machineState: MachineState,
  reach: ReachStatus,
  size: WorkspaceSize,
  /** Awake burn rate for this size; 0 never appears here (napping costs ride the cost event). */
  rateUsdPerHour: z.number(),
  /** Why the runtime pushed this status outside the poll: a wake that had to retry or replace the machine, or "idle 20 min". */
  reason: z.string().optional(),
  /** Epoch ms when the runtime's idle policy naps this workspace; absent while napping, held by a running session, or with auto-nap off. */
  idleAt: z.number().optional(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

export const SessionStatus = z.enum(["running", "completed", "interrupted", "failed"]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Who asked the runtime for the turn: a person in the app, the command line on this computer, or a local agent
 * through the MCP server. All are clients of one host; the sidebar shows which one opened a thread. */
export const SessionOrigin = z.enum(["person", "cli", "agent"]);
export type SessionOrigin = z.infer<typeof SessionOrigin>;

/** Where a thread's title came from, the one rule that decides whether a new one may replace it: seed is the opening
 * turn's own words, here or in the harness's own store, auto the one title the harness was asked for as the first turn
 * started, person a name the person gave the thread here or inside the harness. Auto replaces a seed and nothing else;
 * a person's name is never replaced. */
export const TitleSource = z.enum(["seed", "auto", "person"]);
export type TitleSource = z.infer<typeof TitleSource>;

export const SessionView = z.object({
  id: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  status: SessionStatus,
  /** Who opened the thread this row belongs to: a resumed turn takes over the row of the turn it resumes and keeps
   * its answer. Absent on rows written before provenance was recorded; foldThreads reads those as a person's. */
  startedBy: SessionOrigin.optional(),
  claudeSessionId: z.string().optional(),
  /** The thread this turn belongs to, as the runtime stamps its events; rows sharing one are one sidebar thread. */
  threadId: z.string().optional(),
  /** The turn that opened this row's thread; a resumed turn keeps it, and its own prompt rides its session.start
   * event, so the title every client derives from a row never follows the latest send. */
  prompt: z.string().optional(),
  /** What the harness itself calls this row's session, read from the harness's own store on the machine: the title
   * it generated, or the person's rename inside it. Absent on a harness that keeps none, and until one is read. */
  harnessTitle: z.string().optional(),
  /** Where harnessTitle came from; absent on a row written before provenance was recorded and on one with no title
   * at all, both of which read as seed. */
  titleSource: TitleSource.optional(),
  /** Ms epoch, runtime clock; endedAt is unset while the session runs. */
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the harness runs in: the start request's until the harness announces its own. A resume of this
   * session runs here whatever folder it asks for, since the CLI keys the session to it; the shell folder the
   * agent's tool calls move rides the delta events instead. */
  cwd: z.string().optional(),
  /** What the session runs with, as the harness's own slugs: the start request's model until the harness announces
   * its own; effort as requested, since the CLI never echoes it, and the permission mode the turn is at, which is
   * the start's until a pick moves a running turn to another one. */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  contextWindow: z.string().optional(),
});
export type SessionView = z.infer<typeof SessionView>;

/** One sidebar thread as every client lists it: the turns sharing a threadId (a row stamped none is its own),
 * titled by what the harness calls the latest turn's session and by the opening turn's words where it calls it
 * nothing, in the state and times of the latest, with the opening turn's provenance, always filled in. id is the
 * fold key, the runtime's thread id or the lone row's id; sessionId is the latest turn's row id, what a stop
 * interrupts; claudeSessionId is the latest turn's harness id, what a send resumes. */
export const ThreadView = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  workspaceId: z.string(),
  harness: z.string(),
  startedBy: SessionOrigin,
  status: SessionStatus,
  title: z.string(),
  sessionId: z.string(),
  claudeSessionId: z.string().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /** The folder the latest turn's harness runs in, as SessionView.cwd; absent when no turn recorded one. */
  cwd: z.string().optional(),
  turns: z.number().int().positive(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** Folds the session index into threads, in the order each thread's first turn appears. The one place a row from
 * before provenance was recorded is read as a person's; clients print the answer and never decide it. */
export function foldThreads(sessions: ReadonlyArray<SessionView>): ThreadView[] {
  const byThread = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = session.threadId ?? session.id;
    const turns = byThread.get(key);
    if (turns === undefined) byThread.set(key, [session]);
    else turns.push(session);
  }
  return [...byThread].map(([id, turns]) => {
    const first = turns[0]!;
    const latest = turns[turns.length - 1]!;
    // The one title rule every client reads: the harness's own name for the session the next send resumes wins, so
    // a rename made inside the harness shows here, and the opening turn's first sentence stands until one is read.
    const title = latest.harnessTitle !== undefined ? titleLine(latest.harnessTitle) : first.prompt !== undefined ? openingTitle(first.prompt) : first.claudeSessionId ?? first.id;
    return {
      id,
      ...(first.threadId !== undefined ? { threadId: first.threadId } : {}),
      workspaceId: first.workspaceId,
      harness: first.harness,
      startedBy: first.startedBy ?? "person",
      status: latest.status,
      title,
      sessionId: latest.id,
      ...(latest.claudeSessionId !== undefined ? { claudeSessionId: latest.claudeSessionId } : {}),
      ...(latest.startedAt !== undefined ? { startedAt: latest.startedAt } : {}),
      ...(latest.endedAt !== undefined ? { endedAt: latest.endedAt } : {}),
      ...(latest.cwd !== undefined ? { cwd: latest.cwd } : {}),
      turns: turns.length,
    };
  });
}

// --- harness catalog (what the composer's pickers may offer) -------------------

/** One value a harness's CLI accepts for a picker, as the CLI spells it; the label is what the picker shows. */
export const HarnessOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
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
});
export type HarnessModel = z.infer<typeof HarnessModel>;

export const HarnessCatalogSource = z.enum(["harness", "table"]);
export type HarnessCatalogSource = z.infer<typeof HarnessCatalogSource>;

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
  /** Set on the harness a start without one runs, so a client can pick its list without the catalog package. */
  isDefault: z.boolean().optional(),
  /** Why the binary described nothing, in its own adapter's words, when it ran and refused for a reason it can name
   * (no sign-in); absent when it simply did not answer, and on a catalog the binary filled. */
  refusal: z.string().optional(),
  /** The slug of the cheapest model this harness offers, the one a thread's title is asked of; it rides the row so a
   * harness added to the table names its own. Absent where the harness offers no model of its own, and the title
   * question runs on whatever the CLI would run without one. */
  smallModel: z.string().optional(),
  /** The access a thread on a kept machine starts at: the mode whose tools reach the person as a prompt where this
   * CLI can ask one (Claude Code's default over its control stream), else the narrowest mode that still lets a turn
   * work, for a CLI with no road to ask (codex exec runs non-interactively, so its sandbox is the whole answer).
   * The mode marked isDefault is what a throwaway machine runs instead, which is bypass on every row here. Absent
   * on a harness whose CLI takes no access mode at all. */
  keptMode: z.string().optional(),
  /** This CLI's mode that runs every tool without asking anyone, as it spells it. A kept machine's picker names the
   * machine on this one, since picking it hands that computer over for the turn. Absent on a harness whose CLI has
   * no such mode. */
  bypassMode: z.string().optional(),
});
export type HarnessCatalog = z.infer<typeof HarnessCatalog>;

/** The catalog a kept machine's composer shows and its starts are checked against: the same lists, with the default
 * mark moved from what a throwaway machine runs to keptMode, and the row's own bypassMode named after the machine it
 * is about to touch, so the pick that skips the prompts says whose computer it skips them on. One pick away, in the
 * same list, in the same order. A catalog with no keptMode (a CLI that takes no access mode) comes back as it went
 * in. `machine` is the machine in words, the one phrase every local surface uses.
 */
export function keptAccess(catalog: HarnessCatalog, machine: string): HarnessCatalog {
  if (catalog.keptMode === undefined) return catalog;
  const permissionModes = catalog.permissionModes.map(({ isDefault: _throwaway, ...mode }) => ({
    ...mode,
    ...(mode.value === catalog.keptMode ? { isDefault: true } : {}),
    ...(mode.value === catalog.bypassMode ? { label: `${mode.label} on ${machine}` } : {}),
  }));
  return { ...catalog, permissionModes };
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

/** The option a list marks as its default, if one is: what an unpicked picker shows and an unnamed start runs. */
export function markedDefault<T extends HarnessOption>(options: ReadonlyArray<T>): T | undefined {
  return options.find(o => o.isDefault === true);
}

function narrowed(all: ReadonlyArray<HarnessOption>, subset: ReadonlyArray<string> | undefined): HarnessOption[] {
  return subset === undefined ? [...all] : all.filter(o => subset.includes(o.value));
}

/** The efforts a model takes: its own subset of the catalog's, in the catalog's order, else all of them, with the
 * one this pick runs at when a turn names none marked. The picked model's own default wins where the binary named
 * one, and the catalog's mark stands only for a model that names none, so the mark is the default of this pick and
 * not of the harness. A model that names a default its own list does not carry marks nothing, as a catalog whose
 * binary does. This is the one rule for that: the composer's effort picker and startPicks both read it. */
export function effortsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  const options = narrowed(catalog.efforts, model?.efforts);
  const own = model?.defaultEffort;
  if (own === undefined) return options;
  return options.map(({ isDefault: _harness, ...rest }) => (rest.value === own ? { ...rest, isDefault: true } : rest));
}

/** The model a pick names, as the catalog knows it; a slug the catalog does not list still counts, named by itself. */
export function modelOf(catalog: HarnessCatalog, value: string | undefined): HarnessModel | null {
  if (value === undefined) return null;
  return catalog.models.find(m => m.value === value) ?? { value, label: value };
}

/** None without a model: the window rides the model as a suffix, so there is nothing to offer it on. */
export function contextWindowsFor(catalog: HarnessCatalog, model: HarnessModel | null): HarnessOption[] {
  return model === null ? [] : narrowed(catalog.contextWindows, model.contextWindows);
}

/** The picks a start names, as sessions.start carries them. */
export interface StartPicks {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

/**
 * A remembered pick read against the list in front of us: the value where that list carries it, nothing where it
 * does not. Every reader of a pick kept for later needs this and there is one rule for all of them, because a pick
 * is remembered per workspace while the lists belong to a harness and no two harnesses share one (claude's access
 * modes and codex's are disjoint sets, as are their models and efforts). A pick the resolved harness does not take
 * is not a request to refuse: it is a pick that does not apply here, so it is dropped and that list's own default
 * runs. startPicks refuses a value a caller NAMED, which is a different thing and stays an error.
 */
export function listedPick(options: ReadonlyArray<HarnessOption>, value: string | undefined): string | undefined {
  return value !== undefined && options.some(o => o.value === value) ? value : undefined;
}

const optionWords = (options: ReadonlyArray<HarnessOption>): string => options.map(o => `${o.label} (${o.value})`).join(", ");

function listed(subject: string, word: string, options: ReadonlyArray<HarnessOption>, value: string | undefined): void {
  if (value === undefined || options.some(o => o.value === value)) return;
  throw new Error(options.length === 0 ? `${subject} takes no ${word}` : `${word} "${value}" is not one ${subject} takes; one of: ${optionWords(options)}`);
}

function checkedAgainst(catalog: HarnessCatalog, picks: StartPicks, model: string | undefined): void {
  if (catalog.models.length > 0) listed(catalog.harness, "model", catalog.models, picks.model);
  const chosen = modelOf(catalog, model);
  if (catalog.efforts.length > 0) listed(chosen?.efforts !== undefined ? chosen.label : catalog.harness, "effort", effortsFor(catalog, chosen), picks.effort);
  if (catalog.permissionModes.length > 0) listed(catalog.harness, "access mode", catalog.permissionModes, picks.permissionMode);
}

/** The picks a start runs with, checked against the catalog: a value a list does not carry is refused naming the
 * list in the composer's words, and a list the CLI leaves empty (no such flag, or open values) takes any value. A
 * start that opens a thread without a model runs the one the catalog marks default, and without an effort the one
 * effortsFor marks for that model, so every door runs what the composer shows; a resume keeps the thread's own.
 * Without a catalog (a harness the runtime has no table row for) every value passes and no default is filled. Only
 * the three picks come out, whatever else rides in. */
export function startPicks(catalog: HarnessCatalog | undefined, picks: StartPicks, opensThread: boolean): StartPicks {
  const model = picks.model ?? (opensThread && catalog !== undefined ? markedDefault(catalog.models)?.value : undefined);
  if (catalog !== undefined) checkedAgainst(catalog, picks, model);
  const effort = picks.effort ?? (opensThread && catalog !== undefined ? markedDefault(effortsFor(catalog, modelOf(catalog, model)))?.value : undefined);
  // The access is filled in like the other two, so what the picker shows is what the CLI is told: an unnamed access
  // used to reach the adapter as nothing, which every adapter here reads as its own skip-everything flag. On a kept
  // machine that turned the picker's Default into bypass behind the person's back.
  const permissionMode = picks.permissionMode ?? (opensThread && catalog !== undefined ? markedDefault(catalog.permissionModes)?.value : undefined);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}

// --- session events (the wire form of adapter-port.ts's AdapterEvent) ------

export const DeltaKind = z.enum(["text", "thinking", "tool_use", "tool_result"]);
export type DeltaKind = z.infer<typeof DeltaKind>;

export const TurnStatus = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatus>;

export const TurnResult = z.object({
  status: TurnStatus,
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  usage: z.record(z.unknown()).optional(),
  text: z.string().optional(),
  error: z.string().optional(),
});
export type TurnResult = z.infer<typeof TurnResult>;

const sessionScope = {
  workspaceId: z.string(),
  sessionId: z.string(),
  /** Ms epoch from the runtime clock when it recorded the event; the adapter has no clock of its own. */
  at: z.number().optional(),
  /** Minted by the runtime per sessions.start. The Claude session id repeats across --resume, so it
   * cannot split a transcript into turns; this can. */
  turnId: z.string().optional(),
  /** Minted by the runtime at a start without resume and kept by every start that resumes into it, so a
   * transcript folds into threads where it changes. Absent on transcripts from before it: those are one thread. */
  threadId: z.string().optional(),
};

/** What the CLI announces about itself in system/init, beyond model and tools. */
export const SessionHarness = z.object({
  slashCommands: z.array(z.string()).optional(),
  permissionMode: z.string().optional(),
  agents: z.array(z.string()).optional(),
});
export type SessionHarness = z.infer<typeof SessionHarness>;

export const SessionStartEvent = z.object({
  type: z.literal("session.start"),
  ...sessionScope,
  /** The user's turn; set by the runtime (the adapter never sees it) so a replayed transcript shows it. */
  prompt: z.string().optional(),
  /** The images the person's message carried, as records: their type, their weight and their name, never their
   * pixels, which reach the harness and nothing else. Absent on a turn that carried none. */
  attachments: z.array(ImageRecord).optional(),
  /** The id the client minted for the sessions.start that opened this turn, stamped by the runtime; absent when the
   * client sent none. Two clients sending the same text at the same moment are told apart by this, not the prompt. */
  requestId: z.string().optional(),
  /** Set when the thread's previous turn ended with no exit code and no result (a deadline, a host restart, a nap
   * that ended it), so clients say the harness resumes a transcript that may be missing context; absent otherwise. */
  afterCut: z.literal(true).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  /** The access this turn ran at, as the harness's own slug; the runtime's pick, not the CLI's echo. It rides the
   * row so a resume past the session index cap still reads what the thread was opened at rather than falling back
   * to the adapter's unnamed default. Absent on a turn from before it was recorded. */
  permissionMode: z.string().optional(),
  tools: z.array(z.string()).optional(),
  harness: SessionHarness.optional(),
});

export const SessionDeltaEvent = z.object({
  type: z.literal("session.delta"),
  ...sessionScope,
  kind: DeltaKind,
  text: z.string(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  isError: z.boolean().optional(),
  /** The agent's tool shell folder after this tool_use, present only when the call moved it (a cd, or a file written
   * in a folder beside the one followed so far); the panes follow it while the harness folder stays put. */
  cwd: z.string().optional(),
  /** Where this line sits in its turn, counting from one; not to be confused with `seq`, which the bus stamps on the
   * wire and the transcript never carries. A host that re-opens a running turn reads the run's output from its first
   * byte, and this is how it knows how much of it is already written: the transcript is capped per workspace and
   * drops its oldest rows, so how many of a turn's rows survive says nothing about how many there were. Absent on a
   * row written before the stamp existed. */
  line: z.number().int().positive().optional(),
});

export const SessionDoneEvent = z.object({
  type: z.literal("session.done"),
  ...sessionScope,
  result: TurnResult,
});

export const SessionEndEvent = z.object({
  type: z.literal("session.end"),
  ...sessionScope,
  exitCode: z.number().nullable(),
  sawResult: z.boolean(),
  /** Set when the runtime ended the session itself (a nap, a delete, a machine that stopped answering) rather than the harness exiting. */
  reason: z.string().optional(),
});

/** A message the person sent into the turn while it ran; stamped by the runtime once the harness took it, so a
 * replayed transcript shows it where the turn saw it. No session.start comes with it: the turn is the same one. */
export const SessionSteerEvent = z.object({
  type: z.literal("session.steer"),
  ...sessionScope,
  prompt: z.string(),
  /** The id the client minted for the sessions.steer, as on session.start. */
  requestId: z.string().optional(),
});

/** Pushed once when a start finds the thread's turn running and a harness that takes no message mid-turn, so the
 * caller can say it is waiting before the start's reply comes; not a session event, never in history. */
export const SessionQueuedEvent = z.object({
  type: z.literal("session.queued"),
  workspaceId: z.string(),
  threadId: z.string(),
  prompt: z.string(),
  /** The id the client minted for the sessions.start that waits. */
  requestId: z.string().optional(),
});
export type SessionQueuedEvent = z.infer<typeof SessionQueuedEvent>;

/** The word a start's notify carries to mean the person who ran it, not a thread. */
export const NOTIFY_ME = "me";

/** The turn ended and its one line (notifyLine) went where the thread's start said: into the named thread as a send
 * would go, steered or queued, or, for me, to the person, whom the CLI and the app tell from this event. Recorded in
 * the ending thread's transcript, before its session.done, so the line's source is visible and a follower that ends
 * on the done still sees it. */
export const SessionNotifyEvent = z.object({
  type: z.literal("session.notify"),
  ...sessionScope,
  /** The thread the line went to, or NOTIFY_ME. */
  notify: z.string(),
  text: z.string(),
});
export type SessionNotifyEvent = z.infer<typeof SessionNotifyEvent>;

/** What picking one option on a permission prompt does to the tool call in front of it: run it, refuse it, or run it
 * and leave the rest of the turn in another access mode, which is how a harness offers "and stop asking about
 * edits". The runtime hands the option's id back to the adapter, which turns it into whatever its CLI takes. */
export const PermissionEffect = z.enum(["allow", "deny", "mode"]);
export type PermissionEffect = z.infer<typeof PermissionEffect>;

export const PermissionOption = z.object({
  id: z.string(),
  label: z.string(),
  effect: PermissionEffect,
  /** The access mode the rest of the turn runs in when this option is picked; set on the mode effect only. */
  mode: z.string().optional(),
});
export type PermissionOption = z.infer<typeof PermissionOption>;

/** How a permission prompt ended. allowed and denied are a person's pick. unanswered is the runtime's own deny after
 * PERMISSION_WAIT_MS, the policy for a thread nobody is watching. cancelled is the prompt going with its turn: a
 * stop, or a harness that withdrew the question. */
export const PermissionOutcome = z.enum(["allowed", "denied", "unanswered", "cancelled"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcome>;

/** One permission prompt the harness raised, relayed into the chat as its own row: the tool it wants to run, what it
 * wants to run it on, and the options the person may pick. The prompt blocks the turn until sessions.answer names an
 * option or the runtime's wait runs out, so the row is what the thread is waiting on. */
export const SessionPermissionEvent = z.object({
  type: z.literal("session.permission"),
  ...sessionScope,
  /** What sessions.answer names this prompt by; unique inside its turn. */
  askId: z.string(),
  toolName: z.string(),
  /** The tool_use this prompt is about, so the row sits with the call it belongs to; absent where the harness
   * named none. */
  toolUseId: z.string().optional(),
  /** The tool's input as the harness sent it, JSON, the same text a tool_use delta carries. */
  input: z.string(),
  /** The harness's own one phrase for the call (a file name, a command); absent where it named none. */
  detail: z.string().optional(),
  options: z.array(PermissionOption),
  /** How long this prompt waits before the runtime denies it, from `at`; absent on a prompt the runtime does not
   * time out. */
  waitMs: z.number().optional(),
});
export type SessionPermissionEvent = z.infer<typeof SessionPermissionEvent>;

/** The prompt above is closed and the turn moved on. One of these lands for every session.permission, so a
 * transcript never leaves a row waiting on an answer that was given while nobody was reading. */
export const SessionPermissionClosedEvent = z.object({
  type: z.literal("session.permission.closed"),
  ...sessionScope,
  askId: z.string(),
  outcome: PermissionOutcome,
  /** The option that closed it, on a person's pick; absent on the runtime's own deny and on a cancel. */
  optionId: z.string().optional(),
});
export type SessionPermissionClosedEvent = z.infer<typeof SessionPermissionClosedEvent>;

/** The events sessions.history replays: what a chat transcript folds. */
export const SessionEvent = z.discriminatedUnion("type", [
  SessionStartEvent,
  SessionDeltaEvent,
  SessionDoneEvent,
  SessionEndEvent,
  SessionSteerEvent,
  SessionNotifyEvent,
  SessionPermissionEvent,
  SessionPermissionClosedEvent,
]);
export type SessionEvent = z.infer<typeof SessionEvent>;

/** Every type a session event carries, read off the union itself: a client telling a session event from the rest of
 * the bus asks this rather than keeping a list of its own, which one added event leaves quietly short. */
export const SESSION_EVENT_TYPES: ReadonlySet<SessionEvent["type"]> = new Set(SessionEvent.options.map(o => o.shape.type.value));

// --- workspace / port / inbox events ----------------------------------------

/** A machine this runtime now has: a create that landed, or a record the sweep restored from the provider's
 * listing. Readers that meter the machine (the awake stretch, the auto-nap window) take it as the machine coming
 * up, so a change to a record a client already holds is never this event. */
export const WorkspaceCreatedEvent = z.object({ type: z.literal("workspace.created"), workspace: WorkspaceView });
/** The awaited steps of a create in the order the runtime reaches them; `failed` ends a create that threw. */
export const WorkspaceCreateStage = z.enum(["fork-requested", "machine-booting", "hostname-set", "preview-route", "daemon-answering", "ready", "failed"]);
export type WorkspaceCreateStage = z.infer<typeof WorkspaceCreateStage>;
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
});
export type WorkspaceCreatingEvent = z.infer<typeof WorkspaceCreatingEvent>;
/** found is set when the provider had already paused the machine and this host only followed it: the awake
 * stretch ended at the last instant the meter saw the machine awake, not at this event. */
export const WorkspaceNappedEvent = z.object({ type: z.literal("workspace.napped"), workspaceId: z.string(), found: z.boolean().optional() });
export const WorkspaceWokenEvent = z.object({
  type: z.literal("workspace.woken"),
  workspaceId: z.string(),
  machineId: z.string(),
  /** True when the paused machine had vanished and a fresh golden fork replaced it. */
  resurrected: z.boolean(),
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
/** A person picked the workspace's hue or its glyph: the record alone changed, and both facts travel whole so a
 * client never has to merge one key into what it holds. null on either is none picked. */
export const WorkspaceLookEvent = z.object({
  type: z.literal("workspace.look"),
  workspaceId: z.string(),
  tint: WorkspaceTint.nullable(),
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
  /** The awake time so far billed stretch by stretch at the rate that held over each, so a size change or a wake at
   * another size never re-prices what came before it. */
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
/** Who held the port when it closed, from the watcher's last row for it; at is the daemon's clock. */
const portCloseDetail = {
  pid: z.number().optional(),
  process: z.string().optional(),
  /** The holder's argv joined by spaces, from /proc/<pid>/cmdline; the daemon reads at most 512 bytes of it and a cut argv ends with an ellipsis. */
  command: z.string().optional(),
  /** Whether the holder's pid was gone when the close was seen; absent without a pid. */
  exited: z.boolean().optional(),
  at: z.string().optional(),
};
export const PortCloseEvent = z.object({ type: z.literal("port.close"), workspaceId: z.string(), port: z.number(), ...portCloseDetail });
export const InboxFileEvent = z.object({
  type: z.literal("inbox.file"),
  workspaceId: z.string(),
  path: z.string(),
  bytes: z.number(),
});

// --- project bundle: a folder on this computer landed on a workspace -----------

/** How the collector's credential pass decided a file is secret-shaped: by name, by owner-only mode, by the key
 * names in it, by a PEM header, by a URL with a password in it, by a gitleaks hit, by the catalog, by secret-shaped
 * exports, or by git history. */
export const CredentialSignal = z.enum(["name", "mode", "keys", "pem", "url", "gitleaks", "catalog", "exports", "history"]);
export type CredentialSignal = z.infer<typeof CredentialSignal>;
/** How a repository config lands when its rewrite is accepted: `urls` as they then read, their userinfo removed,
 * and `drop` the config keys (http.extraheader carrying an Authorization header) whose lines are left out. */
export const ProjectRewrite = z.object({ urls: z.array(z.string()), drop: z.array(z.string()) });
export type ProjectRewrite = z.infer<typeof ProjectRewrite>;
/** A secret-shaped file in the folder, by path relative to it; it travels only when the import names it in carry,
 * or in rewrite when `rewrite` is offered: then it lands rewritten as described, and the machine's own login (gh's)
 * is the credential there. Offered only when the rewrite removes every secret shape the file has. */
export const ProjectSecret = z.object({ path: z.string(), bytes: z.number(), signals: z.array(CredentialSignal), rewrite: ProjectRewrite.optional() });
export type ProjectSecret = z.infer<typeof ProjectSecret>;
/** How an agent's state for the folder travels by file: `moves` when the files carry every key and the resolver
 * re-keys them to the new path so the agent resumes there, `transcript-only` when the rows in a shared store that
 * hold or find the sessions stay behind and only the files travel, if there are any. */
export const ProjectCarry = z.enum(["moves", "transcript-only"]);
export type ProjectCarry = z.infer<typeof ProjectCarry>;
/** One agent whose home on this computer holds sessions for the folder, by catalog id: the count, the bytes of the
 * state files that would travel and the carry answer. An agent whose store could not be read keeps its row with
 * `error` saying why and zero sessions; it never travels. */
export const ProjectAgent = z.object({ agent: z.string(), name: z.string(), sessions: z.number(), bytes: z.number(), carry: ProjectCarry, error: z.string().optional() });
export type ProjectAgent = z.infer<typeof ProjectAgent>;
/** What a project import would carry, for the person to read before anything is packed: the files and their bytes,
 * the secret-shaped ones, the caches left behind (relative paths), the paths named but not carried, with why, and the
 * agents with sessions for the folder. */
export const ProjectPlan = z.object({
  /** The folder on this computer, absolute. */
  source: z.string(),
  /** Whether the folder has a .git; the repository travels whole when it does. */
  repo: z.boolean(),
  /** Regular files that would travel, the secret-shaped ones counted. */
  files: z.number(),
  bytes: z.number(),
  secrets: z.array(ProjectSecret),
  excluded: z.array(z.string()),
  skipped: z.array(z.object({ path: z.string(), note: z.string() })),
  agents: z.array(ProjectAgent),
});
export type ProjectPlan = z.infer<typeof ProjectPlan>;
/** The steps of one import in order; `failed` ends one that threw. */
export const ProjectImportStage = z.enum(["planned", "consented", "packing", "uploading", "landing", "done", "failed"]);
export type ProjectImportStage = z.infer<typeof ProjectImportStage>;
/** Progress of one import: one plain sentence per stage, the time since it began, and on uploading the bytes sent so
 * far of the archive's total. */
export const ProjectImportEvent = z.object({
  type: z.literal("project.import"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectImportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectImportEvent = z.infer<typeof ProjectImportEvent>;
/** What became of one agent the import named: `moved` when the agent is on the machine and its module re-keyed every
 * file to dest, or merged its rows into its store there; `transcript-only` when it is on the machine but only its
 * files landed and the rows in its shared store that list them are still to come; `carried` when it is not there so
 * the files landed as they were, `nothing` when no file of its travelled, `failed` when the move raised and nothing of
 * that agent landed, or the merge on the machine failed after its files did; files and bytes are what landed. */
export const ProjectAgentOutcome = z.enum(["moved", "transcript-only", "carried", "nothing", "failed"]);
export type ProjectAgentOutcome = z.infer<typeof ProjectAgentOutcome>;
/** `sessions` is how many the files hold when the trip counted them; `skipped` is how many sessions the agent's own
 * index named whose transcript was not under its home (Codex keeps archived ones elsewhere), so their rows moved
 * and nothing else did. `rows` is what the merge on the machine inserted or updated in the agent's store, once it
 * ran; `note` says why the rows still wait when they could not be merged yet (the agent has not made its store
 * there), or what the merge kept as the machine had it rather than as carried. */
export const ProjectAgentResult = z.object({
  agent: z.string(),
  files: z.number(),
  bytes: z.number(),
  outcome: ProjectAgentOutcome,
  sessions: z.number().optional(),
  skipped: z.number().optional(),
  error: z.string().optional(),
  rows: z.number().optional(),
  note: z.string().optional(),
});
export type ProjectAgentResult = z.infer<typeof ProjectAgentResult>;
/** What landed: the path on the machine, the files and bytes extracted there, the upload parts, the secret-shaped
 * paths that were cut because the import did not name them, the ones that landed rewritten as the plan offered, and
 * each named agent's outcome. */
export const ProjectImportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), parts: z.number(), cut: z.array(z.string()), rewritten: z.array(z.string()), agents: z.array(ProjectAgentResult) });
export type ProjectImportResult = z.infer<typeof ProjectImportResult>;
/** The steps of one export in order; `failed` ends one that threw. */
export const ProjectExportStage = z.enum(["packing", "downloading", "landing", "done", "failed"]);
export type ProjectExportStage = z.infer<typeof ProjectExportStage>;
/** Progress of one export, the bundle's trip home: one plain sentence per stage, the time since it began, and on
 * downloading the bytes received so far of the archive's total. `source` is the folder on the machine, `dest` where
 * it lands on this computer. */
export const ProjectExportEvent = z.object({
  type: z.literal("project.export"),
  workspaceId: z.string(),
  source: z.string(),
  dest: z.string(),
  stage: ProjectExportStage,
  message: z.string(),
  elapsedMs: z.number(),
  bytes: z.number().optional(),
  total: z.number().optional(),
});
export type ProjectExportEvent = z.infer<typeof ProjectExportEvent>;
/** What came home: the folder on this computer, the files and bytes landed there, the cache roots left behind on
 * the machine (relative paths), and each agent whose state for the folder was found on the machine with what became
 * of it here: `moved` when its module keyed every file to dest, `transcript-only` when the files landed but the rows
 * in its shared store here do not list them yet, `nothing` when it had no file to bring, `failed` with the reason. */
export const ProjectExportResult = z.object({ dest: z.string(), files: z.number(), bytes: z.number(), excluded: z.array(z.string()), agents: z.array(ProjectAgentResult) });
export type ProjectExportResult = z.infer<typeof ProjectExportResult>;

// --- this computer's own folders, as a browser tab browses them ---------------

/** One folder on the computer running the host. `repo` is a folder git tracks, which a picker marks. */
export const HostFolder = z.object({ path: z.string(), repo: z.boolean() });
export type HostFolder = z.infer<typeof HostFolder>;
/** One level of this computer's disk: the folder listed, the roots every level is browsed from (the home folder and
 * each imported project's own folder), the folders directly inside it, and how many were left out for being hidden.
 * No web picker can hand a page a path, so this is what a browser tab has instead of the desktop shell's dialog. */
export const HostFolderListing = z.object({
  dir: z.string(),
  roots: z.array(z.string()),
  folders: z.array(HostFolder),
  /** Folders whose name starts with a dot, counted rather than listed unless the ask said to list them. */
  hidden: z.number().int(),
});
export type HostFolderListing = z.infer<typeof HostFolderListing>;

// --- the person's own terminal config, as the terminal pane applies it --------

export const TerminalScheme = z.enum(["light", "dark"]);
export type TerminalScheme = z.infer<typeof TerminalScheme>;
const channel = z.number().int().min(0).max(255);
export const TerminalRgb = z.object({ r: channel, g: channel, b: channel });
export type TerminalRgb = z.infer<typeof TerminalRgb>;
/** Ghostty's cursor-style words, which libghostty takes as its default cursor style. */
export const TerminalCursorStyle = z.enum(["block", "bar", "underline", "block_hollow"]);
export type TerminalCursorStyle = z.infer<typeof TerminalCursorStyle>;
/** The keys of a Ghostty config the terminal pane honours, read off this computer with Ghostty's own lookup order
 * and its theme resolved for one scheme. Only what the files set is here: an absent key leaves the pane's default.
 * `files` is every config and theme file read, in load order; empty when the person has no Ghostty config. Every
 * key but `backgroundBlur` is applied; that one is served for the record, since the blur is the desktop window's
 * own material and a browser tab has none. */
export const TerminalConfig = z.object({
  files: z.array(z.string()),
  /** The primary face first, then the fallbacks the file names after it. */
  fontFamily: z.array(z.string()),
  fontSize: z.number().positive().optional(),
  /** The theme the file names for the scheme asked for, as it names it. */
  theme: z.string().optional(),
  background: TerminalRgb.optional(),
  foreground: TerminalRgb.optional(),
  /** Palette entries 0 to 15; null where the files set none. */
  palette: z.array(TerminalRgb.nullable()).length(16),
  selectionBackground: TerminalRgb.optional(),
  cursorColor: TerminalRgb.optional(),
  cursorStyle: TerminalCursorStyle.optional(),
  cursorStyleBlink: z.boolean().optional(),
  windowPaddingX: z.object({ left: z.number().min(0), right: z.number().min(0) }).optional(),
  windowPaddingY: z.object({ top: z.number().min(0), bottom: z.number().min(0) }).optional(),
  /** 1 is opaque; under 1 the pane paints its background over whatever sits behind it. */
  backgroundOpacity: z.number().min(0).max(1).optional(),
  /** Ghostty's blur intensity; 0 is none, true in the file is 20. Read and served, not applied by the pane. */
  backgroundBlur: z.number().int().min(0).optional(),
});
export type TerminalConfig = z.infer<typeof TerminalConfig>;

// --- preferences (the person's view of the app, kept on the host so every client agrees) ---

/** Which side of the stylesheet the page draws: the computer's own, or one side pinned. */
export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

/** Which body the sidebar draws: every workspace and its threads, or Spaces, one workspace at a time. */
export const SidebarMode = z.enum(["list", "spaces"]);
export type SidebarMode = z.infer<typeof SidebarMode>;

/** Where the terminal pane's text size comes from before a zoom moves it: the app's own size, or the size the person's Ghostty file names. */
export const TerminalSizeSource = z.enum(["app", "file"]);
export type TerminalSizeSource = z.infer<typeof TerminalSizeSource>;

/** One record on the host's state; the desktop app and a browser tab on the same host read and write this one. sidebarWidth
 * absent is the sidebar's own default; terminalZoom is the pixels a workspace's panes add to the base size, by workspace id. */
export const Preferences = z.object({
  theme: ThemePreference,
  sidebarMode: SidebarMode,
  sidebarWidth: z.number().int().positive().optional(),
  terminalSize: TerminalSizeSource,
  terminalZoom: z.record(z.string(), z.number().int()),
  /** The access mode the composer last picked in a workspace, by workspace id, in the harness's own slug. It is on
   * this record rather than in one browser's storage because the host reads it too: a thread opened with no access
   * named runs at the person's last pick for that workspace, whichever client or CLI opened it. Keyed by workspace
   * alone, as the composer's other picks are, so it is read through listedPick: a workspace's threads may run on
   * either harness and their mode lists are disjoint, and a pick the harness in front of us does not take drops to
   * that harness's own default rather than refusing the send. */
  access: z.record(z.string(), z.string()),
  /** Whether the surfaces still being worked on are offered at all. The host stamps it from its own environment at
   * every read, so no client sets it and nothing a state file holds can turn it on. */
  labs: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

/** The one road that turns labs on: this variable in the host's environment, read once when the runtime starts. */
export const LABS_ENV = "WSP_LABS";
export const labsFromEnv = (env: Record<string, string | undefined>): boolean => env[LABS_ENV] === "1";

/** What preferences.set takes: any of the record's fields but labs, which is the host's to say; a null sidebarWidth
 * clears it back to the default, and terminalZoom and access name only the workspaces they move, a null entry
 * dropping that workspace's zoom or pick. */
export const PreferencesPatch = Preferences.omit({ labs: true }).partial().extend({
  sidebarWidth: z.number().int().positive().nullable().optional(),
  terminalZoom: z.record(z.string(), z.number().int().nullable()).optional(),
  access: z.record(z.string(), z.string().nullable()).optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", sidebarMode: "list", terminalSize: "app", terminalZoom: {}, access: {}, labs: false };

/** The record as stored, over the defaults; a record that does not parse (an older or a hand-edited state file) reads as the defaults. */
export function preferencesFrom(stored: unknown): Preferences {
  const parsed = Preferences.partial().safeParse(stored ?? {});
  return parsed.success ? applyPreferencesPatch(DEFAULT_PREFERENCES, parsed.data) : DEFAULT_PREFERENCES;
}

/** The record with the patch's fields over it. The one merge rule, read by the host that keeps the record and the client
 * that paints ahead of the host's answer, so both land on the same record. */
export function applyPreferencesPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const sidebarWidth = patch.sidebarWidth === undefined ? current.sidebarWidth : patch.sidebarWidth;
  const terminalZoom = { ...current.terminalZoom };
  for (const [workspaceId, zoom] of Object.entries(patch.terminalZoom ?? {})) {
    if (zoom === null) delete terminalZoom[workspaceId];
    else terminalZoom[workspaceId] = zoom;
  }
  const access = { ...current.access };
  for (const [workspaceId, mode] of Object.entries(patch.access ?? {})) {
    if (mode === null) delete access[workspaceId];
    else access[workspaceId] = mode;
  }
  return {
    theme: patch.theme ?? current.theme,
    sidebarMode: patch.sidebarMode ?? current.sidebarMode,
    terminalSize: patch.terminalSize ?? current.terminalSize,
    terminalZoom,
    access,
    labs: current.labs,
    ...(sidebarWidth === null || sidebarWidth === undefined ? {} : { sidebarWidth }),
  };
}

/** The host's record changed, by any client; every socket gets the whole record. */
export const PreferencesChangedEvent = z.object({ type: z.literal("preferences.changed"), preferences: Preferences });
export type PreferencesChangedEvent = z.infer<typeof PreferencesChangedEvent>;

// --- desktop shell bridge (preload to page) -----------------------------------

/** One installed font file the desktop shell hands the page for its terminal, registered under the family the file names. */
export interface LocalFontFace {
  family: string;
  weight: 400 | 700;
  style: "normal" | "italic";
  data: ArrayBuffer;
}

/** What the host writes into the page's one inline script as window.__WSP__ before serving it. */
export interface BootPayload {
  wsPort: number;
  token: string;
  /** The family the person's terminal draws with, when the saved recipe ticks its row; the terminal pane defaults to it. */
  terminalFont?: string;
  /** The state file this host serves; the page keeps what it remembers (the workspace open last) under it. */
  statePath?: string;
}

/** One row of a context menu as the page hands it to the desktop shell, which builds the native menu from it. An item
 * that cannot run right now is shown dimmed with its refusal as the hover text; rows of different groups are parted by
 * a separator. shortcut is the label the page shows, accelerator the same chord in Electron's spelling. */
export interface ContextMenuItem {
  id: string;
  label: string;
  group: string;
  enabled: boolean;
  refusal?: string;
  shortcut?: string;
  accelerator?: string;
  destructive?: boolean;
}

/** The class the desktop preload puts on the html element when the window has no title bar of its own: the app's
 * header row is the window's frame, the traffic lights sit in it and the sidebar shows the window's frosted glass. */
export const DESKTOP_MAC_CLASS = "desktop-mac";

/** A key press the desktop shell took from its own menu and handed to the page, spelled the way a keyboard event
 * spells it, so the page's one keybinding table answers it. */
export interface ShellChord {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** What the desktop shell's preload puts on window.wsp; a browser tab has none of it. */
export interface DesktopBridge {
  /** The installed faces for a family and its Nerd Font variants, from this computer's font directories. */
  localFonts(family: string): Promise<LocalFontFace[]>;
  /** The system folder picker; the absolute path chosen, or nothing when it was dismissed. */
  pickFolder(): Promise<string | undefined>;
  /** The native context menu at the pointer, built from the items; resolves with the chosen item's id, or null when it was dismissed. */
  contextMenu(items: ContextMenuItem[]): Promise<string | null>;
  /** Photographs the page as it is now and keeps it under this workspace, replacing what that workspace held. Asked
   * for as the person leaves a workspace, while the page still shows it. */
  capturePreview(workspaceId: string): Promise<void>;
  /** The last photograph taken of this workspace, as a data url, or nothing when none was taken. */
  workspacePreview(workspaceId: string): Promise<string | undefined>;
  /** Whether a terminal holds focus, so the chords the shell's menu would zoom the window on stand aside for it. */
  setTerminalFocus(focused: boolean): void;
  /** A chord the shell stood aside from, for the page's keybindings to answer; returns the unsubscribe. */
  onShellChord(handler: (chord: ShellChord) => void): () => void;
  /** The theme the page draws, so the window's frame, glass and traffic-light bar follow it. */
  setTheme(theme: ThemePreference): void;
}

// --- golden image (manifest, interactive builder, build stages) ---------------

export const MachineKind = z.enum(["sandbox", "desktop"]);
export type MachineKind = z.infer<typeof MachineKind>;

/** What each login came to by the time the golden sealed: a sign-in on the machine, or a copy from this computer
 * checked there with the tool's status command. `copied` is a copy nothing checked: an update re-imported it, or the
 * tool has no status command or is not on the machine. */
export const LoginState = z.enum(["signed-in", "not-signed-in", "not-verified", "skipped", "copied"]);
export type LoginState = z.infer<typeof LoginState>;
export const GoldenLogin = z.object({ name: z.string(), state: LoginState });
export type GoldenLogin = z.infer<typeof GoldenLogin>;
/** A tool the builder's import did not put on the image: set aside at plan or install time, or failed to install,
 * with the reason it gave. Forks of the version are missing it. `id` is the recipe row's, the key the machine's own
 * record of what did not install is kept by. */
export const GoldenMissingTool = z.object({ id: z.string(), name: z.string(), outcome: z.enum(["skipped", "failed"]), note: z.string() });
export type GoldenMissingTool = z.infer<typeof GoldenMissingTool>;
/** A path the pack left off the image, by the recipe row it belongs to and why: a hook whose script is not a plain
 * file under home. Forks of the version run without it. */
export const GoldenLeftBehind = z.object({ id: z.string(), path: z.string(), note: z.string() });
export type GoldenLeftBehind = z.infer<typeof GoldenLeftBehind>;
/** One base tool's command with the version read on the builder after the base stage. */
export const GoldenBaseTool = z.object({ name: z.string(), version: z.string() });
export type GoldenBaseTool = z.infer<typeof GoldenBaseTool>;
/** A row an update took out of the recipe. An update never takes anything off the image: the bytes stay where the
 * version before it put them and the row is recorded here, so the lineage says what a fork still carries but the
 * recipe no longer asks for. A row ticked again later leaves this list at the version that re-installs it. */
export const GoldenRetired = z.object({ id: z.string(), name: z.string() });
export type GoldenRetired = z.infer<typeof GoldenRetired>;

/** One sealed image. `kind` is the machine kind the snapshot was taken from and
 * therefore restores as; entries sealed before kind was recorded were all
 * sandboxes, so readers treat a missing kind as sandbox. */
export const GoldenVersion = z.object({
  version: z.number(),
  snapshotId: z.string(),
  /** The durable template the seal, or wsp doctor after it, promoted the snapshot to; forks boot from it. Absent on
   * a backend without templates and on versions sealed before templates were recorded, whose forks boot from the
   * snapshot, which the provider may lose. */
  templateId: z.string().optional(),
  baseTemplate: z.string(),
  kind: MachineKind.optional(),
  setupSha: z.string(),
  createdAt: z.string(),
  smoke: z.object({ cmd: z.string(), exitCode: z.number() }),
  /** What the provider built the builder at; forks of this version inherit it unless told otherwise. */
  size: WorkspaceSize.optional(),
  /** The browser shim was on the machine when it was sealed, so its forks can be told BROWSER; versions sealed before it existed have no flag and get none. */
  browserShim: z.boolean().optional(),
  /** The sign-ins the builder was asked for and how each ended, so the app can say what a fork carries. */
  logins: z.array(GoldenLogin).optional(),
  /** Every tool the import skipped or failed to install, by name with the cause and reason, so a workspace can say why
   * one is missing; absent when every tool installed or the version was sealed before this was recorded. */
  missingTools: z.array(GoldenMissingTool).optional(),
  /** Commands the carried rc files call that the image does not have, each defined as a silent no-op in the file's
   * guard block so the shell comes up quiet; absent when every call has a command behind it. */
  silenced: z.array(z.string()).optional(),
  /** What the login shell printed to stderr when the builder started it interactively after the files landed, first
   * line and line count; absent when it started quiet or no shell row was ticked. */
  shellNoise: z.string().optional(),
  /** What the pack left off the image and why, by row and path; absent when everything ticked travelled or the version
   * was sealed before this was recorded. */
  leftBehind: z.array(GoldenLeftBehind).optional(),
  /** The snapshot the builder that sealed this version descends from: an update's head. Absent on a version built
   * from a fresh machine, and on versions sealed before this was recorded. */
  parentSnapshotId: z.string().optional(),
  /** Every base tool's command with the version read after the base stage on the builder this version descends from.
   * Absent on a version sealed before the base tools existed; its forks never ran them, so an update is refused. */
  base: z.array(GoldenBaseTool).optional(),
  /** Every row on this version's image that its recipe no longer asks for, carried from the version before it.
   * Absent when the recipe asks for everything the image carries. */
  retired: z.array(GoldenRetired).optional(),
});
export type GoldenVersion = z.infer<typeof GoldenVersion>;

export const GoldenManifest = z.object({ head: z.number(), versions: z.array(GoldenVersion) });
export type GoldenManifest = z.infer<typeof GoldenManifest>;

/** The sealed version a manifest's head names, or nothing: a manifest without one has no golden to serve or fork. */
export function goldenHead(manifest: GoldenManifest | undefined): GoldenVersion | undefined {
  return manifest?.versions.find(v => v.version === manifest.head);
}

/** What a fork of a version boots from and the lineage's word for it: the durable template once one is recorded,
 * the snapshot until then. The one rule for every road that creates from a version and every row that says whether
 * the version survives the provider losing its snapshot store; a durable version gets no word, since a word every
 * row wears says nothing. */
export function goldenImage(v: Pick<GoldenVersion, "snapshotId" | "templateId">): { spec: { template: string } | { fromSnapshot: string }; marks: readonly "volatile"[] } {
  return v.templateId !== undefined ? { spec: { template: v.templateId }, marks: [] } : { spec: { fromSnapshot: v.snapshotId }, marks: ["volatile"] };
}

/** What happens to a login: copied from this computer, signed in on the machine after the build, set there as an
 * API key the tool reads, or left out. One list, read by the collector's rows, by a recipe's rows and by the words
 * `wsp recipe --signin` takes. */
export const LOGIN_CHOICES = ["copy", "machine", "key", "skip"] as const;
export const LoginChoice = z.enum(LOGIN_CHOICES);
export type LoginChoice = z.infer<typeof LoginChoice>;

/** What the first install of a release recorded: the tag it fetched and the asset's sha256. The one shape for the
 * recipe row that carries it, the collector's row, the catalog road that checks it and the tick the seal writes. */
export const ToolPin = z.object({ tag: z.string().min(1), sha256: z.string().min(1) });
export type ToolPin = z.infer<typeof ToolPin>;

/** What a golden is built from, as its builder records it: every ticked row
 * with its login answer, tool pin and install road, and every planned path
 * with a digest of the bytes that travel. Two recipes with equal digests build
 * the same golden; the hash a builder carries is this object's, so a later run
 * can say what changed instead of only that something did. */
export const RecipeDigest = z.object({
  ticks: z.array(
    z.object({
      id: z.string(),
      choice: LoginChoice.optional(),
      /** The version the row installs: the laptop's, or the one its road reads for it (a tap formula's release tag). */
      version: z.string().optional(),
      /** A tools row's install road by name, and the sha256 of the lines that road runs before any recorded pin: a
       * road that installs differently under the same id is a changed row. */
      road: z.string().optional(),
      installer: z.string().optional(),
      /** The release a tools row is fixed to while its recorded pin stands. The build that records a pin stamps it
       * here, so the recipe carrying the same pin reads as no change; it never enters the hash. */
      pin: ToolPin.optional(),
    }),
  ),
  /** The computer's login shell by name, when a shell row is ticked: it decides which shell the machine logs into. */
  login: z.string().optional(),
  /** A volatile entry (its tool rewrites it, or it is a Keychain value the machine gets rendered) is recorded but never hashed. */
  files: z.array(z.object({ id: z.string(), path: z.string(), dest: z.string(), digest: z.string(), volatile: z.boolean().optional() })),
});
export type RecipeDigest = z.infer<typeof RecipeDigest>;

/** Where a recipe row's tick comes from: the project the recipe was written for names it in its own manifests (with
 * the line saying which file said so), the entry is on this computer (what was found: its config paths and whether
 * its command is on PATH), the agents' session histories on this computer used it (in how many sessions, how many
 * calls), or nothing local says anything and the catalog's own evidence decides. */
export const RecipeSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), why: z.string().min(1) }),
  z.object({ kind: z.literal("installed"), paths: z.array(z.string()), bin: z.boolean() }),
  z.object({ kind: z.literal("used"), sessions: z.number().int().nonnegative(), calls: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("popular"), sessions: z.number().int().nonnegative(), images: z.number().int().nonnegative() }),
]);
export type RecipeSource = z.infer<typeof RecipeSource>;

/** One catalog entry in a recipe: ticked or not, why, its size on the machine when the catalog measured one, and
 * the sign-in answer the person or the agent that wrote the recipe gave; absent, the wizard's default stands. A tools
 * row this computer has that the catalog does not carry (a formula, a manager's global) is a row too, under the
 * collector's own id (`tools/<manager>/<package>`), so the file and the screens tick it like any other. */
export const RecipeRow = z.object({
  /** The catalog id, or the collector's row id for a tools row outside the catalog. */
  id: z.string().min(1),
  kind: z.enum(["agent", "tool"]),
  on: z.boolean(),
  source: RecipeSource,
  size: z.number().int().nonnegative().optional(),
  signIn: LoginChoice.optional(),
  /** Only on a tool installed from a release: what its first install fetched and hashed, written by the build that
   * recorded it. The next build installs that tag and fails the row when the download's sum is not this one. */
  pin: ToolPin.optional(),
});
export type RecipeRow = z.infer<typeof RecipeRow>;

/** What one agent's session history on this computer gave: read with these counts, empty, there but unreadable, or
 * no reader for its format yet. Names and counts only; nothing a session held travels. */
export const RecipeHistory = z.object({
  agent: z.string().min(1),
  state: z.enum(["read", "empty", "unreadable", "no-reader"]),
  sessions: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
});
export type RecipeHistory = z.infer<typeof RecipeHistory>;

/** Which rule decided every tick in a recipe: what the person's agents used on this computer, what is installed on
 * it, or the catalog's own default. `wsp recipe --tick` names one; a recipe written without one (the wizard's
 * screens) carries none and its rows say for themselves where each tick came from. */
export const RecipeTick = z.enum(["used", "installed", "default"]);
export type RecipeTick = z.infer<typeof RecipeTick>;
/** The words `--tick` takes, in the order the help lists them. */
export const RECIPE_TICKS: readonly RecipeTick[] = RecipeTick.options;

/** A tool the recipe carries that the catalog does not, because an agent added it for the person's own projects:
 * the lines that install it, run as given on the builder after every catalog road, and one command that exits 0
 * once it is there. Nothing here is ever offered a sign-in: the install is the whole row. */
export const RecipeCustomRow = z.object({
  kind: z.literal("custom"),
  id: z.string().min(1),
  name: z.string().min(1),
  install: z.array(z.string().min(1)).min(1),
  check: z.string().min(1),
  /** The package manager the lines call, when the row came off a scan of one: the build brings that manager onto
   * the machine before the row runs. A row nobody named a manager for runs on what the base and the ticks left. */
  manager: z.string().min(1).optional(),
  /** Bytes on the machine, when whoever added the row measured one. */
  size: z.number().int().nonnegative().optional(),
  why: z.string().min(1),
});
export type RecipeCustomRow = z.infer<typeof RecipeCustomRow>;

/** The small recipe: catalog ids with a tick each and the source of that tick, written by wsp recipe from this
 * computer (or by hand, or by a local agent), read by wsp init --recipe, the app's pick screen and the import
 * of a project. Among them this computer's own tools rows the catalog does not carry, under the collector's ids, and
 * beside them the rows an agent added for tools the catalog has none for. Names, ticks and install lines only: never
 * a path's content, never a key. */
export const Recipe = z.object({
  version: z.literal(1),
  /** When it was written, ISO 8601. */
  at: z.string().min(1),
  /** The rule that decided the ticks, when one was named; a later --set keeps it, so the table reads the same. */
  tick: RecipeTick.optional(),
  histories: z.array(RecipeHistory),
  rows: z.array(RecipeRow),
  /** Rows outside the catalog, added on purpose; a recipe written before they existed carries none. */
  custom: z.array(RecipeCustomRow).optional(),
});
export type Recipe = z.infer<typeof Recipe>;

/** The custom rows a recipe carries: the one reading of a recipe that has none. */
export function customRows(recipe: Pick<Recipe, "custom">): readonly RecipeCustomRow[] {
  return recipe.custom ?? [];
}

/** What a row added without a check of its own is checked with: its command on PATH. */
export function commandCheck(bin: string): string {
  return `command -v ${shellQuote(bin)}`;
}

/** The why on a row an agent added without saying more. */
export const ADDED_BY_AGENT = "added by the agent";

/** The live machine a person sets up before sealing it as a golden. It is not
 * a workspace and never appears in the rail; `screen` is present when the
 * machine streams a display (desktop kind). */
export const GoldenBuilderView = z.object({
  id: z.string(),
  name: z.string(),
  kind: MachineKind,
  createdAt: z.string(),
  /** What the provider built, so a builder left running can be priced. */
  size: z.object({ cpu: z.number(), memMb: z.number() }),
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** True while the machine has never been paused, resumed or restored, so it can still be sealed. */
  firstLife: z.boolean().optional(),
  /** The recipe this builder carries; a prepare with the same hash attaches to it instead of booting. */
  recipeHash: z.string().optional(),
  /** The parts behind recipeHash; absent on a builder recorded without them. */
  recipe: RecipeDigest.optional(),
  /** The owner label on the machine when it names another state file; absent when it is this one's or the provider reports none. */
  foreignOwner: z.string().optional(),
  /** The other live wsp process using this builder, when there is one; such a builder is listed and left alone. */
  heldBy: z.object({ host: z.string(), pid: z.number(), heartbeat: z.string() }).optional(),
  /** True while its stages still run in the process that holds it; left this way by a dead process, it can never seal. */
  building: z.boolean().optional(),
  /** Set once the builder was saved as this golden version and kept running for a short window, so one more
   * change re-snapshots it instead of forking; the sweep stops it when the window ends. */
  sealed: z.object({ at: z.string(), version: z.number() }).optional(),
});
export type GoldenBuilderView = z.infer<typeof GoldenBuilderView>;

export const GoldenStage = z.enum([
  "creating",
  "deploying-daemon",
  "applying-setup",
  "uploading-files",
  "installing-harness",
  "installing-tools",
  "installing-mcp",
  "ready",
  "snapshotting",
  "promoting",
  "smoke-forking",
  "sealed",
  "failed",
]);
export type GoldenStage = z.infer<typeof GoldenStage>;

/** The install step a frame belongs to, within its stage: what the step is called and the one line a person reads
 * for what it runs. A reader's clock for the step starts at the first frame naming it and stops at the first without. */
export const GoldenStep = z.object({ label: z.string(), command: z.string() });
export type GoldenStep = z.infer<typeof GoldenStep>;

/** Progress of a golden prepare or seal, keyed by golden name; `detail` is
 * free text for a progress line (the failure message on `failed`). */
export const GoldenStageEvent = z.object({
  type: z.literal("golden.stage"),
  name: z.string(),
  stage: GoldenStage,
  detail: z.string().optional(),
  step: GoldenStep.optional(),
});
export type GoldenStageEvent = z.infer<typeof GoldenStageEvent>;
/** The detail a golden.stage frame carries for a step the builder already holds; a reader closes the step at once and charges it no time. */
export const ALREADY_APPLIED = "already applied";
/** Recipe rows under the agents rung that are MCP servers, not agents: `agents/mcp/<agent>/<name>`. The collector writes them, the engine's import reads them. */
export const MCP_ID_PREFIX = "agents/mcp/";
/** Where a manager's rows sit under the tools rung: what every id of its packages starts with. It lives here, not
 * beside the engine's other row prefixes, because the collector writes these ids and cannot import the engine. */
export const toolRowPrefix = (manager: string): string => `tools/${manager}/`;
/** The id of a tools row a manager lists, the one spelling of it: what the collector writes for one, and what a scan
 * row of the same manager and package stands for. */
export const toolRowId = (manager: string, pkg: string): string => `${toolRowPrefix(manager)}${pkg}`;
/** Recipe rows under the tools rung that name a Homebrew formula. */
export const BREW_ID_PREFIX = toolRowPrefix("brew");
/** The package a tools row names: what follows its manager in the id (a tap formula keeps its slashes). Beside the
 * prefix above for the same reason: the collector writes these ids and cannot import the engine. */
export const packageOf = (e: { id: string }): string => e.id.split("/").slice(2).join("/");

/** Where the event sits in its runtime's stream: one counter per runtime process, monotonic from 1, so a client that
 * lost its socket can ask events.subscribe for everything after the last one it saw. Absent on events from an older
 * runtime and on sessions.history replies, which a client reads whole. */
const sequenced = { seq: z.number().int().positive().optional() };

/** The host opened or closed a forward; the runtime relays these to the app's socket and emits none itself. */
export const ForwardOpenEvent = z.object({ type: z.literal("forward.open"), forward: PortForward });
export const ForwardCloseEvent = z.object({ type: z.literal("forward.close"), workspaceId: z.string(), port: RelayPort });
export type ForwardEvent = z.infer<typeof ForwardOpenEvent> | z.infer<typeof ForwardCloseEvent>;

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatingEvent.extend(sequenced),
  WorkspaceCreatedEvent.extend(sequenced),
  WorkspaceNappedEvent.extend(sequenced),
  WorkspaceWokenEvent.extend(sequenced),
  WorkspaceUpgradedEvent.extend(sequenced),
  WorkspaceRenamedEvent.extend(sequenced),
  WorkspaceLookEvent.extend(sequenced),
  WorkspaceDeletedEvent.extend(sequenced),
  WorkspaceGoneEvent.extend(sequenced),
  WorkspaceStatusEvent.extend(sequenced),
  WorkspaceCostEvent.extend(sequenced),
  SessionStartEvent.extend(sequenced),
  SessionDeltaEvent.extend(sequenced),
  SessionDoneEvent.extend(sequenced),
  SessionEndEvent.extend(sequenced),
  SessionSteerEvent.extend(sequenced),
  SessionNotifyEvent.extend(sequenced),
  SessionPermissionEvent.extend(sequenced),
  SessionPermissionClosedEvent.extend(sequenced),
  SessionQueuedEvent.extend(sequenced),
  PortOpenEvent.extend(sequenced),
  PortCloseEvent.extend(sequenced),
  InboxFileEvent.extend(sequenced),
  GoldenStageEvent.extend(sequenced),
  ForwardOpenEvent.extend(sequenced),
  ForwardCloseEvent.extend(sequenced),
  ProjectImportEvent.extend(sequenced),
  ProjectExportEvent.extend(sequenced),
  PreferencesChangedEvent.extend(sequenced),
]);
export type EventUnion = z.infer<typeof EventUnion>;

/** What events.subscribe answers before it pushes anything. seq is the newest sequence the runtime has issued (0
 * before its first event): the cursor a client that has seen no event yet resubscribes from. stream names the
 * runtime process that issued it; sequences from two streams never compare, so a client that stored one and sees
 * another treats the reply as a gap whatever else it says. gap: the `after` sent is not a cursor into this stream
 * (the runtime no longer retains it, or it came with another stream id), nothing was replayed, and a client that
 * folds events must refetch sessions.history. */
export const EventsSubscribeReply = z.object({
  seq: z.number().int().nonnegative(),
  stream: z.string().optional(),
  gap: z.literal(true).optional(),
});
export type EventsSubscribeReply = z.infer<typeof EventsSubscribeReply>;

// --- daemon wire protocol (ws://0.0.0.0:7070, auth frame first, 4401 on anything else) ---

/** Client-side health of a daemon link. reauth-needed: the daemon refused the token, and a browser link asks the
 * host for its current one before redialling; the host's own link stops there. dead is terminal. */
export const DaemonLinkStatus = z.enum(["connecting", "live", "reauth-needed", "dead"]);
export type DaemonLinkStatus = z.infer<typeof DaemonLinkStatus>;

const reqId = z.union([z.string(), z.number()]);

/** The first frame on every daemon socket, the URL carries no token: answered {id, ok} then daemon.hello, or
 * the socket closes 4401 with one sentence of reason. Anything else first, or nothing, closes the same way.
 * A peer that sends more than a few KiB before this frame passes is closed 4401 too, so a client sends nothing
 * more until it is answered. port scopes the socket to one guest port: only tunnel ops on that port and ping are
 * answered, everything else is refused with code forbidden. */
export const DaemonAuthRequest = z.object({
  id: reqId,
  op: z.literal("auth"),
  token: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
});
export type DaemonAuthRequest = z.infer<typeof DaemonAuthRequest>;

// Replies carry no op, so each files/diff op has its own reply schema here
// instead of a discriminated union; DaemonOkResponse stays the loose envelope.

export const FsEntryType = z.enum(["file", "dir", "symlink"]);
export type FsEntryType = z.infer<typeof FsEntryType>;
/** name is the entry's own name in the listed directory; size is 0 for
 * anything but a file; mtime is epoch milliseconds. */
export const FsEntry = z.object({ name: z.string(), type: FsEntryType, size: z.number(), mtime: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;
/** total counts the directory's entries after filtering; truncated means
 * entries holds only the first cap of them. */
export const FsListReply = z.object({ entries: z.array(FsEntry), truncated: z.boolean(), total: z.number() });
export type FsListReply = z.infer<typeof FsListReply>;

export const FsReadEncoding = z.enum(["utf8", "base64"]);
export type FsReadEncoding = z.infer<typeof FsReadEncoding>;
/** size is the whole file's byte length; content holds at most the first 2 MiB. */
export const FsReadReply = z.object({ content: z.string(), size: z.number(), truncated: z.boolean() });
export type FsReadReply = z.infer<typeof FsReadReply>;

/** Porcelain v2 branch header: head is "(detached)" off a branch, oid
 * "(initial)" before the first commit; ahead/behind are 0 without an upstream. */
export const GitBranch = z.object({
  oid: z.string(),
  head: z.string(),
  upstream: z.string().optional(),
  ahead: z.number(),
  behind: z.number(),
});
export type GitBranch = z.infer<typeof GitBranch>;
/** xy is the two-letter porcelain code ("??" untracked, "!!" ignored, "." for
 * an unchanged side); origPath is set for renames and copies. */
export const GitStatusEntry = z.object({ xy: z.string(), path: z.string(), origPath: z.string().optional() });
export type GitStatusEntry = z.infer<typeof GitStatusEntry>;
/** root is the working tree's top-level directory, absolute on the guest. */
export const GitStatusReply = z.object({ branch: GitBranch, entries: z.array(GitStatusEntry), root: z.string() });
export type GitStatusReply = z.infer<typeof GitStatusReply>;

/** branch: working tree against the merge-base with the default branch;
 * unstaged: working tree against the index; staged: index against HEAD. */
export const GitDiffScope = z.enum(["branch", "unstaged", "staged"]);
export type GitDiffScope = z.infer<typeof GitDiffScope>;
export const GitDiffFile = z.object({ path: z.string(), patch: z.string() });
export type GitDiffFile = z.infer<typeof GitDiffFile>;
/** base is the ref the branch scope diffed against (null for other scopes);
 * truncated means the 2 MiB patch budget cut files or a patch short. */
export const GitDiffReply = z.object({ base: z.string().nullable(), files: z.array(GitDiffFile), truncated: z.boolean() });
export type GitDiffReply = z.infer<typeof GitDiffReply>;

/** One live or exited pty the daemon still holds; exited ones stay until pty.kill. */
export const PtyListEntry = z.object({ id: z.string(), pid: z.number(), cols: z.number(), rows: z.number(), exited: z.boolean() });
export type PtyListEntry = z.infer<typeof PtyListEntry>;
export const PtyListReply = z.object({ ptys: z.array(PtyListEntry) });
export type PtyListReply = z.infer<typeof PtyListReply>;

export const ProcSignal = z.enum(["TERM", "KILL"]);
export type ProcSignal = z.infer<typeof ProcSignal>;

/** One process as /proc/[pid] shows it. cpu is its busy share of one core
 * over the interval (a threaded process can pass 100); rss in bytes;
 * startedAt epoch milliseconds; cmdline the first 200 bytes with the NULs as
 * spaces, empty for a kernel thread; pty names the daemon pty whose shell
 * this is. The environment never travels: it holds tokens. */
export const ProcEntry = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  state: z.string(),
  comm: z.string(),
  cmdline: z.string(),
  cpu: z.number(),
  rss: z.number(),
  startedAt: z.number(),
  pty: z.string().optional(),
});
export type ProcEntry = z.infer<typeof ProcEntry>;

/** cwd is null when unreadable; ports are the TCP ports this pid listens on;
 * children are the pids whose parent it is, as of the last snapshot. */
export const ProcInspectReply = z.object({
  pid: z.number().int(),
  cwd: z.string().nullable(),
  ports: z.array(z.number().int()),
  threads: z.number().int(),
  children: z.array(z.number().int()),
});
export type ProcInspectReply = z.infer<typeof ProcInspectReply>;

export const DaemonRequest = z.discriminatedUnion("op", [
  z.object({
    id: reqId,
    op: z.literal("pty.create"),
    cols: z.number().optional(),
    rows: z.number().optional(),
    shell: z.string().optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({ id: reqId, op: z.literal("pty.attach"), ptyId: z.string() }),
  z.object({ id: reqId, op: z.literal("pty.write"), ptyId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("pty.resize"), ptyId: z.string(), cols: z.number(), rows: z.number() }),
  z.object({ id: reqId, op: z.literal("pty.kill"), ptyId: z.string() }),
  z.object({ id: reqId, op: z.literal("pty.list") }),
  z.object({ id: reqId, op: z.literal("ports.watch") }),
  z.object({ id: reqId, op: z.literal("manifest.get") }),
  z.object({
    id: reqId,
    op: z.literal("manifest.record"),
    cmd: z.string(),
    cwd: z.string(),
    port: z.number().optional(),
  }),
  z.object({ id: reqId, op: z.literal("manifest.restartScript") }),
  z.object({ id: reqId, op: z.literal("inbox.watch") }),
  z.object({ id: reqId, op: z.literal("inbox.rescan") }),
  /** Streams sys.sample events to this socket every two seconds until it
   * closes. One sampler serves every subscriber and stops with the last one;
   * the first sample lands one interval after the reply, since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("sys.watch") }),
  /** Streams proc.snapshot events to this socket every two seconds until
   * proc.unwatch or the socket closes. The daemon reads /proc only while some
   * socket watches; the first snapshot lands one interval after the reply,
   * since cpu is a delta. */
  z.object({ id: reqId, op: z.literal("proc.watch") }),
  z.object({ id: reqId, op: z.literal("proc.unwatch") }),
  /** One process in depth, replied as a ProcInspectReply; this is the only op
   * that scans /proc/net, and only for that pid's sockets. */
  z.object({ id: reqId, op: z.literal("proc.inspect"), pid: z.number().int().positive() }),
  /** Sends the signal. pid 1, the daemon and the daemon's parent are refused
   * with code forbidden; a pid that is gone answers not-found. */
  z.object({ id: reqId, op: z.literal("proc.kill"), pid: z.number().int().positive(), signal: ProcSignal }),
  z.object({ id: reqId, op: z.literal("ping") }),
  /** Lists one directory's direct children, each request under its own entry
   * cap. Paths are relative to the daemon's home root (HOME unless started
   * with --root) or absolute inside it or an imported project folder named in
   * DAEMON_ROOTS_PATH; anything resolving outside every root, through .. or a
   * symlink, is refused with code outside-root. gitignore hides .git and the
   * entries git would ignore. */
  z.object({
    id: reqId,
    op: z.literal("fs.list"),
    path: z.string(),
    gitignore: z.boolean().optional(),
  }),
  z.object({ id: reqId, op: z.literal("fs.read"), path: z.string(), encoding: FsReadEncoding.optional() }),
  z.object({ id: reqId, op: z.literal("git.status"), cwd: z.string() }),
  z.object({ id: reqId, op: z.literal("git.diff"), cwd: z.string(), scope: GitDiffScope, path: z.string().optional() }),
  /** One laptop-side connection to a guest loopback port, for the sign-in
   * callback forward. The daemon dials 127.0.0.1 then ::1 (a Node 22 tool
   * binds [::1] only). data is base64; the reply to tunnel.open comes after
   * the guest accepted. */
  z.object({ id: reqId, op: z.literal("tunnel.open"), tunnelId: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ id: reqId, op: z.literal("tunnel.write"), tunnelId: z.string(), data: z.string() }),
  z.object({ id: reqId, op: z.literal("tunnel.close"), tunnelId: z.string() }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

export const DaemonErrorCode = z.enum([
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "not-a-git-repo",
  "bad-request",
  "forbidden",
]);
export type DaemonErrorCode = z.infer<typeof DaemonErrorCode>;

export const DaemonOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** code is set by the files and diff ops so clients can branch on the refusal
 * without matching message text; older ops send the message alone. */
export const DaemonErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  code: DaemonErrorCode.optional(),
});
export const DaemonResponse = z.union([DaemonOkResponse, DaemonErrorResponse]);
export type DaemonResponse = z.infer<typeof DaemonResponse>;

/** One reading of the guest: cpu is busy time over the interval across all
 * cores (0 to 100), load1 the one-minute load average, mem and disk in bytes
 * (mem used is total minus available; disk is the filesystem under the
 * daemon's root), at epoch milliseconds. */
export const SysSample = z.object({
  type: z.literal("sys.sample"),
  cpu: z.number(),
  load1: z.number(),
  mem: z.object({ used: z.number(), total: z.number() }),
  disk: z.object({ used: z.number(), total: z.number() }),
  at: z.number(),
});
export type SysSample = z.infer<typeof SysSample>;

/** Every process the daemon read this tick. daemon is its own pid, so a
 * client can name it; total counts /proc entries, procs holds at most the
 * first thousand of them by pid. */
export const ProcSnapshot = z.object({
  type: z.literal("proc.snapshot"),
  at: z.number(),
  daemon: z.number().int(),
  total: z.number().int(),
  procs: z.array(ProcEntry),
});
export type ProcSnapshot = z.infer<typeof ProcSnapshot>;

/** The content of every daemon this project has deployed, oldest first, one entry per version: the last one is
 * what a deploy installs today, so appending the sha the host's daemon-content test prints is the whole of
 * cutting a new version. The three cut before the record existed have no sha to name. */
const UNRECORDED = "";
const DAEMON_CONTENTS = [
  UNRECORDED,
  UNRECORDED,
  UNRECORDED,
  "b749121a659b9c45b07285ee0f4e95f15aae26ddbc1bcba75745e83c2ae032c6",
  "b0b88a03c649769e0676ca38eaa5035825b71302c97a2858dcf8eb57131288be",
  "cae44a68bd72d81717b52a71c3890da918025cbd0d071db884102936e5cf4345",
  "c5c3b15cad1b45ed110b072a18d0d895f661c489f73828de78a3b9f3589f05c6",
];

/** The daemon's protocol version, carried in its hello, so a client can tell what a machine's daemon answers
 * before asking, and a host can tell that a machine's daemon is behind the one it would deploy. It moves whenever
 * an op is added or widened and whenever anything a deploy installs changes, because a live machine keeps the
 * daemon it has until the version it announces is behind this one. A hello without one is version 1: every daemon
 * deployed before the field existed, which has the pty, ports, manifest, inbox, fs, git and tunnel ops and no sys
 * or proc ops. Version 3 browses the imported project folders named in DAEMON_ROOTS_PATH beside its home.
 * Version 4 starts from a script that sets the guest PATH itself. Version 5 fetches its Node through the catalog's
 * curl function. Version 6 puts itself last for the kernel's memory killer and starts every shell it opens at the
 * work score instead. Version 7 picks the road to the listening ports by platform, so the same daemon serves them
 * on a Linux guest and on the person's own Mac. */
export const DAEMON_VERSION = DAEMON_CONTENTS.length;

/** sha256 of what a deploy installs on a guest and this record can hold: the daemon's sources, the dependency
 * pins its bundle carries, the scripts the host writes beside them, and DAEMON_ROOTS_PATH. The host's
 * daemon-content test recomputes it and fails when that content moved and this record did not, so changed content
 * cannot reach nobody: a start script gained a PATH line under an unchanged version once and every machine
 * already running kept the old one. Left out, and on the guest anyway because the daemon's dist bundles them: the
 * rest of this file, the DaemonAuthRequest schema the daemon reads, and zod. Hashing the protocol whole would
 * turn every edit to it into a redeploy of every machine. */
export const DAEMON_CONTENT_SHA = DAEMON_CONTENTS[DAEMON_CONTENTS.length - 1]!;

/** The file on the guest naming the imported project folders, one absolute path per line: the runtime writes it
 * when a project lands, the daemon reads it on every files and diff op and browses those folders beside its home.
 * The guest's home is /root, so this is rootsPathIn answered there; the value is hashed into DAEMON_CONTENT_SHA. */
export const DAEMON_ROOTS_PATH = rootsPathIn("/root");

/** The version a hello announces, 1 when it carries none. */
export function daemonVersionOf(hello: { version?: number }): number {
  return hello.version ?? 1;
}

export const DaemonEvent = z.discriminatedUnion("type", [
  /** The first frame after the auth reply: root is the
   * absolute directory every fs.* and git.* path must resolve inside, so a
   * client can build absolute paths for pickers, pins and session starts.
   * version is DAEMON_VERSION as the daemon was built; absent on version 1. */
  z.object({ type: z.literal("daemon.hello"), root: z.string(), version: z.number().int().optional() }),
  z.object({ type: z.literal("pty.data"), ptyId: z.string(), data: z.string() }),
  z.object({
    type: z.literal("pty.exit"),
    ptyId: z.string(),
    exitCode: z.number(),
    signal: z.number().optional(),
  }),
  /** loopback: bound to 127.0.0.1 or ::1 only, so the preview edge (which dials eth0) cannot reach it. */
  z.object({
    type: z.literal("port.open"),
    port: z.number(),
    pid: z.number().optional(),
    process: z.string().optional(),
    loopback: z.boolean().optional(),
  }),
  z.object({ type: z.literal("port.close"), port: z.number(), ...portCloseDetail }),
  z.object({ type: z.literal("inbox.file"), path: z.string(), bytes: z.number() }),
  /** Broadcast on pty.attach (current state) and afterwards only on change.
   * mode mirrors the slave termios ICANON bit ("line" when set), echo mirrors
   * ECHO; foreground is the comm of the foreground process group leader, ""
   * when unreadable. There is no request op: clients only listen. */
  z.object({
    type: z.literal("pty.mode"),
    ptyId: z.string(),
    mode: z.enum(["line", "raw"]),
    echo: z.boolean(),
    foreground: z.string(),
  }),
  /** A guest tool asked for a browser (through the BROWSER or xdg-open shim).
   * Pushed to every authed socket; clients show it and open it on a click.
   * http(s) only: the machine is the untrusted side. port is the localhost
   * port in the URL's redirect_uri when it carries one. */
  z.object({ type: z.literal("browser.open"), url: z.string().refine(isHttpUrl, "http or https URL"), port: RelayPort.optional() }),
  /** A loopback listener appeared around a browser.open whose URL named no
   * port: the flow's callback, for the host to forward. */
  z.object({ type: z.literal("callback.port"), port: RelayPort }),
  z.object({ type: z.literal("tunnel.data"), tunnelId: z.string(), data: z.string() }),
  /** The guest side closed; the laptop connection ends after any data before it. */
  z.object({ type: z.literal("tunnel.end"), tunnelId: z.string() }),
  /** A pty printed, or a tool asked to open, a plain http URL on a local host
   * with an explicit port (http://localhost:8123/, 127.0.0.1:8123): the port a
   * person would click. Only the port travels; the host forwards it here. */
  z.object({ type: z.literal("localhost.url"), port: RelayPort }),
  SysSample,
  ProcSnapshot,
]);
export type DaemonEvent = z.infer<typeof DaemonEvent>;

// --- runtime wire protocol (serveRuntime) ------------------------------------

export const TicketPurpose = z.enum(["connect"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

const RuntimeOp = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  /** Replies with an EventsSubscribeReply, then pushes events on this socket. With `after`, the seq of the last event
   * this client saw, every retained event past it is pushed first, oldest first, before anything live; `stream` is
   * the id that came with that seq, so a runtime that is not the one that issued it answers gap instead. */
  z.object({
    id: reqId,
    op: z.literal("events.subscribe"),
    after: z.number().int().nonnegative().optional(),
    stream: z.string().optional(),
  }),
  /** Replies with a WorkspaceStatus[] snapshot and keeps the runtime's status
   * poller + cost ticker running while this socket lives; the events ride the
   * events.subscribe channel. */
  z.object({ id: reqId, op: z.literal("status.subscribe") }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.create"),
    golden: z.string(),
    name: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
    envs: z.record(z.string()).optional(),
    labels: z.record(z.string()).optional(),
    /** Auto-nap window for this workspace; absent takes the runtime default (20 min), null turns it off. */
    idleWindowMs: z.number().nullable().optional(),
  }),
  /** The one local workspace: this computer. Forks nothing (the machine already exists); refused when this host wired
   * no local backend, when one already exists, or for a name another workspace holds. Replies with { workspace }. */
  /** Makes this computer the host's one local workspace; the name defaults to this computer's own. */
  z.object({ id: reqId, op: z.literal("workspaces.createLocal"), name: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("workspaces.list") }),
  z.object({ id: reqId, op: z.literal("workspaces.get"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.nap"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.wake"), workspaceId: z.string() }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.upgrade"),
    workspaceId: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
  }),
  /** Moves a workspace onto the golden's head version: a fresh fork of the newer image carrying this workspace's
   * files across, the way a resize does. The person asks for it; nothing moves a machine they are working on.
   * Refused (kind "conflict") for a workspace forked from a project golden, whose disk the move would throw away. */
  z.object({ id: reqId, op: z.literal("workspaces.updateImage"), workspaceId: z.string() }),
  /** Names the workspace and replies with its fresh { workspace }. The name is unique on this host, so one another
   * workspace holds, one a fork is landing under and a blank one are refused (kind "conflict"); a name the workspace
   * already carries comes back untouched. Threads running on the machine are untouched. */
  z.object({ id: reqId, op: z.literal("workspaces.rename"), workspaceId: z.string(), name: z.string() }),
  /** Sets the workspace's look and replies with its fresh { workspace }. A key left out keeps that fact as it is and
   * null clears it, so the colour picker and the icon picker each send their own without reading the other's. The
   * record alone changes: nothing on the machine is touched. */
  z.object({ id: reqId, op: z.literal("workspaces.look"), workspaceId: z.string() }).extend(WorkspaceLook.shape),
  z.object({ id: reqId, op: z.literal("workspaces.delete"), workspaceId: z.string() }),
  /** Drops a workspace whose machine the provider no longer has: the record, its transcripts and its sessions leave the
   * store, workspace.deleted follows, and nothing is asked of the provider. Refused with the reason (kind "conflict")
   * while the machine still exists: pause it or delete it at the provider first. */
  z.object({ id: reqId, op: z.literal("workspaces.forget"), workspaceId: z.string() }),
  /** Snapshots the workspace's disk as a project golden and replies with { projectGolden }. Refused when the workspace
   * is not running, holds no project, or its machine is not first-life (kind "notFirstLife"). The guest freezes for
   * about three seconds and keeps its first life. */
  z.object({ id: reqId, op: z.literal("workspaces.snapshot"), workspaceId: z.string() }),
  /** Replies with { projectGoldens: ProjectGolden[] }, every project golden this runtime took, newest last. */
  z.object({ id: reqId, op: z.literal("projectGoldens.list") }),
  /** A person acted in the workspace through a road the runtime cannot see (typed into
   * a terminal over the browser's daemon link); the idle countdown starts over. */
  z.object({ id: reqId, op: z.literal("workspaces.touch"), workspaceId: z.string() }),
  /** Replies with a DaemonReachView; the runtime remints the edge token when it nears expiry. */
  z.object({ id: reqId, op: z.literal("workspaces.daemonReach"), workspaceId: z.string() }),
  /** Starts a turn and replies with a SessionStartResult. On a thread whose turn is still running the runtime never
   * starts a second one on the session: the message joins the running turn when the harness steers (the reply names
   * that turn), and otherwise waits for it to end before starting. */
  z.object({
    id: reqId,
    op: z.literal("sessions.start"),
    workspaceId: z.string(),
    prompt: z.string(),
    harness: z.string().optional(),
    resume: z.string().optional(),
    /** The thread the message goes to, by its runtime id: its latest turn is resumed, and a thread whose harness never
     * announced a session takes the message as a first turn on that same thread. Refused when the workspace has no
     * thread with that id. */
    thread: z.string().optional(),
    cwd: z.string().optional(),
    /** Values from the harness's catalog for the workspace (harnesses.list), refused with that list on a miss. A
     * start that opens a thread without a model runs the one the catalog marks default, so the app, the command line
     * and the MCP server run the same model; an absent effort or mode leaves the CLI's own. */
    model: z.string().optional(),
    effort: z.string().optional(),
    permissionMode: z.string().optional(),
    contextWindow: z.string().optional(),
    /** Absent reads as person: the app never sends it, the command line sends cli, the MCP server sends agent. */
    startedBy: SessionOrigin.optional(),
    /** Minted by the client per send and echoed on the turn's session.start, so the client knows which start is its own. */
    requestId: z.string().optional(),
    /** A thread id, or NOTIFY_ME: registered on the thread this start opens, so every turn's end on it sends one line
     * there (a session.notify event in this thread's transcript). Refused when no thread has that id. */
    notify: z.string().optional(),
    /** The name the thread is opened under, as a person's: it stands in every client at once, the harness is told it
     * too so its own UI says the same, and no generated title ever replaces it. Refused when it is blank. */
    title: z.string().optional(),
    /** The images the message carries, in the order the person added them; refused with imagesRefusal's line over the
     * caps, and refused naming the agent before the machine is asked when that agent's adapter reads no image. */
    attachments: z.array(ImageAttachment).optional(),
  }),
  /** Replies with { harnesses: HarnessCatalog[] }, one per harness the runtime knows. With a workspace, the lists come
   * from the binaries on its machine where they answer; without one, from the runtime's table. */
  z.object({ id: reqId, op: z.literal("harnesses.list"), workspaceId: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("sessions.list"), workspaceId: z.string().optional() }),
  /** Replies with the workspace's persisted SessionEvent[] (oldest first, capped by the runtime). */
  z.object({ id: reqId, op: z.literal("sessions.history"), workspaceId: z.string() }),
  /** Asks the harness to stop the session's running turn; replies with a SessionInterruptResult. */
  z.object({ id: reqId, op: z.literal("sessions.interrupt"), sessionId: z.string() }),
  /** Sends a message into the session's running turn; replies with a SessionSteerResult. Takes the runtime's session
   * id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.steer"), sessionId: z.string(), prompt: z.string(), requestId: z.string().optional() }),
  /** Answers a permission prompt the session's running turn relayed into the chat, by the prompt's id and one of its
   * options; replies with a SessionAnswerResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.answer"), sessionId: z.string(), askId: z.string(), optionId: z.string() }),
  /** Puts the session's running turn into another access mode from its next tool call on; replies with a
   * SessionAccessResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.access"), sessionId: z.string(), permissionMode: z.string() }),
  /** Names the session's harness session in the harness's own store and keeps the name on the thread's rows; replies
   * with a SessionRenameResult. Takes the runtime's session id, as sessions.interrupt does. */
  z.object({ id: reqId, op: z.literal("sessions.rename"), sessionId: z.string(), title: z.string() }),
  z.object({ id: reqId, op: z.literal("golden.get"), name: z.string() }),
  /** Replies with the backend's Capabilities; the UI gates features on these. */
  z.object({ id: reqId, op: z.literal("capabilities.get") }),
  /** Boots a fresh builder for golden `name`; replies with a GoldenBuilderView.
   * Progress rides golden.stage events on the events channel. */
  z.object({ id: reqId, op: z.literal("golden.prepare"), name: z.string(), kind: MachineKind.optional() }),
  /** Snapshots the builder, smoke-tests a fork, appends a manifest version;
   * replies with { manifest, version }. The builder is consumed either way. */
  z.object({ id: reqId, op: z.literal("golden.seal"), builderId: z.string() }),
  /** Replies with { lineage: SnapshotLineage } for golden `name` (default "default"). */
  z.object({ id: reqId, op: z.literal("snapshots.list"), name: z.string().optional() }),
  /** Replies with { storage: SnapshotStorage | null }: every snapshot on the account by count, size and monthly
   * cost; null on a backend whose capabilities lack snapshotListing. */
  z.object({ id: reqId, op: z.literal("snapshots.storage") }),
  /** Replies with { points: WorkspaceCostEvent[] }: the workspace's cost ticks since metering began, across host
   * restarts, folded to the ticks where the rate changed plus the newest (appendCostPoint); empty before the first tick. */
  z.object({ id: reqId, op: z.literal("cost.history"), workspaceId: z.string() }),
  /** Moves the golden's head to a version already in its manifest; replies with a
   * SnapshotRollbackResult. A version outside the manifest fails with kind "missing". */
  z.object({ id: reqId, op: z.literal("snapshots.rollback"), version: z.number(), name: z.string().optional() }),
  /** Replies with a DaemonReachView for a live builder (wsp init's sign-in
   * terminal dials it). Asked per dial like workspaces.daemonReach: the edge token
   * expires hourly and a builder may sit for hours before it is sealed. */
  z.object({ id: reqId, op: z.literal("golden.builderReach"), builderId: z.string() }),
  /** Replies with { reach: PortReachView } for one guest port, cached per port
   * while fresh like workspaces.daemonReach. A port outside the daemon's
   * listening set still mints: the user may have typed it. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portReach"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replies with { probe: PortProbeView }: one fetch of the port's minted route
   * from the host, redirects unfollowed, the body read up to a cap. A 401 remints
   * the port's route before the reply, so the next portReach carries a fresh
   * token. Refused when the route cannot be fetched at all; the frame is the
   * only truth then. */
  z.object({
    id: reqId,
    op: z.literal("workspaces.portProbe"),
    workspaceId: z.string(),
    port: z.number().int().min(1).max(65535),
  }),
  /** Replaces the workspace's machine with a fresh golden fork, imports the
   * nap-time vault if one exists, and kills the old machine whatever it
   * reports. Replies with the WorkspaceView on its new machine; id and name
   * are kept. The way out of a zombie reach state. */
  z.object({ id: reqId, op: z.literal("workspaces.rebuild"), workspaceId: z.string() }),
  /** Replies with { forwards: PortForward[] }, the host's open forwards; empty when no host holds any. */
  z.object({ id: reqId, op: z.literal("forwards.list") }),
  /** Closes one forward; refused when none is open on that workspace and port. */
  z.object({ id: reqId, op: z.literal("forwards.stop"), workspaceId: z.string(), port: RelayPort }),
  /** Runs one command on the workspace's machine the way a harness turn is launched: detached, as the same user,
   * with the environment the harness adapter exports for a turn. argv is the command word by word; the runtime
   * quotes each for the machine's shell, so a word stays one word. Replies { execId } once launched, then pushes
   * ExecEvent frames to this socket only: exec.output per line, exec.exit last. The socket closing ends the
   * command, and so does the machine going away under it (deleted, paused, or unanswering: exec.exit then carries
   * the reason as its error); nothing else does, there is no deadline. cwd is the folder the command runs in, absolute;
   * absent, the home folder, as a harness turn's is. */
  z.object({ id: reqId, op: z.literal("workspaces.exec"), workspaceId: z.string(), argv: z.array(z.string()).min(1), cwd: z.string().optional() }),
  /** Replies with { listing: HostFolderListing }: one level of this computer's own folders, for the picker a browser
   * tab has instead of the desktop shell's dialog. `dir` absent lists the first root and a folder inside the roots
   * that is gone does the same; a path outside them is refused. `hidden` lists the dot-named folders too, which are
   * otherwise only counted. */
  z.object({ id: reqId, op: z.literal("host.folders"), dir: z.string().optional(), hidden: z.boolean().optional() }),
  /** Replies with { config: TerminalConfig }: the person's Ghostty config on the computer running the host, read
   * again on every ask so a saved change reaches the next terminal opened; `scheme` picks the theme of a
   * light:...,dark:... value and is dark when absent. */
  z.object({ id: reqId, op: z.literal("host.terminalConfig"), scheme: TerminalScheme.optional() }),
  /** Replies with { preferences: Preferences }: the record on this host's state, the defaults until a client set something. */
  z.object({ id: reqId, op: z.literal("preferences.get") }),
  /** Lands the patch on the record, keeps it, pushes preferences.changed to every socket and replies with { preferences: Preferences }. */
  z.object({ id: reqId, op: z.literal("preferences.set"), patch: PreferencesPatch }),
  /** Replies with { plan: ProjectPlan } for a folder on this computer; nothing is read into memory or uploaded. */
  z.object({ id: reqId, op: z.literal("project.plan"), source: z.string() }),
  /** Packs the folder and lands it at `dest` on the workspace's machine; progress rides project.import events and the
   * reply is { imported: ProjectImportResult }. `carry` names the secret-shaped paths from the plan that may travel as
   * they are; `rewrite` names the ones the plan offered a rewrite for, which land rewritten as offered and win over
   * carry; every other secret-shaped file is cut and named. `agents` names the plan's agents whose state for the
   * folder travels; nothing of an agent not named is read. An existing `dest` is refused (kind "exists") unless `replace`. */
  z.object({
    id: reqId,
    op: z.literal("project.import"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    carry: z.array(z.string()).optional(),
    rewrite: z.array(z.string()).optional(),
    agents: z.array(z.string()).optional(),
  }),
  /** The bundle's trip home: tars `source` on the workspace's machine with the bundle's cache exclusions and the
   * agent state keyed to it, lands the folder at `dest` on this computer and the state in the agents' homes here,
   * keyed to `dest`; progress rides project.export events and the reply is { exported: ProjectExportResult }.
   * `agents` narrows whose state comes home, by catalog id; absent, every agent with sessions for the folder does.
   * An existing `dest` is refused (kind "exists", the message naming it and how many files it holds) unless
   * `replace`; nothing is read from the machine before that check. */
  z.object({
    id: reqId,
    op: z.literal("project.export"),
    workspaceId: z.string(),
    source: z.string(),
    dest: z.string(),
    replace: z.boolean().optional(),
    agents: z.array(z.string()).optional(),
  }),
]);

/** Every request carries where it reached the host from: here, this computer's own app, CLI or MCP, or relayed from
 * a machine. It rides the envelope beside the id rather than each op, so a verb added later carries it without
 * saying so. Absent reads here, and today every client on this computer is here in practice. */
export const RuntimeRequest = z.intersection(RuntimeOp, z.object({ origin: WorkspaceOrigin.optional() }));
export type RuntimeRequest = z.infer<typeof RuntimeRequest>;

/** What a workspaces.exec pushes to the socket that asked. exitCode is null when the command was ended without
 * one (the socket closed or the launch failed); error says which. */
export const ExecEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exec.output"), execId: z.string(), text: z.string() }),
  z.object({ type: z.literal("exec.exit"), execId: z.string(), exitCode: z.number().int().nullable(), error: z.string().optional() }),
]);
export type ExecEvent = z.infer<typeof ExecEvent>;

export const RuntimeOkResponse = z.object({ id: reqId.nullable(), ok: z.literal(true) }).passthrough();
/** `kind` carries a typed failure when the runtime has one (engine WspError
 * kinds such as "concurrency", or "notFirstLife" from a refused seal). */
export const RuntimeErrorResponse = z.object({
  id: reqId.nullable(),
  ok: z.literal(false),
  error: z.string(),
  kind: z.string().optional(),
});
export const RuntimeResponse = z.union([RuntimeOkResponse, RuntimeErrorResponse]);
export type RuntimeResponse = z.infer<typeof RuntimeResponse>;

// --- session interrupt (what a stop button gets back) -------------------------

/** accepted: the harness was told to stop and the turn ends with status interrupted.
 * not-running: the turn had already ended, so there was nothing to stop.
 * not-found: this runtime holds no such session (sessions live in memory; a restart forgets them).
 * None of these is an error reply: a stop button has nothing to recover from. */
export const SessionInterruptOutcome = z.enum(["accepted", "not-running", "not-found"]);
export type SessionInterruptOutcome = z.infer<typeof SessionInterruptOutcome>;
export const SessionInterruptResult = z.object({ outcome: SessionInterruptOutcome });
export type SessionInterruptResult = z.infer<typeof SessionInterruptResult>;

// --- session steer (what send-now on a queued row gets back) -------------------

/** accepted: the harness took the message into the running turn and a session.steer event carries it.
 * not-running: the turn had ended, or had not started, when the message was offered; the caller starts a turn instead.
 * unsupported: the session's harness takes no message mid-turn (its catalog says steers: false).
 * not-found: this runtime holds no such session. None is an error reply. */
export const SessionSteerOutcome = z.enum(["accepted", "not-running", "unsupported", "not-found"]);
export type SessionSteerOutcome = z.infer<typeof SessionSteerOutcome>;
export const SessionSteerResult = z.object({ outcome: SessionSteerOutcome });
export type SessionSteerResult = z.infer<typeof SessionSteerResult>;

// --- session access (what a pick made while a turn runs gets back) ---------------------

/** set: the harness took the mode and this turn's next tool call runs at it. unsupported: the harness takes no
 * access change on a turn already under way (Claude Code's bypass, which is a launch flag on that CLI), so the pick
 * waits for the person's next message. not-running: the turn ended, or its process is gone, before the pick reached
 * it. not-found: this runtime holds no such session. None is an error reply, as a mode the harness's own list does
 * not carry is. */
export const SessionAccessOutcome = z.enum(["set", "not-running", "unsupported", "not-found"]);
export type SessionAccessOutcome = z.infer<typeof SessionAccessOutcome>;
export const SessionAccessResult = z.object({ outcome: SessionAccessOutcome });
export type SessionAccessResult = z.infer<typeof SessionAccessResult>;

// --- session answer (what picking an option on a relayed permission prompt gets back) --

/** answered: the harness took the answer and the tool call it blocks ran or was refused as the option says, and a
 * session.permission.closed event carries it. gone: no such prompt is open on that session, so it was answered
 * already, withdrawn by the harness, or its turn is over; the row closes on that event, not on this reply.
 * unsupported: the session's harness raises no prompt this host can answer. not-found: this runtime holds no such
 * session. no-option: the prompt is open and carries no option by that id. None is an error reply. */
export const SessionAnswerOutcome = z.enum(["answered", "gone", "unsupported", "not-found", "no-option"]);
export type SessionAnswerOutcome = z.infer<typeof SessionAnswerOutcome>;
export const SessionAnswerResult = z.object({ outcome: SessionAnswerOutcome });
export type SessionAnswerResult = z.infer<typeof SessionAnswerResult>;

// --- session rename (what a name a person typed came to in the harness's store) -

/** renamed: the harness's store took the name, in the field the harness itself writes, and the thread's rows carry
 * it. unsupported: the session's harness keeps no name of a person's, so nothing was written and nothing would have
 * survived its next turn. no-session: the store answered and holds no such session, or the harness never announced
 * one for this thread. failed: the store was there and refused the write, and `error` is the line the machine gave
 * for it. not-found: this runtime holds no such session. None is an error reply. */
export const SessionRenameOutcome = z.enum(["renamed", "unsupported", "no-session", "failed", "not-found"]);
export type SessionRenameOutcome = z.infer<typeof SessionRenameOutcome>;
export const SessionRenameResult = z.object({ outcome: SessionRenameOutcome, error: z.string().optional() });
export type SessionRenameResult = z.infer<typeof SessionRenameResult>;

// --- session start (how the turn the caller asked for came to be) --------------

/** started: a turn of its own began. steered: the thread's turn was running and took the message mid-way, so
 * session is that turn and a session.steer event carries the message. queued: the thread's turn was running and could
 * not take a message, so this start waited for it to end and then began. The reply comes back once the turn began.
 * turnId is the turn's, as its events carry it: a follower keys on it, since the thread's earlier turns share the
 * session row. */
export const SessionStartOutcome = z.enum(["started", "steered", "queued"]);
export type SessionStartOutcome = z.infer<typeof SessionStartOutcome>;
export const SessionStartResult = z.object({ session: SessionView, outcome: SessionStartOutcome, turnId: z.string() });
export type SessionStartResult = z.infer<typeof SessionStartResult>;

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
  project: WorkspaceProject,
  golden: z.string(),
  version: z.number().int().optional(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  createdAt: z.string(),
});
export type ProjectGolden = z.infer<typeof ProjectGolden>;

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

export { NO_REBUILD_NEEDED, actionRefusal, computerOffline, goneRefusal, imageMoveRefusal, isBilling, isLocalWorkspace, kindWords, needsRebuild, reachShown, sendRefusal, workspaceKind, workspaceState, workspaceWord, WORKSPACE_KIND_WORDS, type ImageMoveInput, type SendBlock, type SendRefusalKind, type WorkspaceKindWords, type WorkspaceState, type WorkspaceStateInput } from "./workspace-state.js";
export * from "./exit.js";
export * from "./format.js";
export { IMAGES_AFTER_TURN, IMAGES_MAX, IMAGE_ACCEPT, IMAGE_MAX_BYTES, IMAGE_MAX_WORDS, IMAGE_TYPES, IMAGE_TYPE_WORDS, ImageAttachment, ImageRecord, imageBytes, imageLine, imagePathIn, imageRecord, imageTypeOf, imagesBlocked, imagesRefusal, noImagesLine, notAFileLine, notAnImageLine, threadImagesDir, turnImagesDir } from "./attachments.js";
export * from "./oom.js";
export { appendCostPoint, COST_HISTORY_CAP } from "./cost-history.js";
export { inFolder, shellLine, shellQuote } from "./shell-quote.js";
export { LOOK_PARTS, WORKSPACE_GLYPHS, WORKSPACE_TINTS, WorkspaceGlyph, WorkspaceLook, WorkspaceTint, type LookPart } from "./workspace-look.js";
export { rootsPathIn, underProject } from "./project-path.js";
export { agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, importConsented, importRequest, secretOffer, type ImportAnswers, type ProjectImportRequest } from "./project-import.js";
export { threadFromHash, threadHash, workspaceFromHash, workspaceHash } from "./app-address.js";
export * from "./app-ports.js";
export { catalogRefused, endAfterResult, endRun, PERMISSION_ALLOW, PERMISSION_DENY } from "./adapter-port.js";
export type { AdapterAttachOptions, AdapterEvent, AttachmentRoad, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, HarnessCatalogModelProbe, HarnessCatalogProbe, HarnessCatalogRefusal, PermissionAsk, SessionRenameWrite, SessionRenamer, SessionTitleMaker, SessionTitleReader, TitleTurn, TurnImage } from "./adapter-port.js";
