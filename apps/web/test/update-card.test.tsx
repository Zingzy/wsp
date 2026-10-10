// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's update card: absent while this wsp is level, the version and
// its stage's one act while it is behind, What's new on the release's page,
// and a dismiss the host keeps per version, so every window drops the card and
// a newer release brings it back.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_PREFERENCES, type BundleOutcome, type DesktopBridge, type Preferences, type ReleaseView, type SessionView } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useNotices } from "../src/notices/store.js";
import { UPDATE_WORDS, useUpdateDownload, useUpdateInBackground } from "../src/shell/update.js";
import { UpdateCard } from "../src/sidebar/UpdateCard.js";

const ROW: SessionView = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "thr_1", prompt: "fix the login page" };
const release = (version: string, over: Partial<ReleaseView> = {}): ReleaseView => ({ state: "read", latest: { version, tag: `v${version}`, url: `https://example.test/v${version}`, publishedAt: "2026-10-10T00:00:00Z" }, ...over });

let emit: (e: ProtocolEvent) => void;
let bound: Api;
let api: { setPreferences: ReturnType<typeof vi.fn>; hostRestart: ReturnType<typeof vi.fn> };

function Window() {
  useUpdateInBackground();
  return <UpdateCard />;
}

const settle = (): Promise<void> => act(async () => await new Promise(resolve => setTimeout(resolve, 0)));
const card = (): HTMLElement | null => document.querySelector("[data-update-card]");
const title = (): string | null | undefined => card()?.querySelector("[data-k=update-title]")?.textContent;
const line = (): string | null | undefined => card()?.querySelector("[data-k=update-line]")?.textContent;
const actButton = (): HTMLButtonElement => screen.getByRole("button", { name: /^(Get|Downloading|Quit and open|Restart)$/ });

/** An app of 0.1.0 on its own host. */
function shell(over: Partial<DesktopBridge> = {}) {
  const getBundle = vi.fn(async (_ask: { version: string }): Promise<BundleOutcome> => ({ ok: true }));
  const quitAndOpen = vi.fn(async (): Promise<BundleOutcome> => ({ ok: true }));
  const discardUpdate = vi.fn(async (): Promise<BundleOutcome> => ({ ok: true }));
  const bridge = { version: "0.1.0", getBundle, quitAndOpen, discardUpdate, hosts: async () => ({ here: "zingzy's MacBook Pro", current: null, hosts: [] }), ...over };
  window.wsp = bridge;
  return bridge;
}

