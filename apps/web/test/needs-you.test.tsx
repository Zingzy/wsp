// SPDX-License-Identifier: AGPL-3.0-only
// What the app does with the job's needsYou field beyond the sidebar's row:
// the tab or window title leads with the mark while a need stands, and each
// need is said once outside the app on this shell's own road, and a machine
// that came up while the person looked away is said on that same road, as is
// a turn that finished, each as the person chose for its kind on General.
// The dock's badge counts the threads waiting on the person. Both roads run
// here against a stubbed Notification, a stubbed tone and a stubbed bridge;
// nothing real is shown and nothing makes a sound.
import { act, render } from "@testing-library/react";
import { DEFAULT_PREFERENCES, NEEDS_YOU, askingLine, initNeedsYouLine, workspaceAwakeLine, type InitNeedsYou, type NotifyChoice, type OutsideLine, type SessionView, type TurnResult } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { useSettingsStore } from "../src/settings/settingsStore.js";
import { useHostNotices } from "../src/notices/hostNotices.js";
import { askToNotify, needsYouRoad, resetAskedToNotify } from "../src/shell/needsYou.js";
import { clearNotices, lastNotice } from "./notice-text.js";

const NEED: InitNeedsYou = { what: "sign in to GitHub CLI login", since: 1_760_000_000_000 };

/** A Notification that records what it was built with and hands its click back. */
class FakeNotification {
  static built: { title: string; body: string; silent?: boolean }[] = [];
  static permission: NotificationPermission = "granted";
  static asked = 0;
  static requestPermission = vi.fn(async () => {
    FakeNotification.asked += 1;
    return FakeNotification.permission;
  });
  onclick: (() => void) | null = null;
  closed = 0;
  constructor(title: string, options?: { body?: string; silent?: boolean }) {
    FakeNotification.built.push({ title, body: options?.body ?? "", ...(options?.silent !== undefined ? { silent: options.silent } : {}) });
    FakeNotification.last = this;
  }
  static last: FakeNotification | undefined;
  close(): void {
    this.closed += 1;
  }
}

/** An AudioContext that counts the tones started on it and plays none. */
class FakeAudio {
  static tones = 0;
  currentTime = 0;
  destination = {};
  createOscillator() {
    const node = { frequency: { value: 0 }, onended: null as (() => void) | null, connect: (to: unknown) => to, start: () => void (FakeAudio.tones += 1), stop: () => {} };
    return node;
  }
  createGain() {
    return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: (to: unknown) => to };
  }
  close() {
    return Promise.resolve();
  }
}

let hidden = true;
beforeEach(() => {
  FakeAudio.tones = 0;
  vi.stubGlobal("AudioContext", FakeAudio);
  FakeNotification.built = [];
  FakeNotification.permission = "granted";
  FakeNotification.asked = 0;
  FakeNotification.last = undefined;
  FakeNotification.requestPermission.mockClear();
  hidden = true;
  resetAskedToNotify();
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("Notification", FakeNotification);
  document.title = "wsp";
  useStore.setState({ api: null, initJob: null, settingsOpen: false, sessions: {}, workspaces: [], preferences: DEFAULT_PREFERENCES });
  clearNotices();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete window.wsp;
});

