// SPDX-License-Identifier: AGPL-3.0-only
// One computer's machines, driven from another. The backend and every machine
// it hands back sit behind the same seam the Docker, Solari, local and ssh
// backends do, and each call is one frame on a link somebody else holds: this
// module imports no socket library and knows nothing about how a place is
// reached. What the far side answers is what the far side's own backend
// answered, kind and status included, so a container it lost reads missing
// here exactly as it reads there.

import {
  MACHINE_PUT_PART_BYTES,
  MachineAnswersReply,
  MachineBackendReply,
  MachineCapacityReply,
  MachineExecReply,
  MachineFactsReply,
  MachineHandleReply,
  MachineListReply,
  MachinePromoteReply,
  MachineReachReply,
  MachineShapeReply,
  MachineSnapshotJobReply,
  MachineSnapshotReply,
  MachineSnapshotsReply,
  MachineStateReply,
  MachineTemplateReply,
  MachineTemplatesReply,
  MachineUrlReply,
  type BackendFacts,
  type Capabilities,
  type MachineFacts,
  type MachineHandle,
  type PlaceCapacity,
} from "@wsp/protocol";
import { randomBytes } from "node:crypto";
import { INLINE_EXEC_MS, execDetached } from "./exec-detached.js";
import type {
  BackendPricing,
  ExecResult,
  Lifecycle,
  Machine,
  MachineBackend,
  MachineKind,
  MachineLife,
  MachineListRow,
  MachineShape,
  MachineSpec,
  MachineState,
  PreviewReach,
  RunOptions,
  SnapshotOptions,
  SnapshotRow,
  TemplateRow,
} from "./machine.js";

/** What one ask on a link may say about itself: how long it waits, and whether asking it again is the same ask. */
export interface LinkAsk {
  timeoutMs?: number;
  idempotencyKey?: string;
}

/** The road to one place, as whoever holds the socket hands it over. */
export interface MachineLink {
  /** One frame and its answer. Rejects with an Error carrying the reply's kind and status when the place refused,
   * with PlaceAbsentError when the place is not connected, and with a timeout error when nothing answered inside
   * timeoutMs.
   *
   * `idempotencyKey` names an ask that may be made a second time: the road holding the link waits for a bounded
   * while and asks again when the link goes out from under the frame, and fails with what the frame failed with
   * when the computer never comes back. A frame without one is never asked twice, since the far side runs what it
   * is sent and has no memory of what it already ran. */
  request(op: string, params?: Record<string, unknown>, opts?: LinkAsk): Promise<Record<string, unknown>>;
  /** Whether the road to the computer went and came back: for a caller whose ask is a run of frames rather than
   * one, which waits here and sends the run again. False at once on a link that is up, where what just failed is
   * the far side's own answer and nothing is retried, and false on a computer that did not open a socket again
   * inside the same bounded wait. Absent on a link nothing redials, where a closed socket is the end of it. */
  dialsBack?(): Promise<boolean>;
  /** A port on this computer's loopback carried to one port on the place's own loopback, kept for as long as the
   * place stands; the same pair answers the same local port every time. */
  forward(placePort: number): Promise<{ localPort: number }>;
}

/** How much longer than the frame's own timeout the client waits for the answer to come back over the link. */
export const LINK_MARGIN_MS = 5_000;

/** How often a snapshot job is asked after. A layer of a built workspace takes minutes to write on a small box, so
 * the snapshot is a job the far side names at once, and each ask is one short frame of its own; a person watching
 * the stage reads the bytes at this pace. */
export const SNAPSHOT_POLL_MS = 1_000;

/** How long a job may read running with its bytes standing still before the ask is given up with a reason. The
 * bytes stand still by design while the far side unpacks the layer it has written (46 s for 5 GB, measured), so this
 * is minutes, not the poll's pace; a tar on a stalled disk or a thaw that hangs is what it ends. */
export const SNAPSHOT_STALL_MS = 10 * 60_000;

/** What every call on a place that is not connected rejects with. Nothing is wrong with the machine: the computer
 * holding it dials this host on its own whenever it is on, and the record waits rather than being called gone. */
export class PlaceAbsentError extends Error {
  readonly kind = "absent" as const;
}

export function isPlaceAbsent(e: unknown): boolean {
  return (e as { kind?: unknown } | undefined)?.kind === "absent";
}

/** A route this computer can take to a port inside a machine on a place: the place's own loopback route, carried
 * here by a forward. It is nobody's public route, so it has no token and lasts as long as the machine does. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** One machine on a place. Which optional calls it carries is the handle's to say, so a machine over a link offers
 * exactly what the machine on the other side offers and no road above reads a capability that is not really there. */
