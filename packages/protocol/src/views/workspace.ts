// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { CarryModule as WireCarryModule } from "../generated/CarryModule.js";
import type { FoundModule as WireFoundModule } from "../generated/FoundModule.js";
import { WorkspaceKind } from "./workspace-kind.js";
import type { WorktreeReport as WireWorktreeReport } from "../generated/WorktreeReport.js";
import type { WorktreeRemoval as WireWorktreeRemoval } from "../generated/WorktreeRemoval.js";
import { Checkout } from "../changes.js";
import { TreeFact } from "../tree.js";
import { PullRequestSeen } from "../pull-request.js";
import { ReviewDraft, WorkspaceFrom } from "../start.js";
import { AGENTS_ON } from "../place-state.js";
import { WorkspaceGlyph, WorkspaceTheme } from "../workspace-look.js";
import type { Held, Same } from "../wire/helpers.js";
import { WorkspaceSize } from "../wire/capabilities.js";

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

/** What a path git ignores is to a seed of the folder it sits in, as the catalog's own rows judge it: config
 * travels, rebuilt is what the computer makes again, data is a database, never is a login that does not leave this
 * computer whatever is ticked, and unknown is a path no row names. The catalog's junk kind reaches no menu, so it
 * is not here. */
export const SeedKind = z.enum(["config", "rebuilt", "data", "never", "unknown"]);
export type SeedKind = z.infer<typeof SeedKind>;

/** One row of the seed menu: a path git ignores in the folder, relative to it and collapsed to the directory where
 * the whole directory is ignored, with its size, the catalog row and kind that judged it, and whether it starts
 * ticked. */
export const SeedFile = z.object({
  path: z.string(),
  dir: z.boolean(),
  bytes: z.number().int().nonnegative(),
  kind: SeedKind,
  /** The catalog row's id and name; absent on unknown. */
  row: z.object({ id: z.string(), name: z.string() }).optional(),
  ticked: z.boolean(),
});
export type SeedFile = z.infer<typeof SeedFile>;

/** What seeding a project from this folder would carry, for the person to read before anything leaves this
 * computer. Nothing here is a file's content: the plan is names, sizes and counts. */
export const SeedPlan = z.object({
  /** The folder on this computer, resolved. */
  source: z.string(),
  /** The remote the computer clones, origin's URL; null where the folder has none, which refuses the add. */
  remote: z.string().nullable(),
  /** The branch the folder is on, and the branch the remote's own HEAD names. */
  branch: z.string(),
  defaultBranch: z.string().nullable(),
  /** Commits on the branch the remote does not have, with the commit they start from; null when there are none. */
  unpushed: z.object({ commits: z.number().int(), base: z.string() }).nullable(),
  /** Changed or untracked files that stay on this computer: the menu says how many and the seed carries none. */
  uncommitted: z.number().int().nonnegative(),
  /** Claude Code's memory folder for this folder here, with the key it sits under; null where there is none. */
  memory: z.object({ key: z.string(), files: z.number().int(), bytes: z.number().int() }).nullable(),
  files: z.array(SeedFile),
  /** The ticks came from a choice remembered for this folder rather than from the catalog's own defaults. */
  remembered: z.boolean(),
});
export type SeedPlan = z.infer<typeof SeedPlan>;

/** What the person chose off the menu: the paths that travel, the memory folder, the unpushed commits as a patch,
 * and whether the choice is kept for the next add of this folder. */
export const SeedChoice = z.object({
  files: z.array(z.string()),
  memory: z.boolean(),
  commits: z.boolean(),
  remember: z.boolean().optional(),
});
export type SeedChoice = z.infer<typeof SeedChoice>;

/** How far an add has got. In order: planned, the folder read or the remote resolved; cloning, on the computer;
 * seeding, the chosen files landed there; installing, the lockfile's own install run once; imaging, the machine
 * snapshotted as the project's image, which only a provider computer does; done. failed ends one that threw. */
export const ProjectAddStage = z.enum(["planned", "cloning", "seeding", "installing", "imaging", "done", "failed"]);
export type ProjectAddStage = z.infer<typeof ProjectAddStage>;

