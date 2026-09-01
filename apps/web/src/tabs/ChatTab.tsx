// SPDX-License-Identifier: AGPL-3.0-only
// Chat view over a workspace's session event stream. Rendering folds
// session.* protocol events through transcript.ts; composing is fully local,
// and Enter starts exactly one turn, resumed through the workspace's
// claudeSessionId. On mount the transcript replays from sessions.history;
// live events are ignored until that reply lands, because the socket is
// FIFO: anything pushed before the reply is already in it, anything after is
// not.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useProtocolEvents, useStore, useWorkspace } from "../protocol/store.js";
import type { ProtocolEvent } from "../protocol/client.js";
import type { SessionEvent } from "@wsp/protocol";
import {
  applySessionEvent,
  appendLocalError,
  appendUserTurn,
  emptyTranscript,
  isSessionEvent,
  type Transcript,
  type TranscriptItem,
} from "./chat/transcript.js";
import styles from "./chat/ChatTab.module.css";

const INPUT_MAX_PX = 140;

export function ChatTab({ workspaceId }: { workspaceId: string }) {
  const api = useStore(s => s.api);
  const workspace = useWorkspace(workspaceId);
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [viewedWs, setViewedWs] = useState(workspaceId);
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  const hydratedRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  if (viewedWs !== workspaceId) {
    setViewedWs(workspaceId);
    setTranscript(emptyTranscript);
    setSending(false);
  }

  useEffect(() => {
    if (!api) return;
    let current = true;
    api.sessionHistory(workspaceId).then(
      events => {
        if (!current) return;
        setTranscript(replayTranscript(events, workspaceId));
        hydratedRef.current = workspaceId;
        setHydratedFor(workspaceId);
      },
      (err: unknown) => {
        if (!current) return;
        setTranscript(t => appendLocalError(t, `history unavailable: ${err instanceof Error ? err.message : String(err)}`));
        hydratedRef.current = workspaceId;
        setHydratedFor(workspaceId);
      },
    );
    return () => {
      current = false;
      hydratedRef.current = null;
    };
  }, [api, workspaceId]);

  const onEvent = useCallback((e: ProtocolEvent) => {
    if (hydratedRef.current !== workspaceId) return;
    setTranscript(t => applySessionEvent(t, e, workspaceId));
    if (isSessionEvent(e) && e.workspaceId === workspaceId) setSending(false);
  }, [workspaceId]);
  useProtocolEvents(onEvent);

  // The reducer returns the same object for events that change nothing, so
  // keying on the transcript itself also catches deltas that only grow the
  // tail item. A reader who scrolled up is not yanked back down.
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  useEffect(() => { resize(inputRef.current, draft); }, [draft]);

  const busy = sending || transcript.running;
  const disabledReason = !api
    ? "not connected to the runtime"
    : hydratedFor !== workspaceId
      ? "loading transcript"
      : busy
        ? "turn in flight"
        : null;

  async function send() {
    const prompt = draft.trim();
    if (!prompt || !api || busy) return;
    setDraft("");
    setSending(true);
    setTranscript(t => appendUserTurn(t, prompt));
    const resume = workspace?.claudeSessionId;
    try {
      await api.startSession({ workspaceId, prompt, ...(resume ? { resume } : {}) });
    } catch (err) {
      setSending(false);
      setDraft(d => (d === "" ? prompt : d));
      setTranscript(t => appendLocalError(t, err instanceof Error ? err.message : String(err)));
    }
  }

  return (
    <div className={styles.root}>
      <div
        className={styles.scroll}
        ref={scrollRef}
        onScroll={e => {
          const el = e.currentTarget;
          nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {transcript.items.length === 0 && !transcript.running
          ? <div className={styles.empty}>No session yet. Send a prompt to start one.</div>
          : transcript.items.map((item, i) => <Item key={i} item={item} />)}
        {transcript.running ? <div className={styles.working}><span className={styles.okDot} />working</div> : null}
      </div>
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
    </div>
  );
}

/** Persisted events carry the prompt on session.start; the live path echoes the user turn itself. */
function replayTranscript(events: SessionEvent[], workspaceId: string): Transcript {
  let t = emptyTranscript;
  for (const e of events) {
    if (e.type === "session.start" && e.prompt !== undefined) t = appendUserTurn(t, e.prompt);
    t = applySessionEvent(t, e, workspaceId);
  }
  return t;
}

function resize(el: HTMLTextAreaElement | null, value: string): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = value === "" ? "" : `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`;
}

function Item({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <div className={styles.user}><span className={styles.prompt}>&gt; </span><span>{item.text}</span></div>;
    case "text":
      return <div className={styles.assistant}><span className={styles.tdot} /><span>{item.text}</span></div>;
    case "thinking":
      return (
        <Collapsible headClass={`${styles.blockHead} ${styles.thinkingHead}`} head={<span>thinking</span>}>
          <div className={styles.thinkingBody}>{item.text}</div>
        </Collapsible>
      );
    case "tool":
      return (
        <Collapsible
          headClass={styles.blockHead}
          head={
            <>
              <span className={styles.tdot} />
              <span className={styles.toolName}>{item.toolName}</span>
              <span className={styles.dim}>({firstLine(item.input)})</span>
              {item.isError ? <span className={styles.dim}> · errored</span> : null}
            </>
          }
        >
          <div className={styles.blockBody}>
            {item.input ? <pre className={styles.dim}>{item.input}</pre> : null}
            <pre>{item.result ?? "no result yet"}</pre>
          </div>
        </Collapsible>
      );
    case "done": {
      const r = item.result;
      return (
        <div className={styles.done}>
          <span>{r.status}</span>
          {typeof r.durationMs === "number" ? <span> · {fmtDuration(r.durationMs)}</span> : null}
          {typeof r.costUsd === "number" ? <span className={styles.cost}> · {fmtCost(r.costUsd)}</span> : null}
          {r.error ? <div className={styles.errText}>{r.error}</div> : null}
        </div>
      );
    }
    default: {
      const _exhaustive: never = item;
      return null;
    }
  }
}

function Collapsible({ head, headClass, children }: { head: ReactNode; headClass: string | undefined; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className={headClass} aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {head}
      </button>
      {open ? children : null}
    </div>
  );
}

function firstLine(input: string): string {
  const line = input.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}
