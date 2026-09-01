// SPDX-License-Identifier: AGPL-3.0-only
// Terminal pane: xterm bound to the active daemon pty through the
// per-workspace link in ../terminal/link.js. Pty tabs live in that model and
// render in the TabStrip, so tab-away parks the terminal (xterm disposed, pty
// alive) and a remount replays from the mirror.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { DaemonLinkStatus } from "@wsp/protocol";
import "@xterm/xterm/css/xterm.css";
import { getTerminals, onTerminals, type WorkspaceTerminals } from "../terminal/link.js";
import styles from "./TerminalTab.module.css";

// The well is darker than the app chrome (content-well inversion, approved
// mock). xterm cannot read CSS vars, so the theme resolves tokens.css at
// mount; an unresolved token (jsdom) leaves that key on xterm's default.
function themeFromTokens(el: HTMLElement): ITheme {
  const cs = getComputedStyle(el);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  const background = v("--term");
  const foreground = v("--muted");
  const cursor = v("--fg");
  const selectionBackground = v("--line");
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { foreground } : {}),
    ...(cursor ? { cursor } : {}),
    ...(selectionBackground ? { selectionBackground } : {}),
  };
}

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
    // Auto-open only before the first pty ever: closing the last terminal
    // must not respawn one.
    if (status === "live" && tabs.length === 0 && !terms.everOpened()) terms.ensureOpen().catch(() => {});
  }, [terms, status, tabs.length]);

  return (
    <div className={styles.pane}>
      {status === "reauth-needed" && (
        <div className={styles.banner}>
          the daemon rejected this workspace&apos;s token. terminals reconnect once the workspace re-authenticates.
        </div>
      )}
      <div className={styles.well}>
        {activeId ? (
          <TerminalView key={activeId} terms={terms} ptyId={activeId} />
        ) : (
          <div className={styles.empty}>
            {status !== "live" ? "waiting for connection" : terms.everOpened() ? "no terminals" : "opening terminal"}
          </div>
        )}
      </div>
    </div>
  );
}

/** The daemon link's health, rendered by the TabStrip at its right edge. */
export function TerminalLinkState({ terms }: { terms: WorkspaceTerminals }) {
  const status = useSyncExternalStore(fn => terms.onStatus(fn), () => terms.status());
  return <StatusIndicator status={status} />;
}

function StatusIndicator({ status }: { status: DaemonLinkStatus }) {
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
      theme: themeFromTokens(el),
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
