// SPDX-License-Identifier: AGPL-3.0-only
// The stage stream drawn into a small terminal: every frame is replayed through
// a screen that honours the cursor moves the stream writes, and the rows left
// on it are what the person sees. No row may hold two lines, no line may wrap,
// and a step only ever shows once.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ALREADY_APPLIED } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";
import { SEAL_STEPS, StageStream, streamStages, type StageFrame } from "../src/init.js";

const SPINNERS = /[◒◐◓◑]/;
const ev = (stage: string, at: number, detail?: string): StageFrame => ({ type: "golden.stage", name: "default", stage, at, ...(detail !== undefined ? { detail } : {}) });

/** A terminal of `cols` by `rows` cells: printable text, CR, LF, cursor up, cursor to column, erase below and erase line. Styling is dropped. */
class Screen {
  private readonly cells: string[][];
  private row = 0;
  private col = 0;
  private dropped = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
  }

  feed(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\x1b") {
        const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i));
        if (!m) {
          i += 1;
          continue;
        }
        const arg = m[1] === "" ? undefined : Number(m[1]);
        switch (m[2]) {
          case "A":
            this.row = Math.max(0, this.row - (arg ?? 1));
            break;
          case "G":
            this.col = Math.max(0, (arg ?? 1) - 1);
            break;
          case "J":
            if (arg === undefined || arg === 0) {
              this.cells[this.row]!.fill(" ", this.col);
              for (let r = this.row + 1; r < this.rows; r++) this.cells[r]!.fill(" ");
            }
            break;
          case "K":
            if (arg === 2) this.cells[this.row]!.fill(" ");
            else if (arg === undefined || arg === 0) this.cells[this.row]!.fill(" ", this.col);
            break;
          default:
            break;
        }
        i += m[0].length;
        continue;
      }
      if (ch === "\n") {
        this.row += 1;
        this.col = 0;
        this.scroll();
        i += 1;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      const glyph = String.fromCodePoint(text.codePointAt(i)!);
      if (this.col >= this.cols) {
        this.col = 0;
        this.row += 1;
        this.scroll();
      }
      this.cells[this.row]![this.col] = glyph;
      this.col += 1;
      i += glyph.length;
    }
  }

  private scroll(): void {
    while (this.row >= this.rows) {
      this.cells.shift();
      this.cells.push(Array<string>(this.cols).fill(" "));
      this.row -= 1;
      this.dropped += 1;
    }
  }

  /** Rows with text, top to bottom; blank rows under the last one are not counted. */
  lines(): string[] {
    const out = this.cells.map(r => r.join("").trimEnd());
    while (out.length > 0 && out.at(-1) === "") out.pop();
    return out;
  }

  /** Rows that scrolled off the top; a stream that fits never loses one. */
  get scrolled(): number {
    return this.dropped;
  }
}

function terminal(cols: number, rows: number) {
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: cols, rows });
  const screen = new Screen(cols, rows);
  output.on("data", (c: Buffer) => screen.feed(c.toString()));
  return { output, screen };
}

const count = (lines: string[], text: string): number => lines.filter(l => l.includes(text)).length;

