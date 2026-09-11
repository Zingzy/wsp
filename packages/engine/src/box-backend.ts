// SPDX-License-Identifier: AGPL-3.0-only
// The backend for Box by ASCII: a persistent Ubuntu VM per box, billed while
// it runs and free while stopped. It sits behind the same MachineBackend seam
// as Solari and Docker. A nap is a stop that snapshots the disk and kills every
// process; a wake is a resume onto a fresh machine that streams the disk back
// in, so the id and the hosted route hold and the address does not. A golden
// version is a named snapshot, which is already durable, so promoting one is a
// second reading of the same name. Everything Box does differently from Solari
// is a declaration through the seam or an internal of this file.

import { createHash, randomBytes } from "node:crypto";
import { moveTimedOutLine, providerRoadRetryLine, shellQuote, type Capabilities } from "@wsp/protocol";
import { MoveUnansweredError, ROAD_TRIES, backoffMs, classify, isMissing, realRetryClock, roadBackoffMs, roadCode, shouldRetry, type RetryClock, type WspError } from "./errors.js";
import { DEADLINE_EXIT, INLINE_EXEC_MS, execDetached } from "./exec-detached.js";
import { EXEC_ENV } from "./golden-import.js";
import { BUILDER_LABEL, CREATED_AT_LABEL, DOCTOR_LABEL, GOLDEN_LABEL, HOST_LABEL, NAME_LABEL, OWNER_LABEL, SMOKE_LABEL, WORKSPACE_LABEL, WSP_LABEL } from "./labels.js";
import type { BackendPricing, ExecResult, Lifecycle, LifecycleBudgets, Machine, MachineBackend, MachineKind, MachineLife, MachineShape, MachineSpec, MachineState, PreviewReach, RunOptions, SnapshotRow, SnapshotStoragePricing, TemplateRow } from "./machine.js";
import { DAEMON_PORT } from "./preview.js";

type Fetch = typeof globalThis.fetch;

export const BOX_API_URL = "https://ascii.dev/api/box/v1";

/** The three classes the API sells without an operator allocation, with the disk each one floors at (the disk is
 * not settable and may be roomier) and the published rate. The trial allows small and default only. */
export interface BoxClass {
  type: "small" | "default" | "large";
  cpu: number;
  memMb: number;
  diskGb: number;
  rateUsdPerHour: number;
}

export const BOX_CLASSES: readonly BoxClass[] = [
  { type: "small", cpu: 2, memMb: 4096, diskGb: 40, rateUsdPerHour: 0.018 },
  { type: "default", cpu: 4, memMb: 8192, diskGb: 80, rateUsdPerHour: 0.036 },
  { type: "large", cpu: 8, memMb: 16384, diskGb: 100, rateUsdPerHour: 0.072 },
];

/** The class a size names: the one it matches, else the smallest that holds both figures, else the largest sold. */
export function boxClassFor(size: { cpu?: number; memMb?: number }): BoxClass {
  const exact = BOX_CLASSES.find(c => c.cpu === size.cpu && c.memMb === size.memMb);
  if (exact !== undefined) return exact;
  return BOX_CLASSES.find(c => c.cpu >= (size.cpu ?? 0) && c.memMb >= (size.memMb ?? 0)) ?? BOX_CLASSES.at(-1)!;
}

const classOfType = (type: string | undefined): BoxClass | undefined => BOX_CLASSES.find(c => c.type === type);

/** Snapshots, the address, the desktop and the hosted routes are included with a box; no storage price is
 * published for a named snapshot. */
const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

export const BOX_PRICING: BackendPricing = {
  rateUsdPerHour: size => boxClassFor(size).rateUsdPerHour,
  defaultSize: { cpu: BOX_CLASSES[0]!.cpu, memMb: BOX_CLASSES[0]!.memMb },
  snapshotStorage: NO_SNAPSHOT_STORAGE,
};

/** The stock image a box boots from when no snapshot names one: the API's own default environment name, which a
 * create carries by leaving `from` out. */
export const BOX_BASE_TEMPLATE = "base";

// Frozen: one shared object for every backend, so nothing shrinks a budget for everyone by accident.
export const BOX_BUDGETS: LifecycleBudgets = Object.freeze({
  // A second attempt would be a stop that snapshots the disk for minutes and a resume that counts as a billed start
  // against 5 a minute and 75 a day on the trial; a wake that fails its check goes straight to the rebuild.
  wakeAttempts: 1,
  // The daemon's unit came back 14 to 85 s after the box read ready on every fork, template create and resume
  // measured (2026-09-11): the restored disk streams in behind the box and systemd starts the unit once its files
  // are there. The empty journal in between is normal.
  daemonAnswersMs: 120_000,
});

/** A stop reads archived 0.6 to 39 s after the call on a small golden and the vendor's own probe puts the p99 near
 * five minutes on a 15 GB disk; past this the pause is reported as not taken. */
