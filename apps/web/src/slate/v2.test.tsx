// SPDX-License-Identifier: AGPL-3.0-only
// Schema 2 in the Slate tab against a fake host: appendix C draws and moves with pushed values, typing writes
// through slates.state, a held run shows its row and the consent sheet, an output streams and cancels, and a
// secret's text never stays in the window once the host has it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLATE_PIECES, type SessionView, type SlateDoc, type SlateJson } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../protocol/client";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { APPENDIX_C } from "./fixtures/appendixC";
import type { SlateAsk } from "./model";
import { SLATE_VIEWS } from "./pieces";
import { SlateSurface } from "./SlateSurface";
import { slateBundle, useSlateStore } from "./store";
import { slate, startsOf } from "./testing";
import type { SlateApi, SlateRecord } from "./wire";

const ROW: SessionView = { id: "s1", workspaceId: "ws", harness: "claude", status: "completed", threadId: "t1" };
const HANDLE = { secret: true, set: true, len: 24, at: 1 };
const TOKEN = "tok_9f8e7d6c5b4a39281706f5e4";

function record(doc: SlateDoc, values: Record<string, SlateJson> = {}, over: Partial<SlateRecord> = {}): SlateRecord {
  return { threadId: tid(), workspaceId: "ws", version: 1, document: doc, values: { ...startsOf(doc), ...values }, comments: [], approvals: {}, asks: [], problems: [], shownOnce: true, canUndo: false, rewound: false, updatedAt: 1, ...over };
}

function host(first: SlateRecord, over: Partial<SlateApi> = {}): SlateApi {
  return {
    get: vi.fn(async () => ({ record: first })),
    state: vi.fn(async () => ({ version: 2 })),
    event: vi.fn(async () => ({ outcome: "done" as const, said: "" })),
    approve: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    shown: vi.fn(async () => {}),
    sketch: vi.fn(async () => ""),
    undo: vi.fn(async () => ({ version: 2 })),
    clear: vi.fn(async () => ({ version: 2 })),
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    resolve: vi.fn(async () => ({})),
    ...over,
  };
}

const push = (e: Record<string, unknown>) => act(() => useStore.getState().applyEvent(e as unknown as ProtocolEvent));
const CHECK_ASK: SlateAsk = {
  key: "k-check",
  run: "check",
  kind: "cmd",
  cmd: 'vercel project inspect "$PROJECT" 2>&1 | head -c 4000',
  env: { PROJECT: "wsp-landing", VERCEL_TOKEN: "•••••••••••••••••••••••• (24 characters)" },
  args: [],
  computer: "zingzy's MacBook Pro",
  folder: "/Users/zingzy/wsp-landing",
  timeoutS: 30,
  why: "needs your approval",
};

let thread = 0;
beforeEach(() => {
  // Each test its own thread id, so the window-lifetime engines of one test never meet the next's.
  thread += 1;
  ROW.threadId = `t${thread}`;
  useSlateStore.setState({ byThread: {}, asking: {}, lastTurn: {} });
  useRightPanelStore.setState({ byWorkspaceId: {} });
});
afterEach(cleanup);

function openThread(slates: SlateApi) {
  useStore.setState({ api: { slates, subscribe: () => () => {} } as unknown as Api, selectedId: "ws", selectedThreadId: ROW.threadId!, sessions: { ws: [ROW] } });
  return render(<SlateSurface />);
}
const tid = () => ROW.threadId!;
const flush = () => act(() => slateBundle(tid()).engine.flush());

