// SPDX-License-Identifier: AGPL-3.0-only
// The flat strip from the approved mock: chat, one tab per terminal pty,
// screen. The browser lives in the right panel. Pty tabs are a view over the workspace's WorkspaceTerminals
// (../terminal/link.js), which owns their order, titles and the active one.
import { useEffect, useState, useSyncExternalStore } from "react";
import { useSelectedId, useSession, useWorkspaces } from "../protocol/store.js";
import { getTerminals, onTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import { ChatTab } from "../tabs/ChatTab.js";
import { TerminalLinkState, TerminalTab } from "../tabs/TerminalTab.js";
import { ScreenTab } from "../tabs/ScreenTab.js";
import styles from "./TabStrip.module.css";

type TabKind = "chat" | "terminal" | "screen";

export function TabStrip() {
  const workspaceId = useSelectedId();
  const sessions = useSession(workspaceId);
  const terms = useSyncExternalStore(onTerminals, () => (workspaceId ? getTerminals(workspaceId) : null));
  // Default: chat when a managed session exists, else terminal (approved
  // decision). Derived, not initial state, so it follows a session that starts
  // after mount; an explicit pick per workspace overrides it.
  const [picked, setPicked] = useState<Record<string, TabKind>>({});
  const workspaces = useWorkspaces();
  useEffect(() => {
    setPicked(p => {
      const kept = Object.fromEntries(Object.entries(p).filter(([id]) => workspaces.some(w => w.id === id)));
      return Object.keys(kept).length === Object.keys(p).length ? p : kept;
    });
  }, [workspaces]);
  if (!workspaceId) return <div className={styles.none}>select a workspace</div>;
  const active: TabKind = picked[workspaceId] ?? (sessions.length > 0 ? "chat" : "terminal");
  const setActive = (t: TabKind) => setPicked(p => ({ ...p, [workspaceId]: t }));
  const plain = (t: TabKind) => (
    <button key={t} role="tab" aria-selected={t === active} className={styles.tab} data-active={t === active} onClick={() => setActive(t)}>
      {t}
    </button>
  );
  return (
    <>
      <div className={styles.strip} role="tablist">
        {plain("chat")}
        {terms ? <PtyTabs terms={terms} shown={active === "terminal"} onPick={() => setActive("terminal")} /> : plain("terminal")}
        {plain("screen")}
        {terms && <span className={styles.right}><TerminalLinkState terms={terms} /></span>}
      </div>
      <div className={styles.body}>
        {active === "chat" && <ChatTab workspaceId={workspaceId} />}
        {active === "terminal" && <TerminalTab workspaceId={workspaceId} />}
        {active === "screen" && <ScreenTab workspaceId={workspaceId} />}
      </div>
    </>
  );
}

function PtyTabs({ terms, shown, onPick }: { terms: WorkspaceTerminals; shown: boolean; onPick: () => void }) {
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const activeId = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.activeId());
  return (
    <>
      {tabs.length === 0 && (
        <button role="tab" aria-selected={shown} className={styles.tab} data-active={shown} onClick={onPick}>
          terminal
        </button>
      )}
      {tabs.map(t => {
        const on = shown && t.ptyId === activeId;
        return (
          <button
            key={t.ptyId}
            role="tab"
            aria-selected={on}
            data-active={on}
            data-pty={t.ptyId}
            className={styles.tab}
            onClick={() => {
              terms.setActive(t.ptyId);
              onPick();
            }}
          >
            <span>{t.title}</span>
            {t.exited && <span className={styles.exited}>exited</span>}
            <span
              role="button"
              aria-label={`close ${t.title}`}
              className={styles.close}
              onClick={e => {
                e.stopPropagation();
                void terms.close(t.ptyId);
              }}
            >
              ×
            </span>
          </button>
        );
      })}
      <button
        className={styles.add}
        aria-label="new terminal"
        onClick={() => {
          onPick();
          void terms.open().catch(() => {});
        }}
      >
        +
      </button>
    </>
  );
}
