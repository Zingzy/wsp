// SPDX-License-Identifier: AGPL-3.0-only
// The stage stream drawn into a small terminal: every frame is replayed through
// a screen that honours the cursor moves the stream writes, and the rows left
// on it are what the person sees. No row may hold two lines, no line may wrap,
// and a step only ever shows once.
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ALREADY_APPLIED } from "@wsp/protocol";
import type { Runtime } from "@wsp/runtime";
import { SEAL_STEPS, StageStream, streamStages, type StageFrame } from "../src/init.js";

const SPINNERS = /[◒◐◓◑]/;
const ev = (stage: string, at: number, detail?: string): StageFrame => ({ type: "golden.stage", name: "default", stage, at, ...(detail !== undefined ? { detail } : {}) });

/** A terminal of `cols` by `rows` cells: printable text, CR, LF, cursor up, cursor to column, erase below and erase line. Styling is dropped.
 * A resize reflows it the way Ghostty does: a row that overflowed continues on the next, and a narrower screen wraps every row wider than it. */
class Screen {
  private cells: string[][];
  /** Whether a row is the continuation of the one above, wrapped there because the text ran past the edge. */
  private wrapped: boolean[];
  private row = 0;
  private col = 0;
  private dropped = 0;

  constructor(
    public cols: number,
    readonly rows: number,
  ) {
    this.cells = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
    this.wrapped = Array<boolean>(rows).fill(false);
  }

  resize(cols: number): void {
    const logical: string[] = [];
    let at = { line: 0, offset: 0 };
    for (let r = 0; r < this.rows; r++) {
      const text = r + 1 < this.rows && this.wrapped[r + 1] ? this.cells[r]!.join("") : this.cells[r]!.join("").trimEnd();
      if (this.wrapped[r]) logical[logical.length - 1] += text;
      else logical.push(text);
      if (r === this.row) at = { line: logical.length - 1, offset: logical[logical.length - 1]!.length - text.length + this.col };
    }
    while (logical.length > 0 && logical.at(-1) === "" && logical.length - 1 > at.line) logical.pop();
    const rows: string[][] = [];
    const wrapped: boolean[] = [];
    let cursor = { row: 0, col: 0 };
    logical.forEach((text, i) => {
      const glyphs = Array.from(text);
      const chunks = glyphs.length === 0 ? [[]] : Array.from({ length: Math.ceil(glyphs.length / cols) }, (_, k) => glyphs.slice(k * cols, (k + 1) * cols));
      if (i === at.line) cursor = { row: rows.length + Math.floor(at.offset / cols), col: at.offset % cols };
      chunks.forEach((chunk, k) => {
        rows.push([...chunk, ...Array<string>(cols - chunk.length).fill(" ")]);
        wrapped.push(k > 0);
      });
    });
    while (rows.length > this.rows) {
      rows.shift();
      wrapped.shift();
      cursor.row -= 1;
      this.dropped += 1;
    }
    while (rows.length < this.rows) {
      rows.push(Array<string>(cols).fill(" "));
      wrapped.push(false);
    }
    this.cols = cols;
    this.cells = rows;
    this.wrapped = wrapped;
    this.row = cursor.row;
    this.col = cursor.col;
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
              for (let r = this.row + 1; r < this.rows; r++) {
                this.cells[r]!.fill(" ");
                this.wrapped[r] = false;
              }
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
        this.wrapped[this.row] = false;
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
        this.wrapped[this.row] = true;
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
      this.wrapped.shift();
      this.wrapped.push(false);
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

/** One terminal with both of a process's streams on it, as stdout and stderr share a screen; `resize` is the pane changing width under a running stream. */
function terminal(cols: number, rows: number) {
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: cols, rows });
  const stderr = Object.assign(new PassThrough(), { isTTY: true, columns: cols, rows });
  const screen = new Screen(cols, rows);
  output.on("data", (c: Buffer) => screen.feed(c.toString()));
  stderr.on("data", (c: Buffer) => screen.feed(c.toString()));
  const resize = (to: number): void => {
    output.columns = to;
    stderr.columns = to;
    screen.resize(to);
  };
  return { output, stderr, screen, resize };
}

