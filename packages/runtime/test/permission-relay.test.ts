// SPDX-License-Identifier: AGPL-3.0-only
// A permission prompt a harness raises mid-turn, all the way through the
// runtime: into the transcript as its own row with the options a person picks,
// answered from the chat, denied by the runtime when nobody comes, cancelled
// with the turn on a stop, and the access a thread starts at on a machine the
// person keeps. The harness here is a fake that raises the prompt on command,
// so nothing on a machine is needed and the runtime's own bookkeeping is what
// is under test.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { PERMISSION_ALLOW, PERMISSION_DENY, PERMISSION_DENIED_LINE, permissionUnansweredLine, THIS_COMPUTER, type PermissionAsk, type PermissionOutcome, type SessionEvent } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime, type SessionHandle } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";

const SESSION = "22222222-2222-4222-8222-222222222222";

/** What a running fake turn lets the test do to it. */
interface Turn {
  /** Raises a prompt on the turn, as a CLI's control channel would. */
  raise: (ask?: Partial<PermissionAsk>) => void;
  /** What the adapter was asked to answer, in order: the option and the words a deny carries. */
  answers: { askId: string; optionId: string; outcome: PermissionOutcome; denyMessage: string }[];
  /** Ends the turn with a reply. */
  reply: () => void;
  interrupted: () => boolean;
}

