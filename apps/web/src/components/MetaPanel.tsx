// SPDX-License-Identifier: AGPL-3.0-only
// TICKET: meta panel (Plan 3 Task 7)
// STUB. Task 7 fills: machine facts, spend sparkline, snapshot lineage +
// rollback, upgrade button (Workspace.upgrade), pause/wake.
import { useSelectedId, useWorkspace } from "../protocol/store.js";
import styles from "./MetaPanel.module.css";
export function MetaPanel() {
  const id = useSelectedId();
  const w = useWorkspace(id);
  if (!w) return <div className={styles.meta}><span className={styles.dim}>no selection</span></div>;
  return (
    <div className={styles.meta}>
      <div className={styles.row}><span className={styles.k}>workspace</span><span className={styles.v}>{w.name ?? w.id.slice(0, 8)}</span></div>
      <div className={styles.row}><span className={styles.k}>phase</span><span className={styles.v}>{w.phase}</span></div>
      <div className={styles.dim}>meta panel · Task 7</div>
    </div>
  );
}
