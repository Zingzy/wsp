// SPDX-License-Identifier: AGPL-3.0-only
// The launch and poll contract over a scripted guest: a log that grows between
// polls, an exit file, a leader that can die or be killed, and a machine that
// naps mid-run. The last block runs the real guest commands under this
// machine's bash with setsid shimmed, since macOS has none.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXEC_BODY_MAX } from "@wsp/protocol";
import { DEADLINE_EXIT, INLINE_EXEC_MS, execDetached, putFiles } from "../src/exec-detached.js";
import type { ExecResult, Machine } from "../src/machine.js";
import { EXEC_ENV } from "../src/solari-backend.js";

interface Step {
  out?: string;
  err?: string;
  exit?: number;
  dead?: boolean;
  /** The poll fails as it does while the machine is paused. */
  nap?: boolean;
}

interface Call {
  cmd: string;
  timeoutMs: number | undefined;
}

const PIECE = /^printf %s '([A-Za-z0-9+/=]*)' > '([^']*)'\.(\d+) \|\| exit 1$/;
const SOURCE = String.raw`(?:printf %s '([A-Za-z0-9+/=]*)'|cat '([^']*)'\.\{0\.\.(\d+)\})`;
const LAND = new RegExp(String.raw`^${SOURCE} \| base64 -d > '([^']*)' \|\| exit 1$`);
const APPEND = new RegExp(String.raw`^\[ -e '([^']*)' \] \|\| \{ ${SOURCE} \| base64 -d >> '([^']*)' && : > '\1'; \} \|\| exit 1$`);

/** The guest's disk as the upload lines write it: pieces by name, files by path, an append onto what is there once
 * per marker, as the real shell would. */
function guestDisk() {
  const files = new Map<string, string>();
  const pieces = new Map<string, string>();
  const marks = new Set<string>();
  const decode = (b64: string | undefined, piecePath: string | undefined, n: string | undefined): string => {
    const joined = b64 ?? Array.from({ length: Number(n) + 1 }, (_, i) => pieces.get(`${piecePath}.${i}`) ?? "").join("");
    return Buffer.from(joined, "base64").toString("utf8");
  };
  const apply = (cmd: string): { pieces: number; landed: string[] } => {
    const got = { pieces: 0, landed: [] as string[] };
    for (const line of cmd.split("\n")) {
      const p = PIECE.exec(line);
      if (p !== null) {
        pieces.set(`${p[2]}.${p[3]}`, p[1]!);
        got.pieces++;
        continue;
      }
      const a = APPEND.exec(line);
      if (a !== null) {
        if (marks.has(a[1]!)) continue;
        files.set(a[5]!, (files.get(a[5]!) ?? "") + decode(a[2], a[3], a[4]));
        marks.add(a[1]!);
        got.landed.push(a[5]!);
        continue;
      }
      const l = LAND.exec(line);
      if (l === null) continue;
      files.set(l[4]!, decode(l[1], l[2], l[3]));
      got.landed.push(l[4]!);
    }
    return got;
  };
  return { files, marks, apply };
}