/** Where a project's code comes from, as the computer it lives on sees it: a folder that computer holds, or a repo
 * it clones. Which of the two a computer takes is its kind's own row (projectSources), so no road guesses. */
export const ProjectSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("folder"), path: z.string() }),
  z.object({ kind: z.literal("git"), url: z.string() }),
  /** owner/repo on a host whose signed-in command line the computer's image carries: the clone goes through that
   * command, so a private repo needs no key of the person's on the box. */
  z.object({ kind: z.literal("github"), repo: z.string() }),
  z.object({ kind: z.literal("gitlab"), repo: z.string() }),
]);
export type ProjectSource = z.infer<typeof ProjectSource>;

/** A project: one computer, one source that computer can see, and the branch a workspace of it starts on. Its own
 * record, not a folder inside a workspace: a workspace is a copy of this computer with this project in it. */
export const ProjectView = z.object({
  id: z.string(),
  /** The folder's name, or the repo's last word without .git; --name overrides. */
  name: z.string(),
  /** An id off places.list: this computer, a computer somebody joined, or a provider account. */
  computer: z.string(),
  source: ProjectSource,
  /** Where the checkout sits inside a workspace of it: the folder itself on this computer, and under the folder
   * the landing road for that computer names where the computer cloned it. Written once at the add. */
  path: z.string(),
  /** The remote the computer cloned, or the seed folder's own origin: written once at the add and never read again
   * to decide anything, so a remote renamed later changes nothing about a project that already stands. */
  remote: z.string(),
  /** The branch the remote's HEAD named at the add. */
  defaultBranch: z.string(),
  /** The value of every agent's project key variable in every workspace of this project: the seed folder's own key
   * on this Mac when it was seeded from one, else the key of the path on the computer. It is fixed at the add, so a
   * project's memory and sessions key on the project rather than on wherever its checkout sits. */
  memoryKey: z.string(),
  /** Where the project's memory lives on the computer holding it, which every workspace of it reads: the folder
   * itself on this Mac, a folder of wsp's own on a computer that clones. */
  memoryDir: z.string(),
  /** Where the checkout sits on the computer holding it, outside every workspace of it: a folder of wsp's own on
   * a computer that cloned it there, which every workspace of the project takes its own copy of. Absent where the
   * computer keeps the project inside an image instead, and where the project is worked where it already sits. */
  checkout: z.string().optional(),
  /** What the seed carried, once, where the source was a folder on this computer. */
  seeded: z
    .object({
      files: z.number().int(),
      /** The bytes of the files that were ticked, which is the sum the menu showed; never the archive's own size,
       * which is bigger and is nobody's question. */
      bytes: z.number().int(),
      /** What the memory did, in one word: landed on that computer, kept because the agent there already had its
       * own for this project and no memory is ever written over, or none travelled at all. */
      memory: z.enum(["landed", "kept", "none"]),
      /** How many files the memory folder held, the menu's own count; absent where none travelled. */
      memoryFiles: z.number().int().optional(),
      commits: z.number().int(),
      at: z.string(),
    })
    .optional(),
  /** What the install ran and how long it took, once; absent where no catalog row named an install for this repo. */
  installed: z.object({ row: z.string(), command: z.string(), at: z.string(), seconds: z.number() }).optional(),
  /** On a provider computer: the project image every workspace of this project forks from. */
  image: z.object({ snapshotId: z.string(), builtAt: z.string(), lockfileSha: z.string().optional() }).optional(),
  /** The branch a new workspace starts on; absent is the remote's default branch, read at the clone. */
  base: z.string().optional(),
  /** On this computer, the repo the folder sits in: its top folder, which is the folder itself or a folder above it
   * when the project is a subfolder of a repo. Absent on a folder that is not a git repo, which has no branches. */
  git: z.object({ top: z.string() }).optional(),
  createdAt: z.string(),
});
export type ProjectView = z.infer<typeof ProjectView>;

