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

import { isMissing, roadFailed, type ExecResult, type MachineState, type PreviewReach } from "@wsp/engine";
import { appendCostPoint, goneWords, reachShown, type EventUnion, type MachineFacts, type ReachState, type ReachStatus, type WorkspaceCostEvent, type WorkspacePhase, type WorkspaceSize, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
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

/** What a state read makes of a record marked gone: a machine the provider still holds unmakes the verdict, running
 * as running and paused as napping, and any other answer leaves the record gone. Every road out of gone (a wake, a
 * rebuild, the sweep, the record load) reads it here, so none of them keeps a rule of its own. */
export function phaseLeavingGone(read: MachineState): "running" | "napping" | undefined {
  return read === "running" ? "running" : read === "paused" ? "napping" : undefined;
}

/** The provider's answer as a row or a log line quotes it: its status and message when the call answered with both. */
export function providerSaid(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `${status} ${message}` : message;
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
  /** The request failed before it left this computer (no DNS, no route out): the silence is the computer's, and
   * says nothing about the machine. */
  offline?: boolean;
}

/** The silence a failed request is: the machine's, or this computer's when the request never got out. */
export function missed(e: unknown): Probed {
  return { state: "unreachable", fromDaemon: false, ...(roadFailed(e) ? { offline: true } : {}) };
}

/** One HTTP round trip against the minted URL. A prompt 502 means the edge
 * dialed the guest and nothing listens on the daemon port. A late answer, 502
 * included, is a provider slow spell: the machine is there, the edge is not
 * keeping up. Silence is unreachable; a request that never got out is the
 * computer offline. */
export async function probeReach(url: string, o: ProbeOptions, now: () => number = Date.now): Promise<Probed> {
  const started = now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs) });
    await res.text().catch(() => "");
    const fromDaemon = res.status === DAEMON_ANSWER;
    if (now() - started > o.promptMs) return { state: "slow", fromDaemon };
    return { state: res.status === 502 ? "no-daemon" : "reachable", fromDaemon };
  } catch (e) {
    return missed(e);
  }
}

/** Whose run of probes a status read joins. The dampening rule wants two silences in a row before a row's word
 * turns, so every read is dampened by the run it belongs to and moves that run on: the app keeps the one a sidebar
 * row rides, and every listing door shares another. An agent polling `wsp workspaces` therefore cannot spend the
 * silence the person's row is granted, and a table on a host with no app open is still dampened by its own last
 * read rather than calling a machine dark on one blip. */
export type StatusReader = "app" | "table";

