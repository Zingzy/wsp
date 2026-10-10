// SPDX-License-Identifier: AGPL-3.0-only
// The layer the desktop app's browser guests live in, mounted once beside the
// shell, and the slot a shown browser tab leaves for its guest. A guest stands
// over its slot while the slot is on screen and waits off screen at its last
// size otherwise, so its page neither reloads nor lays itself out again. Each
// page the guest goes to, by a link or its own history, is the tab's place.
import { BROWSER_PARTITION, type GuestOpen } from "@wsp/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  dropGuests,
  guestElement,
  hideGuest,
  holdGuestElement,
  setGuestNav,
  showGuest,
  useGuests,
  type Guest,
  type GuestElement,
  type GuestRect,
} from "../../browser/guests.js";
import { useBrowserTabs } from "../../browser/tabs.js";
import { placeOfUrl } from "../../browser/url.js";
import { desktopBridge } from "../../lib/desktopShell.js";
import { openBrowserAt } from "../../rightPanelStore.js";

/** Over the inline panel and under the dialogs (z-50); over a panel drawn as a sheet (z-50) and so over a dialog
 * opened on it, which is why a slot in a sheet hides its guest while anything modal stands over the sheet. */
const OVER_PANEL = 10;
const OVER_SHEET = 60;
const OFF_SCREEN = -100_000;

/** Electron reads allowpopups when the guest attaches, so it is an attribute from the start; react-dom drops a boolean
 * on an attribute it does not know, so it goes as the string. */
const ALLOW_POPUPS = { allowpopups: "true" } as unknown as { allowpopups?: boolean };

/** A guest's new window, a tab of the same workspace on the page it asked for. */
function openFromGuest(open: GuestOpen): void {
  const { guests } = useGuests.getState();
  const key = Object.keys(guests).find(k => guestElement(k)?.getWebContentsId() === open.guest);
  const from = key === undefined ? undefined : guests[key];
  if (from !== undefined) openBrowserAt(from.workspaceId, placeOfUrl(open.url, from.route));
}

export function BrowserGuests() {
  const guests = useGuests(s => s.guests);
  const slots = useGuests(s => s.slots);
  const tabs = useBrowserTabs(s => s.byWorkspaceId);

  useEffect(() => {
    dropGuests(Object.entries(guests).flatMap(([key, guest]) => (tabs[guest.workspaceId]?.[guest.tabId] === undefined ? [key] : [])));
  }, [guests, tabs]);

  useEffect(() => desktopBridge()?.onGuestOpen?.(openFromGuest), []);

  return (
    <>
      {Object.entries(guests).map(([key, guest]) => (
        <GuestView key={key} id={key} guest={guest} rect={slots[key]} />
      ))}
    </>
  );
}

function GuestView({ id, guest, rect }: { id: string; guest: Guest; rect: GuestRect | undefined }) {
  const ref = useRef<GuestElement | null>(null);
  const [src] = useState(guest.src);
  const zoom = useBrowserTabs(s => s.byWorkspaceId[guest.workspaceId]?.[guest.tabId]?.zoom ?? 1);
  const zoomNow = useRef(zoom);
  zoomNow.current = zoom;
  const ready = useRef(false);
  const lastSize = useRef({ width: 800, height: 600 });
  if (rect !== undefined) lastSize.current = { width: rect.width, height: rect.height };
  const { workspaceId, tabId } = guest;

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    holdGuestElement(id, element);
    const tabs = useBrowserTabs.getState();
    const nav = (): void => setGuestNav(id, { canGoBack: element.canGoBack(), canGoForward: element.canGoForward() });
    const moved = (e: Event): void => {
      const { url, isMainFrame } = e as Event & { url: string; isMainFrame?: boolean };
      if (isMainFrame === false) return;
      tabs.follow(workspaceId, tabId, placeOfUrl(url, useGuests.getState().guests[id]?.route ?? null));
      nav();
    };
    const titled = (e: Event): void => tabs.titled(workspaceId, tabId, (e as Event & { title: string }).title);
    const started = (): void => setGuestNav(id, { loading: true });
    const stopped = (): void => {
      setGuestNav(id, { loading: false });
      nav();
    };
    // setZoomFactor throws on a guest that has not drawn its first page.
    const domReady = (): void => {
      ready.current = true;
      element.setZoomFactor(zoomNow.current);
    };
    const on: ReadonlyArray<[string, (e: Event) => void]> = [
      ["did-navigate", moved],
      ["did-navigate-in-page", moved],
      ["page-title-updated", titled],
      ["did-start-loading", started],
      ["did-stop-loading", stopped],
      ["dom-ready", domReady],
    ];
    for (const [name, listener] of on) element.addEventListener(name, listener);
    return () => {
      for (const [name, listener] of on) element.removeEventListener(name, listener);
      holdGuestElement(id, null);
    };
  }, [id, workspaceId, tabId]);

  useEffect(() => {
    if (ready.current) ref.current?.setZoomFactor(zoom);
  }, [zoom]);

  const style =
    rect === undefined
      ? { left: OFF_SCREEN, top: OFF_SCREEN, ...lastSize.current, pointerEvents: "none" as const }
      : { left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: rect.raised ? OVER_SHEET : OVER_PANEL };
  return (
    <div className="fixed overflow-hidden" style={style} data-browser-guest={id} aria-hidden={rect === undefined ? true : undefined}>
      <webview ref={ref as never} src={src} partition={BROWSER_PARTITION} {...ALLOW_POPUPS} className="flex h-full w-full bg-white" />
    </div>
  );
}

/** Base UI marks everything outside an open dialog, palette or menu with this, an ancestor of the slot included. */
const UNDER_MODAL = "[data-base-ui-inert]";

/** Where the shown tab's guest stands: measured on every change of its size, the panel's and the window's, and after
 * a transition, which moves a sheet without resizing it. A slot drawn at no size, inside a hidden panel, shows none,
 * and a slot in a sheet shows none while a dialog, the palette or a menu is open over it. */
export function GuestSlot({ id, made }: { id: string; made: Guest }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const madeNow = useRef(made);
  madeNow.current = made;

  useLayoutEffect(() => {
    const slot = ref.current;
    if (slot === null) return;
    const place = (): void => {
      const box = slot.getBoundingClientRect();
      const raised = slot.closest('[data-preview-panel-mode="sheet"]') !== null;
      if (box.width === 0 || box.height === 0 || (raised && slot.closest(UNDER_MODAL) !== null)) return hideGuest(id);
      showGuest(id, madeNow.current, { x: box.x, y: box.y, width: box.width, height: box.height, raised });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    observer?.observe(slot);
    const panel = slot.closest("[data-preview-panel-mode]");
    if (panel !== null) observer?.observe(panel);
    window.addEventListener("resize", place);
    document.addEventListener("transitionend", place, true);
    const modal = new MutationObserver(place);
    modal.observe(document.body, { subtree: true, attributeFilter: ["data-base-ui-inert"] });
    return () => {
      observer?.disconnect();
      modal.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("transitionend", place, true);
      hideGuest(id);
    };
  }, [id]);

  return <div ref={ref} className="min-h-0 flex-1" data-guest-slot={id} />;
}