/** The branch a new thread of a project starts on, read when asked: where its threads work in the folder itself (this
 * computer, a box) the branch that folder has checked out now, null on a detached head or a folder git holds no repo
 * in; on a computer that forks a copy, the branch a new copy starts from, off the record. */
export const ProjectBranch = z.object({ branch: z.string().nullable(), folder: z.boolean() });
export type ProjectBranch = z.infer<typeof ProjectBranch>;

/** The project a workspace holds, joined onto the view by the runtime from the record's project id: what every row
 * that names a workspace's project reads, without a second fetch of the projects list. */
export const ProjectRef = ProjectView.pick({ id: true, name: true, path: true, computer: true });
export type ProjectRef = z.infer<typeof ProjectRef>;

export { WorkspaceKind };

/** Which machine a daemon's own cpu, memory and process readings describe: a computer somebody joined is a place,
 * and its daemon reads that box for the person sitting at it and for every thread in a folder on it. */
export const DaemonKind = WorkspaceKind;
export type DaemonKind = z.infer<typeof DaemonKind>;

/** Where a request to a workspace verb came from: here, this computer's own app, CLI or MCP; relayed from a
 * machine wsp runs; or paired, a computer of the person's own that holds a device token of this host. A local
 * workspace is driven by `here` alone and starts a process for nothing else, since a command, a thread or a shell
 * pane on it runs under the person's own login on this computer. The host stamps the word off the road a request
 * arrived on, so nothing a client sends decides it. */
export const WorkspaceOrigin = z.enum(["here", "relayed", "paired"]);
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
 * machine's turn sent it out of. A bare word is one of the three roads and says nothing about who; the object is a
 * socket the host authed on a thread scoped token, and the scope is the host's own reading of that token, never
 * the client's. Read it through `roadOf` and `scopeOf` so no verb decides for itself what the shape means. */
export type Caller = WorkspaceOrigin | { origin: WorkspaceOrigin; by: ThreadScope };

/** Which road a caller came in by. */
export const roadOf = (caller: Caller | undefined): WorkspaceOrigin | undefined => (typeof caller === "string" ? caller : caller?.origin);

/** The thread a caller is, when it is one. */
export const scopeOf = (caller: Caller | undefined): ThreadScope | undefined => (typeof caller === "string" ? undefined : caller?.by);

/** What a workspace lets the agents inside it do to this host. Absent on the record reads AGENTS_ON: a thread the
 * person starts may start threads and machines under the caps, and only a switch the person turned off refuses. */
export const WorkspaceAgents = z.object({
  /** Whether a thread on this workspace may open threads and fork machines; every turn carries its token either way. */
  spawn: z.boolean(),
  /** How many machines may stand at once under one root thread, counted off the records. */
  maxMachines: z.number().int().min(0),
  /** How deep the tree under a root thread may go: 1 is the root's own children and no further. */
  maxDepth: z.number().int().min(1),
});
export type WorkspaceAgents = z.infer<typeof WorkspaceAgents>;

/** Which road made a workspace's copy on a computer that copies by directory: a directory clone of the project
 * folder or a git worktree of it. Every workspace on such a computer is a copy, from the first piece of work on. */
export const CopyRoad = z.enum(["clonefile", "worktree"]);
export type CopyRoad = z.infer<typeof CopyRoad>;

/** What rode along in the copy: everything the folder held that git ignores, so the dependencies are there and a
 * build runs at once; the config files alone, so the dependencies install first; or nothing. */
export const Carried = z.enum(["deps-and-config", "config-only", "nothing"]);
export type Carried = z.infer<typeof Carried>;

/** One copy as the daemon binary's copy verb is asked for it. The size line rides rather than living in the
 * daemon: the number is the host's to change in one place, and a copy asked for by a test names a small one to
 * take the fallback road. */
export const CopyAsk = z.object({
  from: z.string(),
  to: z.string(),
  /** The ref the copy is reset to; the folder's default branch when absent. */
  base: z.string().optional(),
  /** Directories removed after the copy so they rebuild at the new path. */
  exclude: z.array(z.string()),
  /** Apparent size above which the directory clone is not taken. */
  sizeLineBytes: z.number().int().nonnegative(),
  /** A road named outright; the verb's own pick when absent. */
  road: CopyRoad.optional(),
});
export type CopyAsk = z.infer<typeof CopyAsk>;

