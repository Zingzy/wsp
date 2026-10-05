// SPDX-License-Identifier: AGPL-3.0-only
// The prompt dock in the thread: a prompt the thread's own agent is stopped
// on takes the composer's place, is answered with its keys or its buttons,
// folds to one row over the composer on Esc, and gives the composer back once
// it closes. Same fixture api shape as chat-composer.test.tsx; no live daemon.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUESTION_TOOL, otherOptionId, pickedOptionId, questionOptions, type EventUnion, type HarnessCatalog, type SessionEvent, type WorkspaceView } from "@wsp/protocol";
import { installFakeLayout } from "./fake-layout.js";
import { useStore } from "../src/protocol/store.js";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { WorkspaceThread } from "../src/shell/WorkspaceThread.js";
import { useComposerDraftStore } from "../src/components/chat/composerDraftStore.js";
import { keyBelongsElsewhere } from "../src/keyOwners.js";
import { CHAT_T0, CHAT_WS } from "./fixtures/chat-stream.js";
import { caps } from "./caps.js";
import { noDaemonApi } from "./fake-daemon-api.js";

let restoreLayout: () => void = () => {};
beforeAll(() => { restoreLayout = installFakeLayout(); });
afterAll(() => restoreLayout());
beforeEach(() => useComposerDraftStore.setState({ drafts: {}, queues: {} }));

const WS = CHAT_WS;
const T0 = CHAT_T0;
const sc = { workspaceId: WS, sessionId: "sess_dock", turnId: "turn_dock" };
const workspace: WorkspaceView = {
  id: WS,
  name: "api",
  machineId: "m1",
  project: { id: "pr_1", name: "the-project", path: "/root", computer: "default" },
  phase: "running",
  golden: "snap_g",
  createdAt: "2026-09-01T00:00:00Z",
};
const CATALOG: HarnessCatalog = { harness: "claude", label: "Claude Code", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false };

interface Answer {
  readonly askId: string;
  readonly optionId: string;
  readonly reason?: string;
}

function fixture(asks: SessionEvent[]) {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const answered: Answer[] = [];
  const history: SessionEvent[] = [{ type: "session.start", ...sc, at: T0, model: "claude-sonnet-5", prompt: "set it up" }, ...asks];
  const api: Api = {
    portReach: async (_id, port) => ({ url: `https://m1-${port}.preview.example/`, expiresAt: Date.now() + 3_600_000 }),
    daemon: noDaemonApi,
    sessionHistory: async () => history,
    listSnapshots: async () => ({ name: "default", head: null, versions: [] }),
    snapshotStorage: async () => null,
    rollbackSnapshot: async () => ({ lineage: { name: "default", head: null, versions: [] }, existingWorkspaces: "untouched" }),
    listWorkspaces: async () => [workspace],
    getWorkspace: async () => workspace,
    createWorkspace: async () => workspace,
    nap: async () => workspace,
    wake: async () => workspace,
    capabilities: async () => caps(),
    listSessions: async () => [],
    listHarnesses: async () => [CATALOG],
    watchStatuses: async () => [],
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getGolden: async () => undefined,
    startSession: async opts => ({ id: "s1", workspaceId: opts.workspaceId, harness: "claude", status: "running", prompt: opts.prompt, startedAt: 0 }),
    answerPermission: async (_sessionId, askId, optionId, reason) => {
      answered.push({ askId, optionId, ...(reason === undefined ? {} : { reason }) });
      return "answered";
    },
  };
  const emit = (e: EventUnion) => act(() => { for (const fn of [...listeners]) fn(e); });
  return { api, answered, emit };
}

async function setup(api: Api) {
  useStore.setState({ conn: "connecting", workspaces: [], statuses: {}, harnesses: [], harnessesByWorkspace: {}, launches: {} });
  useStore.getState().bind(api);
  useStore.getState().setConn("live");
  await waitFor(() => expect(useStore.getState().workspaces.length).toBeGreaterThan(0));
  await waitFor(() => expect(useStore.getState().harnesses.length).toBeGreaterThan(0));
  render(<WorkspaceThread workspaceId={WS} />);
  await waitFor(() => expect(document.querySelector("[data-prompt-root]")).not.toBeNull());
}

const question = (askId: string, questions: unknown[]): SessionEvent => {
  const input = JSON.stringify({ questions });
  return { type: "session.permission", ...sc, at: T0 + 500, askId, toolName: QUESTION_TOOL, toolUseId: `toolu_${askId}`, input, options: questionOptions(QUESTION_TOOL, input) };
};
const bash = (askId: string): SessionEvent => ({
  type: "session.permission",
  ...sc,
  at: T0 + 500,
  askId,
  toolName: "Bash",
  input: JSON.stringify({ command: "pnpm exec vitest run" }),
  options: [
    { id: "allow", label: "Allow", effect: "allow" },
    { id: "deny", label: "Deny", effect: "deny" },
  ],
});

