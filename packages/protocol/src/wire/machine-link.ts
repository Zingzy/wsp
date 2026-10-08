// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { THIS_COMPUTER } from "../format.js";
import { plural } from "../words/base.js";
import type { SysHistoryReply as WireSysHistoryReply } from "../generated/SysHistoryReply.js";
import type { SysPoint as WireSysPoint } from "../generated/SysPoint.js";
import type { UsageLogsReply as WireUsageLogsReply } from "../generated/UsageLogsReply.js";
import { HERE_PLACE_ID } from "../place-word.js";
import { type Held, reqId, type Same } from "./helpers.js";
import { EXEC_BODY_MAX, isPlainPath } from "./limits.js";
import { Capabilities, PlaceCapacity, WorkspaceSize } from "./capabilities.js";
import { MachineFacts, MachineState } from "../views/workspace.js";
import { MachineKind } from "../views/golden-image.js";
import { MachineBind, MachineShare, WorkspaceCopy } from "../views/place.js";
import { ProcEntry } from "./daemon.js";
import type { PlaceReport } from "./place-link.js";

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
  /** The machine gets the place's container engine through its daemon's fenced socket, so a project's own docker
   * compose runs inside it and sees its own containers alone; a place with no engine refuses the create. Absent is
   * no socket. */
  engine: z.boolean().optional(),
  /** The project this workspace is made with, on a computer the person owns. */
  copy: WorkspaceCopy.optional(),
  /** The logins that computer holds for every workspace on it, mounted into this one. Absent shares none. */
  shares: z.array(MachineShare).optional(),
  /** Folders on the computer bound into the workspace at create, read-write unless the bind says otherwise: a
   * project's memory folder rides this, so every workspace of one project reads and writes the same memory on the
   * computer holding it. A bind whose source is not a directory the computer holds is refused there. */
  binds: z.array(MachineBind).optional(),
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
  /** What the machine has written since it booted, where the backend can read that off the disk itself rather than
   * through df inside, which on a container reads the box's whole disk. */
  usedBytes: z.number().int().nonnegative().optional(),
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
  /** The size the snapshot restores to, which is an image's size, where the provider reports one. A provider that
   * stores a snapshot as what changed since another bills on that change, so sizeBytes is not this; absent, the
   * image's size is unknown and nothing stands in for it. */
  restoredBytes: z.number().optional(),
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
  /** How many times a wake may resume the machine and check it before the wake fails. Each attempt after
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
  /** Where this computer keeps the logins every workspace on it shares, absolute; absent from a backend that
   * shares none, which is every provider, since a machine somebody else runs holds no file of this person's. */
  logins: z.string().min(1).refine(isPlainPath, "an absolute path on the computer").optional(),
  /** Where this computer keeps the project checkouts it holds and each project's own memory, absolute; absent from
   * a backend that keeps none, which is every provider, where a project lives in an image instead. */
  projects: z.string().min(1).refine(isPlainPath, "an absolute path on the computer").optional(),
});
export type BackendFacts = z.infer<typeof BackendFacts>;

/** One machine as the place hands it over: the handle's fields, and which optional roads the handle carries, so the
 * client builds a machine whose optional methods are present exactly where the place's are. Where a fork dials the
 * host is not among them: the place's answer names the place, and a fork on it dials the address the host
 * advertises. */
