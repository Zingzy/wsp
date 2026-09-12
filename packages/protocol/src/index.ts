// The typed contract every client speaks: workspace/session views, the event
// union fanned out by the runtime, and the wire types for both servers (the
// runtime's serveRuntime and the in-VM daemon). The daemon package has no
// exported wire types, so these schemas are their one home; @wsp/daemon's
// handlers are the reference implementation they mirror. A few readings of a
// machine are parsed here too (ps-time.ts): the runtime and the daemon both
// read them and neither may import the other, so this package is the only
// home a second copy cannot grow beside.

import { z } from "zod";
import { DEFAULT_PLACE_PORT } from "./app-ports.js";
import { HOST_TOKEN_ENV, HOST_URL_ENV, LABS_ENV, TURN_TOKEN_ENV } from "./env.js";
import { ImageAttachment, ImageRecord } from "./attachments.js";
import { openingTitle, PLACE_LEAVE_LINE, threadWord, titleLine } from "./format.js";
import { InitJob, InitJobEvent, InitAgent, InitKeys, InitNeedsYou, InitNeedsYouEvent, InitRoad, InitScreenId, LoginState, SIGN_IN_CODE_MAX } from "./init-job.js";
import { rootsPathIn } from "./project-path.js";
import { shellQuote } from "./shell-quote.js";
import { WorkspaceGlyph, WorkspaceLook, WorkspaceTheme } from "./workspace-look.js";

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

/** Hosts a sign-in's redirect comes back to on the machine itself; anything else is a page the person finishes. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A sign-in URL's redirect_uri as a URL, or nothing when it carries none and when either fails to parse. */
function redirectOf(url: string): URL | undefined {
  try {
    const redirect = new URL(url).searchParams.get("redirect_uri");
    return redirect === null ? undefined : new URL(redirect);
  } catch {
    return undefined;
  }
}

/** Whether a sign-in's page comes back to the machine that asked for it: its redirect_uri names a loopback host,
 * port or no port (aws registers http://127.0.0.1/oauth/callback bare and binds its port at the time). This is what
 * tells the two roads apart, since a page that returns to the machine hands the person nothing to carry back. */
export function redirectsToMachine(url: string): boolean {
  const target = redirectOf(url);
  return target !== undefined && LOOPBACK_HOSTS.has(target.hostname);
}

/** Which port on the machine that redirect names, for the forward to bind here: the daemon reads it to name the port
 * on a browser.open. Absent when the page does not come back to the machine at all, when the redirect names no
 * explicit port, or when the port is one this computer could not bind. */
export function callbackPortOf(url: string): number | undefined {
  const target = redirectOf(url);
  if (target === undefined || !LOOPBACK_HOSTS.has(target.hostname) || target.port === "") return undefined;
  const port = Number(target.port);
  return RelayPort.safeParse(port).success ? port : undefined;
}

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

/** What the cloud setup modal opens on: which keys the host holds (their presence, never a value), the agents on this
 * computer the agent road can start, the price of the machine the build boots, and the init job when one is running
 * or over. */
export const InitSetup = z.object({
  keys: InitKeys,
  /** This computer's home directory, so a field can show a real path of the person's as its example. */
  home: z.string(),
  agents: z.array(InitAgent),
  /** What a machine costs on this host's provider, and the disk that provider gives a builder where it caps one;
   * null where the host forks none, so there is no golden to build here and nothing to price. */
  pricing: z.object({ size: WorkspaceSize, rateUsdPerHour: z.number(), builderDiskGb: z.number().positive().optional() }).nullable(),
  job: InitJob.nullable(),
});
export type InitSetup = z.infer<typeof InitSetup>;

/** One size a create may ask for, with what it costs awake. */
export const MachineSizeOffer = WorkspaceSize.extend({ rateUsdPerHour: z.number() });
export type MachineSizeOffer = z.infer<typeof MachineSizeOffer>;

/** How a provider pauses a machine. memory: a pause keeps the processes and every byte they hold. disk: a pause is a
 * stop and a snapshot, and the wake is a boot that starts nothing the machine was running. */
export const PauseMode = z.enum(["memory", "disk"]);
export type PauseMode = z.infer<typeof PauseMode>;

