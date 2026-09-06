// SPDX-License-Identifier: AGPL-3.0-only
// Enriched workspace status + awake-time cost metering. Promoted from
// @wsp/host so every protocol client reads one implementation; the host's
// REST endpoint and the web app's rail both consume this.
//
// Machine state is the runtime's own phase plus a reach probe over the preview
// URL. The provider is asked only after a failed reach (at most once per
// reconcile window) or on an explicit refresh: every GET /sandboxes/:id resets
// Solari's idle timer, so a poller that asked per tick kept every workspace
// awake and billing forever.

import type { ExecResult, MachineState, PreviewReach } from "@wsp/engine";
import { appendCostPoint, type EventUnion, type ReachState, type ReachStatus, type WorkspaceCostEvent, type WorkspacePhase, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { realClock, type Clock } from "./clock.js";
import type { Store } from "./store.js";

/** The provider word the runtime's own phase implies: a wake in flight is a machine starting, a pause in flight still runs. */
export function machineStateOf(phase: WorkspacePhase): MachineState {
  switch (phase) {
    case "running":
    case "pausing":
      return "running";
    case "napping":
      return "paused";
    case "waking":
      return "starting";
    case "gone":
      return "gone";
    default: {
      const _exhaustive: never = phase;
      return "running";
    }
  }
}

/** What a record says about a machine the provider stopped knowing, quoting the provider where it said anything. */
export function goneWords(machineId: string, providerWords?: string): string {
  const base = `machine ${machineId} is gone at the provider`;
  return providerWords === undefined || providerWords === "" ? base : `${base}: ${providerWords}`;
}

export interface ProbeOptions {
  /** An answer slower than this is the edge being slow, whatever its status. */
  promptMs: number;
  /** No answer by this is unreachable. Must tolerate a slow edge (measured 502s after 5 to 11 s). */
  timeoutMs: number;
}

/** The daemon's ws server answers a plain HTTP GET with Upgrade Required and nothing else it serves does: it is the
 * one status that came from inside the guest. */
const DAEMON_ANSWER = 426;

/** What one round trip found: the state to show, and whether the guest itself answered. */
export interface Probed {
  state: ReachState;
  /** The daemon answered. Any other answer is the edge speaking for the machine (an edge auth refusal, a route to a
   * paused machine), which says nothing about the guest either way, so it decides nothing on its own and only sends
   * the caller to the provider for the machine's real state. */
  fromDaemon: boolean;
}

/** One HTTP round trip against the minted URL. A prompt 502 means the edge
 * dialed the guest and nothing listens on the daemon port. A late answer, 502
 * included, is a provider slow spell: the machine is there, the edge is not
 * keeping up. Silence is unreachable. */
export async function probeReach(url: string, o: ProbeOptions, now: () => number = Date.now): Promise<Probed> {
  const started = now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs) });
    await res.text().catch(() => "");
    const fromDaemon = res.status === DAEMON_ANSWER;
    if (now() - started > o.promptMs) return { state: "slow", fromDaemon };
    return { state: res.status === 502 ? "no-daemon" : "reachable", fromDaemon };
  } catch {
    return { state: "unreachable", fromDaemon: false };
  }
}

export interface StatusListOptions {
  probeTimeoutMs?: number;
  promptMs?: number;
  /** "always" asks the provider for every machine (an explicit refresh; what a
   * bare list() does). "on-failure" asks only after a failed reach and reuses
   * that answer for the reconcile window; the poller runs this way. */
  reconcile?: "always" | "on-failure";
}

export interface StatusWatchOptions {
  costIntervalMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
  promptMs?: number;
  /** How long the poller believes a provider answer before a failed reach may ask again. */
  reconcileMinMs?: number;
  /** Reach slow or unreachable for this long on a machine the provider calls running earns one exec probe. */
  zombieWindowMs?: number;
  /** The exec probe's bound; past it the guest counts as dead. */
  zombieProbeTimeoutMs?: number;
}

