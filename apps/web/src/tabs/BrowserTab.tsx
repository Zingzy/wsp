// SPDX-License-Identifier: AGPL-3.0-only
// Browser tab: the new-tab page is the workspace's live port directory, fed by
// the daemon's port watcher through the runtime event stream. Opening a port
// shows a local placeholder because the wire exposes no per-port URL yet; the
// tabs and the directory live in ../browser/model.js so tab-away keeps them.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ProtocolEvent } from "../protocol/client.js";
import { useProtocolEvents } from "../protocol/store.js";
import { getBrowser, type BrowserTabView, type PortEntry, type WorkspaceBrowser } from "../browser/model.js";
import styles from "./BrowserTab.module.css";

const localUrl = (port: number) => `http://localhost:${port}`;

export function BrowserTab({ workspaceId }: { workspaceId: string }) {
  const browser = getBrowser(workspaceId);
  const onEvent = useCallback(
    (e: ProtocolEvent) => {
      if ((e.type === "port.open" || e.type === "port.close") && e.workspaceId === workspaceId) browser.feedEvent(e);
    },
    [browser, workspaceId],
  );
  useProtocolEvents(onEvent);

  const ports = useSyncExternalStore(fn => browser.onChange(fn), () => browser.ports());
  const tabs = useSyncExternalStore(fn => browser.onChange(fn), () => browser.tabs());
  const activeId = useSyncExternalStore(fn => browser.onChange(fn), () => browser.activeId());
  const active = tabs.find(t => t.id === activeId) ?? tabs[0]!;

  return (
    <div className={styles.pane}>
      <TabBar browser={browser} tabs={tabs} activeId={active.id} />
      <div className={styles.urlrow}>
        <button
          className={styles.ikey}
          title="port directory"
          aria-label="port directory"
          onClick={() => browser.navigate(active.id, null)}
        >
          <PortsIcon />
        </button>
        <input
          className={styles.addr}
          aria-label="address"
          readOnly
          value={active.port === null ? `wsp://${workspaceId}/ports` : localUrl(active.port)}
        />
      </div>
      <div className={styles.webview} role="tabpanel">
        {active.port === null ? (
          <Directory ports={ports} onOpen={port => browser.navigate(active.id, port)} />
        ) : (
          <PortPage port={active.port} listening={ports.some(p => p.port === active.port)} />
        )}
      </div>
    </div>
  );
}

function TabBar({ browser, tabs, activeId }: { browser: WorkspaceBrowser; tabs: BrowserTabView[]; activeId: string }) {
  return (
    <div className={styles.bar} role="tablist" aria-label="browser tabs">
      {tabs.map(t => {
        const title = t.port === null ? "new tab" : `:${t.port}`;
        return (
          <button
            key={t.id}
            role="tab"
            aria-label={title}
            aria-selected={t.id === activeId}
            data-active={t.id === activeId}
            className={styles.btab}
            onClick={() => browser.setActive(t.id)}
          >
            <span>{title}</span>
            {tabs.length > 1 && (
              <span
                role="button"
                aria-label={`close tab ${title}`}
                className={styles.close}
                onClick={e => {
                  e.stopPropagation();
                  browser.closeTab(t.id);
                }}
              >
                ×
              </span>
            )}
          </button>
        );
      })}
      <button className={styles.add} aria-label="new browser tab" onClick={() => browser.openTab()}>
        +
      </button>
    </div>
  );
}

function Directory({ ports, onOpen }: { ports: PortEntry[]; onOpen: (port: number) => void }) {
  if (ports.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.t1}>no open ports</div>
        <div className={styles.t2}>nothing is listening in this workspace yet</div>
      </div>
    );
  }
  return (
    <div className={styles.ports}>
      <div className={styles.portsIn}>
        <div className={styles.portsHead}>
          <span className={styles.label}>open ports</span>
          <span className={styles.count}>{ports.length} listening</span>
        </div>
        <ul className={styles.grid} aria-label="open ports">
          {ports.map(p => (
            <li key={p.port}>
              <button className={styles.card} aria-label={`open :${p.port}`} onClick={() => onOpen(p.port)}>
                <span className={styles.ext}>
                  <ExtIcon />
                </span>
                <span className={styles.port}>:{p.port}</span>
                <span className={styles.sub}>
                  {p.pid !== null && <span>pid {p.pid}</span>}
                  <FirstSeen at={p.firstSeen} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function FirstSeen({ at }: { at: number }) {
  const d = new Date(at);
  const clock = d.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <time dateTime={d.toISOString()}>
      since {clock}
    </time>
  );
}

function PortPage({ port, listening }: { port: number; listening: boolean }) {
  const url = localUrl(port);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className={styles.page}>
      <div className={styles.t1}>{listening ? `:${port} has no stream yet` : `:${port} stopped listening`}</div>
      <div className={styles.t2}>
        {listening ? "no public url for this port yet. localhost resolves inside the workspace." : "nothing is listening on this port any more"}
      </div>
      <div className={styles.urlbox}>
        <span className={styles.url}>{url}</span>
        <button
          className={styles.key}
          aria-label="copy url"
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
    </div>
  );
}

function PortsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <circle cx="7.5" cy="7.5" r="2.4" />
      <circle cx="16.5" cy="7.5" r="2.4" />
      <circle cx="7.5" cy="16.5" r="2.4" />
      <circle cx="16.5" cy="16.5" r="2.4" />
    </svg>
  );
}

function ExtIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="8 7 17 7 17 16" />
    </svg>
  );
}