export const BOX_PAUSE_MS = 10 * 60_000;
/** A resume read ready in 12 to 18 s; the vendor's worst daily average for the same move was 27 s. */
export const BOX_RESUME_MS = 5 * 60_000;
/** A create from the stock image read ready in 1.5 s and from a named snapshot in 9 to 35 s; one live smoke fork sat
 * in cloning past five minutes (2026-09-11), and the vendor's own fork probe reads degraded for an hour at a time. */
export const BOX_CREATE_MS = 10 * 60_000;
/** A named snapshot of a live box read ready in 11 to 32 s; the provider's own words are "can run minutes". */
export const BOX_SNAPSHOT_MS = 10 * 60_000;
export const BOX_POLL_MS = 2_000;
/** How long a box that reads ready may go on refusing commands with box_restoring or box_starting before the refusal
 * is the caller's: the restored disk streams in behind a ready box, and the daemon's unit came back 14 to 85 s
 * after ready on every measured fork and resume (2026-09-11). */
export const BOX_RESTORE_MS = 120_000;

/** How much later than the last instant sent a backstop instant has to be before it is worth a call: the runtime
 * arms its window on every streamed chunk, and a PATCH per chunk would be a call per keystroke. */
export const BACKSTOP_SLACK_MS = 60_000;
/** The longest auto-stop the trial takes; `null` (no auto-stop) is refused there until the first payment. */
export const TRIAL_TTL_S = 7200;

/** How long a firewall rule has to stand unchanged before the box's own agent is taken to have finished rewriting
 * the rules for this life, and how often it is read meanwhile. */
export const FIREWALL_HOLD_MS = 30_000;
export const FIREWALL_WATCH_MS = 5_000;

/** How long one landing of the environment may take: a write under /etc and a call to the manager, which on a box
 * still streaming its disk in have sat past the ordinary command timeout. */
export const ENV_LANDING_MS = 60_000;

/** PUT /files decodes at most this many bytes (measured 2026-09-11: 8 MB answered 400 box_direct_failed). */
export const FILE_PUT_MAX = 5 * 1024 * 1024;
/** The sync command endpoint's ceiling on one command, in seconds; a longer figure is refused with invalid_timeout. */
export const COMMAND_TIMEOUT_MAX_S = 600;

/** How a box's own state reads as a machine state. `error` is folded into gone: nothing runs on it again and the
 * runtime's road out of gone is a rebuild. */
const STATE_MAP: Record<string, MachineState> = {
  init: "starting",
  provisioning: "starting",
  provisioned: "starting",
  cloning: "starting",
  ready: "running",
  idle: "running",
  running: "running",
  archiving: "paused",
  archived: "paused",
  error: "gone",
};

// --- names ------------------------------------------------------------------

/** A box carries no labels and no readable env, so wsp's marks ride in its display name, which the API keeps whole
 * up to this many characters and truncates past them. */
export const BOX_NAME_MAX = 120;
const NAME_MARK = "wsp";
/** The label keys wsp stamps, by the letter each rides under, in the order they are kept when the name runs out of
 * room: the owner and the workspace decide whose machine it is, the stamp decides its age, and a pair that would not
 * fit whole is left off rather than cut in the middle. Keys outside this table ride under their own name. */
const SHORT_KEYS: readonly (readonly [key: string, short: string])[] = [
  [OWNER_LABEL, "o"],
  [WORKSPACE_LABEL, "w"],
  [CREATED_AT_LABEL, "t"],
  [BUILDER_LABEL, "b"],
  [SMOKE_LABEL, "s"],
  [DOCTOR_LABEL, "d"],
  [HOST_LABEL, "h"],
  [GOLDEN_LABEL, "g"],
  [NAME_LABEL, "n"],
];
const LONG_KEYS = new Map(SHORT_KEYS.map(([key, short]) => [short, key]));

const encodeValue = (value: string): string => value.replace(/[%;=]/g, c => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const decodeValue = (value: string): string => value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/** The display name that carries a machine's labels: the mark, then `;k=v` pairs, wsp's own keys shortened to a
 * letter. WSP_LABEL is the mark itself. */
export function boxName(labels: Record<string, string>): string {
  const rank = (key: string): number => {
    const at = SHORT_KEYS.findIndex(([k]) => k === key);
    return at === -1 ? SHORT_KEYS.length : at;
  };
  const pairs = Object.entries(labels)
    .filter(([key]) => key !== WSP_LABEL)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, value]) => `;${SHORT_KEYS.find(([k]) => k === key)?.[1] ?? key}=${encodeValue(value)}`);
  let name = NAME_MARK;
  for (const pair of pairs) {
    if (name.length + pair.length > BOX_NAME_MAX) continue;
    name += pair;
  }
  return name;
}

/** The labels a box name carries, or undefined on a box wsp did not name. */
export function boxLabels(name: string | undefined | null): Record<string, string> | undefined {
  if (name === undefined || name === null) return undefined;
  const parts = name.split(";");
  if (parts[0] !== NAME_MARK) return undefined;
  const labels: Record<string, string> = { [WSP_LABEL]: "1" };
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const short = part.slice(0, eq);
    labels[LONG_KEYS.get(short) ?? short] = decodeValue(part.slice(eq + 1));
  }
  return labels;
}