export class LinkMachine implements Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly streamUrl?: string;
  readonly labels?: Record<string, string>;
  readonly seen?: { state: MachineState; createdAt?: string };
  readonly replayed?: boolean;
  readonly notice?: string;
  readonly daemonSupervisor?: "systemd" | "entrypoint";
  readonly previewUrl?: (port: number) => Promise<PreviewReach>;
  readonly daemonAnswers?: (opts?: { timeoutMs?: number }) => Promise<boolean>;
  readonly putBytes?: (path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }) => Promise<void>;
  readonly describe?: () => Promise<MachineShape>;
  readonly facts?: () => Promise<MachineFacts>;
  readonly metrics?: () => Promise<void>;

  constructor(
    private readonly link: MachineLink,
    handle: MachineHandle,
    private readonly snapshotPollMs = SNAPSHOT_POLL_MS,
    private readonly snapshotStallMs = SNAPSHOT_STALL_MS,
  ) {
    this.id = handle.id;
    this.kind = handle.kind;
    if (handle.streamUrl !== undefined) this.streamUrl = handle.streamUrl;
    if (handle.labels !== undefined) this.labels = handle.labels;
    if (handle.seen !== undefined) this.seen = handle.seen;
    if (handle.replayed !== undefined) this.replayed = handle.replayed;
    if (handle.notice !== undefined) this.notice = handle.notice;
    if (handle.daemonSupervisor !== undefined) this.daemonSupervisor = handle.daemonSupervisor;
    if (handle.roads.previewUrl) this.previewUrl = port => this.routeTo(port);
    if (handle.roads.daemonAnswers) this.daemonAnswers = opts => this.askDaemon(opts);
    if (handle.roads.putBytes) this.putBytes = (path, bytes, opts) => this.landBytes(path, bytes, opts);
    if (handle.roads.describe) this.describe = () => this.ask(MachineShapeReply, "machine.describe").then(r => r.shape);
    if (handle.roads.facts) this.facts = () => this.ask(MachineFactsReply, "machine.facts").then(r => r.facts);
    if (handle.roads.metrics) this.metrics = () => this.ask(null, "machine.metrics").then(() => undefined);
  }

  private ask<T>(reply: { parse(v: unknown): T } | null, op: string, params: Record<string, unknown> = {}, opts?: LinkAsk): Promise<T> {
    return askLink(this.link, reply, op, { machineId: this.id, ...params }, opts);
  }

  /** A command the caller says may be run twice carries its key down to the link, so a gap in the link is waited
   * out rather than failing it. Every other command is the caller's alone and is sent once. */
  exec(cmd: string, opts?: LinkAsk): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? INLINE_EXEC_MS;
    return this.ask(
      MachineExecReply,
      "machine.exec",
      { cmd, timeoutMs },
      { timeoutMs: timeoutMs + LINK_MARGIN_MS, ...(opts?.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}) },
    ).then(r => r.result);
  }

  /** A command that may run for minutes: the same detached launch and polls every machine without a long-lived
   * channel takes, so nothing of it is a frame of its own. */
  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return execDetached(this, script, opts);
  }

  /** The far side names the job at once and is asked after it until it reads done; a job that failed is refused
   * with its reason on the ask that finds it so, and a job whose bytes stand still past the stall bound is given up
   * with the count it stopped at.
   *
   * The ask after the job is a read of the job's own state and changes nothing on that computer, so it is named by
   * the job and waits out a link that drops under it. The frame that names the job is not: asked twice it would
   * start a second snapshot. That leaves the first frame of a snapshot as the one a gap ends, and the minutes after
   * it, which is where a layer is written, as time a link may go and come back in. */
  async snapshot(name: string, life: MachineLife, opts?: SnapshotOptions): Promise<string> {
    const { job } = await this.ask(MachineSnapshotReply, "machine.snapshot", { name, life });
    let advanced = { bytes: -1, at: Date.now() };
    for (;;) {
      const read = await askLink(this.link, MachineSnapshotJobReply, "machine.snapshotJob", { job }, { idempotencyKey: `snapshotJob/${job}` });
      opts?.onProgress?.({ bytes: read.bytes, ...(read.total !== undefined ? { total: read.total } : {}) });
      if (read.state === "done") {
        if (read.snapshotId === undefined) throw new Error(`the snapshot job ${job} on ${this.id} read done without a snapshot id`);
        return read.snapshotId;
      }
      if (read.bytes !== advanced.bytes) advanced = { bytes: read.bytes, at: Date.now() };
      else if (Date.now() - advanced.at >= this.snapshotStallMs) throw new Error(`the snapshot job ${job} on ${this.id} has written nothing past ${read.bytes} bytes for ${Math.round(this.snapshotStallMs / 60_000)} minutes; given up`);
      await new Promise(r => setTimeout(r, this.snapshotPollMs));
    }
  }

  pause(): Promise<void> {
    return this.ask(null, "machine.pause").then(() => undefined);
  }

  /** `signal` ends the wait here; the frame is sent once whatever the caller does with it, since the place has
   * taken the move by then and a second ask would be a second resume. */
  async resume(signal?: AbortSignal): Promise<void> {
    const sent = this.ask(null, "machine.resume");
    if (signal === undefined) {
      await sent;
      return;
    }
    await Promise.race([
      sent,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
        else signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))), { once: true });
      }),
    ]);
  }

  kill(): Promise<void> {
    return this.ask(null, "machine.kill").then(() => undefined);
  }

  state(): Promise<MachineState> {
    return this.ask(MachineStateReply, "machine.state").then(r => r.state);
  }

  downloadUrl(path: string): Promise<string> {
    return this.ask(MachineUrlReply, "machine.downloadUrl", { path }).then(r => r.url);
  }

  uploadUrl(path: string): Promise<string> {
    return this.ask(MachineUrlReply, "machine.uploadUrl", { path }).then(r => r.url);
  }

  /** The place answers the route on its own loopback, which is where its Docker daemon published the port; the
   * forward turns it into a port on this computer's. No token and no expiry: the road is this host's alone. */
  private async routeTo(port: number): Promise<PreviewReach> {
    const { reach } = await this.ask(MachineReachReply, "machine.previewUrl", { port });
    const placePort = Number(new URL(reach.url).port);
    if (!Number.isInteger(placePort) || placePort < 1) throw new Error(`${this.id} answered ${reach.url}, which names no port this host can be carried to`);
    const { localPort } = await this.link.forward(placePort);
    return { url: `http://127.0.0.1:${localPort}`, token: "", expiresAt: NEVER };
  }

  private askDaemon(opts?: { timeoutMs?: number }): Promise<boolean> {
    const timeoutMs = opts?.timeoutMs ?? INLINE_EXEC_MS;
    return this.ask(MachineAnswersReply, "machine.daemonAnswers", { timeoutMs }, { timeoutMs: timeoutMs + LINK_MARGIN_MS }).then(r => r.answers);
  }

  /** The file in parts under one upload id, in order, the last one marked: the place appends them and lands the
   * whole of it through its own machine's byte road.
   *
   * A part carries no key of its own: the far side appends what it is sent, so the same part asked twice would land
   * twice. The whole upload is the ask that may be made again, since it ends in one write of the file: a link that
   * drops under a part is waited out and every part goes again under a fresh id, which is a name the far side has
   * nothing under. The part it half wrote stays in its own scratch folder, outside the machine. */
  private async landBytes(path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? INLINE_EXEC_MS;
    const parts = Math.max(1, Math.ceil(bytes.length / MACHINE_PUT_PART_BYTES));
    for (let attempt = 1; ; attempt++) {
      const uploadId = randomBytes(8).toString("hex");
      try {
        for (let seq = 0; seq < parts; seq++) {
          const part = bytes.subarray(seq * MACHINE_PUT_PART_BYTES, (seq + 1) * MACHINE_PUT_PART_BYTES);
          await this.ask(
            null,
            "machine.putBytes",
            { path, uploadId, seq, last: seq === parts - 1, data: Buffer.from(part).toString("base64"), timeoutMs },
            { timeoutMs: timeoutMs + LINK_MARGIN_MS },
          );
        }
        return;
      } catch (e) {
        // A part that failed on anything but the link, and a computer that never came back inside the wait, leave
        // the upload failing with what its own part failed with.
        if (attempt >= UPLOAD_ATTEMPTS || this.link.dialsBack === undefined || !(await this.link.dialsBack())) throw e;
      }
    }
  }
}