/** The store bound to an api whose only job is to hand events back to the test. */
function bindEvents(): (e: ProtocolEvent) => void {
  const listeners = new Set<(e: ProtocolEvent) => void>();
  const api = {
    listWorkspaces: vi.fn(async () => []),
    watchStatuses: vi.fn(async () => []),
    capabilities: vi.fn(async () => ({ upgrade: false, snapshot: false })),
    getGolden: vi.fn(async () => ({ versions: [] })),
    subscribe: (fn: (e: ProtocolEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Api;
  useStore.getState().bind(api);
  return e => listeners.forEach(fn => fn(e));
}

function Harness() {
  useHostNotices();
  return null;
}

const JOB = { id: "init_1", road: "manual" as const, phase: "signing-in" as const, keys: { solari: true }, step: 0, stoppable: true, screens: [], rows: [], progress: { done: 1, total: 2 }, log: [] };

describe("the title while a build waits on the person", () => {
  it("leads with the mark while the job's need stands, drops it when the need goes, and never doubles it", () => {
    render(<Harness />);
    expect(document.title).toBe("wsp");
    act(() => useStore.setState({ initJob: { ...JOB, needsYou: NEED } }));
    expect(document.title).toBe("• wsp");
    // A second view of the same standing need leaves one mark, not two.
    act(() => useStore.setState({ initJob: { ...JOB, needsYou: { ...NEED, what: "sign in to Claude Code login" } } }));
    expect(document.title).toBe("• wsp");
    act(() => useStore.setState({ initJob: JOB }));
    expect(document.title).toBe("wsp");
  });

  it("the wait ending takes the notice and the mark together, so no surface is left saying it alone", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED }));
    act(() => emit({ type: "init.job", job: { ...JOB, needsYou: NEED } }));
    expect([lastNotice(), document.title]).toEqual([initNeedsYouLine(NEED.what), "• wsp"]);
    // The row moved on: one view with no need on it drops the wait at once.
    act(() => emit({ type: "init.job", job: JOB }));
    expect([lastNotice(), document.title]).toEqual([null, "wsp"]);
    // And the job ending after a need that was never answered leaves nothing behind either.
    act(() => emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED }));
    act(() => emit({ type: "init.job", job: { ...JOB, phase: "done" } }));
    expect(document.title).toBe("wsp");
  });
});

describe("a browser tab's road out of the app", () => {
  it("asks for leave on a press, at most once a page, and never on load", () => {
    render(<Harness />);
    FakeNotification.permission = "default";
    expect(FakeNotification.asked).toBe(0);
    // The press that opens the setup is the gesture a browser wants; a second press asks nothing again.
    askToNotify();
    expect(FakeNotification.asked).toBe(1);
    askToNotify();
    expect(FakeNotification.asked).toBe(1);
  });

  it("a build already running when the page loaded asks too, since that page saw no press, and the answer already given is not asked for again", () => {
    const emit = bindEvents();
    render(<Harness />);
    FakeNotification.permission = "default";
    emit({ type: "init.job", job: { ...JOB, phase: "answering", rows: [], progress: { done: 0, total: 0 } } });
    expect(FakeNotification.asked, "the screens are not a build").toBe(0);
    emit({ type: "init.job", job: { ...JOB, phase: "building" } });
    expect(FakeNotification.asked).toBe(1);
    emit({ type: "init.job", job: { ...JOB, phase: "signing-in" } });
    expect(FakeNotification.asked).toBe(1);
    // Leave already granted or refused is never asked about again, whatever fires ready.
    resetAskedToNotify();
    FakeNotification.permission = "denied";
    askToNotify();
    expect(FakeNotification.asked).toBe(1);
  });

  it("a shell that owns its own notifications is never asked for the browser's leave", () => {
    window.wsp = { sayOutside: () => {}, onNeedsYouOpen: () => () => {} };
    FakeNotification.permission = "default";
    askToNotify();
    expect(FakeNotification.asked).toBe(0);
  });

  it("says the need with the app's name and a sound while the tab is hidden, as a thread that needs the person is said, and a click focuses the tab and opens Computers, where the build's card is", () => {
    const emit = bindEvents();
    render(<Harness />);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: "sign in to GitHub CLI login", silent: false }]);
    expect(useStore.getState().settingsOpen).toBe(false);
    FakeNotification.last!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(FakeNotification.last!.closed).toBe(1);
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "computers" });
    focus.mockRestore();
  });

  it("says nothing while the tab is the one in front of the person, and nothing without permission", () => {
    const emit = bindEvents();
    render(<Harness />);
    hidden = false;
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(FakeNotification.built).toEqual([]);
    hidden = true;
    FakeNotification.permission = "denied";
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(FakeNotification.built).toEqual([]);
  });
});