/** A named snapshot's name: 1 to 63 lowercase letters, digits or dashes, opening with a letter or digit. wsp's names
 * fit that already except for case and length; a long one keeps its head and ends in a hash of the whole, so two
 * versions that differ only at the tail never share a name and the owner mark at the front still reads. */
export const SNAPSHOT_NAME_MAX = 63;
export function boxSnapshotName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "");
  if (cleaned === "") throw new Error(`${JSON.stringify(name)} leaves nothing a named snapshot can be called`);
  if (cleaned.length <= SNAPSHOT_NAME_MAX) return cleaned;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, SNAPSHOT_NAME_MAX - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- the wire ----------------------------------------------------------------

interface BoxView {
  id: string;
  name?: string | null;
  state: string;
  error?: string | null;
  type?: string;
  vcpu?: number;
  memoryGB?: number;
  createdAt?: string | null;
  archiveAfter?: string | null;
  subdomain?: string | null;
}

interface CommandView {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface NamedSnapshotView {
  name: string;
  status: "saving" | "ready" | "failed";
  error?: string;
  sourceBoxId?: string;
  snapshotId?: string;
  type?: string;
  sizeBytes?: number;
  createdAt: string;
}

interface SnapshotView {
  id: string;
  boxId?: string;
  status?: string;
  kind?: string;
  chainId?: string | null;
  createdAt?: string;
  completedAt?: string | null;
  sizeBytes?: number | null;
}

interface Paged {
  pageInfo?: { nextCursor?: string | null };
}
type BoxPage = Paged & { boxes?: BoxView[] };
type SnapshotPage = Paged & { snapshots?: SnapshotView[] };

const templateRowOf = (s: NamedSnapshotView): TemplateRow => ({
  id: s.name,
  name: s.name,
  status: s.status === "ready" ? "ready" : s.status === "failed" ? "failed" : "building",
  ...(s.status === "failed" && s.error !== undefined ? { error: s.error } : {}),
  createdAt: s.createdAt,
});

/** The provider's own words for its concurrent-box cap. The reference says 429 limit_reached; the trial's refusal
 * carries a message naming the cap under a status of its own (measured 2026-09-11), and the seal and the runtime read
 * a cap only as the concurrency kind: the builder is killed before the smoke fork, the row names the slot holders. */
const CAP_CODES: ReadonlySet<string> = new Set(["limit_reached", "member_limit_reached"]);
const CAP_WORDS = /concurrent box/i;

function boxKind(e: WspError): WspError {
  if (e.kind !== "concurrency" && ((e.code !== undefined && CAP_CODES.has(e.code)) || CAP_WORDS.test(e.message))) return { ...e, kind: "concurrency" };
  return e;
}

function fail(e: WspError): never {
  throw Object.assign(new Error(e.message || `${e.kind} (${e.status})`), e);
}

/** What a fetch is given to end it early: the cap, the caller's own signal, or both. A fresh timeout per attempt. */
function abort(capMs: number | undefined, signal: AbortSignal | undefined): { signal?: AbortSignal } {
  const caps = capMs === undefined ? undefined : AbortSignal.timeout(capMs);
  if (caps === undefined) return signal === undefined ? {} : { signal };
  return { signal: signal === undefined ? caps : AbortSignal.any([caps, signal]) };
}

interface RequestOpts {
  body?: unknown;
  headers?: Record<string, string>;
  capMs?: number;
  signal?: AbortSignal;
}

export interface BoxBudgets {
  createMs: number;
  pauseMs: number;
  resumeMs: number;
  snapshotMs: number;
  restoreMs: number;
  pollMs: number;
}

export interface BoxBackendOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  /** The clock the polls and retries sleep on; tests hand in one that costs nothing. */
  clock?: RetryClock;
  /** How long each move is waited on and how often the box is read meanwhile; the measured defaults when absent. */
  budgets?: Partial<BoxBudgets>;
}

export class BoxBackend implements MachineBackend {
  readonly capabilities: Capabilities = {
    liveCloneForks: false, // a fork boots from a disk snapshot; no memory travels, so the agents start again
    pauseMode: "disk", // a stop snapshots the disk and kills every process; the ptys and the daemon die with it
    resize: false,
    previewUrls: true, // POST /host mints a stable tokened route per port that passes a WebSocket upgrade (measured)
    signedUrls: false, // bytes go through PUT /files as JSON
    containers: true, // Docker and BuildKit are on the image and the box runs its own kernel
    callbackRelay: true, // the daemon link rides the hosted route
    diskSnapshots: true, // a named snapshot of a running box, from any life of it
    snapshotListing: true,
    templates: true, // a named snapshot is the template: durable past its source box, deleted by name
    kept: false, // a fork wsp made and can rebuild
    sizes: BOX_CLASSES.map(c => ({ cpu: c.cpu, memMb: c.memMb, rateUsdPerHour: c.rateUsdPerHour })),
  };

  readonly pricing = BOX_PRICING;

  readonly lifecycle: Lifecycle = {
    budgets: BOX_BUDGETS,
    backstop: (machine, until) => this.backstop(machine, until),
  };

