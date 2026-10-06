// SPDX-License-Identifier: AGPL-3.0-only
// What a turn changed in the folder it ran in: a snapshot of the checkout as
// the turn launches, a second as it ends, and the range between them recorded
// as the turn's session.changes. The daemon is a fake that answers the two git
// ops from a script; nothing here runs git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERE_PLACE_ID, type AdapterEvent, type DaemonFrame, type DaemonResponse, type SessionEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { memoryStore } from "../src/store.js";
import { createOn, fakeLocal, projectOn, stubBackend, tokenGuest } from "./stub-backend.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);
const sha = (n: number): string => String(n).repeat(40).slice(0, 40);

/** A daemon whose snapshots count up and whose range answers what the case gives it; with hold, the first snapshot
 * (or the one numbered) answers when the case lets it, with stallAt that snapshot never answers, and with refuseAt
 * it is refused. */
function fakeDaemon(o: { files?: { path: string; kind: string; additions: number; deletions: number }[]; moved?: string[]; stall?: boolean; stallAt?: number; refuseAt?: number; hold?: boolean | number; root?: string } = {}) {
  const frames: Record<string, unknown>[] = [];
  let snapshots = 0;
  let letGo: () => void = () => {};
  const held = new Promise<void>(resolve => (letGo = resolve));
  const answer = async (frame: Record<string, unknown>): Promise<DaemonResponse> => {
    frames.push(frame);
    if (frame["op"] === "git.snapshot") {
      snapshots += 1;
      if (o.stall === true || snapshots === o.stallAt) return new Promise(() => {});
      const commit = sha(snapshots);
      if (snapshots === (o.hold === true ? 1 : o.hold)) await held;
      if (snapshots === o.refuseAt) return { id: 1, ok: false, code: "unsupported", error: "the snapshot was refused" } as DaemonResponse;
      return { id: 1, ok: true, commit } as DaemonResponse;
    }
    if (frame["op"] === "git.worktrees" && o.root !== undefined) return { id: 1, ok: true, worktrees: [{ path: o.root, branch: "main", head: sha(9) }] } as DaemonResponse;
    if (frame["op"] === "git.turn") return Promise.resolve({ id: 1, ok: true, base: null, truncated: false, moved: o.moved ?? [], files: (o.files ?? []).map(f => ({ ...f, patch: "" })) } as DaemonResponse);
    return Promise.resolve({ id: 1, ok: false, code: "unsupported", error: `${String(frame["op"])} is not in this case` } as DaemonResponse);
  };
  const open = async (_o: DaemonChannelOptions): Promise<DaemonChannel> => ({
    send: (frame: DaemonFrame) => answer(frame as unknown as Record<string, unknown>),
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { open, frames, letGo: () => letGo(), rootAt: (root: string) => void (o.root = root) };
}

/** An adapter whose turn waits on the case's word before it replies, so two turns can overlap. wrote names the files
 * each start's agent writes through its own Write calls, by the start's place, as paths under its folder. */
function gated(o: { waitsForPrompt?: true; reportsEdits?: true; wrote?: Record<number, string[]> } = {}): { factory: HarnessAdapterFactory; release: (n: number) => void; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const gates: (() => void)[] = [];
  const { wrote = {}, ...flags } = o;
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    ...flags,
    start: (options: HarnessStartOptions) => {
      const index = starts.push(options) - 1;
      const sessionId = `sess-${index}`;
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        options.onEvent({ type: "session.start", sessionId } as AdapterEvent);
        for (const [n, file] of (wrote[index] ?? []).entries()) {
          const toolUseId = `write-${index}-${n}`;
          options.onEvent({ type: "turn.delta", sessionId, kind: "tool_use", toolName: "Write", toolUseId, text: JSON.stringify({ file_path: join(options.cwd ?? "", file), content: "x" }) });
          options.onEvent({ type: "turn.delta", sessionId, kind: "tool_result", toolUseId, text: "ok", isError: false });
        }
        await new Promise<void>(resolve => (gates[index] = resolve));
        options.onEvent({ type: "turn.done", sessionId, result });
        options.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  const release = (n: number): void => {
    const wait = (): void => (gates[n] === undefined ? void setTimeout(wait, 2) : gates[n]!());
    wait();
  };
  return { factory, release, starts };
}

let rt: Runtime | undefined;
const roots: string[] = [];
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A workspace on a box, or with here a copy of a repo on this computer, both with the case's daemon. */
async function workspaceWith(daemon: ReturnType<typeof fakeDaemon>, adapter: HarnessAdapterFactory, turnSnapshotMs?: number, here = false) {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  const snapshotWait = turnSnapshotMs !== undefined ? { turnSnapshotMs } : {};
  const store = memoryStore();
  let ws: Awaited<ReturnType<typeof createOn>>;
  let folder: string | undefined;
  if (here) {
    const root = mkdtempSync(join(tmpdir(), "wsp-turn-changes-"));
    roots.push(root);
    folder = join(root, "work");
    mkdirSync(folder, { recursive: true });
    execFileSync("git", ["init", "-q", folder]);
    const local = { ...fakeLocal(root), daemonRoad: async () => ({ url: "http://127.0.0.1:7070", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN }) };
    rt = createRuntime({ backend, store, adapters: { claude: adapter }, local, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open, ...snapshotWait });
    ws = await createOn(rt, { on: HERE_PLACE_ID, name: "changes", project: (await projectOn(rt, HERE_PLACE_ID, realpathSync(folder))).id });
  } else {
    rt = createRuntime({ backend, store, adapters: { claude: adapter }, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open, ...snapshotWait });
    ws = await createOn(rt, { golden: "snap_g", name: "changes" });
    backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
  }
  const events: SessionEvent[] = [];
  /** Each turn's id by the prompt that opened it, off the start the runtime recorded. */
  const turnOf = new Map<string, string>();
  rt.events.on("*", e => {
    if (e.type === "session.changes") events.push(e);
    if (e.type === "session.start" && e.prompt !== undefined && e.turnId !== undefined) turnOf.set(e.prompt, e.turnId);
  });
  return { ws, events, turnOf, store, folder };
}

async function until(ready: () => boolean): Promise<void> {
  for (let n = 0; n < 400 && !ready(); n++) await new Promise(resolve => setTimeout(resolve, 5));
  if (!ready()) throw new Error("the runtime never did it");
}

describe("what a turn changed", () => {
  it("is the range between a snapshot at its launch and one at its end, recorded under the turn", async () => {
    const files = [
      { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
      { path: "NOTES.md", kind: "added", additions: 3, deletions: 0 },
    ];
    const daemon = fakeDaemon({ files });
    const agent = gated();
    const { ws, events, turnOf } = await workspaceWith(daemon, agent.factory);
    const handle = await rt!.sessions.start(ws.id, { prompt: "add a line and a file" });
    const cwd = handle.view().cwd!;
    expect(daemon.frames).toEqual([{ op: "git.snapshot", cwd }]);
    agent.release(0);
    await handle.finished;
    await until(() => events.length > 0);
    // The turn's own snapshots and range; the checkpoint and the status read its end also makes are other roads'.
    expect(daemon.frames.filter(f => f["op"] === "git.snapshot" || f["op"] === "git.turn")).toEqual([{ op: "git.snapshot", cwd }, { op: "git.snapshot", cwd }, { op: "git.turn", cwd, from: sha(1), to: sha(2) }]);
    expect(events).toEqual([expect.objectContaining({ type: "session.changes", turnId: turnOf.get("add a line and a file"), threadId: handle.view().threadId, from: sha(1), to: sha(2), files })]);
    expect(events[0]).not.toHaveProperty("shared");
  });

  it("on this computer starts an agent that takes its prompt late while the launch's snapshot is taken, and hands it the prompt once the snapshot is in", async () => {
    const files = [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }];
    const daemon = fakeDaemon({ files, hold: true });
    const agent = gated({ waitsForPrompt: true });
    const { ws, events } = await workspaceWith(daemon, agent.factory, undefined, true);
    const handle = await rt!.sessions.start(ws.id, { prompt: "edit the readme" });
    expect(agent.starts).toHaveLength(1);
    let prompted = false;
    void agent.starts[0]!.promptAfter!.then(() => (prompted = true));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(prompted).toBe(false);
    daemon.letGo();
    await until(() => prompted);
    agent.release(0);
    await handle.finished;
    await until(() => events.length > 0);
    expect(events).toEqual([expect.objectContaining({ type: "session.changes", from: sha(1), to: sha(2), files })]);
  });

  it("on this computer writes the launch's snapshot onto the running row once it is in, after the agent started", async () => {
    const daemon = fakeDaemon({ hold: true });
    const agent = gated({ waitsForPrompt: true });
    const { ws, store } = await workspaceWith(daemon, agent.factory, undefined, true);
    const handle = await rt!.sessions.start(ws.id, { prompt: "edit the readme" });
    const stored = async () => ((await store.get("sessions", ws.id)) as { sessions: { status: string; snapshot?: string }[] }).sessions;
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "running" })]);
    expect((await stored())[0]).not.toHaveProperty("snapshot");
    daemon.letGo();
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "running", snapshot: sha(1) })]);
    agent.release(0);
    await handle.finished;
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "completed" })]);
    expect((await stored())[0]).not.toHaveProperty("snapshot");
  });

  it("on this computer hands an agent that takes its prompt late the prompt at the cap when the daemon never answers, and records nothing", async () => {
    const daemon = fakeDaemon({ stall: true });
    const agent = gated({ waitsForPrompt: true });
    const { ws, events } = await workspaceWith(daemon, agent.factory, 30, true);
    const handle = await rt!.sessions.start(ws.id, { prompt: "go" });
    await agent.starts[0]!.promptAfter;
    agent.release(0);
    await handle.finished;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(daemon.frames.filter(f => f["op"] === "git.turn")).toEqual([]);
    expect(events).toEqual([]);
  });

  it("on a box seeds the prompt at the launch of an agent that could take it late, the snapshot in first", async () => {
    const daemon = fakeDaemon({ hold: true });
    const agent = gated({ waitsForPrompt: true });
    const { ws } = await workspaceWith(daemon, agent.factory);
    const starting = rt!.sessions.start(ws.id, { prompt: "go" });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(agent.starts).toHaveLength(0);
    daemon.letGo();
    const handle = await starting;
    expect(agent.starts[0]).not.toHaveProperty("promptAfter");
    agent.release(0);
    await handle.finished;
  });

  it("records nothing for a turn that changed nothing", async () => {
    const daemon = fakeDaemon({ files: [] });
    const agent = gated();
    const { ws, events } = await workspaceWith(daemon, agent.factory);
    const handle = await rt!.sessions.start(ws.id, { prompt: "look around" });
    agent.release(0);
    await handle.finished;
    await until(() => daemon.frames.some(f => f["op"] === "git.turn"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual([]);
  });

  it("records a turn that only moved HEAD: no files of its own, the move named on the card", async () => {
    const daemon = fakeDaemon({ files: [], moved: ["Pulled"] });
    const agent = gated();
    const { ws, events } = await workspaceWith(daemon, agent.factory);
    const handle = await rt!.sessions.start(ws.id, { prompt: "pull main" });
    agent.release(0);
    await handle.finished;
    await until(() => events.length > 0);
    expect(events).toEqual([expect.objectContaining({ type: "session.changes", files: [], moved: ["Pulled"] })]);
  });

  it("runs the turn without a snapshot when the daemon does not answer in time, and records nothing for it", async () => {
    const daemon = fakeDaemon({ stall: true });
    const agent = gated();
    const { ws, events } = await workspaceWith(daemon, agent.factory, 30);
    const handle = await rt!.sessions.start(ws.id, { prompt: "go" });
    expect(agent.starts).toHaveLength(1);
    agent.release(0);
    await handle.finished;
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(daemon.frames.filter(f => f["op"] === "git.turn")).toEqual([]);
    expect(events).toEqual([]);
  });

  it("says a turn's changes are shared when another thread's turn ran in the same folder between its two snapshots", async () => {
    const daemon = fakeDaemon({ files: [{ path: "a.ts", kind: "modified", additions: 2, deletions: 1 }] });
    const agent = gated();
    const { ws, events, turnOf } = await workspaceWith(daemon, agent.factory);
    const first = await rt!.sessions.start(ws.id, { prompt: "one" });
    const second = await rt!.sessions.start(ws.id, { prompt: "two" });
    expect(second.view().threadId).not.toBe(first.view().threadId);
    expect(second.view().cwd).toBe(first.view().cwd);
    agent.release(1);
    await second.finished;
    agent.release(0);
    await first.finished;
    await until(() => events.length === 2);
    const byTurn = new Map(events.map(e => [e.turnId, e]));
    expect(byTurn.get(turnOf.get("one"))).toMatchObject({ shared: true });
    expect(byTurn.get(turnOf.get("two"))).toMatchObject({ shared: true });
  });

  it("lists only each thread's own files when two threads in one folder write different files in overlapping turns, and marks the other's as another thread's", async () => {
    const a = { path: "a.ts", kind: "added", additions: 1, deletions: 0 };
    const b = { path: "b.ts", kind: "added", additions: 2, deletions: 0 };
    const daemon = fakeDaemon({ files: [a, b] });
    const agent = gated({ reportsEdits: true, wrote: { 0: ["a.ts"], 1: ["b.ts"] } });
    const { ws, events, turnOf } = await workspaceWith(daemon, agent.factory);
    const first = await rt!.sessions.start(ws.id, { prompt: "one" });
    const second = await rt!.sessions.start(ws.id, { prompt: "two" });
    const cwd = first.view().cwd!;
    expect(second.view().cwd).toBe(cwd);
    daemon.rootAt(cwd);
    agent.release(1);
    await second.finished;
    agent.release(0);
    await first.finished;
    await until(() => events.length === 2);
    const byTurn = new Map(events.map(e => [e.turnId, e]));
    expect(byTurn.get(turnOf.get("one"))).toMatchObject({ files: [a], others: [b], shared: true });
    expect(byTurn.get(turnOf.get("two"))).toMatchObject({ files: [b], others: [a], shared: true });
  });

  it("shows none of its own for a turn that wrote nothing while another thread changed the folder", async () => {
    const b = { path: "b.ts", kind: "added", additions: 2, deletions: 0 };
    const daemon = fakeDaemon({ files: [b] });
    const agent = gated({ reportsEdits: true, wrote: { 1: ["b.ts"] } });
    const { ws, events, turnOf } = await workspaceWith(daemon, agent.factory);
    const quiet = await rt!.sessions.start(ws.id, { prompt: "just read" });
    const busy = await rt!.sessions.start(ws.id, { prompt: "write b" });
    daemon.rootAt(quiet.view().cwd!);
    agent.release(1);
    await busy.finished;
    agent.release(0);
    await quiet.finished;
    await until(() => events.length === 2);
    const byTurn = new Map(events.map(e => [e.turnId, e]));
    expect(byTurn.get(turnOf.get("just read"))).toMatchObject({ files: [], others: [b], shared: true });
    expect(byTurn.get(turnOf.get("write b"))).toMatchObject({ files: [b], others: [], shared: true });
  });

  it("splits the list of two threads in one repo at different subfolders, since each turn's range covers the whole checkout", async () => {
    const x = { path: "a/x.ts", kind: "added", additions: 1, deletions: 0 };
    const y = { path: "b/y.ts", kind: "added", additions: 2, deletions: 0 };
    const daemon = fakeDaemon({ files: [x, y] });
    const agent = gated({ reportsEdits: true, wrote: { 0: ["x.ts"], 1: ["y.ts"] } });
    const { ws, events, turnOf, folder } = await workspaceWith(daemon, agent.factory, undefined, true);
    const top = realpathSync(folder!);
    for (const sub of ["a", "b"]) mkdirSync(join(top, sub));
    daemon.rootAt(top);
    const first = await rt!.sessions.start(ws.id, { prompt: "in a", cwd: join(top, "a") });
    const second = await rt!.sessions.start(ws.id, { prompt: "in b", cwd: join(top, "b") });
    expect([first.view().cwd, second.view().cwd]).toEqual([join(top, "a"), join(top, "b")]);
    agent.release(1);
    await second.finished;
    agent.release(0);
    await first.finished;
    await until(() => events.length === 2);
    const byTurn = new Map(events.map(e => [e.turnId, e]));
    expect(byTurn.get(turnOf.get("in a"))).toMatchObject({ files: [x], others: [y], shared: true });
    expect(byTurn.get(turnOf.get("in b"))).toMatchObject({ files: [y], others: [x], shared: true });
  });

  it("keeps the folder's list, marked shared and not split, where the agent reports none of its edits", async () => {
    const a = { path: "a.ts", kind: "added", additions: 1, deletions: 0 };
    const daemon = fakeDaemon({ files: [a] });
    const agent = gated({ wrote: { 0: ["a.ts"] } });
    const { ws, events, turnOf } = await workspaceWith(daemon, agent.factory);
    const first = await rt!.sessions.start(ws.id, { prompt: "one" });
    await rt!.sessions.start(ws.id, { prompt: "two" });
    daemon.rootAt(first.view().cwd!);
    agent.release(1);
    agent.release(0);
    await until(() => events.length === 2);
    const one = events.find(e => e.turnId === turnOf.get("one"))!;
    expect(one).toMatchObject({ files: [a], shared: true });
    expect(one).not.toHaveProperty("others");
  });

  it("keeps every change as the turn's own where no other thread ran in its folder, edits it never reported included", async () => {
    const a = { path: "a.ts", kind: "added", additions: 1, deletions: 0 };
    const built = { path: "dist/out.js", kind: "added", additions: 9, deletions: 0 };
    const daemon = fakeDaemon({ files: [a, built] });
    const agent = gated({ reportsEdits: true, wrote: { 0: ["a.ts"] } });
    const { ws, events } = await workspaceWith(daemon, agent.factory);
    const handle = await rt!.sessions.start(ws.id, { prompt: "build" });
    agent.release(0);
    await handle.finished;
    await until(() => events.length === 1);
    expect(events[0]).toMatchObject({ files: [a, built] });
    expect(events[0]).not.toHaveProperty("others");
    expect(events[0]).not.toHaveProperty("shared");
  });

  /** One run on a box that outlives the host that launched it: each host the case starts re-opens it by its handle. */
  const RUN = "/tmp/wsp-run/000000000001";
  const restartable = (daemon: ReturnType<typeof fakeDaemon>) => {
    const runs = new Map<string, { onEvent: (event: AdapterEvent) => void; settle: (result: TurnResult) => void }>();
    const session = (run: string, localId: string, onEvent: (event: AdapterEvent) => void) => {
      const finished = new Promise<TurnResult>(settle => runs.set(run, { onEvent, settle }));
      return { localId, run, finished, interrupt: async () => {} };
    };
    const factory: HarnessAdapterFactory = () => ({
      steers: false,
      start: o => {
        const opened = session(RUN, "sess-1", o.onEvent);
        queueMicrotask(() => o.onEvent({ type: "session.start", sessionId: "sess-1" } as AdapterEvent));
        return opened;
      },
      attach: async o => (runs.has(o.run) ? session(o.run, o.sessionId, o.onEvent) : "gone"),
    });
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const store = memoryStore();
    const host = () => createRuntime({ backend, store, adapters: { claude: factory }, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open });
    const begin = async (prompt: string) => {
      rt = host();
      const ws = await createOn(rt, { golden: "snap_g", name: "changes" });
      backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
      const handle = await rt.sessions.start(ws.id, { prompt });
      const stored = async () => ((await store.get("sessions", ws.id)) as { sessions: { status: string; run?: string; snapshot?: string }[] }).sessions;
      await expect.poll(stored).toEqual([expect.objectContaining({ status: "running", run: RUN })]);
      return { ws, cwd: handle.view().cwd!, stored };
    };
    return { run: () => runs.get(RUN)!, host, begin };
  };
  const reply = { status: "completed", text: "done" } as const;

  it("keeps the card of a turn a host restart re-opened, read against the snapshot its launch took", async () => {
    const files = [{ path: "src/fix.ts", kind: "modified", additions: 4, deletions: 1 }];
    const daemon = fakeDaemon({ files });
    const box = restartable(daemon);
    const { ws, cwd, stored } = await box.begin("fix it");
    await rt!.close();

    rt = box.host();
    const events: SessionEvent[] = [];
    rt.events.on("*", e => void (e.type === "session.changes" && events.push(e)));
    expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    box.run().onEvent({ type: "turn.done", sessionId: "sess-1", result: reply });
    box.run().onEvent({ type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    box.run().settle(reply);
    await until(() => events.length > 0);
    expect(daemon.frames.filter(f => f["op"] === "git.turn")).toEqual([{ op: "git.turn", cwd, from: sha(1), to: sha(2) }]);
    expect(events).toEqual([expect.objectContaining({ type: "session.changes", from: sha(1), to: sha(2), files })]);
    await expect.poll(stored).toEqual([expect.not.objectContaining({ snapshot: expect.anything() })]);
  });

  it("writes one card for a turn whose card was recorded before the restart that re-opened it", async () => {
    const daemon = fakeDaemon({ files: [{ path: "src/fix.ts", kind: "modified", additions: 4, deletions: 1 }] });
    const box = restartable(daemon);
    const { ws } = await box.begin("fix it");
    box.run().onEvent({ type: "turn.done", sessionId: "sess-1", result: reply });
    await until(() => daemon.frames.some(f => f["op"] === "git.turn"));
    await expect.poll(async () => (await rt!.sessions.history(ws.id)).filter(e => e.type === "session.changes")).toHaveLength(1);
    await rt!.close();

    rt = box.host();
    expect((await rt.sessions.list(ws.id)).map(s => s.status)).toEqual(["running"]);
    box.run().onEvent({ type: "turn.done", sessionId: "sess-1", result: reply });
    box.run().onEvent({ type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    box.run().settle(reply);
    await expect.poll(async () => (await rt!.sessions.list(ws.id))[0]!.status).toBe("completed");
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await rt.sessions.history(ws.id)).filter(e => e.type === "session.changes")).toEqual([expect.objectContaining({ from: sha(1), to: sha(2) })]);
    expect(daemon.frames.filter(f => f["op"] === "git.turn")).toHaveLength(1);
  });

  it("reads the card of a turn whose host went after its agent exited and before the card was in, and once", async () => {
    const files = [{ path: "src/fix.ts", kind: "modified", additions: 4, deletions: 1 }];
    const daemon = fakeDaemon({ files, stallAt: 2 });
    const box = restartable(daemon);
    const { ws, cwd, stored } = await box.begin("fix it");
    box.run().onEvent({ type: "turn.done", sessionId: "sess-1", result: reply });
    box.run().onEvent({ type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    box.run().settle(reply);
    await expect.poll(async () => (await rt!.sessions.list(ws.id))[0]!.status).toBe("completed");
    await rt!.close();

    const cards = async () => (await rt!.sessions.history(ws.id)).filter(e => e.type === "session.changes");
    rt = box.host();
    await expect.poll(cards).toEqual([expect.objectContaining({ from: sha(1), to: sha(3), files })]);
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "completed" })]);
    expect((await stored())[0]).not.toHaveProperty("snapshot");
    await rt.close();

    rt = box.host();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await cards()).toHaveLength(1);
    expect(daemon.frames.filter(f => f["op"] === "git.turn")).toEqual([{ op: "git.turn", cwd, from: sha(1), to: sha(3) }]);
  });

  it("takes the commit off the row of a turn its card read failed on after the exit, so no later host reads it", async () => {
    const daemon = fakeDaemon({ files: [{ path: "src/fix.ts", kind: "modified", additions: 4, deletions: 1 }], hold: 2, refuseAt: 2 });
    const box = restartable(daemon);
    const { ws, stored } = await box.begin("fix it");
    box.run().onEvent({ type: "turn.done", sessionId: "sess-1", result: reply });
    box.run().onEvent({ type: "session.end", sessionId: "sess-1", exitCode: 0, sawResult: true });
    box.run().settle(reply);
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "completed", snapshot: sha(1) })]);
    daemon.letGo();
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "completed" })]);
    await expect.poll(async () => (await stored())[0]).not.toHaveProperty("snapshot");
    await rt!.close();

    rt = box.host();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await rt.sessions.history(ws.id)).filter(e => e.type === "session.changes")).toEqual([]);
    expect(daemon.frames.filter(f => f["op"] === "git.turn")).toEqual([]);
  });

  it("takes the commit off the row of a turn a pause cut, before its process is heard from again", async () => {
    const daemon = fakeDaemon({ files: [{ path: "src/fix.ts", kind: "modified", additions: 4, deletions: 1 }] });
    const box = restartable(daemon);
    const { ws, stored } = await box.begin("fix it");
    await expect.poll(stored).toEqual([expect.objectContaining({ status: "running", snapshot: sha(1) })]);
    await rt!.workspaces.nap(ws.id);
    await expect.poll(stored).toEqual([expect.not.objectContaining({ status: "running" })]);
    expect((await stored())[0]).not.toHaveProperty("snapshot");
  });

  it("takes a snapshot of the project folder a turn runs in, and none of a folder git holds no repo in", async () => {
    const root = mkdtempSync(join(tmpdir(), "wsp-own-folder-"));
    const folder = join(root, "work");
    const plain = join(root, "plain");
    mkdirSync(folder, { recursive: true });
    mkdirSync(plain, { recursive: true });
    execFileSync("git", ["init", "-q", folder]);
    const daemon = fakeDaemon();
    const agent = gated();
    const store = memoryStore();
    const local = { ...fakeLocal(root), daemonRoad: async () => ({ url: "http://127.0.0.1:7070", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN }) };
    try {
      rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: agent.factory }, local, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open });
      const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac", project: (await projectOn(rt, HERE_PLACE_ID, realpathSync(folder))).id });
      const inRepo = await rt.sessions.start(ws.id, { prompt: "in the repo" });
      agent.release(0);
      await inRepo.finished;
      await until(() => daemon.frames.some(f => f["op"] === "git.turn"));
      expect(daemon.frames.some(f => f["op"] === "git.snapshot")).toBe(true);
      daemon.frames.length = 0;
      const bare = await createOn(rt, { on: HERE_PLACE_ID, name: "plain", project: (await projectOn(rt, HERE_PLACE_ID, realpathSync(plain))).id });
      const own = await rt.sessions.start(bare.id, { prompt: "in a plain folder" });
      agent.release(1);
      await own.finished;
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(daemon.frames.filter(f => f["op"] === "git.snapshot" || f["op"] === "git.turn" || f["op"] === "git.checkpoint")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
