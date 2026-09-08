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

async function bridge(): Promise<DesktopBridge> {
  await import("../src/preload.js");
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  const [name, exposed] = exposeInMainWorld.mock.calls[0]!;
  expect(name).toBe("wsp");
  return exposed as DesktopBridge;
}

describe("the preload's bridge", () => {
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
});
