// SPDX-License-Identifier: AGPL-3.0-only
// Schema 2 in the Slate tab against a fake host: appendix C draws and moves with pushed values, typing writes
// through slates.state, a held run shows its row and the consent sheet, an output streams and cancels, and a
// secret's text never stays in the window once the host has it.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLATE_PIECES, slateStartValues, type SessionView, type SlateDoc, type SlateJson } from "@wsp/protocol";
import type { Api, ProtocolEvent } from "../protocol/client";
import { useStore } from "../protocol/store";
import { useRightPanelStore } from "../rightPanelStore";
import { APPENDIX_C } from "./fixtures/appendixC";
import type { SlateAsk } from "./model";
import { SLATE_VIEWS } from "./pieces";
import { SlateSurface } from "./SlateSurface";
import { slateBundle, useSlateStore } from "./store";
import { slate } from "./testing";
import type { SlateApi, SlateRecord } from "./wire";

const ROW: SessionView = { id: "s1", workspaceId: "ws", harness: "claude", status: "completed", threadId: "t1" };
const HANDLE = { secret: true, set: true, len: 24, at: 1 };
const TOKEN = "tok_9f8e7d6c5b4a39281706f5e4";

function record(doc: SlateDoc, values: Record<string, SlateJson> = {}, over: Partial<SlateRecord> = {}): SlateRecord {
  return { threadId: tid(), workspaceId: "ws", version: 1, revision: 1, document: doc, values: { ...slateStartValues(doc), ...values }, comments: [], approvals: {}, asks: [], problems: [], shownOnce: true, canUndo: false, rewound: false, updatedAt: 1, ...over };
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
  useSlateStore.setState({ byThread: {}, asking: {}, seen: {}, lastTurn: {} });
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
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 2, values: { $vercelToken: HANDLE } });
    flush();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 3, values: { $step: 2 } });
    flush();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(screen.getByLabelText("Project name on Vercel")).toBeTruthy();
    expect(screen.queryByLabelText("Vercel token")).toBeNull();
    // The run's result drives the derived value, and the derived value the text.
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 4, values: { $project: "wsp-landing", $check: { state: "done", exit: 0, out: "Found wsp-landing (prj_8f2a)", runs: 1 } } });
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
    // The sheet opens on its own the first time the tab shows the held run; closed unanswered, it waits on Review.
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(slates.approve).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Review" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Run this command?")).toBeTruthy();
    expect(sheet.querySelector("[data-slate-consent-cadence]")?.textContent).toBe("Runs each time $project changes");
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
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 2, values: { $tests: { state: "cancelled", exit: null, runs: 1 } } });
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