  readonly baseTemplates: Readonly<Record<MachineKind, string>> = { sandbox: BOX_BASE_TEMPLATE, desktop: BOX_BASE_TEMPLATE };

  readonly budgets: BoxBudgets;
  readonly clock: RetryClock;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: Fetch;
  /** The longest auto-stop the account takes, in seconds, or null where none is required; read off /limits once. */
  private ttlCapRead: Promise<number | null> | undefined;
  /** The backstop instant last sent per box, so a window armed on every chunk costs one call a minute at most. */
  private readonly backstops = new Map<string, number>();

  constructor(opts: BoxBackendOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? BOX_API_URL;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? realRetryClock;
    this.budgets = {
      createMs: opts.budgets?.createMs ?? BOX_CREATE_MS,
      pauseMs: opts.budgets?.pauseMs ?? BOX_PAUSE_MS,
      resumeMs: opts.budgets?.resumeMs ?? BOX_RESUME_MS,
      snapshotMs: opts.budgets?.snapshotMs ?? BOX_SNAPSHOT_MS,
      restoreMs: opts.budgets?.restoreMs ?? BOX_RESTORE_MS,
      pollMs: opts.budgets?.pollMs ?? BOX_POLL_MS,
    };
  }

  /** One request to the API. A refusal is read out of the error envelope (`code`, `message`, `requestId`) and thrown
   * as the engine's error kinds; a gateway status is retried on the engine's backoff; a road that failed before the
   * request left this computer is retried too, since nothing was sent. */
  async request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, ...opts.headers };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let roadRetries = 0;
    let attempt = 1;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetch(this.baseUrl + path, {
          method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          ...abort(opts.capMs, opts.signal),
        });
      } catch (e) {
        const road = roadCode(e);
        if (road === undefined) throw e;
        if (++roadRetries >= ROAD_TRIES) throw e;
        console.warn(providerRoadRetryLine(`${method} ${path}`, road, roadRetries + 1, ROAD_TRIES));
        await this.clock.sleep(roadBackoffMs(roadRetries));
        continue;
      }
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      let envelope: { code?: string; message?: string; requestId?: string } = {};
      try {
        envelope = JSON.parse(text) as typeof envelope;
      } catch { /* not a JSON envelope */ }
      const e = boxKind(classify(res.status, { code: envelope.code, error: envelope.message ?? text }, envelope.requestId));
      if (!shouldRetry(e, attempt)) fail(e);
      await this.clock.sleep(backoffMs(attempt));
      attempt++;
    }
  }

  /** The auto-stop the account requires: two hours on the trial, none once it has paid. One read of /limits per
   * backend, before the first create, since the trial refuses `null` with trial_auto_stop_required. */
  ttlCap(): Promise<number | null> {
    this.ttlCapRead ??= this.request<{ accessTier?: string }>("GET", "/limits").then(l => (l.accessTier === "trial" ? TRIAL_TTL_S : null));
    return this.ttlCapRead;
  }

  /** The cheapest authenticated read: the account's limits, which boot nothing and touch no box. */
  async checkKey(): Promise<void> {
    await this.request("GET", "/limits");
  }

  view(id: string): Promise<BoxView> {
    return this.request<{ box: BoxView }>("GET", `/boxes/${encodeURIComponent(id)}`).then(r => r.box);
  }

  /** Reads the box until `done` says so, at the poll pace, inside `budgetMs`; a box the provider lost throws missing
   * and one that reads error throws its reason. */
  async settle(id: string, done: (view: BoxView) => boolean, budgetMs: number, what: string, signal?: AbortSignal): Promise<BoxView> {
    const started = this.clock.now();
    for (;;) {
      if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error(`${what} of ${id} was stopped by its caller`);
      const view = await this.view(id);
      if (done(view)) return view;
      if (view.state === "error") throw new Error(`box ${id} reads error during ${what}${view.error ? `: ${view.error}` : ""}`);
      if (this.clock.now() - started >= budgetMs) throw new Error(`${what} of ${id} still reads ${view.state} after ${Math.round(budgetMs / 1000)} s`);
      await this.clock.sleep(this.budgets.pollMs);
    }
  }

  /** Runs one call against a box that may still be taking its disk in: a refusal with box_restoring or box_starting
   * is the provider saying not yet, and is asked again at the poll pace inside the restore budget; every other
   * refusal is the caller's at once. */
  async whileRestoring<T>(call: () => Promise<T>): Promise<T> {
    const started = this.clock.now();
    for (;;) {
      try {
        return await call();
      } catch (e) {
        const code = (e as Partial<WspError>).code;
        if ((e as Partial<WspError>).kind !== "conflict" || (code !== "box_restoring" && code !== "box_starting")) throw e;
        if (this.clock.now() - started >= this.budgets.restoreMs) throw e;
        await this.clock.sleep(this.budgets.pollMs);
      }
    }
  }

  async create(spec: MachineSpec): Promise<Machine> {
    const cls = boxClassFor(spec);
    const named = spec.fromSnapshot ?? spec.template;
    const from = named === undefined || named === BOX_BASE_TEMPLATE ? undefined : named;
    const body = {
      type: cls.type,
      ttlSeconds: await this.ttlCap(),
      // None of the account's secrets, environment or credential toggles land on a machine wsp forks: sign-ins live
      // in the golden and the vault, and a box handed to a turn must not be able to act on the account.
      noEnv: true,
      name: boxName(spec.labels ?? {}),
      ...(from !== undefined ? { from } : {}),
    };
    const res = await this.request<{ status?: string; box: BoxView }>("POST", "/boxes", {
      body,
      headers: { "Idempotency-Key": spec.idempotencyKey ?? crypto.randomUUID() },
    });
    // A fresh create answers with the box provisioning; a replay under a key already used answers with the box as it
    // stands, which is the one fact the reply carries about it.
    const replayed = res.status !== undefined && res.status !== "provisioning";
    const id = res.box.id;
    const machine = new BoxMachine(this, id, spec.kind, spec.labels, undefined, replayed);
    try {
      // Commands sent before ready run before the box is usable, so the handle is given back once it reads ready.
      const view = await this.settle(id, v => STATE_MAP[v.state] === "running", this.budgets.createMs, "create");
      // A box deployed from a named snapshot is named after the snapshot, whatever the create asked (measured
      // 2026-09-11), and the name is where the labels live: it is set again once the box stands.
      if (view.name !== body.name) await this.request("PATCH", `/boxes/${encodeURIComponent(id)}`, { body: { name: body.name } });
      if (spec.envs !== undefined && Object.keys(spec.envs).length > 0) await machine.landEnvs(spec.envs);
    } catch (e) {
      // A box the provider made that never became a machine is nobody's but this backend's: the caller never learns
      // its id, so it is deleted here rather than left running under the account's cap.
      if (!replayed) await machine.kill().catch(() => {});
      throw e;
    }
    return machine;
  }

  async get(id: string): Promise<Machine> {
    const view = await this.view(id);
    return new BoxMachine(this, view.id, "sandbox", boxLabels(view.name), {
      state: STATE_MAP[view.state] ?? "gone",
      ...(view.createdAt !== undefined && view.createdAt !== null ? { createdAt: view.createdAt } : {}),
    });
  }

  private async pages<T>(path: string, rows: (page: T) => unknown[] | undefined, nextCursor: (page: T) => string | null | undefined): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ limit: "200" });
      if (cursor !== undefined) params.set("cursor", cursor);
      const page = await this.request<T>("GET", `${path}?${params.toString()}`);
      out.push(...(rows(page) ?? []));
      cursor = nextCursor(page) ?? undefined;
    } while (cursor !== undefined);
    return out;
  }

  /** Every box wsp named, archived ones included; the other boxes on the account are not wsp's to list. */
  async list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[]> {
    const boxes = (await this.pages<BoxPage>("/boxes", p => p.boxes, p => p.pageInfo?.nextCursor)) as BoxView[];
    const out: { id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[] = [];
    for (const box of boxes) {
      const carried = boxLabels(box.name);
      if (carried === undefined) continue;
      if (Object.entries(labels ?? {}).some(([k, v]) => carried[k] !== v)) continue;
      out.push({
        id: box.id,
        state: STATE_MAP[box.state] ?? "gone",
        labels: carried,
        ...(box.vcpu !== undefined && box.memoryGB !== undefined ? { size: { cpu: box.vcpu, memMb: box.memoryGB * 1024 } } : {}),
      });
    }
    return out;
  }

  /** The named snapshots, which are wsp's versions, and the provider's own per-minute history with what each
   * increment holds; a delete that finds nothing left is done. */
  async listSnapshots(): Promise<SnapshotRow[]> {
    const named = await this.namedSnapshots();
    const history = (await this.pages<SnapshotPage>("/snapshots", p => p.snapshots, p => p.pageInfo?.nextCursor)) as SnapshotView[];
    return [
      ...named.map(s => ({ id: s.name, name: s.name, sizeBytes: s.sizeBytes ?? 0, createdAt: s.createdAt })),
      ...history.map(s => ({
        id: s.id,
        sizeBytes: s.sizeBytes ?? 0,
        ...(s.completedAt ?? s.createdAt ? { createdAt: (s.completedAt ?? s.createdAt)! } : {}),
        ...(s.chainId !== undefined ? { parent: s.chainId } : {}),
      })),
    ];
  }

  async deleteSnapshot(id: string): Promise<void> {
    const gone = (e: unknown): void => {
      if (!isMissing(e)) throw e;
    };
    if (UUID.test(id)) {
      await this.request("DELETE", `/snapshots/${encodeURIComponent(id)}`, { headers: { "X-Ascii-Confirm-Delete": id } }).catch(gone);
      return;
    }
    await this.request("DELETE", `/named-snapshots/${encodeURIComponent(id)}`).catch(gone);
  }

  private async namedSnapshots(): Promise<NamedSnapshotView[]> {
    const page = await this.request<{ snapshots?: unknown }>("GET", "/named-snapshots");
    if (!Array.isArray(page.snapshots)) throw new Error("GET /named-snapshots answered without a snapshots array");
    return page.snapshots as NamedSnapshotView[];
  }

  /** A named snapshot is durable past its source box already, so the template is the name it was saved under. */
  async promoteSnapshot(snapshotId: string, _name: string): Promise<string> {
    return snapshotId;
  }

  async getTemplate(id: string): Promise<TemplateRow> {
    return templateRowOf(await this.request<{ snapshot: NamedSnapshotView }>("GET", `/named-snapshots/${encodeURIComponent(id)}`).then(r => r.snapshot));
  }

  async listTemplates(): Promise<TemplateRow[]> {
    return (await this.namedSnapshots()).map(templateRowOf);
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.deleteSnapshot(id);
  }

  /** The provider's own stop timer pushed out to the runtime's backstop instant, capped at what the account takes.
   * The timer counts from the PATCH (measured 2026-09-11), so an instant the runtime hands over on activity is
   * what a host that died leaves the box to stop at. */
  async backstop(machine: Machine, until: number): Promise<void> {
    const cap = await this.ttlCap();
    const now = this.clock.now();
    const instant = cap === null ? until : Math.min(until, now + cap * 1000);
    const last = this.backstops.get(machine.id);
    if (last !== undefined && instant - last < BACKSTOP_SLACK_MS) return;
    await this.request("PATCH", `/boxes/${encodeURIComponent(machine.id)}`, { body: { ttlSeconds: Math.max(1, Math.ceil((instant - now) / 1000)) } });
    this.backstops.set(machine.id, instant);
  }

  forgetBackstop(id: string): void {
    this.backstops.delete(id);
  }
}

