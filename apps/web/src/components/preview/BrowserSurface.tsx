// SPDX-License-Identifier: AGPL-3.0-only
// The right panel's browser surface: the copied chrome row over an iframe on
// the route the runtime mints for one guest port, with the tab's path on it.
// A workspace of this computer shares this computer's ports, so the pane
// frames that same address rather than asking for a route no backend of this
// computer mints; a computer that mints none says so in one sentence of the
// protocol's, naming itself and the address that does answer. The servers
// list is the workspace's port directory; recents live in local storage per
// workspace. The bar shows the loopback address; copy and the frame keep the
// route and its token. On the desktop app the frame is a guest of the shell's,
// which opens any web page too and keeps its own history; a page in a plain
// browser frames ports alone and sends any other site to a new browser tab.
import { Check, Copy, Laptop } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isLocalWorkspace, noPreviewRouteLine } from "@wsp/protocol";
import { stoppedSentence, toPreviewableServers } from "../../adapt/ports.js";
import { usePortAnswering } from "../../browser/answering.js";
import { useStoppedPort, useWorkspacePorts, useWorkspacePortsSeeded } from "../../browser/model.js";
import { recordVisit, removeVisit, useRecents } from "../../browser/recents.js";
import { useProbedRoute } from "../../browser/refusal.js";
import { browserGuestsHere, guestElement, guestKey, updateGuest, useGuestNav, useGuests, type GuestRoute } from "../../browser/guests.js";
import { currentPlace, useBrowserTab, useBrowserTabs, ZOOM_STEP } from "../../browser/tabs.js";
import { frameSrc, isSite, loopbackAddress, loopbackUrl, parseAddress, parseTarget, placeAddress, placeUrl, type Address, type Place } from "../../browser/url.js";
import { useForwarded, useWorkspace } from "../../protocol/store.js";
import { useComputerName } from "../../sidebar/workspaceRows.js";
import { roomForBrowserTab, useRightPanelStore, type RightPanelSurface } from "../../rightPanelStore.js";
import { clockLabel } from "../../lib/timestampFormat.js";
import { noticeFailure, notCopied } from "../../notices/store.js";
import { Button } from "../ui/button.js";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { GuestSlot } from "./BrowserGuests.js";
import { PreviewChromeRow } from "./PreviewChromeRow.js";
import { PreviewEmptyState } from "./PreviewEmptyState.js";
import { PreviewMoreMenu } from "./PreviewMoreMenu.js";
import { ZoomIndicator } from "./ZoomIndicator.js";

type PreviewSurface = Extract<RightPanelSurface, { kind: "preview" }>;

export const UNFRAMEABLE = "Only ports on the thread's computer show here, like localhost:3000. Other sites open in a new browser tab.";

