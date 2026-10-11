// SPDX-License-Identifier: AGPL-3.0-only
// Conversations an agent kept on this computer outside wsp: the one list a project answers, read through each agent's
// own store on the project's computer, and a thread opened on one of them, in the folder it ran in, under its own name,
// with its earlier messages ahead of the first prompt. The stores are fakes with the adapters' own shape, except where
// the daemon's op is the point; the daemon is a fake; git is real.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { claudeConversations } from "@wsp/adapter-claude";
import {
  CONVERSATION_OPEN_KIND,
  conversationOpenFix,
  conversationsUnreadLine,
  conversationsUpdateFix,
  earlierLine,
  foldThreads,
  refusalParts,
  type AdapterEvent,
  type ConversationEarlier,
  type ConversationStore,
  type DaemonFrame,
  type DaemonResponse,
  type StoredConversation,
  type TurnResult,
} from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { gitCopier } from "./git-copier.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();

const ID = "7414323d-e71b-4957-8b56-eefdf6bfa350";
const OTHER = "e615a6ab-a2f2-4b10-8fd6-0dc38bf99c28";

const roots: string[] = [];
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-conversations-")));
  roots.push(root);
  return root;
};
/** A repo on main with one commit, and a worktree of it on a branch of its own beside it. */
const repoWithTree = (): { folder: string; tree: string } => {
  const folder = join(scratch(), "lab");
  mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  git(folder, "commit", "-q", "--allow-empty", "-m", "first");
  const tree = `${folder}-wt`;
  git(folder, "worktree", "add", "-q", "-b", "feat/x", tree);
  return { folder, tree };
};

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** What a harness was handed and asked. */
interface Seen {
  starts: HarnessStartOptions[];
  seeds: string[];
  renames: string[];
}

let n = 0;
/** A harness that answers each turn at once, a resume under its own session and a copy under a new one, and records
 * what it was started with, the seed it was handed where it reads one, and every name written into its store. */