/** A guest that answers the transport: steps apply one per poll, before the poll reads. */
function guest(steps: Step[]) {
  let out = Buffer.alloc(0);
  let err = Buffer.alloc(0);
  let exit = "";
  let alive = true;
  let step = 0;
  const calls: Call[] = [];
  const kills: string[] = [];
  const polls: { out: number; err: number }[] = [];
  let cleaned = 0;
  const disk = guestDisk();
  const machine = {
    id: "m1",
    async exec(cmd: string, o?: { timeoutMs?: number }): Promise<ExecResult> {
      calls.push({ cmd, timeoutMs: o?.timeoutMs });
      if (cmd.includes("echo WSP_PIECE")) {
        if (disk.apply(cmd).pieces !== 1) throw new Error(`piece exec without a numbered file: ${cmd}`);
        return { exitCode: 0, stdout: "WSP_PIECE\n", stderr: "" };
      }
      if (cmd.includes("echo WSP_LAUNCHED")) {
        disk.apply(cmd);
        return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
      }
      if (cmd.includes("kill -TERM")) {
        kills.push(cmd);
        alive = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.startsWith("rm -")) {
        cleaned++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("echo WSP_POLL")) {
        const s = steps[step];
        if (s !== undefined) {
          step++;
          if (s.nap) throw Object.assign(new Error("Bad Gateway"), { kind: "transient", status: 502 });
          if (s.out !== undefined) out = Buffer.concat([out, Buffer.from(s.out)]);
          if (s.err !== undefined) err = Buffer.concat([err, Buffer.from(s.err)]);
          if (s.exit !== undefined) exit = String(s.exit);
          if (s.dead) alive = false;
        }
        const from = { out: Number(cmd.match(/tail -c \+(\d+) "\$b\.out"/)?.[1]) - 1, err: Number(cmd.match(/tail -c \+(\d+) "\$b\.err"/)?.[1]) - 1 };
        polls.push(from);
        const chunk = (buf: Buffer, at: number) => buf.subarray(at, at + 262_144).toString("base64");
        return { exitCode: 0, stdout: `WSP_POLL\n${exit}\n${chunk(out, from.out)}\n${chunk(err, from.err)}\n${alive ? "up" : "down"}\nWSP_POLL_END\n`, stderr: "" };
      }
      throw new Error(`guest got an unexpected command: ${cmd}`);
    },
  } as unknown as Machine;
  const script = (): string | undefined => [...disk.files].find(([path]) => path.endsWith(".sh"))?.[1];
  return { machine, calls, kills, polls, script, cleaned: () => cleaned };
}

/** The bytes the provider counts: its request with the backend's wrapper around the command. */
const solariBody = (cmd: string): number => Buffer.byteLength(JSON.stringify({ cmd: "bash", args: ["-c", `${EXEC_ENV}\n${cmd}`], timeoutMs: INLINE_EXEC_MS }));
/** Every exec before the first poll: the launch, with the pieces ahead of it when the script needs them. */
const launchCalls = (calls: readonly Call[]): Call[] => calls.slice(0, calls.findIndex(c => c.cmd.includes("echo WSP_POLL")));
/** Forty kilobytes of lines with quotes and bytes outside ASCII, so a piece boundary that broke the encoding would show. */
const BIG_SCRIPT = Array.from({ length: 480 }, (_, i) => `echo 'line ${i} it'\\''s ünïcödé ${"y".repeat(50)}'`).join("\n");

