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

import type { MachineState, PreviewReach } from "@wsp/engine";
import type { EventUnion, ReachState, WorkspacePhase, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";

/** The provider word the runtime's own phase implies: a wake in flight is a machine starting. */
export function machineStateOf(phase: WorkspacePhase): MachineState {
  return phase === "running" ? "running" : phase === "napping" ? "paused" : "starting";
}

export interface ProbeOptions {
  /** An answer slower than this is the edge being slow, whatever its status. */
  promptMs: number;
  /** No answer by this is unreachable. Must tolerate a slow edge (measured 502s after 5 to 11 s). */
  timeoutMs: number;
}

/** One HTTP round trip against the minted URL. A prompt 502 means the edge
 * dialed the guest and nothing listens on the daemon port; any other prompt
 * response came from inside the guest (the daemon's ws server answers plain
 * HTTP with 426). A late answer, 502 included, is a provider slow spell: the
 * machine is there, the edge is not keeping up. Silence is unreachable. */
export async function probeReach(url: string, o: ProbeOptions): Promise<ReachState> {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs) });
    await res.text().catch(() => "");
    if (Date.now() - started > o.promptMs) return "slow";
    return res.status === 502 ? "no-daemon" : "reachable";
  } catch {
    return "unreachable";
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
}

export interface StatusApi {
  list(opts?: StatusListOptions): Promise<WorkspaceStatus[]>;
  /** Refcounted: while at least one watcher holds this, the poller and cost
   * ticker run and their events ride the runtime bus. Returns the release. */
  watch(opts?: StatusWatchOptions): () => void;
}

/** A workspace as the tracker needs it: the view, the size the provider built
 * (views carry no size), and roads to the machine that never go through
 * backend.get. daemonReach is absent on backends without preview URLs. */
export interface StatusRecord extends WorkspaceView {
  size: WorkspaceSize;
  idleAt?: number;
  daemonReach?: () => Promise<PreviewReach>;
  providerState: () => Promise<MachineState>;
}

export interface StatusTrackerOptions {
  rateUsdPerHour(size: WorkspaceSize): number;
  records(): Promise<StatusRecord[]>;
  emit(event: EventUnion): void;
  on(type: EventUnion["type"] | "*", listener: (e: EventUnion) => void): () => void;
  defaults?: StatusWatchOptions;
}

interface Meter {
  awakeMs: number;
  /** Set while running: when the current awake stretch began. */
  mark?: number;
}

const PROBE_TIMEOUT_MS = 10_000;
const PROMPT_MS = 2_500;
const RECONCILE_MIN_MS = 5 * 60_000;

export function createStatusTracker(o: StatusTrackerOptions): StatusApi {
  const probeTimeoutMs = o.defaults?.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const promptMs = o.defaults?.promptMs ?? PROMPT_MS;
  const reconcileMinMs = o.defaults?.reconcileMinMs ?? RECONCILE_MIN_MS;
  const costIntervalMs = o.defaults?.costIntervalMs ?? 5_000;
  const pollIntervalMs = o.defaults?.pollIntervalMs ?? 15_000;
  const meters = new Map<string, Meter>();
  const reconciled = new Map<string, { state: MachineState; at: number }>();

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
  o.on("workspace.created", e => {
    if (e.type === "workspace.created") meter(e.workspace.id).mark = Date.now();
  });
  o.on("workspace.woken", e => {
    if (e.type === "workspace.woken") meter(e.workspaceId).mark ??= Date.now();
  });
  o.on("workspace.napped", e => {
    if (e.type !== "workspace.napped") return;
    const m = meter(e.workspaceId);
    if (m.mark !== undefined) m.awakeMs += Date.now() - m.mark;
    m.mark = undefined;
  });
  o.on("workspace.deleted", e => {
    if (e.type !== "workspace.deleted") return;
    meters.delete(e.workspaceId);
    lastEmitted.delete(e.workspaceId);
    reconciled.delete(e.workspaceId);
  });

  /** The provider's word, or our own when it cannot be had (weather is not a
   * reason to report a running workspace as anything else). */
  const askProvider = async (r: StatusRecord): Promise<MachineState> => {
    try {
      const state = await r.providerState();
      reconciled.set(r.id, { state, at: Date.now() });
      return state;
    } catch (e) {
      if ((e as { kind?: string }).kind !== "missing") return machineStateOf(r.phase);
      reconciled.set(r.id, { state: "gone", at: Date.now() });
      return "gone";
    }
  };

  const machineState = async (r: StatusRecord, reconcile: StatusListOptions["reconcile"], reachFailed: boolean): Promise<MachineState> => {
    if (reconcile === "always") return askProvider(r);
    if (!reachFailed) return machineStateOf(r.phase);
    const known = reconciled.get(r.id);
    if (known && Date.now() - known.at < reconcileMinMs) return known.state;
    return askProvider(r);
  };

  const list: StatusApi["list"] = async opts => {
    const records = await o.records();
    const probe: ProbeOptions = { promptMs: opts?.promptMs ?? promptMs, timeoutMs: opts?.probeTimeoutMs ?? probeTimeoutMs };
    const reconcile = opts?.reconcile ?? "always";

    return Promise.all(
      records.map(async (r): Promise<WorkspaceStatus> => {
        const { size, idleAt, daemonReach, providerState, ...view } = r;
        void providerState;
        const base = { ...view, size, rateUsdPerHour: o.rateUsdPerHour(size), ...(idleAt !== undefined ? { idleAt } : {}) };
        const done = (state: MachineState, reach: WorkspaceStatus["reach"]): WorkspaceStatus =>
          state === "gone" ? { ...base, machineState: state, reach: { state: "gone" } } : { ...base, machineState: state, reach };

        // Measured: the reach goes dark only while paused and works again on wake.
        if (view.phase !== "running") return done(await machineState(r, reconcile, false), { state: "napping" });
        if (!daemonReach) return done(await machineState(r, reconcile, false), { state: "unsupported" });

        let reach: PreviewReach;
        try {
          reach = await daemonReach();
        } catch {
          return done(await machineState(r, reconcile, true), { state: "unreachable" });
        }
        const state = await probeReach(reach.url, probe);
        const failed = state === "no-daemon" || state === "unreachable";
        return done(await machineState(r, reconcile, failed), { state, url: reach.url, expiresAt: reach.expiresAt });
      }),
    );
  };

  let watchers = 0;
  let costTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const lastEmitted = new Map<string, string>();

  const costTick = async (): Promise<void> => {
    const now = Date.now();
    for (const { size, ...view } of await o.records()) {
      const m = meter(view.id);
      if (view.phase === "running") m.mark ??= now;
      const running = view.phase === "running" && m.mark !== undefined;
      const rate = o.rateUsdPerHour(size);
      const awakeMs = m.awakeMs + (running ? now - m.mark! : 0);
      o.emit({
        type: "workspace.cost",
        workspaceId: view.id,
        phase: view.phase,
        rateUsdPerHour: running ? rate : 0,
        awakeMs,
        accruedUsd: (rate * awakeMs) / 3_600_000,
        at: new Date(now).toISOString(),
      });
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
      costTimer = setInterval(() => void costTick(), opts?.costIntervalMs ?? costIntervalMs);
      pollTimer = setInterval(() => void pollTick(), opts?.pollIntervalMs ?? pollIntervalMs);
      costTimer.unref?.();
      pollTimer.unref?.();
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

  return { list, watch };
}