const ASK: PermissionAsk = {
  askId: "ask_1",
  toolName: "Write",
  toolUseId: "toolu_1",
  input: '{"file_path":"/root/out.txt","content":"hi"}',
  detail: "out.txt",
  options: [
    { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
    { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
    { id: "mode:acceptEdits", label: "acceptEdits", effect: "mode", mode: "acceptEdits" },
  ],
};

/** An adapter whose turn raises whatever prompt the test tells it to and answers by handing the answer back, the way
 * the claude adapter's control channel does; the close event is the adapter's, as it is there. */
function askingAdapter(turns: Turn[]): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: ({ onEvent }) => {
      const open = new Map<string, PermissionAsk>();
      const answers: Turn["answers"] = [];
      let interrupted = false;
      let settle: (() => void) | undefined;
      const finished = new Promise<{ status: "completed" | "interrupted"; text?: string }>(resolve => {
        settle = () => {
          for (const askId of [...open.keys()]) {
            open.delete(askId);
            onEvent({ type: "permission.close", sessionId: SESSION, askId, outcome: "cancelled" });
          }
          const result = interrupted ? ({ status: "interrupted" } as const) : ({ status: "completed", text: "done" } as const);
          onEvent({ type: "turn.done", sessionId: SESSION, result });
          onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      onEvent({ type: "session.start", sessionId: SESSION, cwd: "/root" });
      turns.push({
        raise: overrides => {
          const ask = { ...ASK, ...overrides };
          open.set(ask.askId, ask);
          onEvent({ type: "permission.ask", sessionId: SESSION, ask });
        },
        answers,
        reply: () => settle?.(),
        interrupted: () => interrupted,
      });
      return {
        localId: SESSION,
        finished,
        interrupt: async () => {
          interrupted = true;
          settle?.();
        },
        answer: async (askId, o) => {
          const ask = open.get(askId);
          if (ask === undefined) return "gone";
          open.delete(askId);
          answers.push({ askId, ...o });
          onEvent({ type: "permission.close", sessionId: SESSION, askId, outcome: o.outcome, optionId: o.optionId });
          return "answered";
        },
      };
    },
  });
}

const prompts = (events: readonly SessionEvent[]) => events.filter(e => e.type === "session.permission");
const closes = (events: readonly SessionEvent[]) => events.filter(e => e.type === "session.permission.closed");

describe("a permission prompt relayed into the chat", () => {
  let root: string;
  let store: Store;
  let turns: Turn[];
  let localWiring: LocalWiring;
  let rt: Runtime;
  const WAIT_MS = 40;

  const runtime = (): Runtime => createRuntime({ backend: stubBackend(), store, adapters: { claude: askingAdapter(turns) }, local: localWiring, permissionWaitMs: WAIT_MS });

  /** A started turn on the one local workspace, with the fake turn it opened. */
  const started = async (): Promise<{ handle: SessionHandle; turn: Turn; workspaceId: string }> => {
    const ws = await rt.workspaces.createLocal("mac");
    const handle = await rt.sessions.start(ws.id, { prompt: "write it" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    return { handle, turn: turns[0]!, workspaceId: ws.id };
  };

  const history = (workspaceId: string): Promise<SessionEvent[]> => rt.sessions.history(workspaceId);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-perm-"));
    store = memoryStore();
    turns = [];
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, ...o }),
      folder: root,
      home: () => join(root, ".claude"),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    };
    rt = runtime();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lands in the transcript as its own row, with the harness table's words for a mode option and the wait it gets", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    const row = prompts(await history(workspaceId))[0]!;
    expect(row).toMatchObject({
      type: "session.permission",
      workspaceId,
      askId: "ask_1",
      toolName: "Write",
      toolUseId: "toolu_1",
      detail: "out.txt",
      input: '{"file_path":"/root/out.txt","content":"hi"}',
      waitMs: WAIT_MS,
      turnId: handle.turnId,
    });
    // The adapter hands the CLI's own mode slug; the words for it live in the harness table, beside the picker's.
    expect(row.type === "session.permission" ? row.options : []).toEqual([
      { id: PERMISSION_ALLOW, label: "Allow", effect: "allow" },
      { id: PERMISSION_DENY, label: "Deny", effect: "deny" },
      { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode", mode: "acceptEdits" },
    ]);
    // Nothing closed it yet: the row is what the thread is waiting on.
    expect(closes(await history(workspaceId))).toHaveLength(0);
    turn.reply();
    await handle.finished;
  });

  it("an option picked in the chat reaches the harness and closes the row once", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));

    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW })).toEqual({ outcome: "answered" });
    expect(turn.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: PERMISSION_DENIED_LINE }]);
    expect(closes(await history(workspaceId))).toMatchObject([{ askId: "ask_1", outcome: "allowed", optionId: PERMISSION_ALLOW }]);

    // The prompt is closed: a second client picking on the same row answers nothing rather than a second time.
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_DENY })).toEqual({ outcome: "gone" });
    expect(turn.answers).toHaveLength(1);
    expect(closes(await history(workspaceId))).toHaveLength(1);
    turn.reply();
    await handle.finished;
  });

  it("a deny tells the agent the person refused, and a mode pick reads as an allow", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_DENY })).toEqual({ outcome: "answered" });
    expect(turn.answers[0]).toMatchObject({ outcome: "denied", denyMessage: PERMISSION_DENIED_LINE });

    turn.raise({ askId: "ask_2" });
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(2));
    expect(await rt.sessions.answer(handle.id, { askId: "ask_2", optionId: "mode:acceptEdits" })).toEqual({ outcome: "answered" });
    expect(turn.answers[1]).toMatchObject({ optionId: "mode:acceptEdits", outcome: "allowed" });
    turn.reply();
    await handle.finished;
  });

  it("nobody answering it denies it after the wait, in words that say so rather than blaming a person", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(closes(await history(workspaceId))).toHaveLength(1), { timeout: 5_000 });
    expect(turn.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_DENY, outcome: "unanswered", denyMessage: permissionUnansweredLine(WAIT_MS) }]);
    expect(closes(await history(workspaceId))).toMatchObject([{ askId: "ask_1", outcome: "unanswered", optionId: PERMISSION_DENY }]);
    // The turn is still running: the wait denies the call, it does not end the thread.
    expect(handle.view().status).toBe("running");
    turn.reply();
    await handle.finished;
  });

  it("a prompt answered in time is never denied by the wait afterwards", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW });
    await new Promise(resolve => setTimeout(resolve, WAIT_MS * 4));
    expect(turn.answers).toHaveLength(1);
    expect(closes(await history(workspaceId))).toHaveLength(1);
    turn.reply();
    await handle.finished;
  });

  it("a stop takes the open prompt with the turn: the row closes as cancelled and answering it afterwards answers nothing", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    expect(await rt.sessions.interrupt(handle.id)).toEqual({ outcome: "accepted" });
    expect(closes(await history(workspaceId))).toMatchObject([{ askId: "ask_1", outcome: "cancelled" }]);
    expect(closes(await history(workspaceId))[0]).not.toHaveProperty("optionId");
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW })).toEqual({ outcome: "gone" });
    expect(turn.answers).toHaveLength(0);
  });

  it("a turn the runtime cuts under an open prompt closes its row and stops its wait, so no row waits on an answer forever", async () => {
    // The cut roads (a nap, a machine gone, a zombie, a delete) all end the turn from this side rather than through
    // the harness, so this is the road the adapter's own close never travels.
    const cloud = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    const handle = await rt.sessions.start(cloud.id, { prompt: "write it" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0]!;
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(cloud.id))).toHaveLength(1));

    await rt.workspaces.nap(cloud.id);
    const cut = await history(cloud.id);
    expect(closes(cut)).toMatchObject([{ askId: "ask_1", outcome: "cancelled" }]);
    expect(closes(cut)[0]).not.toHaveProperty("optionId");
    // The row closes before the turn ends, so a transcript reads the prompt going with the turn, not after it.
    expect(cut.findIndex(e => e.type === "session.permission.closed")).toBeLessThan(cut.findIndex(e => e.type === "session.end"));
    // A paused workspace refuses the verb in its own words, as a send gets, and the closed row offers nothing anyway.
    await expect(rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW })).rejects.toThrow("Workspace is paused; wake it to send");

    // The wait went with it: nothing denies a prompt on a turn that is over, and no second row lands.
    await new Promise(resolve => setTimeout(resolve, WAIT_MS * 4));
    expect(turn.answers).toHaveLength(0);
    expect(closes(await history(cloud.id))).toHaveLength(1);
  });

  it("answers what it can rather than throwing: an unknown session, an unknown prompt, an option the prompt never carried", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    expect(await rt.sessions.answer("s_nope", { askId: "ask_1", optionId: PERMISSION_ALLOW })).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.answer(handle.id, { askId: "ask_9", optionId: PERMISSION_ALLOW })).toEqual({ outcome: "gone" });
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: "mode:bypassPermissions" })).toEqual({ outcome: "no-option" });
    expect(turn.answers).toHaveLength(0);
    turn.reply();
    await handle.finished;
  });
});