describe("execDetached over a scripted guest", () => {
  it("launches the script detached, reads both streams from where the last poll stopped, and returns the exit file", async () => {
    const g = guest([{ out: "one\ntw" }, { out: "o\nthree\n", err: "warn\n" }, { exit: 3 }]);
    const lines: string[] = [];
    const res = await execDetached(g.machine, "brew install gh", { deadlineMs: 10_000, pollMs: 1, onLine: l => lines.push(l) });
    expect(res).toEqual({ exitCode: 3, stdout: "one\ntwo\nthree\n", stderr: "warn\n" });
    expect(lines).toEqual(["one", "two", "three", "warn"]);
    expect(g.script()).toBe("brew install gh");
    expect(g.polls).toEqual([{ out: 0, err: 0 }, { out: 6, err: 0 }, { out: 14, err: 5 }]);
    expect(g.cleaned()).toBe(1);
    expect(g.kills).toEqual([]);
  });

  it("every exec it sends is bounded at the inline cap", async () => {
    const g = guest([{ out: "x\n", exit: 0 }]);
    await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(g.calls.length).toBeGreaterThanOrEqual(3);
    for (const c of g.calls) expect(c.timeoutMs, c.cmd).toBeLessThanOrEqual(INLINE_EXEC_MS);
  });

  it("a full chunk is followed at once by the next read from the new offset", async () => {
    const big = "x".repeat(262_144) + "tail\n";
    const g = guest([{ out: big, exit: 0 }]);
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(res.stdout).toBe(big);
    expect(g.polls.map(p => p.out)).toEqual([0, 262_144]);
  });

  it("the exit file ends the run only once nothing is left to read", async () => {
    const g = guest([{ exit: 0, out: "a".repeat(262_144) }, { out: "b\n" }]);
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(res.stdout).toBe(`${"a".repeat(262_144)}b\n`);
  });

  it("past the deadline it kills the recorded pid with its group and answers 124 with the output so far", async () => {
    const g = guest([{ out: "started\n" }]);
    const t0 = Date.now();
    const res = await execDetached(g.machine, "sleep 999", { deadlineMs: 40, pollMs: 1 });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(res.exitCode).toBe(DEADLINE_EXIT);
    expect(res.stdout).toBe("started\n");
    expect(g.kills).toHaveLength(1);
    expect(g.kills[0]).toMatch(/p=\$\(cat "\$b\.pid"[^\n]*kill -TERM -- "-\$p" "\$p"[^\n]*kill -KILL -- "-\$p" "\$p"/);
    expect(g.cleaned()).toBe(1);
  });

  it("a poll that fails while the machine naps is retried after a pause and the run completes", async () => {
    const g = guest([{ out: "before\n" }, { nap: true }, { nap: true }, { out: "after\n", exit: 0 }]);
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1 });
    expect(res).toEqual({ exitCode: 0, stdout: "before\nafter\n", stderr: "" });
    expect(g.calls.filter(c => c.cmd.includes("echo WSP_POLL"))).toHaveLength(4);
  });

  it("a nap that outlasts the deadline still ends in 124, with the kill attempted", async () => {
    const g = guest(Array.from({ length: 200 }, () => ({ nap: true })));
    const res = await execDetached(g.machine, "true", { deadlineMs: 30, pollMs: 1 });
    expect(res.exitCode).toBe(DEADLINE_EXIT);
  });

  it("a leader gone without an exit file answers -1 and says so on stderr", async () => {
    const g = guest([{ out: "partial" }, { dead: true }]);
    const lines: string[] = [];
    const res = await execDetached(g.machine, "true", { deadlineMs: 10_000, pollMs: 1, onLine: l => lines.push(l) });
    expect(res.exitCode).toBe(-1);
    expect(res.stdout).toBe("partial");
    expect(res.stderr).toContain("ended without reporting an exit code");
    expect(lines).toEqual(["partial"]);
  });

  it("a script that fits one exec body goes up in one launch exec, as before", async () => {
    const g = guest([{ out: "x\n", exit: 0 }]);
    await execDetached(g.machine, "brew install gh", { deadlineMs: 10_000, pollMs: 1 });
    const launch = launchCalls(g.calls);
    expect(launch).toHaveLength(1);
    expect(launch[0]!.cmd).toContain("printf %s 'YnJldyBpbnN0YWxsIGdo' | base64 -d");
    expect(solariBody(launch[0]!.cmd)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    expect(g.script()).toBe("brew install gh");
  });

  it("a 40 KB script goes up in pieces, every exec body under the cap, and decodes byte for byte", async () => {
    expect(Buffer.byteLength(BIG_SCRIPT)).toBeGreaterThan(40_000);
    const g = guest([{ out: "x\n", exit: 0 }]);
    const res = await execDetached(g.machine, BIG_SCRIPT, { deadlineMs: 10_000, pollMs: 1 });
    expect(res.exitCode).toBe(0);
    expect(g.script()).toBe(BIG_SCRIPT);
    const launch = launchCalls(g.calls);
    expect(launch.filter(c => c.cmd.includes("echo WSP_PIECE"))).toHaveLength(4);
    expect(launch.at(-1)!.cmd).toMatch(/cat '\/tmp\/wsp-run\/[0-9a-f]{12}\.sh'\.\{0\.\.3\} \| base64 -d > '\/tmp\/wsp-run\/[0-9a-f]{12}\.sh' \|\| exit 1\nrm -f '\/tmp\/wsp-run\/[0-9a-f]{12}\.sh'\.\{0\.\.3\}\n/);
    for (const c of g.calls) expect(solariBody(c.cmd), c.cmd.slice(0, 80)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    // The pieces are cut as large as the cap allows, so the count is the smallest that fits.
    for (const c of launch.slice(0, 3)) expect(solariBody(c.cmd)).toBeGreaterThan(EXEC_BODY_MAX - 1024);
  });

  it("a piece posted twice, as a retried exec is, lands once and the script still decodes whole", async () => {
    const g = guest([{ out: "x\n", exit: 0 }]);
    const retrying = {
      id: "m1",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        const first = await g.machine.exec(cmd, o);
        return cmd.includes("echo WSP_PIECE") ? g.machine.exec(cmd, o) : first;
      },
    } as unknown as Machine;
    await execDetached(retrying, BIG_SCRIPT, { deadlineMs: 10_000, pollMs: 1 });
    expect(g.calls.filter(c => c.cmd.includes("echo WSP_PIECE"))).toHaveLength(8);
    expect(g.script()).toBe(BIG_SCRIPT);
  });

  it("a piece that does not confirm fails the run before the launch", async () => {
    const machine = { id: "m9", exec: async () => ({ exitCode: 1, stdout: "", stderr: "bash: printf: write error: No space left on device" }) } as unknown as Machine;
    await expect(execDetached(machine, BIG_SCRIPT, { deadlineMs: 1_000, pollMs: 1 })).rejects.toThrow(/a piece did not land on m9.*No space left/);
  });

  it("a launch that does not confirm fails the run before any poll", async () => {
    const machine = { id: "m9", exec: async () => ({ exitCode: 1, stdout: "", stderr: "bash: base64: not found" }) } as unknown as Machine;
    await expect(execDetached(machine, "true", { deadlineMs: 1_000, pollMs: 1 })).rejects.toThrow(/launch failed on m9.*base64: not found/);
  });
});

