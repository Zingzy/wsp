// SPDX-License-Identifier: AGPL-3.0-only
import { HERE_PLACE_ID, NEEDS_YOU, type PlaceView, type SessionEvent, type SessionPermissionEvent, type SessionView, type TurnResult, type WorkspaceView } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { QUIT_WORD } from "../src/quit.js";
import { TRAY_WORDS, trayModel, trayNotice, type TrayInput, type TrayRow } from "../src/tray.js";

const places = [
  { id: HERE_PLACE_ID, kind: "computer", name: "zmac", label: "zingzy's MacBook Pro", default: true },
  { id: "pl_box", kind: "computer", name: "spoo", default: false },
] as PlaceView[];
const workspaces = [
  { id: "ws_mac", kind: "local", machineId: "local", name: "wsp" },
  { id: "ws_box", kind: "cloud", machineId: "m1", place: "pl_box", name: "wsp-box" },
] as unknown as WorkspaceView[];

const row = (over: Partial<SessionView> & Pick<SessionView, "id">): SessionView => ({ workspaceId: "ws_mac", harness: "claude", status: "running", prompt: `task ${over.id}`, startedAt: 1, ...over });

const input = (over: Partial<TrayInput> = {}): TrayInput => ({
  sessions: [],
  asks: new Map(),
  workspaces,
  places,
  host: { label: "zingzy's MacBook Pro", remote: false, lost: false },
  ...over,
});

const labels = (rows: readonly TrayRow[]): string[] => rows.map(r => (r.kind === "separator" ? "---" : r.label));
const threadRows = (rows: readonly TrayRow[]) => rows.filter((r): r is Extract<TrayRow, { kind: "thread" }> => r.kind === "thread");