describe("a thread stopped on a permission prompt while the person looked away", () => {
  const ASKED = {
    type: "session.permission" as const,
    workspaceId: "ws_1",
    sessionId: "s1",
    turnId: "turn_1",
    threadId: "thr_1",
    askId: "ask_1",
    toolName: "Bash",
    detail: "Check wsp version",
    input: '{"command":"wsp --version"}',
    options: [{ id: "allow", label: "Allow", effect: "allow" as const }],
  };

  it("says what the thread is waiting on, on the same road as a build's need, and a click opens that thread", () => {
    const emit = bindEvents();
    render(<Harness />);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => emit(ASKED));
    // A prompt is said as the person chose for a thread that needs them, notify and sound until they pick otherwise.
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: askingLine(ASKED), silent: false }]);
    FakeNotification.last!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_1", "thr_1"]);
    focus.mockRestore();
  });

  it("says nothing while the app is the thing in front of the person", () => {
    const emit = bindEvents();
    render(<Harness />);
    hidden = false;
    act(() => emit(ASKED));
    expect(FakeNotification.built).toEqual([]);
  });

  it("says it as the person chose: nothing on off, no sound on notify, and a tone with nothing shown on sound", () => {
    const emit = bindEvents();
    render(<Harness />);
    const needs = (notifyNeeds: NotifyChoice) => act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, notifyNeeds } }));
    needs("off");
    act(() => emit(ASKED));
    act(() => emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED }));
    expect(FakeNotification.built).toEqual([]);
    needs("notify");
    act(() => emit(ASKED));
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: askingLine(ASKED), silent: true }]);
    needs("sound");
    act(() => emit(ASKED));
    expect(FakeNotification.built).toHaveLength(1);
    expect(FakeAudio.tones).toBe(1);
  });
});

describe("a machine that came up while the person looked away", () => {
  const WOKEN = { id: "ws_1", name: "b1", machineId: "m1", phase: "running" as const, golden: "snap_g", createdAt: "2026-09-10T00:00:00Z", project: { id: "pr_api", name: "the-project", path: "/root", computer: "default" } };

  it("says the workspace is awake once the person hears finishes, as a finish is said, and a click opens that workspace", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => useStore.setState({ workspaces: [WOKEN], selectedId: null, preferences: { ...DEFAULT_PREFERENCES, notifyDone: "notify" } }));
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1" }));
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: workspaceAwakeLine("b1"), silent: true }]);
    FakeNotification.last!.onclick!();
    expect(focus).toHaveBeenCalled();
    // The click lands on the machine that came up, not on the build screen a need's click opens.
    expect([useStore.getState().selectedId, useStore.getState().settingsOpen]).toEqual(["ws_1", false]);
    focus.mockRestore();
  });

  it("says nothing while the app is the thing in front of the person", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => useStore.setState({ workspaces: [WOKEN] }));
    hidden = false;
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1" }));
    expect(FakeNotification.built).toEqual([]);
  });

  it("follows When a thread finishes, not what needs the person: nothing by default, nothing with needs off, a sound where finishes sound", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => useStore.setState({ workspaces: [WOKEN] }));
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1" }));
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, notifyNeeds: "off", notifyDone: "notify-sound" } }));
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1" }));
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: workspaceAwakeLine("b1"), silent: false }]);
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, notifyNeeds: "notify-sound", notifyDone: "off" } }));
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_1", machineId: "m1" }));
    expect(FakeNotification.built).toHaveLength(1);
  });
  it("says nothing about a workspace this page never knew", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => emit({ type: "workspace.woken", workspaceId: "ws_gone", machineId: "m9" }));
    expect(FakeNotification.built).toEqual([]);
  });
});

describe("the desktop shell's road out of the app", () => {
  it("hands the need to the shell rather than showing anything itself, since only the shell can read its window's focus", () => {
    const said: OutsideLine[] = [];
    const handlers: (() => void)[] = [];
    window.wsp = {
      sayOutside: line => said.push(line),
      onNeedsYouOpen: handler => {
        handlers.push(handler);
        return () => {};
      },
    };
    const emit = bindEvents();
    render(<Harness />);
    emit({ type: "job.needs-you", jobId: "init_1", needsYou: NEED });
    expect(said).toEqual([{ title: NEEDS_YOU, body: NEED.what, show: true, sound: true }]);
    // The browser's own notifications are never used where a shell owns them.
    expect(FakeNotification.built).toEqual([]);
    // The shell's click comes back over the bridge and opens Computers here.
    expect(useStore.getState().settingsOpen).toBe(false);
    handlers[0]!();
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "computers" });
  });

  it("a shell too old to take a need falls back to the browser's own road, so nothing is silently dropped", () => {
    window.wsp = { setTheme: () => {} };
    const road = needsYouRoad(() => {});
    road.say({ title: NEEDS_YOU, body: NEED.what, show: true, sound: false });
    expect(FakeNotification.built).toEqual([{ title: NEEDS_YOU, body: "sign in to GitHub CLI login", silent: true }]);
    road.close();
    expect(FakeNotification.last!.closed).toBe(1);
  });
});