/** The systemd manager drop-in a machine's environment lands in: every service, the daemon included, starts with
 * these, on this boot through set-environment and on every later boot (a resume, a fork) through the file, which
 * sits under /etc and travels with the snapshot. */
export const ENV_DROP_IN = "/etc/systemd/system.conf.d/wsp-env.conf";

/** One assignment as systemd's DefaultEnvironment= takes it: double-quoted, with the quote and the backslash escaped. */
const unitAssignment = (name: string, value: string): string => `"${name}=${value.replace(/[\\"]/g, c => `\\${c}`)}"`;

export function envLandingScript(envs: Record<string, string>): string {
  const pairs = Object.entries(envs);
  return [
    `mkdir -p ${shellQuote(ENV_DROP_IN.slice(0, ENV_DROP_IN.lastIndexOf("/")))}`,
    `cat > ${shellQuote(ENV_DROP_IN)} <<'WSP_ENV'`,
    "[Manager]",
    `DefaultEnvironment=${pairs.map(([k, v]) => unitAssignment(k, v)).join(" ")}`,
    "WSP_ENV",
    `chmod 0600 ${shellQuote(ENV_DROP_IN)}`,
    `systemctl set-environment ${pairs.map(([k, v]) => shellQuote(`${k}=${v}`)).join(" ")}`,
  ].join("\n");
}

