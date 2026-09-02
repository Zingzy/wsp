// SPDX-License-Identifier: AGPL-3.0-only
// Browser tab: the new-tab page is the workspace's live port directory, fed by
// the daemon's port watcher over the workspace's daemon link. Opening a port
// frames it through the public route the runtime mints for that port. The
// tabs and the directory live in ../browser/model.js, which also consumes the
// port events, so tab-away keeps both current.
import { useEffect, useState, useSyncExternalStore } from "react";
import { getBrowser, type BrowserTabView, type PortEntry, type WorkspaceBrowser } from "../browser/model.js";
import { usePortReach, type PortReach } from "../browser/reach.js";
import styles from "./BrowserTab.module.css";

export function BrowserTab({ workspaceId }: { workspaceId: string }) {
  const browser = getBrowser(workspaceId);
  const ports = useSyncExternalStore(fn => browser.onChange(fn), () => browser.ports());
  const tabs = useSyncExternalStore(fn => browser.onChange(fn), () => browser.tabs());
  const activeId = useSyncExternalStore(fn => browser.onChange(fn), () => browser.activeId());
  const active = tabs.find(t => t.id === activeId) ?? tabs[0]!;
  const reach = usePortReach(workspaceId, active.port);
  const url = reach.state === "ready" ? reach.reach.url : "";

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
          value={active.port === null ? `wsp://${workspaceId}/ports` : url}
          placeholder={active.port === null ? undefined : "minting a public url"}
        />
        {url !== "" && <CopyKey url={url} />}
      </div>
      <div className={styles.webview} role="tabpanel">
        {active.port === null ? (
          <Directory ports={ports} onOpen={port => browser.navigate(active.id, port)} />
        ) : (
          <PortPage port={active.port} listening={ports.some(p => p.port === active.port)} reach={reach} />
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

function PortPage({ port, listening, reach }: { port: number; listening: boolean; reach: PortReach }) {
  if (reach.state === "failed") {
    return (
      <div className={styles.page}>
        <div className={styles.t1}>:{port} has no public route</div>
        <div className={styles.t2}>{reach.error}</div>
      </div>
    );
  }
  // No sandbox attribute: the guest app is the user's own code and needs
  // scripts, forms and same-origin storage.
  return (
    <div className={styles.framed}>
      {!listening && (
        <div key="note" className={styles.note}>
          :{port} stopped listening
        </div>
      )}
      {reach.state === "ready" && <iframe key="frame" className={styles.frame} title={`:${port}`} src={reach.reach.url} />}
    </div>
  );
}

function CopyKey({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className={styles.key}
      aria-label="copy url"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => {});
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
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