export function BrowserSurface({ workspaceId, surface }: { workspaceId: string; surface: PreviewSurface }) {
  const tabId = surface.resourceId;
  const tab = useBrowserTab(workspaceId, tabId);
  const tabs = useBrowserTabs.getState();
  const openBrowser = useRightPanelStore(s => s.openBrowser);
  const ports = useWorkspacePorts(workspaceId);
  const portsSeeded = useWorkspacePortsSeeded(workspaceId);
  const servers = useMemo(() => toPreviewableServers({ ports }), [ports]);
  const [recents, setRecents] = useRecents(workspaceId);
  const [hint, setHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const guests = browserGuestsHere();
  const key = tabId === null ? null : guestKey(workspaceId, tabId);
  const nav = useGuestNav(key);
  const place = currentPlace(tab);
  const address: Address | null = place === null || isSite(place) ? null : place;
  const port = address?.port ?? null;
  // A workspace of this computer answers on this computer's own ports, which is the address the person's own
  // browser opens; nothing is minted for it and nothing is probed, since there is no preview edge in between.
  const workspace = useWorkspace(workspaceId);
  const here = workspace !== null && isLocalWorkspace(workspace);
  const computer = useComputerName(workspaceId);
  const [rechecks, setRechecks] = useState(0);
  const { reach, refusal } = useProbedRoute(workspaceId, here ? null : port, tab?.reloadNonce ?? 0, rechecks);
  const realUrl =
    place === null
      ? null
      : isSite(place)
        ? place.url
        : here
          ? loopbackUrl(place.port, place.path)
          : reach.state === "ready"
            ? frameSrc(reach.reach.url, place.path)
            : null;
  const shownUrl = place !== null ? placeAddress(place) : "";
  const routeUrl = !here && port !== null && reach.state === "ready" ? reach.reach.url : null;
  const listed = port === null || !portsSeeded || ports.some(p => p.port === port);
  // A port off the list may still answer: Docker's is held by a process of dockerd's, so no event names it. Until
  // its route and its first fetch are back, nothing is known, and nothing is said.
  const fetched = listed || here || reach.state !== "ready" ? null : port;
  const { answering, check } = usePortAnswering(workspaceId, fetched, () => setRechecks(n => n + 1));
  const listening = listed || (!here && reach.state === "minting") || (fetched !== null && answering !== false);
  const stopped = useStoppedPort(workspaceId, port);
  const sentence = listening ? "" : stoppedSentence(port, computer, stopped, clockLabel, fetched !== null);
  const forwarded = useForwarded(workspaceId, port);
  const zoom = tab?.zoom ?? 1;
  const framed = realUrl !== null && (refusal === null || refusal.keepsFrame);
  const route: GuestRoute | null = routeUrl === null || port === null ? null : { url: routeUrl, port };

  useEffect(() => {
    setLoading(framed);
  }, [framed, realUrl, tab?.reloadNonce]);

  // The guest reads its own urls back against the port's route, which is reminted within the hour.
  useEffect(() => {
    if (key !== null) updateGuest(key, { route });
  }, [key, routeUrl, port]);

  // A place typed or picked is loaded into the guest the tab already has; a fresh route or a page the guest went to
  // by itself leaves the count, so neither loads anything.
  const loads = tab?.loads ?? 0;
  useEffect(() => {
    if (!guests || key === null || realUrl === null) return;
    const guest = useGuests.getState().guests[key];
    if (guest === undefined || guest.loaded === loads) return;
    updateGuest(key, { loaded: loads });
    void guestElement(key)?.loadURL(realUrl).catch(() => {});
  }, [guests, key, realUrl, loads]);

  const reloadNonce = tab?.reloadNonce ?? 0;
  const reloaded = useRef(reloadNonce);
  useEffect(() => {
    if (reloadNonce === reloaded.current) return;
    reloaded.current = reloadNonce;
    if (guests && key !== null) guestElement(key)?.reload();
  }, [guests, key, reloadNonce]);

  // The port listening again is the cue to probe its route anew, whether the last answer was framed or a refusal card.
  // The list naming it again counts on its own, since a fetch can find a fast restart up on both sides of it. A route
  // that only now came back has no frame to reload.
  const wasListening = useRef({ port, listening, listed, realUrl });
  useEffect(() => {
    const prev = wasListening.current;
    wasListening.current = { port, listening, listed, realUrl };
    const back = (listening && !prev.listening) || (listed && !prev.listed);
    if (tabId !== null && realUrl !== null && prev.realUrl !== null && prev.port === port && back) tabs.reload(workspaceId, tabId);
  }, [port, listening, listed, realUrl, tabId, workspaceId, tabs]);

  const frameAddress = (next: Place): void => {
    setHint(null);
    if (tabId === null) {
      if (!roomForBrowserTab(workspaceId)) return;
      openBrowser(workspaceId, tabs.createTab(workspaceId, next));
    } else tabs.navigate(workspaceId, tabId, next);
    setRecents(prev => recordVisit(prev, placeUrl(next), Date.now()));
  };

  const openUrl = (url: string): void => {
    const next = guests ? parseTarget(url) : parseAddress(url);
    if (next === null) {
      window.open(placeUrl(parseTarget(url)), "_blank", "noopener");
      setHint(UNFRAMEABLE);
      return;
    }
    frameAddress(next);
  };

  const copyUrl = (): void => {
    if (realUrl !== null) void navigator.clipboard?.writeText(realUrl).catch((e: unknown) => noticeFailure(e, notCopied));
  };
  const openOutside = (): void => {
    if (realUrl !== null) window.open(realUrl, "_blank", "noopener");
  };
  const withTab = (fn: (id: string) => void) => () => {
    if (tabId !== null) fn(tabId);
  };
  // A route that failed is asked for again, and the frame it brings back is its one load.
  const reload = withTab(id => {
    if (reach.state === "failed") return setRechecks(n => n + 1);
    check();
    tabs.reload(workspaceId, id);
  });

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-browser-surface>
      <PreviewChromeRow
        url={shownUrl}
        loading={guests ? nav.loading : loading}
        canGoBack={guests ? nav.canGoBack : tab !== null && tab.index > 0}
        canGoForward={guests ? nav.canGoForward : tab !== null && tab.index < tab.entries.length - 1}
        refreshDisabled={place === null}
        onBack={withTab(id => (guests ? guestElement(guestKey(workspaceId, id))?.goBack() : tabs.back(workspaceId, id)))}
        onForward={withTab(id => (guests ? guestElement(guestKey(workspaceId, id))?.goForward() : tabs.forward(workspaceId, id)))}
        onRefresh={reload}
        onSubmit={openUrl}
        onDraft={setQuery}
        onOpenInBrowser={realUrl !== null ? openOutside : undefined}
        trailingActions={
          <>
            {forwarded && address !== null ? <OpenOnLaptopButton address={address} /> : null}
            {realUrl !== null ? <CopyUrlButton url={realUrl} /> : null}
            <PreviewMoreMenu
              tabId={tabId}
              hasPage={realUrl !== null}
              zoomFactor={zoom}
              onHardReload={reload}
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
        {place === null ? (
          <PreviewEmptyState
            servers={servers}
            recentEntries={recents}
            query={query}
            onOpenUrl={openUrl}
            onRemoveRecent={url => setRecents(prev => removeVisit(prev, url))}
          />
        ) : port !== null && reach.state === "failed" ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{noPreviewRouteLine(port, computer)}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {!listening ? (
              <div title={sentence} className="shrink-0 truncate border-b border-border/60 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
                {sentence}
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
            ) : framed && guests && tabId !== null && key !== null ? (
              <GuestSlot id={key} made={{ workspaceId, tabId, src: realUrl, route, loaded: loads }} />
            ) : framed ? (
              <iframe
                key={`${place === null ? "" : placeUrl(place)}:${tab?.reloadNonce ?? 0}`}
                title={`:${port}`}
                src={realUrl}
                onLoad={() => {
                  setLoading(false);
                  check();
                }}
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
function OpenOnLaptopButton({ address }: { address: Address }) {
  const here = loopbackAddress(address.port, address.path);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label="Open on laptop"
            onClick={() => window.open(loopbackUrl(address.port, address.path), "_blank", "noopener,noreferrer")}
          />
        }
      >
        <Laptop />
      </TooltipTrigger>
      <TooltipPopup>Open {here} on this computer</TooltipPopup>
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
              void navigator.clipboard?.writeText(url).then(() => setCopied(true), (e: unknown) => noticeFailure(e, notCopied));
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