/** The command the API is asked to run for one exec: root's, since the endpoint runs as the box user with
 * passwordless sudo and everything wsp puts on a machine is root's own. The shell drops sudo's own marks first, so
 * a command reads a plain root shell and not a person's shell escalated: the harness vendor's installer refuses to
 * run under sudo (measured 2026-09-11). bash -c, never -lc: a login shell resets PATH. */
export const sudoCommand = (cmd: string): string => `sudo -n bash -c ${shellQuote(`unset SUDO_USER SUDO_UID SUDO_GID SUDO_COMMAND\n${EXEC_ENV}\n${cmd}`)}`;

export class BoxMachine implements Machine {
  /** The desktop stream is minted per open and lives ten minutes, which a field read once cannot carry; the desktop
   * stays off on this backend until the seam reads the stream as a call. */
  readonly streamUrl = undefined;
  /** The id of the deletion the provider accepted for this box, once kill() has been answered. */
  deletion: string | undefined;

  constructor(
    private readonly backend: BoxBackend,
    readonly id: string,
    readonly kind: MachineKind,
    readonly labels?: Record<string, string>,
    readonly seen?: { state: MachineState; createdAt?: string },
    readonly replayed?: boolean,
  ) {}

  private path(suffix = ""): string {
    return `/boxes/${encodeURIComponent(this.id)}${suffix}`;
  }

  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const timeoutS = Math.min(COMMAND_TIMEOUT_MAX_S, Math.max(1, Math.ceil((opts?.timeoutMs ?? INLINE_EXEC_MS) / 1000)));
    const res = await this.backend.whileRestoring(() => this.backend.request<CommandView>("POST", this.path("/commands"), {
      body: { command: sudoCommand(cmd), timeoutSeconds: timeoutS },
      // The call holds while the command runs; the cap is the command's own timeout plus room for the round trip.
      capMs: timeoutS * 1000 + 30_000,
    }));
    return { exitCode: res.exitCode ?? (res.timedOut === true ? DEADLINE_EXIT : -1), stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return execDetached(this, script, opts);
  }