export interface StatusApi {
  list(opts?: StatusListOptions): Promise<WorkspaceStatus[]>;
  /** Refcounted: while at least one watcher holds this, the poller and cost
   * ticker run and their events ride the runtime bus. Returns the release. */
  watch(opts?: StatusWatchOptions): () => void;
  /** The workspace's cost ticks since metering began, across host restarts, folded to the rate changes and the newest tick. */
  history(workspaceId: string): Promise<WorkspaceCostEvent[]>;
}

/** A workspace as the tracker needs it: the view, the size the provider built
 * (views carry no size), and roads to the machine that never go through
 * backend.get. daemonReach is absent on backends without preview URLs. */
export interface StatusRecord extends WorkspaceView {
  size: WorkspaceSize;
  idleAt?: number;
  daemonReach?: () => Promise<PreviewReach>;
  providerState: () => Promise<MachineState>;
  exec: (cmd: string, opts?: { timeoutMs?: number }) => Promise<ExecResult>;
}

export interface StatusTrackerOptions {
  rateUsdPerHour(size: WorkspaceSize): number;
  records(): Promise<StatusRecord[]>;
  /** Holds each workspace's folded cost history so the series and the meter behind it outlive the process. */
  store: Store;
  emit(event: EventUnion): void;
  on(type: EventUnion["type"] | "*", listener: (e: EventUnion) => void): () => void;
  defaults?: StatusWatchOptions;
  /** Time source for the meters, the reconcile and zombie windows and the probe's elapsed read; tests inject one they can advance. */
  clock?: Clock;
}

interface Meter {
  awakeMs: number;
  /** Set while running: when the current awake stretch began. */
  mark?: number;
  /** The newest instant anything proved the machine awake. A pause or a death the provider made ended the stretch
   * here at the latest: nothing proves a machine awake while the host is down or unwatched, so the gap is not billed. */
  awakeUntil?: number;
}

const COST_HISTORIES = "cost-histories";

/** One store document per workspace: its folded series as of the tick that last added a point. */
interface CostHistoryRecord {
  workspaceId: string;
  points: WorkspaceCostEvent[];
}

const PROBE_TIMEOUT_MS = 10_000;
const PROMPT_MS = 2_500;
const RECONCILE_MIN_MS = 5 * 60_000;
/** Both measured zombies sat slow or unreachable for well over this before anyone looked;
 * a provider slow spell (5 to 11 s answers, minutes long) must not reach the probe. */
const ZOMBIE_WINDOW_MS = 3 * 60_000;
/** The zombies' own exec 502'd after 36 to 38 s; a live guest answers echo in under a second. */
const ZOMBIE_PROBE_TIMEOUT_MS = 20_000;
const ZOMBIE_PROBE_CMD = "echo ok";

/** Rejects once ms pass; the underlying promise is left to settle on its own. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** A running machine whose reach has been slow or unreachable: when the spell
 * began, the probe in flight if any, and the verdict once one was reached. */
interface Suspect {
  machineId: string;
  badSince: number;
  probe?: Promise<string | undefined>;
  zombie?: string;
}