/** A guest that only has a disk: every exec lands what it carries and answers the marker the caller asked for. */
function diskGuest(seed: Record<string, string> = {}) {
  const disk = guestDisk();
  for (const [path, text] of Object.entries(seed)) disk.files.set(path, text);
  const calls: string[] = [];
  const machine = {
    id: "m2",
    async exec(cmd: string): Promise<ExecResult> {
      calls.push(cmd);
      disk.apply(cmd);
      return { exitCode: 0, stdout: `${cmd.split("\n").at(-1)!.replace(/^echo /, "")}\n`, stderr: "" };
    },
  } as unknown as Machine;
  return { machine, calls, files: disk.files, marks: disk.marks };
}

/** The machine with every exec that carries `mark` run twice, as the backend does when the first answer is lost. */
function twice(machine: Machine, mark: string): Machine {
  return {
    id: machine.id,
    exec: async (cmd: string, o?: { timeoutMs?: number }) => {
      const first = await machine.exec(cmd, o);
      return cmd.includes(mark) ? machine.exec(cmd, o) : first;
    },
  } as unknown as Machine;
}

const BIG_INPUT = Array.from({ length: 200 }, (_, i) => `prompt line ${i} with a 'quote' and ünïcödé ${"z".repeat(60)}`).join("\n");