/** What the daemon binary's copy verb printed, read back by the host and kept on the workspace's record as
 * `copy`. */
export const CopyReport = z.object({
  road: CopyRoad,
  path: z.string(),
  base: z.string(),
  branch: z.string(),
  fetched: z.boolean(),
  carried: Carried,
  excluded: z.array(z.string()),
  /** The rows the exclusion left standing and why: a path it could not walk without following a link, so nothing
   * under it was removed. Absent where every row it was given went. */
  skipped: z.array(z.string()).optional(),
  bytes: z.number().int().nonnegative(),
  ms: z.number().int().nonnegative(),
  fellBack: z.string().optional(),
});
export type CopyReport = z.infer<typeof CopyReport>;

/** One ecosystem as the worktree verb is handed it: the lockfiles that pick it in whatever folder of a new worktree
 * holds one, the ignored directories under that folder it then takes from the project folder, the ones it never
 * takes, which hold the path they were built at, and where its install leaves a copy of the lockfile it installed
 * from, relative to the lockfile's folder. */
export const CarryModule = z.object({ id: z.string(), lockfiles: z.array(z.string()), carry: z.array(z.string()), never: z.array(z.string()), installed: z.string().optional() });
export type CarryModule = WireCarryModule;
type CarryModuleHeld = Held<Same<z.infer<typeof CarryModule>, CarryModule>>;

/** A wsp worktree as the daemon binary's worktree verb is asked for it: the project's repo, the host's own folder its
 * worktrees live under, the project's id the path is keyed by, the branch, and the ecosystems whose directories a new
 * worktree carries in beside the config files. */
export const WorktreeAsk = z.object({
  from: z.string(),
  home: z.string(),
  project: z.string(),
  branch: z.string(),
  modules: z.array(CarryModule),
});
export type WorktreeAsk = z.infer<typeof WorktreeAsk>;

/** What a workspace on a computer that copies by directory is made of: the road that made the copy, where it
 * landed, what it stands on and what rode along. Absent on a fork and on a box snapshot, whose project arrives by
 * the runtime's own road. */
export const ProjectCopy = CopyReport.pick({ path: true, base: true, branch: true, carried: true, fellBack: true }).extend({
  road: CopyRoad,
  /** The project folder the copy was taken from: what a worktree's remove needs and what the row names. */
  source: z.string(),
});
export type ProjectCopy = z.infer<typeof ProjectCopy>;

/** Why a wsp worktree's branch counts as done: its pull request merged or closed, the remote no longer holds the
 * branch it was pushed to, or the person removed the worktree. */
export const WorktreeSettled = z.object({ at: z.number(), why: z.enum(["merged", "closed", "deleted", "removed"]) });
export type WorktreeSettled = z.infer<typeof WorktreeSettled>;

/** A worktree of the project's repo threads run in on this computer. made: wsp added it under its own folder, and
 * only such a worktree is ever removed by wsp; one the person or an agent made is used and left alone. kept says why
 * a settled worktree still stands, removeFailed is git's own line when a removal was refused, and gone marks one
 * that is no longer on disk, whose threads continue in the project folder. madeFor is the root thread a thread's
 * start made it for, whose tree reaches it as a fork the tree made. */
export const WorktreeFolder = z.object({
  path: z.string(),
  branch: z.string().optional(),
  made: z.boolean(),
  madeFor: z.string().optional(),
  settled: WorktreeSettled.optional(),
  kept: z.string().optional(),
  removeFailed: z.string().optional(),
  gone: z.literal(true).optional(),
});
export type WorktreeFolder = z.infer<typeof WorktreeFolder>;

/** One module whose lockfile a folder of a new worktree holds: the folder, `.` for the worktree's top, and whether its
 * install runs there. */
