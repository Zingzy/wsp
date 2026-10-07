// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { InitJob, InitAgent, InitKeys } from "../init-job.js";
import { WorkspaceKind } from "../views/workspace-kind.js";

// --- backend capabilities ----------------------------------------------------

export const WorkspaceSize = z.object({ cpu: z.number(), memMb: z.number() });
export type WorkspaceSize = z.infer<typeof WorkspaceSize>;

/** What the cloud setup modal opens on: which keys the host holds (their presence, never a value), the agents on this
 * computer the agent road can start, the price of the machine the build boots, and the init job when one is running
 * or over. */
export const InitSetup = z.object({
  keys: InitKeys,
  /** The provider whose key the setup's own key step asks for, by the word WSP_PROVIDER holds: the one this host
   * forks on where it reads a key, else the one a key alone would wire. Absent where no key would wire anything,
   * which is a host set up for a provider that reads none. The step reads its held state out of `keys` by this
   * word rather than by a provider's name. */
  keyProvider: z.string().optional(),
  /** This computer's home directory, so a field can show a real path of the person's as its example. */
  home: z.string(),
  agents: z.array(InitAgent),
  /** What a machine costs at the place the build boots on, and the disk that place gives a builder where it caps
   * one; null where no place here runs workspaces, so there is no image to build and nothing to price. */
  pricing: z.object({ size: WorkspaceSize, rateUsdPerHour: z.number(), builderDiskGb: z.number().positive().optional() }).nullable(),
  /** The place the build boots on: the one the ask named, else the default place; absent with `pricing` null. */
  place: z.object({ id: z.string(), name: z.string() }).optional(),
  /** The provider this host forks on, under the word its machines are stamped with: where every workspace it makes
   * lands, and what `wsp up --provider` moves. A run beside this host reads it to say so where the provider it was
   * given is another one. Absent on a host of an earlier build, which says nothing about where it forks. */
  forksOn: z.string().optional(),
  /** Why no build can start here, in the runtime's one sentence for it: no place runs workspaces, or several do and
   * none is the default. Present exactly when `pricing` is null, so the sheet and the command line read the same
   * refusal. */
  buildRefusal: z.string().optional(),
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
  /** The provider replaces a machine with a fresh fork of the image behind it and the workspace goes on, its
   * vaulted files carried over: the road a rebuild takes, since it throws a machine away and hands its workspace
   * another. False where nothing forks: this computer, a host with no provider. Whether the replacement comes up with
   * the processes still running is liveCloneForks, which says nothing about whether one may stand in at all. */
  replacesMachine: z.boolean(),
  previewUrls: z.boolean(),
  signedUrls: z.boolean(),
  /** A daemon link exists, so sign-in URLs a guest tool opens land in the laptop's browser and the
   * callback port is forwarded back; false means the person finishes sign-ins by copy and paste. */
  callbackRelay: z.boolean(),
  /** The provider copies a running machine's disk into an image it keeps, which is what a version and a project
   * golden are sealed as and what a fork boots from. False where the disk is the person's own and nothing copies it
   * (this computer, a machine reached over ssh). Which life the copy may be taken from is snapshotsAnyLife.
   * Whether a fork of that image comes up with the processes still running is liveCloneForks and says nothing about
   * whether one can be taken. */
  diskSnapshots: z.boolean(),
  /** The backend keeps images at all: a template or a snapshot a fork can boot from, whether it built them or
   * pulled them. False on a computer somebody joined, where a workspace is a copy of that computer's own
   * directories and of one checkout on it, so a fork names no image, nothing is pulled and nothing is built. */
  images: z.boolean(),
  /** The copy may be taken from a machine that was paused and woken, not only from one that never was. False where
   * the provider refuses a resumed machine (Solari answers 502 and consumes the builder), which is the one reason a
   * builder that woke can no longer be sealed. Read wherever the golden road asks whether a builder still has a
   * seal in it, so that question is the provider's and never the road's; meaningless where diskSnapshots is false. */
  snapshotsAnyLife: z.boolean(),
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
   * rebuild and nothing else. Whether the access picker names the machine on the pick that asks nothing reads this;
   * what a thread with no access word runs at is the person's default, which markedFor places. */
  kept: z.boolean(),
  /** The computer makes a workspace as a copy of itself with the project inside. A Linux box and a provider fork
   * yes; the computer the app runs on yes, by copying the project folder to a path of its own; a machine reached
   * over ssh and a host with no provider no. */
  copies: z.boolean(),
  /** A copy gets its own network, its own localhost and its own ports. A Linux box and a provider fork yes; the
   * computer the app runs on no, so its copies share its ports and the row says so. The one flag the row and the
   * port base read. */
  ownNetwork: z.boolean(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** Where a workspace of one project would land: the row it stands on where that is a computer this host holds, the
 * computer's name as the runtime words it, and what that computer offers. The reply of workspaces.landing, read
 * ahead of a create by the command line and by every row of that project in the app, which takes its words about a
 * copy's ports and its state word's pause mode off these flags. */
export const WorkspaceLanding = z.object({ place: z.string().optional(), name: z.string(), capabilities: Capabilities, kind: WorkspaceKind.optional() });
export type WorkspaceLanding = z.infer<typeof WorkspaceLanding>;

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

/** Whether a request asks for a size at all: a create naming none takes the golden's own size, and so never reads
 * the list of sizes the provider offers. */
export function namesSize(asked: Partial<WorkspaceSize> | undefined): boolean {
  return asked?.cpu !== undefined || asked?.memMb !== undefined;
}

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
  /** What the machines on this computer hold of it right now, summed over the ones that are not stopped: the cores
   * their quotas name and the memory their caps name. Absent from a backend that counts neither, which is what the
   * room line reads before it says anything. */
  cpuTaken: z.number().optional(),
  memTakenMb: z.number().optional(),
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
