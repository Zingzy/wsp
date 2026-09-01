// SPDX-License-Identifier: AGPL-3.0-only
// TICKET: terminal tab (Plan 3 Task 3)
// STUB. Owner ticket fills this. Contract: receives { workspaceId }, uses the
// hooks in ../protocol/store.js and events via useProtocolEvents.
import styles from "./Stub.module.css";
export function TerminalTab({ workspaceId }: { workspaceId: string }) {
  return <div className={styles.stub}><b>terminal tab</b><span>workspace {workspaceId.slice(0, 8)} · Task 3</span></div>;
}