describe("schema 2 in the Slate tab", () => {
  it("has a view for every core piece the protocol registers", () => {
    const core = Object.entries(SLATE_PIECES).flatMap(([type, piece]) => (piece.level === "core" ? [type] : []));
    expect(Object.keys(SLATE_VIEWS).sort()).toEqual(core.sort());
  });

  it("draws appendix C and moves through its steps on pushed values", async () => {
    openThread(host(record(APPENDIX_C)));
    expect(await screen.findByText("Step 1 of 4")).toBeTruthy();
    expect(screen.getByText("Deploy setup")).toBeTruthy();
    const token = screen.getByLabelText("Vercel token") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(screen.getByRole("button", { name: "Open Vercel tokens" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 2, values: { $vercelToken: HANDLE } });
    flush();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 3, values: { $step: 2 } });
    flush();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByLabelText("Project name on Vercel")).toBeTruthy();
    expect(screen.queryByLabelText("Vercel token")).toBeNull();
    // The run's result drives the derived value, and the derived value the text.
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 4, values: { $project: "wsp-landing", $check: { state: "done", exit: 0, out: "Found wsp-landing (prj_8f2a)", runs: 1 } } });
    flush();
    expect(screen.getByText("Found wsp-landing")).toBeTruthy();
  });

  it("writes the project name through slates.state, 300 ms after the last keystroke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const slates = host(record(APPENDIX_C, { step: 2 }));
      openThread(slates);
      const field = (await screen.findByLabelText("Project name on Vercel")) as HTMLInputElement;
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "wsp-land" } });
      fireEvent.change(field, { target: { value: "wsp-landing" } });
      expect(slates.state).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(300));
      expect(slates.state).toHaveBeenCalledTimes(1);
      expect(slates.state).toHaveBeenCalledWith(tid(), { $project: "wsp-landing" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a held run's row and its consent sheet, the command whole and the secret as dots, and approves by key", async () => {
    const slates = host(record(APPENDIX_C, { step: 2, project: "wsp-landing", vercelToken: HANDLE, check: { state: "held", why: "needs your approval", runs: 0 } }, { asks: [CHECK_ASK] }));
    openThread(slates);
    const row = (await screen.findByText("This slate wants to run")).closest("[data-slate-held]") as HTMLElement;
    expect(row.dataset["slateHeld"]).toBe("check");
    expect(within(row).getByText(CHECK_ASK.cmd)).toBeTruthy();
    expect(screen.getByText("Approve the check to go on")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Run this command?")).toBeTruthy();
    expect(sheet.querySelector("[data-slate-consent-cmd]")?.textContent).toBe(CHECK_ASK.cmd);
    expect(sheet.querySelector('[data-slate-consent-env="PROJECT"]')?.textContent).toContain("wsp-landing");
    const secret = sheet.querySelector('[data-slate-consent-env="VERCEL_TOKEN"]')?.textContent ?? "";
    expect(secret).toMatch(/^VERCEL_TOKEN•+ \(24 characters\)$/);
    expect(sheet.textContent).not.toContain(TOKEN);
    expect(within(sheet).getByText(/on zingzy's MacBook Pro, in \/Users\/zingzy\/wsp-landing, 30 s at most/)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Run once" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Don't" })).toBeTruthy();
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Always in this thread" })));
    expect(slates.approve).toHaveBeenCalledWith(tid(), "k-check", "thread");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the sheet at once when a press held a run, from the host's answer", async () => {
    const ask: SlateAsk = { ...CHECK_ASK, key: "k-env", run: "env", cmd: "printf ... >> .env.tmp; mv .env.tmp .env", env: { VERCEL_TOKEN: "•••••••• (8 characters)" } };
    const slates = host(record(APPENDIX_C, { step: 3, project: "wsp-landing", vercelToken: HANDLE }), { event: vi.fn(async () => ({ outcome: "held" as const, said: "", ask })) });
    openThread(slates);
    fireEvent.click(await screen.findByRole("button", { name: "Write .env" }));
    const sheet = await screen.findByRole("dialog");
    expect(slates.event).toHaveBeenCalledWith(tid(), expect.objectContaining({ piece: "button-3", event: "press" }));
    expect(sheet.querySelector("[data-slate-consent-cmd]")?.textContent).toBe(ask.cmd);
    await act(async () => fireEvent.click(within(sheet).getByRole("button", { name: "Run once" })));
    expect(slates.approve).toHaveBeenCalledWith(tid(), "k-env", "once");
  });

  it("streams a run's lines into its output piece and cancels it through slates.cancel", async () => {
    const doc = slate({
      root: "root",
      runs: { tests: { kind: "cmd", cmd: "pnpm exec vitest run test/cart.test.ts", stream: true, timeout: 300 } },
      pieces: { root: { type: "column", children: ["out"] }, out: { type: "output", props: { run: "$tests", lines: 10 } } },
    });
    const slates = host(record(doc, { tests: { state: "running", runs: 1 } }));
    openThread(slates);
    expect(await screen.findByText("Running")).toBeTruthy();
    push({ type: "slate.run", workspaceId: "ws", threadId: tid(), run: "tests", lines: ["RUN  v3", " ✓ rounds once"] });
    push({ type: "slate.run", workspaceId: "ws", threadId: tid(), run: "tests", lines: [" ✓ totals add up"] });
    flush();
    const log = screen.getByRole("log");
    expect([...log.children].map(line => line.textContent)).toEqual(["RUN  v3", " ✓ rounds once", " ✓ totals add up"]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    expect(slates.cancel).toHaveBeenCalledWith(tid(), "tests");
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 2, values: { $tests: { state: "cancelled", exit: null, runs: 1 } } });
    flush();
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // A finished run keeps its last lines until it next starts.
    expect(screen.getByRole("log").textContent).toContain("totals add up");
  });

  it("holds the slate on the host while the tab draws it, so its timers tick only while shown", async () => {
    const slates = host(record(APPENDIX_C));
    const view = openThread(slates);
    await screen.findByText("Step 1 of 4");
    expect(slates.subscribe).toHaveBeenCalledWith(tid(), ["slate"]);
    view.unmount();
    expect(slates.unsubscribe).toHaveBeenCalledWith(tid(), ["slate"]);
  });

  it("sends a secret's text once and keeps none of it in the window after", async () => {
    let answer: () => void = () => {};
    const slates = host(record(APPENDIX_C), { state: vi.fn(() => new Promise<{ version: number }>(resolve => (answer = () => resolve({ version: 2 })))) });
    openThread(slates);
    const field = (await screen.findByLabelText("Vercel token")) as HTMLInputElement;
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: TOKEN } });
    // Typing alone sends nothing: a secret goes once, whole, on blur or Enter.
    await act(async () => new Promise(resolve => setTimeout(resolve, 350)));
    expect(slates.state).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(slates.state).toHaveBeenCalledTimes(1);
    expect(slates.state).toHaveBeenCalledWith(tid(), { $vercelToken: TOKEN });
    await act(async () => answer());
    flush();
    expect(field.value).toBe("");
    expect(field.placeholder).toMatch(/^•+$/);
    const engine = slateBundle(tid()).engine;
    expect(JSON.stringify(engine.values)).not.toContain(TOKEN);
    expect(engine.values["vercelToken"]).toMatchObject({ secret: true, set: true, len: TOKEN.length });
    expect(JSON.stringify(useSlateStore.getState())).not.toContain(TOKEN);
    expect(document.body.innerHTML).not.toContain(TOKEN);
    // The handle unlocks the step, as the host's push would.
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });
});
