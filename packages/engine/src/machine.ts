import type { Capabilities, MachineFacts } from "@wsp/protocol";

export type MachineKind = "sandbox" | "desktop";
/** What keeps the daemon running on a machine: the guest's own service manager, or the machine's boot itself on a
 * guest that has none (a container, whose PID 1 is the only thing that outlives an exec). */
export type DaemonSupervisor = "systemd" | "entrypoint";
export type MachineState = "starting" | "running" | "paused" | "gone";

export interface MachineSpec {
  kind: MachineKind;
  template?: string;
  fromSnapshot?: string;
  cpu?: number;
  memMb?: number;
  /** Root disk in GiB; the provider default applies when absent (Solari: 4, and 20 is its cap). */
  diskGb?: number;
  envs?: Record<string, string>;
  labels?: Record<string, string>;
  /** What the provider does when the machine sits idle past its window; the
   * provider default (Solari: pause) applies when absent. */
  onIdle?: "pause" | "kill";
  /** Rolling idle window before onIdle fires; the provider default (Solari: 30 min documented) applies when absent. */
  idleTimeoutMs?: number;
  /** One per create attempt: the provider answers a repeat of the same request under it with the machine it already
   * booted. Minted fresh after a kill, since a replay names the dead machine (measured 2026-09-04). */
  idempotencyKey?: string;
}

export interface ExecResult { exitCode: number; stdout: string; stderr: string }

export interface RunOptions {
  /** Past it the command's session is killed, pid and group, and the result is exit 124 with the output so far. */
  deadlineMs: number;
  /** Each complete line the command writes, stdout and stderr alike, as it is read. */
  onLine?: (line: string) => void;
  /** Between reads of the command's output; the backend's own pace unless a test shortens it. */
  pollMs?: number;
}

/** The route this host takes to one guest port. On a backend whose capabilities say previewUrls it is a public URL
 * with the provider's token embedded, the token standalone, and its expiry in epoch ms as the provider sets it; on
 * one that says otherwise it is a route only the computer holding the backend can take, with no token and an expiry
 * at the end of the machine's life. */
export interface PreviewReach {
  url: string;
  token: string;
  expiresAt: number;
}

/** The provider's own view of a machine's size and birth. Solari's resume can
 * rebuild a VM on a fresh host at default size while keeping the id, so a wake
 * compares the size against what was created. createdAt moves to the resume
 * time on every Solari resume (measured), healthy or not: record it, never judge by it. */
export interface MachineShape {
  cpu?: number;
  memMb?: number;
  /** The root disk the provider granted, in GiB; a dropped or misspelled disk field boots the
   * default and says nothing else. */
  diskGb?: number;
  createdAt?: string;
}

/** The history the runtime hands a snapshot: whether this machine was ever resumed. The fact is the record's; the
 * rule about it, if the provider has one, is the backend's. */
export interface MachineLife {
  firstLife: boolean;
}

