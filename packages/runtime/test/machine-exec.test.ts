import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXEC_ENV, INLINE_EXEC_MS, type ExecResult, type Machine } from "@wsp/engine";
import { EXEC_BODY_MAX, shellQuote } from "@wsp/protocol";
import { machineExecStream } from "../src/machine-exec.js";
import { stubBackend, type StubBackend, type StubMachine } from "./stub-backend.js";

interface Step {
  append?: Buffer | string;
  exit?: number;
  dead?: boolean;
}

/**
 * Emulates the guest side of the launch/poll/kill contract: a log file that
 * grows between polls, an exit file, and a leader process that can die.
 */
function scriptGuest(backend: StubBackend, steps: Step[]) {
  let log = Buffer.alloc(0);
  let exitFile = "";
  let alive = true;
  let child = false;
  let launch = "";
  let step = 0;
  const kills: string[] = [];
  const writes: string[] = [];
  const calls: string[] = [];
  const pieces = new Map<string, string>();
  /** What is on the guest now; the reap empties it. */
  const disk = new Map<string, string>();
  /** What every exec wrote, kept after the reap so a test can read the script it ran. */
  const landed = new Map<string, string>();
  const at = (suffix: string): string => [...landed].find(([path]) => path.endsWith(suffix))?.[1] ?? "";
  /** Lands every file the exec writes, inline or joined from pieces, replaced or appended. */
  const land = (cmd: string): void => {
    for (const m of cmd.matchAll(/(?:printf %s '([A-Za-z0-9+/=]*)'|cat '([^']*)'\.\{0\.\.(\d+)\}) \| base64 -d (>>?) '([^']*)'/g)) {
      const b64 = m[1] ?? Array.from({ length: Number(m[3]) + 1 }, (_, i) => pieces.get(`${m[2]}.${i}`) ?? "").join("");
      const text = (m[4] === ">>" ? at(m[5]!) : "") + Buffer.from(b64, "base64").toString("utf8");
      disk.set(m[5]!, text);
      landed.set(m[5]!, text);
    }
  };

  backend.execImpl = async (_m, cmd): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd.endsWith("echo WSP_PIECE")) {
      const m = /printf %s '([A-Za-z0-9+/=]*)' > '([^']*)'\.(\d+) \|\| exit 1\n/.exec(cmd);
      if (m === null) throw new Error(`piece exec without a numbered file: ${cmd}`);
      pieces.set(`${m[2]}.${m[3]}`, m[1]!);
      return { exitCode: 0, stdout: "WSP_PIECE\n", stderr: "" };
    }
    if (cmd.includes("WSP_LAUNCHED")) {
      launch = cmd;
      land(cmd);
      child = true;
      return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    }
    if (cmd.includes("kill -KILL") || cmd.includes("kill -TERM")) {
      kills.push(cmd);
      // A signal to the group takes the leader and what it spawned; one to a pid takes that pid alone.
      if (cmd.includes("-- -$P")) child = false;
      if (!cmd.includes(".tail")) alive = false;
      const rm = /rm -rf ([^ ]+)\.\*/.exec(cmd);
      if (rm) for (const path of [...disk.keys()]) if (path.startsWith(`${rm[1]}.`)) disk.delete(path);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd.includes("echo WSP_OK")) {
      writes.push(cmd);
      if (exitFile !== "") return { exitCode: 0, stdout: "WSP_GONE\n", stderr: "" };
      land(cmd);
      return { exitCode: 0, stdout: "WSP_OK\n", stderr: "" };
    }
    const sentinel = cmd.match(/(__WSP_EOF_[a-z0-9]+__)/)?.[1];
    if (sentinel) {
      const s = steps[step];
      if (s) {
        step++;
        if (s.append !== undefined) log = Buffer.concat([log, Buffer.from(s.append)]);
        if (s.exit !== undefined) exitFile = String(s.exit);
        if (s.dead) alive = false;
      }
      const from = Number(cmd.match(/tail -c \+(\d+)/)?.[1] ?? "1") - 1;
      const chunk = log.subarray(from, from + 262144);
      return {
        exitCode: 0,
        stdout: `${chunk.toString("base64")}\n${sentinel} ${exitFile} ${alive ? "up" : "down"}\n`,
        stderr: "",
      };
    }
    throw new Error(`guest got unexpected command: ${cmd}`);
  };
  return {
    kills,
    writes,
    calls,
    getScript: () => at(".sh"),
    getLaunch: () => launch,
    getInput: () => at(".in"),
    exit: (code: number) => (exitFile = String(code)),
    childAlive: () => child,
    files: () => [...disk.keys()],
  };
}

