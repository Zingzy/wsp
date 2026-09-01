// SPDX-License-Identifier: AGPL-3.0-only
// Placeholder pending implementation. Contract: receives { workspaceId }, uses the
// hooks in ../protocol/store.js and events via useProtocolEvents.
import styles from "./Stub.module.css";
export function ScreenTab({ workspaceId }: { workspaceId: string }) {
  return <div className={styles.stub}><b>screen tab</b><span>workspace {workspaceId.slice(0, 8)} · Task 6</span></div>;
}