export function createStatusTracker(o: StatusTrackerOptions): StatusApi {
  const probeTimeoutMs = o.defaults?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const promptMs = o.defaults?.promptMs ?? PROMPT_MS;
  const reconcileMinMs = o.defaults?.reconcileMinMs ?? RECONCILE_MIN_MS;
  const zombieWindowMs = o.defaults?.zombieWindowMs ?? ZOMBIE_WINDOW_MS;
  const zombieProbeTimeoutMs = o.defaults?.zombieProbeTimeoutMs ?? ZOMBIE_PROBE_TIMEOUT_MS;
  const costIntervalMs = o.defaults?.costIntervalMs ?? 5_000;
  const pollIntervalMs = o.defaults?.pollIntervalMs ?? 15_000;
  const clock = o.clock ?? realClock;
  const meters = new Map<string, Meter>();
  const histories = new Map<string, WorkspaceCostEvent[]>();
  const reconciled = new Map<string, { state: MachineState; at: number }>();
  /** The words behind a gone answer, per workspace, so the status that reports it can quote the provider. */
  const goneReasons = new Map<string, string>();
  const suspects = new Map<string, Suspect>();

  // Exact awake accounting comes from lifecycle events, not poll edges. A
  // workspace hydrated already-running starts its meter lazily at first tick.
  const meter = (id: string): Meter => {
    let m = meters.get(id);
    if (!m) {
      m = { awakeMs: 0 };
      meters.set(id, m);
    }
    return m;
  };
  /** Something proved the machine awake just now: a create or a wake here, the guest answering the probe, or the
   * provider saying running. The record's own phase is a belief, and a belief never moves this. */
  const sawAwake = (id: string): void => {
    meter(id).awakeUntil = clock.now();
  };
  const beganAwake = (id: string): void => {
    meter(id).mark = clock.now();
    sawAwake(id);
  };
  o.on("workspace.created", e => {
    if (e.type === "workspace.created") beganAwake(e.workspace.id);
  });
  o.on("workspace.woken", e => {
    if (e.type === "workspace.woken") beganAwake(e.workspaceId);
  });
  // Awake time ends where the machine did: a pause this host made ends it now; a pause the provider made and this
  // host only found, and the moment the provider was found not to know the machine at all, end it at the last
  // instant anything proved the machine awake, so the hours before we noticed bill nothing.
  for (const type of ["workspace.napped", "workspace.gone"] as const) {
    o.on(type, e => {
      if (e.type !== type) return;
      const m = meter(e.workspaceId);
      const found = e.type === "workspace.gone" || e.found === true;
      const ended = found ? (m.awakeUntil ?? clock.now()) : clock.now();
      if (m.mark !== undefined) m.awakeMs += Math.max(0, ended - m.mark);
      m.mark = undefined;
    });
  }
  o.on("workspace.deleted", e => {
    if (e.type !== "workspace.deleted") return;
    meters.delete(e.workspaceId);
    forget(e.workspaceId);
    lastEmitted.delete(e.workspaceId);
    reconciled.delete(e.workspaceId);
    goneReasons.delete(e.workspaceId);
    suspects.delete(e.workspaceId);
  });

  // The stored series is as of the tick that last added a point, and a run of one rate is a straight line from
  // there: a workspace running then resumes its awake stretch at that tick, so the host's downtime is metered as
  // the provider billed it.
  const loading = (async () => {
    for (const raw of await o.store.list(COST_HISTORIES)) {
      const doc = raw as CostHistoryRecord;
      const last = Array.isArray(doc.points) ? doc.points.at(-1) : undefined;
      if (last === undefined) continue;
      histories.set(doc.workspaceId, doc.points);
      const m = meter(doc.workspaceId);
      m.awakeMs = last.awakeMs;
      if (last.phase === "running") m.mark = m.awakeUntil = Date.parse(last.at);
    }
  })().catch((e: unknown) => console.warn("cost histories not loaded; the series begins at the first tick", e));

  // Writes land in order behind the load, so a save never lands under a delete that followed it.
  let writes: Promise<void> = loading;
  const persist = (step: () => Promise<void>): void => {
    writes = writes.then(step).catch(() => {});
  };

  const forget = (id: string): void => {
    histories.delete(id);
    persist(() => o.store.delete(COST_HISTORIES, id));
  };

  /** The provider's word, or our own when it cannot be had (weather is not a
   * reason to report a running workspace as anything else). */
  const askProvider = async (r: StatusRecord): Promise<MachineState> => {
    let state: MachineState;
    let words: string | undefined;
    try {
      state = await r.providerState();
    } catch (e) {
      if ((e as { kind?: string }).kind !== "missing") return machineStateOf(r.phase);
      state = "gone";
      words = e instanceof Error ? e.message : String(e);
    }
    reconciled.set(r.id, { state, at: clock.now() });
    if (state === "running") sawAwake(r.id);
    if (state === "gone") goneReasons.set(r.id, goneWords(r.machineId, words));
    return state;
  };

  const machineState = async (r: StatusRecord, reconcile: StatusListOptions["reconcile"], reachFailed: boolean): Promise<MachineState> => {
    if (reconcile === "always") return askProvider(r);
    if (!reachFailed) return machineStateOf(r.phase);
    const known = reconciled.get(r.id);
    if (known && clock.now() - known.at < reconcileMinMs) return known.state;
    return askProvider(r);
  };

  /** undefined when the guest answered; otherwise what went wrong and how long it took. */
  const probeExec = async (r: StatusRecord): Promise<string | undefined> => {
    const started = clock.now();
    const took = () => `failed after ${clock.now() - started} ms`;
    try {
      const res = await bounded(r.exec(ZOMBIE_PROBE_CMD, { timeoutMs: zombieProbeTimeoutMs }), zombieProbeTimeoutMs);
      if (res.exitCode === 0 && res.stdout.trim() === "ok") return undefined;
      const stderr = res.stderr.trim().slice(0, 200);
      return `${took()} (exit ${res.exitCode}${stderr === "" ? "" : `: ${stderr}`})`;
    } catch (e) {
      return `${took()} (${e instanceof Error ? e.message : String(e)})`;
    }
  };

  /** The spell this workspace's current machine is in; a replaced machine starts clean. */
  const suspectOf = (r: StatusRecord): Suspect => {
    const known = suspects.get(r.id);
    if (known !== undefined && known.machineId === r.machineId) return known;
    const fresh: Suspect = { machineId: r.machineId, badSince: clock.now() };
    suspects.set(r.id, fresh);
    return fresh;
  };

  /** A slow or unreachable reach on a running workspace. Inside the window it
   * is weather. Past it, and only while the provider still says running, one
   * exec probe decides: an answer restarts the window (a long slow spell with
   * a live guest never flags), a failure marks the machine zombie until reach
   * reads healthy again or the machine is replaced. */
  const judge = async (
    r: StatusRecord,
    reach: ReachStatus,
    reconcile: StatusListOptions["reconcile"],
  ): Promise<{ state: MachineState; reach: ReachStatus; reason?: string }> => {
    const s = suspectOf(r);
    const elapsed = clock.now() - s.badSince;
    if (s.zombie === undefined && elapsed < zombieWindowMs) {
      return { state: await machineState(r, reconcile, reach.state === "unreachable"), reach };
    }
    const provider = await machineState(r, reconcile, true);
    if (provider !== "running") {
      suspects.delete(r.id);
      return { state: provider, reach };
    }
    if (s.zombie !== undefined) return { state: provider, reach: { ...reach, state: "zombie" }, reason: s.zombie };
    s.probe ??= probeExec(r).finally(() => {
      s.probe = undefined;
    });
    const fault = await s.probe;
    if (fault === undefined) {
      s.badSince = clock.now();
      return { state: provider, reach };
    }
    const reason =
      `${r.machineId} reports running at the provider; reach ${reach.state} since ${new Date(s.badSince).toISOString()} ` +
      `(${Math.round(elapsed / 1000)} s); exec probe "${ZOMBIE_PROBE_CMD}" ${fault}`;
    s.zombie = reason;
    console.warn(`zombie on ${r.machineId} (workspace ${r.id}): ${reason}`);
    return { state: provider, reach: { ...reach, state: "zombie" }, reason };
  };

  const list: StatusApi["list"] = async opts => {
    const records = await o.records();
    const probe: ProbeOptions = { promptMs: opts?.promptMs ?? promptMs, timeoutMs: opts?.probeTimeoutMs ?? probeTimeoutMs };
    const reconcile = opts?.reconcile ?? "always";

    return Promise.all(
      records.map(async (r): Promise<WorkspaceStatus> => {
        const { size, idleAt, daemonReach, providerState, exec, ...view } = r;
        void providerState;
        void exec;
        const base = { ...view, size, rateUsdPerHour: o.rateUsdPerHour(size), ...(idleAt !== undefined ? { idleAt } : {}) };
        const gone = (reason: string | undefined): WorkspaceStatus => ({ ...base, machineState: "gone", reach: { state: "gone" }, ...(reason !== undefined ? { reason } : {}) });
        const done = (state: MachineState, reach: WorkspaceStatus["reach"]): WorkspaceStatus =>
          state === "gone" ? gone(goneReasons.get(r.id) ?? goneWords(r.machineId)) : { ...base, machineState: state, reach };

        // A gone record already holds the provider's last word; asking again would only 404.
        if (view.phase === "gone") {
          suspects.delete(r.id);
          return gone(view.gone);
        }
        // Measured: the reach goes dark only while paused and works again on wake.
        if (view.phase !== "running") {
          suspects.delete(r.id);
          return done(await machineState(r, reconcile, false), { state: "napping" });
        }
        if (!daemonReach) return done(await machineState(r, reconcile, false), { state: "unsupported" });

        let reach: PreviewReach;
        try {
          reach = await daemonReach();
        } catch {
          return done(await machineState(r, reconcile, true), { state: "unreachable" });
        }
        const probed = await probeReach(reach.url, probe, clock.now);
        if (probed.fromDaemon) sawAwake(r.id);
        const status: ReachStatus = { state: probed.state, url: reach.url, expiresAt: reach.expiresAt };
        if (probed.state !== "slow" && probed.state !== "unreachable") {
          suspects.delete(r.id);
          // An answer the guest did not send is a reason to ask the provider, never a verdict on the guest: the
          // state on show stays as it was, and a machine the provider has paused is caught by its own word.
          return done(await machineState(r, reconcile, !probed.fromDaemon), status);
        }
        const judged = await judge(r, status, reconcile);
        return { ...done(judged.state, judged.reach), ...(judged.reason !== undefined ? { reason: judged.reason } : {}) };
      }),
    );
  };

  /** A tick that throws is a tick that failed, never an unhandled rejection: one of those takes the host down with it. */
  const guarded = (what: string, run: () => Promise<void>) => (): void => {
    void run().catch((e: unknown) => console.warn(`${what} tick failed`, e));
  };

  let watchers = 0;
  let costTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const lastEmitted = new Map<string, string>();

  const costTick = async (): Promise<void> => {
    await loading;
    const now = clock.now();
    for (const { size, ...view } of await o.records()) {
      const m = meter(view.id);
      if (view.phase === "running") m.mark ??= now;
      // A gone record's stretch is over and its end unknown (the host may have been down when the provider lost the
      // machine): the mark goes without folding, so no tick after a rebuild bills the gap.
      else if (view.phase === "gone") m.mark = undefined;
      const running = view.phase === "running" && m.mark !== undefined;
      const rate = o.rateUsdPerHour(size);
      const awakeMs = m.awakeMs + (running ? now - m.mark! : 0);
      const tick: WorkspaceCostEvent = {
        type: "workspace.cost",
        workspaceId: view.id,
        phase: view.phase,
        rateUsdPerHour: running ? rate : 0,
        awakeMs,
        accruedUsd: (rate * awakeMs) / 3_600_000,
        at: new Date(now).toISOString(),
      };
      const before = histories.get(view.id) ?? [];
      const next = appendCostPoint(before, tick);
      histories.set(view.id, next);
      // A tick that replaced the newest point lies on the stored line; only an added point changes the document.
      const added = before.length === 0 || next[next.length - 2] === before[before.length - 1];
      if (added) persist(() => o.store.put(COST_HISTORIES, view.id, { workspaceId: view.id, points: next } satisfies CostHistoryRecord));
      o.emit(tick);
    }
  };

  const pollTick = async (): Promise<void> => {
    for (const status of await list({ reconcile: "on-failure" })) {
      const key = JSON.stringify(status);
      if (lastEmitted.get(status.id) === key) continue;
      lastEmitted.set(status.id, key);
      o.emit({ type: "workspace.status", status });
    }
  };

  const watch: StatusApi["watch"] = opts => {
    watchers++;
    if (watchers === 1) {
      costTimer = setInterval(guarded("cost", costTick), opts?.costIntervalMs ?? costIntervalMs);
      pollTimer = setInterval(guarded("status poll", pollTick), opts?.pollIntervalMs ?? pollIntervalMs);
      costTimer.unref?.();
      pollTimer.unref?.();
      // Every machine's state before the first cost tick: nothing polls while no client watches, so a client
      // attaching after a gap would otherwise meter a stretch the provider ended hours ago.
      guarded("status poll", pollTick)();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      watchers--;
      if (watchers === 0) {
        clearInterval(costTimer);
        clearInterval(pollTimer);
        costTimer = pollTimer = undefined;
        lastEmitted.clear();
      }
    };
  };

  const history: StatusApi["history"] = async id => {
    await loading;
    return histories.get(id) ?? [];
  };

  return { list, watch, history };
}