beforeEach(async () => {
  // Served on the host's own computer, where a restart may be asked for.
  (window as unknown as { __WSP__?: unknown }).__WSP__ = { version: "0.1.0", paired: true };
  const listeners = new Set<(e: ProtocolEvent) => void>();
  api = {
    setPreferences: vi.fn(async (patch: Partial<Preferences>) => ({ ...useStore.getState().preferences, ...patch })),
    hostRestart: vi.fn(async () => undefined),
  };
  bound = {
    ...api,
    listWorkspaces: vi.fn(async () => []),
    watchStatuses: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({ upgrade: false, snapshot: false })),
    getGolden: vi.fn(async () => ({ versions: [] })),
    listSessions: vi.fn(async () => []),
    subscribe: (fn: (e: ProtocolEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Api;
  useStore.setState({ api: null, release: null, sessions: {}, preferences: DEFAULT_PREFERENCES });
  useStore.getState().bind(bound);
  await settle();
  useStore.setState({ release: null, sessions: { ws_1: [ROW] }, preferences: DEFAULT_PREFERENCES, preferencesRead: true });
  useUpdateDownload.setState({ download: null });
  act(() => useNotices.getState().clear());
  emit = e => act(() => listeners.forEach(fn => fn(e)));
});

afterEach(() => {
  delete (window as unknown as { __WSP__?: unknown }).__WSP__;
  delete window.wsp;
  vi.restoreAllMocks();
  act(() => useNotices.getState().clear());
});

describe("the update card", () => {
  it("is absent while this wsp is level with the release, and while nothing was read", async () => {
    render(<Window />);
    expect(card()).toBeNull();
    act(() => useStore.setState({ release: release("0.1.0") }));
    expect(card()).toBeNull();
    act(() => useStore.setState({ release: { state: "unreached" } }));
    expect(card()).toBeNull();
  });

  it("on a browser tab says the release is out, Get and What's new open its page", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    expect(title()).toBe(UPDATE_WORDS.out("0.3.3"));
    expect(card()?.dataset["updateCard"]).toBe("link");
    fireEvent.click(actButton());
    fireEvent.click(screen.getByRole("button", { name: UPDATE_WORDS.whatsNew }));
    expect(open.mock.calls).toEqual([
      ["https://example.test/v0.3.3", "_blank", "noopener,noreferrer"],
      ["https://example.test/v0.3.3", "_blank", "noopener,noreferrer"],
    ]);
  });

  it("on an app that opens a disk image: Get, Downloading while the shell fetches, then ready with Quit and open", async () => {
    let finish: (outcome: BundleOutcome) => void = () => undefined;
    const { getBundle, quitAndOpen } = shell({ getBundle: vi.fn(() => new Promise<BundleOutcome>(resolve => (finish = resolve))) });
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    await settle();
    expect(getBundle).not.toHaveBeenCalled();
    expect([title(), actButton().textContent]).toEqual([UPDATE_WORDS.out("0.3.3"), UPDATE_WORDS.get]);
    fireEvent.click(actButton());
    expect(getBundle).toHaveBeenCalledWith({ version: "0.3.3" });
    expect(actButton().textContent).toBe(UPDATE_WORDS.downloading);
    expect(actButton().disabled).toBe(true);
    finish({ ok: true });
    await settle();
    expect([title(), actButton().textContent]).toEqual([UPDATE_WORDS.ready("0.3.3"), UPDATE_WORDS.quitAndOpen]);
    fireEvent.click(actButton());
    await settle();
    expect(quitAndOpen).toHaveBeenCalledTimes(1);
  });

  it("on an app that replaces itself downloads in the background, then is ready with Restart and the running threads' fate", async () => {
    const { getBundle, quitAndOpen } = shell({ updatesInPlace: true });
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    await settle();
    expect(getBundle).toHaveBeenCalledTimes(1);
    expect([title(), actButton().textContent]).toEqual([UPDATE_WORDS.ready("0.3.3"), UPDATE_WORDS.restart]);
    expect(card()?.querySelector("[data-k=update-line]")?.textContent).toBe(UPDATE_WORDS.keepRunning(1));
    fireEvent.click(actButton());
    await settle();
    expect(quitAndOpen).toHaveBeenCalledTimes(1);
  });

  it("a download that fails is an error in the shell's words and puts Get back", async () => {
    shell({ getBundle: vi.fn(async (): Promise<BundleOutcome> => ({ ok: false, error: "wsp-0.3.3-mac.zip failed its signature check and was deleted" })) });
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    await settle();
    fireEvent.click(actButton());
    await settle();
    expect(useNotices.getState().notices).toMatchObject([{ kind: "error", text: UPDATE_WORDS.notReady("0.3.3", "wsp-0.3.3-mac.zip failed its signature check and was deleted") }]);
    expect(actButton().textContent).toBe(UPDATE_WORDS.get);
  });

  it("newer files installed under the host are ready, and Restart restarts the host", async () => {
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3", { installed: "0.3.3" }) }));
    expect([title(), actButton().textContent]).toEqual([UPDATE_WORDS.ready("0.3.3"), UPDATE_WORDS.restart]);
    fireEvent.click(actButton());
    await settle();
    expect(api.hostRestart).toHaveBeenCalledTimes(1);
  });

  it("a dismiss is kept on the host for that version: the card goes, a window that hears of it drops it, and a newer release shows again", async () => {
    const first = render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    fireEvent.click(screen.getByRole("button", { name: UPDATE_WORDS.dismiss }));
    expect(api.setPreferences).toHaveBeenCalledWith({ updateDismissed: "0.3.3" });
    expect(card()).toBeNull();
    await settle();
    first.unmount();

    // Another window: its record is the host's, which pushes the dismiss to every socket.
    act(() => useStore.setState({ preferences: DEFAULT_PREFERENCES }));
    render(<Window />);
    expect(title()).toBe(UPDATE_WORDS.out("0.3.3"));
    emit({ type: "preferences.changed", preferences: { ...DEFAULT_PREFERENCES, updateDismissed: "0.3.3" } });
    expect(card()).toBeNull();

    act(() => useStore.setState({ release: release("0.3.4") }));
    expect(title()).toBe(UPDATE_WORDS.out("0.3.4"));
  });

  it("a dismissed release is not downloaded in the background, and dismissing a ready one deletes the checked copy", async () => {
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, updateDismissed: "0.3.3" } }));
    const { getBundle, discardUpdate } = shell({ updatesInPlace: true });
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    await settle();
    expect(getBundle).not.toHaveBeenCalled();
    expect(card()).toBeNull();

    act(() => useStore.setState({ release: release("0.3.4") }));
    await settle();
    expect(getBundle).toHaveBeenCalledWith({ version: "0.3.4" });
    expect(title()).toBe(UPDATE_WORDS.ready("0.3.4"));
    fireEvent.click(screen.getByRole("button", { name: UPDATE_WORDS.dismiss }));
    await settle();
    expect(discardUpdate).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
  });

  it("waits for the host's record before it shows or downloads a release, since the host answers the release first", async () => {
    const { getBundle } = shell({ updatesInPlace: true });
    let answer: (preferences: Preferences) => void = () => undefined;
    useStore.setState({ api: null, preferences: DEFAULT_PREFERENCES, preferencesRead: false });
    useStore.getState().bind({ ...bound, preferences: () => new Promise<Preferences>(resolve => (answer = resolve)), releaseGet: async () => release("0.3.3") } as unknown as Api);
    render(<Window />);
    await settle();
    expect(useStore.getState().release?.latest?.version).toBe("0.3.3");
    expect(card()).toBeNull();
    act(() => answer({ ...DEFAULT_PREFERENCES, updateDismissed: "0.3.3" }));
    await settle();
    expect(card()).toBeNull();
    expect(getBundle).not.toHaveBeenCalled();
  });

  it("a release dismissed while it downloads in the background leaves no checked copy", async () => {
    let finish: (outcome: BundleOutcome) => void = () => undefined;
    const { discardUpdate } = shell({ updatesInPlace: true, getBundle: vi.fn(() => new Promise<BundleOutcome>(resolve => (finish = resolve))) });
    render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    await settle();
    expect(actButton().textContent).toBe(UPDATE_WORDS.downloading);
    fireEvent.click(screen.getByRole("button", { name: UPDATE_WORDS.dismiss }));
    finish({ ok: true });
    await settle();
    expect(discardUpdate).toHaveBeenCalledTimes(1);
    expect(useUpdateDownload.getState().download).toBeNull();
  });

  it("an app that cannot replace itself says why beside Get, and says nothing of it where only the host is behind", async () => {
    const why = "The app runs from a disk image or another drive, so it cannot replace itself. Move wsp to Applications.";
    shell({ updateWhy: why });
    const mounted = render(<Window />);
    act(() => useStore.setState({ release: release("0.3.3") }));
    await settle();
    expect([card()?.dataset["updateCard"], line()]).toEqual(["get", why]);
    mounted.unmount();
    shell({ version: "0.3.3", updateWhy: why });
    render(<Window />);
    await settle();
    expect([card()?.dataset["updateCard"], line()]).toEqual(["link", undefined]);
  });
});
