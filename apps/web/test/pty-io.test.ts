// SPDX-License-Identifier: AGPL-3.0-only
// The per-pty io the viewport is handed: bytes replay then stream into the
// screen, keys go through the compose table (line mode buffers locally and
// echoes, raw mode passes through), a mode change flushes, a reconnect resets.
import { describe, expect, it } from "vitest";
import { WorkspaceTerminals, type TerminalWire } from "../src/terminal/link.js";
import { composedPtyIo, type TerminalScreen } from "../src/terminal/pty-io.js";

async function setup() {
  const writes: string[] = [];
  const resizes: Record<string, unknown>[] = [];
  const wire: TerminalWire = {
    request: async (op, params = {}) => {
      if (op === "pty.create") return { ok: true, ptyId: "p1" };
      if (op === "pty.write") writes.push(String(params["data"]));
      if (op === "pty.resize") resizes.push(params);
      return { ok: true };
    },
  };
  const wt = new WorkspaceTerminals(wire);
  wt.feedStatus("live");
  await wt.open();
  const painted: string[] = [];
  let resets = 0;
  const screen: TerminalScreen = { write: d => painted.push(d), reset: () => resets++ };
  const io = composedPtyIo(wt, "p1");
  const mode = (m: "line" | "raw", echo = true) => wt.feedEvent({ type: "pty.mode", ptyId: "p1", mode: m, echo, foreground: "" });
  const settle = () => new Promise(r => setTimeout(r, 0));
  return { wt, io, screen, writes, resizes, painted, resets: () => resets, mode, settle };
}

describe("composedPtyIo", () => {
  it("passes keys straight through to the pty before any mode report", async () => {
    const { io, writes, settle } = await setup();
    io.write("a");
    io.write("\r");
    await settle();
    expect(writes).toEqual(["a", "\r"]);
  });

  it("attach replays what the pty already printed, then streams live bytes", async () => {
    const { wt, io, screen, painted } = await setup();
    wt.feedEvent({ type: "pty.data", ptyId: "p1", data: "before" });
    const detach = io.attach(screen);
    expect(painted.join("")).toBe("before");
    wt.feedEvent({ type: "pty.data", ptyId: "p1", data: " after" });
    expect(painted.join("")).toBe("before after");
    detach();
    wt.feedEvent({ type: "pty.data", ptyId: "p1", data: " gone" });
    expect(painted.join("")).toBe("before after");
  });

  it("in line mode, keys echo locally and Enter ships the line as one write", async () => {
    const { io, screen, writes, painted, mode, settle } = await setup();
    io.attach(screen);
    mode("line");
    io.write("l");
    io.write("s");
    await settle();
    expect(painted).toEqual(["l", "s"]);
    expect(writes).toEqual([]);
    io.write("\r");
    await settle();
    expect(writes).toEqual(["ls\r"]);
    expect(painted.at(-1)).toBe("\b \b\b \b");
  });

  it("switching to raw mode flushes the pending line before later keys pass through", async () => {
    const { io, screen, writes, mode, settle } = await setup();
    io.attach(screen);
    mode("line");
    io.write("v");
    io.write("i");
    mode("raw");
    io.write("j");
    await settle();
    expect(writes).toEqual(["vi", "j"]);
  });

  it("a reconnect resets the screen and drops the compose state back to raw", async () => {
    const { wt, io, screen, writes, resets, mode, settle } = await setup();
    io.attach(screen);
    mode("line");
    io.write("x");
    wt.feedStatus("connecting");
    wt.feedStatus("live");
    expect(resets()).toBe(1);
    io.write("y");
    await settle();
    expect(writes).toEqual(["y"]);
  });

  it("resize goes to the pty as pty.resize", async () => {
    const { io, resizes, settle } = await setup();
    io.resize(100, 40);
    await settle();
    expect(resizes).toEqual([{ ptyId: "p1", cols: 100, rows: 40 }]);
  });
});