export interface Machine {
  readonly id: string;
  readonly kind: MachineKind;
  readonly streamUrl?: string;
  /** The labels the provider reported when this handle was made; absent on backends that carry none. */
  readonly labels?: Record<string, string>;
  /** The provider's view when get() made this handle, so a caller needs no second read; absent on a handle from
   * create(). Its createdAt moves on a running machine nobody touched (+306 s at ten minutes, canary 2026-09-04 UTC)
   * with no lifecycle event behind it, so nothing decides on it; state is the field worth reading. */
  readonly seen?: { state: MachineState; createdAt?: string };
  /** On a handle from create(): the provider answered from an earlier create under the same key instead of booting. */
  readonly replayed?: boolean;
  /** One short command; a backend's exec has a hard ceiling, so anything that can run longer goes through run(). */
  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult>; // always REST path
  /** A command that may run for minutes: started detached on the guest and read until it exits or the deadline
   * kills it; the result is shaped like exec's. */
  run(script: string, opts: RunOptions): Promise<ExecResult>;
  /** Answers when the provider holds the snapshot. A backend that refuses one of a resumed machine throws
   * NotFirstLifeError before any call; one whose snapshot copies the disk from any life ignores `life`. */
  snapshot(name: string, life: MachineLife): Promise<string>;
  pause(): Promise<void>;
  /** `signal` ends the call where the caller has stopped waiting on it, so a resume nobody is waiting on is not left
   * running behind them; the backend's own cap on how long it waits for an answer is its business, not the caller's. */
  resume(signal?: AbortSignal): Promise<void>;
  kill(): Promise<void>;
  state(): Promise<MachineState>;
  downloadUrl(path: string): Promise<string>;
  uploadUrl(path: string): Promise<string>;
  /** Optional: the backends that have a route to a guest port at all. */
  previewUrl?(port: number): Promise<PreviewReach>;
  /** Optional: whether the daemon inside the guest is listening, asked over the road this machine's own calls take
   * rather than by dialling a route from here. Present where a route this computer dials is not the truth about
   * the guest: a container's published port lands on the loopback of the computer its Docker daemon runs on, which
   * is not always the one asking, and a host that is not that computer reads silence off a live daemon. Absent
   * leaves the reach to previewUrl, which on a backend with a public edge is the same road a client takes. The
   * caller's bound is the whole call's, as it is on exec and putBytes. */
  daemonAnswers?(opts?: { timeoutMs?: number }): Promise<boolean>;
  /** Optional: where a process inside this machine dials the computer this host runs on, for the port that host
   * listens on. Only a backend whose machines have a road back to it answers: a container on this computer's own
   * daemon is created with a name for the gateway it reaches this computer through. Absent leaves the address the
   * host advertises, which is what a machine somewhere else dials. */
  hostUrl?(port: number): string;
  /** Optional: bytes onto the machine on a backend that mints no signed upload URL. `landBytes` is what reads it,
   * so no caller picks between the two roads itself. */
  putBytes?(path: string, bytes: Uint8Array, opts?: { timeoutMs?: number }): Promise<void>;
  /** Optional: what keeps a process running on this machine, read by the daemon deploy. Absent means the guest has
   * a service manager and the deploy registers a unit with it. */
  readonly daemonSupervisor?: DaemonSupervisor;
  /** Optional: backends that expose size and creation time per machine. */
  describe?(): Promise<MachineShape>;
  /** Optional: a machine that already existed before wsp says what it is; the status poll carries the answer. */
  facts?(): Promise<MachineFacts>;
  /** Optional: backends whose host reports live usage per machine. Answers when the host still knows the VM; a
   * missing answer while state() still says running is the host having lost it, ahead of the gateway's own record.
   * The numbers themselves are read nowhere yet, so none are typed. */
  metrics?(): Promise<void>;
}

/** One snapshot as the provider lists it; sizeBytes is what storage is billed on. */
export interface SnapshotRow {
  id: string;
  /** The name the snapshot was taken under, which is where wsp's owner mark rides (snapshot-names.ts); absent on a
   * backend whose listing carries none. */
  name?: string;
  sizeBytes: number;
  createdAt?: string;
  /** The snapshot this one was taken under, as the provider chains them; null at a root. */
  parent?: string | null;
}

/** One template as the provider reports it: a promoted snapshot reads ready at once, a built one moves from building
 * to ready or failed, with the provider's reason only on failed. */
export interface TemplateRow {
  id: string;
  name: string;
  status: "building" | "ready" | "failed";
  error?: string;
  /** When the provider says it was promoted or built; absent on a built-in and on a backend that reports none. It
   * is what gives a template the same grace a snapshot gets before anything may call it an orphan. */
  createdAt?: string;
}

/** How the provider bills snapshot storage: the free GB shared by every snapshot on the account, the price of
 * each GB-month past them, and the day billing starts. */