export const FoundModule = z.object({ id: z.string(), folder: z.string(), rebuild: z.boolean() });
export type FoundModule = WireFoundModule;
type FoundModuleHeld = Held<Same<z.infer<typeof FoundModule>, FoundModule>>;

/** What the daemon binary's `copy worktree` printed: the worktree a thread on the branch works in, whether wsp made
 * it (under the host's folder or a volume's own `.wsp`), what was carried in when this call made it, which carried
 * directories a clone could not take and which are overlays, whether this call made it, and each folder of it
 * holding a module's lockfile. */
export const WorktreeReport = z.object({
  path: z.string(),
  branch: z.string(),
  made: z.boolean(),
  carried: z.array(z.string()),
  plain: z.array(z.string()).optional(),
  overlaid: z.array(z.string()).optional(),
  fresh: z.boolean(),
  modules: z.array(FoundModule),
  ms: z.number().int().nonnegative(),
});
export type WorktreeReport = WireWorktreeReport;
type WorktreeReportHeld = Held<Same<z.infer<typeof WorktreeReport>, WorktreeReport>>;

/** What `copy worktree-remove` printed once the worktree went: its path, and the ref a detached one's commit was saved to. */
export const WorktreeRemoval = z.object({ path: z.string(), rescued: z.string().optional() });
export type WorktreeRemoval = WireWorktreeRemoval;
type WorktreeRemovalHeld = Held<Same<z.infer<typeof WorktreeRemoval>, WorktreeRemoval>>;

/** A worktree as wsp worktree answers it: where the branch is checked out and whether wsp made that worktree. */
export const WorktreeMade = WorktreeReport.pick({ path: true, branch: true, made: true });
export type WorktreeMade = z.infer<typeof WorktreeMade>;

/** The switch a patch leaves on the record, the one rule both roads that set one read: every key the patch does not
 * name keeps what the record holds, so turning it off and on again does not throw the caps away, and a workspace
 * that never had one starts from the default. */
export function agentsFrom(held: WorkspaceAgents | undefined, patch: Partial<WorkspaceAgents>): WorkspaceAgents {
  return { ...(held ?? AGENTS_ON), ...patch };
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
  /** The one project this workspace was made for, joined from its record's project id. A workspace holds exactly
   * one; the computer it runs on is that project's. */
  project: ProjectRef,
  /** The folder a thread or a command starts in when no project does, the last branch of the runtime's default folder
   * rule: the kind's own (the work folder on this computer). Absent where the kind names none and the machine's own
   * home is where the shell lands (a fork). Published so a client shows what the runtime will do. */
  folder: z.string().optional(),
  /** The machine's own home, where its shell shortens paths to `~`: /root on a fork, the person's home on this
   * computer. Absent where the kind has not read one. */
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
  /** What the agents on this workspace may ask of this host, read off the root of its tree; a workspace whose root this
   * host no longer holds carries none, and spawns nothing. */
  agents: WorkspaceAgents.optional(),
  /** The thread that forked this workspace, and the thread at the top of that thread's tree; absent on every
   * workspace a person made. The root is what the machine cap counts against. */
  parentThreadId: z.string().optional(),
  rootThreadId: z.string().optional(),
  /** The workspace this one was forked out of, by id; absent on every workspace that is not a fork of another. A
   * child holds the same project as its parent and starts on the branch the parent was on, and its work goes back
   * into that branch. */
  parentWorkspaceId: z.string().optional(),
  /** The place a fork lives on, by id; absent on a fork at the host's own provider and on every workspace that is
   * not a fork. The command line and the app show its name after the workspace's. */
  place: z.string().optional(),
  /** On this computer, the worktree of the project's repo this record's threads run in; absent on the record of
   * the project folder itself and on every fork. */
  worktree: WorktreeFolder.optional(),
  /** Which provider this workspace's machine was forked at, by the id that provider's own module carries in a
   * registry (`solari`, `box`, `docker`): the host's own where it forked the machine, and the joined computer's
   * own offer where `place` names one, so the two fields cannot disagree about where a machine lives. The runtime
   * stamps it; absent on every kind wsp does not fork, whose machine is the person's own, and on a place this host
   * has not yet heard what it forks with. A row names this where it would otherwise have only the provider's
   * opaque id for the machine. */
  provider: z.string().optional(),
  /** Where the work came from where it started off an issue or a pull request, or is a review of one. */
  from: WorkspaceFrom.optional(),
  /** A review workspace's review as the person shapes it before Post, read off the reviewer's reply. */
  review: ReviewDraft.optional(),
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
  /** Why the runtime pushed this status outside the poll: a wake that had to retry or failed, or "idle 20 min". */
  reason: z.string().optional(),
  /** Which ask a wake the provider has not taken is on, of the ones the host will make; absent unless the host is
   * asking again on its own. The numbers ride, never a sentence: the row and the Machine tab read the same
   * `wakeAskingAgainLine` at different lengths, and a line built here would fit one of them and be cut in the other. */
  wakeAsk: z.object({ ask: z.number(), of: z.number() }).optional(),
  /** Epoch ms when the runtime's idle policy naps this workspace; absent while napping, held by a running session, or with auto-nap off. */
  idleAt: z.number().optional(),
  /** The copy's checkout as the host last read it, at a turn's end, on view, after a write and every few seconds while
   * a composer about to open a thread on it shows; absent until git has answered once. */
  checkout: Checkout.optional(),
  /** The workspace's pull request as the host last read it through the git host's command line on this computer, or
   * the one sentence saying why it could not; absent where its branch has none. */
  pr: PullRequestSeen.optional(),
  /** The workspace's children as the host last read them, at each child's turn end, after a child's bring back or a
   * merge into this workspace and when its thread opens, never on a timer; absent on a workspace with none. */
  tree: TreeFact.optional(),
});
export type WorkspaceStatus = z.infer<typeof WorkspaceStatus>;

