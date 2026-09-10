import { describe, expect, it } from "vitest";
import {
  WORKSPACE_GLYPHS,
  lookWord,
  Recipe,
  RecipeSource,
  Capabilities,
  GoldenVersion,
  DAEMON_ROOTS_PATH,
  rootsPathIn,
  DAEMON_VERSION,
  daemonVersionOf,
  DaemonAuthRequest,
  DaemonErrorCode,
  DaemonErrorResponse,
  DaemonEvent,
  DaemonReachView,
  DaemonRequest,
  DaemonResponse,
  EventUnion,
  EventsSubscribeReply,
  FsListReply,
  FsReadReply,
  GitDiffReply,
  GitStatusReply,
  GoldenManifest,
  GoldenStageEvent,
  goldenHead,
  goldenImage,
  HarnessCatalog,
  HostFolderListing,
  contextWindowsFor,
  effortsFor,
  keepsRename,
  mcpServersBlocked,
  noMcpServersLine,
  takesMcpServers,
  markedDefault,
  PortReachView,
  ProjectExportEvent,
  ProjectExportResult,
  ProjectGolden,
  ProjectImportResult,
  ProjectPlan,
  RuntimeErrorResponse,
  RuntimeRequest,
  RuntimeResponse,
  SESSION_EVENT_TYPES,
  isSessionEvent,
  SessionAccessResult,
  SessionAnswerResult,
  SessionEvent,
  SessionInterruptResult,
  SessionSteerResult,
  SessionStartResult,
  SnapshotLineage,
  SnapshotRollbackResult,
  SessionOrigin,
  SessionView,
  ThreadView,
  ExecEvent,
  foldThreads,
  NOTIFY_ME,
  WorkspaceStatus,
  WorkspaceView,
} from "../src/index.js";

import * as wire from "../src/index.js";

describe("the recipe's pins", () => {
  it("a recipe row and a digest tick carry one pin shape, the tag and the sum, beside the tick's road and install lines", () => {
    const pin = { tag: "v2.86.0", sha256: "b".repeat(64) };
    expect(wire.ToolPin.parse(pin)).toEqual(pin);
    expect(wire.ToolPin.safeParse({ tag: "v2.86.0" }).success).toBe(false);
    const row = { id: "gh", kind: "tool", on: true, source: { kind: "popular", sessions: 1, images: 1 }, pin };
    expect(wire.RecipeRow.parse(row)).toEqual(row);
    const tick = { id: "tools/catalog/gh", road: "release", installer: "a".repeat(64), pin };
    expect(wire.RecipeDigest.parse({ ticks: [tick, { id: "agents/claude" }], files: [] })).toEqual({ ticks: [tick, { id: "agents/claude" }], files: [] });
  });
});

describe("protocol views", () => {
  it("parses a WorkspaceView and rejects a bad phase", () => {
    const ws = {
      id: "ws_1",
      name: "task-1",
      machineId: "m1",
      phase: "running",
      golden: "snap_g",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    expect(WorkspaceView.parse(ws)).toEqual(ws);
    expect(() => WorkspaceView.parse({ ...ws, phase: "hibernating" })).toThrow();
  });

  it("parses a SessionView", () => {
    const s = {
      id: "0b6a9c1e-0000-4000-8000-000000000000",
      workspaceId: "ws_1",
      harness: "claude",
      status: "running",
    };
    expect(SessionView.parse(s)).toEqual(s);
    expect(() => SessionView.parse({ ...s, status: "done" })).toThrow();
  });

  it("WorkspaceView and WorkspaceStatus carry the desktop stream as screen.streamUrl, absent for headless machines", () => {
    const view = {
      id: "ws_1",
      name: "task-1",
      machineId: "m1",
      phase: "running",
      golden: "snap_g",
      createdAt: "2026-09-01T00:00:00.000Z",
      screen: { streamUrl: "wss://stream.example/m1" },
    };
    expect(WorkspaceView.parse(view)).toEqual(view);
    expect(WorkspaceView.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
    const { screen, ...headless } = view;
    void screen;
    expect(WorkspaceView.parse(headless)).toEqual(headless);
    expect(() => WorkspaceView.parse({ ...view, screen: {} })).toThrow();

    const status = { ...view, machineState: "running", reach: { state: "unsupported" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.11 };
    expect(WorkspaceStatus.parse(status)).toEqual(status);
  });
});

describe("a workspace's look", () => {
  const view = { id: "ws_1", name: "task-1", machineId: "m1", phase: "running", golden: "snap_g", createdAt: "2026-09-01T00:00:00.000Z" };
  const theme = { dots: [{ angle: 200, radius: 0.5 }, { angle: 20, radius: 0.5 }], harmony: "complementary", grain: 0.25, opacity: 0.6, mode: "auto" };

  it("about two dozen glyphs, each one word so its name needs no second table, and none of them an emoji", () => {
    expect(WORKSPACE_GLYPHS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(WORKSPACE_GLYPHS).size).toBe(WORKSPACE_GLYPHS.length);
    for (const glyph of WORKSPACE_GLYPHS) expect(glyph).toMatch(/^[a-z]+$/);
    expect(lookWord("terminal")).toBe("Terminal");
  });

  it("the view carries the theme and the glyph, absent is none, and a theme outside the shape is refused", () => {
    expect(WorkspaceView.parse(view)).toEqual(view);
    const looked = { ...view, theme, glyph: "flask" };
    expect(WorkspaceView.parse(looked)).toEqual(looked);
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, dots: [] } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, dots: [...theme.dots, ...theme.dots] } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, opacity: 0 } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, grain: 2 } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, theme: { ...theme, mode: "sepia" } })).toThrow();
    expect(() => WorkspaceView.parse({ ...view, tint: "cyan" })).not.toThrow();
    expect(WorkspaceView.parse({ ...view, tint: "cyan" })).toEqual(view);
    expect(() => WorkspaceView.parse({ ...view, glyph: "🚀" })).toThrow();
  });

  it("the op takes one fact at a time, null to clear it, and refuses a theme outside the shape", () => {
    for (const req of [
      { id: 1, op: "workspaces.look", workspaceId: "ws_1", theme },
      { id: 2, op: "workspaces.look", workspaceId: "ws_1", glyph: null },
      { id: 3, op: "workspaces.look", workspaceId: "ws_1", theme: null, glyph: "rocket" },
      { id: 4, op: "workspaces.look", workspaceId: "ws_1" },
    ]) {
      expect(RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(() => RuntimeRequest.parse({ id: 5, op: "workspaces.look", workspaceId: "ws_1", theme: "red" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 6, op: "workspaces.look", theme })).toThrow();
  });

  it("the event carries both facts whole, so a cleared one reads null rather than going missing", () => {
    const e = { type: "workspace.look", workspaceId: "ws_1", theme, glyph: null };
    expect(EventUnion.parse(e)).toEqual(e);
    expect(() => EventUnion.parse({ type: "workspace.look", workspaceId: "ws_1", theme })).toThrow();
  });
});