/** One frame, its answer read by the reply's own schema. A reply with no schema is the bare ok envelope. */
async function askLink<T>(
  link: MachineLink,
  reply: { parse(v: unknown): T } | null,
  op: string,
  params: Record<string, unknown>,
  opts?: LinkAsk,
): Promise<T> {
  const answer = await link.request(op, params, opts ?? {});
  return reply === null ? (undefined as T) : reply.parse(answer);
}

/** A backend on a computer this host reaches over a link. Its facts are read once, when the link opens, and the
 * optional calls are present exactly where those facts say: the rule that ties a capability to the call behind it
 * holds over a link as it does in process. */
export class LinkBackend implements MachineBackend {
  readonly capabilities: Capabilities;
  readonly pricing: BackendPricing;
  readonly lifecycle?: Lifecycle;
  readonly baseTemplates?: Readonly<Record<MachineKind, string>>;
  readonly listSnapshots?: () => Promise<SnapshotRow[]>;
  readonly promoteSnapshot?: (snapshotId: string, name: string) => Promise<string>;
  readonly getTemplate?: (id: string) => Promise<TemplateRow>;
  readonly listTemplates?: () => Promise<TemplateRow[]>;
  readonly deleteTemplate?: (id: string) => Promise<void>;

  /** Asks the place what its backend is and builds it from the answer. */
  static async open(link: MachineLink): Promise<LinkBackend> {
    return new LinkBackend(link, MachineBackendReply.parse(await link.request("machine.backend", {}, {})));
  }

