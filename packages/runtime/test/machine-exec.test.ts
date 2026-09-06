import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult, Machine } from "@wsp/engine";
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
  let script = "";
  let launch = "";
  let input = "";
  let step = 0;
  const kills: string[] = [];
  const writes: string[] = [];
  const decoded = (cmd: string): string[] => [...cmd.matchAll(/printf '%s' '([A-Za-z0-9+/=]*)' \| base64 -d/g)].map(m => Buffer.from(m[1]!, "base64").toString("utf8"));

  backend.execImpl = async (_m, cmd): Promise<ExecResult> => {
    if (cmd.includes("WSP_LAUNCHED")) {
      launch = cmd;
      [script = "", input = ""] = decoded(cmd);
      return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    }
    if (cmd.includes("kill -KILL") || cmd.includes("kill -TERM")) {
      kills.push(cmd);
      if (!cmd.includes(".tail")) alive = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd.includes(".in")) {
      writes.push(cmd);
      if (exitFile !== "") return { exitCode: 0, stdout: "WSP_GONE\n", stderr: "" };
      input += decoded(cmd)[0] ?? "";
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
  return { kills, writes, getScript: () => script, getLaunch: () => launch, getInput: () => input, exit: (code: number) => (exitFile = String(code)) };
}

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

  it("write appends one base64-decoded line to the input file with one exec; a write after the stream ended rejects", async () => {
    const { backend, machine } = await makeMachine();
    const guest = scriptGuest(backend, [{}, {}, {}, { exit: 0 }, {}]);
    const stream = machineExecStream(machine, { pollMs: 5 })("claude", { env: {}, input: ["first"] });
    expect(await stream.write('{"type":"user","text":"don\'t stop"}')).toBe("written");
    expect(guest.writes).toHaveLength(1);
    expect(guest.writes[0]).toMatch(/>> \/tmp\/wsp-run\/[a-f0-9]+\.in/);
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
    expect(guest.writes[0]).toMatch(/^\[ -e \/tmp\/wsp-run\/[a-f0-9]+\.exit \] && \{ echo WSP_GONE; exit 0; \}; printf/);
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
    expect(guest.kills).toHaveLength(1);
    expect(guest.kills[0]).toMatch(/P=\$\(cat \/tmp\/wsp-run\/[a-f0-9]+\.tail 2>\/dev\/null\); \[ -n "\$P" \] && kill -TERM "\$P"/);
    expect(guest.kills[0]).not.toContain("-- -");
    stream.closeInput();
    expect(guest.kills).toHaveLength(1);
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
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

describe("machineExecStream feeding a real process over the input channel", () => {
  it("the seeded line and a later write reach the command's stdin in order, closeInput ends it, and the tail is gone after", async () => {
    const { machine, runDir } = localGuest();
    const stream = machineExecStream(machine, { pollMs: 20, runDir })("cat", { env: {}, input: ["hello"] });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const l of stream.lines) lines.push(l);
    })();
    await new Promise(r => setTimeout(r, 200));
    await stream.write("world");
    await new Promise(r => setTimeout(r, 200));
    stream.closeInput();
    await reading;
    expect(lines).toEqual(["hello", "world"]);
    expect(await stream.exited).toBe(0);
    const tailFile = readdirSync(runDir).find(f => f.endsWith(".tail"))!;
    const tailPid = Number(readFileSync(join(runDir, tailFile), "utf8").trim());
    expect(tailPid).toBeGreaterThan(0);
    await new Promise(r => setTimeout(r, 100));
    expect(() => process.kill(tailPid, 0)).toThrow();
  }, 15_000);

  it("a write after the command exited answers gone and the input file keeps only what the process could read", async () => {
    const { machine, runDir } = localGuest();
    const stream = machineExecStream(machine, { pollMs: 1000, runDir })("cat", { env: {}, input: ["hello"] });
    const lines: string[] = [];
    const reading = (async () => {
      for await (const l of stream.lines) lines.push(l);
    })();
    const file = (suffix: string): string | undefined => readdirSync(runDir).find(f => f.endsWith(suffix));
    await vi.waitFor(() => expect(readFileSync(join(runDir, file(".tail")!), "utf8").trim()).not.toBe(""), { timeout: 5000 });
    stream.closeInput();
    await vi.waitFor(() => expect(file(".exit")).toBeDefined(), { timeout: 5000 });
    expect(await stream.write("late")).toBe("gone");
    await reading;
    expect(lines).toEqual(["hello"]);
    expect(await stream.exited).toBe(0);
    const inFile = readdirSync(runDir).find(f => f.endsWith(".in"))!;
    expect(readFileSync(join(runDir, inFile), "utf8")).toBe("hello\n");
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