describe("protocol event union", () => {
  it("covers workspace.*, session.* (mirroring AdapterEvent), port.*, inbox.*", () => {
    const samples = [
      {
        type: "workspace.created",
        workspace: {
          id: "ws_1",
          name: "x",
          machineId: "m1",
          phase: "running",
          golden: "snap_g",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      },
      { type: "workspace.napped", workspaceId: "ws_1" },
      { type: "workspace.woken", workspaceId: "ws_1", machineId: "m2", resurrected: true },
      { type: "workspace.upgraded", workspaceId: "ws_1", machineId: "m3" },
      { type: "workspace.deleted", workspaceId: "ws_1" },
      { type: "session.start", workspaceId: "ws_1", sessionId: "s1", model: "claude-sonnet-4-5" },
      { type: "session.delta", workspaceId: "ws_1", sessionId: "s1", kind: "text", text: "hi" },
      {
        type: "session.delta",
        workspaceId: "ws_1",
        sessionId: "s1",
        kind: "tool_use",
        text: "{}",
        toolName: "Bash",
        toolUseId: "tu_1",
      },
      {
        type: "session.done",
        workspaceId: "ws_1",
        sessionId: "s1",
        result: { status: "completed", durationMs: 1200, costUsd: 0.01, text: "ok" },
      },
      { type: "session.end", workspaceId: "ws_1", sessionId: "s1", exitCode: 0, sawResult: true },
      { type: "port.open", workspaceId: "ws_1", port: 8080, pid: 123 },
      { type: "port.close", workspaceId: "ws_1", port: 8080 },
      { type: "inbox.file", workspaceId: "ws_1", path: "/root/inbox/a.png", bytes: 168 },
    ];
    for (const s of samples) expect(EventUnion.parse(s)).toEqual(s);
    expect(() => EventUnion.parse({ type: "workspace.exploded" })).toThrow();
    // session.start may carry the prompt so a replayed transcript shows the user's turn
    const started = { type: "session.start", workspaceId: "ws_1", sessionId: "s1", prompt: "fix the flaky test" };
    expect(EventUnion.parse(started)).toEqual(started);
    expect(SessionEvent.parse(started)).toEqual(started);
    expect(() => SessionEvent.parse({ type: "workspace.napped", workspaceId: "ws_1" })).toThrow();
    // session.end with a null exit code (kill path) is valid
    expect(
      EventUnion.parse({ type: "session.end", workspaceId: "w", sessionId: "s", exitCode: null, sawResult: false }),
    ).toBeTruthy();
  });

  it("session.steer is a session event: the message the person sent into a running turn, with the turn's scope and the send's request id", () => {
    const steered = { type: "session.steer", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0001", threadId: "thread_0001", at: 1756687889412, prompt: "and say pineapple", requestId: "req_7" };
    expect(SessionEvent.parse(steered)).toEqual(steered);
    expect(EventUnion.parse(JSON.parse(JSON.stringify(steered)))).toEqual(steered);
    expect(EventUnion.parse({ ...steered, seq: 9 })).toEqual({ ...steered, seq: 9 });
    const { requestId: _r, ...plain } = steered;
    expect(SessionEvent.parse(plain)).toEqual(plain);
    expect(() => SessionEvent.parse({ ...steered, prompt: undefined })).toThrow();
    expect(() => SessionEvent.parse({ ...steered, prompt: 7 })).toThrow();
  });
});

describe("a relayed permission prompt on the wire", () => {
  const ask = {
    type: "session.permission",
    workspaceId: "ws_1",
    sessionId: "s1",
    turnId: "turn_0001",
    threadId: "thread_0001",
    at: 1757320000000,
    askId: "d9aa99d3-be4e-4a2b-8766-1b9494cde4f6",
    toolName: "Write",
    toolUseId: "toolu_1",
    input: '{"file_path":"/root/out.txt","content":"hi"}',
    detail: "out.txt",
    options: [
      { id: "allow", label: "Allow", effect: "allow" },
      { id: "deny", label: "Deny", effect: "deny" },
      { id: "mode:acceptEdits", label: "Allow, then Accept edits", effect: "mode", mode: "acceptEdits" },
    ],
    waitMs: 300_000,
  };
  const closed = { type: "session.permission.closed", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0001", threadId: "thread_0001", at: 1757320005000, askId: ask.askId, outcome: "allowed", optionId: "allow" };

  it("both halves are session events, so a transcript replays a prompt and how it closed", () => {
    for (const e of [ask, closed]) {
      expect(SessionEvent.parse(e)).toEqual(e);
      expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
      expect(EventUnion.parse({ ...e, seq: 12 })).toEqual({ ...e, seq: 12 });
    }
    // Every session type is read off the union, so an added event is never missed by a client's own list.
    expect([...SESSION_EVENT_TYPES]).toContain("session.permission");
    expect([...SESSION_EVENT_TYPES]).toContain("session.permission.closed");
    expect(SESSION_EVENT_TYPES.has("session.queued" as never)).toBe(false);
    // The one predicate every reader that folds a thread's events out of the whole channel makes.
    expect(isSessionEvent(ask)).toBe(true);
    expect(isSessionEvent({ type: "workspace.napped" })).toBe(false);
  });

  it("a prompt with nothing the harness did not name still parses, and one missing what it must name does not", () => {
    const { detail: _d, toolUseId: _t, waitMs: _w, ...bare } = ask;
    expect(SessionEvent.parse(bare)).toEqual(bare);
    for (const key of ["askId", "toolName", "input", "options"] as const) {
      expect(() => SessionEvent.parse({ ...ask, [key]: undefined })).toThrow();
    }
    expect(() => SessionEvent.parse({ ...ask, options: [{ id: "allow", label: "Allow", effect: "maybe" }] })).toThrow();
  });

  it("a close names its outcome from the four, and the option only where one closed it", () => {
    for (const outcome of ["allowed", "denied", "unanswered", "cancelled"]) expect(SessionEvent.parse({ ...closed, outcome })).toMatchObject({ outcome });
    expect(() => SessionEvent.parse({ ...closed, outcome: "timedout" })).toThrow();
    const { optionId: _o, ...noOption } = closed;
    expect(SessionEvent.parse(noOption)).toEqual(noOption);
    expect(() => SessionEvent.parse({ ...closed, askId: undefined })).toThrow();
  });

  it("the answer op and its outcomes are on the wire, so a client can name an option and read what came of it", () => {
    const req = { id: 31, op: "sessions.answer", sessionId: "s1", askId: ask.askId, optionId: "allow" };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ ...req, askId: undefined })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, optionId: undefined })).toThrow();
    for (const outcome of ["answered", "gone", "unsupported", "not-found", "no-option"]) {
      expect(SessionAnswerResult.parse({ outcome })).toEqual({ outcome });
    }
    expect(() => SessionAnswerResult.parse({ outcome: "denied" })).toThrow();
  });

  it("the access op and its outcomes are on the wire, so a pick made mid-turn can be sent and its answer read", () => {
    const req = { id: 32, op: "sessions.access", sessionId: "s1", permissionMode: "bypassPermissions" };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ ...req, permissionMode: undefined })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, sessionId: undefined })).toThrow();
    for (const outcome of ["set", "not-running", "unsupported", "not-found"]) {
      expect(SessionAccessResult.parse({ outcome })).toEqual({ outcome });
    }
    expect(() => SessionAccessResult.parse({ outcome: "refused" })).toThrow();
  });
});

describe("session.queued", () => {
  it("is a pushed event, not a session event: a start waiting behind the thread's running turn, with the send's request id, never in history", () => {
    const queued = { type: "session.queued", workspaceId: "ws_1", threadId: "thread_0001", prompt: "and then this", requestId: "req_8" };
    expect(EventUnion.parse(queued)).toEqual(queued);
    expect(EventUnion.parse({ ...queued, seq: 4 })).toEqual({ ...queued, seq: 4 });
    const { requestId: _r, ...plain } = queued;
    expect(EventUnion.parse(plain)).toEqual(plain);
    expect(() => EventUnion.parse({ ...queued, prompt: undefined })).toThrow();
    expect(() => EventUnion.parse({ ...queued, threadId: undefined })).toThrow();
    expect(() => SessionEvent.parse(queued)).toThrow();
  });
});

