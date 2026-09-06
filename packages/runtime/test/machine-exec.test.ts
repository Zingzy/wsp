import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  let script = "";
  let step = 0;
  const kills: string[] = [];
  const calls: string[] = [];
  const pieces = new Map<string, string>();

  backend.execImpl = async (_m, cmd): Promise<ExecResult> => {
    calls.push(cmd);
    if (cmd.endsWith("echo WSP_PIECE")) {
      const m = /printf %s '([A-Za-z0-9+/=]*)' > '([^']*)'\.(\d+) \|\| exit 1\n/.exec(cmd);
      if (m === null) throw new Error(`piece exec without a numbered file: ${cmd}`);
      pieces.set(`${m[2]}.${m[3]}`, m[1]!);
      return { exitCode: 0, stdout: "WSP_PIECE\n", stderr: "" };
    }
    if (cmd.includes("base64 -d")) {
      const joined = /cat '([^']*)'\.\{0\.\.(\d+)\} \| base64 -d/.exec(cmd);
      const b64 = joined === null ? (cmd.match(/printf %s '([A-Za-z0-9+/=]*)'/)?.[1] ?? "") : Array.from({ length: Number(joined[2]) + 1 }, (_, i) => pieces.get(`${joined[1]}.${i}`) ?? "").join("");
      script = Buffer.from(b64, "base64").toString("utf8");
      return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    }
    if (cmd.includes("kill -KILL") || cmd.includes("kill -TERM")) {
      kills.push(cmd);
      alive = false;
      return { exitCode: 0, stdout: "", stderr: "" };
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
  return { kills, calls, getScript: () => script };
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