describe("a turn that finished while the person looked away", () => {
  const WS = { id: "ws_1", name: "b1", machineId: "m1", phase: "running" as const, golden: "snap_g", createdAt: "2026-09-10T00:00:00Z", project: { id: "pr_api", name: "the-project", path: "/root", computer: "default" } };
  const turn = (over: Partial<SessionView> = {}): SessionView =>
    ({ id: "s1", workspaceId: "ws_1", threadId: "thr_1", prompt: "Fix the redirect", harness: "claude", status: "completed", startedBy: "cli", startedAt: 1_000, endedAt: 2_000, readAt: 500, ...over }) as SessionView;
  const finish = (emit: (e: ProtocolEvent) => void, status: "completed" | "interrupted" = "completed", threadId = "thr_1") => {
    emit({ type: "session.done", workspaceId: "ws_1", sessionId: "s1", turnId: `turn_${threadId}`, threadId, result: { status, text: "done" } });
    emit({ type: "session.end", workspaceId: "ws_1", sessionId: "s1", turnId: `turn_${threadId}`, threadId, exitCode: 0, sawResult: true });
  };

  const finishes = (notifyDone: NotifyChoice) => act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, notifyDone } }));

  it("says nothing for a finished thread by default, since ten running threads would ping ten times", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => useStore.setState({ workspaces: [WS], sessions: { ws_1: [turn()] } }));
    act(() => finish(emit));
    act(() => fail(emit));
    expect(FakeNotification.built).toEqual([]);
  });

  it("says which thread finished with a sound once the person picks notify and sound, silent on notify alone, and a click opens that thread", () => {
    const emit = bindEvents();
    render(<Harness />);
    finishes("notify-sound");
    act(() => useStore.setState({ workspaces: [WS], sessions: { ws_1: [turn()] } }));
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => finish(emit));
    expect(FakeNotification.built).toEqual([{ title: "Fix the redirect finished", body: "b1", silent: false }]);
    FakeNotification.last!.onclick!();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_1", "thr_1"]);
    finishes("notify");
    act(() => finish(emit));
    expect(FakeNotification.built.at(-1)).toEqual({ title: "Fix the redirect finished", body: "b1", silent: true });
    focus.mockRestore();
  });

  it("says nothing for a turn somebody stopped, for a thread an agent opened, or while the app is in front", () => {
    const emit = bindEvents();
    render(<Harness />);
    finishes("notify-sound");
    act(() => useStore.setState({ workspaces: [WS], sessions: { ws_1: [turn(), turn({ id: "s2", threadId: "thr_child", startedBy: "agent", parentThreadId: "thr_1" })] } }));
    act(() => finish(emit, "interrupted"));
    act(() => finish(emit, "completed", "thr_child"));
    hidden = false;
    act(() => finish(emit));
    expect(FakeNotification.built).toEqual([]);
  });

  // What every adapter sends as its process ends: its own result, a made-up one when the process died first, and then
  // the end with no result seen.
  const ending = (emit: (e: ProtocolEvent) => void, result: TurnResult, o: { exitCode?: number; reason?: string; threadId?: string } = {}) => {
    const threadId = o.threadId ?? "thr_1";
    emit({ type: "session.done", workspaceId: "ws_1", sessionId: "s1", turnId: `turn_${threadId}`, threadId, result });
    emit({ type: "session.end", workspaceId: "ws_1", sessionId: "s1", turnId: `turn_${threadId}`, threadId, exitCode: o.exitCode ?? 1, sawResult: false, ...(o.reason !== undefined ? { reason: o.reason } : {}) });
  };
  const fail = (emit: (e: ProtocolEvent) => void, o: { error?: string; reason?: string; threadId?: string } = {}) => ending(emit, { status: "failed", ...(o.error !== undefined ? { error: o.error } : {}) }, o);

  it("says a thread that failed stopped, with its error in one line, as a finish is said, and a click opens that thread", () => {
    const emit = bindEvents();
    render(<Harness />);
    finishes("notify-sound");
    act(() => useStore.setState({ workspaces: [WS], sessions: { ws_1: [turn({ status: "failed" })] } }));
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => fail(emit, { error: "API Error: 529 overloaded\n  retry later" }));
    expect(FakeNotification.built).toEqual([{ title: "Fix the redirect stopped", body: "API Error: 529 overloaded retry later", silent: false }]);
    FakeNotification.last!.onclick!();
    expect([useStore.getState().selectedId, useStore.getState().selectedThreadId]).toEqual(["ws_1", "thr_1"]);
    finishes("notify");
    act(() => fail(emit));
    expect(FakeNotification.built.at(-1)).toEqual({ title: "Fix the redirect stopped", body: "exit 1", silent: true });
    expect(FakeNotification.built).toHaveLength(2);
    focus.mockRestore();
  });

  it("says nothing for a turn somebody stopped, whose process the stop killed before it replied", () => {
    const emit = bindEvents();
    render(<Harness />);
    finishes("notify-sound");
    act(() => useStore.setState({ workspaces: [WS], sessions: { ws_1: [turn({ status: "interrupted" })] } }));
    act(() => ending(emit, { status: "interrupted" }, { exitCode: 143 }));
    expect(FakeNotification.built).toEqual([]);
  });

  it("says nothing for a failure the runtime ended itself, for a thread an agent opened, or while the app is in front", () => {
    const emit = bindEvents();
    render(<Harness />);
    finishes("notify-sound");
    act(() => useStore.setState({ workspaces: [WS], sessions: { ws_1: [turn({ status: "failed" }), turn({ id: "s2", threadId: "thr_child", startedBy: "agent", parentThreadId: "thr_1", status: "failed" })] } }));
    act(() => fail(emit, { reason: "the machine went away" }));
    act(() => fail(emit, { threadId: "thr_child" }));
    hidden = false;
    act(() => fail(emit));
    expect(FakeNotification.built).toEqual([]);
  });

  it("puts the count of threads waiting on the person on the dock, and it drops as one is opened", () => {
    const badge: number[] = [];
    // A bridge whose call answers something is still only told: nothing the page does waits on it or keeps it.
    window.wsp = { sayOutside: () => {}, onNeedsYouOpen: () => () => {}, setBadge: ((count: number) => badge.push(count)) as unknown as (count: number) => void };
    render(<Harness />);
    const asks = turn({ id: "s3", threadId: "thr_asks", status: "running", endedAt: undefined, asking: "Permission for Bash: ls" });
    act(() => useStore.setState({ sessions: { ws_1: [turn(), asks, turn({ id: "s4", threadId: "thr_read", readAt: 3_000 })] } }));
    expect(badge.at(-1)).toBe(2);
    act(() => useStore.setState({ sessions: { ws_1: [turn({ readAt: 2_000 }), asks] } }));
    expect(badge.at(-1)).toBe(1);
    act(() => useStore.setState({ sessions: {} }));
    expect(badge.at(-1)).toBe(0);
  });
});