describe("session wire fields the face reads", () => {
  it("every session event may carry at (ms epoch) and turnId; both survive a JSON round trip", () => {
    const scope = { workspaceId: "ws_1", sessionId: "s1", at: 1756687889412, turnId: "turn_0001" };
    const events = [
      { type: "session.start", ...scope, prompt: "hello" },
      { type: "session.delta", ...scope, kind: "text", text: "hi" },
      { type: "session.done", ...scope, result: { status: "completed" } },
      { type: "session.end", ...scope, exitCode: 0, sawResult: true },
    ];
    for (const e of events) {
      expect(SessionEvent.parse(e)).toEqual(e);
      expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
    }
    expect(() => SessionEvent.parse({ ...events[0], at: "2026-09-01T00:00:00Z" })).toThrow();
    expect(() => SessionEvent.parse({ ...events[0], turnId: 7 })).toThrow();
  });

  it("every session event may carry a threadId; a transcript without one still parses", () => {
    const scope = { workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0001", threadId: "thread_0001" };
    const events = [
      { type: "session.start", ...scope, prompt: "hello" },
      { type: "session.delta", ...scope, kind: "text", text: "hi" },
      { type: "session.done", ...scope, result: { status: "completed" } },
      { type: "session.end", ...scope, exitCode: 0, sawResult: true },
    ];
    for (const e of events) {
      expect(SessionEvent.parse(e)).toEqual(e);
      expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
      const { threadId: _threadId, ...before } = e;
      expect(SessionEvent.parse(before)).toEqual(before);
    }
    expect(() => SessionEvent.parse({ ...events[0], threadId: 7 })).toThrow();
  });

  it("session.start carries the harness catalog from system/init", () => {
    const started = {
      type: "session.start",
      workspaceId: "ws_1",
      sessionId: "s1",
      harness: { slashCommands: ["compact", "review"], permissionMode: "bypassPermissions", agents: ["general-purpose"] },
    };
    expect(SessionEvent.parse(started)).toEqual(started);
    const partial = { ...started, harness: { permissionMode: "default" } };
    expect(SessionEvent.parse(partial)).toEqual(partial);
    expect(() => SessionEvent.parse({ ...started, harness: { slashCommands: "compact" } })).toThrow();
  });

  it("session.start may say the thread's previous turn was cut, and only as true: the fact is stated or absent", () => {
    const started = { type: "session.start", workspaceId: "ws_1", sessionId: "s1", afterCut: true };
    expect(SessionEvent.parse(started)).toEqual(started);
    expect(() => SessionEvent.parse({ ...started, afterCut: false })).toThrow();
  });

  it("SessionView carries prompt, startedAt and endedAt so the sidebar can title and sort threads", () => {
    const running = {
      id: "0b6a9c1e-0000-4000-8000-000000000000",
      workspaceId: "ws_1",
      harness: "claude",
      status: "running",
      prompt: "fix the flaky test",
      startedAt: 1756687889412,
    };
    expect(SessionView.parse(running)).toEqual(running);
    const ended = { ...running, status: "completed", endedAt: 1756687899870 };
    expect(SessionView.parse(ended)).toEqual(ended);
    expect(() => SessionView.parse({ ...running, startedAt: "soon" })).toThrow();
  });

  it("port.open names the listening process on both the daemon and runtime wires", () => {
    const daemonSide = { type: "port.open", port: 8080, pid: 123, process: "node" };
    expect(DaemonEvent.parse(daemonSide)).toEqual(daemonSide);
    const runtimeSide = { ...daemonSide, workspaceId: "ws_1" };
    expect(EventUnion.parse(runtimeSide)).toEqual(runtimeSide);
    expect(() => DaemonEvent.parse({ ...daemonSide, process: 1 })).toThrow();
  });

  it("port.close may say who held the port, whether it exited and when, on both wires", () => {
    const daemonSide = { type: "port.close", port: 8412, pid: 53479, process: "python3", command: "python3 -m http.server 8412", exited: true, at: "2026-09-05T12:04:00.000Z" };
    expect(DaemonEvent.parse(daemonSide)).toEqual(daemonSide);
    const runtimeSide = { ...daemonSide, workspaceId: "ws_1" };
    expect(EventUnion.parse(runtimeSide)).toEqual(runtimeSide);
    expect(DaemonEvent.parse({ type: "port.close", port: 8412 })).toEqual({ type: "port.close", port: 8412 });
    expect(() => DaemonEvent.parse({ ...daemonSide, exited: "yes" })).toThrow();
  });
});

describe("event replay wire fields", () => {
  it("every event may carry seq, a positive integer that survives a JSON round trip; history events need not", () => {
    const events = [
      { type: "workspace.napped", workspaceId: "ws_1", seq: 1 },
      { type: "workspace.status", status: { id: "ws_1", name: "x", machineId: "m1", phase: "running", golden: "g", createdAt: "t", machineState: "running", reach: { state: "unsupported" }, size: { cpu: 2, memMb: 4096 }, rateUsdPerHour: 0.1 }, seq: 2 },
      { type: "session.delta", workspaceId: "ws_1", sessionId: "s1", kind: "text", text: "hi", seq: 3 },
      { type: "port.open", workspaceId: "ws_1", port: 8080, seq: 4 },
      { type: "golden.stage", name: "default", stage: "ready", seq: 5 },
    ];
    for (const e of events) expect(EventUnion.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
    const { seq, ...unstamped } = events[0]!;
    void seq;
    expect(EventUnion.parse(unstamped)).toEqual(unstamped);
    expect(() => EventUnion.parse({ ...events[0], seq: 0 })).toThrow();
    expect(() => EventUnion.parse({ ...events[0], seq: 1.5 })).toThrow();
    expect(() => EventUnion.parse({ ...events[0], seq: "1" })).toThrow();
    const history = { type: "session.delta", workspaceId: "ws_1", sessionId: "s1", kind: "text", text: "hi" };
    expect(SessionEvent.parse(history)).toEqual(history);
  });

  it("events.subscribe takes an optional after cursor, a non-negative integer", () => {
    const bare = { id: 1, op: "events.subscribe" };
    const cursor = { id: 2, op: "events.subscribe", after: 41 };
    const start = { id: 3, op: "events.subscribe", after: 0 };
    const resumed = { id: 4, op: "events.subscribe", after: 41, stream: "0b6a9c1e-0000-4000-8000-000000000000" };
    for (const r of [bare, cursor, start, resumed]) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ ...bare, stream: 7 })).toThrow();
    expect(() => RuntimeRequest.parse({ ...bare, after: -1 })).toThrow();
    expect(() => RuntimeRequest.parse({ ...bare, after: 2.5 })).toThrow();
    expect(() => RuntimeRequest.parse({ ...bare, after: "41" })).toThrow();
  });

  it("the subscribe reply names the runtime's head and stream and, when the cursor is gone, gap", () => {
    expect(EventsSubscribeReply.parse({ seq: 0 })).toEqual({ seq: 0 });
    const stamped = { seq: 5002, gap: true, stream: "0b6a9c1e-0000-4000-8000-000000000000" };
    expect(EventsSubscribeReply.parse(JSON.parse(JSON.stringify(stamped)))).toEqual(stamped);
    expect(() => EventsSubscribeReply.parse({ seq: 1, stream: 7 })).toThrow();
    expect(() => EventsSubscribeReply.parse({ seq: 5002, gap: false })).toThrow();
    expect(() => EventsSubscribeReply.parse({ gap: true })).toThrow();
    expect(RuntimeResponse.parse({ id: 1, ok: true, seq: 7, gap: true })).toBeTruthy();
  });
});

describe("daemon wire types (one home for the ops from @wsp/daemon)", () => {
  it("parses requests, responses, and push events", () => {
    const reqs = [
      { id: 1, op: "pty.create", cols: 80, rows: 24, shell: "bash" },
      { id: 2, op: "pty.attach", ptyId: "p1" },
      { id: 3, op: "pty.write", ptyId: "p1", data: "ls\n" },
      { id: 4, op: "pty.resize", ptyId: "p1", cols: 100, rows: 30 },
      { id: 5, op: "pty.kill", ptyId: "p1" },
      { id: 6, op: "pty.list" },
      { id: 7, op: "ports.watch" },
      { id: 8, op: "manifest.get" },
      { id: 9, op: "manifest.record", cmd: "pnpm dev", cwd: "/root/app", port: 3000 },
      { id: 10, op: "manifest.restartScript" },
      { id: 11, op: "inbox.watch" },
      { id: 12, op: "inbox.rescan" },
      { id: 13, op: "ping" },
    ];
    for (const r of reqs) expect(DaemonRequest.parse(r)).toEqual(r);
    expect(() => DaemonRequest.parse({ id: 1, op: "pty.explode" })).toThrow();

    expect(DaemonResponse.parse({ id: 1, ok: true, ptyId: "p1", pid: 42 })).toBeTruthy();
    expect(DaemonResponse.parse({ id: 1, ok: false, error: "no such pty" })).toBeTruthy();

    const events = [
      { type: "daemon.hello", root: "/root" },
      { type: "pty.data", ptyId: "p1", data: "hello" },
      { type: "pty.exit", ptyId: "p1", exitCode: 0, signal: undefined },
      { type: "port.open", port: 8080, pid: 12 },
      { type: "port.close", port: 8080 },
      { type: "inbox.file", path: "/root/inbox/x.png", bytes: 10 },
    ];
    for (const e of events) expect(DaemonEvent.parse(e)).toBeTruthy();
    expect(() => DaemonEvent.parse({ type: "daemon.hello" })).toThrow();
  });

  it("the hello carries the daemon's version; one without is the first version, as every daemon deployed before the field", () => {
    expect(DAEMON_VERSION).toBeGreaterThanOrEqual(2);
    const current = DaemonEvent.parse({ type: "daemon.hello", root: "/root", version: DAEMON_VERSION });
    expect(current).toEqual({ type: "daemon.hello", root: "/root", version: DAEMON_VERSION });
    expect(daemonVersionOf(current as { version?: number })).toBe(DAEMON_VERSION);
    expect(daemonVersionOf(DaemonEvent.parse({ type: "daemon.hello", root: "/root" }) as { version?: number })).toBe(1);
    expect(() => DaemonEvent.parse({ type: "daemon.hello", root: "/root", version: "2" })).toThrow();
    // No client asks for a daemon update: the runtime reads the hello on its own connect and replaces an old daemon itself.
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.updateDaemon", workspaceId: "ws_a" })).toThrow();
  });
});

describe("backend capabilities", () => {
  it("requires every flag, containers, callbackRelay, templates, kept and the sizes list included, so no backend can leave one unstated", () => {
    const full = { liveCloneForks: true, ramPreservingPause: true, resize: false, previewUrls: true, signedUrls: true, containers: false, callbackRelay: true, snapshotListing: true, templates: true, kept: false, sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.11 }] };
    expect(Capabilities.parse(full)).toEqual(full);
    const { containers: _c, ...missing } = full;
    expect(() => Capabilities.parse(missing)).toThrow();
    const { templates: _t, ...noTemplates } = full;
    expect(() => Capabilities.parse(noTemplates)).toThrow();
    const { callbackRelay: _r, ...noRelay } = full;
    expect(() => Capabilities.parse(noRelay)).toThrow();
    // A backend that never says whether its machine is the person's own would have every turn's access decided for it.
    const { kept: _k, ...noKept } = full;
    expect(() => Capabilities.parse(noKept)).toThrow();
    const { sizes: _s, ...noSizes } = full;
    expect(() => Capabilities.parse(noSizes)).toThrow();
    expect(() => Capabilities.parse({ ...full, sizes: [{ cpu: 2, memMb: 4096 }] })).toThrow();
  });
});