/** The bytes the provider counts: its request with the backend's wrapper around the command. */
const solariBody = (cmd: string): number => Buffer.byteLength(JSON.stringify({ cmd: "bash", args: ["-c", `${EXEC_ENV}\n${cmd}`], timeoutMs: INLINE_EXEC_MS }));
/** Every exec before the first poll: the launch, with the pieces ahead of it when the script needs them. */
const launchCalls = (calls: readonly string[]): string[] => calls.slice(0, calls.findIndex(c => c.includes("__WSP_EOF_")));
/** Forty kilobytes of command, as a turn whose prompt rides the command line would be. */
const BIG_COMMAND = `claude -p ${shellQuote(Array.from({ length: 520 }, (_, i) => `line ${i} it's ünïcödé ${"y".repeat(50)}`).join("\n"))} </dev/null`;

async function makeMachine(): Promise<{ backend: StubBackend; machine: StubMachine }> {
  const backend = stubBackend();
  await backend.create({ kind: "sandbox" });
  return { backend, machine: backend.machines[0]! };
}

describe("machineExecStream", () => {
  it("launches detached, streams log lines across polls, and resolves the exit code", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [
      { append: '{"type":"system","subtype":"init"}\n{"type":"assist' },
      { append: 'ant"}\n' },
      { append: '{"type":"result"}\n', exit: 0 },
      {}, // drain poll: exit visible, no new bytes
    ]);
    const factory = machineExecStream(machine, { pollMs: 5 });
    const stream = factory("claude -p 'hi' </dev/null", { env: { CLAUDE_CONFIG_DIR: "/root/.claude-cfg" } });
    const lines: string[] = [];
    for await (const line of stream.lines) lines.push(line);
    expect(lines).toEqual(['{"type":"system","subtype":"init"}', '{"type":"assistant"}', '{"type":"result"}']);
    expect(await stream.exited).toBe(0);
    expect(guest.getScript()).toContain("export CLAUDE_CONFIG_DIR='/root/.claude-cfg'");
    expect(guest.getScript()).toContain("claude -p 'hi' </dev/null");
  });

  it("when the poll sees the exit code the run's process group gets TERM then KILL after the log tail is read, and its files go", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "almost" }, { append: " done\n", exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude -p 'hi' & sleep 300 &", { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(await stream.exited).toBe(0);
    expect(lines).toEqual(["almost done"]);
    expect(guest.childAlive()).toBe(false);
    expect(guest.files()).toEqual([]);
    expect(guest.kills).toHaveLength(1);
    const reap = guest.kills[0]!;
    expect(reap).toMatch(/^P=\$\(cat \/tmp\/wsp-run\/[a-f0-9]{12}\.pid 2>\/dev\/null\); /);
    expect(reap.indexOf("kill -TERM -- -$P")).toBeGreaterThan(-1);
    expect(reap.indexOf("kill -TERM -- -$P")).toBeLessThan(reap.indexOf("kill -KILL -- -$P"));
    expect(reap.indexOf("kill -KILL -- -$P")).toBeLessThan(reap.indexOf("rm -rf /tmp/wsp-run/"));
    expect(reap).toMatch(/rm -rf \/tmp\/wsp-run\/[a-f0-9]{12}\.\*; true$/);
    const polls = guest.calls.filter(c => c.includes("__WSP_EOF_"));
    expect(guest.calls.indexOf(reap)).toBeGreaterThan(guest.calls.indexOf(polls.at(-1)!));
  });

  it("a leader that died without an exit file still gets its group reaped and its files removed", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "partial output\n" }, { dead: true }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude -p 'hi'", { env: {} });
    for await (const _ of stream.lines) void _;
    expect(await stream.exited).toBeNull();
    expect(guest.childAlive()).toBe(false);
    expect(guest.files()).toEqual([]);
  });

  it("a command that fits one exec body launches in one exec, under the cap", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "hi\n", exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude -p 'hi' </dev/null", { env: { CLAUDE_CONFIG_DIR: "/root/.claude-cfg" } });
    for await (const _ of stream.lines) void _;
    expect(await stream.exited).toBe(0);
    const launch = launchCalls(guest.calls);
    expect(launch).toHaveLength(1);
    expect(launch[0]).toMatch(/^mkdir -p '\/tmp\/wsp-run'\nmkdir \/tmp\/wsp-run\/[0-9a-f]{12}\.d 2>\/dev\/null \|\| \{ echo WSP_LAUNCHED; exit 0; \}\nset -o pipefail\nprintf %s '[A-Za-z0-9+/=]+' \| base64 -d > '\/tmp\/wsp-run\/[0-9a-f]{12}\.sh' \|\| exit 1\nsetsid bash /);
    expect(solariBody(launch[0]!)).toBeLessThanOrEqual(EXEC_BODY_MAX);
  });

  it("a 40 KB command goes up in pieces, every exec body under the cap, and the script decodes byte for byte", async () => {
    expect(Buffer.byteLength(BIG_COMMAND)).toBeGreaterThan(40_000);
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "hi\n", exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })(BIG_COMMAND, { env: { CLAUDE_CONFIG_DIR: "/root/.claude-cfg" } });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(lines).toEqual(["hi"]);
    expect(await stream.exited).toBe(0);
    for (const c of guest.calls) expect(solariBody(c), c.slice(0, 80)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    const launch = launchCalls(guest.calls);
    expect(launch.filter(c => c.endsWith("echo WSP_PIECE"))).toHaveLength(4);
    expect(launch).toHaveLength(5);
    expect(guest.getScript()).toBe(`export CLAUDE_CONFIG_DIR='/root/.claude-cfg'\n${BIG_COMMAND}\necho $? > ${launch.at(-1)!.match(/> '([^']*)\.sh'/)![1]}.exit\n`);
  });

  it("reassembles multi-byte characters split across poll boundaries", async () => {
    const { backend, machine } = await makeMachine();
    const line = Buffer.from("café ☕ done\n", "utf8");
    const guest = scriptGuest(backend, [
      { append: line.subarray(0, 4) }, // splits the é
      { append: line.subarray(4), exit: 0 },
      {},
    ]);
    void guest;
    const factory = machineExecStream(machine, { pollMs: 5 });
    const stream = factory("echo done", { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(lines).toEqual(["café ☕ done"]);
  });

  it("ends with exit null when the process dies without writing an exit file", async () => {
    const { backend, machine } = await makeMachine();
    scriptGuest(backend, [{ append: "partial output\n" }, { dead: true }, {}]);
    const factory = machineExecStream(machine, { pollMs: 5 });
    const stream = factory("claude -p 'hi'", { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(lines).toEqual(["partial output"]);
    expect(await stream.exited).toBeNull();
  });

  it("waits one more poll when the leader is gone before its exit file is there", async () => {
    const { backend, machine } = await makeMachine();
    scriptGuest(backend, [{ append: "almost\n" }, { dead: true }, { append: "done\n", exit: 0 }, {}]);
    const factory = machineExecStream(machine, { pollMs: 5 });
    const stream = factory("claude -p 'hi'", { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(lines).toEqual(["almost", "done"]);
    expect(await stream.exited).toBe(0);
  });

  it("kill() SIGKILLs the process group and unblocks exited", async () => {
    const { backend, machine } = await makeMachine();
    // never exits on its own: every poll just says "up" with no new output
    const guest = scriptGuest(backend, []);
    const factory = machineExecStream(machine, { pollMs: 5 });
    const stream = factory("sleep 9999", { env: {} });
    setTimeout(() => stream.kill(), 25);
    for await (const _ of stream.lines) void _;
    expect(await stream.exited).toBeNull();
    expect(guest.kills.some(k => k.includes("kill -KILL"))).toBe(true);
    expect(guest.childAlive()).toBe(false);
    expect(guest.files()).toEqual([]);
  });

  it("without an input channel the command runs as before: no input file, no tail, and write rejects", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "hi\n", exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("echo hi", { env: {} });
    await expect(stream.write("x")).rejects.toThrow(/channel/);
    for await (const _ of stream.lines) void _;
    expect(guest.getScript()).not.toContain("tail");
    expect(guest.getLaunch()).not.toContain(".in");
    expect(guest.writes).toEqual([]);
  });

  it("with an input channel the launch seeds the file and the script feeds it to the command through a tail whose pid it records and kills when the command ends", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: '{"type":"result"}\n', exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5, runDir: "/tmp/r" })("cd ~ && claude -p --input-format stream-json", { env: {}, input: ['{"type":"user","text":"go"}'] });
    for await (const _ of stream.lines) void _;
    expect(await stream.exited).toBe(0);
    expect(guest.getInput()).toBe('{"type":"user","text":"go"}\n');
    const base = guest.getLaunch().match(/mkfifo (\/tmp\/r\/[a-f0-9]+)\.fifo/)?.[1];
    expect(base).toBeDefined();
    const script = guest.getScript();
    expect(script).toContain(`( tail -n +1 -f ${base}.in > ${base}.fifo & echo $! > ${base}.tail )`);
    expect(script).toContain(`} < ${base}.fifo`);
    expect(script).toContain("cd ~ && claude -p --input-format stream-json");
    expect(script.indexOf(`echo $? > ${base}.exit`)).toBeLessThan(script.indexOf(`kill $(cat ${base}.tail)`));
  });

  it("a seeded prompt over the cap goes up in pieces ahead of the launch, every exec body under the cap, and the input file decodes byte for byte", async () => {
    const prompt = `{"type":"user","text":${JSON.stringify(Array.from({ length: 520 }, (_, i) => `line ${i} it's ünïcödé ${"y".repeat(50)}`).join("\n"))}}`;
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(40_000);
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: '{"type":"result"}\n', exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude -p --input-format stream-json", { env: {}, input: [prompt] });
    for await (const _ of stream.lines) void _;
    expect(await stream.exited).toBe(0);
    for (const c of guest.calls) expect(solariBody(c), c.slice(0, 80)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    const launch = launchCalls(guest.calls);
    expect(launch.filter(c => c.endsWith("echo WSP_PIECE"))).toHaveLength(4);
    expect(launch).toHaveLength(5);
    expect(launch.at(-1)).toMatch(/mkdir \/tmp\/wsp-run\/[a-f0-9]+\.d 2>\/dev\/null \|\| \{ echo WSP_LAUNCHED; exit 0; \}\nset -o pipefail\n.*\nmkfifo \/tmp\/wsp-run\/[a-f0-9]+\.fifo\nsetsid bash /s);
    expect(guest.getInput()).toBe(`${prompt}\n`);
    expect(guest.getScript()).toContain("claude -p --input-format stream-json");
  });

  it("write appends one base64-decoded line to the input file with one exec; a write after the stream ended rejects", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{}, {}, {}, { exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude", { env: {}, input: ["first"] });
    expect(await stream.write('{"type":"user","text":"don\'t stop"}')).toBe("written");
    expect(guest.writes).toHaveLength(1);
    expect(guest.writes[0]).toMatch(/\| base64 -d >> '\/tmp\/wsp-run\/[a-f0-9]+\.in'/);
    expect(guest.getInput()).toBe('first\n{"type":"user","text":"don\'t stop"}\n');
    for await (const _ of stream.lines) void _;
    await expect(stream.write("late")).rejects.toThrow(/ended/);
    expect(guest.writes).toHaveLength(1);
  });

  it("a write after the command exited but before the poll saw it answers gone with one exec, appends nothing and leaves the deadline alone", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{}, {}, {}, {}]);
    let now = 0;
    const stream = machineExecStream(machine, { pollMs: 200, deadlineMs: 1000, now: () => now })("claude", { env: {}, input: ["first"] });
    const first = stream.lines[Symbol.asyncIterator]().next();
    await new Promise(r => setTimeout(r, 20));
    guest.exit(0);
    now = 900;
    expect(await stream.write("late")).toBe("gone");
    expect(guest.writes).toHaveLength(1);
    expect(guest.writes[0]).toMatch(/^mkdir -p '\/tmp\/wsp-run'\n\{ \[ -e \/tmp\/wsp-run\/[a-f0-9]+\.exit \] \|\| \[ ! -d \/tmp\/wsp-run\/[a-f0-9]+\.d \]; \} && \{ echo WSP_GONE; exit 0; \}\nset -o pipefail\n\[ -e '\/tmp\/wsp-run\/[a-f0-9]+\.in\.a[0-9a-f]{12}' \] \|\| \{ printf %s '[A-Za-z0-9+/=]+' \| base64 -d >> '\/tmp\/wsp-run\/[a-f0-9]+\.in' && : > '[^']+'; \} \|\| exit 1\necho WSP_OK$/);
    expect(guest.getInput()).toBe("first\n");
    now = 1100;
    await expect(first).rejects.toThrow(/deadline/);
    expect(await stream.exited).toBeNull();
  });

  it("closeInput kills the recorded tail pid and nothing else, once", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{}, {}, { exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude", { env: {}, input: ["first"] });
    stream.closeInput();
    stream.closeInput();
    for await (const _ of stream.lines) void _;
    const before = guest.kills.filter(k => !k.includes("rm -rf"));
    expect(before).toHaveLength(1);
    expect(before[0]).toMatch(/P=\$\(cat \/tmp\/wsp-run\/[a-f0-9]+\.tail 2>\/dev\/null\); \[ -n "\$P" \] && kill -TERM "\$P"/);
    expect(before[0]).not.toContain("-- -");
    stream.closeInput();
    expect(guest.kills.filter(k => !k.includes("rm -rf"))).toHaveLength(1);
  });

  it("a write restarts the deadline; past it the stream ends with the error and the process group is killed", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, []);
    let now = 0;
    const stream = machineExecStream(machine, { pollMs: 1, deadlineMs: 1000, now: () => now })("claude", { env: {}, input: ["first"] });
    const it = stream.lines[Symbol.asyncIterator]();
    const first = it.next();
    now = 900;
    await stream.write("more");
    now = 1800;
    await new Promise(r => setTimeout(r, 20));
    expect(guest.kills).toEqual([]);
    now = 2000;
    await expect(first).rejects.toThrow(/deadline/);
    expect(await stream.exited).toBeNull();
    expect(guest.kills.some(k => k.includes("kill -KILL -- -$P"))).toBe(true);
    expect(guest.childAlive()).toBe(false);
    expect(guest.files()).toEqual([]);
  });

  it("tolerates exec failures mid-poll (a napping machine) and finishes after recovery", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "before nap\n" }, { append: "after wake\n", exit: 0 }, {}]);
    void guest;
    const inner = backend.execImpl;
    let failures = 3;
    backend.execImpl = async (m, cmd): Promise<ExecResult> => {
      if (cmd.includes("__WSP_EOF_") && failures > 0) {
        failures--;
        throw Object.assign(new Error("machine paused"), { kind: "conflict" });
      }
      return inner(m, cmd);
    };
    const factory = machineExecStream(machine, { pollMs: 5 });
    const stream = factory("long task", { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(lines).toEqual(["before nap", "after wake"]);
    expect(await stream.exited).toBe(0);
  });
});

