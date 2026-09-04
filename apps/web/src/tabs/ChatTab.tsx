// SPDX-License-Identifier: AGPL-3.0-only
// The chat tab slot: the transplanted ChatView with the composer in its slot.
// The composer is keyed by workspace so the editor and its undo history
// remount on a switch; the draft store keeps each workspace's text.
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { ChatView } from "../components/chat/ChatView.js";
import styles from "./chat/ChatTab.module.css";

export function ChatTab({ workspaceId }: { workspaceId: string }) {
  return (
    <div className={styles.root}>
      <ChatView workspaceId={workspaceId}>{thread => <ChatComposer key={workspaceId} workspaceId={workspaceId} thread={thread} />}</ChatView>
    </div>
  );
}
