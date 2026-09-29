// SPDX-License-Identifier: AGPL-3.0-only
// A workspace stops, whoever sends wakes it as the send verb does, and the
// thread comes back by its own session id at the access its last turn ran at.
// What these cases prove is the launch line: the adapters are the real ones and
// the exec is scripted, so the line each harness would run on the machine is
// read here word for word.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecStream, ExecStreamFactory } from "@wsp/protocol";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend, type StubBackend } from "./stub-backend.js";

const CLAUDE_SESSION = "e16ed170-8257-4668-879e-fe836341633c";
const CODEX_THREAD = "01a0e365-72f3-77e3-ba3a-3d18e12e9b95";

const fixture = (at: string): string[] =>
  readFileSync(new URL(at, import.meta.url), "utf8")
    .split("\n")
    .filter(line => line.trim() !== "");

/** An exec that records the line it was given, and the lines it was seeded with, and replays that harness's own output
 * at it. */
function scripted(lines: () => string[]): { factory: ExecStreamFactory; commands: string[]; seeds: (readonly string[] | undefined)[] } {
  const commands: string[] = [];
  const seeds: (readonly string[] | undefined)[] = [];
  const factory: ExecStreamFactory = (command, o) => {
    commands.push(command);
    seeds.push(o.input);
    let settle: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>(resolve => (settle = resolve));
    const stream: ExecStream = {
      lines: (async function* () {
        yield* lines();
        settle(0);
      })(),
      teardown: () => settle(0),
      kill: () => settle(null),
      write: async () => "written" as const,
      closeInput: () => {},
      exited,
    };
    return stream;
  };
  return { factory, commands, seeds };
}

/** The real adapter for that harness, launching through the scripted exec instead of the machine. */
const through = (id: "claude" | "codex", factory: ExecStreamFactory): HarnessAdapterFactory => ctx => HARNESS_ADAPTERS[id]!({ ...ctx, execStream: factory });

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

/** A workspace with a thread that ran once and whose machine is then stopped. */
async function stoppedAfterOneTurn(
  harness: "claude" | "codex",
  lines: string[],
): Promise<{ backend: StubBackend; commands: string[]; seeds: (readonly string[] | undefined)[]; workspaceId: string; threadId: string }> {
  const exec = scripted(() => lines);
  const backend = stubBackend();
  rt = createRuntime({ backend, store: memoryStore(), adapters: { [harness]: through(harness, exec.factory) } });
  const ws = await createOn(rt, { golden: "snap_g", name: "pricing page" });
  const opened = await rt.sessions.start(ws.id, { prompt: "start the dev server", harness });
  await opened.finished;
  const threadId = opened.view().threadId!;
  await rt.workspaces.nap(ws.id);
  expect(backend.machines[0]!.paused).toBe(true);
  return { backend, commands: exec.commands, seeds: exec.seeds, workspaceId: ws.id, threadId };
}

describe("a send after a stop", () => {
  it("launches claude on the woken machine with the thread's own session id and the access its last turn ran at", async () => {
    const { backend, commands, workspaceId, threadId } = await stoppedAfterOneTurn("claude", fixture("../../adapter-claude/test/fixtures/stream-session.jsonl"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/--session-id [0-9a-f-]{36}$/);
    expect(commands[0]).not.toContain("--resume");
    await rt!.workspaces.wake(workspaceId);
    const again = await rt!.sessions.start(workspaceId, { prompt: "what did you leave running", thread: threadId });
    await again.finished;
    expect(backend.machines[0]!.paused).toBe(false);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain(`--resume ${CLAUDE_SESSION}`);
    expect(commands[1]).not.toContain("--session-id");
    // The access rides the resume: a turn that came back asking about each action would stop on the first one.
    expect(commands[1]).toContain("--dangerously-skip-permissions");
  });

  it("carries the access the thread's last turn ran at, not the kind's default", async () => {
    const exec = scripted(() => fixture("../../adapter-claude/test/fixtures/stream-session.jsonl"));
    const backend = stubBackend();
    rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: through("claude", exec.factory) } });
    const ws = await createOn(rt, { golden: "snap_g", name: "careful" });
    const opened = await rt.sessions.start(ws.id, { prompt: "go", harness: "claude", permissionMode: "acceptEdits" });
    await opened.finished;
    await rt.workspaces.nap(ws.id);
    await rt.workspaces.wake(ws.id);
    const again = await rt.sessions.start(ws.id, { prompt: "more", thread: opened.view().threadId! });
    await again.finished;
    expect(exec.commands[1]).toContain(`--resume ${CLAUDE_SESSION}`);
    expect(exec.commands[1]).toContain("--permission-mode 'acceptEdits'");
    expect(exec.commands[1]).not.toContain("--dangerously-skip-permissions");
  });

  it("resumes codex on the thread it started, at the access that asks nobody", async () => {
    const { backend, commands, seeds, workspaceId, threadId } = await stoppedAfterOneTurn("codex", fixture("../../adapter-codex/test/fixtures/app-server-turn.jsonl"));
    expect(commands).toHaveLength(1);
    // The server line carries the thread's own wsp server, which takes the place of any the person's config names.
    expect(commands[0]).toMatch(/ && codex app-server -c tools.update_plan.enabled='true' -c mcp_servers\.wsp\.command=/);
    const threadLine = (at: number) => JSON.parse(seeds[at]!.at(-1)!) as { method: string; params: Record<string, unknown> };
    expect(threadLine(0).method).toBe("thread/start");
    await rt!.workspaces.wake(workspaceId);
    const again = await rt!.sessions.start(workspaceId, { prompt: "what did you leave running", thread: threadId });
    await again.finished;
    expect(backend.machines[0]!.paused).toBe(false);
    expect(commands).toHaveLength(2);
    expect(threadLine(1)).toMatchObject({ method: "thread/resume", params: { threadId: CODEX_THREAD, sandbox: "danger-full-access", approvalPolicy: "never" } });
  });
});