const PICK = { question: "Which one is real?", header: "Spider-Man", multiSelect: false, options: [{ label: "Tobey", description: "Raimi" }, { label: "Andrew", description: "Amazing" }, { label: "Tom", description: "MCU" }] };
const CHECKS = { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "Types", description: "" }, { label: "Tests", description: "" }, { label: "Lint", description: "" }] };
const press = (at: Element, key: string) => fireEvent.keyDown(at, { key });
const root = () => document.querySelector<HTMLElement>("[data-prompt-root]")!;
const field = () => document.querySelector<HTMLInputElement>("[data-prompt-field]")!;
const composer = () => document.querySelector("[data-chat-composer]");

describe("the prompt dock", () => {
  it("takes the composer's place, answers a question on a digit and Enter, and gives the composer back once it closes", async () => {
    const ask = question("ask_q", [PICK]);
    const { api, answered, emit } = fixture([ask]);
    await setup(api);
    expect(composer()).toBeNull();
    // The timeline keeps the record of the prompt the dock answers, with no second set of buttons.
    expect(document.querySelector('[data-permission-prompt="ask_q"]')!.getAttribute("data-permission-open")).toBe("false");
    expect(document.querySelectorAll("[data-question-option]")).toHaveLength(0);
    press(root(), "2");
    press(root(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_q", optionId: "q0:o1" }]));
    emit({ type: "session.permission.closed", ...sc, at: T0 + 900, askId: "ask_q", outcome: "allowed", optionId: "q0:o1" });
    await waitFor(() => expect(document.querySelector("[data-prompt-dock]")).toBeNull());
    expect(composer()).not.toBeNull();
    expect(document.querySelector('[data-permission-outcome="allowed"]')!.textContent).toBe("You answered: Andrew");
  });

  it("walks a form a step at a time, says each earlier answer, goes Back, and sends one pick per question", async () => {
    const { api, answered } = fixture([question("ask_f", [PICK, { ...PICK, question: "Which suit?", header: "Suit", options: [{ label: "Red", description: "" }, { label: "Black", description: "" }] }])]);
    await setup(api);
    expect(document.querySelector("[data-prompt-count]")!.textContent).toBe("1 of 2");
    press(root(), "3");
    press(root(), "Enter");
    await waitFor(() => expect(document.querySelector("[data-prompt-count]")!.textContent).toBe("2 of 2"));
    expect(answered).toEqual([]);
    expect(document.querySelector("[data-prompt-answered]")!.textContent).toBe("Spider-Man: Tom");
    fireEvent.click(document.querySelector("[data-prompt-back]")!);
    await waitFor(() => expect(document.querySelector("[data-prompt-count]")!.textContent).toBe("1 of 2"));
    press(root(), "1");
    press(root(), "Enter");
    await waitFor(() => expect(document.querySelector("[data-prompt-answered]")!.textContent).toBe("Spider-Man: Tobey"));
    press(root(), "2");
    expect(document.querySelector("[data-prompt-answer]")!.textContent).toBe("Answer");
    press(root(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_f", optionId: pickedOptionId(["q0:o0", "q1:o1"]) }]));
  });

  it("takes an answer typed in Other as the words themselves, and holds Answer until there are some", async () => {
    const { api, answered } = fixture([question("ask_o", [PICK])]);
    await setup(api);
    press(root(), "4");
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(document.querySelector("[data-prompt-answer]")!.hasAttribute("data-held")).toBe(true);
    fireEvent.change(field(), { target: { value: "Tom Hardy, in the Venom suit" } });
    press(field(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_o", optionId: otherOptionId(0, "Tom Hardy, in the Venom suit") }]));
  });

  it("ticks several on a multi-pick, Other's words beside them, and sends every tick as one pick", async () => {
    const { api, answered } = fixture([question("ask_m", [CHECKS])]);
    await setup(api);
    press(root(), "1");
    press(root(), "3");
    press(root(), "4");
    await waitFor(() => expect(field()).not.toBeNull());
    fireEvent.change(field(), { target: { value: "Format" } });
    press(field(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_m", optionId: pickedOptionId(["q0:o0", "q0:o2", otherOptionId(0, "Format")]) }]));
  });

  it("allows a command on Enter, and denies it with the reason typed in Deny's field", async () => {
    const { api, answered, emit } = fixture([bash("ask_a")]);
    await setup(api);
    expect(document.querySelector("[data-prompt-answer]")!.textContent).toBe("Allow");
    press(root(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_a", optionId: "allow" }]));
    emit({ type: "session.permission.closed", ...sc, at: T0 + 900, askId: "ask_a", outcome: "allowed", optionId: "allow" });
    emit(bash("ask_d") as EventUnion);
    await waitFor(() => expect(document.querySelector('[data-prompt-dock="ask_d"]')).not.toBeNull());
    press(root(), "2");
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(document.querySelector("[data-prompt-answer]")!.textContent).toBe("Deny");
    fireEvent.change(field(), { target: { value: "Run only the thread-rows file" } });
    press(field(), "Enter");
    await waitFor(() => expect(answered.at(-1)).toEqual({ askId: "ask_d", optionId: "deny", reason: "Run only the thread-rows file" }));
  });

  it("folds to one row over the composer on Esc, and opens again from that row", async () => {
    const { api } = fixture([bash("ask_e")]);
    await setup(api);
    press(root(), "Escape");
    await waitFor(() => expect(document.querySelector("[data-prompt-strip]")).not.toBeNull());
    expect(document.querySelector("[data-prompt-dock]")).toBeNull();
    expect(composer()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(document.querySelector('[data-prompt-dock="ask_e"]')).not.toBeNull());
  });

  it("takes a digit typed outside any field as its own, as the composer takes a letter, so a tile clicked first still picks", async () => {
    const { api, answered } = fixture([bash("ask_t")]);
    await setup(api);
    const tile = document.createElement("button");
    document.body.append(tile);
    tile.focus();
    press(tile, "2");
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(composer()).toBeNull();
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt ?? "").toBe("");
    fireEvent.change(field(), { target: { value: "not now" } });
    press(field(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_t", optionId: "deny", reason: "not now" }]));
    tile.remove();
  });

  it("owns its digits, arrows, Space, Enter and Esc only, so a letter typed anywhere folds it and lands in the composer", async () => {
    const { api, answered } = fixture([bash("ask_k")]);
    await setup(api);
    for (const key of ["1", "ArrowDown", " ", "Enter", "Escape"]) expect(keyBelongsElsewhere(root(), key)).toBe(true);
    expect(keyBelongsElsewhere(root(), "h")).toBe(false);
    expect(keyBelongsElsewhere(document.body, "1")).toBe(false);
    press(root(), "h");
    await waitFor(() => expect(composer()).not.toBeNull());
    expect(document.querySelector("[data-prompt-strip]")).not.toBeNull();
    expect(useComposerDraftStore.getState().drafts[WS]?.prompt).toBe("h");
    expect(answered).toEqual([]);
  });
  it("leaves Enter to a focused button, so Write a message instead, Copy and Back do what they say and allow nothing", async () => {
    const { api, answered } = fixture([bash("ask_b")]);
    await setup(api);
    // A browser clicks a focused button on an Enter nobody prevented; jsdom does not, so the click is the default's.
    const enter = (button: HTMLElement) => {
      button.focus();
      if (fireEvent.keyDown(button, { key: "Enter" })) fireEvent.click(button);
    };
    enter(document.querySelector<HTMLElement>("[data-prompt-dock] [data-copy-row] button")!);
    expect(answered).toEqual([]);
    enter(document.querySelector<HTMLElement>("[data-prompt-write]")!);
    await waitFor(() => expect(document.querySelector("[data-prompt-strip]")).not.toBeNull());
    expect(answered).toEqual([]);
  });

  it("goes Back to the answer the step was given, a typed Other included, and Enter on Back sends nothing", async () => {
    const { api, answered } = fixture([question("ask_r", [PICK, { ...PICK, question: "Which suit?", header: "Suit", options: [{ label: "Red", description: "" }, { label: "Black", description: "" }] }])]);
    await setup(api);
    press(root(), "4");
    await waitFor(() => expect(document.activeElement).toBe(field()));
    fireEvent.change(field(), { target: { value: "Miles" } });
    press(field(), "Enter");
    await waitFor(() => expect(document.querySelector("[data-prompt-count]")!.textContent).toBe("2 of 2"));
    const back = document.querySelector<HTMLElement>("[data-prompt-back]")!;
    back.focus();
    if (fireEvent.keyDown(back, { key: "Enter" })) fireEvent.click(back);
    await waitFor(() => expect(document.querySelector("[data-prompt-count]")!.textContent).toBe("1 of 2"));
    expect(answered).toEqual([]);
    expect(field().value).toBe("Miles");
    expect(document.querySelector("[data-prompt-answer]")!.hasAttribute("data-held")).toBe(false);
    press(field(), "Enter");
    await waitFor(() => expect(document.querySelector("[data-prompt-count]")!.textContent).toBe("2 of 2"));
    press(root(), "1");
    press(root(), "Enter");
    await waitFor(() => expect(answered).toEqual([{ askId: "ask_r", optionId: pickedOptionId([otherOptionId(0, "Miles"), "q1:o0"]) }]));
  });

  it("puts the caret in the composer when Esc folds it, so the person who chose to write can type at once", async () => {
    const { api } = fixture([bash("ask_c")]);
    await setup(api);
    press(root(), "Escape");
    await waitFor(() => expect(composer()).not.toBeNull());
    await waitFor(() => expect(composer()!.contains(document.activeElement)).toBe(true));
  });
});