export const MachineHandle = z.object({
  id: z.string(),
  kind: MachineKind,
  streamUrl: z.string().optional(),
  labels: z.record(z.string()).optional(),
  seen: z.object({ state: MachineState, createdAt: z.string().optional() }).optional(),
  replayed: z.boolean().optional(),
  daemonSupervisor: DaemonSupervisor.optional(),
  /** One sentence on a create whose size the computer would not give as asked, naming what it gave instead. The
   * handle carries the size itself nowhere, so this is the whole of what the person is told, said once. */
  notice: z.string().optional(),
  roads: z.object({ previewUrl: z.boolean(), daemonAnswers: z.boolean(), putBytes: z.boolean(), describe: z.boolean(), facts: z.boolean(), metrics: z.boolean() }),
});
export type MachineHandle = z.infer<typeof MachineHandle>;

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
  z.object({ id: reqId, op: z.literal("machine.exec"), machineId: z.string(), cmd: z.string().max(EXEC_BODY_MAX), timeoutMs: z.number().int().positive().optional(), stdin: z.string().optional() }),
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
export const MachineStateReply = z.object({ state: MachineState });
export const MachineShapeReply = z.object({ shape: MachineShape });
/** One workspace as the computer running it reads it, in one frame: the sizes its cgroup was written with, what it
 * holds of them now, and where its processes, its files and its address are. Every figure is read at the moment of
 * the ask rather than sampled, so a row drawn from it is true of that moment and of no moment since; a workspace
 * that is not running carries the sizes and the paths and none of the live figures. cpuUsageUsec is the processor
 * time the workspace has spent since it booted, so a rate is the difference between two readings. */
export const MachineReading = z.object({
  state: MachineState,
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  memBytes: z.number().int().nonnegative().optional(),
  cpuUsageUsec: z.number().int().nonnegative().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  procs: z.number().int().nonnegative().optional(),
  /** How long the computer running it has seen it do nothing on its own: no byte through a published port and no
   * command run in it. Counted from its boot, so one nothing has asked anything of reads its whole life. Absent
   * from a workspace that is not running, and from a computer that cannot say. */
  quietForMs: z.number().int().nonnegative().optional(),
  address: z.string().optional(),
  cgroup: z.string(),
  upper: z.string(),
});
export type MachineReading = z.infer<typeof MachineReading>;
export const MachineReadingReply = z.object({ reading: MachineReading });
export const MachineFactsReply = z.object({ facts: MachineFacts });
export const MachineAnswersReply = z.object({ answers: z.boolean() });
/** The route on the place's own loopback; the host turns it into a route of its own with a forward. */
export const MachineReachReply = z.object({ reach: PreviewReach });
export const MachineUrlReply = z.object({ url: z.string() });

/** What an op meant for the link a computer opened to its host answers on any other socket: the leave op, which
 * takes this computer out of a wsp, and every machine op, which drives the Docker daemon behind it. One sentence,
 * since it is one rule: a client holding this daemon's token is a client on this machine, and a client on this
 * machine neither un-joins it nor forks on it. */
export const NOT_ON_THIS_ROAD = "not on this road";

/** What a create naming a template or a snapshot is refused with on a computer somebody joined, and what a road
 * above answers for a saved image there without asking: a workspace on such a computer is made from that
 * computer's own directories and a copy of a checkout on it, so there is nothing to pull and nothing to build. */
export const NO_IMAGES_HERE = "this computer keeps no images: a workspace here is a copy of the computer itself";

/** What a fork is refused with when the place it lands on answers that it holds no copy of the snapshot named. A
 * fork builds the copy it needs only of the image's current version, so this is an older version or a project's
 * image named at a place it was never built at. */
export const placeHoldsNoImageLine = (place: string, image: string): string =>
  `${place} holds no copy of ${image}; a fork there builds a copy first only of your image's current version`;

/** What a remove of a computer is refused with while a fork or a project there holds work no remote has, each named
 * with what it holds, a project folder by its checkout's path there: the roads that keep it, and the flag that takes
 * it anyway. */
export const placeUnsavedRefusal = (place: string, unsaved: readonly string[]): { said: string; fix: string } => ({
  said: `${place} holds work no remote has, which a remove would lose: ${unsaved.join("; ")}`,
  fix: `Keep a fork's work with wsp export or by pushing its branch, and copy a project folder's off ${place} from the path named; then remove ${place} again, or wsp remove ${place} --force removes it anyway.`,
});