describe("the menu bar's model", () => {
  it("counts the threads working in its title and says nothing when none is", () => {
    const idle = trayModel(input());
    expect(idle.title).toBe("");
    expect(idle.needsYou).toBe(false);
    expect(labels(idle.rows)).toEqual([TRAY_WORDS.nothing, "---", TRAY_WORDS.openApp, QUIT_WORD]);
    const busy = trayModel(input({ sessions: [row({ id: "s1", threadId: "t1" }), row({ id: "s2", threadId: "t2", workspaceId: "ws_box" }), row({ id: "s3", threadId: "t3", status: "completed", endedAt: 5, readAt: 6 })] }));
    expect(busy.title).toBe("2");
    expect(labels(busy.rows)[0]).toBe(TRAY_WORDS.working(2, 0));
  });

  it("lists a thread that waits on the person before the ones that work, marks the icon, and a finished one no longer", () => {
    const model = trayModel(
      input({
        sessions: [row({ id: "s1", threadId: "t_work", startedAt: 9 }), row({ id: "s2", threadId: "t_ask", asking: "Bash: sleep 5", startedAt: 1 }), row({ id: "s3", threadId: "t_old", status: "completed", endedAt: 5, readAt: 6 })],
      }),
    );
    expect(model.needsYou).toBe(true);
    expect(model.title).toBe("1");
    expect(threadRows(model.rows).map(r => r.threadId)).toEqual(["t_ask", "t_work"]);
    expect(labels(model.rows)[0]).toBe(TRAY_WORDS.working(1, 1));
  });

  it("names each row by its thread and the computer it runs on, by the name the tiles use", () => {
    const [mac, box] = threadRows(trayModel(input({ sessions: [row({ id: "s1", threadId: "t1", prompt: "fix login", startedAt: 2 }), row({ id: "s2", threadId: "t2", workspaceId: "ws_box", prompt: "ship it", startedAt: 1 })] })).rows);
    expect(mac).toMatchObject({ label: "fix login", sublabel: TRAY_WORDS.where("Working", "zingzy's MacBook Pro") });
    expect(box).toMatchObject({ label: "ship it", sublabel: TRAY_WORDS.where("Working", "spoo") });
  });

  it("offers Allow and Deny only while the row holds an open prompt, picking the options by their effect; a row without one has Open and Stop only", () => {
    const asks = new Map([["s2", { askId: "a1", options: [{ id: "o_yes", effect: "allow" as const }, { id: "o_mode", effect: "mode" as const }, { id: "o_no", effect: "deny" as const }] }]]);
    const [asking, working] = threadRows(trayModel(input({ asks, sessions: [row({ id: "s1", threadId: "t_work", harness: "codex" }), row({ id: "s2", threadId: "t_ask", asking: "Bash: sleep 5" })] })).rows);
    expect(asking!.actions).toEqual([
      { label: TRAY_WORDS.open, act: { kind: "open", threadId: "t_ask" } },
      { label: TRAY_WORDS.allow, act: { kind: "answer", sessionId: "s2", askId: "a1", optionId: "o_yes" } },
      { label: TRAY_WORDS.deny, act: { kind: "answer", sessionId: "s2", askId: "a1", optionId: "o_no" } },
      { label: TRAY_WORDS.stop, act: { kind: "stop", sessionId: "s2" } },
    ]);
    expect(working!.actions.map(a => a.label)).toEqual([TRAY_WORDS.open, TRAY_WORDS.stop]);
  });

  it("a prompt the menu never saw open, one that asked before it was listening, offers Open and Stop and still marks the icon", () => {
    const model = trayModel(input({ sessions: [row({ id: "s1", threadId: "t_ask", asking: "Bash: ls" })] }));
    expect(model.needsYou).toBe(true);
    expect(threadRows(model.rows)[0]!.actions.map(a => a.label)).toEqual([TRAY_WORDS.open, TRAY_WORDS.stop]);
  });

  it("on a host somewhere else the title and the first row name that host", () => {
    const model = trayModel(input({ host: { label: "spoo", remote: true, lost: false }, sessions: [row({ id: "s1", threadId: "t1", workspaceId: "ws_box" })] }));
    expect(model.title).toBe("spoo 1");
    expect(labels(model.rows)[0]).toBe(TRAY_WORDS.on("spoo"));
    expect(trayModel(input({ host: { label: "spoo", remote: true, lost: false } })).title).toBe("spoo");
  });

  it("a host that stopped answering is one row saying so, and on this computer a Start that brings it back", () => {
    const here = trayModel(input({ host: { label: "zingzy's MacBook Pro", remote: false, lost: true }, sessions: [row({ id: "s1", threadId: "t1" })] }));
    expect(here.title).toBe("");
    expect(labels(here.rows)).toEqual([TRAY_WORDS.notRunning, TRAY_WORDS.start, "---", TRAY_WORDS.openApp, QUIT_WORD]);
    expect(here.rows[1]).toMatchObject({ act: { kind: "start" } });
    const away = trayModel(input({ host: { label: "spoo", remote: true, lost: true } }));
    expect(labels(away.rows)).toEqual([TRAY_WORDS.unreached("spoo"), "---", TRAY_WORDS.openApp, QUIT_WORD]);
  });

  it("carries the count the dock reads, the threads waiting on the person, finishes nobody has seen included", () => {
    const model = trayModel(input({ sessions: [row({ id: "s1", threadId: "t_ask", asking: "Bash: ls" }), row({ id: "s2", threadId: "t_done", status: "completed", endedAt: 5 }), row({ id: "s3", threadId: "t_work" })] }));
    expect(model.badge).toBe(2);
  });

  it("a failure nobody has opened marks the icon as waiting on the person and stands as a row that opens it; once opened it goes", () => {
    const failed = row({ id: "s1", threadId: "t_failed", status: "failed", endedAt: 5 });
    const model = trayModel(input({ sessions: [failed] }));
    expect(model.needsYou).toBe(true);
    const [only] = threadRows(model.rows);
    expect(only).toMatchObject({ threadId: "t_failed", sublabel: TRAY_WORDS.where("Failed", "zingzy's MacBook Pro") });
    expect(only!.actions).toEqual([{ label: TRAY_WORDS.open, act: { kind: "open", threadId: "t_failed" } }]);
    const seen = trayModel(input({ sessions: [{ ...failed, readAt: 6 }] }));
    expect(seen.needsYou).toBe(false);
    expect(threadRows(seen.rows)).toEqual([]);
  });

  it("never names the parts of wsp a person does not see", () => {
    const every = [TRAY_WORDS.nothing, TRAY_WORDS.working(3, 2), TRAY_WORDS.notRunning, TRAY_WORDS.start, TRAY_WORDS.unreached("spoo"), TRAY_WORDS.on("spoo"), TRAY_WORDS.openApp, TRAY_WORDS.open, TRAY_WORDS.allow, TRAY_WORDS.deny, TRAY_WORDS.stop];
    for (const word of every) expect(word).not.toMatch(/host|daemon|service|session/i);
  });
});

