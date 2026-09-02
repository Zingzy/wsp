import { describe, expect, it } from "vitest";
import {
  DaemonEvent,
  DaemonReachView,
  DaemonRequest,
  DaemonResponse,
  EventUnion,
  GoldenManifest,
  GoldenStageEvent,
  RuntimeErrorResponse,
  RuntimeRequest,
  RuntimeResponse,
  SessionEvent,
  SnapshotLineage,
  SnapshotRollbackResult,
  SessionView,
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
      { type: "pty.data", ptyId: "p1", data: "hello" },
      { type: "pty.exit", ptyId: "p1", exitCode: 0, signal: undefined },
      { type: "port.open", port: 8080, pid: 12 },
      { type: "port.close", port: 8080 },
      { type: "inbox.file", path: "/root/inbox/x.png", bytes: 10 },
    ];
    for (const e of events) expect(DaemonEvent.parse(e)).toBeTruthy();
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
    ];
    for (const r of reqs) expect(RuntimeRequest.parse(r)).toEqual(r);
    expect(() => RuntimeRequest.parse({ id: 1, op: "workspaces.create" })).toThrow(); // golden+name required
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.prepare", name: "d", kind: "browser" })).toThrow();
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.seal" })).toThrow(); // builderId required
    expect(() => RuntimeRequest.parse({ id: 1, op: "golden.builderReach" })).toThrow();
    expect(RuntimeResponse.parse({ id: 4, ok: true, workspace: { id: "w" } })).toBeTruthy();
    expect(RuntimeResponse.parse({ id: 4, ok: false, error: "nope" })).toBeTruthy();
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