describe("runtime wire types", () => {
  it("parses the client ops serveRuntime dispatches", () => {
    const reqs = [
      { id: 1, op: "auth", token: "t" },
      { id: 2, op: "ticket.issue", purpose: "connect" },
      { id: 3, op: "events.subscribe" },
      { id: 4, op: "workspaces.create", golden: "snap_g", name: "x", cpu: 2 },
      { id: 5, op: "workspaces.list" },
      { id: 6, op: "workspaces.get", workspaceId: "ws_1" },
      { id: 7, op: "workspaces.nap", workspaceId: "ws_1" },
      { id: 8, op: "workspaces.wake", workspaceId: "ws_1" },
      { id: 9, op: "workspaces.upgrade", workspaceId: "ws_1", cpu: 4 },
      { id: 10, op: "workspaces.delete", workspaceId: "ws_1" },
      { id: 11, op: "sessions.start", workspaceId: "ws_1", prompt: "do the thing" },
      { id: 12, op: "sessions.list" },
      { id: 13, op: "golden.get", name: "default" },
      { id: 14, op: "capabilities.get" },
      { id: 15, op: "sessions.history", workspaceId: "ws_1" },
      { id: 16, op: "workspaces.daemonReach", workspaceId: "ws_1" },
      { id: 17, op: "golden.prepare", name: "default" },
      { id: 18, op: "golden.prepare", name: "default", kind: "desktop" },
      { id: 19, op: "golden.seal", builderId: "m1" },
      { id: 20, op: "golden.builderReach", builderId: "m1" },
      { id: 21, op: "sessions.interrupt", sessionId: "s1" },
      { id: 22, op: "workspaces.forget", workspaceId: "ws_1" },
    ];
    for (const r of reqs) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ id: 21, op: "sessions.interrupt" })).toThrow(); // sessionId required
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.create" })).toThrow(); // golden+name required
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.prepare", name: "d", kind: "browser" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.seal" })).toThrow(); // builderId required
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.builderReach" })).toThrow();
    expect(RuntimeResponse.parse({ id: 4, ok: true, workspace: { id: "w" } })).toBeTruthy();
    expect(RuntimeResponse.parse({ id: 4, ok: false, error: "nope" })).toBeTruthy();
  });

  it("every request carries where it reached the host from, on the envelope and not per op", () => {
    const relayed = [
      { id: 1, op: "workspaces.list", origin: "relayed" },
      { id: 2, op: "workspaces.nap", workspaceId: "ws_1", origin: "relayed" },
      { id: 3, op: "sessions.start", workspaceId: "ws_1", prompt: "go", origin: "relayed" },
      { id: 4, op: "workspaces.exec", workspaceId: "ws_1", argv: ["ls"], origin: "here" },
    ];
    for (const r of relayed) expect(RuntimeRequest.parse(r)).toEqual(r);
    // A client on this computer names none, and nothing is added to what it sent.
    expect(RuntimeRequest.parse({ id: 5, op: "workspaces.list" })).toEqual({ id: 5, op: "workspaces.list" });
    expect(() => RuntimeRequest.parse({ id: 6, op: "workspaces.list", origin: "machine" })).toThrow();
  });

  it("sessions.start carries the composer's model, effort and permission mode as the harness's own slugs", () => {
    const picked = { id: 22, op: "sessions.start", workspaceId: "ws_1", prompt: "go", model: "claude-opus-5", effort: "high", permissionMode: "acceptEdits", contextWindow: "1m" };
    expect(RuntimeRequest.parse(picked)).toEqual(picked);
    const { model: _m, effort: _e, permissionMode: _p, contextWindow: _c, ...bare } = picked;
    expect(RuntimeRequest.parse(bare)).toEqual(bare);
    expect(() => RuntimeRequest.parse({ ...picked, effort: 3 })).toThrow();
    expect(RuntimeRequest.parse({ id: 23, op: "harnesses.list" })).toEqual({ id: 23, op: "harnesses.list" });
    expect(RuntimeRequest.parse({ id: 23, op: "harnesses.list", workspaceId: "ws_1" })).toEqual({ id: 23, op: "harnesses.list", workspaceId: "ws_1" });
  });

  it("a harness catalog lists what each picker may offer, says where the lists came from, and a model may narrow them", () => {
    const catalog = {
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.257",
      models: [{ value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] }, { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] }],
      efforts: [{ value: "high", label: "High", isDefault: true }],
      contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
      permissionModes: [{ value: "plan", label: "Plan", description: "Read and plan only" }],
      steers: true,
      renames: true,
      images: true,
    };
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    expect(HarnessCatalog.parse({ ...catalog, isDefault: true })).toEqual({ ...catalog, isDefault: true });
    const bare = { harness: "pi", label: "Pi", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false };
    expect(HarnessCatalog.parse(bare)).toEqual(bare);
    // steers says whether a running turn of this harness takes a message; the composer decides send-now from it before the click
    expect(() => HarnessCatalog.parse({ ...catalog, steers: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, steers: "yes" })).toThrow();
    // renames says whether a name of a person's survives in the harness's own store; a client offers the rename from it
    expect(() => HarnessCatalog.parse({ ...catalog, renames: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, renames: "yes" })).toThrow();
    // images says whether a message to this harness may carry one; the composer offers its picker from it
    expect(() => HarnessCatalog.parse({ ...catalog, images: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, images: "yes" })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, models: [{ value: "x" }] })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, efforts: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, source: "guess" })).toThrow();
    const { source: _s, version: _v, contextWindows: _w, ...old } = catalog;
    expect(() => HarnessCatalog.parse(old)).toThrow();
  });

  it("whether a rename is kept is the adapter's answer: a row the runtime's table stood in for is no answer, never a no", () => {
    const row = (over: Partial<HarnessCatalog>): HarnessCatalog => ({
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.263",
      models: [],
      efforts: [],
      contextWindows: [],
      permissionModes: [],
      steers: true,
      renames: true,
      images: true,
      ...over,
    });
    expect(keepsRename(row({}))).toBe(true);
    // The machine answered no: no client offers the rename.
    expect(keepsRename(row({ renames: false }))).toBe(false);
    // The table stood in, so nobody has asked the machine yet: the client offers it and the runtime answers.
    expect(keepsRename(row({ source: "table", renames: false }))).toBe(true);
    expect(keepsRename(null)).toBe(true);
    expect(keepsRename(undefined)).toBe(true);
    // Whether a launch may carry MCP servers is not the machine's answer but this host's adapter, so a table row is
    // the answer and absent is a no: a client offering an agent whose launch drops them is the fault, not the fix.
    expect(takesMcpServers(row({ mcpServers: true }))).toBe(true);
    expect(takesMcpServers(row({ source: "table", mcpServers: true }))).toBe(true);
    expect(takesMcpServers(row({}))).toBe(false);
    expect(takesMcpServers(row({ mcpServers: false }))).toBe(false);
    expect(takesMcpServers(null)).toBe(false);
    expect(takesMcpServers(undefined)).toBe(false);
  });

  it("servers named for an agent whose adapter renders none are refused in that agent's name, and naming none is never refused", () => {
    const wsp = { wsp: { command: "/usr/local/bin/node", args: ["/opt/wsp/bin.js", "mcp"] } };
    expect(mcpServersBlocked(wsp, undefined, "Codex")).toBe(noMcpServersLine("Codex"));
    expect(mcpServersBlocked(wsp, true, "Claude Code")).toBeNull();
    expect(mcpServersBlocked(undefined, undefined, "Codex")).toBeNull();
    expect(mcpServersBlocked({}, undefined, "Codex")).toBeNull();
    expect(noMcpServersLine("Codex")).toContain("Codex");
  });

  it("a model without its own lists takes the catalog's; a model with lists narrows them in the catalog's order; the marked default is one option or none", () => {
    const catalog: HarnessCatalog = {
      harness: "claude",
      label: "Claude Code",
      source: "harness",
      version: "2.1.257",
      models: [
        { value: "claude-opus-5", label: "Opus 5", isDefault: true, contextWindows: ["200k", "1m"] },
        { value: "claude-sonnet-5", label: "Sonnet 5", contextWindows: [] },
        { value: "claude-haiku-4-5", label: "Haiku", efforts: [], contextWindows: [] },
        { value: "claude-next", label: "Next", efforts: ["high"] },
      ],
      efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
      contextWindows: [{ value: "200k", label: "200k" }, { value: "1m", label: "1M", isDefault: true }],
      permissionModes: [{ value: "plan", label: "Plan" }],
      steers: true,
      renames: true,
      images: true,
    };
    expect(effortsFor(catalog, catalog.models[0]!).map(o => o.value)).toEqual(["low", "high"]);
    expect(effortsFor(catalog, catalog.models[3]!).map(o => o.value)).toEqual(["high"]);
    expect(effortsFor(catalog, catalog.models[2]!)).toEqual([]);
    expect(effortsFor(catalog, null)).toEqual(catalog.efforts);
    expect(contextWindowsFor(catalog, catalog.models[0]!).map(o => o.value)).toEqual(["200k", "1m"]);
    expect(contextWindowsFor(catalog, catalog.models[1]!)).toEqual([]);
    expect(contextWindowsFor(catalog, catalog.models[3]!).map(o => o.value)).toEqual(["200k", "1m"]);
    expect(contextWindowsFor(catalog, null)).toEqual([]);
    expect(markedDefault(catalog.models)?.value).toBe("claude-opus-5");
    expect(markedDefault(catalog.contextWindows)?.value).toBe("1m");
    expect(markedDefault(catalog.permissionModes)).toBeUndefined();
    expect(markedDefault([])).toBeUndefined();
  });

  it("SessionView records the model, effort, permission mode and context window the session runs with", () => {
    const view = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running", model: "claude-opus-5", effort: "high", permissionMode: "bypassPermissions", contextWindow: "1m" };
    expect(SessionView.parse(view)).toEqual(view);
    expect(() => SessionView.parse({ ...view, model: 5 })).toThrow();
  });

  it("sessions.interrupt answers one of three outcomes, none of them an error reply", () => {
    for (const outcome of ["accepted", "not-running", "not-found"]) expect(SessionInterruptResult.parse({ outcome })).toEqual({ outcome });
    expect(() => SessionInterruptResult.parse({ outcome: "stopped" })).toThrow();
    expect(() => SessionInterruptResult.parse({})).toThrow();
    expect(RuntimeResponse.parse({ id: 21, ok: true, outcome: "not-running" })).toBeTruthy();
  });

  it("sessions.steer carries the message for the running turn and answers one of four outcomes", () => {
    const steer = { id: 24, op: "sessions.steer", sessionId: "s1", prompt: "also check the tests", requestId: "req_2" };
    expect(RuntimeRequest.parse(steer)).toEqual(steer);
    const { requestId: _r, ...plain } = steer;
    expect(RuntimeRequest.parse(plain)).toEqual(plain);
    expect(() => RuntimeRequest.parse({ id: 24, op: "sessions.steer", sessionId: "s1" })).toThrow(); // prompt required
    expect(() => RuntimeRequest.parse({ id: 24, op: "sessions.steer", prompt: "x" })).toThrow(); // sessionId required
    for (const outcome of ["accepted", "not-running", "unsupported", "not-found"]) expect(SessionSteerResult.parse({ outcome })).toEqual({ outcome });
    expect(() => SessionSteerResult.parse({ outcome: "queued" })).toThrow();
    expect(() => SessionSteerResult.parse({})).toThrow();
  });

  it("sessions.start answers the session and how the start went: started, steered into the running turn, or queued behind it", () => {
    const session = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "running" };
    for (const outcome of ["started", "steered", "queued"]) expect(SessionStartResult.parse({ session, outcome, turnId: "t1" })).toEqual({ session, outcome, turnId: "t1" });
    expect(() => SessionStartResult.parse({ session, outcome: "accepted", turnId: "t1" })).toThrow();
    expect(() => SessionStartResult.parse({ session, turnId: "t1" })).toThrow();
    expect(() => SessionStartResult.parse({ session, outcome: "started" })).toThrow();
    expect(() => SessionStartResult.parse({ outcome: "started", turnId: "t1" })).toThrow();
  });

  it("snapshots.list / snapshots.rollback parse, and SnapshotLineage is the manifest plus its name", () => {
    const list = { id: 20, op: "snapshots.list" };
    const named = { id: 21, op: "snapshots.list", name: "default" };
    const roll = { id: 22, op: "snapshots.rollback", version: 11 };
    for (const r of [list, named, roll]) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ id: 23, op: "snapshots.rollback" })).toThrow(); // version required
    const version = {
      version: 11,
      snapshotId: "snap_golden-v11",
      baseTemplate: "base",
      setupSha: "abc",
      createdAt: "2026-08-14T00:00:00.000Z",
      smoke: { cmd: "claude --version", exitCode: 0 },
    };
    const lineage = { name: "default", head: 11, versions: [version] };
    expect(SnapshotLineage.parse(lineage)).toEqual(lineage);
    expect(SnapshotLineage.parse({ name: "default", head: null, versions: [] })).toEqual({ name: "default", head: null, versions: [] });
    const rolled = { lineage, existingWorkspaces: "untouched" };
    expect(SnapshotRollbackResult.parse(rolled)).toEqual(rolled);
    expect(() => SnapshotRollbackResult.parse({ lineage, existingWorkspaces: "upgraded" })).toThrow();
  });

  it("workspaces.portReach names the workspace and one guest port; PortReachView is the route without the daemon token", () => {
    const req = { id: 21, op: "workspaces.portReach", workspaceId: "ws_1", port: 3000 };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ id: 21, op: "workspaces.portReach", workspaceId: "ws_1" })).toThrow();
    for (const port of [0, 65536, 30.5]) expect(() => RuntimeRequest.parse({ ...req, port })).toThrow();
    const reach = { url: "https://m-3000.preview.example/?pt_token=edge", expiresAt: 1_700_000_000_000 };
    expect(PortReachView.parse(reach)).toEqual(reach);
    expect(PortReachView.parse({ ...reach, daemonToken: "d" })).toEqual(reach);
    expect(() => PortReachView.parse({ url: "x" })).toThrow();
  });

  it("DaemonReachView carries the preview route, its expiry, and the daemon token when the guest has one", () => {
    const full = { url: "https://m-7070.preview.example/?pt_token=edge", expiresAt: 1_700_000_000_000, daemonToken: "d" };
    expect(DaemonReachView.parse(full)).toEqual(full);
    const bare = { url: "https://m-7070.preview.example/?pt_token=edge", expiresAt: 1 };
    expect(DaemonReachView.parse(bare)).toEqual(bare);
    expect(() => DaemonReachView.parse({ url: "x" })).toThrow();
  });
});

