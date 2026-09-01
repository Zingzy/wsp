// SPDX-License-Identifier: AGPL-3.0-only
// TICKET: browser tab (Plan 3 Task 5)
// STUB. Owner ticket fills this. Contract: receives { workspaceId }, uses the
// hooks in ../protocol/store.js and events via useProtocolEvents.
import styles from "./Stub.module.css";
export function BrowserTab({ workspaceId }: { workspaceId: string }) {
  return <div className={styles.stub}><b>browser tab</b><span>workspace {workspaceId.slice(0, 8)} · Task 5</span></div>;
}
