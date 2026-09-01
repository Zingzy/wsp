// SPDX-License-Identifier: AGPL-3.0-only
// The Orca landmine map, encoded where jsdom can reach it. IME composition:
// composed text must be sent exactly once, never per keystroke. Parked
// terminals: xterm instances and listeners are released on tab-away (the
// listener count is the proxy for memory staying flat) and only the active
// tab holds a WebGL renderer (the atlas budget).
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabStrip } from "../src/components/TabStrip.js";
import { useStore } from "../src/protocol/store.js";
import { TerminalTab } from "../src/tabs/TerminalTab.js";
import { boot, teardown, WS_ID } from "./terminal-harness.js";

const { webglInstances } = vi.hoisted(() => ({ webglInstances: [] as { disposed: boolean }[] }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    disposed = false;
    constructor() {
      webglInstances.push(this);
    }
    activate(): void {}
    dispose(): void {
      this.disposed = true;
    }
    onContextLoss(): { dispose(): void } {
      return { dispose() {} };
    }
  },
}));

afterEach(async () => {
  cleanup();
  webglInstances.length = 0;
  await teardown();
});

function helperTextarea(): HTMLTextAreaElement {
  const el = document.querySelector(".xterm-helper-textarea");
  expect(el).not.toBeNull();
  return el as HTMLTextAreaElement;
}

function keydown(el: HTMLTextAreaElement, key: string, keyCode: number): void {
  const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "keyCode", { value: keyCode });
  el.dispatchEvent(ev);
}

describe("IME composition", () => {
  it("sends composed text exactly once, not per keystroke", async () => {
    const { daemon, wireLog } = await boot();
    render(<TerminalTab workspaceId={WS_ID} />);
    await waitFor(() => expect(daemon.ptys.list()).toHaveLength(1), { timeout: 10_000 });
    await waitFor(() => expect(document.querySelector(".xterm")).not.toBeNull());
    const textarea = helperTextarea();
    const writes = () => wireLog.filter(m => m.op === "pty.write").map(m => String(m.params["data"]));

    // Baseline: a plain keystroke reaches the pty once.
    keydown(textarea, "a", 65);
    await waitFor(() => expect(writes().join("")).toContain("a"));
    const baseline = writes().length;

    // IME flow: keydown 229 per keystroke while the composition accumulates,
    // then one compositionend carrying the final text.
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    keydown(textarea, "Process", 229);
    textarea.value = "你";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "你", bubbles: true }));
    keydown(textarea, "Process", 229);
    textarea.value = "你好";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "你好", bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "你好", bubbles: true }));

    await waitFor(() => expect(writes().join("")).toContain("你好"), { timeout: 10_000 });
    const composed = writes().slice(baseline).join("");
    expect(composed).toBe("你好"); // once: no per-key duplicates, no double-send on end
  }, 15_000);
});

describe("parked terminals", () => {
  it("20 parked tabs release their listeners and renderers; ptys stay alive", async () => {
    const { wt, daemon } = await boot();
    // cat holds the pty open without shell startup cost, 20 times over.
    for (let i = 0; i < 20; i++) await wt.open({ shell: "/bin/cat" });
    useStore.setState({ selectedId: WS_ID, ready: true });
    const view = render(<TabStrip />);
    expect((await screen.findAllByRole("tab")).filter(t => t.hasAttribute("data-pty"))).toHaveLength(20);

    // Visit every tab: each mount swaps the previous xterm out.
    for (const t of wt.tabs()) {
      act(() => wt.setActive(t.ptyId));
      await waitFor(() => expect(wt.sinkCount()).toBe(1));
      // The atlas budget: only the active tab may hold a WebGL renderer.
      expect(webglInstances.filter(w => !w.disposed).length).toBeLessThanOrEqual(1);
      expect(document.querySelectorAll(".xterm")).toHaveLength(1);
    }

    view.unmount(); // park them all
    expect(wt.sinkCount()).toBe(0); // listener count proxies memory staying flat
    expect(document.querySelectorAll(".xterm")).toHaveLength(0);
    expect(webglInstances.length).toBeGreaterThanOrEqual(20);
    expect(webglInstances.every(w => w.disposed)).toBe(true);

    // Parked, not killed: every pty is still running daemon-side.
    expect(daemon.ptys.list()).toHaveLength(20);
    expect(daemon.ptys.list().every(p => !p.exited)).toBe(true);
  }, 30_000);
});
