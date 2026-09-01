// SPDX-License-Identifier: AGPL-3.0-only
// Terminal tab: xterm bound to daemon ptys through the per-workspace link in
// ../terminal/link.js. Pty tabs live in that model, so tab-away parks the
// terminal (xterm disposed, pty alive) and a remount replays from the mirror.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getTerminals, onTerminals, type LinkStatus, type WorkspaceTerminals } from "../terminal/link.js";
import styles from "./TerminalTab.module.css";

// The well is darker than the app chrome (content-well inversion, approved
// mock); xterm cannot read CSS vars, so these mirror tokens.css.
const THEME = {
  background: "#060607", // --term
  foreground: "#a1a1aa", // --muted
  cursor: "#f4f4f5", // --fg
  selectionBackground: "rgba(244, 244, 245, 0.18)",
};

export function TerminalTab({ workspaceId }: { workspaceId: string }) {
  const terms = useSyncExternalStore(onTerminals, () => getTerminals(workspaceId));
  if (!terms) return <div className={styles.none}>no terminal link for this workspace</div>;
  return <TerminalPane terms={terms} />;
}

function TerminalPane({ terms }: { terms: WorkspaceTerminals }) {
  const status = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.status());
  const tabs = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.tabs());
  const activeId = useSyncExternalStore(fn => terms.onTabs(fn), () => terms.activeId());

  useEffect(() => {
    if (status === "live" && tabs.length === 0) terms.ensureOpen().catch(() => {});
  }, [terms, status, tabs.length]);

  return (
    <div className={styles.pane}>
      <div className={styles.bar} role="tablist" aria-label="terminals">
        {tabs.map(t => (
          <button
            key={t.ptyId}
            role="tab"
            aria-selected={t.ptyId === activeId}
            data-active={t.ptyId === activeId}
            className={styles.ptab}
            onClick={() => terms.setActive(t.ptyId)}
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
        ))}
        <button
          className={styles.add}
          aria-label="new terminal"
          onClick={() => {
            void terms.open().catch(() => {});
          }}
        >
          +
        </button>
        <span className={styles.right}>
          <StatusIndicator status={status} />
        </span>
      </div>
      {status === "reauth-needed" && (
        <div className={styles.banner}>
          the daemon rejected this workspace&apos;s token. terminals reconnect once the workspace re-authenticates.
        </div>
      )}
      <div className={styles.well}>
        {activeId ? (
          <TerminalView key={activeId} terms={terms} ptyId={activeId} />
        ) : (
          <div className={styles.empty}>{status === "live" ? "opening terminal" : "waiting for connection"}</div>
        )}
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: LinkStatus }) {
  if (status === "live") return <span className={styles.dot} title="connected" />;
  if (status === "connecting") return <span className={styles.state}>reconnecting</span>;
  if (status === "reauth-needed") return <span className={styles.state}>auth expired</span>;
  return <span className={styles.state}>disconnected</span>;
}

function TerminalView({ terms, ptyId }: { terms: WorkspaceTerminals; ptyId: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      // Atlas budget blown or context lost: drop to the DOM renderer for good.
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      webgl = null;
    }
    const applyFit = () => {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || dims.cols < 2 || dims.rows < 1) return;
      term.resize(dims.cols, dims.rows);
      terms.resize(ptyId, dims.cols, dims.rows);
    };
    applyFit();
    const unbind = terms.bind(ptyId, { data: d => term.write(d), reset: () => term.reset() });
    const input = term.onData(d => terms.write(ptyId, d));
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(applyFit) : null;
    ro?.observe(el);
    term.focus();
    return () => {
      ro?.disconnect();
      input.dispose();
      unbind();
      term.dispose(); // disposes loaded addons, webgl included
    };
  }, [terms, ptyId]);

  return <div ref={ref} className={styles.term} />;
}