  /** The machine's environment, as the seam promises a fork its envs: the API's own `env` reaches the box user's
   * tools and nothing under root, where the daemon and every turn run. On a box that has just read ready the write
   * under /etc and the call to the manager can sit behind the disk still streaming in (one fork's landing hit the
   * command timeout, 2026-09-11), so a landing that times out is asked again inside the restore budget. */
  async landEnvs(envs: Record<string, string>): Promise<void> {
    const started = this.backend.clock.now();
    for (;;) {
      const res = await this.exec(envLandingScript(envs), { timeoutMs: ENV_LANDING_MS });
      if (res.exitCode === 0) return;
      if (res.exitCode !== DEADLINE_EXIT || this.backend.clock.now() - started >= this.backend.budgets.restoreMs) {
        throw new Error(`environment did not land on ${this.id} (exit ${res.exitCode}): ${res.stderr.trim() || res.stdout.trim()}`);
      }
      await this.backend.clock.sleep(this.backend.budgets.pollMs);
    }
  }

  /** A named snapshot of the disk as it stands, from any life of the box: the provider snapshots continuously and a
   * resumed box saves like a fresh one. Answers with the name once the provider reads it ready. */
  async snapshot(name: string, _life: MachineLife): Promise<string> {
    const saved = boxSnapshotName(name);
    await this.backend.request("POST", "/named-snapshots", { body: { boxId: this.id, name: saved } });
    const started = this.backend.clock.now();
    for (;;) {
      await this.backend.clock.sleep(this.backend.budgets.pollMs);
      const { snapshot } = await this.backend.request<{ snapshot: NamedSnapshotView }>("GET", `/named-snapshots/${encodeURIComponent(saved)}`);
      if (snapshot.status === "ready") return saved;
      if (snapshot.status === "failed") throw new Error(`named snapshot ${saved} of ${this.id} failed${snapshot.error ? `: ${snapshot.error}` : ""}`);
      if (this.backend.clock.now() - started >= this.backend.budgets.snapshotMs) throw new Error(`named snapshot ${saved} of ${this.id} still reads saving after ${Math.round(this.backend.budgets.snapshotMs / 1000)} s`);
    }
  }

  /** Returns when the box reads archived. A stop is a 202 the provider lands in seconds to minutes, so the box is
   * read until it does; archiving is the stop under way and a box already archived needs none. A stop the
   * provider refuses is thrown as itself, and one it takes back (the snapshot behind it failing leaves the box
   * running, which the provider does rather than lose work) ends the move as not taken; nothing here sends force. */
  async pause(): Promise<void> {
    const { pauseMs, pollMs } = this.backend.budgets;
    const now = this.backend.clock.now;
    const started = now();
    let view = await this.backend.view(this.id);
    if (view.state === "archived") return;
    if (view.state !== "archiving") await this.backend.request("POST", this.path("/stop"), { body: {} });
    for (;;) {
      await this.backend.clock.sleep(pollMs);
      view = await this.backend.view(this.id);
      if (view.state === "archived") return;
      if (view.state !== "archiving") {
        const words = `pause did not take: the provider left ${this.id} ${view.state}, which it does when the snapshot behind a stop is failing`;
        console.warn(`${this.id}: ${words}`);
        throw new MoveUnansweredError(words);
      }
      if (now() - started >= pauseMs) {
        const words = moveTimedOutLine("pause", now() - started, STATE_MAP[view.state]);
        console.warn(`${this.id}: ${words}`);
        throw new MoveUnansweredError(words);
      }
    }
  }

  /** Returns when the box reads ready. A resume is a 202 onto a fresh machine with the same id; the address changes
   * every time, so nothing here keeps one, and the daemon's own answer is the runtime's to wait for through the
   * hosted route. A resume of a running box is the provider's free no-op. */
  async resume(signal?: AbortSignal): Promise<void> {
    await this.backend.request("POST", this.path("/resume"), { body: { ttlSeconds: await this.backend.ttlCap() }, signal });
    await this.backend.settle(this.id, v => STATE_MAP[v.state] === "running", this.backend.budgets.resumeMs, "resume", signal);
  }