describe("golden wire schemas", () => {
  it("golden.stage rides the event union with a closed stage enum and an optional detail", () => {
    const e = { type: "golden.stage", name: "default", stage: "smoke-forking", detail: "claude --version" };
    expect(EventUnion.parse(e)).toEqual(e);
    expect(GoldenStageEvent.parse({ type: "golden.stage", name: "default", stage: "sealed" })).toBeTruthy();
    expect(() => GoldenStageEvent.parse({ type: "golden.stage", name: "default", stage: "vibing" })).toThrow();
    for (const stage of ["applying-setup", "uploading-files", "installing-tools"]) {
      expect(GoldenStageEvent.parse({ type: "golden.stage", name: "default", stage, detail: "3 files" })).toMatchObject({ stage });
    }
  });

  it("a golden.stage frame may name the install step it belongs to, with the command a person reads for it", () => {
    const step = { label: "mongosh", command: "npm install -g mongosh" };
    const e = { type: "golden.stage", name: "default", stage: "installing-tools", detail: "mongosh (24/30)", step };
    expect(EventUnion.parse(e)).toEqual(e);
    expect(() => GoldenStageEvent.parse({ ...e, step: { label: "mongosh" } })).toThrow();
  });

  it("a manifest sealed before kind was recorded still parses; new ones carry the kind", () => {
    const old = { version: 1, snapshotId: "snap_a", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };
    const parsed = GoldenManifest.parse({ head: 2, versions: [old, { ...old, version: 2, kind: "desktop" }] });
    expect(parsed.versions[0]!.kind).toBeUndefined();
    expect(parsed.versions[1]!.kind).toBe("desktop");
  });

  it("error replies may carry a typed kind", () => {
    expect(RuntimeErrorResponse.parse({ id: 1, ok: false, error: "refused", kind: "notFirstLife" }).kind).toBe("notFirstLife");
  });
});

describe("daemon auth frame", () => {
  it("carries the token and, for a socket meant for one guest port, that port", () => {
    expect(DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t" })).toEqual({ id: 1, op: "auth", token: "t" });
    expect(DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: 3000 })).toEqual({ id: 1, op: "auth", token: "t", port: 3000 });
    expect(() => DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: 0 })).toThrow();
    expect(() => DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: 65536 })).toThrow();
    expect(() => DaemonAuthRequest.parse({ id: 1, op: "auth", token: "t", port: "3000" })).toThrow();
    expect(DaemonErrorCode.parse("forbidden")).toBe("forbidden");
  });
});

