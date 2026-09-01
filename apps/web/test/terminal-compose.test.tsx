// SPDX-License-Identifier: AGPL-3.0-only
// The terminal tab under fixture pty.mode events over a fake wire: line mode
// holds keystrokes until Enter, raw mode passes them through, and a switch to
// raw flushes what was pending. The daemon's probe is inert off Linux, so the
// events are fed by hand through the model, exactly as the link would.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTab } from "../src/tabs/TerminalTab.js";
import { provideTerminals, WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    activate(): void {}
    dispose(): void {}
    onContextLoss(): { dispose(): void } {
      return { dispose() {} };
    }
  },
}));

const WS_ID = "ws_compose_test";
const PTY = "p1";

afterEach(() => {
  cleanup();
  provideTerminals(WS_ID, null);
});

async function mount() {
  const writes: string[] = [];
  const wire: TerminalWire = {
    request: async (op, params = {}) => {
      if (op === "pty.create") return { ok: true, ptyId: PTY };
      if (op === "pty.write") writes.push(String(params["data"]));
      return { ok: true };
    },
  };
  const wt = new WorkspaceTerminals(wire);
  wt.feedStatus("live");
  provideTerminals(WS_ID, wt);
  render(<TerminalTab workspaceId={WS_ID} />);
  await waitFor(() => expect(document.querySelector(".xterm-helper-textarea")).not.toBeNull());
  const textarea = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
  const key = (k: string, keyCode: number, init: KeyboardEventInit = {}): void => {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(ev, "keyCode", { value: keyCode });
    textarea.dispatchEvent(ev);
  };
  const mode = (m: "line" | "raw", echo = true): void =>
    wt.feedEvent({ type: "pty.mode", ptyId: PTY, mode: m, echo, foreground: "" });
  const settle = () => new Promise(r => setTimeout(r, 20));
  // What xterm's DOM renderer painted; the trailing cursor cell is trimmed.
  const painted = () => (document.querySelector(".xterm-rows")?.textContent ?? "").trim();
  return { wt, writes, key, mode, settle, painted };
}

describe("TerminalTab compose", () => {
  it("passes keys straight through while no pty.mode event has been seen", async () => {
    const { writes, key, settle } = await mount();
    key("a", 65);
    key("Enter", 13);
    await settle();
    expect(writes).toEqual(["a", "\r"]);
  });

  it("in line mode, holds keys until Enter, paints them locally, and sends the line in one write", async () => {
    const { writes, key, mode, settle, painted } = await mount();
    mode("line");
    key("l", 76);
    key("s", 83);
    await waitFor(() => expect(painted()).toBe("ls"));
    expect(writes).toEqual([]);
    key("Enter", 13);
    await settle();
    expect(writes).toEqual(["ls\r"]);
    // The local paint is erased so the pty's own echo of the line is not doubled.
    await waitFor(() => expect(painted()).toBe(""));
  });

  it("in line mode with echo off, keys are buffered but never painted", async () => {
    const { writes, key, mode, settle, painted } = await mount();
    mode("line", false);
    key("h", 72);
    key("i", 73);
    await settle();
    expect(painted()).toBe("");
    key("Enter", 13);
    await settle();
    expect(writes).toEqual(["hi\r"]);
  });

  it("in line mode, Backspace edits locally and a control key flushes then passes through", async () => {
    const { writes, key, mode, settle, painted } = await mount();
    mode("line");
    key("a", 65);
    key("b", 66);
    key("Backspace", 8);
    await waitFor(() => expect(painted()).toBe("a"));
    key("Tab", 9);
    await settle();
    expect(writes).toEqual(["a\t"]);
    key("c", 67, { ctrlKey: true });
    await settle();
    expect(writes).toEqual(["a\t", "\x03"]);
  });

  it("switching to raw mode flushes the pending buffer before passing keys through", async () => {
    const { writes, key, mode, settle } = await mount();
    mode("line");
    key("v", 86);
    key("i", 73);
    await settle();
    expect(writes).toEqual([]);
    mode("raw");
    key("j", 74);
    await settle();
    expect(writes).toEqual(["vi", "j"]);
  });

  it("a remount picks up the last reported mode", async () => {
    const { wt, writes, mode, settle } = await mount();
    mode("line");
    cleanup();
    render(<TerminalTab workspaceId={WS_ID} />);
    await waitFor(() => expect(document.querySelector(".xterm-helper-textarea")).not.toBeNull());
    const textarea = document.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
    const ev = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    Object.defineProperty(ev, "keyCode", { value: 88 });
    textarea.dispatchEvent(ev);
    await settle();
    expect(writes).toEqual([]);
    expect(wt.tabs()).toHaveLength(1);
  });
});