  /** The provider deletes in the background and answers an operation, which read blocked for the rest of the spike
   * while every box was gone from GET within seconds: the box gone is what counts, the operation id is kept. */
  async kill(): Promise<void> {
    try {
      const res = await this.backend.request<{ operation?: { id?: string } }>("DELETE", this.path(), { headers: { "X-Ascii-Confirm-Delete": this.id } });
      this.deletion = res.operation?.id;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    this.backend.forgetBackstop(this.id);
  }

  async state(): Promise<MachineState> {
    try {
      return STATE_MAP[(await this.backend.view(this.id)).state] ?? "gone";
    } catch (e) {
      if (isMissing(e)) return "gone";
      throw e;
    }
  }

  /** The class the box runs as; its disk is the class floor, since the API neither takes nor reports a figure. */
  async describe(): Promise<MachineShape> {
    const view = await this.backend.view(this.id);
    const cls = classOfType(view.type);
    return {
      ...(view.vcpu !== undefined ? { cpu: view.vcpu } : {}),
      ...(view.memoryGB !== undefined ? { memMb: view.memoryGB * 1024 } : {}),
      ...(cls !== undefined ? { diskGb: cls.diskGb } : {}),
      ...(view.createdAt !== undefined && view.createdAt !== null ? { createdAt: view.createdAt } : {}),
    };
  }

  /** The hosted route to one port: a stable URL minted once per box and port, answered again on every later call,
   * with no expiry. The daemon's port is routed public: the provider opens its own firewall for a public route and
   * never for a private one (measured 2026-09-11), and the daemon's token in the first frame is the gate on it, as
   * it is on every address the daemon listens on. Any other port keeps the private route with the provider's token
   * in the query, and the guest firewall is opened for it first, since a private route answers 502 until a rule
   * stands. */
  async previewUrl(port: number): Promise<PreviewReach> {
    const daemon = port === DAEMON_PORT;
    if (!daemon) await this.openPort(port);
    const res = await this.backend.request<{ url: string }>("POST", this.path("/host"), { body: { port, public: daemon } });
    return { url: res.url, token: new URL(res.url).searchParams.get("_token") ?? "", expiresAt: Number.MAX_SAFE_INTEGER };
  }

  /** The guest firewall rule for one port, and the box's own agent that takes it away: about half a minute after
   * a life begins the agent rewrites the rules from its own list (measured 2026-09-11: a fork asked at 16:05:10 had
   * its rules rewritten at 16:05:45), and a private route answers 502 until a rule stands. So a rule that is not
   * there is added, then watched and added again whenever it is gone, until it has stood for FIREWALL_HOLD_MS; a
   * rule already standing costs one read. In the first seconds of a life ufw refuses with a non-zero exit while it
   * comes up, which is asked again at the poll pace. A rule that will not hold inside the budget is said once and
   * the route is minted anyway. */
  private async openPort(port: number): Promise<void> {
    const { pollMs, restoreMs } = this.backend.budgets;
    const now = this.backend.clock.now;
    const standing = async (): Promise<boolean> => (await this.exec(`ufw status | grep -q '^${port}/tcp '`).catch(() => ({ exitCode: -1 }))).exitCode === 0;
    if (await standing()) return;
    const started = now();
    let held: number | undefined;
    let said = "";
    while (now() - started < restoreMs + FIREWALL_HOLD_MS) {
      if (held !== undefined && await standing()) {
        if (now() - held >= FIREWALL_HOLD_MS) return;
      } else {
        const res = await this.exec(`ufw allow ${port}/tcp`).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: e instanceof Error ? e.message : String(e) }));
        if (res.exitCode === 0) held = now();
        else {
          held = undefined;
          said = (res.stderr || res.stdout).trim().slice(-200);
        }
      }
      await this.backend.clock.sleep(held === undefined ? pollMs : FIREWALL_WATCH_MS);
    }
    console.warn(`${this.id}: the firewall did not hold a rule for port ${port}${said === "" ? "" : ` (${said})`}; the route is minted without one`);
  }

  /** Bytes onto the box through PUT /files, which writes as the box user under /home/user or /tmp and takes at most
   * FILE_PUT_MAX decoded bytes a call: a file that fits goes straight to a path under those two, and anything else
   * lands in pieces under /tmp and is joined into place as root, its size read back before the pieces go. */
  async putBytes(path: string, bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<void> {
    const put = (at: string, part: Uint8Array): Promise<unknown> => this.backend.whileRestoring(() => this.backend.request("PUT", this.path("/files"), {
      body: { path: at, content: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64"), encoding: "base64" },
      ...(opts.timeoutMs !== undefined ? { capMs: opts.timeoutMs } : {}),
    }));
    const pieces = Math.max(1, Math.ceil(bytes.byteLength / FILE_PUT_MAX));
    if (pieces === 1 && (path.startsWith("/tmp/") || path.startsWith("/home/user/"))) {
      await put(path, bytes);
      return;
    }
    const base = `/tmp/wsp-put-${randomBytes(6).toString("hex")}`;
    const names: string[] = [];
    for (let i = 0; i < pieces; i++) {
      names.push(`${base}.${i}`);
      await put(`${base}.${i}`, bytes.subarray(i * FILE_PUT_MAX, (i + 1) * FILE_PUT_MAX));
    }
    const quoted = names.map(shellQuote).join(" ");
    const joined = await this.exec([
      `mkdir -p ${shellQuote(path.slice(0, path.lastIndexOf("/")) || "/")}`,
      `cat ${quoted} > ${shellQuote(path)} && chmod 0644 ${shellQuote(path)} && rm -f ${quoted}`,
      `[ "$(stat -c %s ${shellQuote(path)})" = ${bytes.byteLength} ] || { echo "WSP_SHORT $(stat -c %s ${shellQuote(path)})"; exit 1; }`,
    ].join("\n"));
    if (joined.exitCode !== 0) throw new Error(`${path} did not land on ${this.id} (exit ${joined.exitCode}): ${joined.stderr.trim() || joined.stdout.trim()}`);
  }

  async downloadUrl(): Promise<string> {
    throw new Error("a box serves no signed download URL; its files come out through GET /files");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("a box serves no signed upload URL; its files go in through PUT /files");
  }
}
