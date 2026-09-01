// SPDX-License-Identifier: AGPL-3.0-only
// Meta panel: machine facts, live spend sparkline, snapshot lineage with
// golden rollback, pause/wake, upgrade.
import { useCallback, useEffect, useState } from "react";
import type { SnapshotLineage, WorkspaceSize, WorkspaceStatus, WorkspaceView } from "@wsp/protocol";
import { useCapabilities, useCost, useProtocolEvents, useSelectedId, useStatus, useStore, useWorkspace } from "../protocol/store.js";
import { upgradeOptions, useCostSeries, useUpgrade, type CostPoint, type Upgrade } from "../protocol/meta.js";
import styles from "./MetaPanel.module.css";

const money = (n: number, d = 4): string => `$${n.toFixed(d)}`;
const sizeLabel = (s: WorkspaceSize): string => `${s.cpu} vCPU · ${s.memMb / 1024} GB`;

const fmtDur = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Provider word for each phase; anything else (starting, gone) is divergence. */
const expectedMachineState = (phase: WorkspaceView["phase"]): WorkspaceStatus["machineState"] =>
  phase === "running" ? "running" : "paused";

function Spark({ rates }: { rates: number[] }) {
  const W = 258;
  const H = 54;
  const PAD = 2;
  const max = Math.max(...rates, 0.01);
  const pts = rates.map((v, i): [number, number] => [
    PAD + (i * (W - 2 * PAD)) / (rates.length - 1),
    H - 4 - (v / max) * (H - 12),
  ]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || first === last) return null;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${last[0].toFixed(1)} ${H - 3} L${first[0].toFixed(1)} ${H - 3} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="spend per hour" data-spark>
      <line x1="0" y1={H - 3} x2={W} y2={H - 3} className={styles.sparkBase} />
      <path d={area} className={styles.sparkArea} />
      <path d={line} className={styles.sparkLine} />
      <circle cx={last[0]} cy={last[1]} r="2.4" className={styles.sparkDot} />
    </svg>
  );
}

interface FactsProps {
  w: WorkspaceView;
  status: WorkspaceStatus | null;
  awakeMs: number | null;
  /** Optimistically painted while an upgrade is in flight. */
  pendingSize: WorkspaceSize | null;
}

function Facts({ w, status, awakeMs, pendingSize }: FactsProps) {
  const expected = expectedMachineState(w.phase);
  const diverged = status && status.machineState !== expected ? status.machineState : null;
  return (
    <section className={styles.sect}>
      <div className={styles.sectHead}>
        <span className={styles.label}>machine</span>
        <span className={styles.headR}>{w.machineId}</span>
      </div>
      <dl className={styles.kv}>
        <dt>state</dt>
        <dd data-k="state">
          {w.phase}
          {diverged && <span className={styles.dim}> · {diverged}</span>}
          <span className={styles.stDot} data-phase={w.phase} />
        </dd>
        <dt>machine</dt>
        <dd data-k="machine">
          {pendingSize ? (
            <>
              {sizeLabel(pendingSize)}
              <span className={styles.dim}> · resizing</span>
            </>
          ) : status ? (
            sizeLabel(status.size)
          ) : (
            "—"
          )}
        </dd>
        <dt>reach</dt>
        <dd data-k="reach">{status ? status.reach.state.replace("-", " ") : "—"}</dd>
        <dt>awake</dt>
        <dd data-k="awake">{awakeMs === null ? "—" : fmtDur(awakeMs)}</dd>
      </dl>
    </section>
  );
}

