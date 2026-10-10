// SPDX-License-Identifier: AGPL-3.0-only
// The browser tab on the desktop app: a guest of the shell's on its own partition, standing over the shown tab's slot,
// following the pages it goes to and its own history, opening its new windows as tabs and unloaded once its tab has
// not been shown for five minutes. In a plain browser the tab frames ports alone. The webview here is jsdom's unknown
// element with the methods the pane calls put on it, and its events are dispatched as Electron names them.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_PARTITION, type DesktopBridge, type GuestOpen } from "@wsp/protocol";
import { GUEST_IDLE_MS, resetGuests, useGuests } from "../src/browser/guests.js";
import { currentPlace, resetBrowserTabs, useBrowserTabs } from "../src/browser/tabs.js";
import { SEARCH_URL } from "../src/browser/url.js";
import type { Api } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { BrowserGuests } from "../src/components/preview/BrowserGuests.js";
import { BrowserSurface, UNFRAMEABLE } from "../src/components/preview/BrowserSurface.js";
import { useRightPanelStore } from "../src/rightPanelStore.js";

const WS = "ws_guests01";
const HOST = "m1-3000.preview.example";
const ROUTE = `https://${HOST}/?pt_token=edge`;
const GUEST_ID = 41;

interface FakeGuest extends HTMLElement {
  back: boolean;
  forward: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
}

/** A runtime that mints the port's route and finds it answering. */
const routeApi = (): Api =>
  ({
    subscribe: () => () => {},
    portReach: async () => ({ url: ROUTE, expiresAt: Date.now() + 3_600_000 }),
    portProbe: async () => ({ status: 200, body: "<!doctype html>" }),
  }) as unknown as Api;

let openHandler: ((open: GuestOpen) => void) | undefined;

function desktop(): void {
  const bridge: Partial<DesktopBridge> = {
    browserGuests: () => true,
    onGuestOpen: handler => {
      openHandler = handler;
      return () => (openHandler = undefined);
    },
  };
  window.wsp = bridge;
}

/** The webview the layer drew, with the methods the pane calls. */
function guest(): FakeGuest {
  const element = document.querySelector("webview") as FakeGuest | null;
  if (element === null) throw new Error("no guest drawn");
  if (element.loadURL === undefined) {
    Object.assign(element, {
      back: false,
      forward: false,
      loadURL: vi.fn(async () => {}),
      goBack: vi.fn(),
      goForward: vi.fn(),
      reload: vi.fn(),
      canGoBack: () => element.back,
      canGoForward: () => element.forward,
      getWebContentsId: () => GUEST_ID,
      setZoomFactor: vi.fn(),
    });
  }
  return element;
}

/** The guest went to a page by itself, as Electron says it: a link, a redirect or its own history. */
function goes(url: string, history: { back?: boolean; forward?: boolean } = {}): void {
  const element = guest();
  element.back = history.back ?? false;
  element.forward = history.forward ?? false;
  act(() => {
    element.dispatchEvent(Object.assign(new Event("did-navigate"), { url }));
    element.dispatchEvent(new Event("did-stop-loading"));
  });
}

const bar = () => document.querySelector<HTMLInputElement>("[data-preview-url-input]")!;

function type(text: string): void {
  act(() => bar().focus());
  fireEvent.change(bar(), { target: { value: text } });
  fireEvent.keyDown(bar(), { key: "Enter" });
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
  });
}

const surfaceOf = (tabId: string) => ({ id: `browser:${tabId}` as const, kind: "preview" as const, resourceId: tabId });

function Pane({ tabId, shown = true }: { tabId: string; shown?: boolean }) {
  return (
    <>
      <BrowserGuests />
      {shown ? <BrowserSurface workspaceId={WS} surface={surfaceOf(tabId)} /> : null}
    </>
  );
}

function mountOn(place: Parameters<ReturnType<typeof useBrowserTabs.getState>["createTab"]>[1]) {
  const tabId = useBrowserTabs.getState().createTab(WS, place);
  act(() => useRightPanelStore.getState().openBrowser(WS, tabId));
  const view = render(<Pane tabId={tabId} />);
  return { ...view, tabId };
}

