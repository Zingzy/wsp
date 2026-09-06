// SPDX-License-Identifier: AGPL-3.0-only
// Machine surface protocol hooks: the workspace's cost series (the runtime's
// history, then the live ticks folded onto it) and the optimistic upgrade
// flow, mirroring the store's nap/wake pattern.
import { useCallback, useEffect, useState } from "react";
import { appendCostPoint, type WorkspaceCostEvent, type WorkspaceSize, type WorkspaceView } from "@wsp/protocol";
import type { Api } from "./client.js";
import { useProtocolEvents, useStatus, useStore } from "./store.js";

/** The runtime's history with the ticks that landed while it was in flight folded on after it. */
function seeded(history: WorkspaceCostEvent[], live: readonly WorkspaceCostEvent[]): WorkspaceCostEvent[] {
  const last = history[history.length - 1];
  const after = last === undefined ? live : live.filter(p => p.at > last.at);
  return after.reduce(appendCostPoint, history);
}

/** The workspace's accrued cost since metering began: its history once fetched, every live tick after.
 * Rate-constant runs fold to their ends, so a day of ticks stays a handful of points. */
export function useCostSeries(id: string | null): WorkspaceCostEvent[] {
  const api = useStore(s => s.api);
  const [series, setSeries] = useState<WorkspaceCostEvent[]>([]);

  useEffect(() => {
    setSeries([]);
    if (id === null || api?.costHistory === undefined) return;
    let current = true;
    api
      .costHistory(id)
      .then(history => {
        if (current) setSeries(live => seeded(history, live));
      })
      .catch((e: unknown) => console.warn("cost history unavailable; the chart begins at the first live tick", e));
    return () => {
      current = false;
    };
  }, [api, id]);

  useProtocolEvents(
    useCallback(
      e => {
        if (e.type !== "workspace.cost" || e.workspaceId !== id) return;
        setSeries(s => appendCostPoint(s, e));
      },
      [id],
    ),
  );
  return series;
}

export type UpgradePhase =
  | { kind: "idle" }
  | { kind: "resizing"; size: WorkspaceSize }
  /** Op confirmed; the painted size holds until a status event carries it. */
  | { kind: "settling"; size: WorkspaceSize }
  | { kind: "failed"; message: string };

export interface Upgrade {
  phase: UpgradePhase;
  run(size: WorkspaceSize): void;
  dismiss(): void;
}

export function useUpgrade(id: string): Upgrade {
  const api = useStore(s => s.api);
  const status = useStatus(id);
  const [phase, setPhase] = useState<UpgradePhase>({ kind: "idle" });

  useEffect(() => {
    if (phase.kind !== "settling" || !status) return;
    if (status.size.cpu === phase.size.cpu && status.size.memMb === phase.size.memMb) setPhase({ kind: "idle" });
  }, [phase, status]);

  const run = useCallback(
    (size: WorkspaceSize) => {
      if (!api) {
        setPhase({ kind: "failed", message: "not connected to the runtime" });
        return;
      }
      setPhase({ kind: "resizing", size });
      api
        .upgrade(id, size)
        .then(() => setPhase({ kind: "settling", size }))
        .catch((e: unknown) => setPhase({ kind: "failed", message: e instanceof Error ? e.message : String(e) }));
    },
    [api, id],
  );

  const dismiss = useCallback(() => setPhase({ kind: "idle" }), []);
  return { phase, run, dismiss };
}

/** Doubling ladder above the current size. The 16 vCPU cap is a placeholder
 * guess, not a provider fact: no size catalog exists on the wire, only the
 * capabilities.resize flag the panel gates on. Pricing is linear per vCPU +
 * per GB, so scaling both by k scales the rate by k. */
export function upgradeOptions(current: WorkspaceSize): WorkspaceSize[] {
  const out: WorkspaceSize[] = [];
  for (let k = 2; current.cpu * k <= 16; k *= 2) out.push({ cpu: current.cpu * k, memMb: current.memMb * k });
  return out;
}
