// SPDX-License-Identifier: AGPL-3.0-only
// Enriched workspace status + awake-time cost metering. Promoted from
// @wsp/host so every protocol client reads one implementation; the host's
// REST endpoint and the web app's rail both consume this.

import { DAEMON_PORT, previewIsFresh, type MachineBackend, type MachineState, type PreviewReach } from "@wsp/engine";
import type { EventUnion, ReachState, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";

/** One HTTP round trip against the minted URL. 502 means the edge dialed the
 * guest and nothing listens on the daemon port; any other response came from
 * inside the guest (the daemon's ws server answers plain HTTP with 426). */
async function probe(url: string, timeoutMs: number): Promise<ReachState> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.text().catch(() => "");
    return res.status === 502 ? "no-daemon" : "reachable";
  } catch {
    return "unreachable";
  }
}

export interface StatusListOptions {
  probeTimeoutMs?: number;
}

export interface StatusWatchOptions {
  costIntervalMs?: number;
  pollIntervalMs?: number;
  probeTimeoutMs?: number;
}

export interface StatusApi {
  list(opts?: StatusListOptions): Promise<WorkspaceStatus[]>;
  /** Refcounted: while at least one watcher holds this, the poller and cost
   * ticker run and their events ride the runtime bus. Returns the release. */
  watch(opts?: StatusWatchOptions): () => void;
}

export interface StatusTrackerOptions {
  backend: MachineBackend;
  /** Current workspace records with their machine spec (views carry no size). */
  records(): Promise<(WorkspaceView & { spec: { cpu?: number; memMb?: number } })[]>;
  emit(event: EventUnion): void;
  on(type: EventUnion["type"] | "*", listener: (e: EventUnion) => void): () => void;
  defaults?: StatusWatchOptions;
}

interface Meter {
  awakeMs: number;
  /** Set while running: when the current awake stretch began. */
  mark?: number;
}

export function createStatusTracker(o: StatusTrackerOptions): StatusApi {
  const probeTimeoutMs = o.defaults?.probeTimeoutMs ?? 2500;
  const costIntervalMs = o.defaults?.costIntervalMs ?? 5_000;
  const pollIntervalMs = o.defaults?.pollIntervalMs ?? 15_000;
  const reachCache = new Map<string, PreviewReach>();
  const meters = new Map<string, Meter>();

  // Rates and the assumed shape are provider facts; the tracker keeps only the arithmetic.
  const sizeOf = (spec: { cpu?: number; memMb?: number }): WorkspaceSize => ({
    cpu: spec.cpu ?? o.backend.pricing.defaultSize.cpu,
    memMb: spec.memMb ?? o.backend.pricing.defaultSize.memMb,
  });

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
  });

  const list: StatusApi["list"] = async opts => {
    const records = await o.records();
    if (records.length === 0) return [];
    // One list() call covers machine states for every workspace.
    const machineStates = new Map((await o.backend.list()).map(m => [m.id, m.state]));
    const timeoutMs = opts?.probeTimeoutMs ?? probeTimeoutMs;

    return Promise.all(
      records.map(async ({ spec, ...view }): Promise<WorkspaceStatus> => {
        const size = sizeOf(spec);
        const base = { ...view, size, rateUsdPerHour: o.backend.pricing.rateUsdPerHour(size) };
        // list() is best-effort (observed flake: empty while machines exist);
        // absence is only believed after get(id) throws "missing".
        let machineState: MachineState | undefined = machineStates.get(view.machineId);
        if (machineState === undefined) {
          try {
            machineState = await (await o.backend.get(view.machineId)).state();
          } catch (e) {
            if ((e as { kind?: string }).kind !== "missing") throw e;
            machineState = "gone";
          }
        }
        if (machineState === "gone") {
          reachCache.delete(view.machineId);
          return { ...base, machineState, reach: { state: "gone" } };
        }
        if (view.phase === "napping" || machineState !== "running") {
          // Measured: the reach goes dark only while paused and works again on
          // wake, so the cached entry stays for the next running poll.
          return { ...base, machineState, reach: { state: "napping" } };
        }

        let reach = reachCache.get(view.machineId);
        if (!reach || !previewIsFresh(reach)) {
          try {
            const machine = await o.backend.get(view.machineId);
            if (!machine.previewUrl) return { ...base, machineState, reach: { state: "unsupported" } };
            reach = await machine.previewUrl(DAEMON_PORT);
            reachCache.set(view.machineId, reach);
          } catch {
            return { ...base, machineState, reach: { state: "unreachable" } };
          }
        }
        const state = await probe(reach.url, timeoutMs);
        return { ...base, machineState, reach: { state, url: reach.url, expiresAt: reach.expiresAt } };
      }),
    );
  };

  let watchers = 0;
  let costTimer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const lastEmitted = new Map<string, string>();

  const costTick = async (): Promise<void> => {
    const now = Date.now();
    for (const { spec, ...view } of await o.records()) {
      const m = meter(view.id);
      if (view.phase === "running") m.mark ??= now;
      const running = view.phase === "running" && m.mark !== undefined;
      const rate = o.backend.pricing.rateUsdPerHour(sizeOf(spec));
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
    for (const status of await list()) {
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