/** Honest per-backend feature flags; the UI degrades based on these, never on probing. */
export const Capabilities = z.object({
  /** What a fork of an image comes up as: on a provider whose images hold memory the processes are still running,
   * and on one whose images hold only a disk it boots cold and wsp starts the agents on it again. The provider
   * table publishes it; no verb reads it, since each verb reads the one road its own move needs. */
  liveCloneForks: z.boolean(),
  /** Absent: the machine cannot be paused, and the runtime refuses a nap and a wake. The app reads the value for its
   * words; the runtime reads only whether it is there. */
  pauseMode: PauseMode.optional(),
  /** The provider asks for a machine at a size another one was not made at. False on a provider that clamps every
   * machine to one size, whatever else it can do to one. Half of the resize road, since a resize replaces the
   * machine first: resizesMachines reads the pair, and the verb and the button that offers a size both read that. */
  resize: z.boolean(),
  /** The provider replaces a machine with a fresh fork of the image behind it and the workspace goes on, its
   * vaulted files carried over: the one road a rebuild and an image move both take, since both throw a machine away
   * and hand its workspace another. False where nothing forks: this computer, a machine reached over ssh, a host with
   * no provider. Whether the replacement comes up with the processes still running is liveCloneForks, which says
   * nothing about whether one may stand in at all. */
  replacesMachine: z.boolean(),
  previewUrls: z.boolean(),
  signedUrls: z.boolean(),
  /** Guests can run containers; false means services get installed natively. */
  containers: z.boolean(),
  /** A daemon link exists, so sign-in URLs a guest tool opens land in the laptop's browser and the
   * callback port is forwarded back; false means the person finishes sign-ins by copy and paste. */
  callbackRelay: z.boolean(),
  /** The provider copies a running machine's disk into an image it keeps, which is what a version and a project
   * golden are sealed as and what a fork boots from. False where the disk is the person's own and nothing copies it
   * (this computer, a machine reached over ssh). Which life the copy may be taken from is the provider's own rule.
   * Whether a fork of that image comes up with the processes still running is liveCloneForks and says nothing about
   * whether one can be taken. */
  diskSnapshots: z.boolean(),
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

/** Whether this host forks no machine at all: the provider module a keyless host wires offers no size, so the roads
 * that would fork one answer NO_PROVIDER_LINE instead of sending the person back to an init that seals nothing. The
 * one place that reading is made, so nothing above the provider module asks whether there is a key. */
export function forksNoMachines(capabilities: { sizes: readonly MachineSizeOffer[] }): boolean {
  return capabilities.sizes.length === 0;
}

/** Whether a place can build a copy of the image at all: it has to fork a builder and then copy that builder's disk
 * into something a fork can stand on. A computer somebody joined does neither, and nor does a host with no provider
 * key. The one place that reading is made, so the refusal and any road that offers the build read one rule. */
export function buildsImages(capabilities: Pick<Capabilities, "diskSnapshots"> & { sizes: readonly MachineSizeOffer[] }): boolean {
  return !forksNoMachines(capabilities) && capabilities.diskSnapshots;
}

/** Whether this provider can give a machine that already exists a new size, which is both halves of that one road:
 * a resize replaces the machine with a fresh fork of its image, then asks for that one at a size the old was not
 * made at. The one place the pair is read, so the gate that refuses a resize and the button that offers a size
 * cannot hold half the rule each. */
export function resizesMachines(capabilities: Pick<Capabilities, "resize" | "replacesMachine">): boolean {
  return capabilities.replacesMachine && capabilities.resize;
}

/** Whether a request asks for a size at all, the one reading both roads that take one make: a create naming none
 * takes the golden's own size and a resize naming none replaces the machine at the size it has, so neither checks
 * a size nor reads the road a new one needs. */
export function namesSize(asked: Partial<WorkspaceSize> | undefined): boolean {
  return asked?.cpu !== undefined || asked?.memMb !== undefined;
}

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

/** The reach as every door outside the app's own socket shows it: the state, and whether the probe even left this
 * computer. Picked rather than omitted, so a field added to the reach is not handed over by having been forgotten:
 * the route the status carries is the provider's minted bearer with an hour on it, and only the app dials it. */
export const ReachView = ReachStatus.pick({ state: true, offline: true });
export type ReachView = z.infer<typeof ReachView>;

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

/** One project a workspace holds: the folder the bundle landed at, named by its last segment, when the bundle landed
 * and, where the import measured it, its size in bytes. Added by an import, inherited by every fork of a project
 * golden. */
export const WorkspaceProject = z.object({ name: z.string(), dest: z.string(), importedAt: z.string(), size: z.number().int().nonnegative().optional() });
export type WorkspaceProject = z.infer<typeof WorkspaceProject>;

/** What a workspace's machine is: cloud, a fork wsp made at a provider, local, this computer itself, or ssh, a
 * machine of the person's own that wsp only reaches. A missing kind reads cloud, since every record written before
 * local workspaces existed was one. The one fact every road that varies by machine kind reads; nothing switches on
 * it outside the backend registry. */
export const WorkspaceKind = z.enum(["cloud", "local", "ssh", "place"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

/** Where a request to a workspace verb came from: here, this computer's own app, CLI or MCP, or relayed from a
 * machine wsp runs. A local workspace answers only `here`; today no machine has a road into the host, so nothing
 * relays yet, and the rule is written and tested so it holds when one appears. */
export const WorkspaceOrigin = z.enum(["here", "relayed"]);
export type WorkspaceOrigin = z.infer<typeof WorkspaceOrigin>;

/** What a token scoped to one thread names: the thread whose turn holds it, the workspace that thread runs on, and
 * the thread at the top of the tree that thread was spawned under, which is the thread itself when a person opened
 * it. The host mints the scope; nothing a client says on the wire can make or widen one. */
export const ThreadScope = z.object({
  kind: z.literal("thread"),
  threadId: z.string(),
  workspaceId: z.string(),
  rootThreadId: z.string(),
});
export type ThreadScope = z.infer<typeof ThreadScope>;

/** Who an event is on behalf of, taken off the scope that asked so the two cannot drift: the thread and the root of
 * its tree. An event about work that has no record yet carries this, since the reading that hides a workspace from
 * a caller has nothing to read until the record exists. */
export const EventAsker = ThreadScope.pick({ threadId: true, rootThreadId: true });
export type EventAsker = z.infer<typeof EventAsker>;

/** Where a request reached the host from, as every verb takes it: the road alone, or the road with the thread a
 * machine's turn sent it out of. A bare word is `here` or `relayed` and says nothing about who; the object is a
 * socket the host authed on a thread scoped token, and the scope is the host's own reading of that token, never
 * the client's. Read it through `roadOf` and `scopeOf` so no verb decides for itself what the shape means. */
export type Caller = WorkspaceOrigin | { origin: WorkspaceOrigin; by: ThreadScope };

/** Which road a caller came in by. */
export const roadOf = (caller: Caller | undefined): WorkspaceOrigin | undefined => (typeof caller === "string" ? caller : caller?.origin);

/** The thread a caller is, when it is one. */
export const scopeOf = (caller: Caller | undefined): ThreadScope | undefined => (typeof caller === "string" ? undefined : caller?.by);

/** What a workspace lets the agents inside it do to this host. Absent on the record means off: an agent that asks
 * for a thread or a machine is refused, which is what every workspace made before this switch existed answers. */
export const WorkspaceAgents = z.object({
  /** Whether a turn on this workspace gets a token into the host at all. */
  spawn: z.boolean(),
  /** How many machines may stand at once under one root thread, counted off the records. */
  maxMachines: z.number().int().min(0),
  /** How deep the tree under a root thread may go: 1 is the root's own children and no further. */
  maxDepth: z.number().int().min(1),
});
export type WorkspaceAgents = z.infer<typeof WorkspaceAgents>;

/** What a workspace's switch reads as when nobody has set one: agents drive nothing. */
export const AGENTS_OFF: WorkspaceAgents = { spawn: false, maxMachines: 0, maxDepth: 1 };

/** What a workspace's switch takes when a person turns it on and names no numbers. Three machines is what one root
 * thread's builders need and few enough that a runaway is a bill a person notices, and one level is the tree the
 * app draws without indenting twice. */
export const AGENTS_ON: WorkspaceAgents = { spawn: true, maxMachines: 3, maxDepth: 1 };

/** The switch a patch leaves on the record, the one rule both roads that set one read: every key the patch does not
 * name keeps what the record holds, so turning it off and on again does not throw the caps away, and a workspace
 * that never had one takes the defaults for the caps nobody named. */
export function agentsFrom(held: WorkspaceAgents | undefined, patch: Partial<WorkspaceAgents>): WorkspaceAgents {
  return { ...(held ?? (patch.spawn === true ? AGENTS_ON : AGENTS_OFF)), ...patch };
}

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
  /** The projects on the machine, oldest import first; absent reads as none, through workspaceProjects. */
  projects: z.array(WorkspaceProject).optional(),
  /** The folder a thread or a command starts in when no project does, the last branch of the runtime's default folder
   * rule: the kind's own (the work folder on this computer). Absent where the kind names none and the machine's own
   * home is where the shell lands (a fork, a machine over ssh). Published so a client shows what the runtime will do. */
  folder: z.string().optional(),
  /** The machine's own home, where its shell shortens paths to `~`: /root on a fork, the person's home on this
   * computer, the login's on a machine over ssh once it has answered. Absent where the kind has not read one. */
  home: z.string().optional(),
  /** Claude session id of the last session, so the next send can --resume it. */
  claudeSessionId: z.string().optional(),
  /** Present when the machine streams a display (desktop kind); sandbox machines are headless. */
  screen: z.object({ streamUrl: z.string() }).optional(),
  /** With phase gone: the provider's words when it stopped knowing the machine; every refusal quotes them. */
  gone: z.string().optional(),
  /** The theme a person gave this workspace; absent is none, and the sidebar keeps its own surface. */
  theme: WorkspaceTheme.optional(),
  /** The glyph a person picked for this workspace; absent is none, and the state dot stands alone. */
  glyph: WorkspaceGlyph.optional(),
  /** One line for the machine's row while the runtime is doing something to the machine's daemon, or why the last
   * attempt failed; absent whenever there is nothing to say. Not persisted: it says what this process is doing. */
  daemonNote: z.string().optional(),
  /** When the last nap stored a vault of this machine's files, ISO; absent where no nap ever stored one. What a
   * rebuild would restore, so it is what says how old the restored files would be. */
  vaultedAt: z.string().optional(),
  /** Why the last nap could not store a fresh vault, in the words that name the export's size and the cap; absent
   * once a nap stores one. Persisted, unlike the nap's own status line: the files stay unbacked until the next nap
   * stores one, so every row keeps saying it rather than the person having to have seen the nap. */
  vaultRefused: z.string().optional(),
  /** What this machine answered when the daemon was last offered to it and it refused: which machine said so, when
   * it said it, and the sentence naming what it has not got. Persisted, unlike the daemon note: a compiler is a
   * person's to install on their own machine, so the row keeps saying it rather than the person having to have
   * been watching the one host start that tried. The stamp is what leaves such a machine alone between attempts;
   * cleared by a deploy that gets past the machine's own checks. */
  daemonRefusedAt: z.object({ machineId: z.string(), at: z.string(), why: z.string() }).optional(),
  /** Why the last wake gave up: the host asked the provider for half an hour and the machine never came back, in the
   * words that also name the rebuild road. Persisted, unlike the wake's own status line, since the machine stays
   * unreachable until something replaces it; cleared by a wake that lands and by the rebuild. */
  wakeRefused: z.string().optional(),
  /** What the agents on this workspace may ask of this host; absent is off, which every workspace reads as until a
   * person turns it on. */
  agents: WorkspaceAgents.optional(),
  /** The thread that forked this workspace, and the thread at the top of that thread's tree; absent on every
   * workspace a person made. The root is what the machine cap counts against. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The place a fork lives on, by id; absent on a fork at the host's own provider and on every workspace that is
   * not a fork. The command line and the app show its name after the workspace's. */
  place: z.string().optional(),
  /** Which provider this workspace's machine was forked at, by the id that provider's own module carries in a
   * registry (`solari`, `box`, `docker`): the host's own where it forked the machine, and the joined computer's
   * own offer where `place` names one, so the two fields cannot disagree about where a machine lives. The runtime
   * stamps it; absent on every kind wsp does not fork, whose machine is the person's own, and on a place this host
   * has not yet heard what it forks with. A row names this where it would otherwise have only the provider's
   * opaque id for the machine. */
  provider: z.string().optional(),
});
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/** What a machine that already existed before wsp says about itself, read off the machine at every status poll: the
 * operating system as its maker names it with its version, how long it has been up, and the folder its commands
 * start in. A fork wsp made carries none; its image and size say what it is. */
export const MachineFacts = z.object({ os: z.string(), uptimeMs: z.number(), folder: z.string() });
export type MachineFacts = z.infer<typeof MachineFacts>;

/** WorkspaceView enriched with what the rail and meta panel render live. */
export const WorkspaceStatus = WorkspaceView.extend({
  machineState: MachineState,
  reach: ReachStatus,
  size: WorkspaceSize,
  /** Awake burn rate for this size; 0 never appears here (napping costs ride the cost event). */
  rateUsdPerHour: z.number(),
  facts: MachineFacts.optional(),
  /** Why the runtime pushed this status outside the poll: a wake that had to retry or replace the machine, or "idle 20 min". */
  reason: z.string().optional(),
  /** Which ask a wake the provider has not taken is on, of the ones the host will make; absent unless the host is
   * asking again on its own. The numbers ride, never a sentence: the row and the Machine tab read the same
   * `wakeAskingAgainLine` at different lengths, and a line built here would fit one of them and be cut in the other. */
  wakeAsk: z.object({ ask: z.number(), of: z.number() }).optional(),
  /** Epoch ms when the runtime's idle policy naps this workspace; absent while napping, held by a running session, or with auto-nap off. */
  idleAt: z.number().optional(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

/** Every field of a workspace's view that a door outside the app's own status socket hands over: the record's own
 * facts, and nothing the provider minted. Picked rather than omitted, so a route added to the view later is not
 * handed over by having been forgotten, which is how the display stream rode these doors until now. */
const WORKSPACE_OUT = {
  id: true, name: true, machineId: true, phase: true, kind: true, golden: true, createdAt: true, projects: true, folder: true, home: true,
  claudeSessionId: true, gone: true, theme: true, glyph: true, daemonNote: true, daemonRefusedAt: true, vaultedAt: true, vaultRefused: true, wakeRefused: true,
  agents: true, parentThreadId: true, rootThreadId: true, place: true, provider: true,
} as const;

/** A workspace as every verb answers with it: the view without the display stream a desktop machine carries, which
 * is the provider's own route with its own bearer on it. A relayed caller drives every cloud record and an agent's
 * transcript leaves the computer, so no door but the app's status socket hands one over. */
export const WorkspaceOut = WorkspaceView.pick(WORKSPACE_OUT);
export type WorkspaceOut = z.infer<typeof WorkspaceOut>;

/** A workspace as the command line and the MCP tool list it: the same fields with what the rail reads live beside
 * them, and the reach without the route it carries, since a table needs the state word and nothing that opens a
 * machine. Parsing a status through it is what drops the routes; the app's own socket still gets both. */
export const WorkspaceListing = WorkspaceStatus.pick({ ...WORKSPACE_OUT, machineState: true, size: true, rateUsdPerHour: true, reason: true, idleAt: true, facts: true }).extend({ reach: ReachView });
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

/** What moving a workspace onto a newer image came to: the workspace as it now stands, whether a machine was
 * actually replaced, and which of the files the image's own recipe writes into home this workspace had changed, so
 * its copies travelled instead of the new image's. `moved` is false for a workspace already on the newest version,
 * which is answered untouched and whose empty `kept` means nothing was judged rather than nothing was changed.
 * `fallback` is the image it stood on listing no files of its own, which is every image sealed before they were
 * recorded: nothing was left to the new image and the whole home came across. */
export const UpgradeResult = z.object({ workspace: WorkspaceView, moved: z.boolean(), kept: z.array(z.string()), fallback: z.boolean().optional() });
export type UpgradeResult = z.infer<typeof UpgradeResult>;

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

/** What the agent refused a turn for, where it named a cause wsp knows: the word every door reads to class the
 * failure, since the sentence is the agent's and no door may read a reason out of its words. Adding a cause is an
 * entry here and its road on the client that shows one. */
export const TurnRefusal = z.enum(["sign-in"]);
export type TurnRefusal = z.infer<typeof TurnRefusal>;

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
  /** The thread that opened this row's thread, when an agent inside another thread did; absent on every thread a
   * person or the command line opened. rootThreadId is the top of that tree, which the machine cap counts against;
   * a row carrying a parent always carries one. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
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
  /** What the agent refused this turn for, where it named a cause wsp knows, off the turn's own result: a refused
   * turn did none of the work it was asked for, so a row carrying this is a turn that ran nothing. Absent on every
   * turn the agent worked on, however it ended. */
  refusal: TurnRefusal.optional(),
  /** What the turns that ran on this row have cost together, as each result reported it; absent where no turn of it
   * has ended and on a harness that reports no figure, which is not the same as nothing spent. It rides the row so
   * a listing can say what a thread spent without anyone reading its transcript. */
  costUsd: z.number().optional(),
  /** What the session runs with, as the harness's own slugs: the start request's model until the harness announces
   * its own; effort as requested, since the CLI never echoes it, and the permission mode the turn is at, which is
   * the start's until a pick moves a running turn to another one. */
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionMode: z.string().optional(),
  contextWindow: z.string().optional(),
  /** The lead of the permission prompt this turn has open and nobody has answered, as askingLine writes it;
   * absent on a turn waiting on nobody. The harness is stopped on the question while it stands, so this is the one
   * fact that says a thread is waiting on the person rather than working. */
  asking: z.string().optional(),
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
  /** Whether any turn of this thread ever did work, as threadRan reads the rows: false is a launch that never got
   * going, the thread a forget removes. */
  ran: z.boolean(),
  /** The opening turn's parent and root, so a listing draws the tree a root thread spawned without reading rows. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The latest turn's open permission prompt, as SessionView.asking carries it; what threadState reads. */
  asking: z.string().optional(),
  /** What this thread has cost: its rows' figures added up. Absent where no row of it carries one. */
  costUsd: z.number().optional(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** The thread a turn's row belongs to: the runtime's thread id, else the row's own, since a row the runtime stamped
 * no thread on is a thread of one turn. The one rule for grouping rows by thread. */
export const threadKeyOf = (session: SessionView): string => session.threadId ?? session.id;

/** Whether a turn of these rows ever did any work: one is still working, or one announced a harness session and
 * ended for something other than a refusal. Announcing is not enough on its own, since both CLIs announce their
 * session before they learn they have no sign-in, and a refused turn did none of the work it was asked for. A
 * thread with no such turn never got going, so nothing of it was written down anywhere and dropping it loses none. */
export function threadRan(turns: ReadonlyArray<Pick<SessionView, "claudeSessionId" | "status" | "refusal">>): boolean {
  return turns.some(turn => turn.status === "running" || (turn.claudeSessionId !== undefined && turn.refusal === undefined));
}

/** Folds the session index into threads, in the order each thread's first turn appears. The one place a row from
 * before provenance was recorded is read as a person's; clients print the answer and never decide it. */
export function foldThreads(sessions: ReadonlyArray<SessionView>): ThreadView[] {
  const byThread = new Map<string, SessionView[]>();
  for (const session of sessions) {
    const key = threadKeyOf(session);
    const turns = byThread.get(key);
    if (turns === undefined) byThread.set(key, [session]);
    else turns.push(session);
  }
  return [...byThread].map(([id, turns]) => {
    const first = turns[0]!;
    const latest = turns[turns.length - 1]!;
    const spent = threadCost(turns);
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
      ...(latest.asking !== undefined ? { asking: latest.asking } : {}),
      turns: turns.length,
      ran: threadRan(turns),
      ...(first.parentThreadId !== undefined ? { parentThreadId: first.parentThreadId } : {}),
      ...(first.rootThreadId !== undefined ? { rootThreadId: first.rootThreadId } : {}),
      ...(spent !== undefined ? { costUsd: spent } : {}),
    };
  });
}

/** What a thread has cost: the figures its rows carry, added up; undefined where not one of them reported a
 * figure, which no reader may take for nothing spent. */
function threadCost(turns: ReadonlyArray<Pick<SessionView, "costUsd">>): number | undefined {
  const said = turns.filter(turn => turn.costUsd !== undefined);
  return said.length === 0 ? undefined : said.reduce((sum, turn) => sum + turn.costUsd!, 0);
}

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

/** An MCP server as every agent's config names it and as a launch may carry it: the program and its arguments, run
 * over stdio. The catalog's config writers, the adapters that hand a server to a turn and the install that writes
 * one into a config file all read this shape, and none of them may import another, so it lives here. */
export interface McpServerSpec {
  command: string;
  args: readonly string[];
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

/** The catalog a kept machine's composer shows and its starts are checked against: the same lists, with the default
 * mark moved from what a throwaway machine runs to keptMode, and the row's own bypassMode named after the machine it
 * is about to touch, so the pick that skips the prompts says whose computer it skips them on. One pick away, in the
 * same list, in the same order. The CLI's own word for the mode stays as the row's short form, which is what the
 * picker's button says once it is picked: the long name is read in the menu and in every line about the pick, and a
 * button that carried it crushed the model's name beside it in a narrow window (measured 2026-09-09, 316 px of row at
 * a 1200 px viewport with the right panel open). A catalog with no keptMode (a CLI that takes no access mode) comes
 * back as it went in. `machine` is the machine in words, the one phrase every local surface uses.
 */
export function keptAccess(catalog: HarnessCatalog, machine: string): HarnessCatalog {
  if (catalog.keptMode === undefined) return catalog;
  const permissionModes = catalog.permissionModes.map(({ isDefault: _throwaway, ...mode }) => ({
    ...mode,
    ...(mode.value === catalog.keptMode ? { isDefault: true } : {}),
    ...(mode.value === catalog.bypassMode ? { label: `${mode.label} on ${machine}`, short: mode.label } : {}),
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

/** Whether wsp can hand this harness's launch an MCP server. Unlike the three above, a table row is the answer and
 * not a stand-in: this is decided by the adapter in this host and by no binary, so a caller may read it before any
 * machine exists. Absent is a no, which is a catalog from before the field was declared. */
export function takesMcpServers(catalog: Pick<HarnessCatalog, "mcpServers"> | null | undefined): boolean {
  return catalog?.mcpServers === true;
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
  /** Set only on a turn the agent refused outright for a cause wsp knows; the status is failed with it. */
  refusal: TurnRefusal.optional(),
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

/** The word a start's notify carries to mean the caller: the thread the request came out of when it came out of one,
 * and otherwise the person who ran it. */
export const NOTIFY_ME = "me";

/** The host a turn on a machine drives, off its own environment: the address the launch put there and the token
 * beside it. Nothing unless both are there, since an address with no token opens nothing and a token with no
 * address names no host. The pair goes ahead of every host a computer holds on its own, under only what a line
 * names: it is the identity the launch handed the turn, and the machine's own state file is a path nothing serves. */
export function hostFromEnv(env: Readonly<Record<string, string | undefined>>): { url: string; token: string } | undefined {
  const url = env[HOST_URL_ENV]?.trim();
  const token = env[HOST_TOKEN_ENV]?.trim();
  return url === undefined || url === "" || token === undefined || token === "" ? undefined : { url, token };
}

/** Where a machine's daemon bundle is unpacked, and the wsp command that rides in it: one file, the whole bundled
 * command, so a turn on any machine with a daemon can drive this host with no install of its own. Named here
 * because the host stages the file and the runtime builds the launch that runs it, and neither may import the
 * other's rule. */
export const GUEST_DAEMON_DIR = "/root/wsp-daemon";
/** The name the wsp MCP server has in every agent's config and in every launch that carries it, so an agent's
 * config on this computer and the launch a turn on a machine gets name one server and not two. */
export const MCP_SERVER_NAME = "wsp";
/** The command sits in the bundle as npm lays the published package out, its package.json beside a dist folder,
 * because the bin reads its own version through that file (`../package.json` from the bin) and announces it in
 * every MCP handshake; a client refuses a server that names none. */
export const wspBinIn = (dir: string): string => `${dir}/wsp/dist/bin.js`;
export const GUEST_WSP_BIN = wspBinIn(GUEST_DAEMON_DIR);

/** The token a client puts on its requests, off its own environment; nothing when it is not running inside a turn. */
export function turnTokenOf(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = env[TURN_TOKEN_ENV];
  return token === undefined || token === "" ? undefined : token;
}

/** The turn ended and its one line (notifyLine) went where the thread's start said: into the named thread as a send
 * would go, steered or queued, or, for me, to the person, whom the CLI and the app tell from this event. One row per
 * target, so a start that named two threads is two rows. Recorded in the ending thread's transcript, before its
 * session.done, so the line's source is visible and a follower that ends on the done still sees it. */
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

/** How a permission prompt ended. allowed and denied are a person's pick. cancelled is the prompt going with its
 * turn: a stop, or a harness that withdrew the question. unanswered is only ever read back off a transcript written
 * while wsp still denied a prompt on a clock of its own; nothing closes one that way now. */
export const PermissionOutcome = z.enum(["allowed", "denied", "unanswered", "cancelled"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcome>;

/** One permission prompt the harness raised, relayed into the chat as its own row: the tool it wants to run, what it
 * wants to run it on, and the options the person may pick. The prompt blocks the turn until sessions.answer names an
 * option or the turn itself ends, so the row is what the thread is waiting on for as long as the turn lives. */
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

/** Whether one event off the bus is a session's, narrowed: the one test every reader that folds a thread's events
 * out of the whole channel makes, so none of them keeps a list or a cast of its own. */
export const isSessionEvent = (e: { type: string }): e is SessionEvent => SESSION_EVENT_TYPES.has(e.type as SessionEvent["type"]);

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
/** A person set the workspace's theme or its glyph: the record alone changed, and both facts travel whole so a
 * client never has to merge one key into what it holds. null on either is none picked. */
export const WorkspaceLookEvent = z.object({
  type: z.literal("workspace.look"),
  workspaceId: z.string(),
  theme: WorkspaceTheme.nullable(),
  glyph: WorkspaceGlyph.nullable(),
});
/** A person changed what the agents on a workspace may ask of this host. The whole switch travels, so a client
 * never merges one key into what it holds; nothing about the machine changed. */
export const WorkspaceAgentsEvent = z.object({ type: z.literal("workspace.agents"), workspaceId: z.string(), agents: WorkspaceAgents });
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

/** The last target: the workspace a thread was last started on, and the project when it landed in one. */
export const PreferencesTarget = z.object({ workspace: z.string(), project: z.string().optional() });
export type PreferencesTarget = z.infer<typeof PreferencesTarget>;

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
  /** The project a thread was last started in, by workspace id and project name: the second branch of the default
   * folder rule (projectFor), written by the runtime on every start that lands in one of the workspace's projects
   * and by the composer when its pick changes, so the next thread on that workspace opens where the last one did
   * whichever client or CLI opens it. A name the workspace no longer holds drops through, as a stale access does. */
  project: z.record(z.string(), z.string()),
  /** The workspace and, when it landed in one, the project a thread was last started on anywhere: where a new
   * thread asked for from nowhere goes. Absent until the first start. */
  target: PreferencesTarget.optional(),
  /** Whether the surfaces still being worked on are offered at all. The host stamps it from its own environment at
   * every read, so no client sets it and nothing a state file holds can turn it on. */
  labs: z.boolean(),
});
export type Preferences = z.infer<typeof Preferences>;

/** Whether labs is on in an environment: LABS_ENV set to exactly 1, and nothing else counts. */
export const labsFromEnv = (env: Record<string, string | undefined>): boolean => env[LABS_ENV] === "1";

/** What preferences.set takes: any of the record's fields but labs, which is the host's to say; a null sidebarWidth
 * clears it back to the default, terminalZoom, access and project name only the workspaces they move, a null entry
 * dropping that workspace's zoom or pick, and a null target clears the last target. */
export const PreferencesPatch = Preferences.omit({ labs: true }).partial().extend({
  sidebarWidth: z.number().int().positive().nullable().optional(),
  terminalZoom: z.record(z.string(), z.number().int().nullable()).optional(),
  access: z.record(z.string(), z.string().nullable()).optional(),
  project: z.record(z.string(), z.string().nullable()).optional(),
  target: PreferencesTarget.nullable().optional(),
});
export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

export const DEFAULT_PREFERENCES: Preferences = { theme: "system", sidebarMode: "list", terminalSize: "app", terminalZoom: {}, access: {}, project: {}, labs: false };

/** The record as stored, over the defaults; a record that does not parse (an older or a hand-edited state file) reads as the defaults. */
export function preferencesFrom(stored: unknown): Preferences {
  const parsed = Preferences.partial().safeParse(stored ?? {});
  return parsed.success ? applyPreferencesPatch(DEFAULT_PREFERENCES, parsed.data) : DEFAULT_PREFERENCES;
}

/** The record with the patch's fields over it. The one merge rule, read by the host that keeps the record and the client
 * that paints ahead of the host's answer, so both land on the same record. */
export function applyPreferencesPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const sidebarWidth = patch.sidebarWidth === undefined ? current.sidebarWidth : patch.sidebarWidth;
  const perWorkspace = <T,>(kept: Record<string, T>, moved: Record<string, T | null> | undefined): Record<string, T> => {
    const next = { ...kept };
    for (const [workspaceId, value] of Object.entries(moved ?? {})) {
      if (value === null) delete next[workspaceId];
      else next[workspaceId] = value;
    }
    return next;
  };
  const target = patch.target === undefined ? current.target : patch.target;
  return {
    theme: patch.theme ?? current.theme,
    sidebarMode: patch.sidebarMode ?? current.sidebarMode,
    terminalSize: patch.terminalSize ?? current.terminalSize,
    terminalZoom: perWorkspace(current.terminalZoom, patch.terminalZoom),
    access: perWorkspace(current.access, patch.access),
    project: perWorkspace(current.project, patch.project),
    labs: current.labs,
    ...(sidebarWidth === null || sidebarWidth === undefined ? {} : { sidebarWidth }),
    ...(target === null || target === undefined ? {} : { target }),
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
  /** The host's own token, inlined only when the page was served on loopback, where reaching it already means being
   * on the computer. A page served beyond loopback carries none and pairs for a device token of its own. */
  token?: string;
  /** The path on this page's own origin the runtime WebSocket answers on, which is the one road a client reaching
   * the host through an ssh forward or a tunnel hostname has. */
  wsPath: string;
  /** False when this page carries no token and has to redeem a pairing code before it can dial anything. */
  paired: boolean;
  /** The release this host is, which is the release this page is: a desktop shell attached to a host it did not
   * start reads it to tell whether the two halves were built apart. */
  version: string;
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
  /** What a row that can run says on hover, where the label leaves something out a person would want before pressing
   * it. The two are one slot, read refusal first: a row is either dimmed with a reason or live with a word about
   * what it does, never both, which is the reading every button in the app already makes. */
  hint?: string;
  shortcut?: string;
  accelerator?: string;
  destructive?: boolean;
  /** A row that marks a state, drawn with a check when true; a row with no mark at all leaves this out. */
  checked?: boolean;
}

// --- hosts the desktop window can move between --------------------------------

/** How this computer reached a host somewhere else: by an address it pairs with, or by an ssh login it forwards. */
export type HostRoad = "direct" | "ssh";

/** One saved host as the desktop lists it: never the token. The label is what the person reads in the menu and the
 * sidebar's foot; the alias is what wsp's command line names the same record by. */
export interface HostListing {
  alias: string;
  label: string;
  url: string;
  road: HostRoad;
}

/** The hosts as the window shows them: the word for the app's own computer, which host the window is on (null for
 * that computer), and every saved host. */
export interface HostsView {
  here: string;
  current: string | null;
  hosts: HostListing[];
  /** What this computer is to another wsp, when it joined one: the menu grows the two rows for it. */
  place?: { hostName: string; awake: boolean };
}

/** What the connect sheet asks the shell for: an address with the code wsp pair printed there, or an ssh login the
 * shell starts or finds a host behind and forwards. */
export type HostConnectAsk = { road: "direct"; url: string; code: string } | { road: "ssh"; address: string; port?: number };

/** How a host move or connect ended: done, or refused in the host's own words with the field the words are about, so
 * the sheet can put them under it. */
export type HostOutcome = { ok: true } | { ok: false; error: string; at: "url" | "code" | "address" };

/** What the join screen sends the shell: the address as it is typed on the other screen, and the code beside it. */
export const JoinAsk = z.object({ address: z.string().max(200), code: z.string().max(64) });
export type JoinAsk = z.infer<typeof JoinAsk>;

/** What this computer is to another wsp, read off its place file. */
export interface PlaceStanding {
  hostName: string;
  hostUrl: string;
  alias: string;
  joinedAt: string;
  awake: boolean;
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
  /** The release this shell is, so a page served by a host of another one can say which half is behind. Absent on
   * a shell from before the bridge carried it, which is older than any page that reads this. */
  readonly version?: string;
  /** The installed faces for a family and its Nerd Font variants, from this computer's font directories. */
  localFonts(family: string): Promise<LocalFontFace[]>;
  /** The system folder picker; the absolute path chosen, or nothing when it was dismissed. */
  pickFolder(): Promise<string | undefined>;
  /** The absolute path of a file or folder dropped on the window from the desktop, which the page itself cannot read. */
  droppedPath(file: File): string;
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
  /** A build waits on the person: the shell shows a system notification while its window has no focus, and nothing
   * while it has, since the page already says it. The page decides nothing about focus; the shell owns that. */
  needsYou(need: InitNeedsYou): void;
  /** A click on that notification, after the shell has raised its window: the page opens the build screen. Returns
   * the unsubscribe. */
  onNeedsYouOpen(handler: () => void): () => void;
  /** The device token the shell holds for the host that served this page, when the window is on a host somewhere
   * else; nothing on the app's own host, whose page carries its own token. The token never rides in the page. */
  hostToken(): Promise<string | undefined>;
  /** The saved hosts and which one the window is on. */
  hosts(): Promise<HostsView>;
  /** Puts the window on a saved host, or on the app's own computer for null. */
  switchHost(alias: string | null): Promise<HostOutcome>;
  /** Pairs with a host by one of the two roads and puts the window on it. */
  connectHost(ask: HostConnectAsk): Promise<HostOutcome>;
  /** Hands the host's token back and forgets the host; the window returns to the app's own computer if it was there. */
  disconnectHost(alias: string): Promise<HostOutcome>;
  /** The shell's own menu asked for the connect sheet. Returns the unsubscribe. */
  onConnectHostOpen(handler: () => void): () => void;
  // What this computer is to the wsp it joined, and the two things its window does about it. All three are absent
  // on a shell from before the bridge carried them, as `version` is: the page and the shell are two halves that ship
  // together and can be two releases apart, so a page that would use one reads for it first. The join itself is not
  // among them: it is asked for on the first launch's own page, whose bridge is that page's and not this one.
  /** What this computer is to another wsp, or nothing when it belongs to none. */
  place?(): Promise<PlaceStanding | undefined>;
  /** Takes this computer back out of that wsp and returns the window to its own. */
  leaveWsp?(): Promise<HostOutcome>;
  /** Holds this computer out of idle sleep while it is joined, or lets it go; answers the standing as it now is. */
  setStayAwake?(on: boolean): Promise<PlaceStanding>;
}

// --- golden image (manifest, interactive builder, build stages) ---------------

export const MachineKind = z.enum(["sandbox", "desktop"]);
export type MachineKind = z.infer<typeof MachineKind>;

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

/** One file the recipe wrote into the image's home: where it sits under the guest home and the sha256 of the bytes
 * the builder had when the version sealed. The upgrade reads it to tell a file a fork never touched, whose new copy
 * comes with the new image, from one the fork changed, which travels. */
export const RecipeOwnedFile = z.object({
  path: z.string(),
  sha256: z.string(),
  /** The recipe marks this row volatile: a tool rewrites it as it runs, or the machine renders it. Its bytes differ
   * on any fork that has run anything, so an upgrade carries the fork's copy and never names it as a person's edit. */
  volatile: z.boolean().optional(),
});
export type RecipeOwnedFile = z.infer<typeof RecipeOwnedFile>;

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
  /** Every file this version's recipe wrote into the guest home, hashed on the builder at seal. Absent on a version
   * sealed before the manifest existed and on one built from no recipe; a fork of such a version upgrades under the
   * old rule, its whole home landing over the new image. */
  owned: z.array(RecipeOwnedFile).optional(),
  /** The builder's disk in use when the snapshot was taken, bytes; absent on versions sealed before it was recorded. */
  usedBytes: z.number().int().nonnegative().optional(),
  /** The image record's hash this copy of the version was built at; absent on a version sealed before records
   * existed, which no record matches. A manifest is one place's copies, so this is the copy's hash. */
  imageHash: z.string().length(64).optional(),
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
  /** The machines this stage made and could not remove, because the provider could not be reached: they bill until
   * something takes them, so a client that can retry the kill retries it rather than reading the stage as over. */
  left: z.array(z.string()).optional(),
  /** The place a copy is being built at, when the stage is a copy's and not the wired provider's. */
  place: z.string().optional(),
});
export type GoldenStageEvent = z.infer<typeof GoldenStageEvent>;
// --- the image: the record the host owns, its vault and the copies built from it ---

/** What the sign-in stages left on the builder, archived at the seal: never the bytes on the wire, only their hash
 * and size. */
export const SealedVault = z.object({
  sha256: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  /** How many guest paths the archive names; zero means the seal had nothing to hold and the copy will ask for sign-ins again. */
  paths: z.number().int().nonnegative(),
  takenAt: z.string(),
});
export type SealedVault = z.infer<typeof SealedVault>;

/** The image the host owns: what every copy is built from. One per golden name. */
export const SealedImage = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  /** sha256 over the recipe hash and the vault's sha256; two copies with this hash were built from the same thing. */
  hash: z.string().length(64),
  recipeHash: z.string(),
  /** The small recipe as it stood at the seal, so a later edit of recipe.json changes no copy until the next
   * version. Absent on a record backfilled from a golden sealed before records existed, and on one sealed by a
   * road that carried no small recipe: a copy of such a record is refused, since there is nothing to build from. */
  recipe: Recipe.optional(),
  logins: z.array(GoldenLogin),
  sealedAt: z.string(),
  /** This computer's name at the seal, for the screen's "sealed from". */
  sealedFrom: z.string(),
  /** Absent on a record backfilled from a golden sealed before vaults existed: its copies ask for sign-ins again. */
  vault: SealedVault.optional(),
  /** The builder's disk in use at the snapshot, in bytes; absent on a version sealed before it was read. */
  usedBytes: z.number().int().nonnegative().optional(),
});
export type SealedImage = z.infer<typeof SealedImage>;

/** One place's built copy of one version: the provider's artifact and when it was made. */
export const SealedImageCopy = z.object({
  place: z.string(),
  /** The version this place's own manifest gave the copy. Each place numbers its own, so a second place's first
   * copy is its v1 whatever version of the record it was built from; the hash is what says which record that was. */
  version: z.number().int().positive(),
  /** The record's hash when this copy was built; absent on a copy sealed before hashes, which no record matches. */
  hash: z.string().length(64).optional(),
  snapshotId: z.string(),
  templateId: z.string().optional(),
  builtAt: z.string(),
  /** From the provider's snapshot listing where it has one; absent elsewhere, never guessed. */
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type SealedImageCopy = z.infer<typeof SealedImageCopy>;

/** What a build at a place came to: the copy that place holds now, and whether this call built it. A place already
 * standing on the record is answered with its copy and `built: false` rather than refused, so the road that builds
 * a copy on first use and a person typing the line twice both get the copy they asked for. */
export const SealedImageBuilt = z.object({ copy: SealedImageCopy, built: z.boolean() });
export type SealedImageBuilt = z.infer<typeof SealedImageBuilt>;

/** What an export wrote on this computer. */
export const SealedImageExport = z.object({ path: z.string(), bytes: z.number().int().nonnegative(), hash: z.string().length(64) });
export type SealedImageExport = z.infer<typeof SealedImageExport>;

/** The shortest passphrase an export is sealed to; a shorter one is refused before anything is read. */
export const IMAGE_PASSPHRASE_MIN = 12;

/** A sealed vault's header, one line of JSON a reader parses before anything else: it says how the bytes behind it
 * are keyed and carries the record in the plain, so an import can show what a file holds before asking for the
 * passphrase. The header's own bytes are the cipher's additional data, so an edited header fails to open. */
export const SealedVaultHeader = z.object({
  format: z.literal("wsp-vault-1"),
  cipher: z.literal("aes-256-gcm"),
  to: z.enum(["passphrase", "key"]),
  /** scrypt salt (passphrase) or HKDF salt (key), base64. */
  salt: z.string(),
  nonce: z.string(),
  /** The sender's ephemeral X25519 public key, base64, on `to: "key"` only. */
  ephemeral: z.string().optional(),
  image: SealedImage,
});
export type SealedVaultHeader = z.infer<typeof SealedVaultHeader>;

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

/** What a computer joining this host passes through when the host installs the agent on it over ssh, in order.
 * One list for the line a terminal prints and the rows the app draws, so neither invents a step the other has not
 * got. */
export const PlaceAddStep = z.enum(["connect", "wsp", "service", "join"]);
export type PlaceAddStep = z.infer<typeof PlaceAddStep>;

/** What each step reads as while it runs. The note beside it carries what the computer answered (its system, the
 * node it got), which is the step's own to say and never a second sentence about it. */
export const PLACE_ADD_WORDS: Record<PlaceAddStep, string> = {
  connect: "connecting over ssh",
  wsp: "installing wsp",
  service: "starting the agent",
  join: "waiting for it to connect to this computer",
};

/** Where the app's sheet says a step differently from the line a terminal prints. The sheet's road is a Linux box
 * and its own description names this Mac; the same install from a terminal reaches a Mac too, on a host that need
 * not be one, so the words above stay as they are. `done` is read once a step is finished, where a line under a
 * check would otherwise say the wait it was in rather than the state it reached. */
export const PLACE_ADD_SHEET_WORDS: Partial<Record<PlaceAddStep, { word: string; done?: string }>> = {
  service: { word: "starting the agent under systemd" },
  join: { word: "waiting for it to connect to this Mac", done: "connected to this Mac" },
};

/** The word the app's sheet draws for a step in the state it is in. */
export function placeAddSheetWord(step: PlaceAddStep, state: "running" | "done"): string {
  const said = PLACE_ADD_SHEET_WORDS[step];
  return (state === "done" ? said?.done : undefined) ?? said?.word ?? PLACE_ADD_WORDS[step];
}

/** How far the install on one computer has got, keyed by the id the request was answered with, so two installs at
 * once are two lists. A step that is running is the one with a spinner; one that is done carries its note. */
export const PlaceStageEvent = z.object({
  type: z.literal("place.stage"),
  addId: z.string(),
  step: PlaceAddStep,
  state: z.enum(["running", "done", "failed"]),
  note: z.string().optional(),
});
export type PlaceStageEvent = z.infer<typeof PlaceStageEvent>;

export const PlaceKind = z.enum(["computer", "provider"]);
export type PlaceKind = z.infer<typeof PlaceKind>;

/** One row of wsp places: a computer of the person's own, this computer itself, or the provider this host forks on. */
export const PlaceView = z.object({
  id: z.string(),
  kind: PlaceKind,
  name: z.string(),
  default: z.boolean(),
  /** A computer: what it reported last. */
  os: z.string().optional(),
  shape: WorkspaceSize.optional(),
  diskFreeBytes: z.number().int().optional(),
  docker: z.boolean().optional(),
  present: z.boolean().optional(),
  joinedAt: z.string().optional(),
  lastSeenAt: z.string().optional(),
  daemonVersion: z.number().int().optional(),
  /** The catalog ids of the agents that computer found on itself, as it last reported them. */
  agents: z.array(z.string()).optional(),
  /** The workspace recorded on this computer, when the join could record one. */
  workspaceId: z.string().optional(),
  /** A provider: its hourly rate for the default size. */
  rateUsdPerHour: z.number().optional(),
  /** How many forks the place holds and how many more it takes, by forkRoom; absent on a place that forks nowhere. */
  forks: z.object({ running: z.number().int(), room: z.number().int() }).optional(),
});
export type PlaceView = z.infer<typeof PlaceView>;

/** The id the computer the host runs on carries in that list. It is a place like every other, and the one nothing
 * was installed on, so both sides of the wire read the same word for it. */
export const HERE_PLACE_ID = "here";

/** The one written form of a workspace's machine on a joined computer: the id names the place the link belongs to
 * and nothing else. Written here rather than in the backend that mints it because every client reads it back to
 * say which computer a workspace stands on. */
export const placeMachineId = (placeId: string): string => `place:${placeId}`;

/** The place an id names, or nothing when the id is not one of ours: a record from another backend. */
export function parsePlaceMachineId(id: string): string | undefined {
  const placeId = id.startsWith("place:") ? id.slice("place:".length) : "";
  return placeId === "" ? undefined : placeId;
}

/** A computer you own finished its join, with the address it dialled from as `ws` reported it. The view carries
 * what it said about itself, so the sheet fills its row off this one event. */
export const PlaceJoinedEvent = z.object({ type: z.literal("place.joined"), place: PlaceView, from: z.string() });
export const PlacePresentEvent = z.object({ type: z.literal("place.present"), placeId: z.string(), from: z.string() });
export const PlaceAbsentEvent = z.object({ type: z.literal("place.absent"), placeId: z.string() });
export const PlaceRemovedEvent = z.object({ type: z.literal("place.removed"), placeId: z.string() });
/** The four as one type, so the host's door and the app's fold read one shape. */
export type PlaceEvent = z.infer<typeof PlaceJoinedEvent> | z.infer<typeof PlacePresentEvent> | z.infer<typeof PlaceAbsentEvent> | z.infer<typeof PlaceRemovedEvent>;

export const EventUnion = z.discriminatedUnion("type", [
  WorkspaceCreatingEvent.extend(sequenced),
  WorkspaceCreatedEvent.extend(sequenced),
  WorkspaceNappedEvent.extend(sequenced),
  WorkspaceWokenEvent.extend(sequenced),
  WorkspaceUpgradedEvent.extend(sequenced),
  WorkspaceRenamedEvent.extend(sequenced),
  WorkspaceLookEvent.extend(sequenced),
  WorkspaceAgentsEvent.extend(sequenced),
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
  InitJobEvent.extend(sequenced),
  InitNeedsYouEvent.extend(sequenced),
  PlaceStageEvent.extend(sequenced),
  PlaceJoinedEvent.extend(sequenced),
  PlacePresentEvent.extend(sequenced),
  PlaceAbsentEvent.extend(sequenced),
  PlaceRemovedEvent.extend(sequenced),
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

/** Client-side health of a daemon link. opening: a link that has never been open is being dialled, so nothing is
 * coming back yet and nothing may be promised back. connecting: a link that was open once is being dialled again.
 * unanswered: a link that has never been open and whose first-answer bound has passed, so what it dials is not
 * answering and the person is owed what to do instead of a wait. reauth-needed: the daemon refused the token the
 * host sent. A browser link holds no token of its own, so it opens a channel again and the host dials with the one
 * it holds now; the host's own link stops there. refused: the door answered the upgrade with a status, so no retry
 * at the usual pace opens anything; the link holds this until a dial gets past the door, and retries at the ceiling.
 * dead is terminal. The host's own link reports neither opening nor unanswered, as it reports no refusal: no person
 * reads its words. */
export const DaemonLinkStatus = z.enum(["opening", "connecting", "live", "reauth-needed", "refused", "unanswered", "dead"]);
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
  /** Absent where the machine's own processes module cannot count them: this computer reads its processes with ps,
   * which has no thread column on macOS. */
  threads: z.number().int().optional(),
  children: z.array(z.number().int()),
});
export type ProcInspectReply = z.infer<typeof ProcInspectReply>;

/** How much of a command's output one exec op carries back, stdout and stderr together. Past it the reply says
 * truncated and the rest is dropped: the road is a WebSocket frame and a turn that cats a log would otherwise put
 * the machine's whole disk through it. */
export const EXEC_OUTPUT_MAX = 2 * 1024 * 1024;

/** How long an exec frame that named no deadline of its own gets. Every caller on the host's side names one; this
 * is what bounds a frame that did not, so nothing runs without end on a computer somebody owns. */
export const EXEC_TIMEOUT_DEFAULT_MS = 20_000;

/** The exit code a command killed at its deadline answers with, on every road wsp runs one: the shell's own word
 * for it, so a caller reads one number whether the command was launched detached on a guest or run by an exec op
 * on a place. One home, since the two roads' guards are compared against each other in tests. */
export const EXEC_DEADLINE_EXIT = 124;

/** One command on this machine, for a host driving it over a link it did not open: `bash -c`, in the daemon's own
 * root and environment, with the bytes for its stdin where the caller has any. The byte road a daemon token, a
 * roots file and a project part take on a machine whose backend mints no signed URL. */
export const DaemonExecRequest = z.object({
  id: reqId,
  op: z.literal("exec"),
  cmd: z.string().max(EXEC_BODY_MAX),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  /** Bytes for the command's stdin, base64; absent closes stdin at once. */
  stdin: z.string().optional(),
});
export type DaemonExecRequest = z.infer<typeof DaemonExecRequest>;

export const DaemonExecReply = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string(), truncated: z.boolean() });
export type DaemonExecReply = z.infer<typeof DaemonExecReply>;

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
  DaemonExecRequest,
  /** Sweeps wsp off this computer and answers what it took, then the agent exits: the one op whose handler belongs
   * to the link a place opened and not to the daemon's own switch. */
  z.object({ id: reqId, op: z.literal("place.leave") }),
]);
export type DaemonRequest = z.infer<typeof DaemonRequest>;

// --- machines over a place link -------------------------------------------
//
// One computer drives another computer's machines: every call the engine's
// MachineBackend and Machine interfaces carry, as a frame on the link the
// place opened. The data shapes live here rather than in the engine because
// they are the wire and the interface at once, and two copies of a spec would
// drift the day a field is added on one side.

/** What keeps the daemon running on a machine: the guest's own service manager, or the machine's boot itself on a
 * guest that has none (a container, whose PID 1 is the only thing that outlives an exec). */
export const DaemonSupervisor = z.enum(["systemd", "entrypoint"]);
export type DaemonSupervisor = z.infer<typeof DaemonSupervisor>;

export const MachineSpec = z.object({
  kind: MachineKind,
  template: z.string().optional(),
  fromSnapshot: z.string().optional(),
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  /** Root disk in GiB; the provider default applies when absent (Solari: 4, and 20 is its cap). */
  diskGb: z.number().optional(),
  envs: z.record(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  /** What the provider does when the machine sits idle past its window; the provider default (Solari: pause)
   * applies when absent. */
  onIdle: z.enum(["pause", "kill"]).optional(),
  /** Rolling idle window before onIdle fires; the provider default (Solari: 30 min documented) applies when absent. */
  idleTimeoutMs: z.number().optional(),
  /** One per create attempt: the provider answers a repeat of the same request under it with the machine it already
   * booted. Minted fresh after a kill, since a replay names the dead machine (measured 2026-09-04). */
  idempotencyKey: z.string().optional(),
});
export type MachineSpec = z.infer<typeof MachineSpec>;

export const ExecResult = z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });
export type ExecResult = z.infer<typeof ExecResult>;

/** The provider's own view of a machine's size and birth. Solari's resume can rebuild a VM on a fresh host at
 * default size while keeping the id, so a wake compares the size against what was created. createdAt moves to the
 * resume time on every Solari resume (measured), healthy or not: record it, never judge by it. */
export const MachineShape = z.object({
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  /** The root disk the provider granted, in GiB; a dropped or misspelled disk field boots the default and says
   * nothing else. */
  diskGb: z.number().optional(),
  createdAt: z.string().optional(),
});
export type MachineShape = z.infer<typeof MachineShape>;

/** The history the runtime hands a snapshot: whether this machine was ever resumed. The fact is the record's; the
 * rule about it, if the provider has one, is the backend's. */
export const MachineLife = z.object({ firstLife: z.boolean() });
export type MachineLife = z.infer<typeof MachineLife>;

/** The route this host takes to one guest port. On a backend whose capabilities say previewUrls it is a public URL
 * with the provider's token embedded, the token standalone, and its expiry in epoch ms as the provider sets it; on
 * one that says otherwise it is a route only the computer holding the backend can take, with no token and an expiry
 * at the end of the machine's life. */
export const PreviewReach = z.object({ url: z.string(), token: z.string(), expiresAt: z.number() });
export type PreviewReach = z.infer<typeof PreviewReach>;

/** One snapshot as the provider lists it; sizeBytes is what storage is billed on. */
export const SnapshotRow = z.object({
  id: z.string(),
  /** The name the snapshot was taken under, which is where wsp's owner mark rides; absent on a backend whose
   * listing carries none. */
  name: z.string().optional(),
  sizeBytes: z.number(),
  createdAt: z.string().optional(),
  /** The snapshot this one was taken under, as the provider chains them; null at a root. */
  parent: z.string().nullable().optional(),
});
export type SnapshotRow = z.infer<typeof SnapshotRow>;

/** One template as the provider reports it: a promoted snapshot reads ready at once, a built one moves from
 * building to ready or failed, with the provider's reason only on failed. */
export const TemplateRow = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["building", "ready", "failed"]),
  error: z.string().optional(),
  /** When the provider says it was promoted or built; absent on a built-in and on a backend that reports none. It
   * is what gives a template the same grace a snapshot gets before anything may call it an orphan. */
  createdAt: z.string().optional(),
});
export type TemplateRow = z.infer<typeof TemplateRow>;

/** How the provider bills snapshot storage: the free GB shared by every snapshot on the account, the price of each
 * GB-month past them, and the day billing starts. */
export const SnapshotStoragePricing = z.object({ freeGb: z.number(), usdPerGbMonth: z.number(), billedFrom: z.string() });
export type SnapshotStoragePricing = z.infer<typeof SnapshotStoragePricing>;

export const LifecycleBudgets = z.object({
  /** How many times a wake may resume the machine and check it before a fresh fork replaces it. Each attempt after
   * the first is a pause and a resume; a provider that bills starts declares 1. */
  wakeAttempts: z.number().int().min(1),
  /** How long the guest's daemon gets to answer once the machine reads running, after a fork and after a resume
   * alike, before the runtime says it did not. */
  daemonAnswersMs: z.number().positive(),
  /** How the host keeps asking after a resume the provider did not take: once every everyMs of wall time from the
   * first ask, for forMs. Absent, the host asks once and stops. */
  resumeAsks: z.object({ everyMs: z.number(), forMs: z.number() }).optional(),
});
export type LifecycleBudgets = z.infer<typeof LifecycleBudgets>;

/** One machine as a backend lists it; size comes off the listing itself, since a per-machine read would reset that
 * machine's idle timer. */
export const MachineListRow = z.object({ id: z.string(), state: MachineState, labels: z.record(z.string()), size: WorkspaceSize.optional() });
export type MachineListRow = z.infer<typeof MachineListRow>;

/** The engine's own error kinds, carried on a refused frame so a container the place's daemon lost reads missing on
 * the host exactly as it reads on this computer. `absent` is the link's own: the place is not connected. */
export const MachineErrorKind = z.enum(["concurrency", "plan", "missing", "conflict", "snapshotUnavailable", "transient", "auth", "unknown", "absent"]);
export type MachineErrorKind = z.infer<typeof MachineErrorKind>;

/** What a backend says about itself once, when a link opens. Pricing carries its numbers and not its function: the
 * client answers rateUsdPerHour from the matching offer in capabilities.sizes, and 0 where none matches, which is
 * every size on a computer the person owns. Lifecycle carries budgets alone; a provider whose backstop is pushed
 * cannot be served over a link yet, and none that can be is. */
export const BackendFacts = z.object({
  /** The id of the row this computer serves, off the one table of what a joined computer can offer. What a fork
   * standing there was forked by: the computer says it, since which kinds there are is the computer's own to know
   * and the host that drives it reads a backend and never a kind. */
  offer: z.string(),
  capabilities: Capabilities,
  pricing: z.object({ defaultSize: WorkspaceSize, snapshotStorage: SnapshotStoragePricing, builderDiskGb: z.number().optional() }),
  lifecycle: z.object({ budgets: LifecycleBudgets }).optional(),
  baseTemplates: z.object({ sandbox: z.string(), desktop: z.string() }).optional(),
});
export type BackendFacts = z.infer<typeof BackendFacts>;

/** One machine as the place hands it over: the handle's fields, and which optional roads the handle carries, so the
 * client builds a machine whose optional methods are present exactly where the place's are. hostUrl is never
 * carried: the place's answer names the place, and a fork on it dials the host at the address the host advertises. */
export const MachineHandle = z.object({
  id: z.string(),
  kind: MachineKind,
  streamUrl: z.string().optional(),
  labels: z.record(z.string()).optional(),
  seen: z.object({ state: MachineState, createdAt: z.string().optional() }).optional(),
  replayed: z.boolean().optional(),
  daemonSupervisor: DaemonSupervisor.optional(),
  roads: z.object({ previewUrl: z.boolean(), daemonAnswers: z.boolean(), putBytes: z.boolean(), describe: z.boolean(), facts: z.boolean(), metrics: z.boolean() }),
});
export type MachineHandle = z.infer<typeof MachineHandle>;

/** What the computer holding a backend has left for one more machine. memRoomMb is the backend's share of the
 * memory less what its live machines (running and paused alike, a frozen container keeps its memory) are allowed;
 * diskFreeBytes is the filesystem under the daemon's root; images are the wsp images it holds. */
export const PlaceCapacity = z.object({
  cores: z.number(),
  memMb: z.number(),
  memRoomMb: z.number(),
  /** The most one machine's memory limit may name on this computer, which is what a fork of any bigger size is
   * clamped to. The room a fork takes is not the room the whole computer has, and the rule that says so is the
   * backend's own, so the number travels rather than the rule. */
  machineMemMb: z.number(),
  diskFreeBytes: z.number(),
  images: z.array(z.object({ id: z.string(), name: z.string().optional(), sizeBytes: z.number() })),
  machines: z.object({ running: z.number(), paused: z.number() }),
});
export type PlaceCapacity = z.infer<typeof PlaceCapacity>;

/** How many more forks a place takes: the memory rule, and the disk rule where an image is there to measure by.
 * One function, read by the command line's table and the app's place row. */
export function forkRoom(c: Pick<PlaceCapacity, "memRoomMb" | "diskFreeBytes">, memMb: number, imageBytes: number | undefined): number {
  const byMemory = Math.floor(c.memRoomMb / memMb);
  const byDisk = imageBytes === undefined || imageBytes === 0 ? Number.POSITIVE_INFINITY : Math.floor(c.diskFreeBytes / imageBytes);
  return Math.max(0, Math.min(byMemory, byDisk));
}

/** Raw bytes per putBytes frame: 4 MiB is 5.4 MiB of base64 in one JSON frame, small enough that a pty stream on
 * the same link is not held behind it for long, large enough that a daemon bundle goes in one or two. */
export const MACHINE_PUT_PART_BYTES = 4 * 1024 * 1024;

export const MachineLinkRequest = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("machine.backend") }),
  z.object({ id: reqId, op: z.literal("machine.capacity") }),
  z.object({ id: reqId, op: z.literal("machine.checkKey") }),
  z.object({ id: reqId, op: z.literal("machine.create"), spec: MachineSpec }),
  z.object({ id: reqId, op: z.literal("machine.get"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.list"), labels: z.record(z.string()).optional() }),
  z.object({ id: reqId, op: z.literal("machine.deleteSnapshot"), snapshotId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.listSnapshots") }),
  z.object({ id: reqId, op: z.literal("machine.promoteSnapshot"), snapshotId: z.string(), name: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.getTemplate"), templateId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.listTemplates") }),
  z.object({ id: reqId, op: z.literal("machine.deleteTemplate"), templateId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.exec"), machineId: z.string(), cmd: z.string().max(EXEC_BODY_MAX), timeoutMs: z.number().int().positive().optional() }),
  z.object({ id: reqId, op: z.literal("machine.snapshot"), machineId: z.string(), name: z.string(), life: MachineLife }),
  z.object({ id: reqId, op: z.literal("machine.pause"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.resume"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.kill"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.state"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.describe"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.facts"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.metrics"), machineId: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.daemonAnswers"), machineId: z.string(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ id: reqId, op: z.literal("machine.previewUrl"), machineId: z.string(), port: z.number().int().min(1).max(65535) }),
  z.object({ id: reqId, op: z.literal("machine.downloadUrl"), machineId: z.string(), path: z.string() }),
  z.object({ id: reqId, op: z.literal("machine.uploadUrl"), machineId: z.string(), path: z.string() }),
  /** One part of a file. data is base64 of at most MACHINE_PUT_PART_BYTES raw bytes; parts of one uploadId arrive in
   * seq order on one socket; the part marked last lands the whole file through the backend's own byte road. The
   * upload id is a name, never a path: the far side keeps a file under it while the parts arrive, so anything that
   * could climb out of that folder is refused here, where the shape is read. */
  z.object({
    id: reqId,
    op: z.literal("machine.putBytes"),
    machineId: z.string(),
    path: z.string(),
    uploadId: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    seq: z.number().int().min(0),
    last: z.boolean(),
    data: z.string(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
export type MachineLinkRequest = z.infer<typeof MachineLinkRequest>;

// One reply schema per reply, as the files and diff ops have; an op not listed answers the bare ok envelope.
export const MachineBackendReply = BackendFacts;
export const MachineCapacityReply = PlaceCapacity;
export const MachineHandleReply = z.object({ machine: MachineHandle });
export const MachineListReply = z.object({ machines: z.array(MachineListRow) });
export const MachineExecReply = z.object({ result: ExecResult });
export const MachineSnapshotReply = z.object({ snapshotId: z.string() });
export const MachineStateReply = z.object({ state: MachineState });
export const MachineShapeReply = z.object({ shape: MachineShape });
export const MachineFactsReply = z.object({ facts: MachineFacts });
export const MachineAnswersReply = z.object({ answers: z.boolean() });
/** The route on the place's own loopback; the host turns it into a route of its own with a forward. */
export const MachineReachReply = z.object({ reach: PreviewReach });
export const MachineUrlReply = z.object({ url: z.string() });
export const MachineSnapshotsReply = z.object({ snapshots: z.array(SnapshotRow) });
export const MachinePromoteReply = z.object({ templateId: z.string() });
export const MachineTemplateReply = z.object({ template: TemplateRow });
export const MachineTemplatesReply = z.object({ templates: z.array(TemplateRow) });

/** What an op meant for the link a computer opened to its host answers on any other socket: the leave op, which
 * takes this computer out of a wsp, and every machine op, which drives the Docker daemon behind it. One sentence,
 * since it is one rule: a client holding this daemon's token is a client on this machine, and a client on this
 * machine neither un-joins it nor forks on it. */
export const NOT_ON_THIS_ROAD = "not on this road";

/** What a place that holds no copy of the image a fork names is refused with. A place builds its copy on first use;
 * until it does, the forks land where the image already is. */
export const placeHoldsNoImageLine = (place: string, image: string): string =>
  `${place} holds no copy of ${image}; a place builds its copy of your image on first use, and until it does forks land on your default place`;

/** What a remove of a place that still holds forks is refused with: the machines are the person's to delete, and a
 * place taken out from under them would leave containers nothing here can name. */
export const placeHoldsForksRefusal = (place: string, names: readonly string[]): string =>
  `${place} still holds ${names.length === 1 ? "a fork" : `${names.length} forks`} (${names.join(", ")}); delete them first, then wsp remove ${place}`;

/** What a fork on a joined computer with no Docker is refused with: it runs the person's agents over its link and
 * has nothing to fork with. */
export const placeForksNowhereLine = (place: string): string =>
  `${place} runs your agents but has no Docker, so it takes no forks; install Docker on it to fork there`;

/** What a word that names no place this host holds is refused with, naming the ones it does. */
export const noSuchPlaceRefusal = (word: string, held: readonly string[]): string => `no place named ${word}; you have ${held.join(", ")}`;

/** What a build of the image at a place that cannot take one is refused with: a copy needs a builder forked there
 * and that builder's disk copied, and a computer somebody joined does neither. */
export const placeBuildsNoImageLine = (place: string): string =>
  `${place} takes no copy of your image: a copy is built by forking a machine there and copying its disk, and ${place} does neither`;

export const DaemonErrorCode = z.enum([
  "unsupported",
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
  /** Set by the machine ops alone, so a backend's own error keeps its meaning across the link: a container the
   * place's daemon lost reads missing on the host exactly as it reads on the computer holding it. */
  kind: MachineErrorKind.optional(),
  status: z.number().int().optional(),
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

/** One reading of the computer the host runs on, pushed on a client's own socket rather than through the event
 * stream: it is a tick of a live figure, not a thing that happened, so nothing replays it to a socket that comes
 * back. Named apart from the daemon's own sys.sample because these two arrive on different sockets and a client
 * that reads both must not mistake one for the other. */
export const WorkspaceSysEvent = z.object({ type: z.literal("workspace.sys"), workspaceId: z.string(), sample: SysSample });
export type WorkspaceSysEvent = z.infer<typeof WorkspaceSysEvent>;

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
  "f90fd16f8e5d15707cda18e58524da66fb6ed6b890632fff90d396792dc5604d",
  "9ebea6a49390fd5b1af911f413e77c3e46db091812b55b41515e881e93433292",
  "da0d618fd27965a77c8c15e389fea39c8f3ae691326af0212a8f1c62b9c8499f",
  "cbfe733de05765b706c3ff4d08aa62ee188258771dd3b02011633716fad62a48",
  "12eac7cd2f4b90f9064279a1ea3b3169d24e34c30279f5c19d046252e2d5ec66",
  "877eda4200afad3842bedad0e49d6efc942ef1ef3ea7181af22f9e726d72b669",
  "206d96d53b9734c3dce0e84bf11d5455e210b2419b6c9572748ebf69861afca5",
  "6875c912371aadfb9947191e4d887b9fb6576ed57d0268de91811a6d3ac4f4cd",
  "4c81908db0c4d29e74f00ddd5513e94137f01afeb39b9afbed242368be6097c6",
  "0ad3a1c3e98d5b75bf94d610b9e166a7ad1bb5e79ee7ab4905d6b738fb5eded9",
  "01030623497a43f044916ca27731dbfa4c92c6b82765a9e9dbd6426d69b1ee4e",
  "a6ae68d8af502a8a5ecf9795ca11ca0b9b12cda2792e45eee3376c7e4d57917b",
  "055dcf11b2a17e8959ab3a6246c2d17f89eb3837c59b31d3a8138c6dc7b6c322",
  "09e441a435678290871e210158d5f8fef3b43b307c5ec917086a201583c037a5",
  "d174f06a61a283e4163c28e884b2152fa4551596dceeebb9de05b01b45d1ac22",
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
 * on a Linux guest and on the person's own Mac. Version 8 runs under a systemd unit that restarts it, so a
 * daemon the kernel kills comes back on its own. Version 9 reads the utilisation and the processes it serves
 * through a module per kind of machine, and answers a watch only once that module has read the machine, so a
 * pane is refused where it would otherwise wait for a stream that never comes. Version 10 keeps a DISPLAY the
 * caller names on a pty it opens, so a sign-in whose page must return to the machine can be handed a browser to
 * find there. Version 11 serves a machine reached over ssh, which reads the load and the processes of the machine
 * it runs on the way a fork does; the same daemon under the person's own login there, with every path it keeps
 * under their home. Version 12 asks the prefix it would compile against for the headers themselves, so a machine
 * where an installer symlinked a foreign node into that prefix builds node-pty instead of failing on it. Version
 * 13 asks those headers which major they are and compiles against them only when the node that will load the
 * result agrees, so an older Node's headers left in the prefix send node-gyp after the right ones instead of
 * building against the API another Node declared. Version 14 reads the environment a provider could not hand a
 * fork at create off a file under /etc the unit may lack, so a backend that lands it there hands the daemon its
 * keys without touching anything else on the machine. Version 15 is deployed by a script whose guards end it
 * themselves, so a machine with no service manager and an npm install that failed stop at the line that found
 * them instead of leaving the rest to run. Version 16 starts by the node the deploy compiled its native modules
 * under, kept in the daemon's own folder, rather than by whatever a PATH the machine owns names at the moment of
 * the start: a machine restored onto another one names a different node there, or none, and none is a start that
 * fails every second for the life of the machine. Version 17 answers an exec op and can dial a host of its own: a
 * computer somebody joined as a place opens the socket outward, proves itself on the ed25519 key that host learned
 * at the join, and then serves that socket exactly as it serves an inbound one, so every command the host already
 * sends a machine rides one frame on the link and no runtime road learns a second transport. It also loads its
 * native pty module at the first terminal rather than at its own import, so a machine where nothing built that
 * module serves every other op instead of refusing to start. Version 18 finds that native module where a packaged
 * command carries it: the command bundles node-pty rather than requiring it, and a bundled CommonJS module arrives
 * with a default export and no named one, so a daemon running inside the packaged command opened no terminal at
 * all until this. Version 20 takes every option as a flag,
 * one per option, reads its ports, load, processes and pty modes off one /proc root, logs its samplers' starts and
 * stops, and builds a place's report and sweep off the home it is pointed at, so a test suite drives it as a binary
 * and the words and numbers it answers with are the protocol's, held in one fixture set. Version 21 takes
 * --runtime-root, where a place's daemon keeps the layers and the workspaces it runs itself. Version 22 is one
 * static binary, built from the Rust sources under daemon/ for each chip a machine can be: the deploy lands the two
 * Linux builds and keeps the one uname names, the unit and the supervisor start it by its path with one set of
 * flags, a computer joined as a place runs the same binary under its login's own manager, this computer's
 * workspace spawns it, and the guest keeps no node, no npm install and no native module for the daemon; the wsp
 * command beside it still runs on the node the machine carries. The binary also answers a plain HTTP request 426,
 * as the host's status probe reads a daemon by. */
export const DAEMON_VERSION = DAEMON_CONTENTS.length;

/** sha256 of what a deploy installs on a guest and this record can hold: the Rust sources and manifests the binary
 * is built from, the lock that pins its dependencies, the C library the Linux builds link and its pinned release,
 * the contract fixtures its words and numbers are held to (the version itself left out of them, since it is this
 * record), the scripts the host writes beside it, DAEMON_ROOTS_PATH and the work-score line. The host's
 * daemon-content test recomputes it and fails when that content moved and this record did not, so changed content
 * cannot reach nobody: a start script gained a PATH line under an unchanged version once and every machine already
 * running kept the old one. Left out: the rest of this file, which the binary reads only through the fixtures;
 * hashing the protocol whole would turn every edit to it into a redeploy of every machine. */
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

/** What a single-use ticket opens the next socket for: `connect`, another client of the person's own, or `relay`,
 * the road a machine's requests reach this host by. The purpose is what a socket's origin is read off, so a relayed
 * socket is one this host minted a relay ticket for and nothing a client says on the wire can make one. */
export const TicketPurpose = z.enum(["connect", "relay"]);
export type TicketPurpose = z.infer<typeof TicketPurpose>;

/** Where a socket redeeming a ticket of each purpose reached the host from, named for every purpose there is. The
 * host stamps this over whatever the client's own frames say, so a purpose that names none would be a socket whose
 * origin its holder decides: the door refuses one rather than falling back to the wire, and a purpose added later
 * has to say what it is here before any socket may redeem it. */
export const TICKET_ORIGIN: Record<TicketPurpose, WorkspaceOrigin> = { connect: "here", relay: "relayed" };

/** A computer that redeemed a pairing code and holds a token of its own, as devices.list answers and wsp devices
 * prints it. The token is never here: the host keeps only its hash, so a listing can leak nothing that opens a
 * socket. */
export const DeviceView = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** When this device last authed. Set by the redeem that minted it and moved by every later auth frame, never by
   * a JSON route reading the same token, so a listing says when the computer last dialled rather than last asked. */
  lastSeenAt: z.string(),
  /** What this device may do, when it is not a computer of the person's: a token the host minted into one turn's
   * environment, which drives only the tree that turn's thread is in. Absent is a paired computer, which drives
   * everything this host holds. */
  scope: ThreadScope.optional(),
});
export type DeviceView = z.infer<typeof DeviceView>;

/** How long a pairing code stands before the host forgets it: long enough to read off one screen and type into
 * another, short enough that a code left in a terminal buffer is worth nothing by the time anyone reads it. */
export const PAIR_CODE_TTL_MS = 10 * 60_000;

/** How many characters a pairing code is, out of the 32 the alphabet holds: 40 bits, single use and ten minutes
 * long, which no reachable host answers enough guesses of. */
export const PAIR_CODE_LENGTH = 8;

/** A pairing code as every screen shows it: the alphabet's letters in two halves, which is how a person reads one
 * across a room. The one grouping, so the sheet that shows a code and the field that takes one agree. */
export function shownPairCode(code: string): string {
  const letters = code.replace(/-/g, "").toUpperCase().slice(0, PAIR_CODE_LENGTH);
  const half = Math.ceil(PAIR_CODE_LENGTH / 2);
  return letters.length <= half ? letters : `${letters.slice(0, half)}-${letters.slice(half)}`;
}


/** A pairing code as the host takes it, whichever screen it was copied off: the letters alone, upper case. A
 * person copies the code they can read, so the dash the screens put in it is one this reading takes back out. */
export const sentPairCode = (shown: string): string => shown.replace(/-/g, "").toUpperCase();

/** The symbols a pairing code is written in: the digits and the letters, less the four that a person reading one
 * screen and typing into another confuses (I, L, O, U). Thirty-two of them, so each character is five bits and a
 * random byte masked to five bits is uniform. */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The refusal a socket that is not the host's own gets for asking to mint a pairing code: a code lets a stranger
 * in, so only the process holding the host token, on this computer, may hand one out. */
export const PAIR_ISSUE_REFUSAL = "only a socket holding this host's own token may mint a pairing code; run wsp pair on the computer the host runs on";

/** The refusal a redeemed code that this host is not holding gets: spent, expired, or never minted read the same,
 * so guessing tells a caller nothing about which. */
export const PAIR_CODE_REFUSAL = "that pairing code is not one this host is waiting for; run wsp pair on the host for a fresh one";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the device ops, whether the ticket
 * was the road a machine's requests arrive by or another client's. Who may drive this host is handed out, read and
 * taken away at the terminal of the computer it runs on, and nowhere else. */
export const DEVICES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the devices paired with this host; run wsp devices on the computer the host runs on";

/** The refusal a device gets for revoking another device: a paired computer can hand its own token back, and only
 * the host takes anyone else's away. */
export const DEVICE_REVOKE_REFUSAL = "a paired device may only revoke itself; run wsp devices revoke on the host to take another one away";

/** The refusal the JSON routes answer with when the host listens beyond this computer and the request carries no
 * device token. */
export const API_UNAUTHORIZED = "this host listens beyond the computer it runs on, so this route needs a paired device token in an Authorization header; run wsp pair on the host";

/** A frame the page sends a daemon through the host: the daemon's own op and params, no id. The host numbers
 * frames on its socket to the daemon and hands the daemon's answer back under the request that carried the frame,
 * so a page's ids never reach a machine. auth is refused: the host sent the auth frame when it opened the channel. */
export const DaemonFrame = z.object({ op: z.string().refine(op => op !== "auth", "the host authenticates the channel") }).passthrough();
export type DaemonFrame = z.infer<typeof DaemonFrame>;

export const DaemonOpenReply = z.object({ channel: z.string() });
export type DaemonOpenReply = z.infer<typeof DaemonOpenReply>;
/** The daemon's reply as it sent it; id is the host's number on its own socket and means nothing to the page. */
export const DaemonSendReply = z.object({ reply: DaemonResponse });
export type DaemonSendReply = z.infer<typeof DaemonSendReply>;

/** What the host pushes to the one socket that opened a channel. Never on the event bus, never sequenced, never
 * replayed: a pty chunk is not history. event is the daemon's frame untouched; the page validates it against
 * DaemonEvent as it always did, since a daemon of another version may push a type this host does not know and
 * the host acts on none of them. daemon.closed says the daemon socket ended without the page asking: code and
 * reason are the WebSocket close the host saw, 4401 with the daemon's sentence when it refused the token. */
export const DaemonChannelEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("daemon.event"), channel: z.string(), event: z.object({ type: z.string() }).passthrough() }),
  z.object({ type: z.literal("daemon.closed"), channel: z.string(), code: z.number().int(), reason: z.string() }),
]);
export type DaemonChannelEvent = z.infer<typeof DaemonChannelEvent>;

// --- places: a computer you own, joined by dialling this host ---------------

/** How many bytes each side's challenge is. Thirty-two: a nonce is what keeps a signature from being replayed, and
 * a birthday collision on it has to be out of reach for the life of a key, not for the life of one link. */
export const PLACE_LINK_NONCE_BYTES = 32;

/** The decoded byte length of a base64 string, worked out from the string itself: this package is bundled into the
 * browser, so nothing here decodes through Buffer. */
function base64Bytes(text: string): number {
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return (text.length / 4) * 3 - pad;
}

const base64 = (bytes: number) =>
  z
    .string()
    .max(4 * Math.ceil((bytes + 2) / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine(text => text.length % 4 === 0 && base64Bytes(text) === bytes, `must be ${bytes} bytes, base64`);

export const PlaceNonce = base64(PLACE_LINK_NONCE_BYTES);
/** An ed25519 public key as SPKI DER, base64: 44 bytes. */
export const PlacePublicKey = base64(44);
/** An ed25519 signature, base64: 64 bytes. */
export const PlaceSignature = base64(64);

/** What a place says about itself on every link, and once at join. Read by the host into the place record and the
 * workspace recorded on it; nothing here is trusted for paths until isPlainPath has read it. */
export const PlaceReport = z.object({
  name: z.string().min(1).max(200),
  platform: z.enum(["darwin", "linux"]),
  arch: z.string().max(32),
  os: z.string().max(200),
  shape: WorkspaceSize,
  diskFreeBytes: z.number().int().nonnegative().optional(),
  /** HOME, USER, PATH and each harness's store variable, as the ssh read records them. */
  login: z.record(z.string()),
  docker: z.boolean(),
  daemonVersion: z.number().int().nonnegative(),
  /** The loopback port the place's own daemon bound, for the forward the panes ride. */
  daemonPort: z.number().int().min(1).max(65535).optional(),
  /** The line that runs wsp on this place, word by word, for the tools a turn's agent is given later. */
  wsp: z.array(z.string()).min(1),
  /** The catalog ids of the agents found on that computer's own login PATH, for the line the person reads as it
   * joins. Capped because it lands in a sentence, not in a list a person scrolls. */
  agents: z.array(z.string().max(32)).max(32),
  /** Which of the host's addresses this link reached; the address a turn on the place is told to dial back. */
  dialed: z.string().refine(isHttpUrl, "http or https URL"),
});
export type PlaceReport = z.infer<typeof PlaceReport>;

/** The first frame of a joining place: spends a join code (the pairing code road) for a place record that holds
 * this key. Answered with PlaceJoinReply; the socket then continues with place.prove as an auth would. */
export const PlaceJoinRequest = z.object({
  id: reqId,
  op: z.literal("place.join"),
  code: z.string().max(64),
  publicKey: PlacePublicKey,
  nonce: PlaceNonce,
  report: PlaceReport,
  /** The joining computer also wants a device token for its own window. One code buys both, since the person's
   * intent was one act; absent on a join typed in a terminal, which wants no window. */
  client: z.object({ name: z.string().min(1).max(200) }).optional(),
});
export type PlaceJoinRequest = z.infer<typeof PlaceJoinRequest>;
export const PlaceJoinReply = z.object({
  placeId: z.string(),
  hostPublicKey: PlacePublicKey,
  nonce: PlaceNonce,
  signature: PlaceSignature,
  /** What the primary computer calls itself, which is what the joined computer shows a person from then on. */
  hostName: z.string().min(1).max(200),
  /** Handed back only to a join that asked for one: the token this computer's own window holds. */
  device: z.object({ deviceId: z.string(), deviceToken: z.string().min(1) }).optional(),
});
export type PlaceJoinReply = z.infer<typeof PlaceJoinReply>;

/** The first frame of a place that already joined: names itself and challenges the host. */
export const PlaceAuthRequest = z.object({ id: reqId, op: z.literal("place.auth"), placeId: z.string().max(64), nonce: PlaceNonce });
export type PlaceAuthRequest = z.infer<typeof PlaceAuthRequest>;
export const PlaceAuthReply = z.object({ nonce: PlaceNonce, hostPublicKey: PlacePublicKey, signature: PlaceSignature });
export type PlaceAuthReply = z.infer<typeof PlaceAuthReply>;

/** The second frame: the place's answer to the host's nonce, and its report as it stands now. After this the socket
 * is the place link and carries daemon frames only. */
export const PlaceProveRequest = z.object({ id: reqId, op: z.literal("place.prove"), signature: PlaceSignature, report: PlaceReport });
export type PlaceProveRequest = z.infer<typeof PlaceProveRequest>;

/** What both sides sign, built by one function so they cannot drift: the role of the signer, the place id and the
 * two nonces, the challenged party's nonce first. The host signs the transcript the place challenged it with and
 * the place signs the host's, so neither side's signature can be replayed back at it as the other's. */
export function placeLinkTranscript(role: "host" | "place", placeId: string, challenge: string, answer: string): Uint8Array {
  return new TextEncoder().encode(`wsp place link v1\n${role}\n${placeId}\n${challenge}\n${answer}\n`);
}

/** The refusal a join whose code this host is not holding gets. Spent, expired and never minted read the same, so
 * guessing tells a caller nothing about which; the words differ from a pairing code's only in naming the verb that
 * mints this one, since a person joining a computer never typed wsp pair. */
export const PLACE_CODE_REFUSAL = "that join code is not one this host is waiting for; run wsp add on the host for a fresh one";

/** The refusal a place gets for proving itself with a key the host does not hold for it. A key that moved is a
 * computer re-joined somewhere else or a place file copied off it, and neither is this place. */
export const PLACE_KEY_REFUSAL = "that place's key does not match the one this host learned at join; wsp remove it here and join it again";

/** The refusal a place that names an id this host holds none of gets: removed here, or a state file that is not
 * the one it joined. */
export const PLACE_UNKNOWN_REFUSAL = "this host holds no place by that id; join it with a code from wsp add";

/** The refusal a joining computer prints when the host at that address could not prove the key this computer
 * learned at join, so nothing of this computer's went to it. */
export const hostKeyRefusal = (url: string): string => `the host at ${url} did not prove the key this computer learned at join; nothing was sent to it`;

/** What a row says about a place that is not holding its link right now. Nothing is wrong: the computer dials on
 * its own whenever it is on and can reach this host. */
export const placeAbsentLine = (name: string): string => `${name} is not connected right now; it dials this host on its own when it is on and can reach it`;

/** What a remove says about a place that was not linked when it ran: the records here are gone and the agent on
 * that computer is not, since nothing could reach it to sweep. */
export const placeStillInstalledLine = (name: string): string => `${name} is off this host, but the agent on it is still installed; run ${PLACE_LEAVE_LINE} on that computer when it is back`;

/** What a remove says about each workspace that stood on the place it took out: the record and its threads leave
 * this host, and the computer keeps its own files, since wsp never made them. */
export const placeWorkspaceGoneLine = (name: string, id: string): string => `workspace ${name} (${id}) and its threads are gone from this host; its files on that computer are the person's own and stay`;

/** What a place that is connected but has never said which port its daemon bound is refused with: a pane needs
 * that port to carry to, and only that computer knows it. */
export const placeNoDaemonPortLine = (name: string): string => `${name} is connected but has not said which port its daemon is on, so nothing can carry a pane to it yet; it says so on its next link`;

/** What an install is refused with when the computer took the agent and never dialled back: the join landed, so
 * the computer belongs to this wsp, and what is missing is a road from it to here. */
export const placeNoLinkLine = (name: string): string => `${name} took the agent and has not dialled this host yet; check that it can reach this computer on the address it was given, and wsp places shows it the moment it does`;

/** The refusal wsp add over ssh gets on a host that wired no installer: the road that puts the agent on a computer
 * is the host command's, so a runtime served without one holds no way onto a machine it has never met. */
export const NO_PLACE_INSTALLER = "this host cannot install the agent on a computer over ssh; run wsp add with no argument for the line to type on that computer";

/** The refusal a socket that was let in on a single-use ticket gets for reaching the place ops: which computers a
 * person's wsp runs on, and taking one back out, is handed out and taken away at the terminal of the computer the
 * host runs on and nowhere else. */
export const PLACES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the places this host holds; run wsp places on the computer the host runs on";

/** Where a computer you own dials this wsp: the port the door answers on and every address it can be reached at.
 * A host that already binds beyond this computer answers its own port and opens nothing. */
export const PlaceDoorView = z.object({
  port: z.number().int().min(1).max(65535),
  /** `http://<address>:<port>` for every address this computer answers on that leaves it, loopback left out. */
  addresses: z.array(z.string().url()).min(1),
  /** The relay hostname as an https address, when the host is linked and its connector is running. */
  relay: z.string().url().optional(),
});
export type PlaceDoorView = z.infer<typeof PlaceDoorView>;

/** The refusal a socket let in on a ticket gets for opening the door computers you own dial: the same rule the
 * device and place ops read, since the door is who may reach this wsp. */
export const PLACE_DOOR_REFUSAL = "a socket let in on a ticket cannot open the door computers you own dial; run wsp add on the computer the host runs on";

/** The refusal for a host that serves no such door at all: wsp up serves one, a bare runtime does not. */
export const PLACE_DOOR_UNSERVED = "this host opens no door for computers you own; wsp up serves one";

/** A refusal in two halves: what happened, which the app draws in the destructive ink, and what to do about it,
 * which it draws in the foreground ink. One shape, so every screen that refuses reads the same way. */
export const TwoPartRefusal = z.object({ what: z.string(), fix: z.string() });
export type TwoPartRefusal = z.infer<typeof TwoPartRefusal>;

export const JOIN_ADDRESS_LINE: TwoPartRefusal = {
  what: "That is not an address.",
  fix: `Type it as the other screen shows it, like 192.168.1.20:${DEFAULT_PLACE_PORT}.`,
};
export const joinNoAnswer = (at: string): TwoPartRefusal => ({
  what: `Nothing answered at ${at}.`,
  fix: "Check both computers are on one network and the address on the other screen.",
});
export const JOIN_CODE_REFUSED: TwoPartRefusal = {
  what: "That code is not one the other computer is waiting for.",
  fix: "Press New code there and type the new one.",
};
export const JOIN_ALREADY: TwoPartRefusal = {
  what: "This computer already runs threads for another wsp.",
  fix: "Leave it from the sidebar first.",
};

/** How long the code on the Add a computer sheet is good for, said in the words beside it. */
export const CODE_GOOD_LINE = "the code is good for 10 minutes";
export const CODE_EXPIRED_LINE = "the code expired; press New code";

/** What the sheet says when somebody else already holds the door's port: a fixed port, since the place file on the
 * other computer names it for good, so a fallback port would be a computer that can never dial back. */
export const doorPortHeldLine = (port: number): string =>
  `port ${port} is held by another program on this computer, so no computer you own can reach this wsp; free it and open Add a computer again`;

/** What a computer joined as a place keeps about the wsp it belongs to, in the file the join writes and the agent
 * reads on every attempt: the id its host knows it by, the addresses to dial in order, the host's public key pinned
 * at that join, and where its own private key is. The shape and the two readings of it live here because the join
 * writes it on one side of the wire and the agent reads it on the other. */
export interface PlaceFile {
  placeId: string;
  name: string;
  /** What the wsp this computer joined calls itself, learned at the join: the one word the joined computer shows. */
  hostName: string;
  /** LAN address first, the host's tunnel hostname after it; dialled in this order on every attempt. */
  hostUrls: string[];
  hostPublicKey: string;
  keyPath: string;
  joinedAt: string;
  /** Whether this computer is held out of idle sleep while it is joined. The hold lives in the agent, which watches
   * this file, so the toggle is a write here and quitting the app changes nothing. */
  awake: boolean;
}

/** The mode the place file and the private key beside it are kept at: the person's own and nobody else's. A key any
 * account on that computer could read is a key that joins their wsp for them. */
export const PLACE_FILE_MODE = 0o600;

/** The place file a text holds, or nothing when that text is not one. A file that is there and is not one reads the
 * same as none: the one road that writes it is wsp join, and anything else there is not a place to dial with. */
export function parsePlaceFile(text: string): PlaceFile | undefined {
  let held: unknown;
  try {
    held = JSON.parse(text);
  } catch {
    return undefined;
  }
  const f = held as PlaceFile | undefined;
  const ok =
    typeof f === "object" &&
    f !== null &&
    typeof f.placeId === "string" &&
    typeof f.name === "string" &&
    typeof f.hostName === "string" &&
    typeof f.awake === "boolean" &&
    Array.isArray(f.hostUrls) &&
    f.hostUrls.every(u => typeof u === "string") &&
    typeof f.hostPublicKey === "string" &&
    typeof f.keyPath === "string";
  return ok ? f : undefined;
}

/** The text the file holds, which parsePlaceFile reads back. */
export const placeFileText = (file: PlaceFile): string => `${JSON.stringify(file, null, 2)}\n`;

/** The refusal a second join on one computer gets: a place file is the one wsp this computer belongs to. */
export const ALREADY_JOINED_LINE = `this computer is already a place in a wsp; ${PLACE_LEAVE_LINE} first`;

const RuntimeOp = z.discriminatedUnion("op", [
  z.object({ id: reqId, op: z.literal("auth"), token: z.string() }),
  z.object({ id: reqId, op: z.literal("ticket.issue"), purpose: TicketPurpose }),
  /** Mints a one time code another computer redeems for a device token of its own. Answers `{ code, expiresAt }`.
   * Only on a socket holding the host's own token, and never on one let in by a ticket. */
  z.object({ id: reqId, op: z.literal("pair.issue") }),
  /** Spends a code for this computer's own token, as the first frame of a socket nothing has authed. Answers
   * `{ deviceId, deviceToken }` once, and the socket is authed as that device from then on. */
  z.object({ id: reqId, op: z.literal("pair.redeem"), code: z.string().max(64), name: z.string().max(200) }),
  /** Every paired device, for the host token and for a device's own socket alike. */
  z.object({ id: reqId, op: z.literal("devices.list") }),
  /** Takes a device's token away and cuts the sockets holding it. A device may name only itself; the host token
   * names any. */
  z.object({ id: reqId, op: z.literal("devices.revoke"), deviceId: z.string() }),
  /** The first frame of a computer joining as a place: spends a join code for a record holding its key. Answered
   * with a PlaceJoinReply, and the socket then sends place.prove as an authed one would. */
  PlaceJoinRequest,
  /** The first frame of a place that already joined, answered with a PlaceAuthReply. */
  PlaceAuthRequest,
  /** The second frame of either road: once it verifies, this socket stops being a client's and is the place link. */
  PlaceProveRequest,
  /** Every place this host holds: this computer, the computers joined to it, and the provider it forks on.
   * Answers `{ places: PlaceView[] }`. */
  z.object({ id: reqId, op: z.literal("places.list") }),
  /** Takes a place back out: sweeps wsp off that computer over its link, drops the workspaces standing on it and
   * the place record. Answers `{ removed, swept, note? }`. */
  z.object({ id: reqId, op: z.literal("places.remove"), placeId: z.string() }),
  /** Opens the door computers you own dial, when this host binds loopback alone, and answers where it is; a host
   * already bound beyond loopback answers its own port and opens nothing. Answers a PlaceDoorView. The person's
   * own road only, as every other place op is. */
  z.object({ id: reqId, op: z.literal("places.door") }),
  /** Puts the agent on a Linux computer over ssh and joins it: the host logs in as the person's own ssh would,
   * installs node and wsp there, starts the agent under that login's own service manager and waits for it to dial
   * back. Answers `{ addId, place: PlaceView }` once it has dialled; the steps ride place.stage events carrying the
   * same addId. */
  z.object({
    id: reqId,
    op: z.literal("places.add"),
    /** The stream the steps of this install ride, minted by whoever asked: the steps start before the reply names
     * the place, so a caller that wants to draw them has to know which are its own before it asks. */
    addId: z.string().max(64).optional(),
    address: z.string().max(200),
    name: z.string().max(200).optional(),
    sshPort: z.number().int().min(1).max(65535).optional(),
    keyPath: z.string().max(1024).optional(),
  }),
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
  /** Replies with a WorkspaceListing[] snapshot and keeps nothing running: the one shot a command line or a tool
   * takes to read a state, since a WorkspaceView carries neither the provider's word for the machine nor the daemon
   * reach and the state word turns on both. The listing is the status without the minted route, which only the app's
   * own socket needs, and the snapshot costs one reach probe per machine and no exec probe. */
  z.object({ id: reqId, op: z.literal("status.list") }),
  z.object({
    id: reqId,
    op: z.literal("workspaces.create"),
    golden: z.string(),
    name: z.string(),
    cpu: z.number().optional(),
    memMb: z.number().optional(),
    envs: z.record(z.string()).optional(),
    labels: z.record(z.string()).optional(),
    /** What the agents on the new workspace may ask of this host; absent is off, and a key left out takes the default. */
    agents: WorkspaceAgents.partial().optional(),
    /** Auto-nap window for this workspace; absent takes the runtime default (20 min), null turns it off. */
    idleWindowMs: z.number().nullable().optional(),
    /** Where this fork lands: a joined computer by name or id, or this computer. Absent takes the place a fork
     * last landed on. */
    on: z.string().optional(),
  }),
  /** The one local workspace: this computer. Forks nothing (the machine already exists); refused when this host wired
   * no local backend, when one already exists, or for a name another workspace holds. Replies with { workspace }. */
  /** Makes this computer the host's one local workspace; the name defaults to this computer's own. */
  z.object({ id: reqId, op: z.literal("workspaces.createLocal"), name: z.string().optional() }),
  /** Records a machine the person already has, reached over ssh at `address` (user@host), with the port and key
   * they named where those are not ssh's own. Forks nothing; refused when this host wired no ssh backend, when the
   * machine does not answer the dial, when a workspace already stands on it, or for a name another workspace holds.
   * The name defaults to what the address calls the machine. Replies with { workspace }. */
  z.object({ id: reqId, op: z.literal("workspaces.createSsh"), address: z.string(), name: z.string().optional(), port: z.number().int().optional(), keyPath: z.string().optional() }),
  z.object({ id: reqId, op: z.literal("workspaces.list") }),
  /** The workspace a person's word names, by id or by name, off the same reading workspaces.list serves: a name no
   * workspace here carries is refused as absent, and one this caller may not drive by the rule that hides it, so a
   * verb never denies a workspace the listing just showed. Replies with { workspace }. */
  z.object({ id: reqId, op: z.literal("workspaces.resolve"), ref: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.get"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.nap"), workspaceId: z.string() }),
  z.object({ id: reqId, op: z.literal("workspaces.wake"), workspaceId: z.string() }),
  /** Stops a wake that is asking the provider again on its own and replies with the record it leaves behind. */
  z.object({ id: reqId, op: z.literal("workspaces.stopWake"), workspaceId: z.string() }),
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
  /** Turns the workspace's agents switch on or off and names its caps. Every key left out keeps what the record
   * holds, so the two flags a person gives on one line never clear the third. */
  z.object({ id: reqId, op: z.literal("workspaces.agents"), workspaceId: z.string() }).extend(WorkspaceAgents.partial().shape),
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
  /** Opens a channel to the workspace's daemon and replies with a DaemonOpenReply. The host dials the road the
   * workspace's kind answers with and sends its own token as the first frame. Refused with kind "refused" when the
   * door answered the upgrade with anything but 101 (the sentence carries the status and the body's first line),
   * with kind "reauth" when the daemon took the upgrade and closed 4401 on the token, and with the runtime's own
   * sentence and no kind when the machine has no road or no daemon yet, or the dial failed or timed out. */
  z.object({ id: reqId, op: z.literal("daemon.open"), workspaceId: z.string() }),
  /** Pushes WorkspaceSysEvent frames for this workspace on this socket, one per poll tick, until the socket goes.
   * The one road for a workspace whose kind reads its Live rows in the host rather than off a daemon; refused for
   * every other kind, which reads them over its own daemon link with sys.watch. Replies `{}`. */
  z.object({ id: reqId, op: z.literal("sys.subscribe"), workspaceId: z.string() }),
  /** Sends one frame down a channel this socket opened and replies with a DaemonSendReply carrying the daemon's own
   * answer, ok or not. Refused (ok false, no kind) when the channel is not this socket's or died before the daemon
   * answered. */
  z.object({ id: reqId, op: z.literal("daemon.send"), channel: z.string(), frame: DaemonFrame }),
  /** Closes a channel this socket opened; no daemon.closed follows a close the page asked for. */
  z.object({ id: reqId, op: z.literal("daemon.close"), channel: z.string() }),
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
    /** The folder the thread starts in, absolute; it wins over project and the rule. Absent leaves the runtime's
     * default folder rule (projectFor, then the kind's own folder) to say. */
    cwd: z.string().optional(),
    /** One of the workspace's projects by name, the folder the thread starts in when cwd names none; refused with
     * noProjectLine when the workspace has no project of that name. */
    project: z.string().optional(),
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
    /** Who the end of every turn on the thread this start opens is told, each a thread id or NOTIFY_ME: registered on
     * the thread, and each target gets one line (a session.notify event per target in this thread's transcript).
     * Refused when a target names no thread, and refused when one names the thread this start opens. */
    notify: z.array(z.string()).min(1).optional(),
    /** The TURN_TOKEN_ENV of the turn this request came out of, when it came out of one: what NOTIFY_ME is resolved
     * against. Refused when no turn on this host carries it, since a token nothing carries names a turn the caller
     * is not. */
    turnToken: z.string().optional(),
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
  /** Drops a thread no turn ever ran on: its rows and its transcript rows go and nothing is asked of the machine.
   * Takes the runtime's thread id, the one the rows carry, not a session id; refused with threadForgetRefusal's
   * sentence once a turn reached the agent. */
  z.object({ id: reqId, op: z.literal("sessions.forget"), threadId: z.string() }),
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
  /** Replies with { reach: PortReachView } for one guest port, cached per port
   * while fresh. A port outside the daemon's listening set still mints: the
   * user may have typed it. */
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
   * absent, the folder the workspace's kind names, as a harness turn's is. The reply carries that folder back as its
   * own cwd, absent only where the kind names none and the machine's own home is where the shell landed. */
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
  /** Replies with { setup: InitSetup }: the cloud setup as the modal opens on it, the init job included when one runs. */
  z.object({ id: reqId, op: z.literal("init.get") }),
  /** Saves keys into the wsp home's .env on the computer running the host: the provider key, which wires the
   * provider it names, and an agent's API key by the sign-in row it answers, saved under the variable that agent's
   * sign-in declares. Replies with { setup: InitSetup }, which says a key is held and never says what it is. */
  z.object({ id: reqId, op: z.literal("init.keys"), solari: z.string().optional(), rows: z.record(z.string()).optional() }),
  /** Starts the init job on the road named, an agent's harness on the agent road; replies with { job: InitJob } and
   * every change after rides init.job events. One job runs at a time; a second start while one runs is refused. The
   * terminal road takes its answers from the recipe beside the state, which wsp init wrote from its own screens, and
   * is refused when there is none there. */
  z.object({ id: reqId, op: z.literal("init.start"), road: InitRoad, harness: z.string().optional() }),
  /** Answers one screen: the rows ticked, the answers chosen; replies with { job: InitJob }, its screens recomputed
   * and its step moved to the next. */
  z.object({ id: reqId, op: z.literal("init.answer"), screen: InitScreenId, ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Moves the job to a screen the person went back to, so a setup shut there reopens there; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.step"), at: z.number().int().nonnegative() }),
  /** Keeps what a step has ticked, picked or typed and not sent, so a setup shut mid-step reopens on it; replies
   * with { job: InitJob }. `at` is a screen's id or the build question's own step; a step the job does not have is
   * refused. An empty draft is an answer of its own: a step whose every tick was taken off comes back with none on. */
  z.object({ id: reqId, op: z.literal("init.draft"), at: z.string().min(1).max(64), ticks: z.array(z.string()).optional(), answers: z.record(z.string()).optional() }),
  /** Runs a sign-in that ran out or failed again on the machine while the build goes on; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.retry"), tool: z.string() }),
  /** Writes the recipe as answered and starts the build; replies with { job: InitJob } at once, the build riding on.
   * `yes` skips the sign-ins on the machine, as wsp init --yes does: a caller that asked for no waiting gets none. */
  z.object({ id: reqId, op: z.literal("init.build"), firstWorkspace: z.string().optional(), importFolder: z.string().optional(), yes: z.boolean().optional() }),
  /** Types the code a sign-in's page handed back into the tool waiting for it on the machine, as the person would at
   * that terminal; replies with { job: InitJob }. The code is never logged, kept or carried on the view. Refused when
   * no sign-in for that tool is waiting for one. */
  z.object({ id: reqId, op: z.literal("init.signInCode"), tool: z.string(), code: z.string().min(1).max(SIGN_IN_CODE_MAX) }),
  /** Stops the job where it is: a thread interrupted, a builder killed; replies with { job: InitJob }. */
  z.object({ id: reqId, op: z.literal("init.cancel") }),
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
  /** Replies with { view: SealedImageView }. */
  z.object({ id: reqId, op: z.literal("image.get"), name: z.string().optional() }),
  /** Builds this host's image at `place` from the record: prepare there, import the vault, seal. Replies with
   * { build: SealedImageBuilt }; progress rides golden.stage frames carrying `place`. A place that already holds a
   * copy built from this record is answered with that copy and `built: false`, so asking twice costs nothing.
   * Refused (kind "missing") when no place of that name is held, and (kind "conflict") when the place is the one
   * this host forks on, when the place builds no copy at all, when no record exists, when the record was sealed
   * without the recipe it was built from, and when the record holds no vault and `force` is not set. */
  z.object({ id: reqId, op: z.literal("image.build"), place: z.string().min(1), name: z.string().optional(), force: z.boolean().optional() }),
  /** Writes the record and the vault, sealed to the passphrase, to `dest` on this computer. Replies with
   * { exported: SealedImageExport }. The passphrase is never logged and never kept. */
  z.object({ id: reqId, op: z.literal("image.export"), dest: z.string().min(1), passphrase: z.string().min(IMAGE_PASSPHRASE_MIN).max(256), name: z.string().optional() }),
]);

/** Every request carries where it reached the host from: here, this computer's own app, CLI or MCP, or relayed from
 * a machine. It rides the envelope beside the id rather than each op, so a verb added later carries it without
 * saying so. Absent reads here, and today every client on this computer is here in practice. */
export const RuntimeRequest = z.intersection(RuntimeOp, z.object({ origin: WorkspaceOrigin.optional() }));

/** Every op this host answers, read off the table itself rather than written out beside it, so an op added later
 * cannot be missing from the reading that decides which of them a thread may send. */
export const RUNTIME_OPS: readonly string[] = RuntimeOp.options.map(o => o.shape.op.value);

/** The ops a socket holding a thread's own token may send, and the whole of them: the door is shut and these are
 * the openings, so an op added later reaches no thread until somebody puts it here on purpose. A thread opens
 * threads and forks machines under its own root and reads the tree it is in; every reach into a workspace is
 * refused again by the tree rule, and every act by the guard, so this list is the outer door and not the only one.
 * What is deliberately not here: sealing the golden and rolling its snapshots, the project goldens, the person's
 * keys and their init, their preferences, their folders, importing and exporting a folder, every road that hands out
 * or takes away access to this host, the two roads that move a running turn's access mode or answer a permission
 * prompt, which are the person's guard on an agent and not an agent's to lift, and the daemon channel, which carries
 * the panes a person types into while a thread drives its workspace through workspaces.exec and the session ops. */
export const THREAD_OPS: readonly string[] = [
  "auth",
  "events.subscribe",
  "status.list",
  "status.subscribe",
  // A fork is asked for by snapshot id, and the head of the golden is where wsp new reads it: a thread that may fork
  // has to be able to say from what. The manifest describes the image its own machine runs, nothing the person holds.
  "golden.get",
  // Read ahead of every fork for whether this host forks at all and at which sizes, so the refusal for a host that
  // mints nothing comes in one sentence before any stage is streamed; the wsp command asks it under any token.
  "capabilities.get",
  "workspaces.create",
  "workspaces.list",
  // Every verb a thread runs names its workspace as a person does, so the door that reads a name is open to the
  // same tokens the list is: the tree rule refuses the names outside it here exactly as it hides them there.
  "workspaces.resolve",
  "workspaces.get",
  "workspaces.touch",
  "workspaces.wake",
  "workspaces.exec",
  "harnesses.list",
  "sessions.start",
  "sessions.list",
  "sessions.history",
  "sessions.interrupt",
  "sessions.steer",
  "sessions.rename",
];

/** The one sentence a thread's own token is refused an op with. It names the op rather than guessing why a caller
 * wanted it: the reasons are on the acts, and this is the door saying the op is not a thread's at all. */
export function threadOpRefusal(op: string, threadId: string): string {
  return `${op} is not a thread's to ask for; the token this request came in on is thread ${threadWord(threadId)} on a machine, which opens threads and forks machines under its own root and reads that tree`;
}

/** The workspace an event is about, for the one reading every door that hides a workspace from a caller shares: the
 * id on the event itself, else the id of the record or the status it carries. An event that names none is about
 * this host rather than about any workspace, which is why a caller that may see only its own tree is sent none. */
export function workspaceIdOf(event: unknown): string | undefined {
  const e = event as { workspaceId?: unknown; workspace?: { id?: unknown }; status?: { id?: unknown }; forward?: { workspaceId?: unknown } };
  for (const found of [e.workspaceId, e.workspace?.id, e.status?.id, e.forward?.workspaceId]) if (typeof found === "string") return found;
  return undefined;
}

/** The thread an event is on behalf of, beside the reading above and for the same door: an event about a workspace
 * that has no record yet is nobody's by the reading above, so the caller it was asked for by is named on it. */
export function askerOf(event: unknown): EventAsker | undefined {
  const asked = (event as { askedBy?: { threadId?: unknown; rootThreadId?: unknown } }).askedBy;
  if (typeof asked?.threadId !== "string" || typeof asked.rootThreadId !== "string") return undefined;
  return { threadId: asked.threadId, rootThreadId: asked.rootThreadId };
}
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
export const SessionInterruptResult = z.object({
  outcome: SessionInterruptOutcome,
  /** The threads under this one that were running and were stopped with it, by id: a root thread and the tree its
   * agents spawned stop as one, since a lead left standing while its builders are cut is neither state. Absent
   * where the thread spawned none that were running. */
  under: z.array(z.string()).optional(),
});
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

/** What Settings > Image and `wsp image` draw: the record, every copy at every place, the project goldens under it.
 * Beside ProjectGolden because it carries them; the rest of the image shapes sit with the golden ones above. */
export const SealedImageView = z.object({
  image: SealedImage.nullable(),
  copies: z.array(SealedImageCopy),
  projects: z.array(ProjectGolden),
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

export { threadState, threadStateWord, threadWordOf, type ThreadState } from "./thread-state.js";
export { actionRefusal, agentsKindRefusal, agentsMayDrive, computerOffline, deleteNotice, goneRefusal, MACHINE_LEFT, screenCommandLine, type ImageMoveInput, imageMoveRefusal, isBilling, isLocalWorkspace, type KindReading, kindWords, readingRoad, type ReadingRoad, type MachineOnDelete, machineWord, needsRebuild, NO_REBUILD_NEEDED, reachShown, SEND_BLOCK_WORDS, type SendBlock, sendRefusal, signInRefusalLine, signInRoad, type SendRefusalKind, servesReading, WORKSPACE_KIND_WORDS, workspaceKind, type WorkspaceKindWords, workspaceState, type WorkspaceState, type WorkspaceStateInput, workspaceStateOf, workspaceWord } from "./workspace-state.js";
export * from "./exit.js";
export * from "./format.js";
export { psCpuSeconds } from "./ps-time.js";
export { compareVersions } from "./semver.mjs";
export { IMAGES_AFTER_TURN, IMAGES_MAX, IMAGE_ACCEPT, IMAGE_MAX_BYTES, IMAGE_MAX_WORDS, IMAGE_TYPES, IMAGE_TYPE_WORDS, ImageAttachment, ImageRecord, imageBytes, imageLine, imagePathIn, imageRecord, imageTypeOf, imagesBlocked, imagesRefusal, noImagesLine, notAFileLine, notAnImageLine, threadImagesDir, turnImagesDir } from "./attachments.js";
export * from "./oom.js";
export { appendCostPoint, COST_HISTORY_CAP } from "./cost-history.js";
export { ThreadMessage, threadMessages, threadReplyRows, threadResult, ThreadVoice } from "./thread-read.js";
export { inFolder, shellLine, shellQuote } from "./shell-quote.js";
export {
  DEFAULT_THEME,
  INK_FLOOR,
  LOOK_PARTS,
  SIDE_INK,
  THEME_GRAIN_STEPS,
  THEME_HARMONIES,
  THEME_MAX_DOTS,
  THEME_MIN_OPACITY,
  THEME_PRESETS,
  WORD_FLOOR,
  ThemeDot,
  ThemeHarmony,
  ThemeMode,
  WORKSPACE_GLYPHS,
  WorkspaceGlyph,
  WorkspaceLook,
  WorkspaceTheme,
  applyPreset,
  contrastRatio,
  cycleHarmony,
  dotColour,
  effectiveOpacity,
  harmoniesOf,
  harmonyDots,
  harmonySize,
  hslToRgb,
  isPreset,
  moveFirstDot,
  opacityCap,
  resizeDots,
  rgbToHsl,
  snapGrain,
  themeInk,
  themeScheme,
  type LookPart,
  type Rgb,
  type ThemePreset,
} from "./workspace-look.js";
export { folderName, parentFolderName, placeDaemonPaths, placeOwnedPaths, rootsPathIn, sshDaemonPaths, underProject, workFolderIn } from "./project-path.js";
export * from "./daemon-contract.js";
export * from "./projects.js";
export { agentsRequest, canTravel, consentRequest, defaultAgents, defaultConsent, importConsented, importDest, importRequest, registerRequest, secretOffer, type ImportAnswers, type ProjectImportRequest } from "./project-import.js";
export { addressFromHash, appHash, workspaceHash, type AppAddress } from "./app-address.js";
export * from "./app-ports.js";
export * from "./init-job.js";
export { catalogRefused, endAfterResult, endRun, PERMISSION_ALLOW, PERMISSION_DENY } from "./adapter-port.js";
export { FAKE_AS_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, LABS_ENV, PERSON_HOME_ENV, TURN_TOKEN_ENV, WEB_DIR_ENV } from "./env.js";
export type { AdapterAttachOptions, AdapterEvent, AttachmentRoad, ExecStream, ExecStreamFactory, HarnessCatalogAnswer, HarnessCatalogModelProbe, HarnessCatalogProbe, HarnessCatalogRefusal, PermissionAsk, SessionRenameWrite, SessionRenamer, SessionTitleMaker, SessionTitleReader, TitleTurn, TurnImage } from "./adapter-port.js";
