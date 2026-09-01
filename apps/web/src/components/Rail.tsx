// SPDX-License-Identifier: AGPL-3.0-only
// Workspace rail (Plan 3 Task 2): 3-row cards per the approved mock, fed by
// the enriched status subscription + cost ticker. Ticket additions: the
// new-workspace affordance, and the awake ring turning amber during live
// sessions (coordinator ruling on ticket 19).
import { useState } from "react";
import type { WorkspaceView } from "@wsp/protocol";
import { useCost, useSelectedId, useSpending, useStatus, useStore, useWorkspaces } from "../protocol/store.js";
import styles from "./Rail.module.css";

const money = (n: number, d = 4): string => `$${n.toFixed(d)}`;

function Card({ w }: { w: WorkspaceView }) {
  const selected = useSelectedId() === w.id;
  const status = useStatus(w.id);
  const cost = useCost(w.id);
  const spending = useSpending(w.id);
  const select = useStore(s => s.select);
  const toggle = useStore(s => s.toggle);
  const running = w.phase === "running";

  const size = status ? `${status.size.cpu} vCPU · ${status.size.memMb / 1024} GB` : " ";
  const reachNote =
    status && (status.reach.state === "no-daemon" || status.reach.state === "unreachable")
      ? ` · ${status.reach.state === "no-daemon" ? "no daemon" : "unreachable"}`
      : "";
  const rate = running ? `${money(cost?.rateUsdPerHour ?? status?.rateUsdPerHour ?? 0, 3)}/hr` : "$0/hr";

  return (
    <div
      className={styles.card}
      data-selected={selected}
      role="button"
      tabIndex={0}
      onClick={() => select(w.id)}
      onKeyDown={e => e.key === "Enter" && select(w.id)}
    >
      <span className={styles.dot} data-dot={w.id} data-phase={w.phase} data-spending={spending && running} />
      <span className={styles.name}>{w.name || w.id.slice(0, 8)}</span>
      <button
        className={styles.phase}
        aria-label={`${running ? "nap" : "wake"} ${w.name}`}
        title={running ? "nap this machine" : "wake this machine"}
        onClick={e => {
          e.stopPropagation();
          void toggle(w.id);
        }}
      >
        {w.phase}
      </button>
      <span className={styles.size}>
        {size}
        {reachNote}
      </span>
      <span className={styles.cost}>
        {rate} · <span className={styles.today}>{money(cost?.accruedUsd ?? 0)} today</span>
      </span>
    </div>
  );
}

export function Rail() {
  const workspaces = useWorkspaces();
  const createWorkspace = useStore(s => s.createWorkspace);
  const toast = useStore(s => s.toast);
  const clearToast = useStore(s => s.clearToast);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const submit = (): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void createWorkspace(trimmed);
    setName("");
    setNaming(false);
  };

  return (
    <div className={styles.rail}>
      <div className={styles.head}>
        <span className={styles.label}>workspaces</span>
        <span className={styles.count}>{workspaces.length}</span>
        <button className={styles.add} aria-label="new workspace" title="new workspace" onClick={() => setNaming(v => !v)}>
          +
        </button>
      </div>
      {naming && (
        <input
          className={styles.nameInput}
          placeholder="name"
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") setNaming(false);
          }}
        />
      )}
      <div className={styles.list}>
        {workspaces.length === 0 && <div className={styles.empty}>no workspaces yet</div>}
        {workspaces.map(w => (
          <Card key={w.id} w={w} />
        ))}
      </div>
      {toast && (
        <button className={styles.toast} onClick={clearToast}>
          {toast}
        </button>
      )}
    </div>
  );
}