describe("putFiles", () => {
  it("an input file over the cap goes up in pieces beside a script that fits, and the last exec lands both around the caller's lines", async () => {
    expect(Buffer.byteLength(BIG_INPUT)).toBeGreaterThan(20_000);
    const g = diskGuest();
    const res = await putFiles(g.machine, [{ path: "/tmp/wsp-run/t1.sh", text: "claude -p" }, { path: "/tmp/wsp-run/t1.in", text: BIG_INPUT }], { before: ["mkdir /tmp/wsp-run/t1.d || exit 0"], after: ["mkfifo /tmp/wsp-run/t1.fifo", "echo WSP_LAUNCHED"] });
    expect(res.stdout).toBe("WSP_LAUNCHED\n");
    expect(g.calls.filter(c => c.endsWith("echo WSP_PIECE"))).toHaveLength(2);
    for (const c of g.calls) expect(solariBody(c), c.slice(0, 80)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    expect(g.files.get("/tmp/wsp-run/t1.sh")).toBe("claude -p");
    expect(g.files.get("/tmp/wsp-run/t1.in")).toBe(BIG_INPUT);
    const last = g.calls.at(-1)!.split("\n");
    expect(last.slice(0, 3)).toEqual(["mkdir -p '/tmp/wsp-run'", "mkdir /tmp/wsp-run/t1.d || exit 0", "set -o pipefail"]);
    expect(last[3]).toBe("printf %s 'Y2xhdWRlIC1w' | base64 -d > '/tmp/wsp-run/t1.sh' || exit 1");
    expect(last.slice(4)).toEqual(["cat '/tmp/wsp-run/t1.in'.{0..1} | base64 -d > '/tmp/wsp-run/t1.in' || exit 1", "rm -f '/tmp/wsp-run/t1.in'.{0..1}", "mkfifo /tmp/wsp-run/t1.fifo", "echo WSP_LAUNCHED"]);
  });

  it("an append over the cap goes up in pieces and joins onto the end of what the file holds", async () => {
    const g = diskGuest({ "/tmp/wsp-run/t2.in": "first\n" });
    await putFiles(g.machine, [{ path: "/tmp/wsp-run/t2.in", text: `${BIG_INPUT}\n`, append: true }]);
    expect(g.calls.filter(c => c.endsWith("echo WSP_PIECE"))).toHaveLength(2);
    for (const c of g.calls) expect(solariBody(c)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    expect(g.calls.at(-1)).toMatch(/\n\[ -e '\/tmp\/wsp-run\/t2\.in\.a([0-9a-f]{12})' \] \|\| \{ cat '\/tmp\/wsp-run\/t2\.in'\.\{0\.\.1\} \| base64 -d >> '\/tmp\/wsp-run\/t2\.in' && : > '\/tmp\/wsp-run\/t2\.in\.a\1'; \} \|\| exit 1\nrm -f '\/tmp\/wsp-run\/t2\.in'\.\{0\.\.1\}$/);
    expect(g.files.get("/tmp/wsp-run/t2.in")).toBe(`first\n${BIG_INPUT}\n`);
  });

  it("an append that fits goes up in one exec, behind a marker of its own", async () => {
    const g = diskGuest({ "/tmp/wsp-run/t3.in": "first\n" });
    await putFiles(g.machine, [{ path: "/tmp/wsp-run/t3.in", text: "second\n", append: true }]);
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatch(/^mkdir -p '\/tmp\/wsp-run'\nset -o pipefail\n\[ -e '\/tmp\/wsp-run\/t3\.in\.a([0-9a-f]{12})' \] \|\| \{ printf %s 'c2Vjb25kCg==' \| base64 -d >> '\/tmp\/wsp-run\/t3\.in' && : > '\/tmp\/wsp-run\/t3\.in\.a\1'; \} \|\| exit 1$/);
    expect(g.files.get("/tmp/wsp-run/t3.in")).toBe("first\nsecond\n");
  });

  it("an append exec run twice, as a retried exec is, lands the line once", async () => {
    const g = diskGuest({ "/tmp/wsp-run/t5.in": "first\n" });
    const res = await putFiles(twice(g.machine, "base64 -d >>"), [{ path: "/tmp/wsp-run/t5.in", text: "steer\n", append: true }]);
    expect(res.exitCode).toBe(0);
    expect(g.calls).toHaveLength(2);
    expect(g.calls[0]).toBe(g.calls[1]);
    expect(g.files.get("/tmp/wsp-run/t5.in")).toBe("first\nsteer\n");
  });

  it("a piece-form append whose join runs twice lands one copy and answers 0 both times", async () => {
    const g = diskGuest({ "/tmp/wsp-run/t6.in": "first\n" });
    const res = await putFiles(twice(g.machine, "base64 -d >>"), [{ path: "/tmp/wsp-run/t6.in", text: `${BIG_INPUT}\n`, append: true }]);
    expect(res.exitCode).toBe(0);
    expect(g.calls.filter(c => c.includes("base64 -d >>"))).toHaveLength(2);
    expect(g.files.get("/tmp/wsp-run/t6.in")).toBe(`first\n${BIG_INPUT}\n`);
    expect([...g.marks]).toEqual([expect.stringMatching(/^\/tmp\/wsp-run\/t6\.in\.a[0-9a-f]{12}$/)]);
  });

  it("two appends carry two markers, so the second lands after the first", async () => {
    const g = diskGuest({ "/tmp/wsp-run/t7.in": "first\n" });
    await putFiles(g.machine, [{ path: "/tmp/wsp-run/t7.in", text: "second\n", append: true }]);
    await putFiles(g.machine, [{ path: "/tmp/wsp-run/t7.in", text: "third\n", append: true }]);
    expect(g.marks.size).toBe(2);
    expect(g.files.get("/tmp/wsp-run/t7.in")).toBe("first\nsecond\nthird\n");
  });

  it("a piece that does not confirm fails before the last exec goes", async () => {
    const calls: string[] = [];
    const machine = { id: "m9", exec: async (cmd: string) => { calls.push(cmd); return { exitCode: 0, stdout: "", stderr: "" }; } } as unknown as Machine;
    await expect(putFiles(machine, [{ path: "/tmp/wsp-run/t4.in", text: BIG_INPUT }])).rejects.toThrow(/a piece did not land on m9 \(exit 0\)/);
    expect(calls).toHaveLength(1);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** This machine's bash as the guest; setsid is perl's setpgrp where the OS has none and base64 loses -w0. */
function localGuest(): { machine: Machine; runDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-detached-"));
  dirs.push(dir);
  const shimDir = join(dir, "shims");
  mkdirSync(shimDir);
  if (!existsSync("/proc/1/stat")) {
    const shims = {
      setsid: "#!/bin/sh\nexec perl -e 'setpgrp(0, 0); exec @ARGV or die $!' -- \"$@\"\n",
      base64: '#!/bin/sh\nargs=""\nfor a in "$@"; do [ "$a" = "-w0" ] || args="$args $a"; done\nexec /usr/bin/base64 $args\n',
    };
    for (const [name, body] of Object.entries(shims)) {
      writeFileSync(join(shimDir, name), body);
      chmodSync(join(shimDir, name), 0o755);
    }
  }
  const machine = {
    id: "local",
    exec: (cmd: string) =>
      new Promise<ExecResult>(resolve => {
        execFile("bash", ["-c", cmd], { env: { ...process.env, PATH: `${shimDir}:${process.env["PATH"] ?? ""}` }, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
          resolve({ exitCode: e === null ? 0 : ((e as { code?: number }).code ?? 1), stdout, stderr });
        });
      }),
  } as unknown as Machine;
  return { machine, runDir: join(dir, "run") };
}

describe("execDetached over this machine's bash", () => {
  it("runs the real launch, poll and cleanup commands: exit code, both streams, and no files left", async () => {
    const { machine, runDir } = localGuest();
    const lines: string[] = [];
    const res = await execDetached(machine, "echo one; sleep 0.3; echo two; echo warn >&2; exit 3", { deadlineMs: 20_000, pollMs: 50, onLine: l => lines.push(l) }, runDir);
    expect(res).toEqual({ exitCode: 3, stdout: "one\ntwo\n", stderr: "warn\n" });
    // A poll reads stdout then stderr, so where warn lands among the lines is timing; each stream keeps its order.
    expect(lines.filter(l => l !== "warn")).toEqual(["one", "two"]);
    expect(lines).toContain("warn");
    const left = await machine.exec(`ls ${runDir}`);
    expect(left.stdout).toBe("");
  });

  it("a launch posted twice under one base, as a retried exec does, starts the script once", async () => {
    const { machine, runDir } = localGuest();
    const marks = join(runDir, "..", "marks");
    const retrying = {
      id: "local",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        const first = await machine.exec(cmd, o);
        return cmd.includes("echo WSP_LAUNCHED") ? machine.exec(cmd, o) : first;
      },
    } as unknown as Machine;
    const res = await execDetached(retrying, `echo ran >> ${marks}; echo hi`, { deadlineMs: 20_000, pollMs: 50 }, runDir);
    expect(res).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(readFileSync(marks, "utf8")).toBe("ran\n");
    expect((await machine.exec(`ls ${runDir}`)).stdout).toBe("");
  });

  it("a script over the cap runs for real from its pieces, each posted twice, and leaves no files", async () => {
    const { machine, runDir } = localGuest();
    const retrying = {
      id: "local",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        const first = await machine.exec(cmd, o);
        return cmd.includes("echo WSP_PIECE") ? machine.exec(cmd, o) : first;
      },
    } as unknown as Machine;
    const res = await execDetached(retrying, `${BIG_SCRIPT}\necho tail`, { deadlineMs: 20_000, pollMs: 50 }, runDir);
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
    expect(res.stdout.split("\n").slice(-3)).toEqual([`line 479 it's ünïcödé ${"y".repeat(50)}`, "tail", ""]);
    expect(res.stdout.split("\n")).toHaveLength(482);
    expect((await machine.exec(`ls ${runDir}`)).stdout).toBe("");
  });

  it("two files, one over the cap and appended, land byte for byte through the real commands and leave no pieces", async () => {
    const { machine, runDir } = localGuest();
    const first = await putFiles(machine, [{ path: `${runDir}/f.sh`, text: "echo hi\n" }, { path: `${runDir}/f.in`, text: "first\n" }], { after: ["echo WSP_LAUNCHED"] });
    expect(first.stdout).toBe("WSP_LAUNCHED\n");
    const second = await putFiles(machine, [{ path: `${runDir}/f.in`, text: `${BIG_INPUT}\n`, append: true }]);
    expect(second.exitCode).toBe(0);
    expect(readFileSync(`${runDir}/f.sh`, "utf8")).toBe("echo hi\n");
    expect(readFileSync(`${runDir}/f.in`, "utf8")).toBe(`first\n${BIG_INPUT}\n`);
    expect(readdirSync(runDir).sort()).toEqual(["f.in", expect.stringMatching(/^f\.in\.a[0-9a-f]{12}$/), "f.sh"]);
  });

  it("an append exec and a piece-form join, each run twice through the real shell, land their text once", async () => {
    const { machine, runDir } = localGuest();
    await putFiles(machine, [{ path: `${runDir}/g.in`, text: "first\n" }]);
    const retrying = twice(machine, "base64 -d >>");
    const small = await putFiles(retrying, [{ path: `${runDir}/g.in`, text: "steer\n", append: true }]);
    expect(small.exitCode).toBe(0);
    expect(readFileSync(`${runDir}/g.in`, "utf8")).toBe("first\nsteer\n");
    const big = await putFiles(retrying, [{ path: `${runDir}/g.in`, text: `${BIG_INPUT}\n`, append: true }]);
    expect(big.exitCode).toBe(0);
    expect(readFileSync(`${runDir}/g.in`, "utf8")).toBe(`first\nsteer\n${BIG_INPUT}\n`);
    expect(readdirSync(runDir).filter(f => !/^g\.in\.a[0-9a-f]{12}$/.test(f))).toEqual(["g.in"]);
    expect(readdirSync(runDir)).toHaveLength(3);
  });

  it("the deadline kill ends the launched session for real", async () => {
    const { machine, runDir } = localGuest();
    // The deadline counts from before the launch, so under load the kill can land before the script's first line: the launch answers once it is on disk.
    const started = () => existsSync(runDir) && readdirSync(runDir).some(f => f.endsWith(".out") && statSync(join(runDir, f)).size > 0);
    const settled = {
      id: "local",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        const res = await machine.exec(cmd, o);
        if (cmd.includes("echo WSP_LAUNCHED")) while (!started()) await new Promise(r => setTimeout(r, 20));
        return res;
      },
    } as unknown as Machine;
    const res = await execDetached(settled, "echo pid $$; sleep 30", { deadlineMs: 800, pollMs: 50 }, runDir);
    expect(res.exitCode).toBe(DEADLINE_EXIT);
    const pid = Number(/pid (\d+)/.exec(res.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 200));
    expect(await machine.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).toMatchObject({ stdout: "gone\n" });
    expect((await machine.exec(`ls ${runDir}`)).stdout).toBe("");
  }, 15_000);
});