/** What a remove of a computer is refused with while a fork or a project stands on it and its link is down: the forks
 * are deleted and the project folders read over that link, so nothing about them can be done or known until it is back. */
export const placeAwayRefusal = (place: string, sentence: string): { said: string; fix: string } => ({
  said: `${sentence}, and its forks and projects go over its link`,
  fix: `Turn ${place} on and remove it again once it answers.`,
});

/** What a remove that stopped part way through the forks and projects on a computer says: why, and which of them had
 * already gone, since those are not coming back. */
export const placeDropStoppedLine = (why: string, went: readonly string[]): string => (went.length === 0 ? why : `${why}; ${went.join(", ")} had already gone with the remove`);

/** What a remove of a project is refused with while its checkout on a computer of the person's holds work no remote
 * has, named by its path there. */
export const projectUnsavedRefusal = (project: string, unsaved: string): { said: string; fix: string } => ({
  said: `${unsaved}, which removing ${project} would lose`,
  fix: `Copy that work off its computer from the path named or push its branches, then remove ${project} again; wsp projects remove ${project} --force removes it anyway.`,
});

/** How an unsaved read names a project folder: by its project and the checkout's path on the computer holding it,
 * which is where a person goes to keep what is there. */
export const projectFolderNamed = (project: string, checkout: string): string => `${project} at ${checkout}`;

/** What goes with a computer, the one sentence its remove asks with and answers with: its forks deleted, its projects
 * out of this wsp, each with its threads. Nothing where it holds neither. */
export function placeHoldsLine(held: { forks: readonly { name: string; threads: number }[]; projects: readonly { name: string; threads: number }[] }): string | undefined {
  const part = (rows: readonly { name: string; threads: number }[], noun: string): string | undefined => {
    if (rows.length === 0) return undefined;
    const threads = rows.reduce((sum, r) => sum + r.threads, 0);
    const named = `${rows.length === 1 ? noun : `${rows.length} ${noun}s`} ${rows.map(r => r.name).join(", ")}`;
    return threads === 0 ? named : `${named} with ${plural(threads, "thread")}`;
  };
  const forks = part(held.forks, "fork");
  const projects = part(held.projects, "project");
  if (forks === undefined && projects === undefined) return undefined;
  return [forks === undefined ? undefined : `its ${forks} deleted`, projects === undefined ? undefined : `its ${projects} out of this wsp`].filter(p => p !== undefined).join(", and ");
}

/** What a fork aimed at a place this host no longer holds a record for is refused with. Every computer on the
 * list forks, so the only way to reach this is a record that went between the word being read and the fork being
 * asked for: a remove, or a store another process wrote. */
export const placeForksNowhereLine = (place: string): string => `${place} is no longer a place in this wsp, so nothing forks there`;

/** What a verb aimed at the bare computer a place is, rather than at a workspace forked on it, is refused with. A
 * place holds its facts and its forks; the forks are the workspaces, so the refusal names the computer and the one
 * road to a workspace there. */
export const placeNotAWorkspaceLine = (place: string): string => `${place} is a computer you joined, not a workspace; its forks are the workspaces`;
export const placeNotAWorkspaceFix = (place: string): string => `Name a machine on it: wsp threads lists what runs on ${place}.`;

/** What a caller asking for the road to a workspace's own daemon is told, where that workspace runs none: a
 * workspace on a computer somebody owns is that computer's directories under the computer's own daemon, and that
 * daemon answers its files and its git through the host. Said rather than a route minted to a port nothing listens
 * on, which is what the panes and the relay read before. */
export const placeServesDaemonLine = (workspace: string, computer: string): string =>
  `${workspace} has no daemon of its own: ${computer} answers its files and git through this host`;

/** What a watch of the ports or of the load is refused with on a workspace whose computer answers its daemon
 * frames: both readings are that whole computer's, and one workspace reading them would read another workspace's
 * listeners and load as its own. A pane asks for both on every link it opens and takes a refusal of either. */