  /** The same from facts already in hand, for a caller that keeps what a place last said about itself: a record
   * standing on a place this host has not heard from yet is held without a round trip, and every call on the
   * backend answers with whatever the link answers. */
  static of(link: MachineLink, facts: BackendFacts): LinkBackend {
    return new LinkBackend(link, facts);
  }

  private constructor(
    private readonly link: MachineLink,
    facts: BackendFacts,
  ) {
    this.capabilities = facts.capabilities;
    this.pricing = {
      // The rate the place's own sizes say, and nothing for a size it does not offer, which on a computer somebody
      // owns is every size: the function is not a thing a wire carries, so it is rebuilt from the offers.
      rateUsdPerHour: size => facts.capabilities.sizes.find(o => o.cpu === size.cpu && o.memMb === size.memMb)?.rateUsdPerHour ?? 0,
      defaultSize: facts.pricing.defaultSize,
      snapshotStorage: facts.pricing.snapshotStorage,
      ...(facts.pricing.builderDiskGb !== undefined ? { builderDiskGb: facts.pricing.builderDiskGb } : {}),
    };
    if (facts.lifecycle !== undefined) this.lifecycle = { budgets: facts.lifecycle.budgets };
    if (facts.baseTemplates !== undefined) this.baseTemplates = facts.baseTemplates;
    if (facts.capabilities.snapshotListing) this.listSnapshots = () => this.ask(MachineSnapshotsReply, "machine.listSnapshots").then(r => r.snapshots);
    if (facts.capabilities.templates) {
      this.promoteSnapshot = (snapshotId, name) => this.ask(MachinePromoteReply, "machine.promoteSnapshot", { snapshotId, name }).then(r => r.templateId);
      this.getTemplate = templateId => this.ask(MachineTemplateReply, "machine.getTemplate", { templateId }).then(r => r.template);
      this.listTemplates = () => this.ask(MachineTemplatesReply, "machine.listTemplates").then(r => r.templates);
      this.deleteTemplate = templateId => this.ask(null, "machine.deleteTemplate", { templateId }).then(() => undefined);
    }
  }

  private ask<T>(reply: { parse(v: unknown): T } | null, op: string, params: Record<string, unknown> = {}, opts?: LinkAsk): Promise<T> {
    return askLink(this.link, reply, op, params, opts);
  }

  /** The spec's own key is the ask's: the far side answers the machine it already made under that key instead of
   * booting a second one, so a create the link dropped under is asked again by it and no computer is billed twice. */
  async create(spec: MachineSpec): Promise<Machine> {
    const opts: LinkAsk = { timeoutMs: CREATE_MS, ...(spec.idempotencyKey !== undefined ? { idempotencyKey: spec.idempotencyKey } : {}) };
    return new LinkMachine(this.link, (await this.ask(MachineHandleReply, "machine.create", { spec }, opts)).machine);
  }

  async get(id: string): Promise<Machine> {
    return new LinkMachine(this.link, (await this.ask(MachineHandleReply, "machine.get", { machineId: id })).machine);
  }

  list(labels?: Record<string, string>): Promise<MachineListRow[]> {
    return this.ask(MachineListReply, "machine.list", labels === undefined ? {} : { labels }).then(r => r.machines);
  }

  deleteSnapshot(snapshotId: string): Promise<void> {
    return this.ask(null, "machine.deleteSnapshot", { snapshotId }).then(() => undefined);
  }

  checkKey(): Promise<void> {
    return this.ask(null, "machine.checkKey").then(() => undefined);
  }

  capacity(): Promise<PlaceCapacity> {
    return this.ask(MachineCapacityReply, "machine.capacity");
  }
}

/** How long a create over a link gets: the machine may have to be fetched onto that computer first, which is the
 * same wait the backend doing the fetching gives it. */
const CREATE_MS = 600_000 + LINK_MARGIN_MS;

/** How many times one file's upload is sent over a link that keeps dropping under it. Each attempt waits for the
 * computer to dial back, so this bounds a link that flaps rather than one that is down. */
const UPLOAD_ATTEMPTS = 3;
