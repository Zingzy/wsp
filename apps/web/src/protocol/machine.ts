// SPDX-License-Identifier: AGPL-3.0-only
// Machine surface protocol hooks: live cost-series accumulation (no history op
// exists on the wire, so the series starts when the surface mounts) and the
// optimistic upgrade flow, mirroring the store's nap/wake pattern.
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceSize, WorkspaceView } from "@wsp/protocol";
import type { Api } from "./client.js";
import { useProtocolEvents, useStatus, useStore } from "./store.js";

export interface CostPoint {
  rateUsdPerHour: number;
  accruedUsd: number;
  awakeMs: number;
  at: string;
}

/** ~4 minutes of 5s cost ticks; one bar each in the usage chart. */
const MAX_POINTS = 48;

export function useCostSeries(id: string | null): CostPoint[] {
  const [series, setSeries] = useState<Record<string, CostPoint[]>>({});
  useProtocolEvents(
    useCallback(e => {
      if (e.type === "workspace.deleted") {
        setSeries(s => {
          const { [e.workspaceId]: _gone, ...rest } = s;
          return rest;
        });
        return;
      }
      if (e.type !== "workspace.cost") return;
      setSeries(s => {
        const prev = s[e.workspaceId] ?? [];
        const point: CostPoint = {
          rateUsdPerHour: e.rateUsdPerHour,
          accruedUsd: e.accruedUsd,
          awakeMs: e.awakeMs,
          at: e.at,
        };
        return { ...s, [e.workspaceId]: [...prev.slice(-(MAX_POINTS - 1)), point] };
      });
    }, []),
  );
  return id ? (series[id] ?? []) : [];
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
