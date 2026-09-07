// SPDX-License-Identifier: AGPL-3.0-only
// The adapter here answers the store read and the store write the way the real
// ones do: one shell line to the machine, its stdout the harness's own title or
// what became of the name. What is under test is the runtime's side of it,
// which asks at a turn's end and on a refresh, names the session on the machine
// when a client renames the thread, and keeps the answer on the rows a thread
// is folded from.
import { randomUUID } from "node:crypto";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { THREAD_AGENTS, keepsRename } from "@wsp/catalog";
import type { Machine } from "@wsp/engine";
import { EMPTY_TITLE_LINE, foldThreads, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";
import { HARNESS_ADAPTERS } from "../src/adapters.js";
import { SESSION_TITLE_REFRESH_MAX, SESSION_TITLE_TTL_MS, createRuntime, type HarnessAdapter, type HarnessAdapterFactory } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const SESSION = "33333333-3333-4333-8333-333333333333";
const TITLE_COMMAND = "wsp-title-read";
const RENAME_COMMAND = "wsp-title-write";

/**
 * An adapter whose turn runs to its end on its own, and which reads its title with one line to the machine. A
 * resumed start announces the id it was given, as both real adapters do; `rekeys` mints its own local id beside it,
 * the way the codex adapter does, so two rows can share one harness session.
 */
function titledAdapter(options: { keepsTitles?: boolean; keepsNames?: boolean; rekeys?: boolean; reader?: HarnessAdapter["sessionTitle"] } = {}): HarnessAdapterFactory {
  const reader: HarnessAdapter["sessionTitle"] =
    options.reader ??
    ((sessionId, exec) => exec(`${TITLE_COMMAND} ${sessionId}`).then(stdout => (stdout.trim() === "" ? null : stdout.trim())));
  const writer: HarnessAdapter["renameSession"] = (sessionId, title, exec) =>
    exec(`${RENAME_COMMAND} ${sessionId} ${title}`).then(stdout => (stdout.trim() === "written" ? "written" : "no-session"));
  return () => ({
    steers: false,
    ...(options.keepsTitles === false ? {} : { sessionTitle: reader }),
    ...(options.keepsNames === true ? { renameSession: writer } : {}),
    start: o => {
      const sessionId = o.resume ?? SESSION;
      const result: TurnResult = { status: "completed", text: "ok" };
      const emit = (e: AdapterEvent): void => o.onEvent(e);
      const finished = Promise.resolve().then(() => {
        emit({ type: "session.start", sessionId });
        emit({ type: "turn.done", sessionId, result });
        emit({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: options.rekeys === true ? randomUUID() : sessionId, finished, interrupt: async () => {} };
    },
  });
}

/** A backend whose guest answers the title command with `titled()` and nothing else, counting the reads. With
 * `written`, it answers the write command too: the guest that takes a name says so, and one that has no such
 * session says nothing, exactly as each real store's line does. */
function titledBackend(titled: () => string | null, written?: (title: string) => boolean) {
  const backend = stubBackend();
  const reads: string[] = [];
  const writes: string[] = [];
  const inner = backend.execImpl;
  backend.execImpl = (m, cmd) => {
    if (cmd.startsWith(RENAME_COMMAND)) {
      writes.push(cmd);
      const title = cmd.slice(`${RENAME_COMMAND} `.length).split(" ").slice(1).join(" ");
      return { exitCode: 0, stdout: written?.(title) === true ? "written" : "", stderr: "" };
    }
    if (!cmd.startsWith(TITLE_COMMAND)) return inner(m, cmd);
    reads.push(cmd);
    return { exitCode: 0, stdout: titled() ?? "", stderr: "" };
  };
  return { backend, reads, writes };
}

const titleOf = async (rt: ReturnType<typeof createRuntime>, workspaceId: string): Promise<string> =>
  foldThreads(await rt.sessions.list(workspaceId))[0]!.title;

describe("the harness's own title on a thread", () => {
  it("is read from the harness's store when the turn ends and is what every client folds the thread by", async () => {
    const { backend, reads } = titledBackend(() => "Building the server");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server, and its tests" })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(reads).toEqual([`${TITLE_COMMAND} ${SESSION}`]);
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });

  it("follows a rename made inside the harness: the refresh past the window reads it, the listing after shows it", async () => {
    let named = "Building the server";
    const { backend } = titledBackend(() => named);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(await titleOf(rt, ws.id)).toBe("Building the server");

    named = "the sidebar's own name";
    // Inside the window nothing is read at all.
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
    advance(SESSION_TITLE_TTL_MS + 1);
    // Past it the read goes out, but a row that already carries a title is answered from the index rather than
    // waited on, so a wedged guest cannot empty the listing; the rename is on the row by the listing after.
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle === "the sidebar's own name");
    expect(await titleOf(rt, ws.id)).toBe("the sidebar's own name");
  });

  it("costs one read per session per window however often a client refreshes", async () => {
    const { backend, reads } = titledBackend(() => "Building the server");
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => reads.length === 1);
    for (let i = 0; i < 5; i++) await rt.sessions.list(ws.id);
    expect(reads).toHaveLength(1);
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    expect(reads).toHaveLength(2);
  });

  it("keeps the title it last read while the machine naps, and asks nothing of a machine that is not running", async () => {
    let named: string | null = "Building the server";
    const { backend, reads } = titledBackend(() => named);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => reads.length === 1);
    await rt.workspaces.nap(ws.id);
    named = null;
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
    expect(reads).toHaveLength(1);
  });

  it("outlives the process: a host that started again reads the title back off the session index", async () => {
    let named: string | null = "Building the server";
    const { backend, reads } = titledBackend(() => named);
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: { claude: titledAdapter() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    // The row's own document, which is what the next process reads the index back out of.
    const stored = async (): Promise<string | undefined> =>
      ((await store.get("sessions", ws.id)) as { sessions: { harnessTitle?: string }[] } | undefined)?.sessions[0]?.harnessTitle;
    await until(async () => (await stored()) === "Building the server");
    expect(reads).toHaveLength(1);

    named = null;
    const again = createRuntime({ backend, store, adapters: { claude: titledAdapter() } });
    expect(await titleOf(again, ws.id)).toBe("Building the server");
  });

  it("fails one row's title, never the listing, when the adapter refuses the id on the calling stack", async () => {
    // The real codex reader, whose command guard throws where it is built: a row keyed to something that is not a
    // plain slug must cost that row's title and nothing else. Review round 1, should-fix 1.
    const codex = createCodexAdapter({ exec: () => { throw new Error("no turns here"); }, home: "/root/.codex", login: "codex login" });
    const { backend } = titledBackend(() => null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ reader: codex.sessionTitle }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    try {
      await (await rt.sessions.start(ws.id, { prompt: "make a server", resume: "-not-a-slug" })).finished;
      const rows = await rt.sessions.list(ws.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty("harnessTitle");
      expect(await titleOf(rt, ws.id)).toBe("make a server");
      // The reason is said once for the window, not once per refresh.
      await rt.sessions.list(ws.id);
      expect(warn.mock.calls.filter(([line]) => String(line).includes("plain slug"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("asks about the newest sessions only, and never more than the cap in one refresh", async () => {
    // The store answers nothing throughout, so no row ever carries a title and the refresh below waits on every
    // read it starts: the count and the ids are the refresh's own.
    const { backend, reads } = titledBackend(() => null);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const ids = [...Array(SESSION_TITLE_REFRESH_MAX + 1).keys()].map(i => `s-${String(i).padStart(2, "0")}`);
    for (const id of ids) {
      advance(1_000);
      // A row's startedAt is the wall clock, which the pick sorts on, so the turns are spaced in it and not only
      // in the runtime's own clock.
      await new Promise(r => setTimeout(r, 2));
      await (await rt.sessions.start(ws.id, { prompt: `turn ${id}`, resume: id })).finished;
    }
    await until(async () => reads.length >= ids.length);
    // One listing inside the window, which waits on every read still in flight from a turn's end.
    await rt.sessions.list(ws.id);

    reads.length = 0;
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    expect(reads.map(cmd => cmd.split(" ")[1]!).sort()).toEqual(ids.slice(1).sort());
  });

  it("asks once per harness session however many of a thread's turns carry it", async () => {
    const { backend, reads } = titledBackend(() => null);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ rekeys: true }) }, clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server", resume: SESSION })).finished;
    advance(1_000);
    await (await rt.sessions.start(ws.id, { prompt: "and tests", resume: SESSION })).finished;
    // Two rows, one harness session: the adapter minted its own local id per turn, as the codex one does.
    expect((await rt.sessions.list(ws.id)).filter(v => v.claudeSessionId === SESSION)).toHaveLength(2);

    reads.length = 0;
    advance(SESSION_TITLE_TTL_MS + 1);
    await rt.sessions.list(ws.id);
    expect(reads).toEqual([`${TITLE_COMMAND} ${SESSION}`]);
  });

  it("leaves the opening turn's words alone for a harness that keeps no title, and asks its machine nothing", async () => {
    const { backend, reads } = titledBackend(() => "never asked");
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsTitles: false }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server\nand its tests" })).finished;
    expect(await titleOf(rt, ws.id)).toBe("make a server");
    expect((await rt.sessions.list(ws.id))[0]).not.toHaveProperty("harnessTitle");
    expect(reads).toEqual([]);
  });

  it("keeps the opening turn's words when the store has no title for the session, and asks again rather than caching the miss forever", async () => {
    let named: string | null = null;
    const { backend, reads } = titledBackend(() => named);
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() }, clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server" })).finished;
    await until(async () => reads.length === 1);
    expect(await titleOf(rt, ws.id)).toBe("make a server");
    named = "Building the server";
    advance(SESSION_TITLE_TTL_MS + 1);
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });
});

describe("naming a thread from wsp", () => {
  it("writes the name into the harness's own store and keeps it on every row of the thread", async () => {
    let named: string | null = null;
    const { backend, writes } = titledBackend(() => named, title => {
      named = title;
      return true;
    });
    const { clock, advance } = fakeClock();
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true, rekeys: true }) }, clock });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    await (await rt.sessions.start(ws.id, { prompt: "make a server", resume: SESSION })).finished;
    advance(1_000);
    const second = await rt.sessions.start(ws.id, { prompt: "and tests", resume: SESSION });
    await second.finished;

    expect(await rt.sessions.rename(second.id, "the name he typed in wsp")).toEqual({ outcome: "renamed" });
    expect(writes).toEqual([`${RENAME_COMMAND} ${SESSION} the name he typed in wsp`]);
    const rows = (await rt.sessions.list(ws.id)).filter(v => v.claudeSessionId === SESSION);
    expect(rows).toHaveLength(2);
    expect(rows.map(v => v.harnessTitle)).toEqual(["the name he typed in wsp", "the name he typed in wsp"]);
    expect(await titleOf(rt, ws.id)).toBe("the name he typed in wsp");
    // The harness's own store is where the name now lives, so the next read past the window brings it back.
    advance(SESSION_TITLE_TTL_MS + 1);
    expect(await titleOf(rt, ws.id)).toBe("the name he typed in wsp");
  });

  it("outlives the process: the name is on the session index the next host reads back", async () => {
    const store = memoryStore();
    const { backend } = titledBackend(() => null, () => true);
    const rt = createRuntime({ backend, store, adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await rt.sessions.rename(session.id, "the name");
    expect(((await store.get("sessions", ws.id)) as { sessions: { harnessTitle?: string }[] }).sessions[0]?.harnessTitle).toBe("the name");
  });

  it("answers unsupported for a harness that keeps no name of a person's, and asks its machine nothing", async () => {
    const { backend, writes } = titledBackend(() => null, () => true);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter() } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    expect(await rt.sessions.rename(session.id, "the name")).toEqual({ outcome: "unsupported" });
    expect(writes).toEqual([]);
    expect(await titleOf(rt, ws.id)).toBe("make a server");
  });

  it("answers no-session when the store took nothing, and the row keeps the title it had", async () => {
    const { backend } = titledBackend(() => "Building the server", () => false);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await until(async () => (await rt.sessions.list(ws.id))[0]?.harnessTitle !== undefined);
    expect(await rt.sessions.rename(session.id, "the name")).toEqual({ outcome: "no-session" });
    expect(await titleOf(rt, ws.id)).toBe("Building the server");
  });

  it("answers not-found for a session this runtime does not hold", async () => {
    const { backend } = titledBackend(() => null, () => true);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    await rt.workspaces.create({ golden: "snap_g", name: "a" });
    expect(await rt.sessions.rename("no-such-session", "the name")).toEqual({ outcome: "not-found" });
  });

  it("refuses a name that is nothing but space, before it asks anything of the machine", async () => {
    const { backend, writes } = titledBackend(() => null, () => true);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await expect(rt.sessions.rename(session.id, "   ")).rejects.toThrow(EMPTY_TITLE_LINE);
    expect(writes).toEqual([]);
  });

  it("refuses while the machine is not up, since the name goes into a store on it", async () => {
    const { backend, writes } = titledBackend(() => null, () => true);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server" });
    await session.finished;
    await rt.workspaces.nap(ws.id);
    await expect(rt.sessions.rename(session.id, "the name")).rejects.toThrow("wake it to rename");
    expect(writes).toEqual([]);
  });

  it("names the session the harness announced, whatever the runtime calls the row", async () => {
    const { backend, writes } = titledBackend(() => null, () => true);
    const rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: titledAdapter({ keepsNames: true, rekeys: true }) } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "a" });
    const session = await rt.sessions.start(ws.id, { prompt: "make a server", resume: SESSION });
    await session.finished;
    expect(session.id).not.toBe(SESSION);
    await rt.sessions.rename(session.id, "the name");
    expect(writes).toEqual([`${RENAME_COMMAND} ${SESSION} the name`]);
  });
});

describe("the agents whose store keeps a name", () => {
  it("is one fact: every agent the catalog says keeps a rename is the one whose adapter carries the write", () => {
    const machine = { id: "m_1" } as unknown as Machine;
    for (const id of THREAD_AGENTS) {
      const adapter = HARNESS_ADAPTERS[id]({ machine, workspaceId: "ws_1", env: {} });
      expect(adapter.renameSession !== undefined, id).toBe(keepsRename(id));
    }
    expect(THREAD_AGENTS.filter(keepsRename)).toEqual(["claude", "codex"]);
  });
});