beforeEach(() => {
  resetBrowserTabs();
  resetGuests();
  useRightPanelStore.setState({ byWorkspaceId: {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(600, 80, 400, 500));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.wsp;
  openHandler = undefined;
  resetGuests();
  useStore.setState({ api: null });
});

describe("the browser tab on the desktop app", () => {
  beforeEach(desktop);

  it("opens a typed address or a search in a guest on the browser partition, standing over the tab", () => {
    const { tabId } = mountOn(null);
    type("github.com");
    const element = guest();
    expect(element.getAttribute("src")).toBe("https://github.com/");
    expect(element.getAttribute("partition")).toBe(BROWSER_PARTITION);
    expect(element.getAttribute("allowpopups")).toBe("true");
    expect(bar().value).toBe("https://github.com/");
    expect(element.parentElement!.style.left).toBe("600px");
    expect(element.parentElement!.style.width).toBe("400px");

    type("acme lab release notes");
    expect(element.loadURL).toHaveBeenCalledWith(`${SEARCH_URL}acme%20lab%20release%20notes`);
    expect(currentPlace(useBrowserTabs.getState().byWorkspaceId[WS]![tabId]!)).toEqual({ url: `${SEARCH_URL}acme%20lab%20release%20notes` });
    expect(document.querySelectorAll("webview")).toHaveLength(1);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("back, forward and reload follow the pages the guest went to, a link clicked inside it among them", () => {
    mountOn({ url: "https://github.com/" });
    const element = guest();
    const back = () => screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    const forward = () => screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
    expect(back().disabled).toBe(true);

    goes("https://github.com/acme/lab", { back: true });
    expect(bar().value).toBe("https://github.com/acme/lab");
    expect(back().disabled).toBe(false);
    expect(forward().disabled).toBe(true);
    fireEvent.click(back());
    expect(element.goBack).toHaveBeenCalledTimes(1);

    goes("https://github.com/", { forward: true });
    expect(bar().value).toBe("https://github.com/");
    expect(back().disabled).toBe(true);
    fireEvent.click(forward());
    expect(element.goForward).toHaveBeenCalledTimes(1);

    act(() => element.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://github.com/#readme", isMainFrame: true })));
    expect(bar().value).toBe("https://github.com/#readme");
    act(() => element.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url: "https://ads.example/frame", isMainFrame: false })));
    expect(bar().value).toBe("https://github.com/#readme");

    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(element.reload).toHaveBeenCalledTimes(1);
    expect(element.loadURL).not.toHaveBeenCalled();
  });

  it("a guest's new window opens a new panel tab on its page", () => {
    const { tabId } = mountOn({ url: "https://github.com/" });
    guest();
    act(() => openHandler!({ guest: GUEST_ID, url: "https://docs.example/start" }));
    const panel = useRightPanelStore.getState().byWorkspaceId[WS]!;
    const opened = panel.surfaces.flatMap(s => (s.kind === "preview" && s.resourceId !== null && s.resourceId !== tabId ? [s.resourceId] : []));
    expect(opened).toHaveLength(1);
    expect(panel.activeSurfaceId).toBe(`browser:${opened[0]}`);
    expect(currentPlace(useBrowserTabs.getState().byWorkspaceId[WS]![opened[0]!]!)).toEqual({ url: "https://docs.example/start" });
    act(() => openHandler!({ guest: 999, url: "https://elsewhere.example/" }));
    expect(useRightPanelStore.getState().byWorkspaceId[WS]!.surfaces).toHaveLength(2);
  });

  it("a port of a box or cloud workspace loads through the minted route and the bar shows localhost", async () => {
    useStore.setState({ api: routeApi() });
    const { tabId } = mountOn(null);
    type("localhost:3000");
    await settle();
    expect(guest().getAttribute("src")).toBe(ROUTE);
    expect(bar().value).toBe("localhost:3000");

    goes(`https://${HOST}/about?tab=2&pt_token=edge`, { back: true });
    expect(bar().value).toBe("localhost:3000/about?tab=2");
    expect(currentPlace(useBrowserTabs.getState().byWorkspaceId[WS]![tabId]!)).toEqual({ port: 3000, path: "/about?tab=2" });
    expect(guest().loadURL).not.toHaveBeenCalled();
  });

  it("a tab not shown for five minutes is unloaded, and loads where it was when shown again", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tabId, rerender } = mountOn({ url: "https://github.com/" });
    goes("https://github.com/acme/lab", { back: true });
    rerender(<Pane tabId={tabId} shown={false} />);
    const element = guest();
    expect(element.parentElement!.style.left).toBe("-100000px");
    expect(element.parentElement!.style.width).toBe("400px");

    act(() => vi.advanceTimersByTime(GUEST_IDLE_MS - 1));
    expect(document.querySelector("webview")).toBe(element);
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector("webview")).toBeNull();
    expect(useGuests.getState().guests).toEqual({});

    rerender(<Pane tabId={tabId} shown />);
    expect(guest()).not.toBe(element);
    expect(guest().getAttribute("src")).toBe("https://github.com/acme/lab");
  });

  it("a tab shown again within five minutes keeps its guest, and its timer starts over when it goes again", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { tabId, rerender } = mountOn({ url: "https://github.com/" });
    const element = guest();
    rerender(<Pane tabId={tabId} shown={false} />);
    act(() => vi.advanceTimersByTime(GUEST_IDLE_MS - 1_000));
    rerender(<Pane tabId={tabId} shown />);
    expect(guest()).toBe(element);
    expect(element.parentElement!.style.left).toBe("600px");
    rerender(<Pane tabId={tabId} shown={false} />);
    act(() => vi.advanceTimersByTime(GUEST_IDLE_MS - 1_000));
    expect(document.querySelector("webview")).toBe(element);
  });

  it("a closed tab takes its guest with it at once", () => {
    const { tabId } = mountOn({ url: "https://github.com/" });
    guest();
    act(() => useBrowserTabs.getState().prune(WS, []));
    expect(document.querySelector("webview")).toBeNull();
    expect(useGuests.getState().guests).toEqual({});
    expect(tabId).toBeTruthy();
  });
});

describe("the browser tab in a plain browser", () => {
  it("frames ports and sends any other site to a new browser tab, saying so", async () => {
    useStore.setState({ api: routeApi() });
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    mountOn(null);
    type("github.com");
    expect(opened).toHaveBeenCalledWith("https://github.com/", "_blank", "noopener");
    expect(screen.getByRole("status").textContent).toBe(UNFRAMEABLE);
    expect(UNFRAMEABLE).toContain("Other sites open in a new browser tab.");
    expect(document.querySelector("webview")).toBeNull();

    type("3000");
    await settle();
    expect(document.querySelector("iframe")?.getAttribute("src")).toBe(ROUTE);
    expect(document.querySelector("webview")).toBeNull();
  });
});
