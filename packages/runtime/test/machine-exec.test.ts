import { describe, expect, it } from "vitest";
import type { ExecResult } from "@wsp/engine";
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

  backend.execImpl = async (_m, cmd): Promise<ExecResult> => {
    if (cmd.includes("base64 -d")) {
      const b64 = cmd.match(/printf '%s' '([A-Za-z0-9+/=]*)'/)?.[1] ?? "";
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
  return { kills, getScript: () => script };
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
