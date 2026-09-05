// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's browser surface: the copied chrome row over an iframe on
// the route the runtime mints for one guest port. The servers list is the
// workspace's port directory; recents live in local storage per workspace.
// The bar shows the route without its token; copy and the frame keep it.
import { Check, Copy, Laptop } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toPreviewableServers } from "../../adapt/ports.js";
import { useWorkspacePorts } from "../../browser/model.js";
import { recordVisit, removeVisit, useRecents } from "../../browser/recents.js";
import { useProbedRoute } from "../../browser/refusal.js";
import { currentPort, useBrowserTab, useBrowserTabs, ZOOM_STEP } from "../../browser/tabs.js";
import { elideToken, loopbackUrl, parsePortInput } from "../../browser/url.js";
import { useForwarded } from "../../protocol/store.js";
import { useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore.js";
import { Button } from "../ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { PreviewChromeRow } from "./PreviewChromeRow.js";
import { PreviewEmptyState } from "./PreviewEmptyState.js";
import { PreviewMoreMenu } from "./PreviewMoreMenu.js";
import { ZoomIndicator } from "./ZoomIndicator.js";

type PreviewSurface = Extract<RightPanelSurface, { kind: "preview" }>;

const UNFRAMEABLE = "Only ports on this workspace can be framed here, like localhost:3000.";

export function BrowserSurface({ workspaceId, surface }: { workspaceId: string; surface: PreviewSurface }) {
  const tabId = surface.resourceId;
  const tab = useBrowserTab(workspaceId, tabId);
  const tabs = useBrowserTabs.getState();
  const openBrowser = useRightPanelStore(s => s.openBrowser);
  const ports = useWorkspacePorts(workspaceId);
  const servers = useMemo(() => toPreviewableServers({ ports }), [ports]);
  const [recents, setRecents] = useRecents(workspaceId);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const port = currentPort(tab);
  const { reach, refusal } = useProbedRoute(workspaceId, port, tab?.reloadNonce ?? 0);
  const realUrl = reach.state === "ready" ? reach.reach.url : null;
  const shownUrl = realUrl !== null ? elideToken(realUrl) : port !== null ? loopbackUrl(port) : "";
  const listening = port === null || ports.some(p => p.port === port);
  const forwarded = useForwarded(workspaceId, port);
  const zoom = tab?.zoom ?? 1;
  const framed = realUrl !== null && (refusal === null || refusal.keepsFrame);

  useEffect(() => {
    setLoading(framed);
  }, [framed, realUrl, tab?.reloadNonce]);

  const framePort = (next: number): void => {
    setHint(null);
    if (tabId === null) openBrowser(workspaceId, tabs.createTab(workspaceId, next));
    else tabs.navigate(workspaceId, tabId, next);
    setRecents(prev => recordVisit(prev, loopbackUrl(next), Date.now()));
  };

  const openUrl = (url: string): void => {
    const next = parsePortInput(url);
    if (next === null) {
      setHint(UNFRAMEABLE);
      return;
    }
    framePort(next);
  };

  const copyUrl = (): void => {
    if (realUrl !== null) void navigator.clipboard?.writeText(realUrl).catch(() => {});
  };
  const openOutside = (): void => {
    if (realUrl !== null) window.open(realUrl, "_blank", "noopener");
  };
  const withTab = (fn: (id: string) => void) => () => {
    if (tabId !== null) fn(tabId);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-browser-surface>
      <PreviewChromeRow
        url={shownUrl}
        loading={loading}
        canGoBack={tab !== null && tab.index > 0}
        canGoForward={tab !== null && tab.index < tab.entries.length - 1}
        refreshDisabled={realUrl === null}
        onBack={withTab(id => tabs.back(workspaceId, id))}
        onForward={withTab(id => tabs.forward(workspaceId, id))}
        onRefresh={withTab(id => tabs.reload(workspaceId, id))}
        onSubmit={openUrl}
        onOpenInBrowser={realUrl !== null ? openOutside : undefined}
        trailingActions={
          <>
            {forwarded && port !== null ? <OpenOnLaptopButton port={port} /> : null}
            {realUrl !== null ? <CopyUrlButton url={realUrl} /> : null}
            <PreviewMoreMenu
              tabId={tabId}
              hasPage={realUrl !== null}
              zoomFactor={zoom}
              onHardReload={withTab(id => tabs.reload(workspaceId, id))}
              onCopyUrl={copyUrl}
              onOpenInBrowser={openOutside}
              onNewTab={() => openBrowser(workspaceId, null)}
              onZoomIn={withTab(id => tabs.setZoom(workspaceId, id, zoom + ZOOM_STEP))}
              onZoomOut={withTab(id => tabs.setZoom(workspaceId, id, zoom - ZOOM_STEP))}
              onResetZoom={withTab(id => tabs.setZoom(workspaceId, id, 1))}
            />
          </>
        }
      />
      {hint !== null ? (
        <div role="status" className="border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
          {hint}
        </div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        {port === null ? (
          <PreviewEmptyState
            servers={servers}
            recentEntries={recents}
            onOpenUrl={openUrl}
            onRemoveRecent={url => setRecents(prev => removeVisit(prev, url))}
          />
        ) : reach.state === "failed" ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>:{port} has no public route</EmptyTitle>
              <EmptyDescription>{reach.error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {!listening ? (
              <div className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                :{port} stopped listening
              </div>
            ) : null}
            {refusal !== null && refusal.keepsFrame ? (
              <div role="status" className="shrink-0 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{refusal.title}</span> {refusal.detail}
              </div>
            ) : null}
            {refusal !== null && !refusal.keepsFrame ? (
              <Empty className="flex-1">
                <EmptyHeader>
                  <EmptyTitle>{refusal.title}</EmptyTitle>
                  <EmptyDescription>{refusal.detail}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : framed ? (
              <iframe
                key={`${port}:${tab?.reloadNonce ?? 0}`}
                title={`:${port}`}
                src={realUrl}
                onLoad={() => setLoading(false)}
                className="block min-h-0 flex-1 border-0 bg-white"
                style={
                  zoom === 1
                    ? undefined
                    : { transform: `scale(${zoom})`, transformOrigin: "0 0", width: `${100 / zoom}%`, height: `${100 / zoom}%` }
                }
              />
            ) : null}
            <ZoomIndicator zoomFactor={zoom} />
          </>
        )}
      </div>
    </div>
  );
}

/** Shown only while the host forwards this port: localhost:<port> on this computer reaches the workspace. */
function OpenOnLaptopButton({ port }: { port: number }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Open on laptop"
            onClick={() => window.open(loopbackUrl(port), "_blank", "noopener,noreferrer")}
          />
        }
      >
        <Laptop />
      </TooltipTrigger>
      <TooltipPopup>Open localhost:{port} on this computer</TooltipPopup>
    </Tooltip>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Copy URL"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => {});
            }}
          />
        }
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </TooltipTrigger>
      <TooltipPopup>{copied ? "Copied" : "Copy URL"}</TooltipPopup>
    </Tooltip>
  );
}