function Usage({ w, status, series }: { w: WorkspaceView; status: WorkspaceStatus | null; series: CostPoint[] }) {
  const cost = useCost(w.id);
  const running = w.phase === "running";
  const rates = series.map(p => p.rateUsdPerHour);
  const start = series[0];
  const since = start
    ? new Date(start.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : null;
  const rateNow = running ? `${money(cost?.rateUsdPerHour ?? status?.rateUsdPerHour ?? 0, 3)}/hr` : "$0/hr";
  return (
    <section className={styles.sect}>
      <div className={styles.sectHead}>
        <span className={styles.label}>usage</span>
        <span className={styles.headR}>{since ? `since ${since}` : ""}</span>
      </div>
      <div className={styles.spark}>
        {rates.length > 1 ? <Spark rates={rates} /> : <div className={styles.sparkEmpty}>no spend data yet</div>}
      </div>
      <div className={styles.sparkCap}>
        spend/hr<span>{rates.length > 0 ? `peak ${money(Math.max(...rates), 2)}` : ""}</span>
      </div>
      <div className={styles.urow}>
        <span className={styles.rowL}>rate now</span>
        <span className={styles.rowV}>{rateNow}</span>
      </div>
      <div className={styles.urow}>
        <span className={styles.rowL}>accrued</span>
        <span className={styles.rowV}>{money(cost?.accruedUsd ?? 0)}</span>
      </div>
    </section>
  );
}

function Lineage({ w }: { w: WorkspaceView }) {
  const api = useStore(s => s.api);
  const [lineage, setLineage] = useState<SnapshotLineage | null>(null);
  /** Version whose rollback awaits the orange confirm. */
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!api) return () => {};
    let current = true;
    api.listSnapshots().then(
      l => {
        if (current) setLineage(l);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [api]);
  useEffect(load, [load]);
  // The manifest changes on the bus only when a golden seals (a rollback from
  // another client emits nothing), so that is the one stage worth a refetch.
  useProtocolEvents(
    useCallback(
      e => {
        if (e.type === "golden.stage" && e.stage === "sealed") load();
      },
      [load],
    ),
  );

  const rollback = async (version: number): Promise<void> => {
    if (!api) return;
    setBusy(true);
    try {
      const result = await api.rollbackSnapshot(version);
      setLineage(result.lineage);
      setNote(`new forks use v${version} · existing workspaces keep their image`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };

  // Newest first, like the mock's lineage reads top-down from the latest golden.
  const versions = lineage ? [...lineage.versions].sort((a, b) => b.version - a.version) : [];
  return (
    <section className={styles.sectLast}>
      <div className={styles.sectHead}>
        <span className={styles.label}>snapshots</span>
      </div>
      <div className={styles.snaps}>
        <div className={styles.snap} data-cur={w.phase === "running"}>
          <span className={styles.node} />
          <span>
            <span className={styles.l1}>live disk</span>
            <span className={styles.l2}>forked {w.createdAt.slice(0, 10)}</span>
          </span>
          <span className={styles.when}>now</span>
        </div>
        {versions.length === 0 ? (
          <div className={styles.snap}>
            <span className={styles.node} />
            <span>
              <span className={styles.l1} data-k="golden">
                {w.golden}
                <em>golden</em>
              </span>
              <span className={styles.l2}>base image</span>
            </span>
            <span className={styles.when} />
          </div>
        ) : (
          versions.map(v => {
            const head = v.version === lineage?.head;
            return (
              <div key={v.version} className={styles.snap} data-head={head}>
                <span className={styles.node} />
                <span>
                  <span className={styles.l1} data-k={`v${v.version}`}>
                    v{v.version}
                    {head && <em>head</em>}
                    {v.snapshotId === w.golden && <em>this fork</em>}
                  </span>
                  <span className={styles.l2}>built {v.createdAt.slice(0, 10)}</span>
                </span>
                <span className={styles.when}>
                  {!head && armed !== v.version && (
                    <button
                      className={styles.keyMini}
                      aria-label={`activate v${v.version}`}
                      title="new forks use this version; existing workspaces keep theirs"
                      disabled={busy}
                      onClick={() => setArmed(v.version)}
                    >
                      activate
                    </button>
                  )}
                </span>
                {armed === v.version && (
                  <div className={styles.rollRow}>
                    <div className={styles.uRow}>
                      head<b>v{lineage?.head} → v{v.version}</b>
                    </div>
                    <div className={styles.uRow}>
                      running workspaces<b>unchanged</b>
                    </div>
                    <div className={styles.btns}>
                      <button className={`${styles.keyMini} ${styles.keyConfirm}`} disabled={busy} onClick={() => void rollback(v.version)}>
                        confirm rollback to v{v.version}
                      </button>
                      <button className={styles.keyMini} onClick={() => setArmed(null)}>
                        cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className={styles.status}>{busy ? "rolling back…" : note}</div>
    </section>
  );
}

function Actions({ w, status, upgrade }: { w: WorkspaceView; status: WorkspaceStatus | null; upgrade: Upgrade }) {
  const toggle = useStore(s => s.toggle);
  const capabilities = useCapabilities();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<WorkspaceSize | null>(null);
  const running = w.phase === "running";
  // Backend fact, not a probe: a provider that cannot resize gets no picker at all.
  const canResize = capabilities?.resize === true;
  const options = status && canResize ? upgradeOptions(status.size) : [];
  const choice = picked ?? options[0] ?? null;
  const rate = status?.rateUsdPerHour ?? null;

  const close = (): void => {
    setOpen(false);
    setPicked(null);
  };
  const confirm = (): void => {
    if (!choice) return;
    close();
    upgrade.run(choice);
  };

  return (
    <div className={styles.actions}>
      <div className={styles.btns}>
        <button
          className={styles.key}
          aria-label={`${running ? "pause" : "wake"} ${w.name}`}
          title={running ? "suspend the vm, keep the disk" : "boot the vm from its disk"}
          onClick={() => void toggle(w.id)}
        >
          {running ? "pause" : "wake"}
        </button>
        <button
          className={`${styles.key} ${styles.keyPrimary}`}
          disabled={!status || options.length === 0 || upgrade.phase.kind === "resizing"}
          aria-label={`upgrade ${w.name}`}
          title={canResize ? "resize to a larger machine" : "this provider cannot resize machines"}
          onClick={() => (open ? close() : setOpen(true))}
        >
          {capabilities && !canResize ? "no resize" : status && options.length === 0 ? "largest size" : "upgrade"}
        </button>
      </div>
      {open && status && choice && (
        <div className={styles.upgradeRow}>
          {options.length > 1 && (
            <div className={styles.tiers}>
              {options.map(o => (
                <button
                  key={o.cpu}
                  className={styles.keyMini}
                  data-picked={o.cpu === choice.cpu}
                  onClick={() => setPicked(o)}
                >
                  {sizeLabel(o)}
                </button>
              ))}
            </div>
          )}
          <div className={styles.uRow}>
            current<b>{sizeLabel(status.size)}{rate !== null ? ` · ${money(rate, 3)}/hr` : ""}</b>
          </div>
          <div className={styles.uRow}>
            new<b>{sizeLabel(choice)}{rate !== null ? ` · ~${money((rate * choice.cpu) / status.size.cpu, 3)}/hr` : ""}</b>
          </div>
          <div className={styles.btns}>
            <button className={`${styles.keyMini} ${styles.keyConfirm}`} onClick={confirm}>
              confirm resize
            </button>
            <button className={styles.keyMini} onClick={close}>
              cancel
            </button>
          </div>
        </div>
      )}
      <div className={styles.status} role="status">
        {upgrade.phase.kind === "resizing" && "resizing…"}
        {upgrade.phase.kind === "settling" && "resized"}
        {upgrade.phase.kind === "failed" && (
          <button className={styles.statusErr} onClick={upgrade.dismiss}>
            {upgrade.phase.message}
          </button>
        )}
      </div>
    </div>
  );
}

function Panel({ w, series }: { w: WorkspaceView; series: CostPoint[] }) {
  const status = useStatus(w.id);
  const upgrade = useUpgrade(w.id);
  const last = series[series.length - 1];
  const pendingSize =
    upgrade.phase.kind === "resizing" || upgrade.phase.kind === "settling" ? upgrade.phase.size : null;
  return (
    <div className={styles.meta}>
      <div className={styles.scroll}>
        <Facts w={w} status={status} awakeMs={last ? last.awakeMs : null} pendingSize={pendingSize} />
        <Usage w={w} status={status} series={series} />
        <Lineage w={w} />
      </div>
      <Actions w={w} status={status} upgrade={upgrade} />
    </div>
  );
}

export function MetaPanel() {
  const id = useSelectedId();
  const w = useWorkspace(id);
  // Unkeyed so the per-workspace series survives selection changes.
  const series = useCostSeries(id);
  if (!w) {
    return (
      <div className={styles.meta}>
        <span className={styles.empty}>no selection</span>
      </div>
    );
  }
  return <Panel key={w.id} w={w} series={series} />;
}