/** Every field of a workspace's view that a door outside the app's own status socket hands over: the record's own
 * facts, and nothing the provider minted. Picked rather than omitted, so a route added to the view later is not
 * handed over by having been forgotten, which is how the display stream rode these doors until now. */
const WORKSPACE_OUT = {
  id: true, name: true, machineId: true, phase: true, kind: true, golden: true, createdAt: true, project: true, folder: true, home: true,
  claudeSessionId: true, gone: true, theme: true, glyph: true, daemonNote: true, daemonRefusedAt: true, vaultedAt: true, vaultRefused: true, wakeRefused: true,
  agents: true, parentThreadId: true, rootThreadId: true, parentWorkspaceId: true, place: true, provider: true, worktree: true, from: true, review: true,
} as const;

/** A workspace as every verb answers with it: the view without the display stream a desktop machine carries, which
 * is the provider's own route with its own bearer on it. A relayed caller drives every cloud record and an agent's
 * transcript leaves the computer, so no door but the app's status socket hands one over. */
export const WorkspaceOut = WorkspaceView.pick(WORKSPACE_OUT);
export type WorkspaceOut = z.infer<typeof WorkspaceOut>;

/** A workspace as a thread on a computer the person joined is told it when it names one its tree stands on elsewhere,
 * on the way to a message into that thread: what the send reads to name and wake it, and nothing of the folder, the
 * home or the sessions there, which are the person's. Picked as WORKSPACE_OUT is, and a WorkspaceOut still. */
export const WorkspaceTalked = WorkspaceView.pick({ id: true, name: true, machineId: true, phase: true, kind: true, golden: true, createdAt: true, project: true, gone: true });
export type WorkspaceTalked = z.infer<typeof WorkspaceTalked>;

/** A workspace as the command line and the MCP tool list it: the same fields with what the rail reads live beside
 * them, and the reach without the route it carries, since a table needs the state word and nothing that opens a
 * machine. Parsing a status through it is what drops the routes; the app's own socket still gets both. */
export const WorkspaceListing = WorkspaceStatus.pick({ ...WORKSPACE_OUT, machineState: true, size: true, rateUsdPerHour: true, reason: true, idleAt: true, facts: true }).extend({ reach: ReachView });
export type WorkspaceListing = z.infer<typeof WorkspaceListing>;