describe("daemon files and diff ops", () => {
  it("parses the four requests and refuses a bad scope or encoding", () => {
    const reqs = [
      { id: 1, op: "fs.list", path: "src", gitignore: true },
      { id: 2, op: "fs.read", path: "src/index.ts", encoding: "base64" },
      { id: 3, op: "git.status", cwd: "." },
      { id: 4, op: "git.diff", cwd: ".", scope: "branch", path: "src" },
    ];
    for (const r of reqs) expect(DaemonRequest.parse(r)).toEqual(r);
    expect(() => DaemonRequest.parse({ id: 5, op: "git.diff", cwd: ".", scope: "all" })).toThrow();
    expect(() => DaemonRequest.parse({ id: 6, op: "fs.read", path: "x", encoding: "hex" })).toThrow();
    expect(() => DaemonRequest.parse({ id: 7, op: "fs.list", path: 7 })).toThrow();
  });

  it("parses the typed replies", () => {
    const list = { entries: [{ name: "a.ts", type: "file", size: 12, mtime: 1_700_000_000_000 }], truncated: false, total: 1 };
    expect(FsListReply.parse(list)).toEqual(list);
    expect(() => FsListReply.parse({ entries: [{ ...list.entries[0], type: "socket" }], truncated: false, total: 1 })).toThrow();
    expect(() => FsListReply.parse({ entries: list.entries, truncated: false })).toThrow();
    const read = { content: "aGk=", size: 2, truncated: false };
    expect(FsReadReply.parse(read)).toEqual(read);
    const status = {
      branch: { oid: "abc", head: "main", upstream: "origin/main", ahead: 1, behind: 0 },
      entries: [
        { xy: ".M", path: "a.ts" },
        { xy: "R.", path: "b.ts", origPath: "old.ts" },
        { xy: "??", path: "new.ts" },
      ],
      root: "/root/app",
    };
    expect(GitStatusReply.parse(status)).toEqual(status);
    const diff = { base: "main", files: [{ path: "a.ts", patch: "diff --git a/a.ts b/a.ts\n" }], truncated: true };
    expect(GitDiffReply.parse(diff)).toEqual(diff);
  });

  it("carries a typed error code on refusals", () => {
    const err = { id: 1, ok: false, error: "path escapes the workspace root", code: "outside-root" };
    expect(DaemonErrorResponse.parse(err)).toEqual(err);
    expect(DaemonResponse.parse(err)).toEqual(err);
    expect(DaemonErrorResponse.parse({ id: 1, ok: false, error: "plain" })).toEqual({ id: 1, ok: false, error: "plain" });
    expect(() => DaemonErrorResponse.parse({ ...err, code: "whatever" })).toThrow();
  });

  it("names the roots file beside a home, and the guest's is that rule answered at /root", () => {
    expect(rootsPathIn("/root")).toBe("/root/.wsp/roots");
    // The value, not the expression: the runtime writes this exact path into a guest and DAEMON_CONTENT_SHA hashes it,
    // so a home-derived answer that moved it would redeploy every machine or reach none.
    expect(DAEMON_ROOTS_PATH).toBe("/root/.wsp/roots");
    expect(DAEMON_ROOTS_PATH).toBe(rootsPathIn("/root"));
    expect(rootsPathIn("/Users/z")).toBe("/Users/z/.wsp/roots");
    expect(rootsPathIn("/Users/z/")).toBe("/Users/z/.wsp/roots");
    expect(rootsPathIn("/")).toBe("/.wsp/roots");
  });
});

describe("golden version logins", () => {
  const base = { version: 1, snapshotId: "snap_1", baseTemplate: "base", setupSha: "x", createdAt: "t", smoke: { cmd: "true", exitCode: 0 } };
  it("carries name and state per login when the seal was given them, and stays optional for older versions", () => {
    const logins = [{ name: "GitHub CLI login", state: "signed-in" }, { name: "Codex login", state: "skipped" }];
    expect(GoldenVersion.parse({ ...base, logins })).toEqual({ ...base, logins });
    expect(GoldenVersion.parse(base).logins).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, logins: [{ name: "x", state: "done" }] })).toThrow();
  });

  it("carries the tools missing from the image with the cause and reason, and stays optional for versions sealed before", () => {
    const missingTools = [{ id: "tools/brew/gopls", name: "gopls", outcome: "skipped", note: "no Linux bottle" }, { id: "tools/homebrew", name: "Homebrew", outcome: "failed", note: "git: not found" }];
    expect(GoldenVersion.parse({ ...base, missingTools })).toEqual({ ...base, missingTools });
    expect(GoldenVersion.parse(base).missingTools).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ id: "tools/brew/gopls", name: "gopls", note: "no Linux bottle" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ name: "gopls", outcome: "skipped", note: "no Linux bottle" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ id: "tools/brew/gopls", name: "gopls", outcome: "installed", note: "" }] })).toThrow();
  });

  it("carries what the pack left off the image by row, path and note, and stays optional for versions sealed before", () => {
    const leftBehind = [{ id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" }];
    expect(GoldenVersion.parse({ ...base, leftBehind })).toEqual({ ...base, leftBehind });
    expect(GoldenVersion.parse(base).leftBehind).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, leftBehind: [{ id: "agents/claude", note: "hook left behind: x" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, leftBehind: ["hook left behind: x"] })).toThrow();
  });
});

describe("goldenImage", () => {
  it("boots a version from its template once one is recorded and gives it no word; a version with none boots from its snapshot and is volatile", () => {
    expect(goldenImage({ snapshotId: "snap_a", templateId: "tpl_a" })).toEqual({ spec: { template: "tpl_a" }, marks: [] });
    expect(goldenImage({ snapshotId: "snap_a" })).toEqual({ spec: { fromSnapshot: "snap_a" }, marks: ["volatile"] });
  });

  it("a version record takes an optional templateId and parses without one, as every version sealed before templates did", () => {
    const v = { version: 1, snapshotId: "snap_a", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };
    expect(wire.GoldenVersion.parse(v).templateId).toBeUndefined();
    expect(wire.GoldenVersion.parse({ ...v, templateId: "tpl_a" }).templateId).toBe("tpl_a");
    expect(wire.GoldenStage.options).toContain("promoting");
  });
});

describe("goldenHead", () => {
  const v1: GoldenVersion = { version: 1, snapshotId: "snap_1", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } };

  it("is nothing without a manifest", () => {
    expect(goldenHead(undefined)).toBeUndefined();
  });

  it("is nothing when the head names a version the manifest lacks", () => {
    expect(goldenHead({ head: 2, versions: [v1] })).toBeUndefined();
  });

  it("is the version the head names", () => {
    const v2: GoldenVersion = { ...v1, version: 2, snapshotId: "snap_2" };
    expect(goldenHead({ head: 2, versions: [v1, v2] })).toBe(v2);
  });
});