describe("round 2: held runs ask on their own, held buttons say why, submit is Enter", () => {
  const TIMERS = slate({
    root: "root",
    runs: {
      spot: { kind: "cmd", cmd: "curl -s https://api.example.com/spot", every: 60, always: true },
      disk: { kind: "cmd", cmd: "df -h .", every: 30 },
    },
    pieces: { root: { type: "column", children: ["t"] }, t: { type: "text", props: { text: "Prices" } } },
  });
  const spotAsk: SlateAsk = { ...CHECK_ASK, key: "k-spot", run: "spot", cmd: "curl -s https://api.example.com/spot", env: {} };
  const diskAsk: SlateAsk = { ...CHECK_ASK, key: "k-disk", run: "disk", cmd: "df -h .", env: {} };
  const held = { state: "held", why: "needs your approval", runs: 0 };

  it("opens the sheet for a timer's held run when the tab shows it, one command at a time, saying how often and whether hidden", async () => {
    const slates = host(record(TIMERS, { spot: held, disk: held }, { asks: [spotAsk, diskAsk] }));
    openThread(slates);
    const first = await screen.findByRole("dialog");
    expect(first.querySelector("[data-slate-consent]")?.getAttribute("data-slate-consent")).toBe("spot");
    expect(first.querySelector("[data-slate-consent-cadence]")?.textContent).toBe("Runs every 60 s, also while this slate is not on screen");
    expect(first.querySelector("[data-slate-consent-more]")?.textContent).toBe("1 more command waits after this one");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    await act(async () => fireEvent.click(within(first).getByRole("button", { name: "Run once" })));
    expect(slates.approve).toHaveBeenCalledWith(tid(), "k-spot", "once");
    const second = await waitFor(() => {
      const sheet = screen.getByRole("dialog");
      expect(sheet.querySelector("[data-slate-consent]")?.getAttribute("data-slate-consent")).toBe("disk");
      return sheet;
    });
    expect(second.querySelector("[data-slate-consent-cadence]")?.textContent).toBe("Runs every 30 s, only while this slate is on screen");
    expect(second.querySelector("[data-slate-consent-more]")).toBeNull();
    await act(async () => fireEvent.click(within(second).getByRole("button", { name: "Always in this thread" })));
    expect(slates.approve).toHaveBeenCalledWith(tid(), "k-disk", "thread");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("opens the sheet when a reaction holds a run after the tab is already showing", async () => {
    const first = record(APPENDIX_C, { step: 2, vercelToken: HANDLE });
    const get = vi.fn(async () => ({ record: first }));
    const slates = host(first, { get });
    openThread(slates);
    await screen.findByText("Step 2 of 4");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The host's reaction held $check; the push names it held and the record read after carries its sheet.
    get.mockResolvedValue({ record: record(APPENDIX_C, { step: 2, vercelToken: HANDLE, project: "wsp-landing", check: held }, { asks: [CHECK_ASK] }) });
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 5, values: { $project: "wsp-landing", $check: held } });
    const sheet = await screen.findByRole("dialog");
    expect(sheet.querySelector("[data-slate-consent-cmd]")?.textContent).toBe(CHECK_ASK.cmd);
    expect(sheet.querySelector("[data-slate-consent-cadence]")?.textContent).toBe("Runs each time $project changes");
  });

  it("draws a held button disabled with its sentence on hover, and lets null or false go", async () => {
    const doc = slate({
      root: "root",
      values: { ok: { start: false } },
      pieces: {
        root: { type: "column", children: ["next", "free", "off"] },
        next: { type: "button", props: { label: "Next", held: "Check the project first" }, on: { press: [{ do: "set", path: "$ok", value: true }] } },
        free: { type: "button", props: { label: "Free", held: null }, on: { press: [{ do: "set", path: "$ok", value: true }] } },
        off: { type: "button", props: { label: "Off", held: { bind: "$ok" } }, on: { press: [{ do: "set", path: "$ok", value: true }] } },
      },
    });
    openThread(host(record(doc)));
    const next = (await screen.findByRole("button", { name: "Next" })) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    const wrap = next.closest("[data-slate-held-button]") as HTMLElement;
    expect(wrap.dataset["slateHeldButton"]).toBe("Check the project first");
    fireEvent.pointerEnter(wrap, { pointerType: "mouse" });
    fireEvent.mouseEnter(wrap);
    fireEvent.mouseMove(wrap);
    expect(await screen.findByText("Check the project first", {}, { timeout: 2_000 })).toBeTruthy();
    for (const name of ["Free", "Off"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.closest("[data-slate-held-button]")).toBeNull();
    }
  });

  it("shows an input's submit label as the Enter hint, with no second button, and Enter submits", async () => {
    const doc = slate({
      root: "root",
      values: { q: { start: "" } },
      pieces: {
        root: { type: "column", children: ["ask", "note"] },
        ask: { type: "input", props: { label: "Issue", value: { bind: "$q" }, submit: "Look up" }, on: { submit: [{ do: "send", text: "Look this up" }] } },
        note: { type: "input", props: { label: "Note", value: { bind: "$q" }, lines: 3, submit: "Save" }, on: { submit: [{ do: "send", text: "Saved" }] } },
      },
    });
    const slates = host(record(doc), { event: vi.fn(async () => ({ outcome: "started" as const, said: "" })) });
    openThread(slates);
    const field = (await screen.findByLabelText("Issue")) as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "Look up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    const hints = [...document.querySelectorAll("[data-slate-submit-hint]")].map(hint => hint.textContent);
    expect(hints[0]).toBe("↵Look up");
    expect(hints[1]).toMatch(/^(⌘|Ctrl) ↵Save$/);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "WSP-12" } });
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    await waitFor(() => expect(slates.event).toHaveBeenCalledWith(tid(), expect.objectContaining({ piece: "ask", event: "submit" })));
  });

  const version = () => document.querySelector("[data-slate-version]")?.textContent;

  it("shows the document's version on the tab; values and run results never move it", async () => {
    openThread(host(record(APPENDIX_C, {}, { version: 3, revision: 10 })));
    await screen.findByText("Step 1 of 4");
    expect(version()).toBe("v3");
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 3, revision: 11, values: { $step: 2 } });
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 3, revision: 12, values: { $check: { state: "done", exit: 0, out: "ok", runs: 1 } } });
    flush();
    expect(screen.getByText("Step 2 of 4")).toBeTruthy();
    expect(version()).toBe("v3");
  });

  it("orders pushes by the data revision and drops one older than what it drew", async () => {
    openThread(host(record(APPENDIX_C, {}, { revision: 10 })));
    await screen.findByText("Step 1 of 4");
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 12, values: { $step: 3 } });
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 11, values: { $step: 2 } });
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 12, values: { $step: 4 } });
    flush();
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
  });

  it("takes a newer document from a record read before a push, and keeps the push's values", async () => {
    let answer: (r: { record: SlateRecord }) => void = () => {};
    const get = vi.fn(async () => ({ record: record(APPENDIX_C, { step: 1 }, { revision: 5 }) }));
    openThread(host(record(APPENDIX_C), { get }));
    await screen.findByText("Step 1 of 4");
    get.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    push({ type: "session.slate", workspaceId: "ws", sessionId: "s1", threadId: tid(), cause: "write", version: 2, by: "agent", pieces: [] });
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 2, revision: 8, values: { $step: 3 } });
    const titled = { ...APPENDIX_C, title: "Deploy setup, again", values: { ...APPENDIX_C.values, team: { start: "wsp" } } };
    await act(async () => answer({ record: record(titled, { step: 2 }, { version: 2, revision: 7 }) }));
    flush();
    expect(await screen.findByText("Deploy setup, again")).toBeTruthy();
    expect(version()).toBe("v2");
    expect(screen.getByText("Step 3 of 4")).toBeTruthy();
    // A value the new document declared reaches the window with it.
    expect(slateBundle(tid()).engine.values["team"]).toBe("wsp");
  });

  it("marks a run's output from before the agent changed its command, until it runs again", async () => {
    const doc = slate({
      root: "root",
      runs: { spot: { kind: "cmd", cmd: "curl -s https://wttr.in/Pune" } },
      pieces: { root: { type: "column", children: ["out"] }, out: { type: "output", props: { run: "$spot" } } },
    });
    openThread(host(record(doc, { spot: { state: "done", exit: 0, out: "Mumbai 31C", runs: 3, stale: true } }, { revision: 10 })));
    expect(await screen.findByText("from before the command changed")).toBeTruthy();
    expect(screen.getByRole("log").className).toContain("text-muted-foreground");
    push({ type: "slate.values", workspaceId: "ws", threadId: tid(), version: 1, revision: 11, values: { $spot: { state: "done", exit: 0, out: "Pune 27C", runs: 4 } } });
    flush();
    expect(screen.queryByText("from before the command changed")).toBeNull();
    expect(screen.getByRole("log").textContent).toBe("Pune 27C");
  });
});
