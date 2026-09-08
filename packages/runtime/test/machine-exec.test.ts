import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXEC_ENV, INLINE_EXEC_MS, MachineUnreached, type ExecResult, type Machine } from "@wsp/engine";
import { EXEC_BODY_MAX, machineUnreachedLine, TURN_IDLE_MS, shellQuote, workScoreLine } from "@wsp/protocol";
import type { ExecStream } from "@wsp/protocol";
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
  /** The claim directory the launch makes: what says the run is still on the guest, until the reap takes it. */
  let claimed = false;
  /** What the probe for the claim does instead of answering: throw, or answer something that is not an answer. */
  let probeFails: Error | undefined;
  let probeGarbles = false;
  let probes = 0;
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
      claimed = true;
      return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    }
    if (cmd.includes("WSP_RUN")) {
      probes++;
      if (probeFails !== undefined) throw probeFails;
      if (probeGarbles) return { exitCode: 1, stdout: "", stderr: "bash: line 1: unexpected" };
      return { exitCode: 0, stdout: claimed ? "WSP_RUN\n" : "WSP_GONE\n", stderr: "" };
    }
    if (cmd.includes("kill -KILL") || cmd.includes("kill -TERM")) {
      kills.push(cmd);
      // A signal to the group takes the leader and what it spawned; one to a pid takes that pid alone.
      if (cmd.includes("-- -$P")) child = false;
      if (!cmd.includes(".tail")) alive = false;
      const rm = /rm -rf ([^ ]+)\.\*/.exec(cmd);
      if (rm) {
        claimed = false;
        for (const path of [...disk.keys()]) if (path.startsWith(`${rm[1]}.`)) disk.delete(path);
      }
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
    /** The guest swept the run's files with no reader of its own around, as a reboot or a tmp sweep would. */
    sweep: () => (claimed = false),
    /** The machine stops answering the one question the attach asks, the way a gateway or a nap does. */
    refuseProbes: (e: Error) => (probeFails = e),
    /** The machine answers, but says neither that it holds the run nor that it does not. */
    garbleProbes: () => (probeGarbles = true),
    probes: () => probes,
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
    expect(guest.getScript()).toBe(`${workScoreLine()}\nexport CLAUDE_CONFIG_DIR='/root/.claude-cfg'\n${BIG_COMMAND}\necho $? > ${launch.at(-1)!.match(/> '([^']*)\.sh'/)![1]}.exit\n`);
  });

  it("the run script puts the turn's processes at the work score before anything else, so a build that outgrows the machine dies before the daemon", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "hi\n", exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude -p 'hi'", { env: { PATH: "/root/.local/bin:/usr/bin" } });
    for await (const _ of stream.lines) void _;
    expect(guest.getScript().split("\n").slice(0, 3)).toEqual([workScoreLine(), "export PATH='/root/.local/bin:/usr/bin'", "claude -p 'hi'"]);
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

  it("a write after the command exited but before the poll saw it answers gone with one exec, appends nothing and leaves the idle clock alone", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{}, {}, {}, {}]);
    let now = 0;
    const stream = machineExecStream(machine, { pollMs: 200, idleMs: 1000, now: () => now })("claude", { env: {}, input: ["first"] });
    const first = stream.lines[Symbol.asyncIterator]().next();
    await new Promise(r => setTimeout(r, 20));
    guest.exit(0);
    now = 900;
    expect(await stream.write("late")).toBe("gone");
    expect(guest.writes).toHaveLength(1);
    expect(guest.writes[0]).toMatch(/^mkdir -p '\/tmp\/wsp-run'\n\{ \[ -e \/tmp\/wsp-run\/[a-f0-9]+\.exit \] \|\| \[ ! -d \/tmp\/wsp-run\/[a-f0-9]+\.d \]; \} && \{ echo WSP_GONE; exit 0; \}\nset -o pipefail\n\[ -e '\/tmp\/wsp-run\/[a-f0-9]+\.in\.a[0-9a-f]{12}' \] \|\| \{ printf %s '[A-Za-z0-9+/=]+' \| base64 -d >> '\/tmp\/wsp-run\/[a-f0-9]+\.in' && : > '[^']+'; \} \|\| exit 1\necho WSP_OK$/);
    expect(guest.getInput()).toBe("first\n");
    now = 1100;
    await expect(first).rejects.toThrow(/^stopped after 0m 01s with no output for 0m$/);
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

  it("a write restarts the idle clock; past it the stream ends with the idle line and the process group is killed", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, []);
    let now = 0;
    const stream = machineExecStream(machine, { pollMs: 1, idleMs: 1000, now: () => now })("claude", { env: {}, input: ["first"] });
    const it = stream.lines[Symbol.asyncIterator]();
    const first = it.next();
    now = 900;
    await stream.write("more");
    now = 1800;
    await new Promise(r => setTimeout(r, 20));
    expect(guest.kills).toEqual([]);
    now = 2000;
    await expect(first).rejects.toThrow(/^stopped after 0m 02s with no output for 0m$/);
    expect(await stream.exited).toBeNull();
    expect(guest.kills.some(k => k.includes("kill -KILL -- -$P"))).toBe(true);
    expect(guest.childAlive()).toBe(false);
    expect(guest.files()).toEqual([]);
  });

  /** A guest whose clock moves one minute per poll and whose command prints one line a minute until `quietFromMs`. */
  function minuteGuest(backend: StubBackend, quietFromMs: number, exitAtMs = Number.POSITIVE_INFINITY) {
    const steps: Step[] = [];
    const guest = scriptGuest(backend, steps);
    const clock = { now: 0 };
    const inner = backend.execImpl;
    backend.execImpl = async (m, cmd): Promise<ExecResult> => {
      if (cmd.includes("__WSP_EOF_")) {
        clock.now += 60_000;
        if (clock.now < quietFromMs) steps.push({ append: `tick ${clock.now / 60_000}\n` });
        else if (clock.now >= exitAtMs) steps.push({ exit: 0 });
        else steps.push({});
      }
      return inner(m, cmd);
    };
    return { guest, clock };
  }

  it("a stream that prints a line every minute runs past the old 15 minute wall clock and ends on its own exit", async () => {
    const { backend, machine } = await makeMachine();
    const { guest, clock } = minuteGuest(backend, 21 * 60_000, 21 * 60_000);
    const stream = machineExecStream(machine, { pollMs: 1, now: () => clock.now })("claude", { env: {} });
    const seen: string[] = [];
    for await (const line of stream.lines) seen.push(line);
    expect(seen).toHaveLength(20);
    expect(seen.at(-1)).toBe("tick 20");
    expect(clock.now).toBeGreaterThan(900_000);
    expect(await stream.exited).toBe(0);
    expect(guest.files()).toEqual([]);
  });

  it("a stream that goes silent is cut once no byte came for the idle limit, and the error names the rule and the turn's run", async () => {
    const { backend, machine } = await makeMachine();
    const { guest, clock } = minuteGuest(backend, 6 * 60_000);
    const stream = machineExecStream(machine, { pollMs: 1, now: () => clock.now })("claude", { env: {} });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const line of stream.lines) seen.push(line);
      })(),
    ).rejects.toThrow(/^stopped after 15m 00s with no output for 10m$/);
    expect(seen).toHaveLength(5);
    expect(clock.now).toBe(5 * 60_000 + TURN_IDLE_MS);
    expect(await stream.exited).toBeNull();
    expect(guest.kills.some(k => k.includes("kill -KILL -- -$P"))).toBe(true);
    expect(guest.childAlive()).toBe(false);
    expect(guest.files()).toEqual([]);
  });

  it("a stream that never goes quiet is still cut at the wall cap, and the error names the cap", async () => {
    const { backend, machine } = await makeMachine();
    const { guest, clock } = minuteGuest(backend, Number.POSITIVE_INFINITY);
    const stream = machineExecStream(machine, { pollMs: 1, deadlineMs: 2 * 3_600_000, now: () => clock.now })("claude", { env: {} });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const line of stream.lines) seen.push(line);
      })(),
    ).rejects.toThrow(/^stopped after 2h 00m 00s at the 2h cap on one turn$/);
    expect(seen).toHaveLength(120);
    expect(await stream.exited).toBeNull();
    expect(guest.childAlive()).toBe(false);
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

  /** A guest whose launch fails `failures` times the way `make` says, each failed post costing five seconds of the
   * clock as a DNS lookup that times out does; the stream's sleeps move the same clock. */
  function unreachedGuest(backend: StubBackend, failures: number, make: () => Error, steps: Step[] = [{ append: "ran\n", exit: 0 }, {}]) {
    const guest = scriptGuest(backend, steps);
    const clock = { now: 0 };
    const waits: number[] = [];
    let launches = 0;
    const inner = backend.execImpl;
    backend.execImpl = async (m, cmd): Promise<ExecResult> => {
      if (cmd.includes("WSP_LAUNCHED")) {
        launches++;
        if (launches <= failures) {
          clock.now += 5_000;
          throw make();
        }
      }
      return inner(m, cmd);
    };
    const opts = {
      pollMs: 5,
      now: () => clock.now,
      sleep: async (ms: number): Promise<void> => {
        waits.push(ms);
        clock.now += ms;
      },
    };
    return { guest, opts, launches: () => launches, backoffs: () => waits.filter(w => w >= 1_000) };
  }
  const fetchFailed = (): Error => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN api.example"), { code: "EAI_AGAIN" }) });

  it("a launch nothing answered twice is posted again at the engine's backoff, and the turn runs", async () => {
    const { backend, machine } = await makeMachine();
    const g = unreachedGuest(backend, 2, fetchFailed);
    const stream = machineExecStream(machine, g.opts)("claude -p hi", { env: {} });
    const lines: string[] = [];
    for await (const l of stream.lines) lines.push(l);
    expect(lines).toEqual(["ran"]);
    expect(await stream.exited).toBe(0);
    expect(g.launches()).toBe(3);
    expect(g.backoffs().length).toBe(2);
    expect(g.backoffs()[0]).toBeGreaterThanOrEqual(1_000);
    expect(g.backoffs()[1]).toBeGreaterThanOrEqual(2_000);
  });

  it("a launch nothing answers for the whole reach window fails the turn in the protocol's words, not the fetch's, and reaps the run", async () => {
    const { backend, machine } = await makeMachine();
    const g = unreachedGuest(backend, 99, fetchFailed);
    const stream = machineExecStream(machine, g.opts)("claude -p hi", { env: {} });
    const failure = await (async (): Promise<Error> => {
      for await (const l of stream.lines) void l;
      throw new Error("the stream ended without a failure");
    })().catch((e: unknown) => e as Error);
    expect(failure).toBeInstanceOf(MachineUnreached);
    expect(failure.message).toBe(machineUnreachedLine(4, (failure as MachineUnreached).elapsedMs));
    expect(failure.message).toMatch(/^the machine could not be reached from this computer after 4 attempts over 2[78]s$/);
    expect(failure.message).not.toContain("fetch failed");
    expect(failure.message).not.toContain(machine.id);
    expect(g.launches()).toBe(4);
    expect(g.backoffs().length).toBe(3);
    expect(await stream.exited).toBeNull();
    expect(g.guest.kills.length).toBe(1);
    expect(g.guest.files()).toEqual([]);
  });

  it("a launch that failed for any reason but the network fails at once, in the machine's own words", async () => {
    const { backend, machine } = await makeMachine();
    const g = unreachedGuest(backend, 99, () => Object.assign(new Error("gone"), { kind: "missing", status: 404 }));
    const stream = machineExecStream(machine, g.opts)("claude -p hi", { env: {} });
    await expect(
      (async () => {
        for await (const l of stream.lines) void l;
      })(),
    ).rejects.toThrow(`remote launch failed on ${machine.id}: gone`);
    expect(g.launches()).toBe(1);
    expect(g.backoffs()).toEqual([]);
    expect(await stream.exited).toBeNull();
  });

  it("a gateway status the edge answered is not retried by the launch: the backend already retried it, and the turn keeps the provider's words", async () => {
    const { backend, machine } = await makeMachine();
    const g = unreachedGuest(backend, 99, () => Object.assign(new Error("Service Unavailable"), { kind: "transient", status: 503 }));
    const stream = machineExecStream(machine, g.opts)("claude -p hi", { env: {} });
    await expect(
      (async () => {
        for await (const l of stream.lines) void l;
      })(),
    ).rejects.toThrow(`remote launch failed on ${machine.id}: Service Unavailable`);
    expect(g.launches()).toBe(1);
    expect(g.backoffs()).toEqual([]);
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

describe("machineExecStream attaching to a run its process did not launch", () => {
  /** The run is claimed by the launch alone: nothing iterates the launched stream, as a host that went down under
   * its own reader did not. */
  const abandoned = async (steps: Parameters<typeof scriptGuest>[1]) => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, steps);
    const factory = machineExecStream(machine, { pollMs: 5 });
    const launched = factory("claude -p hi", { env: {}, input: ["go"] });
    await vi.waitFor(() => expect(guest.getLaunch()).not.toBe(""));
    return { factory, guest, run: launched.run! };
  };

  it("reads the run's whole log from its first byte and ends on the exit the run left", async () => {
    const { factory, run } = await abandoned([
      { append: '{"type":"system","subtype":"init"}\n{"type":"assistant"}\n' },
      { append: '{"type":"result"}\n', exit: 0 },
    ]);
    const stream = await factory.attach!(run, { input: true });
    expect(stream).not.toBe("gone");
    const lines: string[] = [];
    for await (const line of (stream as ExecStream).lines) lines.push(line);
    expect(lines).toEqual(['{"type":"system","subtype":"init"}', '{"type":"assistant"}', '{"type":"result"}']);
    expect(await (stream as ExecStream).exited).toBe(0);
  });

  it("takes a message into the run over the channel the launch left open", async () => {
    const { factory, guest, run } = await abandoned([{ append: "one\n" }, { append: "two\n", exit: 0 }]);
    const stream = (await factory.attach!(run, { input: true })) as ExecStream;
    expect(await stream.write('{"type":"user"}')).toBe("written");
    expect(guest.getInput()).toBe('go\n{"type":"user"}\n');
    for await (const line of stream.lines) void line;
    expect(await stream.exited).toBe(0);
  });

  it("a machine that answers and no longer holds the run says gone, with no reader and no poll of its own", async () => {
    const { factory, guest, run } = await abandoned([{ append: "never read\n", exit: 0 }]);
    guest.sweep();
    expect(await factory.attach!(run, { input: true })).toBe("gone");
    expect(guest.calls.filter(c => c.includes("__WSP_EOF_"))).toEqual([]);
  });

  it("a probe nothing answers leaves the run alone: no kill, no rm, and the reach window is what it waits out", async () => {
    const { factory, guest, run } = await abandoned([{ append: "still working\n" }]);
    guest.refuseProbes(new Error("gateway said 502"));
    const failure = await factory.attach!(run, { input: true }).then(
      () => new Error("the probe answered where it should have failed"),
      (e: unknown) => e as Error,
    );
    expect(failure.message).toBe("gateway said 502");
    // The turn this attach was sent to save is still running, and its log is still there to be read next time.
    expect(guest.kills).toEqual([]);
    expect(guest.childAlive()).toBe(true);
    expect(guest.files()).toContain(`${run}.sh`);
  });

  it("a probe whose road is out is asked again over the reach window before it gives up, and still leaves the run alone", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{ append: "still working\n" }]);
    let clock = 0;
    const factory = machineExecStream(machine, { pollMs: 5, now: () => clock, sleep: async ms => void (clock += ms) });
    const launched = factory("claude -p hi", { env: {}, input: ["go"] });
    await vi.waitFor(() => expect(guest.getLaunch()).not.toBe(""));
    guest.refuseProbes(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }));
    const failure = await factory.attach!(launched.run!, { input: true }).then(
      () => new Error("the probe answered where it should have failed"),
      (e: unknown) => e as Error,
    );
    expect(failure).toBeInstanceOf(MachineUnreached);
    expect(guest.probes()).toBeGreaterThan(1);
    expect(guest.kills).toEqual([]);
    expect(guest.childAlive()).toBe(true);
  });

  it("a machine that answers neither way is not a run to end", async () => {
    const { factory, guest, run } = await abandoned([{ append: "still working\n" }]);
    guest.garbleProbes();
    const failure = await factory.attach!(run, { input: true }).then(
      () => new Error("the probe answered where it should have failed"),
      (e: unknown) => e as Error,
    );
    expect(failure.message).toContain("did not answer whether it still holds");
    expect(guest.kills).toEqual([]);
    expect(guest.childAlive()).toBe(true);
  });

  it("a handle this host could not have launched is refused before any shell text goes out", async () => {
    const { factory, guest } = await abandoned([{ append: "still working\n" }]);
    const before = guest.calls.length;
    for (const bad of ["/tmp/wsp-run/../../etc/x", "/tmp/wsp-run/$(id)", "/etc/wsp-run/aabbccddeeff", "/tmp/wsp-run/nothex000000", "/tmp/wsp-run/aabbccddeef"]) {
      await expect(factory.attach!(bad, { input: true })).rejects.toThrow("is not a run this host could have launched");
    }
    expect(guest.calls.length).toBe(before);
  });
});

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