describe("the access a thread starts at", () => {
  let root: string;
  let store: Store;
  let localWiring: LocalWiring;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-access-"));
    store = memoryStore();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, ...o }),
      folder: root,
      home: () => join(root, ".claude"),
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A runtime whose turns record their picks and end at once, so a start's access is readable off the row. */
  const recording = (): { rt: Runtime; picks: (string | undefined)[] } => {
    const picks: (string | undefined)[] = [];
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      start: ({ onEvent, permissionMode }) => {
        picks.push(permissionMode);
        const result = { status: "completed", text: "ok" } as const;
        const finished = (async () => {
          onEvent({ type: "session.start", sessionId: SESSION });
          onEvent({ type: "turn.done", sessionId: SESSION, result });
          onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
          return result;
        })();
        return { localId: SESSION, finished, interrupt: async () => {} };
      },
    });
    return { rt: createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter }, local: localWiring }), picks };
  };

  it("on this computer the composer's access list marks the mode the harness asks in and names the machine on bypass", async () => {
    const { rt } = recording();
    const local = await rt.workspaces.createLocal("mac");
    const [claude] = await rt.harnesses.list(local.id);
    expect(claude!.keptMode).toBe("default");
    expect(claude!.permissionModes.find(o => o.isDefault)?.value).toBe("default");
    expect(claude!.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe(`Bypass on ${THIS_COMPUTER}`);
    // Bypass is still one pick away, in the same list.
    expect(claude!.permissionModes.map(o => o.value)).toContain("bypassPermissions");
  });

  it("a thread on this computer runs the asking mode, explicitly, and a send that names none keeps it", async () => {
    const { rt, picks } = recording();
    const local = await rt.workspaces.createLocal("mac");
    const first = await rt.sessions.start(local.id, { prompt: "one" });
    await first.finished;
    expect(picks).toEqual(["default"]);
    // The second turn resumes the thread and names no access; without the thread's own it would reach the adapter as
    // nothing, which every adapter here reads as its own skip-everything flag.
    await (await rt.sessions.start(local.id, { prompt: "two", thread: first.view().threadId })).finished;
    expect(picks).toEqual(["default", "default"]);
    // A pick still wins over the thread's own.
    await (await rt.sessions.start(local.id, { prompt: "three", thread: first.view().threadId, permissionMode: "plan" })).finished;
    expect(picks).toEqual(["default", "default", "plan"]);
  });

  it("a resumed thread whose rows fell off the index cap reads its access off its own start event, not off the adapter's default", async () => {
    const { rt, picks } = recording();
    const local = await rt.workspaces.createLocal("mac");
    const first = await rt.sessions.start(local.id, { prompt: "one" });
    await first.finished;
    expect(picks).toEqual(["default"]);
    // The start row carries the access, which is what survives the cap: the index keeps 200 rows per workspace and
    // drops the oldest finished ones, while the transcript keeps the thread.
    const start = (await rt.sessions.history(local.id)).find(e => e.type === "session.start");
    expect(start).toMatchObject({ permissionMode: "default" });
    const harnessSession = first.view().claudeSessionId!;
    await rt.close();

    // The state the cap leaves: the transcript holds the thread, the index holds no row of it. A send that names
    // the harness session, as `wsp send` and the MCP door do, is the road that still resumes it.
    const kept = (await store.get("transcripts", local.id)) as { events: unknown[] };
    await store.put("sessions", local.id, { workspaceId: local.id, sessions: [] });
    const after = recording();
    expect(((await store.get("transcripts", local.id)) as { events: unknown[] }).events).toHaveLength(kept.events.length);
    const resumed = await after.rt.sessions.start(local.id, { prompt: "two", resume: harnessSession });
    await resumed.finished;
    // Without the fallback this reached the adapter as nothing, which every adapter here reads as its own
    // skip-everything flag, on the person's own computer.
    expect(after.picks).toEqual(["default"]);
    await after.rt.close();
  });

  it("a throwaway machine's list and its threads are unchanged: bypass is the default and carries no machine's name", async () => {
    const { rt, picks } = recording();
    const cloud = await rt.workspaces.create({ golden: "snap_g", name: "b1" });
    const [claude] = await rt.harnesses.list(cloud.id);
    expect(claude!.permissionModes.find(o => o.isDefault)?.value).toBe("bypassPermissions");
    expect(claude!.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe("Bypass");
    await (await rt.sessions.start(cloud.id, { prompt: "one" })).finished;
    expect(picks).toEqual(["bypassPermissions"]);
  });
});