export interface StatusListOptions {
  probeTimeoutMs?: number;
  /** Which run of probes this read joins; the app's when unsaid, since the poller and its snapshot do not say. */
  reader?: StatusReader;
  promptMs?: number;
  /** "always" asks the provider for every machine (an explicit refresh; what a
   * bare list() does). "on-failure" asks only after a failed reach and reuses
   * that answer for the reconcile window; the poller runs this way. */
  reconcile?: "always" | "on-failure";
  /** Whether a machine dark past the zombie window may be settled here with an exec probe into the guest, which
   * costs up to zombieProbeTimeoutMs on top of the reach probe. The poller pays it, since the verdict is its to
   * keep; false bounds a caller's wait to one reach probe and shows the word the poller last settled on. */
  zombieProbe?: boolean;
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
 * backend.get. daemonReach is absent on a machine whose kind has no road to a daemon. */
export interface StatusRecord extends WorkspaceView {
  size: WorkspaceSize;
  /** The awake rate for this workspace's size on its own backend: a cloud fork's from the provider's pricing, a local
   * workspace's zero. Computed per record because the rate varies by the machine's kind, not by size alone. */
  rateUsdPerHour: number;
  /** Which write of the record this view is of; the poll drops a row built on a view the record has moved past. */
  generation: number;
  idleAt?: number;
  /** A line the runtime keeps saying about this workspace, which every status built from the record carries: what a
   * wake still asking the provider says, and what it left behind when its asking ran out, so the row neither falls
   * silent between two asks nor forgets at the next tick that the rebuild is the road left. */
  reason?: string;
  /** Where this machine's daemon answers and when that route expires; the probe fetches the one and the row carries
   * the other, so whatever else a kind's road hands out (a token) stays off this. */
  daemonReach?: () => Promise<Pick<PreviewReach, "url" | "expiresAt">>;
  providerState: () => Promise<MachineState>;
  /** The host's own word on the machine; absent on backends without one. */
  metrics?: () => Promise<void>;
  /** What a machine that already existed says about itself; absent on a fork wsp made. */
  facts?: () => Promise<MachineFacts>;
  exec: (cmd: string, opts?: { timeoutMs?: number }) => Promise<ExecResult>;
}

export interface StatusTrackerOptions {
  records(): Promise<StatusRecord[]>;
  /** Holds each workspace's folded cost history so the series and the meter behind it outlive the process. */
  store: Store;
  emit(event: EventUnion): void;
  on(type: EventUnion["type"] | "*", listener: (e: EventUnion) => void): () => void;
  defaults?: StatusWatchOptions;
  /** Every status the poll built, on every tick, ahead of the bus dropping the ones that did not change. What a
   * client needs is the changes; what the runtime needs about its own machines is the measurement, and a machine
   * parked in one state changes nothing for hours while staying just as dark. */
  onPolled?(statuses: WorkspaceStatus[]): void;
  /** Time source for the meters, the reconcile and zombie windows and the probe's elapsed read, and the timer the cost
   * and poll ticks run on; tests inject one they can advance. */
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
/** How often the poller reads the running records; the idle nap that failed is asked again on the same cadence. */
export const POLL_INTERVAL_MS = 15_000;
const ZOMBIE_PROBE_CMD = "echo ok";

/** The total at a tick: the last tick's total plus the awake time since it at the rate that tick carried. A tick
 * lands at every event that opens or re-prices a stretch (a create, a wake, a size change), so that rate is the one
 * that held until this tick; only the first tick ever has none behind it, and its stretch ran at the size now. */
function accrue(last: WorkspaceCostEvent | undefined, awakeMs: number, rateNow: number): number {
  return (last?.accruedUsd ?? 0) + ((last?.rateUsdPerHour ?? rateNow) * (awakeMs - (last?.awakeMs ?? 0))) / 3_600_000;
}

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

/** What the last probe of a workspace's current machine found, raw, and the reach word its row was last given. */
interface Probes {
  machineId: string;
  last?: ReachState;
  shown: ReachState;
}

export function createStatusTracker(o: StatusTrackerOptions): StatusApi {
  const probeTimeoutMs = o.defaults?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const promptMs = o.defaults?.promptMs ?? PROMPT_MS;
  const reconcileMinMs = o.defaults?.reconcileMinMs ?? RECONCILE_MIN_MS;
  const zombieWindowMs = o.defaults?.zombieWindowMs ?? ZOMBIE_WINDOW_MS;
  const zombieProbeTimeoutMs = o.defaults?.zombieProbeTimeoutMs ?? ZOMBIE_PROBE_TIMEOUT_MS;
  const costIntervalMs = o.defaults?.costIntervalMs ?? 5_000;
  const pollIntervalMs = o.defaults?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const clock = o.clock ?? realClock;
  const meters = new Map<string, Meter>();
  const histories = new Map<string, WorkspaceCostEvent[]>();
  const reconciled = new Map<string, { state: MachineState; at: number }>();
  /** The words behind a gone answer, per workspace, so the status that reports it can quote the provider. */
  const goneReasons = new Map<string, string>();
  const suspects = new Map<string, Suspect>();
  /** One run of probes per reader, per workspace; a reader that has never read a machine starts clean. */
  const probes = new Map<StatusReader, Map<string, Probes>>();
  /** Per workspace, the machine whose metrics 404 was logged while its guest still answered, so the line lands once per spell. */
  const doubted = new Map<string, string>();
  /** The awake stretch a gone verdict closed, per workspace, until a record leaves gone and reopens it or a rebuild
   * or a nap makes it stale. A verdict the state read later unmakes was never true, and the machine under it went
   * on billing, so those hours belong to the stretch rather than to nothing. */
  const closedByGone = new Map<string, { mark: number; awakeMs: number }>();

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
    if (e.type !== "workspace.woken") return;
    const reopened = closedByGone.get(e.workspaceId);
    if (reopened === undefined) return beganAwake(e.workspaceId);
    // A record that leaves gone was never paused: the machine went on running and billing through the gap, so the
    // stretch the verdict closed reopens where it began rather than a fresh one starting now.
    closedByGone.delete(e.workspaceId);
    const m = meter(e.workspaceId);
    m.mark = reopened.mark;
    m.awakeMs = reopened.awakeMs;
    sawAwake(e.workspaceId);
  });
  // A rebuild put another machine under the record: the stretch the verdict closed was the old one's.
  o.on("workspace.upgraded", e => {
    if (e.type === "workspace.upgraded") closedByGone.delete(e.workspaceId);
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
      // A machine found paused stopped billing somewhere in the gap and nothing says when, so that stretch stays
      // closed at the last proof; only a gone verdict is one a later read can unmake.
      if (e.type === "workspace.napped") closedByGone.delete(e.workspaceId);
      else if (m.mark !== undefined) closedByGone.set(e.workspaceId, { mark: m.mark, awakeMs: m.awakeMs });
      if (m.mark !== undefined) m.awakeMs += Math.max(0, ended - m.mark);
      m.mark = undefined;
    });
  }
  o.on("workspace.deleted", e => {
    if (e.type !== "workspace.deleted") return;
    meters.delete(e.workspaceId);
    closedByGone.delete(e.workspaceId);
    forget(e.workspaceId);
    lastEmitted.delete(e.workspaceId);
    reconciled.delete(e.workspaceId);
    goneReasons.delete(e.workspaceId);
    suspects.delete(e.workspaceId);
    for (const book of probes.values()) book.delete(e.workspaceId);
    doubted.delete(e.workspaceId);
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

  /** The host's own read of a machine the state read calls running, logged once per spell and never a verdict: one
   * metrics 404 over a machine whose state read said running, and that a direct read found running two minutes
   * later, killed two live turns on 2026-09-08. Gone is the state read's word alone. */
  const noteMetricsGap = async (r: StatusRecord): Promise<void> => {
    if (r.metrics === undefined) return;
    let gap: string;
    try {
      await r.metrics();
      doubted.delete(r.id);
      return;
    } catch (e) {
      if (!isMissing(e)) return;
      gap = providerSaid(e);
    }
    if (doubted.get(r.id) === r.machineId) return;
    doubted.set(r.id, r.machineId);
    console.warn(`host metrics for ${r.machineId} (workspace ${r.id}) answered ${gap}; the state read says running and the record follows the state read`);
  };

  /** The provider's word, or our own when it cannot be had (weather is not a reason to report a running workspace
   * as anything else). Only the state read by id names a machine gone. */
  const askProvider = async (r: StatusRecord): Promise<MachineState> => {
    let state: MachineState;
    let answer: string | undefined;
    try {
      state = await r.providerState();
    } catch (e) {
      if (!isMissing(e)) return machineStateOf(r.phase);
      state = "gone";
      answer = providerSaid(e);
    }
    if (state === "running") await noteMetricsGap(r);
    reconciled.set(r.id, { state, at: clock.now() });
    if (state === "running") sawAwake(r.id);
    if (state === "gone") goneReasons.set(r.id, goneWords(r.machineId, { by: "status poll", at: clock.now(), ...(answer !== undefined ? { answer } : {}) }));
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

  /** This reader's probes of this workspace's current machine; a replaced machine starts clean, and a machine never
   * probed is given the word the runtime claims for a running one until a probe says otherwise. Kept per reader, so
   * one door's probe is never counted as the silence another door's row was waiting out. */
  const probesOf = (r: StatusRecord, reader: StatusReader): Probes => {
    let book = probes.get(reader);
    if (book === undefined) probes.set(reader, (book = new Map()));
    const known = book.get(r.id);
    if (known !== undefined && known.machineId === r.machineId) return known;
    const fresh: Probes = { machineId: r.machineId, shown: "reachable" };
    book.set(r.id, fresh);
    return fresh;
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
   * reads healthy again or the machine is replaced. A caller that will not
   * wait out that probe leaves the verdict to the poller and reads the word it
   * last settled on. */
  const judge = async (
    r: StatusRecord,
    reach: ReachStatus,
    opts: StatusListOptions | undefined,
  ): Promise<{ state: MachineState; reach: ReachStatus; reason?: string }> => {
    const reconcile = opts?.reconcile ?? "always";
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
    if (opts?.zombieProbe === false) return { state: provider, reach };
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

  const statusesOf = async (records: StatusRecord[], opts: StatusListOptions | undefined): Promise<WorkspaceStatus[]> => {
    const probe: ProbeOptions = { promptMs: opts?.promptMs ?? promptMs, timeoutMs: opts?.probeTimeoutMs ?? probeTimeoutMs };
    const reconcile = opts?.reconcile ?? "always";

    return Promise.all(
      records.map(async (r): Promise<WorkspaceStatus> => {
        const { size, idleAt, daemonReach, providerState, metrics, facts, exec, generation, ...view } = r;
        void providerState;
        void metrics;
        void exec;
        void generation;
        // A machine that cannot say what it is this tick keeps its row; the facts are the one part left off it.
        const said = facts === undefined ? undefined : await facts().catch(() => undefined);
        const base = { ...view, size, rateUsdPerHour: r.rateUsdPerHour, ...(idleAt !== undefined ? { idleAt } : {}), ...(said !== undefined ? { facts: said } : {}) };
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

        const memory = probesOf(r, opts?.reader ?? "app");
        let route: Pick<PreviewReach, "url" | "expiresAt"> | undefined;
        let probed: Probed;
        try {
          route = await daemonReach();
          probed = await probeReach(route.url, probe, clock.now);
        } catch (e) {
          probed = missed(e);
        }
        const at = route === undefined ? {} : { url: route.url, expiresAt: route.expiresAt };
        // Nothing was learnt about the machine: the row keeps its word, the run of probes under it is left as it was.
        if (probed.offline === true) return done(await machineState(r, reconcile, false), { state: memory.shown, ...at, offline: true });
        if (probed.fromDaemon) sawAwake(r.id);
        const shown = reachShown(memory.last, probed.state);
        memory.last = probed.state;
        memory.shown = shown;
        // A route the provider would not mint is a failed reach with no zombie window: the guest was never dialled.
        if (route === undefined) return done(await machineState(r, reconcile, true), { state: shown });
        const status: ReachStatus = { state: probed.state, ...at };
        if (probed.state !== "slow" && probed.state !== "unreachable") {
          suspects.delete(r.id);
          // An answer the guest did not send is a reason to ask the provider, never a verdict on the guest: the
          // state on show stays as it was, and a machine the provider has paused is caught by its own word. The
          // ask runs on the raw answer; only the word the row carries waits out a window, as the silence does.
          return done(await machineState(r, reconcile, !probed.fromDaemon), { ...status, state: shown });
        }
        // The window and the exec probe run on the raw silence; only the word on the row waits for a second one.
        const judged = await judge(r, status, opts);
        const reach = judged.reach.state === "zombie" ? judged.reach : { ...judged.reach, state: shown };
        memory.shown = reach.state;
        return { ...done(judged.state, reach), ...(judged.reason !== undefined ? { reason: judged.reason } : {}) };
      }),
    );
  };

  const list: StatusApi["list"] = async opts => statusesOf(await o.records(), opts);

  /** A tick that throws is a tick that failed, never an unhandled rejection: one of those takes the host down with it. */
  const guarded = (what: string, run: () => Promise<void>) => (): void => {
    void run().catch((e: unknown) => console.warn(`${what} tick failed`, e));
  };

  /** Runs fn every ms on the clock, the first time one interval from now; the returned function stops it. */
  const every = (fn: () => void, ms: number): (() => void) => {
    let cancel = (): void => {};
    const arm = (): void => {
      cancel = clock.schedule(() => { arm(); fn(); }, ms, { unref: true });
    };
    arm();
    return () => cancel();
  };

  let watchers = 0;
  let stopCost: (() => void) | undefined;
  let stopPoll: (() => void) | undefined;
  const lastEmitted = new Map<string, string>();
  // A status the runtime pushed between polls is a row a client has already been given, so it belongs in the
  // baseline the next poll is held against. Without this a push moves the row and the poll's own word for the same
  // machine reads as a repeat and is dropped: a line the runtime meant to flash once then sat on the row until
  // some other fact about the machine happened to change.
  o.on("workspace.status", e => {
    if (e.type === "workspace.status") lastEmitted.set(e.status.id, JSON.stringify(e.status));
  });

  /** The timer's tick samples every workspace and always rides the bus. An event's tick is one workspace's: it pins
   * a boundary in the meter and rides the bus only when it changed the rate, so a create, a wake and a size change
   * report at once and a rebuild at the same rate reports nothing. */
  const costTick = async (only?: string): Promise<void> => {
    await loading;
    const now = clock.now();
    for (const view of await o.records()) {
      if (only !== undefined && view.id !== only) continue;
      const m = meter(view.id);
      if (view.phase === "running") m.mark ??= now;
      // A gone record's stretch is over and its end unknown (the host may have been down when the provider lost the
      // machine): the mark goes without folding, so no tick after a rebuild bills the gap.
      else if (view.phase === "gone") m.mark = undefined;
      const running = view.phase === "running" && m.mark !== undefined;
      const rate = view.rateUsdPerHour;
      const awakeMs = m.awakeMs + (running ? now - m.mark! : 0);
      const before = histories.get(view.id) ?? [];
      const last = before.at(-1);
      const tick: WorkspaceCostEvent = {
        type: "workspace.cost",
        workspaceId: view.id,
        phase: view.phase,
        rateUsdPerHour: running ? rate : 0,
        awakeMs,
        accruedUsd: accrue(last, awakeMs, rate),
        at: new Date(now).toISOString(),
      };
      const next = appendCostPoint(before, tick);
      histories.set(view.id, next);
      // A tick that replaced the newest point lies on the stored line; only an added point changes the document.
      const added = before.length === 0 || next[next.length - 2] === before[before.length - 1];
      if (added) persist(() => o.store.put(COST_HISTORIES, view.id, { workspaceId: view.id, points: next } satisfies CostHistoryRecord));
      if (only === undefined || last?.rateUsdPerHour !== tick.rateUsdPerHour) o.emit(tick);
    }
  };

  // A tick at every event that opens, re-prices or ends a stretch for good: the rate a tick carries then holds until
  // the next one, so a size change an hour after an unwatched wake still bills that hour at the size it woke at, and
  // a machine found gone reads rate 0 from that instant rather than from the timer's next tick.
  const eventTick = (id: string): void => guarded("cost", () => costTick(id))();
  o.on("workspace.created", e => {
    if (e.type === "workspace.created") eventTick(e.workspace.id);
  });
  for (const type of ["workspace.woken", "workspace.upgraded", "workspace.gone"] as const) {
    o.on(type, e => {
      if (e.type === type) eventTick(e.workspaceId);
    });
  }

  const pollTick = async (): Promise<void> => {
    const records = await o.records();
    const statuses = await statusesOf(records, { reconcile: "on-failure" });
    // A record written while its poll was in flight pushed its own row since; the poll's older row would put a phase the record has left back on the screen.
    const built = new Map(records.map(r => [r.id, r.generation]));
    const now = new Map((await o.records()).map(r => [r.id, r.generation]));
    o.onPolled?.(statuses.filter(status => now.get(status.id) === built.get(status.id)));
    for (const status of statuses) {
      if (now.get(status.id) !== built.get(status.id)) continue;
      const key = JSON.stringify(status);
      if (lastEmitted.get(status.id) === key) continue;
      lastEmitted.set(status.id, key);
      o.emit({ type: "workspace.status", status });
    }
  };

  const watch: StatusApi["watch"] = opts => {
    watchers++;
    if (watchers === 1) {
      stopCost = every(guarded("cost", () => costTick()), opts?.costIntervalMs ?? costIntervalMs);
      stopPoll = every(guarded("status poll", pollTick), opts?.pollIntervalMs ?? pollIntervalMs);
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
        stopCost?.();
        stopPoll?.();
        stopCost = stopPoll = undefined;
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