describe("thread provenance", () => {
  const row = { id: "s1", workspaceId: "ws_1", harness: "claude", status: "completed" } as const;

  it("SessionView carries who asked for the turn, person, cli or agent, and stays optional for rows written before", () => {
    expect(SessionView.parse({ ...row, startedBy: "cli" }).startedBy).toBe("cli");
    expect(SessionView.parse({ ...row, startedBy: "agent" }).startedBy).toBe("agent");
    expect(SessionView.parse(row).startedBy).toBeUndefined();
    expect(() => SessionView.parse({ ...row, startedBy: "robot" })).toThrow();
    expect(SessionOrigin.options).toEqual(["person", "cli", "agent"]);
  });

  it("sessions.start takes startedBy and nothing else new", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", startedBy: "cli" })).toMatchObject({ startedBy: "cli" });
    expect(() => RuntimeRequest.parse({ id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", startedBy: "app" })).toThrow();
  });

  it("sessions.start may name who its thread's ends are told, one target or several, each a thread id or me; session.notify carries the line to one of them in the ending thread's transcript", () => {
    const req = { id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "build it", notify: ["thread_parent_0001"] };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(RuntimeRequest.parse({ ...req, notify: [NOTIFY_ME, "thread_reviewer_0001"] })).toEqual({ ...req, notify: ["me", "thread_reviewer_0001"] });
    // One target is a list of one, never a bare string, and a list of none names nobody rather than the person.
    expect(() => RuntimeRequest.parse({ ...req, notify: "thread_parent_0001" })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, notify: [] })).toThrow();
    expect(() => RuntimeRequest.parse({ ...req, notify: 7 })).toThrow();
    // The token a turn's launch carries, which is what me is read against.
    expect(RuntimeRequest.parse({ ...req, turnToken: "a".repeat(32) })).toEqual({ ...req, turnToken: "a".repeat(32) });
    expect(() => RuntimeRequest.parse({ ...req, turnToken: 7 })).toThrow();
    const told = { type: "session.notify", workspaceId: "ws_1", sessionId: "s1", turnId: "turn_0002", threadId: "thread_child_0001", at: 1756687889412, notify: "thread_parent_0001", text: "thread thread_c finished (completed, 8m 12s, $1.94): all green" };
    expect(SessionEvent.parse(told)).toEqual(told);
    expect(EventUnion.parse(JSON.parse(JSON.stringify(told)))).toEqual(told);
    expect(EventUnion.parse({ ...told, seq: 12 })).toEqual({ ...told, seq: 12 });
    expect(() => SessionEvent.parse({ ...told, notify: undefined })).toThrow();
    expect(() => SessionEvent.parse({ ...told, text: undefined })).toThrow();
  });

  it("sessions.start may carry the client's request id, and session.start carries it back, so a client tells its own start from another's with the same prompt", () => {
    const req = { id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", requestId: "req_1" };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    expect(() => RuntimeRequest.parse({ ...req, requestId: 7 })).toThrow();
    const started = { type: "session.start", workspaceId: "ws_1", sessionId: "s1", prompt: "go", requestId: "req_1" };
    expect(SessionEvent.parse(started)).toEqual(started);
    expect(EventUnion.parse(JSON.parse(JSON.stringify(started)))).toEqual(started);
    const { requestId: _requestId, ...none } = started;
    expect(SessionEvent.parse(none)).toEqual(none);
  });

  it("foldThreads groups turns by threadId, titles by the opening turn, reads state, row id and resume id from the latest, and keeps the opener's provenance", () => {
    const threads = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", startedBy: "cli", prompt: "make a server", claudeSessionId: "c1", startedAt: 1_000, endedAt: 2_000 },
      { ...row, id: "s2", threadId: "thr_b", prompt: "unrelated", startedAt: 3_000, endedAt: 4_000 },
      { ...row, id: "s3", threadId: "thr_a", status: "running", startedBy: "person", prompt: "and tests", claudeSessionId: "c2", startedAt: 5_000 },
      { ...row, id: "s4", status: "failed", prompt: "before threads", startedAt: 6_000, endedAt: 7_000 },
    ]);
    expect(threads).toEqual([
      { id: "thr_a", threadId: "thr_a", workspaceId: "ws_1", harness: "claude", startedBy: "cli", status: "running", title: "make a server", sessionId: "s3", claudeSessionId: "c2", startedAt: 5_000, turns: 2 },
      { id: "thr_b", threadId: "thr_b", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "completed", title: "unrelated", sessionId: "s2", startedAt: 3_000, endedAt: 4_000, turns: 1 },
      { id: "s4", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "failed", title: "before threads", sessionId: "s4", startedAt: 6_000, endedAt: 7_000, turns: 1 },
    ]);
    for (const t of threads) expect(ThreadView.parse(t)).toEqual(t);
  });

  it("foldThreads carries the latest turn's folder, so every director shows where the thread works; a row without one shows none", () => {
    const [worked, bare] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", prompt: "make a server", cwd: "/root/work/proj" },
      { ...row, id: "s2", threadId: "thr_a", prompt: "and tests", cwd: "/root/work/proj/packages" },
      { ...row, id: "s3", threadId: "thr_b", prompt: "no folder" },
    ]);
    expect(worked!.cwd).toBe("/root/work/proj/packages");
    expect(bare).not.toHaveProperty("cwd");
    expect(ThreadView.parse(worked!).cwd).toBe("/root/work/proj/packages");
  });

  it("foldThreads titles a thread by its opening prompt's first line, so the CLI's table and the sidebar show one line for a multi-paragraph brief", () => {
    const [t] = foldThreads([{ ...row, prompt: "You are a builder.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix." }]);
    expect(t!.title).toBe("You are a builder.");
  });

  it("foldThreads titles a thread with no harness title by its opening turn's first sentence, cut to 48 characters, so a brief-shaped turn never shows whole in the row, the breadcrumb, the switcher card or the CLI's table", () => {
    const brief = "You are a builder for the wsp repo, which is at /Users/dev/wsp on this Mac: read the ticket, then run `pnpm test` and report.\n\nTicket: Zingzy/wsp-map#408.";
    const [t] = foldThreads([{ ...row, prompt: brief }]);
    expect(t!.title).toBe("You are a builder for the wsp repo, which is at\u2026");
    const [two] = foldThreads([{ ...row, prompt: "Bump the lockfile. Then run the gate." }]);
    expect(two!.title).toBe("Bump the lockfile.");
  });

  it("foldThreads titles a thread by what the harness calls the session the next send resumes, so a rename made inside the harness shows everywhere", () => {
    const [t] = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", prompt: "make a server", claudeSessionId: "c1", harnessTitle: "Building the server", startedAt: 1_000 },
      { ...row, id: "s2", threadId: "thr_a", prompt: "and tests", claudeSessionId: "c1", harnessTitle: "the sidebar's own name", startedAt: 2_000 },
    ]);
    expect(t!.title).toBe("the sidebar's own name");
  });

  it("foldThreads keeps the opening turn's words while the harness has no title of its own, and cuts a harness title to one line", () => {
    const [none] = foldThreads([{ ...row, id: "s1", threadId: "thr_a", prompt: "make a server" }]);
    expect(none!.title).toBe("make a server");
    const [wrapped] = foldThreads([{ ...row, id: "s2", threadId: "thr_b", prompt: "make a server", harnessTitle: "  Building  the server \nand its tests" }]);
    expect(wrapped!.title).toBe("Building the server");
    const [named] = foldThreads([{ ...row, id: "s3", threadId: "thr_c", claudeSessionId: "c3", harnessTitle: "Building the server" }]);
    expect(named!.title).toBe("Building the server");
  });

  it("a thread always says who opened it: the fold reads a row from before provenance as a person's, once, for every client", () => {
    const [t] = foldThreads([{ ...row, prompt: "old" }]);
    expect(t!.startedBy).toBe("person");
    expect(() => ThreadView.parse({ id: "s1", workspaceId: "ws_1", harness: "claude", status: "completed", title: "old", sessionId: "s1", turns: 1 })).toThrow();
  });
});

describe("workspaces.exec", () => {
  it("takes a workspace and the command as argv, at least one word, so quoting is the runtime's and never lost on the wire", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: ["grep", "a b", "f"] })).toMatchObject({ argv: ["grep", "a b", "f"] });
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: [] })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", cmd: "ls" })).toThrow();
  });

  it("takes the folder the command runs in as cwd, absent when the command runs in the home", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: ["git", "status"], cwd: "/root/work/proj" })).toMatchObject({ cwd: "/root/work/proj" });
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", argv: ["git", "status"] })).not.toHaveProperty("cwd");
  });

  it("pushes output lines and one exit, whose code is null with a reason when the command was ended without one", () => {
    expect(ExecEvent.parse({ type: "exec.output", execId: "e1", text: "hello" })).toEqual({ type: "exec.output", execId: "e1", text: "hello" });
    expect(ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: 0 })).toEqual({ type: "exec.exit", execId: "e1", exitCode: 0 });
    expect(ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: null, error: "deadline" })).toMatchObject({ exitCode: null, error: "deadline" });
    expect(() => ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: 1.5 })).toThrow();
  });
});

describe("the small recipe", () => {
  const row = { id: "gh", kind: "tool", on: true, source: { kind: "used", sessions: 100, calls: 7919 }, signIn: "copy" };
  const recipe = { version: 1, at: "2026-09-06T03:00:00.000Z", histories: [{ agent: "claude", state: "read", sessions: 149, calls: 87593 }], rows: [row] };

  it("is catalog ids with a tick and the source of it, and nothing a session or a file held", () => {
    expect(Recipe.parse(recipe)).toEqual(recipe);
    expect(Recipe.safeParse({ ...recipe, version: 2 }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, rows: [{ ...row, source: { kind: "guess" } }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, rows: [{ ...row, signIn: "maybe" }] }).success).toBe(false);
    expect(Recipe.safeParse({ ...recipe, histories: [{ agent: "claude", state: "read", sessions: -1, calls: 0 }] }).success).toBe(false);
    expect(RecipeSource.parse({ kind: "installed", paths: ["~/.claude/settings.json"], bin: true })).toEqual({ kind: "installed", paths: ["~/.claude/settings.json"], bin: true });
    expect(RecipeSource.safeParse({ kind: "installed", paths: ["~/.claude/settings.json"] }).success).toBe(false);
  });
});