const dirs: string[] = [];
const children: number[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // The test asserts the child is gone; this keeps a red run from leaving a sleep behind on the Mac.
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
});

/** This machine's bash as the guest; setsid is perl's setpgrp where the OS has none and base64 loses -w0. */
function localGuest(): { machine: Machine; runDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-machine-exec-"));
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

describe("machineExecStream over this machine's bash", () => {
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
    const stream = machineExecStream(retrying, { pollMs: 50, runDir })(`echo ran >> ${marks}; echo hi`, { env: { WSP_MARK: "x" } });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(await stream.exited).toBe(0);
    expect(lines).toEqual(["hi"]);
    expect(readFileSync(marks, "utf8")).toBe("ran\n");
  });
});

describe("machineExecStream reaping a real turn's process group", () => {
  it("a child the command left in the background is gone once the turn ended, and the run directory is empty", async () => {
    const { machine, runDir } = localGuest();
    const childFile = join(runDir, "..", "child");
    const stream = machineExecStream(machine, { pollMs: 20, runDir })(`sleep 300 & echo $! > ${shellQuote(childFile)}; echo hi`, { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(await stream.exited).toBe(0);
    expect(lines).toEqual(["hi"]);
    const childPid = Number(readFileSync(childFile, "utf8").trim());
    children.push(childPid);
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 5000 });
    expect(readdirSync(runDir)).toEqual([]);
  }, 15_000);
});