export const placeWatchesItselfLine = (computer: string): string =>
  `${computer} watches its own ports and load, which are that computer's rather than one workspace's`;

/** What a watch, read or signal of processes is refused with on a workspace whose computer answers its daemon
 * frames: that daemon acts on any pid on the computer, the computer's own and every other workspace's, so none of
 * them goes up its link from one workspace's channel. The Processes pane shows it in place of the table. */
export const forkProcsUnreadLine = (workspace: string, computer: string): string =>
  `${workspace}'s processes on ${computer} are not readable from here yet`;

/** What every other op is refused with on that workspace's channel: the frames that computer's daemon answers
 * inside the workspace they name are its shells, its files and its git, and every other op there runs on the
 * computer itself. */
export const forkOpRefusedLine = (op: string, workspace: string, computer: string): string =>
  `${computer} answers ${workspace}'s shells, files and git from here, not ${op}`;

/** What a person asking for a second workspace on the computer the app itself runs on is told. Its local mode is
 * one workspace, the one it already has; every other workspace is forked at a place. */
export const localRunsOneLine = (workspace: string): string => `${THIS_COMPUTER} is already a workspace, ${workspace}, the only one it can be`;
export const localRunsOneFix = (workspace: string): string => `Use ${workspace}, or name a place that forks: wsp places.`;

/** What a computer's kernel must have before wsp runs workspaces on it, asked in this order so the reason a person
 * reads is the first thing missing rather than the last. `read` answers a file's text or nothing when it is not
 * there; `euid` is the effective user the check runs as. Nothing here touches a disk: the two sides that ask (the
 * daemon on the box, and the join typed at it) each read their own files and share this one rule, so what the
 * doctor says and what a create does cannot part ways. */
export function workspacesBlockedBy(at: { platform: string; read: (path: string) => string | undefined; euid?: number }): string | undefined {
  if (at.platform !== "linux") return "wsp runs workspaces on a Linux computer";
  const controllers = at.read(CGROUP_CONTROLLERS_PATH);
  if (controllers === undefined) {
    return "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1";
  }
  const has = new Set(controllers.split(/\s+/));
  for (const wanted of ["memory", "cpu"]) if (!has.has(wanted)) return `this computer's cgroup root offers no ${wanted} controller, which wsp needs to run workspaces here`;
  const filesystems = at.read(PROC_FILESYSTEMS_PATH);
  if (filesystems === undefined || !filesystems.split(/\s+/).includes("overlay")) {
    return "this computer's kernel has no overlay filesystem, which a workspace here reads this computer's own directories through";
  }
  if (at.euid !== 0) return "wsp runs workspaces on this computer as root, and this daemon is not root";
  return undefined;
}

/** The two files that check reads, named once so the daemon and the host ask the same kernel the same question. */
export const CGROUP_CONTROLLERS_PATH = "/sys/fs/cgroup/cgroup.controllers";
export const PROC_FILESYSTEMS_PATH = "/proc/filesystems";

/** What a join of a computer whose kernel cannot boot the image is refused with, in the one sentence the daemon's
 * own doctor named the reason in. A computer that cannot boot your image is not a place, so the join stops here
 * and nothing is written on it. */
export const placeCannotBootLine = (place: string, reason?: string): string =>
  reason === undefined ? `${place} cannot run wsp workspaces, so it cannot be a place` : `${place} cannot run wsp workspaces: ${reason.replace("this computer", "it")}`;

/** The same sentence off a computer's own report, or nothing while it runs workspaces: one reading for the join's
 * refusal, the row, and every act that runs inside a copy there. */
export const placeBlocked = (place: string, report: Pick<PlaceReport, "runsWorkspaces" | "workspacesBlocked">): string | undefined =>
  report.runsWorkspaces ? undefined : placeCannotBootLine(place, report.workspacesBlocked);