describe("this computer's folder listing", () => {
  it("takes an ask with neither the folder nor the hidden flag, and vouches for a level of folders with its roots beside it", () => {
    for (const req of [{ id: "r1", op: "host.folders" }, { id: "r1", op: "host.folders", dir: "/Users/dev/code", hidden: true }]) {
      expect(RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(RuntimeRequest.safeParse({ id: "r1", op: "host.folders", hidden: "yes" }).success).toBe(false);
    const listing = { dir: "/Users/dev/code", roots: ["/Users/dev", "/Volumes/work/api"], folders: [{ path: "/Users/dev/code/spoo", repo: true }], hidden: 3 };
    expect(HostFolderListing.parse(listing)).toEqual(listing);
    expect(HostFolderListing.safeParse({ ...listing, folders: [{ path: "/Users/dev/code/spoo" }] }).success).toBe(false);
    expect(HostFolderListing.safeParse({ ...listing, hidden: 1.5 }).success).toBe(false);
    expect(HostFolderListing.safeParse({ ...listing, roots: undefined }).success).toBe(false);
  });
});

describe("the project plan", () => {
  it("names each agent with sessions for the folder and how its state travels", () => {
    const plan = { source: "/Users/dev/proj", repo: true, files: 1, bytes: 2, secrets: [], excluded: [], skipped: [], agents: [{ agent: "claude", name: "Claude Code", sessions: 2, bytes: 4096, carry: "moves" }] };
    expect(ProjectPlan.parse(plan)).toEqual(plan);
    expect(ProjectPlan.safeParse({ ...plan, agents: [{ ...plan.agents[0], carry: "maybe" }] }).success).toBe(false);
    const unreadable = { agent: "opencode", name: "OpenCode", sessions: 0, bytes: 0, carry: "transcript-only", error: "file is not a database" };
    expect(ProjectPlan.parse({ ...plan, agents: [unreadable] }).agents).toEqual([unreadable]);
    expect(ProjectPlan.safeParse({ ...plan, agents: undefined }).success).toBe(false);
  });

  it("the import names the agents that travel and the result says what became of each", () => {
    const req = { id: "r1", op: "project.import", workspaceId: "ws_1", source: "/Users/dev/proj", dest: "/root/proj", agents: ["claude"] };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    const result = {
      dest: "/root/proj",
      files: 1,
      bytes: 2,
      parts: 1,
      cut: [],
      rewritten: [],
      agents: [
        { agent: "claude", files: 3, bytes: 40, outcome: "moved" },
        { agent: "codex", files: 1, bytes: 40, outcome: "moved", rows: 2 },
        { agent: "gemini", files: 1, bytes: 40, outcome: "carried" },
        { agent: "hermes", files: 0, bytes: 0, outcome: "transcript-only", note: "no /root/.hermes/state.db on the machine" },
        { agent: "opencode", files: 0, bytes: 0, outcome: "nothing" },
        { agent: "pi", files: 0, bytes: 0, outcome: "failed", error: "x already exists" },
      ],
    };
    expect(ProjectImportResult.parse(result)).toEqual(result);
    expect(ProjectImportResult.safeParse({ ...result, agents: [{ agent: "pi", files: 0, bytes: 0, outcome: "lost" }] }).success).toBe(false);
    expect(ProjectImportResult.safeParse({ ...result, agents: [{ agent: "codex", files: 1, bytes: 40, outcome: "moved", rows: "two" }] }).success).toBe(false);
  });
});

describe("the project export", () => {
  it("names the workspace, the folder on the machine and the folder here; agents narrow whose state comes home", () => {
    const req = { id: "r1", op: "project.export", workspaceId: "ws_1", source: "/root/work/proj", dest: "/Users/dev/proj", replace: true, agents: ["claude", "codex"] };
    expect(RuntimeRequest.parse(req)).toEqual(req);
    const bare = { id: "r2", op: "project.export", workspaceId: "ws_1", source: "/root/work/proj", dest: "/Users/dev/proj" };
    expect(RuntimeRequest.parse(bare)).toEqual(bare);
    expect(RuntimeRequest.safeParse({ ...bare, dest: undefined }).success).toBe(false);
  });

  it("its events ride the union with the stages in order, and the result counts sessions and skipped rollouts per agent", () => {
    for (const stage of ["packing", "downloading", "landing", "done", "failed"]) {
      const e = { type: "project.export", workspaceId: "ws_1", source: "/root/work/proj", dest: "/Users/dev/proj", stage, message: "x", elapsedMs: 3, seq: 1 };
      expect(EventUnion.parse(e)).toEqual(e);
    }
    expect(ProjectExportEvent.safeParse({ type: "project.export", workspaceId: "w", source: "/a", dest: "/b", stage: "uploading", message: "", elapsedMs: 0 }).success).toBe(false);
    const result = {
      dest: "/Users/dev/proj",
      files: 12,
      bytes: 4096,
      excluded: ["node_modules", "dist"],
      agents: [
        { agent: "claude", files: 3, bytes: 40, outcome: "moved", sessions: 2 },
        { agent: "codex", files: 1, bytes: 40, outcome: "transcript-only", sessions: 2, skipped: 1 },
        { agent: "hermes", files: 0, bytes: 0, outcome: "nothing", sessions: 1 },
        { agent: "pi", files: 0, bytes: 0, outcome: "failed", error: "not a database" },
      ],
    };
    expect(ProjectExportResult.parse(result)).toEqual(result);
    expect(ProjectExportResult.safeParse({ ...result, excluded: undefined }).success).toBe(false);
    expect(ProjectImportResult.parse({ dest: "/root/p", files: 1, bytes: 1, parts: 1, cut: [], rewritten: [], agents: [{ agent: "codex", files: 1, bytes: 1, outcome: "transcript-only", skipped: 2 }] }).agents[0]).toMatchObject({ skipped: 2 });
  });
});

describe("project goldens", () => {
  it("a project golden names its snapshot, the projects it carries, the golden version it stands on and the workspace it was taken from", () => {
    const golden = {
      snapshotId: "snap_project-proj",
      projects: [{ name: "proj", dest: "/root/work/proj", importedAt: "2026-09-06T10:00:00.000Z" }],
      golden: "snap_golden-v12",
      version: 12,
      workspaceId: "ws_1",
      workspaceName: "task",
      createdAt: "2026-09-06T10:05:00.000Z",
    };
    expect(ProjectGolden.parse(golden)).toEqual(golden);
    const { version: _v, ...unversioned } = golden;
    expect(ProjectGolden.parse(unversioned)).toEqual(unversioned);
    expect(ProjectGolden.safeParse({ ...golden, projects: undefined }).success).toBe(false);
    expect(ProjectGolden.safeParse({ ...golden, version: "12" }).success).toBe(false);
  });

  it("workspaces.snapshot names the workspace and projectGoldens.list takes nothing", () => {
    const snapshot = { id: 30, op: "workspaces.snapshot", workspaceId: "ws_1" };
    const list = { id: 31, op: "projectGoldens.list" };
    for (const r of [snapshot, list]) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(RuntimeRequest.safeParse({ id: 32, op: "workspaces.snapshot" }).success).toBe(false);
  });
});

describe("packageOf", () => {
  it("is what follows the manager in a tools row's id, a tap formula's slashes kept; it lives here because the collector writes these ids without the engine", () => {
    expect(wire.packageOf({ id: "tools/brew/gh" })).toBe("gh");
    expect(wire.packageOf({ id: "tools/brew/zingzy/tap/diskbloom" })).toBe("zingzy/tap/diskbloom");
    expect(wire.packageOf({ id: "tools/npm/@scope/name" })).toBe("@scope/name");
    expect(wire.packageOf({ id: `${wire.BREW_ID_PREFIX}yq` })).toBe("yq");
    // The collector's id for a manager's package, which a scan row of the same manager and package stands for.
    expect(wire.toolRowId("brew", "zingzy/tap/diskbloom")).toBe(`${wire.BREW_ID_PREFIX}zingzy/tap/diskbloom`);
    expect(wire.packageOf({ id: wire.toolRowId("npm", "@scope/name") })).toBe("@scope/name");
    // Where a manager's rows sit, which is what the engine tests a row's id against and what the brew prefix is.
    expect(wire.toolRowPrefix("npm")).toBe("tools/npm/");
    expect(wire.BREW_ID_PREFIX).toBe(wire.toolRowPrefix("brew"));
    expect(wire.toolRowId("uv", "ruff").startsWith(wire.toolRowPrefix("uv"))).toBe(true);
  });
});

describe("the person's terminal config", () => {
  it("takes an ask with or without a scheme, and vouches only for the keys the pane honours in their shapes", () => {
    for (const req of [{ id: "r1", op: "host.terminalConfig" }, { id: "r1", op: "host.terminalConfig", scheme: "light" }]) {
      expect(wire.RuntimeRequest.parse(req)).toEqual(req);
    }
    expect(wire.RuntimeRequest.safeParse({ id: "r1", op: "host.terminalConfig", scheme: "sepia" }).success).toBe(false);
    const none = { files: [], fontFamily: [], palette: Array<null>(16).fill(null) };
    expect(wire.TerminalConfig.parse(none)).toEqual(none);
    const full = {
      ...none,
      files: ["/Users/dev/.config/ghostty/config"],
      fontFamily: ["Berkeley Mono", "Symbols Nerd Font Mono"],
      fontSize: 13,
      theme: "Catppuccin Mocha",
      background: { r: 30, g: 30, b: 46 },
      cursorStyle: "underline",
      cursorStyleBlink: false,
      windowPaddingX: { left: 2, right: 4 },
      backgroundOpacity: 0.85,
      backgroundBlur: 20,
    };
    expect(wire.TerminalConfig.parse(full)).toEqual(full);
    expect(wire.TerminalConfig.safeParse({ ...none, palette: [] }).success).toBe(false);
    expect(wire.TerminalConfig.safeParse({ ...none, background: { r: 256, g: 0, b: 0 } }).success).toBe(false);
    expect(wire.TerminalConfig.safeParse({ ...none, backgroundOpacity: 1.5 }).success).toBe(false);
    expect(wire.TerminalConfig.safeParse({ ...none, cursorStyle: "beam" }).success).toBe(false);
  });
});
