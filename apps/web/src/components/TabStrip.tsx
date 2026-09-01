// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useSelectedId, useSession } from "../protocol/store.js";
import { ChatTab } from "../tabs/ChatTab.js";
import { TerminalTab } from "../tabs/TerminalTab.js";
import { BrowserTab } from "../tabs/BrowserTab.js";
import { ScreenTab } from "../tabs/ScreenTab.js";
import styles from "./TabStrip.module.css";

type TabKind = "chat" | "terminal" | "browser" | "screen";
const TABS: TabKind[] = ["chat", "terminal", "browser", "screen"];

export function TabStrip() {
  const workspaceId = useSelectedId();
  const sessions = useSession(workspaceId);
  // Default: chat when a managed session exists, else terminal (approved
  // decision). Derived, not initial state, so it follows a session that starts
  // after mount; an explicit pick per workspace overrides it.
  const [picked, setPicked] = useState<Record<string, TabKind>>({});
  if (!workspaceId) return <div className={styles.none}>select a workspace</div>;
  const active: TabKind = picked[workspaceId] ?? (sessions.length > 0 ? "chat" : "terminal");
  const setActive = (t: TabKind) => setPicked(p => ({ ...p, [workspaceId]: t }));
  return (
    <>
      <div className={styles.strip} role="tablist">
        {TABS.map(t => (
          <button key={t} role="tab" aria-selected={t === active} className={styles.tab} data-active={t === active} onClick={() => setActive(t)}>{t}</button>
        ))}
      </div>
      <div className={styles.body}>
        {active === "chat" && <ChatTab workspaceId={workspaceId} />}
        {active === "terminal" && <TerminalTab workspaceId={workspaceId} />}
        {active === "browser" && <BrowserTab workspaceId={workspaceId} />}
        {active === "screen" && <ScreenTab workspaceId={workspaceId} />}
      </div>
    </>
  );
}