/** What a computer's row says while the threads on that computer itself get no wsp tools: its daemon could not open
 * the door they reach the tools through, in its own words, and the restart that opens it again, of the unit the
 * daemon says it runs under. An update does not do it: one of a daemon already current sends no binary and restarts
 * nothing. A daemon in no unit the join writes names none, and is added again to get one. Nothing from a daemon older
 * than that door, which the row's behind word already answers, or from one whose door stands. */
export const placeNoToolsLine = (place: string, report: Pick<PlaceReport, "wspDoor" | "wspDoorBlocked" | "daemonUnit">): string | undefined =>
  report.wspDoor !== false
    ? undefined
    : `threads on ${place} get no wsp tools: ${report.wspDoorBlocked ?? "its daemon opened no door for them"}; ${report.daemonUnit === undefined ? `remove ${place} and add it again` : `restart wsp's daemon there with systemctl restart ${report.daemonUnit}`}`;

/** The word a computer's row carries while its doctor says it cannot run workspaces. */
export const PLACE_BLOCKED_WORD = "can't run threads";

/** The one sentence a login that is not root reads when it tries to join a Linux computer. The daemon there is a
 * system service under /etc/systemd/system, so a plain account cannot install it and nothing is written before
 * this is said. */
export const PLACE_NEEDS_ROOT_LINE = "joining a Linux computer needs root, since wsp installs its daemon as a system service; log in as root or use sudo";

/** What a word that names no place this host holds is refused with, naming the ones it does. */
export const noSuchPlaceRefusal = (word: string, held: readonly string[]): string => `no place named ${word}; you have ${held.join(", ")}`;

/** Whether a row is a computer somebody joined to this wsp: a computer, and not the one the host runs on, whose
 * files and threads are that host's own. The one reading, so the road that runs on the link, the road at the
 * terminal and the list of places a fork could stand on cannot disagree about which rows are those computers. */
export const isJoinedComputer = (place: { id: string; kind: string }): boolean => place.kind === "computer" && place.id !== HERE_PLACE_ID;

/** What a build of the image at a place that cannot take one is refused with: a copy needs a builder forked there
 * and that builder's disk copied, and a computer somebody joined does neither. */
export const placeBuildsNoImageLine = (place: string): string =>
  `${place} takes no copy of your image: a copy is built by forking a machine there and copying its disk, and ${place} does neither`;

/** The two rooms the member rule is read in: the seal that takes the archive off a builder on the person's own
 * place, and the import that lands it on a copy somewhere else. */
export type VaultRoad = "seal" | "import";

/** What a vault archive is refused with: where the reading stopped, why, and what that refusal did, which is not
 * the same on the two roads. The archive is refused whole, since a builder that wrote one member nobody asked for
 * wrote every other member too. */
export const vaultMemberRefusal = (road: VaultRoad, member: string, why: string): string =>
  `the image's sign-in archive is refused at ${member}: ${why}; ${road === "seal" ? "the seal is refused and no version is recorded" : "nothing of it was imported"}`;

/** What a copy is refused with for a record whose vault kept no path list: sealed before the record held which
 * paths its sign-ins live at, so no other place can tell a member the seal asked for from one it did not. */
export const vaultUnlistedRefusal = (name: string, version: number): string =>
  `${name} v${version} was sealed before its record kept which paths its sign-ins live at, so no other place can check its archive against them; cut the next version`;