function harness(seen: Seen, store?: ConversationStore): HarnessAdapterFactory {
  return () => ({
    steers: false,
    attachments: "inline",
    ...(store !== undefined ? { conversations: store } : {}),
    renameSession: async (id, title) => {
      seen.renames.push(`${id}:${title}`);
      return { kind: "written" };
    },
    start: o => {
      n += 1;
      seen.starts.push(o);
      const sessionId = o.copy === true || o.resume === undefined ? `55555555-5555-4555-8555-${String(n).padStart(12, "0")}` : o.resume;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = (async () => {
        if (o.seed !== undefined) seen.seeds.push(await o.seed());
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      })();
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

/** A store with the adapters' shape over rows, open ids and one conversation's earlier messages, recording the folders
 * each read was given. */
function fakeStore(o: { rows?: StoredConversation[]; live?: string[] | null; earlier?: ConversationEarlier | "gone" | "open" | ((probe: boolean) => ConversationEarlier | "gone" | "open"); letsGo?: string }): ConversationStore & { asked: { cwds: readonly string[]; probe?: boolean }[] } {
  const asked: { cwds: readonly string[]; probe?: boolean }[] = [];
  return {
    asked,
    ...(o.letsGo !== undefined ? { letsGo: o.letsGo } : {}),
    list: async cwds => {
      asked.push({ cwds });
      return o.rows ?? [];
    },
    ...(o.live !== undefined ? { live: async () => (o.live === null ? null : new Set(o.live)) } : {}),
    earlier: async (_id, read) => {
      asked.push({ cwds: read.cwds, probe: read.probe });
      const e = o.earlier ?? "gone";
      return typeof e === "function" ? e(read.probe) : e;
    },
  };
}

function here(stores: { claude?: ConversationStore; codex?: ConversationStore }, daemonAnswers: Record<string, (f: Record<string, unknown>) => DaemonResponse> = {}) {
  const root = scratch();
  const seen: Seen = { starts: [], seeds: [], renames: [] };
  const open = async (): Promise<DaemonChannel> => ({
    send: async (frame: DaemonFrame) => {
      const f = frame as unknown as Record<string, unknown>;
      const answer = daemonAnswers[String(f["op"])];
      if (answer !== undefined) return answer(f);
      if (f["op"] === "git.checkpoint") return { id: 1, ok: true, ref: "refs/wsp/checkpoints/x", commit: "c", changed: false } as DaemonResponse;
      return { id: 1, ok: false, error: `unknown op: ${String(f["op"])}` } as DaemonResponse;
    },
    close: () => {},
    closed: new Promise(() => {}),
  });
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    platform: testPlatform(),
    copier: gitCopier(),
    daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
  };
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  rt = createRuntime({
    backend: stubBackend(),
    store: memoryStore(),
    adapters: { claude: harness(seen, stores.claude), codex: harness(seen, stores.codex) },
    local,
    statePath: join(state, "state.json"),
    daemonChannel: open,
  });
  return { rt, seen };
}

/** The serve road of a start on a conversation: placed reads it on the project's computer and names the record of the
 * folder it ran in, which the start then runs on. */
async function startOn(rt: Runtime, project: string, resume: { id: string; copy?: boolean }, prompt = "go on", harness?: string) {
  const at = await rt.conversations.placed({ project, ...(harness !== undefined ? { harness } : {}) }, resume);
  const handle = await rt.sessions.start(at.workspaceId, { prompt, ...(at.cwd !== undefined ? { cwd: at.cwd } : {}), outside: at.outside });
  await handle.finished;
  const workspace = (await rt.workspaces.list()).find(w => w.id === at.workspaceId)!;
  return { workspace, outside: at.outside };
}

const row = (id: string, cwd: string, lastAt: number, extra: Partial<StoredConversation> = {}): StoredConversation => ({ id, title: `t-${id.slice(0, 4)}`, cwd, lastAt, origin: "terminal", ...extra });

describe("a project's conversations", () => {
  it("are every agent's in the folder and its worktrees, in one list newest first, a script's left out", async () => {
    const { folder, tree } = repoWithTree();
    const claude = fakeStore({ rows: [row(ID, folder, 100, { branch: "main", bytes: 2048 }), row(OTHER, tree, 300, { origin: "script" })], live: [] });
    const codex = fakeStore({ rows: [row("01a12813-cd12-7a12-9b13-e76892906ff0", tree, 200, { title: "lab terminal thread" })], letsGo: "It lets go a minute later." });
    const { rt } = here({ claude, codex });
    const project = await rt.projects.add({ source: folder });
    const answer = await rt.conversations.list({ project: project.id });
    expect(claude.asked[0]!.cwds).toEqual([folder, tree]);
    expect(codex.asked[0]!.cwds).toEqual([folder, tree]);
    expect(answer.held).toEqual([]);
    expect(answer.rows).toEqual([
      { agent: "codex", id: "01a12813-cd12-7a12-9b13-e76892906ff0", title: "lab terminal thread", cwd: tree, lastAt: 200, origin: "terminal", live: false, letsGo: "It lets go a minute later." },
      { agent: "claude", id: ID, title: "t-7414", cwd: folder, lastAt: 100, origin: "terminal", live: false, branch: "main", bytes: 2048 },
    ]);
    expect((await rt.conversations.list({ project: project.id, agent: "claude" })).rows.map(r => r.agent)).toEqual(["claude"]);
  });

  it("mark a wsp thread's own session as wsp's, with its thread, never open elsewhere, and another app's open one as live", async () => {
    const { folder } = repoWithTree();
    const live: string[] = [];
    const rows: StoredConversation[] = [];
    const { rt, seen } = here({ claude: fakeStore({ rows, live }) });
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id });
    const handle = await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" });
    await handle.finished;
    const mine = (await rt.sessions.list(at.workspace.id))[0]!;
    rows.push(row(mine.claudeSessionId!, folder, 50, { origin: "script" }), row(OTHER, folder, 40));
    live.push(mine.claudeSessionId!, OTHER);
    const answer = await rt.conversations.list({ project: project.id });
    expect(answer.rows.map(r => [r.id, r.origin, r.live, r.thread])).toEqual([
      [mine.claudeSessionId, "wsp", false, mine.threadId],
      [OTHER, "terminal", true, undefined],
    ]);
    expect(seen.starts).toHaveLength(1);
  });

  it("from a daemon without the op are the other agents' rows and one line in two halves naming the update", async () => {
    const { folder } = repoWithTree();
    const claude = { ...claudeConversations({ configDir: "/home/dev/.claude" }), live: async () => null };
    const codex = fakeStore({ rows: [row("01a12813-cd12-7a12-9b13-e76892906ff0", folder, 200)] });
    const { rt } = here({ claude, codex });
    const project = await rt.projects.add({ source: folder });
    const answer = await rt.conversations.list({ project: project.id });
    expect(answer.rows.map(r => r.agent)).toEqual(["codex"]);
    expect(answer.held).toHaveLength(1);
    const held = answer.held[0]!;
    expect(held.agent).toBe("claude");
    expect(held.said).toBe(conversationsUnreadLine("Claude Code", "this computer"));
    expect(held.fix).toBe(conversationsUpdateFix("this computer"));
  });

  it("leave out an agent whose store answered nothing, the others' rows standing", async () => {
    const { folder } = repoWithTree();
    const codex: ConversationStore = { list: () => Promise.reject(new Error("codex: command not found")), earlier: async () => "gone" };
    const claude = fakeStore({ rows: [row(ID, folder, 100)], live: [] });
    const { rt } = here({ claude, codex });
    const project = await rt.projects.add({ source: folder });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const answer = await rt.conversations.list({ project: project.id });
    expect(answer).toEqual({ rows: [expect.objectContaining({ agent: "claude", id: ID })], held: [] });
    expect(warned.mock.calls.flat().join("\n")).toContain("codex: command not found");
    warned.mockRestore();
  });

  it("come off the daemon's transcripts.list where it has the op, under the store the turns read", async () => {
    const { folder } = repoWithTree();
    const frames: Record<string, unknown>[] = [];
    const claude = { ...claudeConversations({ configDir: "/home/dev/.claude" }), live: async () => null };
    const { rt } = here({ claude }, {
      "transcripts.list": f => {
        frames.push(f);
        return { id: 1, ok: true, rows: [{ id: ID, cwd: folder, entrypoint: "cli", title: "lab codewords", lastAt: 9, bytes: 10 }] } as unknown as DaemonResponse;
      },
    });
    const project = await rt.projects.add({ source: folder });
    expect((await rt.conversations.list({ project: project.id })).rows).toEqual([{ agent: "claude", id: ID, title: "lab codewords", cwd: folder, lastAt: 9, bytes: 10, origin: "terminal", live: false }]);
    expect(frames[0]).toMatchObject({ op: "transcripts.list", root: "/home/dev/.claude/projects", cwds: [folder, `${folder}-wt`] });
  });
});

describe("a thread opened on a conversation from outside wsp", () => {
  const earlier = (cwd: string): ConversationEarlier => ({
    cwd,
    title: "lab codewords",
    lines: [
      { who: "person", text: "Remember the codeword ALPHA." },
      { who: "tool", text: '{"command":"echo hi-from-tool"}', tool: "Bash" },
      { who: "agent", text: "ALPHA" },
    ],
    earlier: 3,
  });

  it("resumes that id under the start's agent, in the folder it ran in, on that folder's record, named as it is, writing nothing into the agent's store", async () => {
    const { folder, tree } = repoWithTree();
    const { rt, seen } = here({ claude: fakeStore({ earlier: earlier(tree), live: [] }) });
    const project = await rt.projects.add({ source: folder });
    const { workspace } = await startOn(rt, project.id, { id: ID });
    expect(seen.starts).toHaveLength(1);
    expect(seen.starts[0]).toMatchObject({ resume: ID, cwd: tree });
    expect(seen.starts[0]!.copy).toBeUndefined();
    expect(seen.starts[0]!.title).toBeUndefined();
    expect(workspace.worktree?.path).toBe(tree);
    const rows = await rt.sessions.list(workspace.id);
    expect(rows[0]).toMatchObject({ harness: "claude", claudeSessionId: ID, harnessTitle: "lab codewords", titleSource: "auto" });
    expect(foldThreads(rows)[0]!.title).toBe("lab codewords");
    await new Promise(r => setTimeout(r, 20));
    expect(seen.renames).toEqual([]);
  });

  it("opens with the conversation's earlier messages once, ahead of the prompt, a call as its line and the rest counted", async () => {
    const { folder } = repoWithTree();
    const { rt, seen } = here({ claude: fakeStore({ earlier: earlier(folder), live: [] }) });
    const project = await rt.projects.add({ source: folder });
    const { workspace } = await startOn(rt, project.id, { id: ID });
    const events = await rt.sessions.history(workspace.id);
    const threadId = (await rt.sessions.list(workspace.id))[0]!.threadId!;
    const shown = events.filter(e => e.threadId === threadId).map(e => (e.type === "session.earlier" ? `${e.who}: ${e.text}` : e.type === "session.start" ? `start: ${e.prompt ?? ""}` : e.type));
    expect(shown.slice(0, 5)).toEqual([
      `note: ${earlierLine(3, "Claude Code")}`,
      "person: Remember the codeword ALPHA.",
      "tool: $ echo hi-from-tool",
      "agent: ALPHA",
      "start: go on",
    ]);
    await (await rt.sessions.start(workspace.id, { prompt: "and again", thread: threadId })).finished;
    const after = (await rt.sessions.history(workspace.id)).filter(e => e.type === "session.earlier");
    expect(after).toHaveLength(4);
    expect(seen.starts[1]).toMatchObject({ resume: ID });
  });

  it("hands a lost session's seed the earlier messages it opened with", async () => {
    const { folder } = repoWithTree();
    const { rt, seen } = here({ claude: fakeStore({ earlier: earlier(folder), live: [] }) });
    const project = await rt.projects.add({ source: folder });
    await startOn(rt, project.id, { id: ID });
    expect(seen.seeds).toHaveLength(1);
    expect(seen.seeds[0]).toContain("Remember the codeword ALPHA.");
    expect(seen.seeds[0]).toContain("ALPHA");
    expect(seen.seeds[0]).not.toContain("go on");
  });

  it("is refused in two halves with its own kind where another app holds it open, and runs nothing", async () => {
    const { folder } = repoWithTree();
    const { rt, seen } = here({ claude: fakeStore({ earlier: earlier(folder), live: [ID] }) });
    const project = await rt.projects.add({ source: folder });
    const refused = await startOn(rt, project.id, { id: ID }).catch((e: unknown) => e);
    const parts = refusalParts(refused);
    expect(parts.kind).toBe(CONVERSATION_OPEN_KIND);
    expect(parts.said).toBe("lab codewords is open in another app on this computer, so continuing it here would split it.");
    expect(parts.fix).toBe(conversationOpenFix(undefined));
    expect(seen.starts).toEqual([]);
  });

  it("is refused the same where the agent itself refuses a second writer, and says when it lets go", async () => {
    const { folder } = repoWithTree();
    const codex = fakeStore({ earlier: probe => (probe ? "open" : earlier(folder)), letsGo: "It lets go a minute later." });
    const { rt, seen } = here({ codex });
    const project = await rt.projects.add({ source: folder });
    const refused = refusalParts(await startOn(rt, project.id, { id: ID }, "x", "codex").catch((e: unknown) => e));
    expect(refused.kind).toBe(CONVERSATION_OPEN_KIND);
    expect(refused.said).toMatch(/^lab codewords is open in another app/);
    expect(refused.fix).toBe(conversationOpenFix("It lets go a minute later."));
    expect(seen.starts).toEqual([]);
  });

  it("runs on a copy where the start asks one, read without taking it and never refused as open", async () => {
    const { folder } = repoWithTree();
    const codex = fakeStore({ earlier: probe => (probe ? "open" : earlier(folder)), letsGo: "It lets go a minute later.", live: [ID] });
    const { rt, seen } = here({ codex });
    const project = await rt.projects.add({ source: folder });
    const { workspace } = await startOn(rt, project.id, { id: ID, copy: true }, "on a copy", "codex");
    expect(codex.asked.filter(a => a.probe !== undefined).map(a => a.probe)).toEqual([false]);
    expect(seen.starts[0]).toMatchObject({ resume: ID, copy: true });
    const mine = (await rt.sessions.list(workspace.id))[0]!;
    expect(mine.claudeSessionId).not.toBe(ID);
    expect(seen.seeds).toEqual([]);
    await new Promise(r => setTimeout(r, 20));
    expect(seen.renames).toEqual([]);
  });

  it("is refused beside a thread, a branch or a folder, since the conversation names where it runs", async () => {
    const { folder } = repoWithTree();
    const { rt, seen } = here({ claude: fakeStore({ earlier: earlier(folder), live: [] }) });
    const project = await rt.projects.add({ source: folder });
    for (const beside of [{ branch: "feat/x" }, { cwd: folder }, { thread: "th_1" }]) {
      const refused = refusalParts(await rt.conversations.placed({ project: project.id, ...beside }, { id: ID }).catch((e: unknown) => e));
      expect([refused.kind, refused.said]).toEqual(["usage", "a resumed conversation runs where it ran, so --resume takes no --branch, --cwd or --beside."]);
    }
    expect(seen.starts).toEqual([]);
  });

  it("is refused before any turn where the agent holds no such conversation, never opening a new one", async () => {
    const { folder } = repoWithTree();
    const { rt, seen } = here({ claude: fakeStore({ earlier: "gone", live: [] }) });
    const project = await rt.projects.add({ source: folder });
    const refused = refusalParts(await startOn(rt, project.id, { id: ID }).catch((e: unknown) => e));
    expect(refused.kind).toBe("not-found");
    expect(refused.said).toBe(`Claude Code holds no conversation ${ID} on this computer any more.`);
    expect(refused.fix).toBe("Pick one that is still there from wsp conversations.");
    expect(seen.starts).toEqual([]);
  });

  it("is refused where the conversation is a wsp thread already, which is the thread to send into", async () => {
    const { folder } = repoWithTree();
    const { rt } = here({ claude: fakeStore({ earlier: earlier(folder), live: [] }) });
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" })).finished;
    const mine = (await rt.sessions.list(at.workspace.id))[0]!;
    const refused = refusalParts(await startOn(rt, project.id, { id: mine.claudeSessionId! }).catch((e: unknown) => e));
    expect(refused.kind).toBe("usage");
    expect(refused.said).toContain(`is thread ${mine.threadId!.slice(0, 8)} already`);
  });

  it("refuses a conversation on a send into a thread that has run", async () => {
    const { folder } = repoWithTree();
    const { rt } = here({ claude: fakeStore({ earlier: earlier(folder), live: [] }) });
    const project = await rt.projects.add({ source: folder });
    const at = await rt.workspaces.folderFor({ project: project.id });
    await (await rt.sessions.start(at.workspace.id, { prompt: "hello", harness: "claude" })).finished;
    const threadId = (await rt.sessions.list(at.workspace.id))[0]!.threadId!;
    const outside = await rt.conversations.opening(at.workspace.id, { resume: { id: OTHER } }).catch(() => ({ harness: "claude", id: OTHER, copy: false, project: project.id, title: "x", earlier: [] }));
    const refused = refusalParts(await rt.sessions.start(at.workspace.id, { prompt: "x", thread: threadId, outside }).catch((e: unknown) => e));
    expect(refused.kind).toBe("usage");
    expect(refused.said).toMatch(/--resume opens a thread/);
  });
});