const NODE_WARNING = "(node:72935) MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal]. MaxListeners is 10. Use events.setMaxListeners() to increase limit\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

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

  for (const cols of [80, 120]) {
    it(`a detail carrying carriage returns or escape sequences lands on its row as a terminal would leave it, at ${cols} columns`, () => {
      vi.useFakeTimers();
      try {
        const { output, screen } = terminal(cols, 30);
        const written: string[] = [];
        output.on("data", (c: Buffer) => written.push(c.toString()));
        const stream = new StageStream(output, true);
        stream.start();
        stream.push(ev("creating", 0, "sandbox from base"));
        stream.push(ev("deploying-daemon", 1_000, "node v18.20.4"));
        stream.push(ev("applying-setup", 2_000, "zsh: installing, with shell/oh-my-zsh"));
        const progress = ["(Reading database ... ", ...[5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100].map(n => `(Reading database ... ${n}%`), "(Reading database ... 12345 files and directories currently installed.)"];
        stream.push(ev("applying-setup", 3_000, `zsh: ${progress.join("\r")}`));
        vi.advanceTimersByTime(100);
        let lines = screen.lines();
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatch(/^[◒◐◓◑]  Applying your setup\s+\(Reading database \.\.\. 12345 files/);
        expect(lines[2]).not.toContain("%");
        stream.push(ev("applying-setup", 4_000, "zsh: Unpacking zsh (5.9-4+b15) ...\r"));
        vi.advanceTimersByTime(100);
        lines = screen.lines();
        expect(lines).toHaveLength(3);
        expect(lines[2]).toMatch(/^[◒◐◓◑]  Applying your setup\s+zsh: Unpacking zsh \(5\.9-4\+b15\) \.\.\.$/);
        stream.push(ev("applying-setup", 5_000, `zsh: Created symlink /etc/systemd/system/timers.target.wants/man-db.timer \u2192 /lib/systemd/system/man-db.timer.\r\r`));
        stream.push(ev("uploading-files", 6_000, "38 MB"));
        stream.push(ev("installing-harness", 7_000, "\x07\x1b[2K\x1b[1AClaude Code: \x1b[32m\u2714\x1b[0m Claude Code successfully installed!"));
        vi.advanceTimersByTime(100);
        lines = screen.lines();
        expect(lines).toHaveLength(5);
        expect(lines[2]).toMatch(/^◇  Setup applied\s+zsh: Created symlink \/etc\/sys.*\s+4\.0s$/);
        expect(lines[3]).toMatch(/^◇  Files uploaded\s+38 MB\s+1\.0s$/);
        expect(lines[4]).toMatch(/^[◒◐◓◑]  Installing agents\s+Claude Code: \u2714 Claude Code/);
        expect(written.join("")).not.toMatch(/\x07|\x1b\[2K|\x1b\[0m/);
        expect(count(lines, "Machine created")).toBe(1);
        expect(lines.every(l => l.length < cols)).toBe(true);
        expect(screen.scrolled).toBe(0);
        stream.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a failed frame's detail is flattened line by line, so the guest's carriage returns and colours never reach the rows", () => {
    const { output, screen } = terminal(80, 30);
    const written: string[] = [];
    output.on("data", (c: Buffer) => written.push(c.toString()));
    const stream = new StageStream(output, true);
    stream.start();
    stream.push(ev("creating", 0, "sandbox from base"));
    stream.push(ev("installing-tools", 1_000, "jq: Setting up jq ... \rSetting up jq ... 100%"));
    stream.push(ev("failed", 2_000, "E: Unable to locate package htop\r\x1b[31mE: Unable to locate package htop\x1b[0m\r\napt-get exited 100\r"));
    stream.stop();
    const lines = screen.lines();
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^◇  Machine created\s+sandbox from base\s+1\.0s$/);
    expect(lines.slice(1)).toEqual(["▲  Installing tools failed", "│  Setting up jq ... 100%", "│  E: Unable to locate package htop", "│  apt-get exited 100"]);
    expect(written.join("")).not.toMatch(/\x1b\[31m|\r/);
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

  it("a line written to stdout or stderr from outside the stream settles above the block, reaches the sink, and the streams come back on stop", () => {
    vi.useFakeTimers();
    try {
      const { output, stderr, screen } = terminal(80, 30);
      const outWrite = output.write;
      const errWrite = stderr.write;
      const sunk: string[] = [];
      const stream = new StageStream(output, true, undefined, line => sunk.push(line), stderr);
      stream.start();
      expect(output.write).not.toBe(outWrite);
      expect(stderr.write).not.toBe(errWrite);
      stream.push(ev("creating", 0, "sandbox from default"));
      vi.advanceTimersByTime(100);
      stderr.write("heartbeat for builder b1 not written: ETIMEDOUT\n");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      output.write(Buffer.from("hostname first on m1 failed: \x1b[31mno route\x1b[0m\r\n"));
      vi.advanceTimersByTime(100);
      const lines = screen.lines();
      expect(lines[0]).toBe("│  heartbeat for builder b1 not written: ETIMEDOUT");
      expect(lines[1]).toBe("│  hostname first on m1 failed: no route");
      expect(lines[2]).toMatch(/^◇  Machine created\s+sandbox from default\s+1\.0s$/);
      expect(lines[3]).toMatch(/^[◒◐◓◑]  Installing the base \(tools and daemon\)$/);
      expect(lines).toHaveLength(4);
      expect(sunk).toEqual(["heartbeat for builder b1 not written: ETIMEDOUT", "hostname first on m1 failed: no route"]);
      stream.stop();
      expect(output.write).toBe(outWrite);
      expect(stderr.write).toBe(errWrite);
      expect(count(screen.lines(), "heartbeat for builder b1")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("one stream given as both output and aside is taken once, and stop hands back the write it started with", () => {
    vi.useFakeTimers();
    try {
      const { output, screen } = terminal(80, 30);
      const original = output.write;
      // Every assignment to write is recorded, so a second take shows up as a count before stop can draw through it.
      const assigned: unknown[] = [];
      let current = original;
      Object.defineProperty(output, "write", {
        configurable: true,
        get: () => current,
        set: (w: typeof original) => {
          assigned.push(w);
          current = w;
        },
      });
      const sunk: string[] = [];
      const stream = new StageStream(output, true, undefined, line => sunk.push(line), output);
      stream.start();
      expect(assigned).toHaveLength(1);
      expect(output.write).not.toBe(original);
      stream.push(ev("creating", 0, "sandbox from base"));
      vi.advanceTimersByTime(100);
      output.write("a line from outside\n");
      vi.advanceTimersByTime(100);
      stream.push(ev("deploying-daemon", 1_000));
      stream.stop();
      expect(assigned).toHaveLength(2);
      expect(output.write).toBe(original);
      const lines = screen.lines();
      expect(lines[0]).toBe("│  a line from outside");
      expect(count(lines, "Machine created")).toBe(1);
      expect(lines).toHaveLength(3);
      expect(sunk).toEqual(["a line from outside"]);
      output.write("after stop\n");
      expect(screen.lines().at(-1)).toBe("after stop");
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [where, aside] of [
    ["/dev/null", () => ({ stderr: new Writable({ write: (_c, _e, cb) => cb() }), sent: undefined })],
    ["a pipe", () => {
      const stderr = new PassThrough();
      const sent: string[] = [];
      stderr.on("data", (c: Buffer) => sent.push(c.toString()));
      return { stderr, sent };
    }],
  ] as const) {
    it(`a stderr sent to ${where} is not a terminal, so its bytes stay where the shell sent them and never reach the block`, () => {
      vi.useFakeTimers();
      try {
        const { output, screen } = terminal(80, 30);
        const { stderr, sent } = aside();
        const errWrite = stderr.write;
        const sunk: string[] = [];
        const stream = new StageStream(output, true, undefined, line => sunk.push(line), stderr);
        stream.start();
        expect(stderr.write).toBe(errWrite);
        stream.push(ev("creating", 0, "sandbox from base"));
        vi.advanceTimersByTime(100);
        const raw = "heartbeat for builder b1 not written: \x1b[31mETIMEDOUT\x1b[0m\r\n";
        stderr.write(raw);
        vi.advanceTimersByTime(100);
        stream.push(ev("deploying-daemon", 1_000));
        vi.advanceTimersByTime(100);
        const lines = screen.lines();
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^◇  Machine created\s+sandbox from base\s+1\.0s$/);
        expect(count(lines, "heartbeat")).toBe(0);
        expect(sunk).toEqual([]);
        if (sent !== undefined) expect(sent.join("")).toBe(raw);
        stream.stop();
        expect(stderr.write).toBe(errWrite);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a stream around a call that rejects still stops: the output comes back and the spinner timer ends", async () => {
    vi.useFakeTimers();
    try {
      const { output, stderr, screen } = terminal(80, 30);
      const write = output.write;
      const rt = { events: { on: () => () => {} } } as unknown as Pick<Runtime, "events">;
      const sunk: string[] = [];
      const failing = streamStages(rt, { output, stderr, isTTY: true }, SEAL_STEPS, () => Promise.reject(new Error("the seal call died")), l => sunk.push(l));
      await expect(failing).rejects.toThrow("the seal call died");
      expect(output.write).toBe(write);
      const rows = screen.lines().length;
      vi.advanceTimersByTime(500);
      expect(screen.lines().length).toBe(rows);
      expect(sunk).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const cols of [80, 120]) {
    it(`a warning Node prints to stderr past the stream settles above the block and no step is drawn twice, at ${cols} columns`, () => {
      vi.useFakeTimers();
      try {
        const { output, stderr, screen } = terminal(cols, 40);
        const sunk: string[] = [];
        const stream = new StageStream(output, true, undefined, line => sunk.push(line), stderr);
        stream.start();
        stream.push(ev("creating", 0, "sandbox from base"));
        stream.push(ev("deploying-daemon", 5_200, "node v18.20.4"));
        stream.push(ev("applying-setup", 14_100, "zsh installed as the login shell; shell/oh-my-zsh reinstalled"));
        stream.push(ev("uploading-files", 30_200, "38 MB"));
        vi.advanceTimersByTime(100);
        stderr.write(NODE_WARNING);
        vi.advanceTimersByTime(100);
        stream.push(ev("uploading-files", 47_500, "38 MB in 2 parts in 17.3s"));
        stream.push(ev("installing-harness", 47_500));
        vi.advanceTimersByTime(100);
        const lines = screen.lines();
        expect(count(lines, "Machine created")).toBe(1);
        expect(count(lines, "Base installed")).toBe(1);
        expect(count(lines, "Setup applied")).toBe(1);
        expect(lines[0]).toMatch(/^│  \(node:72935\) MaxListenersExceededWarning: Possible EventTarget memory leak/);
        expect(lines.findIndex(l => l.startsWith("◇  Machine created"))).toBeGreaterThan(1);
        expect(count(lines, "Files uploaded")).toBe(1);
        expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
        expect(lines.every(l => l.length < cols)).toBe(true);
        expect(screen.scrolled).toBe(0);
        expect(sunk).toEqual(NODE_WARNING.trimEnd().split("\n"));
        stream.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("a pane narrowed under the block wraps its rows, and the next redraw still starts at the block's first row", () => {
    vi.useFakeTimers();
    try {
      const { output, screen, resize } = terminal(120, 40);
      const stream = new StageStream(output, true);
      stream.start();
      stream.push(ev("creating", 0, "sandbox from base"));
      stream.push(ev("deploying-daemon", 5_200, "node v18.20.4"));
      stream.push(ev("applying-setup", 14_100, "zsh installed as the login shell; shell/oh-my-zsh reinstalled"));
      stream.push(ev("uploading-files", 30_200, "38 MB"));
      vi.advanceTimersByTime(100);
      expect(screen.lines()).toHaveLength(4);
      resize(70);
      expect(screen.lines()).toHaveLength(7);
      vi.advanceTimersByTime(100);
      let lines = screen.lines();
      expect(lines).toHaveLength(4);
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Setup applied")).toBe(1);
      expect(lines.every(l => l.length < 70)).toBe(true);
      resize(120);
      stream.push(ev("installing-harness", 47_500));
      vi.advanceTimersByTime(100);
      lines = screen.lines();
      expect(lines).toHaveLength(5);
      expect(count(lines, "Machine created")).toBe(1);
      expect(count(lines, "Files uploaded")).toBe(1);
      expect(lines.filter(l => SPINNERS.test(l))).toHaveLength(1);
      expect(screen.scrolled).toBe(0);
      stream.stop();
    } finally {
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
