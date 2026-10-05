// SPDX-License-Identifier: AGPL-3.0-only
// A permission prompt a harness raises mid-turn, all the way through the
// runtime: into the transcript as its own row with the options a person picks,
// answered from the chat, standing on the thread's row for as long as nobody
// answers, cancelled with the turn on a stop, the access a thread starts at on a machine the
// person keeps, and an access picked while a turn runs. The harness here is a
// fake that raises the prompt on command, so nothing on a machine is needed
// and the runtime's own bookkeeping is what is under test.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, PERMISSION_ALLOW, PERMISSION_DENY, PERMISSION_DENIED_LINE, QUESTION_TOOL, deniedLine, otherOptionId, pickedOptionId, questionOptions, askingLine, threadWord, threadWordOf, foldThreads, type PermissionAsk, type PermissionOutcome, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime, type SessionHandle } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, copyingFake, createOn, projectOn, testPlatform } from "./stub-backend.js";

const SESSION = "22222222-2222-4222-8222-222222222222";

/** What a running fake turn lets the test do to it. */
interface Turn {
  /** Raises a prompt on the turn, as a CLI's control channel would. */
  raise: (ask?: Partial<PermissionAsk>) => void;
  /** What the adapter was asked to answer, in order: the option and the words a deny carries. */
  answers: { askId: string; optionId: string; outcome: PermissionOutcome; denyMessage: string; reason?: string }[];
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

/** A harness that dies before it announces a session: the launch that leaves a thread no turn ever ran on, which is
 * the one shape sessions.forget takes. */
const dying: HarnessAdapterFactory = () => ({
  steers: false,
  start: o => {
    const localId = randomUUID();
    const result: TurnResult = { status: "failed", error: "the harness exited with code 1 before emitting a result" };
    const finished = Promise.resolve().then(() => {
      o.onEvent({ type: "turn.done", sessionId: localId, result });
      o.onEvent({ type: "session.end", sessionId: localId, exitCode: 1, sawResult: false });
      return result;
    });
    return { localId, finished, interrupt: async () => {} };
  },
});

/** An adapter whose turn raises whatever prompt the test tells it to and answers by handing the answer back, the way
 * the claude adapter's control channel does; the close event is the adapter's, as it is there. */
function askingAdapter(turns: Turn[]): HarnessAdapterFactory {
  return () => ({
    steers: false,
    start: ({ onEvent, resume }) => {
      const session = resume ?? randomUUID();
      const open = new Map<string, PermissionAsk>();
      const answers: Turn["answers"] = [];
      let interrupted = false;
      let settle: (() => void) | undefined;
      const finished = new Promise<{ status: "completed" | "interrupted"; text?: string }>(resolve => {
        settle = () => {
          for (const askId of [...open.keys()]) {
            open.delete(askId);
            onEvent({ type: "permission.close", sessionId: session, askId, outcome: "cancelled" });
          }
          const result = interrupted ? ({ status: "interrupted" } as const) : ({ status: "completed", text: "done" } as const);
          onEvent({ type: "turn.done", sessionId: session, result });
          onEvent({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
          resolve(result);
        };
      });
      onEvent({ type: "session.start", sessionId: session, cwd: "/root" });
      turns.push({
        raise: overrides => {
          const ask = { ...ASK, ...overrides };
          open.set(ask.askId, ask);
          onEvent({ type: "permission.ask", sessionId: session, ask });
        },
        answers,
        reply: () => settle?.(),
        interrupted: () => interrupted,
      });
      return {
        localId: session,
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
          onEvent({ type: "permission.close", sessionId: session, askId, outcome: o.outcome, optionId: o.optionId });
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
  let wait: ReturnType<typeof fakeClock>;

  const runtime = (extra: Record<string, HarnessAdapterFactory> = {}): Runtime =>
    createRuntime({ backend: stubBackend(), store, adapters: { claude: askingAdapter(turns), ...extra }, local: localWiring, clock: wait.clock });

  /** A started turn on the one local workspace, with the fake turn it opened. */
  const started = async (): Promise<{ handle: SessionHandle; turn: Turn; workspaceId: string }> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "write it" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    return { handle, turn: turns[0]!, workspaceId: ws.id };
  };

  const history = (workspaceId: string): Promise<SessionEvent[]> => rt.sessions.history(workspaceId);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-perm-"));
    store = memoryStore();
    turns = [];
    wait = fakeClock();
    localWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
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

  it("carries a subagent's prompt and a subagent's lines to the chat with the call that launched them", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise({ askId: "ask_child", parentToolUseId: "toolu_launch" });
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    const row = prompts(await history(workspaceId))[0]!;
    expect(row).toMatchObject({ askId: "ask_child", parentToolUseId: "toolu_launch" });
    turn.reply();
    await handle.finished;
  });

  it("a question's own choices reach the chat as the prompt's options, and a pick naming several is one answer", async () => {
    const { handle, turn, workspaceId } = await started();
    const input = JSON.stringify({
      questions: [{ question: "Which checks?", header: "Checks", options: [{ label: "Types" }, { label: "Lint" }], multiSelect: true }],
    });
    const options = questionOptions(QUESTION_TOOL, input);
    turn.raise({ askId: "ask_q", toolName: QUESTION_TOOL, input, options });
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    const row = prompts(await history(workspaceId))[0]!;
    // The words for a mode option are lent by the harness table; a question's own labels are lent nothing.
    expect(row.type === "session.permission" ? row.options : []).toEqual(options);

    const both = pickedOptionId(options.map(o => o.id));
    expect(await rt.sessions.answer(handle.id, { askId: "ask_q", optionId: both })).toEqual({ outcome: "answered" });
    // Several ticks are one pick, and it reaches the harness whole rather than being refused as no option.
    expect(turn.answers[0]).toMatchObject({ optionId: both, outcome: "allowed" });
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

  it("a deny with the person's reason tells the agent the reason, and an answer typed in Other reaches the harness", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_DENY, reason: "Run only the thread-rows file" })).toEqual({ outcome: "answered" });
    expect(turn.answers[0]).toMatchObject({ outcome: "denied", denyMessage: deniedLine("Run only the thread-rows file"), reason: "Run only the thread-rows file" });

    const input = JSON.stringify({ questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] });
    turn.raise({ askId: "ask_q", toolName: QUESTION_TOOL, input, options: questionOptions(QUESTION_TOOL, input) });
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(2));
    const typed = otherOptionId(0, "neither, C");
    expect(await rt.sessions.answer(handle.id, { askId: "ask_q", optionId: typed })).toEqual({ outcome: "answered" });
    expect(turn.answers[1]).toMatchObject({ optionId: typed, outcome: "allowed" });
    turn.reply();
    await handle.finished;
  });

  it("stands open for as long as the turn lives, well past the five minutes a person may be away for", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    wait.advance(20 * 60_000);
    await Promise.resolve();
    expect(closes(await history(workspaceId))).toHaveLength(0);
    expect(turn.answers).toEqual([]);
    expect(handle.view().status).toBe("running");
    // The person comes back to the question they were asked and answers it.
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW })).toEqual({ outcome: "answered" });
    expect(turn.answers).toEqual([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed", denyMessage: PERMISSION_DENIED_LINE }]);
    turn.reply();
    await handle.finished;
  });

  it("puts what it is asking on the thread's row while it stands and takes it off when it is answered", async () => {
    const { handle, turn, workspaceId } = await started();
    const thread = async () => foldThreads(await rt.sessions.list(workspaceId))[0]!;
    expect(threadWordOf(await thread())).toBe("Working");
    turn.raise();
    await vi.waitFor(async () => expect((await thread()).asking).toBe(askingLine(ASK)));
    expect(threadWordOf(await thread())).toBe("Needs you");
    await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW });
    await vi.waitFor(async () => expect((await thread()).asking).toBeUndefined());
    expect(threadWordOf(await thread())).toBe("Working");
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
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    const handle = await rt.sessions.start(cloud.id, { prompt: "write it" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0]!;
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(cloud.id))).toHaveLength(1));

    await rt.workspaces.nap(cloud.id);
    await vi.waitFor(async () => expect(closes(await history(cloud.id))).toHaveLength(1));
    const cut = await history(cloud.id);
    expect(closes(cut)).toMatchObject([{ askId: "ask_1", outcome: "cancelled" }]);
    expect(closes(cut)[0]).not.toHaveProperty("optionId");
    // The row closes before the turn ends, so a transcript reads the prompt going with the turn, not after it.
    expect(cut.findIndex(e => e.type === "session.permission.closed")).toBeLessThan(cut.findIndex(e => e.type === "session.end"));
    // A paused workspace refuses the verb in its own words, as a send gets, and the closed row offers nothing anyway.
    await expect(rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW })).rejects.toThrow("Workspace is paused; wake it to send");

    // Nothing is left waiting on a turn that is over, and no second row lands however long the clock runs.
    wait.advance(20 * 60_000);
    expect(turn.answers).toHaveLength(0);
    expect(closes(await history(cloud.id))).toHaveLength(1);
  });

  it("a thread of another tree forgetting a thread on the workspace is told not-found, and the thread stands", async () => {
    rt = runtime({ codex: dying });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    // A launch that never got going: the one thread shape forget takes, so what holds it back here is the tree.
    const junk = await rt.sessions.start(ws.id, { prompt: "never got going", harness: "codex" });
    await junk.finished.catch(() => {});
    const target = junk.view().threadId!;
    const beside = await rt.sessions.start(ws.id, { prompt: "beside it", harness: "claude" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const besideThread = beside.view().threadId!;
    const outside = { origin: "here", by: { kind: "thread", threadId: besideThread, workspaceId: ws.id, rootThreadId: besideThread } } as const;

    // The absence a thread id nothing holds answers, so the caller learns nothing about a tree that is not its own.
    await expect(rt.sessions.forget(target, outside)).rejects.toMatchObject({ message: `no thread ${threadWord(target)}`, kind: "not-found" });

    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => t.id)).toContain(target);
    // The person, who is no thread, forgets it as before.
    await rt.sessions.forget(target);
    expect(foldThreads(await rt.sessions.list(ws.id)).map(t => t.id)).toEqual([besideThread]);
    turns[0]!.reply();
    await beside.finished;
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

  it("a thread of another tree on the workspace is told not-found, as the interrupt tells it, and answers nothing; the asking thread answers", async () => {
    const { handle, turn, workspaceId } = await started();
    turn.raise();
    await vi.waitFor(async () => expect(prompts(await history(workspaceId))).toHaveLength(1));
    // A second thread the person opened on the same workspace is its own root: the first thread is outside its tree.
    const beside = await rt.sessions.start(workspaceId, { prompt: "beside it" });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const besideThread = beside.view().threadId!;
    const outside = { origin: "here", by: { kind: "thread", threadId: besideThread, workspaceId, rootThreadId: besideThread } } as const;
    // The same absence the sibling verbs answer, before the workspace is read: the prompt stays open and the
    // harness hears nothing, so a thread of one tree cannot grant what another tree's agent asked to do.
    expect(await rt.sessions.interrupt(handle.id, outside)).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW }, outside)).toEqual({ outcome: "not-found" });
    expect(turn.answers).toHaveLength(0);
    expect(closes(await history(workspaceId))).toHaveLength(0);
    // A caller inside the tree answers as the person does.
    const askingThread = handle.view().threadId!;
    const inside = { origin: "here", by: { kind: "thread", threadId: askingThread, workspaceId, rootThreadId: askingThread } } as const;
    expect(await rt.sessions.answer(handle.id, { askId: "ask_1", optionId: PERMISSION_ALLOW }, inside)).toEqual({ outcome: "answered" });
    expect(turn.answers).toMatchObject([{ askId: "ask_1", optionId: PERMISSION_ALLOW, outcome: "allowed" }]);
    expect(closes(await history(workspaceId))).toHaveLength(1);
    turns[1]!.reply();
    await beside.finished;
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
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
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

  it("on this computer the composer's access list marks the mode that asks nothing until the person sets another", async () => {
    const { rt } = recording();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const [claude] = await rt.harnesses.list(local.id);
    expect(claude!.access?.ask).toBe("default");
    expect(claude!.permissionModes.find(o => o.isDefault)?.value).toBe("bypassPermissions");
    // Every mode that asks is still one pick away, in the same list, in the same order.
    expect(claude!.permissionModes.map(o => o.value)).toContain("default");
  });

  it("a thread on this computer runs every action without asking, explicitly, and a send that names none keeps it", async () => {
    const { rt, picks } = recording();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(local.id, { prompt: "one" });
    await first.finished;
    expect(picks).toEqual(["bypassPermissions"]);
    // The second turn resumes the thread and names no access; the mode is named rather than left out, so a thread
    // whose person picked another one keeps it instead of falling to the adapter's own flag.
    await (await rt.sessions.start(local.id, { prompt: "two", thread: first.view().threadId })).finished;
    expect(picks).toEqual(["bypassPermissions", "bypassPermissions"]);
    // A mode named on a send is dropped: a thread's access is the thread's own, and sessions.access is the one
    // road that changes what it may touch.
    await (await rt.sessions.start(local.id, { prompt: "three", thread: first.view().threadId, permissionMode: "dontAsk" })).finished;
    expect(picks).toEqual(["bypassPermissions", "bypassPermissions", "bypassPermissions"]);
  });

  it("a thread nobody named an access for starts at the agent's default, the project's over it, and never at a workspace's last pick", async () => {
    const { rt, picks } = recording();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await (await rt.sessions.start(local.id, { prompt: "one" })).finished;
    expect(picks).toEqual(["bypassPermissions"]);
    // The composer's pick is for one thread: one kept per workspace decides no later thread.
    await rt.preferences.set({ access: { [local.id]: "default" } });
    await (await rt.sessions.start(local.id, { prompt: "two" })).finished;
    expect(picks).toEqual(["bypassPermissions", "bypassPermissions"]);
    await rt.preferences.set({ agentDefaults: { claude: { access: "ask" } } });
    await (await rt.sessions.start(local.id, { prompt: "three" })).finished;
    expect(picks.at(-1)).toBe("default");
    await rt.preferences.set({ projectDefaults: { [local.project.id]: { access: "auto-edit" } } });
    await (await rt.sessions.start(local.id, { prompt: "four" })).finished;
    expect(picks.at(-1)).toBe("acceptEdits");
    // The composer's list carries the same mark, so what the picker shows is what a start runs.
    const [claude] = await rt.harnesses.list(local.id);
    expect(claude!.permissionModes.find(o => o.isDefault)?.value).toBe("acceptEdits");
  });

  it("a word the agent maps to no mode is refused at the set and on a start, never run looser", async () => {
    const { rt, picks } = recording();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await expect(rt.preferences.set({ agentDefaults: { claude: { access: "plan" } } })).rejects.toMatchObject({ message: "Claude Code takes no plan access; it takes ask, auto-edit, full", kind: "usage" });
    await expect(rt.preferences.set({ projectDefaults: { [local.project.id]: { access: "plan" } } })).rejects.toMatchObject({ kind: "usage" });
    await expect(rt.sessions.start(local.id, { prompt: "one", access: "plan" })).rejects.toMatchObject({ message: "Claude Code takes no plan access; it takes ask, auto-edit, full", kind: "usage" });
    expect(picks).toEqual([]);
    await (await rt.sessions.start(local.id, { prompt: "two", access: "auto-edit" })).finished;
    expect(picks).toEqual(["acceptEdits"]);
  });

  it("a start that names an access wins over every default, and a resumed thread keeps its own", async () => {
    const { rt, picks } = recording();
    const local = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const first = await rt.sessions.start(local.id, { prompt: "one" });
    await first.finished;
    await rt.preferences.set({ agentDefaults: { claude: { access: "auto-edit" } } });
    // The thread opened before the default keeps the access its own turns ran at; the default is what a new thread reads.
    await (await rt.sessions.start(local.id, { prompt: "two", thread: first.view().threadId })).finished;
    // A start that names one wins over both.
    await (await rt.sessions.start(local.id, { prompt: "three", permissionMode: "dontAsk" })).finished;
    expect(picks).toEqual(["bypassPermissions", "bypassPermissions", "dontAsk"]);
  });

  it("a throwaway machine's list and its threads are unchanged: bypass is the default and carries no machine's name", async () => {
    const { rt, picks } = recording();
    const cloud = await createOn(rt, { golden: "snap_g", name: "b1" });
    const [claude] = await rt.harnesses.list(cloud.id);
    expect(claude!.permissionModes.find(o => o.isDefault)?.value).toBe("bypassPermissions");
    expect(claude!.permissionModes.find(o => o.value === "bypassPermissions")?.label).toBe("Bypass");
    await (await rt.sessions.start(cloud.id, { prompt: "one" })).finished;
    expect(picks).toEqual(["bypassPermissions"]);
  });
});