describe("machineExecStream sweeping the runs a connecting host does not hold", () => {
  it("ends every claimed run but the ones it is named, takes their files, and leaves a named run running", async () => {
    const { machine, runDir } = localGuest();
    const factory = machineExecStream(machine, { pollMs: 20, runDir });
    // Nothing iterates either stream, as a host that went down under its own reader did not.
    const held = factory("sleep 300", { env: {} });
    const orphan = factory("sleep 300", { env: {} });
    const leader = async (base: string): Promise<number> => {
      await vi.waitFor(() => expect(existsSync(`${base}.pid`)).toBe(true), { timeout: 5_000 });
      const pid = Number(readFileSync(`${base}.pid`, "utf8").trim());
      expect(pid).toBeGreaterThan(0);
      children.push(pid);
      return pid;
    };
    const heldPid = await leader(held.run!);
    const orphanPid = await leader(orphan.run!);
    const filesOf = (base: string): string[] => readdirSync(runDir).filter(name => name.startsWith(basename(base)));
    // A claim of a shape this factory could not have minted is the guest's, not a run of ours to end.
    mkdirSync(join(runDir, "notarun.d"));

    expect(await factory.sweep!([held.run!])).toEqual([orphan.run!]);

    await vi.waitFor(() => expect(() => process.kill(orphanPid, 0)).toThrow(), { timeout: 5_000 });
    expect(filesOf(orphan.run!)).toEqual([]);
    expect(() => process.kill(heldPid, 0)).not.toThrow();
    expect(filesOf(held.run!).length).toBeGreaterThan(0);

    // The same host, holding nothing: the run it was reading is a run nobody reads.
    expect(await factory.sweep!([])).toEqual([held.run!]);
    await vi.waitFor(() => expect(() => process.kill(heldPid, 0)).toThrow(), { timeout: 5_000 });
    expect(readdirSync(runDir)).toEqual(["notarun.d"]);
  }, 30_000);

  it("a machine holding two hundred stale runs is swept a page at a time, every page under the exec body cap", async () => {
    const stale = Array.from({ length: 200 }, (_, i) => `/tmp/wsp-run/${i.toString(16).padStart(12, "0")}`);
    const calls: string[] = [];
    const machine = {
      id: "crowded",
      exec: (cmd: string) => {
        calls.push(cmd);
        return Promise.resolve({ exitCode: 0, stdout: cmd.startsWith("for d in") ? `${stale.map(base => `${base}.d`).join("\n")}\n` : "", stderr: "" });
      },
    } as unknown as Machine;

    expect(await machineExecStream(machine).sweep!([])).toEqual(stale);

    const reaps = calls.slice(1);
    // Measured as the wire body the backend sends, the way every other call this file holds under the cap is.
    for (const cmd of calls) expect(solariBody(cmd), cmd.slice(0, 80)).toBeLessThanOrEqual(EXEC_BODY_MAX);
    expect(reaps.length).toBeGreaterThan(1);
    // Every run is reaped once across the pages, and no page carries a run twice.
    const reaped = stale.filter(base => reaps.filter(cmd => cmd.includes(`rm -rf ${base}.*`)).length === 1);
    expect(reaped).toEqual(stale);
  });

  it("a machine holding no run of this factory's is swept without a second word going out", async () => {
    const { machine, runDir } = localGuest();
    const calls: string[] = [];
    const counted = { id: "local", exec: (cmd: string, o?: { timeoutMs?: number }) => (calls.push(cmd), machine.exec(cmd, o)) } as unknown as Machine;
    expect(await machineExecStream(counted, { runDir }).sweep!([])).toEqual([]);
    expect(calls).toHaveLength(1);
  });
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