describe("an account's plan running low", () => {
  const LOW = { type: "usage.alert" as const, key: "claude:acct_1", agent: "claude", label: "Claude Max", alert: { kind: "low" as const, window: "week" as const, step: 70 } };

  it("is a notice that opens Usage and a notification with no sound while the person looks away", () => {
    const emit = bindEvents();
    render(<Harness />);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    act(() => emit(LOW));
    expect(lastNotice()).toBe("Claude Max has used 70% of its week");
    expect(FakeNotification.built).toEqual([{ title: "Claude Max has used 70% of its week", body: "", silent: true }]);
    FakeNotification.last!.onclick!();
    expect(useStore.getState().settingsOpen).toBe(true);
    expect(useSettingsStore.getState().at).toEqual({ kind: "group", group: "usage" });
    focus.mockRestore();
  });

  it("says a block and a comeback the same way, and nothing at all once the switch is off", () => {
    const emit = bindEvents();
    render(<Harness />);
    act(() => emit({ ...LOW, alert: { kind: "blocked" } }));
    expect(lastNotice()).toBe("Claude Max reached its plan limit");
    act(() => emit({ ...LOW, alert: { kind: "back" } }));
    expect(lastNotice()).toBe("Claude Max can run again: its plan limit reset");
    clearNotices();
    act(() => useStore.setState({ preferences: { ...DEFAULT_PREFERENCES, planAlerts: false } }));
    act(() => emit(LOW));
    expect(lastNotice()).toBeNull();
    expect(FakeNotification.built).toHaveLength(2);
  });
});
