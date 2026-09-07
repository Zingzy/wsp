// SPDX-License-Identifier: AGPL-3.0-only
// The bridge the preload hands the page, and the channel each of its calls
// rides. The page reads this contract through @wsp/protocol's DesktopBridge,
// so a name that drifts here is a switcher card with no picture on it.
import type { DesktopBridge } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
const exposeInMainWorld = vi.fn();
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke } }));

async function bridge(): Promise<DesktopBridge & Record<string, (...args: unknown[]) => Promise<unknown>>> {
  await import("../src/preload.js");
  expect(exposeInMainWorld).toHaveBeenCalledOnce();
  const [name, exposed] = exposeInMainWorld.mock.calls[0]!;
  expect(name).toBe("wsp");
  return exposed as DesktopBridge & Record<string, (...args: unknown[]) => Promise<unknown>>;
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
});