export interface SnapshotStoragePricing {
  freeGb: number;
  usdPerGbMonth: number;
  billedFrom: string;
}

/** What a size costs on this provider, and the shape a spec gets when it
 * names none. Local arithmetic until provider billing APIs are integrated. */
export interface BackendPricing {
  rateUsdPerHour(size: { cpu: number; memMb: number }): number;
  defaultSize: { cpu: number; memMb: number };
  snapshotStorage: SnapshotStoragePricing;
  /** The root disk every builder and fork asks for on this provider, in GiB; absent where a machine takes no disk
   * request at all (a container's disk is the box's, and a quota on one needs a filesystem most boxes do not run). */
  builderDiskGb?: number;
}

export interface LifecycleBudgets {
  /** How many times a wake may resume the machine and check it before a fresh fork replaces it. Each attempt after
   * the first is a pause and a resume; a provider that bills starts declares 1. */
  wakeAttempts: number;
  /** How long the guest's daemon gets to answer once the machine reads running, after a fork and after a resume
   * alike, before the runtime says it did not. It bounds whichever road the check took, the route dialled from
   * here or the machine's own `daemonAnswers`; it is not the status poll's probe bound, which the caller of the
   * read sets. */
  daemonAnswersMs: number;
  /** How the host keeps asking after a resume the provider did not take (a ResumeUnansweredError): once every
   * everyMs of wall time from the first ask, for forMs. Absent, the host asks once and stops. */
  resumeAsks?: { everyMs: number; forMs: number };
}

/** What the runtime reads to drive a machine through naps and wakes on this provider. Present exactly when the
 * capabilities carry a pauseMode; a registry test holds the two together. */
export interface Lifecycle {
  budgets: LifecycleBudgets;
  /** Optional: the instant by which the provider may stop this running machine if this host is gone, computed by
   * the runtime's own backstop policy and handed over whenever the idle window is armed, for a provider whose
   * backstop is pushed rather than set once at create. Never called for a machine the runtime has napped or
   * forgotten. Called from the policy's own arming and not awaited: a rejection is logged, and the backend decides
   * whether a given instant is worth a call, since the window is armed on every streamed chunk. */
  backstop?(machine: Machine, until: number): Promise<void>;
}

export interface MachineBackend {
  readonly capabilities: Capabilities;
  readonly pricing: BackendPricing;
  /** Present on every backend whose capabilities carry a pauseMode. */
  readonly lifecycle?: Lifecycle;
  /** Optional: what a machine of each kind boots from on this provider when nothing names a template. Absent leaves
   * the built-in names the engine knows. */
  readonly baseTemplates?: Readonly<Record<MachineKind, string>>;
  create(spec: MachineSpec): Promise<Machine>;
  /** Optional: only backends the person holds a key for. One cheap authenticated read that boots nothing and touches
   * no machine's idle clock, so a key the provider refuses is known before anything is saved or billed. Rejects with
   * the provider's own WspError; `checkProviderKey` is what reads that answer. */
  checkKey?(): Promise<void>;
  get(id: string): Promise<Machine>;
  /** size comes off the listing itself; a per-machine GET would reset that machine's idle timer. */
  list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[]>;
  deleteSnapshot(id: string): Promise<void>;
  /** Optional: only backends whose capabilities include snapshotListing have it. Every snapshot on the account, with its size. */
  listSnapshots?(): Promise<SnapshotRow[]>;
  /** Optional, the four together: only backends whose capabilities include templates have them. Promotes a snapshot
   * to a durable template under the name and answers the template's id; the snapshot stays and cannot be deleted
   * while the template exists. */
  promoteSnapshot?(snapshotId: string, name: string): Promise<string>;
  getTemplate?(id: string): Promise<TemplateRow>;
  /** Every template the account can boot from, the provider's built-ins included. */
  listTemplates?(): Promise<TemplateRow[]>;
  deleteTemplate?(id: string): Promise<void>;
}