export const DaemonErrorCode = z.enum([
  "unsupported",
  "outside-root",
  "not-found",
  "not-a-directory",
  "not-a-file",
  "not-a-git-repo",
  "bad-request",
  "forbidden",
  /** No command line for the git host the remote names is on the machine, so the pull request waits; the push
   * itself landed, which is why a client reads this one as a note beside the push and not as a failure. */
  "no-host-cli",
  /** Git refused a fetch or a push for want of a credential on the computer it ran on, so nothing moved. */
  "no-git-credential",
  /** The git host's command line refused a read for the account's rate limit. */
  "rate-limited",
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

/** One step of a computer's kept readings: the mean cpu and load over it, the last memory and disk in it. */
export const SysPoint = z.object({ at: z.number(), cpu: z.number(), load1: z.number(), mem: z.object({ used: z.number(), total: z.number() }), disk: z.object({ used: z.number(), total: z.number() }) });
export type SysPoint = WireSysPoint;
type SysPointHeld = Held<Same<z.infer<typeof SysPoint>, SysPoint>>;
/** What a sys.history answered: the steps with a reading in them, oldest first, and whether the range held more. */
export const SysHistoryReply = z.object({ points: z.array(SysPoint), stepMs: z.number(), truncated: z.boolean() });
export type SysHistoryReply = WireSysHistoryReply;
type SysHistoryReplyHeld = Held<Same<z.infer<typeof SysHistoryReply>, SysHistoryReply>>;

const UsageTokens = z.object({ input: z.number(), output: z.number(), cached: z.number(), cacheWrite: z.number(), reasoning: z.number() });
/** One window of a plan reading off an agent's store: how much is used, its length where the store named one, and
 * when it starts again, epoch seconds. */
const UsageLimitWindow = z.object({ usedPercent: z.number(), windowDurationMins: z.number().optional(), resetsAt: z.number().optional() });
/** What usage.logs read: each session's use per half hour under one model and folder, `at` the newest moment of that
 * half hour, and the newest plan reading each agent's store kept, in the shape that agent's server answers with. */
export const UsageLogsReply = z.object({
  rows: z.array(z.object({ agent: z.string(), session: z.string(), at: z.number(), model: z.string(), folder: z.string().optional(), tokens: UsageTokens, cost: z.number().optional() })),
  limits: z.array(
    z.object({ agent: z.string(), at: z.number(), primary: UsageLimitWindow.optional(), secondary: UsageLimitWindow.optional(), planType: z.string().optional(), rateLimitReachedType: z.string().optional() }),
  ),
});
export type UsageLogsReply = WireUsageLogsReply;
type UsageLogsReplyHeld = Held<Same<z.infer<typeof UsageLogsReply>, UsageLogsReply>>;

/** A computer's readings over a range as the Usage page draws them: the kept steps and the span they are drawn over. */
export const ReadingsAnswer = z.object({ points: z.array(SysPoint), stepMs: z.number(), from: z.number(), to: z.number() });
export type ReadingsAnswer = z.infer<typeof ReadingsAnswer>;

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
  /** Counts the daemon's process frames, so the changes after this one name it as their base. A daemon a version
   * behind names none and sends no changes, so its snapshot is a whole list held with no gap to track. */
  seq: z.number().int().optional(),
});
export type ProcSnapshot = z.infer<typeof ProcSnapshot>;

/** What moved since frame `base`: the rows that are new or differ, whole, and the pids no longer listed. */
export const ProcChanges = z.object({
  type: z.literal("proc.changes"),
  at: z.number(),
  daemon: z.number().int(),
  total: z.number().int(),
  procs: z.array(ProcEntry),
  gone: z.array(z.number().int()),
  seq: z.number().int(),
  base: z.number().int(),
});
export type ProcChanges = z.infer<typeof ProcChanges>;

/** The snapshot a proc.changes frame leaves, rows by pid as the daemon lists them; undefined where the frame does not
 * follow the snapshot held, which a client answers by watching again for a whole one. */
export function applyProcChanges(snapshot: ProcSnapshot, changes: ProcChanges): ProcSnapshot | undefined {
  if (changes.base !== snapshot.seq) return undefined;
  const rows = new Map(snapshot.procs.map(p => [p.pid, p]));
  for (const pid of changes.gone) rows.delete(pid);
  for (const p of changes.procs) rows.set(p.pid, p);
  return { type: "proc.snapshot", at: changes.at, daemon: changes.daemon, total: changes.total, procs: [...rows.values()].sort((a, b) => a.pid - b.pid), seq: changes.seq };
}
