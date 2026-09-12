// SPDX-License-Identifier: AGPL-3.0-only
// The bridge the preload hands the page, and the channel each of its calls
// rides. The page reads this contract through @wsp/protocol's DesktopBridge,
// so a name that drifts here is a switcher card with no picture on it.
import type { DesktopBridge } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
const send = vi.fn();
const on = vi.fn();
const off = vi.fn();
const exposeInMainWorld = vi.fn();
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke, send, on, off } }));

// The preload reads the renderer's argv as its module body runs, which is the first import below.
process.argv.push("--wsp-version=0.1.7");

async function bridge(): Promise<DesktopBridge> {
  await import("../src/preload.js");
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  const [name, exposed] = exposeInMainWorld.mock.calls[0]!;
  expect(name).toBe("wsp");
  return exposed as DesktopBridge;
}

describe("the preload's bridge", () => {
  it("carries the release this shell is, so a page from a host of another one can say which half is behind", async () => {
    expect((await bridge()).version).toBe("0.1.7");
  });

  it("carries the picture calls the switcher's cards need, each on its own channel", async () => {
    const wsp = await bridge();
    await wsp.capturePreview("ws_a");
    expect(invoke).toHaveBeenLastCalledWith("preview:capture", "ws_a");
    await wsp.workspacePreview("ws_b");
    expect(invoke).toHaveBeenLastCalledWith("preview:read", "ws_b");
    await wsp.localFonts("Berkeley Mono");
    expect(invoke).toHaveBeenLastCalledWith("fonts:local", "Berkeley Mono");
    await wsp.pickFolder();
    expect(invoke).toHaveBeenLastCalledWith("folder:pick");
  });

  it("carries the first launch's calls, each on its own channel", async () => {
    const wsp = (await bridge()) as DesktopBridge & { agents(): Promise<unknown>; install(ids: string[]): Promise<unknown>; finish(): Promise<void>; join(ask: { address: string; code: string }): Promise<unknown> };
    await wsp.agents();
    expect(invoke).toHaveBeenLastCalledWith("onboarding:agents");
    await wsp.install(["claude", "codex"]);
    expect(invoke).toHaveBeenLastCalledWith("onboarding:install", ["claude", "codex"]);
    await wsp.finish();
    expect(invoke).toHaveBeenLastCalledWith("onboarding:finish");
    await wsp.join({ address: "192.168.1.20:7788", code: "QW4K7PZX" });
    expect(invoke).toHaveBeenLastCalledWith("onboarding:join", { address: "192.168.1.20:7788", code: "QW4K7PZX" });
  });

  it("says when a terminal has focus and hands back the chords the shell stood aside from, unsubscribing with the same listener", async () => {
    const wsp = await bridge();
    wsp.setTerminalFocus(true);
    expect(send).toHaveBeenLastCalledWith("terminal:focus", true);
    wsp.setTheme("light");
    expect(send).toHaveBeenLastCalledWith("theme:set", "light");
    const chords: unknown[] = [];
    const stop = wsp.onShellChord(chord => chords.push(chord));
    expect(on).toHaveBeenLastCalledWith("shell:chord", expect.any(Function));
    const listen = on.mock.calls.at(-1)![1] as (event: unknown, chord: unknown) => void;
    listen(null, { key: "=", code: "Equal", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(chords).toEqual([{ key: "=", code: "Equal", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }]);
    stop();
    expect(off).toHaveBeenLastCalledWith("shell:chord", listen);
  });

  it("hands over a build that needs the person and takes the click back, unsubscribing with the same listener", async () => {
    const wsp = await bridge();
    wsp.needsYou({ what: "sign in to GitHub CLI login", since: 1_760_000_000_000 });
    expect(send).toHaveBeenLastCalledWith("needs-you:say", { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 });
    let opened = 0;
    const stop = wsp.onNeedsYouOpen(() => (opened += 1));
    expect(on).toHaveBeenLastCalledWith("needs-you:open", expect.any(Function));
    const listen = on.mock.calls.at(-1)![1] as (event: unknown) => void;
    listen(null);
    expect(opened).toBe(1);
    stop();
    expect(off).toHaveBeenLastCalledWith("needs-you:open", listen);
  });
});

describe("the hosts the window can move between", () => {
  it("carries the token, the list, the switch, the connect and the disconnect on their own channels, and the menu's open", async () => {
    const wsp = await bridge();
    await wsp.hostToken();
    expect(invoke).toHaveBeenLastCalledWith("hosts:token");
    await wsp.hosts();
    expect(invoke).toHaveBeenLastCalledWith("hosts:list");
    await wsp.switchHost("box");
    expect(invoke).toHaveBeenLastCalledWith("hosts:switch", "box");
    await wsp.connectHost({ road: "direct", url: "http://box:4400", code: "ABCDEFGH" });
    expect(invoke).toHaveBeenLastCalledWith("hosts:connect", { road: "direct", url: "http://box:4400", code: "ABCDEFGH" });
    await wsp.disconnectHost("box");
    expect(invoke).toHaveBeenLastCalledWith("hosts:disconnect", "box");
    let opened = 0;
    const stop = wsp.onConnectHostOpen(() => (opened += 1));
    expect(on).toHaveBeenLastCalledWith("hosts:connect-open", expect.any(Function));
    (on.mock.calls.at(-1)![1] as () => void)();
    expect(opened).toBe(1);
    stop();
    expect(off).toHaveBeenLastCalledWith("hosts:connect-open", expect.any(Function));
    const first = wsp as DesktopBridge & { join(ask: { address: string; code: string }): Promise<unknown> };
    await first.join({ address: "192.168.1.20:4420", code: "QW4K7PZX" });
    expect(invoke).toHaveBeenLastCalledWith("onboarding:join", { address: "192.168.1.20:4420", code: "QW4K7PZX" });
  });

  it("carries what this computer is to the wsp it joined, leaving it and the awake hold, each on its own channel", async () => {
    const wsp = await bridge();
    await wsp.place?.();
    expect(invoke).toHaveBeenLastCalledWith("place:standing");
    await wsp.leaveWsp?.();
    expect(invoke).toHaveBeenLastCalledWith("place:leave");
    await wsp.setStayAwake?.(true);
    expect(invoke).toHaveBeenLastCalledWith("place:awake", true);
  });
});
