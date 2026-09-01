// SPDX-License-Identifier: AGPL-3.0-only
// TICKET: workspace rail (Plan 3 Task 2)
// Minimal live render below proves the data path. Task 2 enriches to the mock's
// 3-row cards: live cost ticker, spend-pulse, optimistic nap/wake w/ reconcile.
import { useSelectedId, useStore, useWorkspaces } from "../protocol/store.js";
import styles from "./Rail.module.css";

export function Rail() {
  const workspaces = useWorkspaces();
  const selected = useSelectedId();
  const select = useStore(s => s.select);
  return (
    <div className={styles.rail}>
      <div className={styles.head}>wsp</div>
      {workspaces.length === 0 && <div className={styles.empty}>no workspaces yet</div>}
      {workspaces.map(w => (
        <button key={w.id} className={styles.card} data-selected={w.id === selected} onClick={() => select(w.id)}>
          <span className={styles.dot} data-phase={w.phase} />
          <span className={styles.name}>{w.name ?? w.id.slice(0, 8)}</span>
          <span className={styles.phase}>{w.phase}</span>
        </button>
      ))}
    </div>
  );
}
