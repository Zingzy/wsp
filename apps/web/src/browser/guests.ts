// SPDX-License-Identifier: AGPL-3.0-only
// The desktop app's browser guests, one per tab that has shown a page. A guest
// lives in a layer of its own outside the panel, since a webview moved in the
// page loads again: the panel's slot says where the shown one stands, and a
// guest whose tab is not shown waits off screen with its page and history.
// Each guest holds a renderer process, so one not shown for five minutes is
// unloaded; its tab keeps where it was, which loads again when shown.
import { create } from "zustand";
import { desktopBridge } from "../lib/desktopShell.js";

export const GUEST_IDLE_MS = 5 * 60_000;

export interface GuestRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Over a panel drawn as a sheet, which stands over the page. */
  readonly raised: boolean;
}

/** The minted route of the port a guest shows, which its own urls are read back against. */
export interface GuestRoute {
  readonly url: string;
  readonly port: number;
}

export interface Guest {
  readonly workspaceId: string;
  readonly tabId: string;
  /** The url the guest was made on; the pages after it are the guest's own. */
  readonly src: string;
  readonly route: GuestRoute | null;
  /** The tab's load count this guest has loaded. */
  readonly loaded: number;
}

export interface GuestNav {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly loading: boolean;
}

/** The parts of Electron's webview element the pane drives. */
export interface GuestElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getWebContentsId(): number;
  setZoomFactor(factor: number): void;
}

interface GuestsState {
  guests: Record<string, Guest>;
  slots: Record<string, GuestRect>;
  hiddenAt: Record<string, number>;
  nav: Record<string, GuestNav>;
}

export const useGuests = create<GuestsState>()(() => ({ guests: {}, slots: {}, hiddenAt: {}, nav: {} }));

export const guestKey = (workspaceId: string, tabId: string): string => `${workspaceId}/${tabId}`;

const NO_NAV: GuestNav = { canGoBack: false, canGoForward: false, loading: false };

export function useGuestNav(key: string | null): GuestNav {
  return useGuests(s => (key === null ? NO_NAV : (s.nav[key] ?? NO_NAV)));
}

const elements = new Map<string, GuestElement>();

export const guestElement = (key: string): GuestElement | undefined => elements.get(key);

export function holdGuestElement(key: string, element: GuestElement | null): void {
  if (element === null) elements.delete(key);
  else elements.set(key, element);
}

const without = <T>(record: Record<string, T>, keys: ReadonlyArray<string>): Record<string, T> => {
  if (!keys.some(key => key in record)) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
};

const sameRect = (a: GuestRect, b: GuestRect): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.raised === b.raised;

/** The tab's slot is on screen: its guest stands there, made now on `made` when it has none. */
export function showGuest(key: string, made: Guest, rect: GuestRect): void {
  const held = useGuests.getState();
  const slot = held.slots[key];
  if (held.guests[key] !== undefined && slot !== undefined && sameRect(slot, rect)) return;
  useGuests.setState(s => ({
    guests: s.guests[key] === undefined ? { ...s.guests, [key]: made } : s.guests,
    slots: { ...s.slots, [key]: rect },
    hiddenAt: without(s.hiddenAt, [key]),
  }));
  scheduleSweep();
}

/** The tab's slot left the screen: its guest waits off screen until shown again or unloaded. */
export function hideGuest(key: string, now = Date.now()): void {
  useGuests.setState(s => (s.guests[key] === undefined ? { slots: without(s.slots, [key]) } : { slots: without(s.slots, [key]), hiddenAt: { ...s.hiddenAt, [key]: now } }));
  scheduleSweep();
}

export function updateGuest(key: string, change: Partial<Pick<Guest, "route" | "loaded">>): void {
  useGuests.setState(s => {
    const guest = s.guests[key];
    if (guest === undefined) return s;
    return { guests: { ...s.guests, [key]: { ...guest, ...change } } };
  });
}

export function setGuestNav(key: string, change: Partial<GuestNav>): void {
  useGuests.setState(s => ({ nav: { ...s.nav, [key]: { ...(s.nav[key] ?? NO_NAV), ...change } } }));
}

/** Unloads the guests named, their page gone with them. */
export function dropGuests(keys: ReadonlyArray<string>): void {
  if (keys.length === 0) return;
  useGuests.setState(s => ({ guests: without(s.guests, keys), slots: without(s.slots, keys), hiddenAt: without(s.hiddenAt, keys), nav: without(s.nav, keys) }));
  scheduleSweep();
}

/** Unloads every guest not shown for the idle span. */
export function sweepGuests(now = Date.now()): void {
  dropGuests(Object.entries(useGuests.getState().hiddenAt).flatMap(([key, at]) => (now - at >= GUEST_IDLE_MS ? [key] : [])));
}

let sweep: ReturnType<typeof setTimeout> | undefined;

/** One timer, for the guest hidden longest: nothing ticks while every guest is shown or none is held. */
function scheduleSweep(): void {
  if (sweep !== undefined) clearTimeout(sweep);
  sweep = undefined;
  const hidden = Object.values(useGuests.getState().hiddenAt);
  if (hidden.length === 0) return;
  sweep = setTimeout(() => {
    sweep = undefined;
    sweepGuests();
  }, Math.max(0, Math.min(...hidden) + GUEST_IDLE_MS - Date.now()));
}

let here: boolean | undefined;

/** Whether this page holds guests: the desktop app's own host's page, asked of the shell once per load. */
export function browserGuestsHere(): boolean {
  return (here ??= desktopBridge()?.browserGuests?.() === true);
}

/** Test isolation: no guests, no timer, and the shell asked again. */
export function resetGuests(): void {
  if (sweep !== undefined) clearTimeout(sweep);
  sweep = undefined;
  here = undefined;
  elements.clear();
  useGuests.setState({ guests: {}, slots: {}, hiddenAt: {}, nav: {} });
}
