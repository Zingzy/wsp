// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModeWatcher, parseSttyModes, parseStatTpgid, type ModeProbe, type PtyModeEvent } from "../src/mode.js";

const LINE = { icanon: true, echo: true, foreground: "bash" };
const RAW = { icanon: false, echo: false, foreground: "vim" };

describe("ModeWatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits the current state to a client on attach", async () => {
    const probe = vi.fn(async () => RAW);
    const w = new ModeWatcher(probe, { intervalMs: 200 });
    const got: PtyModeEvent[] = [];
    w.attach("p1", 42, e => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    expect(got).toEqual([{ type: "pty.mode", ptyId: "p1", mode: "raw", echo: false, foreground: "vim" }]);
    w.stop();
  });

  it("delivers current state to a second client without re-broadcasting to the first", async () => {
    const w = new ModeWatcher(async () => LINE, { intervalMs: 200 });
    const first: PtyModeEvent[] = [];
    const second: PtyModeEvent[] = [];
    w.attach("p1", 42, e => first.push(e));
    await vi.advanceTimersByTimeAsync(0);
    w.attach("p1", 42, e => second.push(e));
    await vi.advanceTimersByTimeAsync(0);
    expect(first.length).toBe(1);
    expect(second).toEqual([{ type: "pty.mode", ptyId: "p1", mode: "line", echo: true, foreground: "bash" }]);
    w.stop();
  });

  it("emits only on change across a probe sequence", async () => {
    const seq = [LINE, LINE, RAW, RAW, LINE];
    let i = 0;
    const probe: ModeProbe = async () => seq[Math.min(i++, seq.length - 1)]!;
    const w = new ModeWatcher(probe, { intervalMs: 200 });
    const got: PtyModeEvent[] = [];
    w.attach("p1", 42, e => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(200 * 5);
    expect(got.map(g => [g.mode, g.echo, g.foreground])).toEqual([
      ["line", true, "bash"],
      ["raw", false, "vim"],
      ["line", true, "bash"],
    ]);
    w.stop();
  });

  it("never probes an idle pty and stops polling at zero attachments", async () => {
    const probe = vi.fn(async () => LINE);
    const w = new ModeWatcher(probe, { intervalMs: 200 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe).not.toHaveBeenCalled();

    const un = w.attach("p1", 42, () => {});
    await vi.advanceTimersByTimeAsync(600);
    expect(probe.mock.calls.length).toBeGreaterThan(0);

    un();
    const atDetach = probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(probe.mock.calls.length).toBe(atDetach);
    w.stop();
  });

  it("keeps the last known mode and blanks foreground on probe failure, silently", async () => {
    let fail = false;
    const probe: ModeProbe = async () => {
      if (fail) throw new Error("stty exploded");
      return RAW;
    };
    const w = new ModeWatcher(probe, { intervalMs: 200 });
    const got: PtyModeEvent[] = [];
    w.attach("p1", 42, e => got.push(e));
    await vi.advanceTimersByTimeAsync(0);
    expect(got.length).toBe(1);

    fail = true;
    await vi.advanceTimersByTimeAsync(200);
    expect(got[1]).toEqual({ type: "pty.mode", ptyId: "p1", mode: "raw", echo: false, foreground: "" });

    // repeated failures are not a change; the loop keeps ticking without emitting
    await vi.advanceTimersByTimeAsync(600);
    expect(got.length).toBe(2);

    fail = false;
    await vi.advanceTimersByTimeAsync(200);
    expect(got[2]).toEqual({ type: "pty.mode", ptyId: "p1", mode: "raw", echo: false, foreground: "vim" });
    w.stop();
  });
});

describe("stty and stat parsing", () => {
  it("reads icanon and echo as exact tokens, not substrings", () => {
    const rawOut =
      "speed 38400 baud; rows 24; columns 80; line = 0;\n" +
      "-icanon -echo echoe echok echoctl echoke\n";
    expect(parseSttyModes(rawOut)).toEqual({ icanon: false, echo: false });
    const lineOut = "speed 38400 baud;\nicanon echo echoe echok\n";
    expect(parseSttyModes(lineOut)).toEqual({ icanon: true, echo: true });
  });

  it("extracts tpgid from /proc/<pid>/stat past a comm with spaces and parens", () => {
    const stat = "123 (tmux: server) S 1 123 123 34816 4567 4194304 0 0 0 0";
    expect(parseStatTpgid(stat)).toBe(4567);
    expect(parseStatTpgid("garbage")).toBeNull();
  });
});
