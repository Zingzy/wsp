// SPDX-License-Identifier: AGPL-3.0-only
// TICKET: chat tab (Plan 3 Task 4)
// STUB. Owner ticket fills this. Contract: receives { workspaceId }, uses the
// hooks in ../protocol/store.js and events via useProtocolEvents.
import styles from "./Stub.module.css";
export function ChatTab({ workspaceId }: { workspaceId: string }) {
  return <div className={styles.stub}><b>chat tab</b><span>workspace {workspaceId.slice(0, 8)} · Task 4</span></div>;
}