describe("an access picked while a turn runs", () => {
  let root: string;
  let store: Store;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-access-live-"));
    store = memoryStore();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A turn that stays open until the test replies. `moves` is what its harness answers a mode change with, and null
   * is a harness that takes none mid-turn. A send resumes its thread's session and a thread the
   * send opens gets one of its own, as a CLI's would, so two threads on one workspace hold two rows. */
  const held = (moves: "set" | "refused" | null): { rt: Runtime; turns: { modes: string[]; reply: () => void }[]; picks: (string | undefined)[] } => {
    const turns: { modes: string[]; reply: () => void }[] = [];
    const picks: (string | undefined)[] = [];
    const adapter: HarnessAdapterFactory = () => ({
      steers: false,
      start: ({ onEvent, permissionMode, resume }) => {
        picks.push(permissionMode);
        const session = resume ?? randomUUID();
        const modes: string[] = [];
        let settle: (() => void) | undefined;
        const finished = new Promise<{ status: "completed"; text: string }>(resolve => {
          settle = () => {
            const result = { status: "completed", text: "done" } as const;
            onEvent({ type: "turn.done", sessionId: session, result });
            onEvent({ type: "session.end", sessionId: session, exitCode: 0, sawResult: true });
            resolve(result);
          };
        });
        onEvent({ type: "session.start", sessionId: session, cwd: "/root" });
        turns.push({ modes, reply: () => settle?.() });
        return {
          localId: session,
          finished,
          interrupt: async () => settle?.(),
          ...(moves === null
            ? {}
            : {
                setAccess: async (mode: string) => {
                  modes.push(mode);
                  return moves;
                },
              }),
        };
      },
    });
    const local: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    return { rt: createRuntime({ backend: stubBackend(), store, adapters: { claude: adapter }, local }), turns, picks };
  };

  /** A running turn on the one local workspace. */
  const running = async (rt: Runtime, turns: unknown[]): Promise<{ handle: SessionHandle; workspaceId: string }> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const handle = await rt.sessions.start(ws.id, { prompt: "run it" });
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    return { handle, workspaceId: ws.id };
  };

  it("reaches the turn in front of the person, and the row carries the mode its later turns resume at", async () => {
    const { rt, turns, picks } = held("set");
    const { handle, workspaceId } = await running(rt, turns);
    expect(handle.view().permissionMode).toBe("bypassPermissions");
    expect(await rt.sessions.access(handle.id, "acceptEdits")).toEqual({ outcome: "set" });
    expect(turns[0]!.modes).toEqual(["acceptEdits"]);
    // The row is what a resume reads its access off, so a turn moved mid-flight must not leave it saying the old one.
    expect(handle.view().permissionMode).toBe("acceptEdits");

    turns[0]!.reply();
    await handle.finished;
    const next = await rt.sessions.start(workspaceId, { prompt: "again", thread: handle.view().threadId });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.reply();
    await next.finished;
    expect(picks).toEqual(["bypassPermissions", "acceptEdits"]);
  });

  it("a harness that takes no mode change mid-turn answers unsupported and the turn keeps the access it started at; the thread's next turn runs at the pick", async () => {
    const { rt, turns, picks } = held(null);
    const { handle, workspaceId } = await running(rt, turns);
    expect(await rt.sessions.access(handle.id, "dontAsk")).toEqual({ outcome: "unsupported" });
    expect(handle.view().permissionMode).toBe("bypassPermissions");
    turns[0]!.reply();
    await handle.finished;
    // The pick landed on the thread's record all the same, which is where its next turn reads its access.
    const next = await rt.sessions.start(workspaceId, { prompt: "again", thread: handle.view().threadId });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.reply();
    await next.finished;
    expect(picks).toEqual(["bypassPermissions", "dontAsk"]);
  });

  it("a CLI that refuses the mode reads as unsupported too, rather than as a change that landed", async () => {
    const { rt, turns } = held("refused");
    const { handle } = await running(rt, turns);
    expect(await rt.sessions.access(handle.id, "dontAsk")).toEqual({ outcome: "unsupported" });
    expect(turns[0]!.modes).toEqual(["dontAsk"]);
    expect(handle.view().permissionMode).toBe("bypassPermissions");
    turns[0]!.reply();
    await handle.finished;
    // The turn kept its mode to its end; over, its row says the pick its thread's next turn runs at.
    expect(handle.view().permissionMode).toBe("dontAsk");
  });

  it("a pick the running turn did not take reaches its row as the turn ends, so no row says a mode the next turn will not run at", async () => {
    const { rt, turns, picks } = held(null);
    const { handle, workspaceId } = await running(rt, turns);
    expect(await rt.sessions.access(handle.id, "dontAsk")).toEqual({ outcome: "unsupported" });
    // While the turn runs, its row says what it is running at: the harness took no change.
    expect(handle.view().permissionMode).toBe("bypassPermissions");
    expect((await rt.sessions.list(workspaceId)).map(s => s.permissionMode)).toEqual(["bypassPermissions"]);
    turns[0]!.reply();
    await handle.finished;
    // Between turns every client folds the thread's access off this row, and the composer reads the row over the
    // transcript's start stamp, so the row says the mode the record holds and the next turn runs at.
    expect(handle.view().permissionMode).toBe("dontAsk");
    expect((await rt.sessions.list(workspaceId)).map(s => s.permissionMode)).toEqual(["dontAsk"]);
    const next = await rt.sessions.start(workspaceId, { prompt: "again", thread: handle.view().threadId });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.reply();
    await next.finished;
    expect(picks).toEqual(["bypassPermissions", "dontAsk"]);
  });

  it("a thread of another tree on the workspace is told not-found, as the interrupt tells it, and moves nothing", async () => {
    const { rt, turns, picks } = held("set");
    const { handle, workspaceId } = await running(rt, turns);
    turns[0]!.reply();
    await handle.finished;
    // A second thread the person opened on the same workspace is its own root: the first thread is outside its tree.
    const beside = await rt.sessions.start(workspaceId, { prompt: "beside it" });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.reply();
    await beside.finished;
    const besideThread = beside.view().threadId!;
    const scoped = { origin: "here", by: { kind: "thread", threadId: besideThread, workspaceId, rootThreadId: besideThread } } as const;
    // The same absence the sibling verbs answer, before the workspace is read, so a thread learns nothing of a row
    // it may not drive; and the one road that changes a thread's access is shut to it.
    expect(await rt.sessions.interrupt(handle.id, scoped)).toEqual({ outcome: "not-found" });
    expect(await rt.sessions.access(handle.id, "dontAsk", scoped)).toEqual({ outcome: "not-found" });
    expect((await rt.sessions.list(workspaceId)).map(s => s.permissionMode)).toEqual(["bypassPermissions", "bypassPermissions"]);
    // A thread's own row is still its own to move.
    expect(await rt.sessions.access(beside.id, "dontAsk", scoped)).toEqual({ outcome: "set" });
    // The first thread's next turn runs at what it ran at.
    const next = await rt.sessions.start(workspaceId, { prompt: "again", thread: handle.view().threadId });
    await vi.waitFor(() => expect(turns).toHaveLength(3));
    turns[2]!.reply();
    await next.finished;
    expect(picks).toEqual(["bypassPermissions", "bypassPermissions", "bypassPermissions"]);
  });

  it("a mode the harness's own list does not carry is refused in the words a start refuses it with", async () => {
    const { rt, turns } = held("set");
    const { handle } = await running(rt, turns);
    await expect(rt.sessions.access(handle.id, "sideways")).rejects.toThrow(/not one claude takes/);
    expect(turns[0]!.modes).toEqual([]);
    turns[0]!.reply();
    await handle.finished;
  });

  it("answers rather than throwing: an unknown session is not found, and a pick on a thread between turns is set on its record", async () => {
    const { rt, turns, picks } = held("set");
    const { handle, workspaceId } = await running(rt, turns);
    expect(await rt.sessions.access("s_nope", "dontAsk")).toEqual({ outcome: "not-found" });
    turns[0]!.reply();
    await handle.finished;
    // No process is touched: the thread's record takes the mode, the row every client folds the access off says
    // it too, and the thread's next turn runs at it. This is the one road that changes a thread's access, since a
    // send into a thread names none.
    expect(await rt.sessions.access(handle.id, "dontAsk")).toEqual({ outcome: "set" });
    expect(turns[0]!.modes).toEqual([]);
    expect((await rt.sessions.list(workspaceId)).map(s => s.permissionMode)).toEqual(["dontAsk"]);
    const next = await rt.sessions.start(workspaceId, { prompt: "again", thread: handle.view().threadId, permissionMode: "acceptEdits" });
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    turns[1]!.reply();
    await next.finished;
    expect(picks).toEqual(["bypassPermissions", "dontAsk"]);
  });
});
