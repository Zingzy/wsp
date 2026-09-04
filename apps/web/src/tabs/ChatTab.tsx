// SPDX-License-Identifier: AGPL-3.0-only
// The chat tab slot: the transplanted ChatView with the textarea composer
// under it in the view's composer slot. Enter starts exactly one turn,
// resumed through the workspace's claudeSessionId unless a new thread was
// requested, in which case the runtime starts a fresh session once the turn
// the request left behind has ended.
import { useEffect, useRef, useState } from "react";
import { useStore, useWorkspace } from "../protocol/store.js";
import { ChatView } from "../components/chat/ChatView.js";
import type { ChatThreadHandle } from "../components/chat/useChatThread.js";
import styles from "./chat/ChatTab.module.css";

const INPUT_MAX_PX = 140;

export function ChatTab({ workspaceId }: { workspaceId: string }) {
  return (
    <div className={styles.root}>
      <ChatView workspaceId={workspaceId}>{thread => <Composer workspaceId={workspaceId} thread={thread} />}</ChatView>
    </div>
  );
}

function Composer({ workspaceId, thread }: { workspaceId: string; thread: ChatThreadHandle }) {
  const api = useStore(s => s.api);
  const workspace = useWorkspace(workspaceId);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { resize(inputRef.current, draft); }, [draft]);
  useEffect(() => { if (thread.fresh && !thread.finishing) inputRef.current?.focus(); }, [thread.fresh, thread.finishing]);

  const disabledReason = !api
    ? "not connected to the runtime"
    : !thread.hydrated
      ? "loading transcript"
      : thread.finishing
        ? "finishing the previous turn"
        : thread.busy
          ? "turn in flight"
          : null;

  async function send() {
    const prompt = draft.trim();
    if (!prompt || !api || thread.busy) return;
    setDraft("");
    thread.setSending(true);
    thread.appendUserTurn(prompt);
    const resume = thread.fresh ? undefined : workspace?.claudeSessionId;
    try {
      await api.startSession({ workspaceId, prompt, ...(resume ? { resume } : {}) });
    } catch (err) {
      thread.setSending(false);
      setDraft(d => (d === "" ? prompt : d));
      thread.appendLocalError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className={styles.composer}>
      <textarea
        ref={inputRef}
        className={styles.input}
        rows={1}
        value={draft}
        placeholder="send a prompt"
        aria-label="prompt"
        disabled={disabledReason !== null}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className={styles.hint}>{disabledReason ?? "enter to send · shift+enter for newline"}</div>
    </div>
  );
}

function resize(el: HTMLTextAreaElement | null, value: string): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = value === "" ? "" : `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
}
