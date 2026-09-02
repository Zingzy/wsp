// SPDX-License-Identifier: AGPL-3.0-only
// Screen tab: noVNC over the machine's desktop stream. Only desktop-kind
// machines carry a stream; sandbox-kind machines (the v1 golden) have no
// display, so the no-display frame is the common case, not an error.
import { useEffect, useRef, useState, type ReactNode } from "react";
import RFB from "@novnc/novnc";
import type { WorkspaceStatus } from "@wsp/protocol";
import { useStatus } from "../protocol/store.js";
import styles from "./ScreenTab.module.css";

// The wizard injects the builder's stream; a workspace's rides its status.
function resolveStreamUrl(status: WorkspaceStatus | null, injected: string | undefined): string | null {
  return injected || status?.screen?.streamUrl || null;
}

export function ScreenTab({ workspaceId, streamUrl }: { workspaceId: string; streamUrl?: string }) {
  const status = useStatus(workspaceId);
  const url = resolveStreamUrl(status, streamUrl);
  if (!url) return <NoDisplay />;
  return <ScreenViewer url={url} />;
}

function NoDisplay() {
  return (
    <div className={styles.pane}>
      <div className={styles.center}>
        <Frame label="screen">
          <div className={styles.t1}>this machine has no display</div>
          <div className={styles.t2}>sandbox machines run headless. a desktop workspace would stream here.</div>
        </Frame>
      </div>
    </div>
  );
}

type Phase = "connecting" | "live" | "reconnecting" | "refused";

// Unclean drops retry with backoff so a dead stream host is not hammered;
// a successful connect resets the ladder.
const RETRY_MS = [1000, 2000, 4000, 8000];

function ScreenViewer({ url }: { url: string }) {
  const target = useRef<HTMLDivElement | null>(null);
  const rfb = useRef<RFB | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [reason, setReason] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const drops = useRef(0);
  const [reconnect, setReconnect] = useState(0);

  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let refused = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // shared: a watcher must not kick the desktop's own session off the display.
    const client = new RFB(el, url, { shared: true });
    client.scaleViewport = true;
    client.viewOnly = true;
    client.background = "transparent";
    rfb.current = client;
    const onConnect = () => {
      drops.current = 0;
      setPhase("live");
    };
    const onSecurity = (e: Event) => {
      refused = true;
      const d = (e as CustomEvent<{ status: number; reason?: string }>).detail;
      setReason(d.reason ?? `security status ${d.status}`);
    };
    const onDisconnect = () => {
      if (refused) {
        setPhase("refused");
        return;
      }
      setPhase("reconnecting");
      const delay = RETRY_MS[Math.min(drops.current, RETRY_MS.length - 1)]!;
      drops.current += 1;
      timer = setTimeout(() => setReconnect(n => n + 1), delay);
    };
    client.addEventListener("connect", onConnect);
    client.addEventListener("securityfailure", onSecurity);
    client.addEventListener("disconnect", onDisconnect);
    return () => {
      if (timer) clearTimeout(timer);
      client.removeEventListener("connect", onConnect);
      client.removeEventListener("securityfailure", onSecurity);
      client.removeEventListener("disconnect", onDisconnect);
      client.disconnect();
      rfb.current = null;
    };
  }, [url, reconnect]);

  // phase is a dependency so a reconnected client inherits the control mode.
  useEffect(() => {
    const client = rfb.current;
    if (!client) return;
    client.viewOnly = !control;
    if (control) client.focus();
  }, [control, phase]);

  const live = phase === "live";
  return (
    <div className={styles.pane}>
      <div className={styles.bar}>
        <span className={styles.lbl}>screen</span>
        <span className={styles.right}>
          {live ? <span className={styles.dot} title="live" /> : <span className={styles.state}>{phase}</span>}
          <button
            type="button"
            role="switch"
            aria-checked={control}
            aria-label="control"
            className={styles.key}
            data-on={control}
            disabled={!live}
            onClick={() => setControl(c => !c)}
          >
            {control ? "controlling" : "watching"}
          </button>
        </span>
      </div>
      <div className={styles.well} data-live={live}>
        <div ref={target} className={styles.target} data-control={control} />
        {!live && (
          <div className={styles.center}>
            <Frame label="screen">
              {phase === "refused" ? (
                <>
                  <div className={styles.t1}>the stream refused this connection</div>
                  <div className={styles.t2}>{reason}</div>
                </>
              ) : (
                <div className={styles.t1}>
                  {phase === "reconnecting" ? "stream dropped, retrying" : "waiting for the desktop"}
                  <Ellipsis />
                </div>
              )}
            </Frame>
          </div>
        )}
      </div>
      <div className={styles.meta}>
        {hostOf(url)} · {live ? (control ? "keyboard and mouse forwarded" : "view only") : phase}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.frame}>
      <span className={`${styles.cm} ${styles.tl}`} />
      <span className={`${styles.cm} ${styles.tr}`} />
      <span className={`${styles.cm} ${styles.bl}`} />
      <span className={`${styles.cm} ${styles.br}`} />
      <span className={styles.frameLbl}>{label}</span>
      {children}
    </div>
  );
}

function Ellipsis() {
  return (
    <span className={styles.ell} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
