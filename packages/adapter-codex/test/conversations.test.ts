// SPDX-License-Identifier: AGPL-3.0-only
// Codex's threads read for a person picking one up: the real adapter's scripts run under bash against a fake app
// server that answers with what codex-cli 0.162.1 answered in a throwaway home (a TUI's thread, a wsp thread, their
// turns and items, a fork, and the refusal of a second writer).
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { ConversationRoad } from "@wsp/protocol";
import { createCodexAdapter } from "../src/adapter.js";
import { fakeAppServer, type Json } from "./fake-app-server.js";

const RECORDED = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "app-server-threads-0.162.1.json"), "utf8")) as Record<string, Json>;
const TUI = "01a12813-cd12-7a12-9b13-e76892906ff0";
const WSP = "01a12813-ce2c-7600-87d3-bfff156be264";
const LAB = "/work/acme/lab";

const run = promisify(execFile);
const input = (env: Readonly<Record<string, string>> = {}): string => Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join("");

const made: (() => void)[] = [];
afterAll(() => made.splice(0).forEach(remove => remove()));

/** The real adapter's store, its every line run under bash with the variables on its input as a machine's exec runs
 * them, against a fake app server answering each method as given. */
function storeOver(answers: Json): { store: ReturnType<typeof createCodexAdapter>["conversations"]; road: ConversationRoad; requests: () => Json[] } {
  const f = fakeAppServer(answers);
  made.push(f.remove);
  const codex = createCodexAdapter({ exec: () => { throw new Error("no turns here"); }, home: f.home, login: "codex login", baseEnv: { PATH: f.path } });
  const exec = async (command: string, env?: Readonly<Record<string, string>>): Promise<string> => {
    const running = run("bash", ["-c", command], { env: { PATH: "/usr/bin:/bin", HOME: tmpdir() } });
    running.child.stdin?.end(input(env));
    return (await running).stdout;
  };
  return { store: codex.conversations, road: { exec, ask: () => Promise.reject(new Error("codex asks no daemon")) }, requests: () => f.requests().filter(r => r["id"] !== undefined && r["method"] !== "initialize") };
}

/** The recorded thread/list answer with each rollout moved to a file of a known size in a folder of the test's. */
function listedWithFiles(): { answer: Json; sizes: Record<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), "wsp-codex-rollouts-"));
  made.push(() => rmSync(dir, { recursive: true, force: true }));
  const answer = structuredClone(RECORDED["thread-list"]!) as { result: { data: Json[] } };
  const sizes: Record<string, number> = {};
  answer.result.data.forEach((thread, i) => {
    const path = join(dir, `rollout-${i}.jsonl`);
    writeFileSync(path, "x".repeat(1000 * (i + 1)));
    thread["path"] = path;
    sizes[String(thread["id"])] = 1000 * (i + 1);
  });
  return { answer, sizes };
}

describe("the threads Codex kept in a folder", () => {
  it("come off thread/list on the computer's own app server, newest first, with a name, a branch, an origin and a size", async () => {
    const { answer, sizes } = listedWithFiles();
    const { store, road, requests } = storeOver({ "thread/list": answer });
    const rows = await store.list([LAB, `${LAB}-wt`], road);
    expect(requests().map(r => [r["method"], r["params"]])).toEqual([["thread/list", { cwd: [LAB, `${LAB}-wt`], sortKey: "recency_at", limit: 100 }]]);
    expect(rows).toEqual([
      { id: WSP, title: "first prompt from wsp", firstPrompt: "first prompt from wsp", branch: "feat/x", cwd: LAB, lastAt: 1_791_673_749_000, origin: "wsp", bytes: sizes[WSP] },
      { id: TUI, title: "lab terminal thread", firstPrompt: "first prompt from codex-tui", branch: "feat/x", cwd: LAB, lastAt: 1_791_673_748_000, origin: "terminal", bytes: sizes[TUI] },
    ]);
  });

  it("pages thread/list by its cursor, and leaves out the size of a rollout that is not there", async () => {
    const recorded = RECORDED["thread-list"] as { result: { data: Json[] } };
    const first = { result: { data: [recorded.result.data[0]], nextCursor: "page-2", backwardsCursor: null } };
    const second = { result: { data: [recorded.result.data[1]], nextCursor: null, backwardsCursor: null } };
    const { store, road, requests } = storeOver({ "thread/list": [first, second] });
    const rows = await store.list([LAB], road);
    expect(rows.map(r => r.id)).toEqual([WSP, TUI]);
    expect(rows.every(r => r.bytes === undefined)).toBe(true);
    expect(requests().map(r => (r["params"] as Json)["cursor"])).toEqual([undefined, "page-2"]);
  });

  it("asks nothing for no folder at all", async () => {
    const { store, road, requests } = storeOver({});
    expect(await store.list([], road)).toEqual([]);
    expect(requests()).toEqual([]);
  });
});

