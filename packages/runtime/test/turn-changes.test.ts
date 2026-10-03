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
 * answers when the case lets it. */
function fakeDaemon(o: { files?: { path: string; kind: string; additions: number; deletions: number }[]; moved?: string[]; stall?: boolean; hold?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  let snapshots = 0;
  let letGo: () => void = () => {};
  const held = new Promise<void>(resolve => (letGo = resolve));
  const answer = async (frame: Record<string, unknown>): Promise<DaemonResponse> => {
    frames.push(frame);
    if (frame["op"] === "git.snapshot") {
      if (o.stall === true) return new Promise(() => {});
      snapshots += 1;
      const commit = sha(snapshots);
      if (o.hold === true && snapshots === 1) await held;
      return { id: 1, ok: true, commit } as DaemonResponse;
    }
    if (frame["op"] === "git.turn") return Promise.resolve({ id: 1, ok: true, base: null, truncated: false, moved: o.moved ?? [], files: (o.files ?? []).map(f => ({ ...f, patch: "" })) } as DaemonResponse);
    return Promise.resolve({ id: 1, ok: false, code: "unsupported", error: `${String(frame["op"])} is not in this case` } as DaemonResponse);
  };
  const open = async (_o: DaemonChannelOptions): Promise<DaemonChannel> => ({
    send: (frame: DaemonFrame) => answer(frame as unknown as Record<string, unknown>),
    close: () => {},
    closed: new Promise(() => {}),
  });
  return { open, frames, letGo: () => letGo() };
}

/** An adapter whose turn waits on the case's word before it replies, so two turns can overlap. */
function gated(o: { waitsForPrompt?: true } = {}): { factory: HarnessAdapterFactory; release: (n: number) => void; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const gates: (() => void)[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    ...o,
    start: (options: HarnessStartOptions) => {
      const index = starts.push(options) - 1;
      const sessionId = `sess-${index}`;
      const result: TurnResult = { status: "completed", text: "done" };
      const finished = (async () => {
        options.onEvent({ type: "session.start", sessionId } as AdapterEvent);
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
  let ws: Awaited<ReturnType<typeof createOn>>;
  if (here) {
    const root = mkdtempSync(join(tmpdir(), "wsp-turn-changes-"));
    roots.push(root);
    const folder = join(root, "work");
    mkdirSync(folder, { recursive: true });
    execFileSync("git", ["init", "-q", folder]);
    const local = { ...fakeLocal(root), daemonRoad: async () => ({ url: "http://127.0.0.1:7070", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN }) };
    rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, local, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open, ...snapshotWait });
    ws = await createOn(rt, { on: HERE_PLACE_ID, name: "changes", project: (await projectOn(rt, HERE_PLACE_ID, realpathSync(folder))).id });
  } else {
    rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, daemonToken: DAEMON_TOKEN, daemonChannel: daemon.open, ...snapshotWait });
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
  return { ws, events, turnOf };
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
