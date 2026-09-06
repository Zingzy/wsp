import { describe, expect, it } from "vitest";
import {
  Capabilities,
  GoldenVersion,
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
  HarnessCatalog,
  PortReachView,
  RuntimeErrorResponse,
  RuntimeRequest,
  RuntimeResponse,
  SessionEvent,
  SessionInterruptResult,
  SnapshotLineage,
  SnapshotRollbackResult,
  SessionOrigin,
  SessionView,
  ThreadView,
  ExecEvent,
  foldThreads,
  WorkspaceStatus,
  WorkspaceView,
} from "../src/index.js";

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
});

describe("backend capabilities", () => {
  it("requires every flag, containers and callbackRelay included, so no backend can leave one unstated", () => {
    const full = { liveCloneForks: true, ramPreservingPause: true, resize: false, previewUrls: true, signedUrls: true, containers: false, callbackRelay: true, snapshotListing: true };
    expect(Capabilities.parse(full)).toEqual(full);
    const { containers: _c, ...missing } = full;
    expect(() => Capabilities.parse(missing)).toThrow();
    const { callbackRelay: _r, ...noRelay } = full;
    expect(() => Capabilities.parse(noRelay)).toThrow();
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
    };
    expect(HarnessCatalog.parse(catalog)).toEqual(catalog);
    const bare = { harness: "pi", label: "Pi", source: "table", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [] };
    expect(HarnessCatalog.parse(bare)).toEqual(bare);
    expect(() => HarnessCatalog.parse({ ...catalog, models: [{ value: "x" }] })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, efforts: undefined })).toThrow();
    expect(() => HarnessCatalog.parse({ ...catalog, source: "guess" })).toThrow();
    const { source: _s, version: _v, contextWindows: _w, ...old } = catalog;
    expect(() => HarnessCatalog.parse(old)).toThrow();
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
    const missingTools = [{ name: "gopls", outcome: "skipped", note: "no Linux bottle" }, { name: "Homebrew", outcome: "failed", note: "git: not found" }];
    expect(GoldenVersion.parse({ ...base, missingTools })).toEqual({ ...base, missingTools });
    expect(GoldenVersion.parse(base).missingTools).toBeUndefined();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ name: "gopls", note: "no Linux bottle" }] })).toThrow();
    expect(() => GoldenVersion.parse({ ...base, missingTools: [{ name: "gopls", outcome: "installed", note: "" }] })).toThrow();
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

  it("SessionView carries who asked for the turn, person or cli, and stays optional for rows written before", () => {
    expect(SessionView.parse({ ...row, startedBy: "cli" }).startedBy).toBe("cli");
    expect(SessionView.parse(row).startedBy).toBeUndefined();
    expect(() => SessionView.parse({ ...row, startedBy: "robot" })).toThrow();
    expect(SessionOrigin.options).toEqual(["person", "cli"]);
  });

  it("sessions.start takes startedBy and nothing else new", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", startedBy: "cli" })).toMatchObject({ startedBy: "cli" });
    expect(() => RuntimeRequest.parse({ id: 1, op: "sessions.start", workspaceId: "ws_1", prompt: "go", startedBy: "app" })).toThrow();
  });

  it("foldThreads groups turns by threadId, titles by the opening turn, reads state and resume id from the latest, and keeps the opener's provenance", () => {
    const threads = foldThreads([
      { ...row, id: "s1", threadId: "thr_a", startedBy: "cli", prompt: "make a server", claudeSessionId: "c1", startedAt: 1_000, endedAt: 2_000 },
      { ...row, id: "s2", threadId: "thr_b", prompt: "unrelated", startedAt: 3_000, endedAt: 4_000 },
      { ...row, id: "s3", threadId: "thr_a", status: "running", startedBy: "person", prompt: "and tests", claudeSessionId: "c2", startedAt: 5_000 },
      { ...row, id: "s4", status: "failed", prompt: "before threads", startedAt: 6_000, endedAt: 7_000 },
    ]);
    expect(threads).toEqual([
      { id: "thr_a", threadId: "thr_a", workspaceId: "ws_1", harness: "claude", startedBy: "cli", status: "running", title: "make a server", claudeSessionId: "c2", startedAt: 5_000, turns: 2 },
      { id: "thr_b", threadId: "thr_b", workspaceId: "ws_1", harness: "claude", status: "completed", title: "unrelated", startedAt: 3_000, endedAt: 4_000, turns: 1 },
      { id: "s4", workspaceId: "ws_1", harness: "claude", status: "failed", title: "before threads", startedAt: 6_000, endedAt: 7_000, turns: 1 },
    ]);
    for (const t of threads) expect(ThreadView.parse(t)).toEqual(t);
  });
});

describe("workspaces.exec", () => {
  it("takes a workspace and a non-empty command", () => {
    expect(RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", cmd: "ls" })).toMatchObject({ cmd: "ls" });
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.exec", workspaceId: "ws_1", cmd: "" })).toThrow();
  });

  it("pushes output lines and one exit, whose code is null with a reason when the command was ended without one", () => {
    expect(ExecEvent.parse({ type: "exec.output", execId: "e1", text: "hello" })).toEqual({ type: "exec.output", execId: "e1", text: "hello" });
    expect(ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: 0 })).toEqual({ type: "exec.exit", execId: "e1", exitCode: 0 });
    expect(ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: null, error: "deadline" })).toMatchObject({ exitCode: null, error: "deadline" });
    expect(() => ExecEvent.parse({ type: "exec.exit", execId: "e1", exitCode: 1.5 })).toThrow();
  });
});