describe("stage stream on a terminal", () => {
  it("a long detail under a failed step is cut to the row, so the block never drifts and every step shows once", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(60, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from default"));
      stream.push(ev("deploying-daemon", 1_000));
      stream.push(ev("applying-setup", 2_000, "38 MB pack"));
      stream.push(ev("uploading-files", 3_000, `HTTP 413 from the edge: ${"the pack is over the cap ".repeat(8)}`));
      vi.advanceTimersByTime(250);
      stream.push(ev("failed", 3_500, `upload refused; ${"the machine's disk holds 4 GB and the pack is 5 GB, ".repeat(3)}`));
      vi.advanceTimersByTime(250);
      stream.stop();
      const lines = screen.lines();
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Base installed")).toBe(1);
      expect(count(lines, "Setup applied")).toBe(1);
      expect(count(lines, "Uploading your files failed")).toBe(1);
      expect(lines.every(l => l.length < 60)).toBe(true);
      expect(lines.some(l => l.includes("HTTP 413") && l.endsWith("…"))).toBe(true);
      expect(lines.join("\n")).not.toMatch(SPINNERS);
      expect(screen.scrolled).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed step's tail is trimmed to the terminal's height, so the block stays inside the screen it redraws", () => {
    const { output, screen } = terminal(80, 12);
    const stream = new StageStream(output, true);
    stream.start();
    stream.push(ev("creating", 0));
    stream.push(ev("deploying-daemon", 1_000));
    stream.push(ev("installing-tools", 2_000));
    for (let i = 1; i <= 20; i++) stream.push(ev("installing-tools", 2_000 + i, `tool ${i} (${i}/20)`));
    stream.push(ev("failed", 3_000, "no space left on device"));
    stream.stop();
    const lines = screen.lines();
    expect(screen.scrolled).toBe(0);
    expect(lines.length).toBeLessThan(12);
    expect(count(lines, "Machine created")).toBe(1);
    expect(count(lines, "Installing tools failed")).toBe(1);
    expect(lines.at(-2)).toContain("tool 20 (20/20)");
    expect(lines.at(-1)).toContain("no space left on device");
  });

  it("a line said while the stream runs settles above the block, which stays whole under it", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(80, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from default"));
      vi.advanceTimersByTime(100);
      stream.note("Solari account at its machine cap; waiting 30s for a slot (1/20). Nothing is killed.");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      vi.advanceTimersByTime(100);
      const lines = screen.lines();
      // The note is longer than the row, so it wraps onto a second line; both sit above the block.
      expect(lines[0]).toBe("│  Solari account at its machine cap; waiting 30s for a slot (1/20). Nothing is");
      expect(lines[1]).toBe("│  killed.");
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Creating the machine")).toBe(0);
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(lines).toHaveLength(4);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("console.warn and console.error mid-frame settle above the block, reach the sink, and the console comes back on stop", () => {
    vi.useFakeTimers();
    const warn = console.warn;
    const error = console.error;
    try {
      const { output, screen } = terminal(80, 30);
      const sunk: string[] = [];
      const stream = new StageStream(output, true, undefined, line => sunk.push(line));
      stream.start();
      expect(console.warn).not.toBe(warn);
      stream.push(ev("creating", 0, "sandbox from default"));
      vi.advanceTimersByTime(100);
      console.warn("heartbeat for builder %s not written: %s", "b1", "ETIMEDOUT");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      console.error("hostname first on m1 failed: no route");
      vi.advanceTimersByTime(100);
      const lines = screen.lines();
      expect(lines[0]).toBe("│  heartbeat for builder b1 not written: ETIMEDOUT");
      expect(lines[1]).toBe("│  hostname first on m1 failed: no route");
      expect(lines[2]).toMatch(/^◇  Machine created\s+sandbox from default\s+1\.0s$/);
      expect(lines[3]).toMatch(/^[◒◐◓◑]  Installing the base \(Node, the daemon\)$/);
      expect(lines).toHaveLength(4);
      expect(sunk).toEqual(["heartbeat for builder b1 not written: ETIMEDOUT", "hostname first on m1 failed: no route"]);
      stream.stop();
      expect(console.warn).toBe(warn);
      expect(console.error).toBe(error);
      expect(count(screen.lines(), "heartbeat for builder b1")).toBe(1);
    } finally {
      console.warn = warn;
      console.error = error;
      vi.useRealTimers();
    }
  });

  it("a stream around a call that rejects still stops: the console comes back and the spinner timer ends", async () => {
    vi.useFakeTimers();
    const warn = console.warn;
    try {
      const { output, screen } = terminal(80, 30);
      const rt = { events: { on: () => () => {} } } as unknown as Pick<Runtime, "events">;
      const sunk: string[] = [];
      const failing = streamStages(rt, { output, isTTY: true }, SEAL_STEPS, () => Promise.reject(new Error("the seal call died")), l => sunk.push(l));
      await expect(failing).rejects.toThrow("the seal call died");
      expect(console.warn).toBe(warn);
      const rows = screen.lines().length;
      vi.advanceTimersByTime(500);
      expect(screen.lines().length).toBe(rows);
      expect(sunk).toEqual([]);
    } finally {
      console.warn = warn;
      vi.useRealTimers();
    }
  });

  it("steps follow the frames' order: a step appears on its first frame and closes only when the next stage starts", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(80, 30);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0));
      stream.push(ev("deploying-daemon", 1_000));
      stream.push(ev("applying-setup", 2_000, "38 MB pack"));
      stream.push(ev("uploading-files", 3_000, "38 MB"));
      stream.push(ev("installing-harness", 4_000));
      stream.push(ev("installing-harness", 4_500, "claude (1/3)"));
      vi.advanceTimersByTime(100);
      let lines = screen.lines();
      expect(lines.join("\n")).not.toContain("Tools installed");
      expect(lines.join("\n")).not.toContain("Installing tools");
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(lines.at(-1)).toMatch(/Installing agents\s+claude \(1\/3\)/);

      stream.push(ev("installing-tools", 9_000, "Homebrew's glibc (2/86)"));
      vi.advanceTimersByTime(100);
      lines = screen.lines();
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(lines.at(-2)).toMatch(/Agents installed\s+claude \(1\/3\)\s+5\.0s$/);
      expect(lines.at(-1)).toMatch(/Installing tools\s+Homebrew's glibc \(2\/86\)/);

      stream.push(ev("installing-tools", 60_000, "71 installed, 15 failed"));
      stream.push(ev("ready", 61_000));
      expect(stream.finished).toBe(true);
      stream.stop();
      lines = screen.lines();
      expect(lines.map(l => l.slice(3, 20).trim())).toEqual(["Machine created", "Base installed", "Setup applied", "Files uploaded", "Agents installed", "Tools installed", "Ready"]);
      expect(lines.join("\n")).not.toMatch(SPINNERS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a step the builder already holds closes on its own frame; a failure with nothing running lands on the stage about to run", () => {
    const { output, screen } = terminal(80, 30);
    const stream = new StageStream(output, true);
    stream.start();
    for (const stage of ["creating", "deploying-daemon", "applying-setup", "uploading-files", "installing-harness", "installing-tools", "installing-mcp"]) stream.push(ev(stage, 1_000, ALREADY_APPLIED));
    stream.push(ev("failed", 2_000, "the builder answered exit 1 to a no-op; it is not serving"));
    const view = stream.stop();
    expect(view.steps.map(s => [s.stage, s.state])).toEqual([
      ["creating", "done"],
      ["deploying-daemon", "done"],
      ["applying-setup", "done"],
      ["uploading-files", "done"],
      ["installing-harness", "done"],
      ["installing-tools", "done"],
      ["installing-mcp", "done"],
      ["ready", "failed"],
    ]);
    const lines = screen.lines();
    expect(count(lines, "already applied")).toBe(7);
    expect(lines.at(-2)).toContain("The machine never became ready");
    expect(lines.at(-1)).toContain("the builder answered exit 1");
  });

  it("off a terminal each step is announced as it starts and as it ends, in the frames' order", () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    const stream = new StageStream(output, false);
    stream.start();
    stream.push(ev("creating", 0));
    stream.push(ev("installing-harness", 1_000));
    stream.push(ev("installing-tools", 2_000, "gh (1/2)"));
    stream.push(ev("ready", 3_000));
    stream.stop();
    const text = chunks.join("");
    const order = ["Creating the machine", "Machine created", "Installing agents", "Agents installed", "Installing tools", "Tools installed", "Ready"].map(s => text.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).not.toContain("Installing the base");
  });
});