describe("machineExecStream feeding a real process over the input channel", () => {
  it("the seeded line and a later write reach the command's stdin in order, closeInput ends it, and the tail is gone after", async () => {
    const { machine, runDir } = localGuest();
    const stream = machineExecStream(machine, { pollMs: 20, runDir })("cat", { env: {}, input: ["hello"] });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const l of stream.lines) lines.push(l);
    })();
    const file = (suffix: string): string | undefined => readdirSync(runDir).find(f => f.endsWith(suffix));
    await vi.waitFor(() => expect(readFileSync(join(runDir, file(".tail")!), "utf8").trim()).not.toBe(""), { timeout: 5000 });
    const tailPid = Number(readFileSync(join(runDir, file(".tail")!), "utf8").trim());
    expect(tailPid).toBeGreaterThan(0);
    expect(await stream.write("world")).toBe("written");
    await vi.waitFor(() => expect(lines).toEqual(["hello", "world"]), { timeout: 5000 });
    stream.closeInput();
    await reading;
    expect(lines).toEqual(["hello", "world"]);
    expect(await stream.exited).toBe(0);
    await vi.waitFor(() => expect(() => process.kill(tailPid, 0)).toThrow(), { timeout: 5000 });
  }, 15_000);

  it("a write after the command exited answers gone and the input file keeps only what the process could read", async () => {
    const { machine, runDir } = localGuest();
    let holdPolls = false;
    const held: (() => void)[] = [];
    const gated = {
      id: "local",
      exec: async (cmd: string, o?: { timeoutMs?: number }) => {
        if (holdPolls && cmd.includes("__WSP_EOF_")) await new Promise<void>(r => held.push(r));
        return machine.exec(cmd, o);
      },
    } as unknown as Machine;
    const stream = machineExecStream(gated, { pollMs: 20, runDir })("cat", { env: {}, input: ["hello"] });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const l of stream.lines) lines.push(l);
    })();
    const file = (suffix: string): string | undefined => readdirSync(runDir).find(f => f.endsWith(suffix));
    await vi.waitFor(() => expect(readFileSync(join(runDir, file(".tail")!), "utf8").trim()).not.toBe(""), { timeout: 5000 });
    holdPolls = true;
    stream.closeInput();
    await vi.waitFor(() => expect(file(".exit")).toBeDefined(), { timeout: 5000 });
    expect(await stream.write("late")).toBe("gone");
    expect(readFileSync(join(runDir, file(".in")!), "utf8")).toBe("hello\n");
    holdPolls = false;
    for (const release of held.splice(0)) release();
    await reading;
    expect(lines).toEqual(["hello"]);
    expect(await stream.exited).toBe(0);
    expect(readdirSync(runDir)).toEqual([]);
  }, 15_000);
});

describe("machineExecStream polling a script that ends at once", () => {
  // Twenty rounds of three to five real bash execs each: 3 s on an idle Mac, 24 s seen at load average 330.
  it("keeps the last line and the exit code when the poll lands as the script ends", async () => {
    const { machine, runDir } = localGuest();
    const results: { lines: string[]; exited: number | null }[] = [];
    for (let i = 0; i < 20; i++) {
      const stream = machineExecStream(machine, { pollMs: 1, runDir })("echo hi", { env: {} });
      const lines: string[] = [];
      for await (const l of stream.lines) lines.push(l);
      results.push({ lines, exited: await stream.exited });
    }
    expect(results).toEqual(Array.from({ length: 20 }, () => ({ lines: ["hi"], exited: 0 })));
  }, 60_000);
});
