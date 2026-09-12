// SPDX-License-Identifier: AGPL-3.0-only
// The screen surface: noVNC over the machine's desktop stream, in the right
// panel and on the first-run builder. Only desktop-kind machines carry a
// stream; sandbox-kind machines (the v1 golden) have no display, so the
// no-display state is the common case, not an error.
import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import type { WorkspaceStatus } from "@wsp/protocol";
import { Button } from "../components/ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty.js";
import { Spinner } from "../components/ui/spinner.js";
import { cn } from "../lib/utils.js";
import { useStatus } from "../protocol/store.js";

// A workspace's stream rides its status; a caller with the URL in hand passes it.
function resolveStreamUrl(status: WorkspaceStatus | null, injected: string | undefined): string | null {
  return injected || status?.screen?.streamUrl || null;
}

export function ScreenSurface({ workspaceId, streamUrl }: { workspaceId: string; streamUrl?: string }) {
  const status = useStatus(workspaceId);
  const url = resolveStreamUrl(status, streamUrl);
  if (!url) return <NoDisplay />;
  return <ScreenViewer url={url} />;
}

function NoDisplay() {
  return (
    <Empty className="h-full bg-[var(--terminal-background)]">
      <EmptyHeader>
        <EmptyTitle>This workspace has no display</EmptyTitle>
        <EmptyDescription>Workspaces run headless. A desktop workspace would stream here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
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
    <div className="flex h-full min-h-0 flex-col bg-[var(--terminal-background)]">
      <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">screen</span>
        <span className="ml-auto flex items-center gap-2.5">
          {live ? (
            <span className="size-[7px] rounded-full bg-emerald-500 dark:bg-emerald-300/90" title="live" />
          ) : (
            <span className="font-mono text-[10.5px] text-muted-foreground">{phase}</span>
          )}
          <Button
            size="xs"
            variant={control ? "default" : "outline"}
            role="switch"
            aria-checked={control}
            aria-label="control"
            disabled={!live}
            onClick={() => setControl(c => !c)}
          >
            {control ? "controlling" : "watching"}
          </Button>
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={target} className={cn("absolute inset-0", !control && "pointer-events-none", !live && "invisible")} />
        {!live && (
          <Empty className="absolute inset-0 h-full">
            <EmptyHeader>
              {phase === "refused" ? (
                <>
                  <EmptyTitle>The stream refused this connection</EmptyTitle>
                  <EmptyDescription>{reason}</EmptyDescription>
                </>
              ) : (
                <>
                  <Spinner className="mb-3 size-4 text-muted-foreground" />
                  <EmptyTitle>{phase === "reconnecting" ? "Stream dropped, retrying" : "Waiting for the desktop"}</EmptyTitle>
                </>
              )}
            </EmptyHeader>
          </Empty>
        )}
      </div>
      <div className="border-t border-border bg-background px-3 py-1.5 text-center font-mono text-[10.5px] text-muted-foreground">
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