describe("what the menu bar says over the system while no window is open", () => {
  const sessions = [row({ id: "s1", threadId: "t1", prompt: "fix login" }), row({ id: "s2", threadId: "t_agent", prompt: "sub task", startedBy: "agent" })];

  it("a finished turn says the thread finished and where, with the sound the person chose", () => {
    const done = { type: "session.done", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", result: { status: "completed" } } as const;
    expect(trayNotice(done, { sessions, workspaces, places }, true)).toEqual({ title: "fix login finished", body: "zingzy's MacBook Pro", sound: true });
    expect(trayNotice(done, { sessions, workspaces, places }, false)?.sound).toBe(false);
  });

  it("an agent's own thread reports to it, and a turn that did not complete says nothing", () => {
    expect(trayNotice({ type: "session.done", workspaceId: "ws_mac", sessionId: "s2", threadId: "t_agent", result: { status: "completed" } }, { sessions, workspaces, places }, true)).toBeUndefined();
    expect(trayNotice({ type: "session.done", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", result: { status: "interrupted" } }, { sessions, workspaces, places }, true)).toBeUndefined();
  });

  it("a turn that failed says the thread stopped with its error in one line, with the same sound", () => {
    const done = { type: "session.done", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", result: { status: "failed", error: "API Error: 529\n overloaded" } } as const;
    expect(trayNotice(done, { sessions, workspaces, places }, true)).toEqual({ title: "fix login stopped", body: "API Error: 529 overloaded", sound: true });
    expect(trayNotice(done, { sessions, workspaces, places }, false)?.sound).toBe(false);
  });

  // What every adapter sends as its process ends: its own result, a made-up one when the process died first, and
  // then the end with no result seen.
  const ending = (result: TurnResult, exitCode: number): SessionEvent[] => [
    { type: "session.done", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", result },
    { type: "session.end", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", exitCode, sawResult: false },
  ];
  const said = (events: SessionEvent[]) => events.flatMap(e => trayNotice(e, { sessions, workspaces, places }, true) ?? []);

  it("a process that died says its thread stopped once, and one somebody stopped says nothing", () => {
    expect(said(ending({ status: "failed", error: "claude exited with code 1" }, 1))).toEqual([{ title: "fix login stopped", body: "claude exited with code 1", sound: true }]);
    expect(said(ending({ status: "interrupted" }, 143))).toEqual([]);
  });

  it("an end the runtime gave its own reason, one that saw a result, an agent's thread and a turn somebody stopped say nothing", () => {
    const rows = { sessions, workspaces, places };
    expect(trayNotice({ type: "session.end", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", exitCode: null, sawResult: false, reason: "paused" }, rows, true)).toBeUndefined();
    expect(trayNotice({ type: "session.end", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", exitCode: 0, sawResult: true }, rows, true)).toBeUndefined();
    expect(trayNotice({ type: "session.done", workspaceId: "ws_mac", sessionId: "s2", threadId: "t_agent", result: { status: "failed", error: "x" } }, rows, true)).toBeUndefined();
    expect(trayNotice({ type: "session.done", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", result: { status: "interrupted" } }, rows, true)).toBeUndefined();
  });

  it("a prompt says what the thread asks", () => {
    const ask = { type: "session.permission", workspaceId: "ws_mac", sessionId: "s1", threadId: "t1", askId: "a1", toolName: "Bash", input: JSON.stringify({ command: "sleep 5" }), options: [] } as unknown as SessionPermissionEvent;
    const said = trayNotice(ask, { sessions, workspaces, places }, true);
    expect(said?.title).toBe(NEEDS_YOU);
    expect(said?.body).toContain("sleep 5");
  });
});