describe("a Codex thread's earlier messages", () => {
  const answered = { "thread/resume": { result: (RECORDED["thread-read"] as Json)["result"] }, "thread/read": RECORDED["thread-read"], "thread/turns/list": RECORDED["turns-list"], "thread/items/list": RECORDED["items-list"] };

  it("come off thread/turns/list and thread/items/list, the thread opened as a writer first where a start asks", async () => {
    const { store, road, requests } = storeOver(answered);
    const read = await store.earlier(TUI, { cwds: [LAB], last: 200, probe: true }, road);
    expect(read).toEqual({
      cwd: LAB,
      title: "lab terminal thread",
      lines: [
        { who: "person", text: "first prompt from codex-tui" },
        { who: "agent", text: "stub reply to: first prompt from codex-tui" },
        { who: "person", text: "second turn" },
        { who: "agent", text: "stub reply to: second turn" },
      ],
      earlier: 0,
    });
    expect(requests().map(r => r["method"])).toEqual(["thread/resume", "thread/turns/list", "thread/items/list"]);
    expect((requests()[1]!["params"] as Json)["sortDirection"]).toBe("desc");
  });

  it("keep the newest messages and count the rest, and read the thread without taking it for a copy", async () => {
    const { store, road, requests } = storeOver(answered);
    const read = await store.earlier(TUI, { cwds: [LAB], last: 1, probe: false }, road);
    expect(read).toEqual({ cwd: LAB, title: "lab terminal thread", lines: [{ who: "agent", text: "stub reply to: second turn" }], earlier: 3 });
    expect(requests()[0]!["method"]).toBe("thread/read");
  });

  it("are open where Codex refuses the resume a second writer, and gone where it holds no such thread", async () => {
    const held = storeOver({ ...answered, "thread/resume": RECORDED["resume-held"] });
    expect(await held.store.earlier(TUI, { cwds: [LAB], last: 200, probe: true }, held.road)).toBe("open");
    const gone = storeOver({ ...answered, "thread/resume": { error: { code: -32600, message: `no rollout found for thread id ${TUI}` } } });
    expect(await gone.store.earlier(TUI, { cwds: [LAB], last: 200, probe: true }, gone.road)).toBe("gone");
    const unread = storeOver({ ...answered, "thread/read": { error: { code: -32600, message: `thread not loaded: ${TUI}` } } });
    expect(await unread.store.earlier(TUI, { cwds: [LAB], last: 200, probe: false }, unread.road)).toBe("gone");
  });

  it("refuse an id that is not a plain slug before anything runs", async () => {
    const { store, road, requests } = storeOver(answered);
    await expect(store.earlier("x' or '1'='1", { cwds: [LAB], last: 1, probe: false }, road)).rejects.toThrow(/plain slug/);
    expect(requests()).toEqual([]);
  });

  it("say a person may try again once Codex lets go, and how soon", () => {
    const { store } = storeOver({});
    expect(store.letsGo).toMatch(/about a minute after its window closes/);
  });
});

describe("the recorded fork", () => {
  it("is a thread of its own that names the one it was copied from", () => {
    const thread = ((RECORDED["fork"] as Json)["result"] as Json)["thread"] as Json;
    expect(thread["forkedFromId"]).toBe(TUI);
    expect(thread["ephemeral"]).toBe(false);
  });
});
