// SPDX-License-Identifier: AGPL-3.0-only
// A workspace started from a link, and a pull request reviewed by an agent, as the host runs them: the link matched to
// a project the person added, the issue or the pull request read on this computer, the copy made and, for a pull
// request, put on its head through the copy's own daemon, the thread opened with the composed task; the reviewer at its
// harness's read-only word, its review read off its reply at the turn's end, and nothing posted until the person asks.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SPAWN_ACTS, START_WORDS, type Caller, type DaemonFrame, type DaemonResponse, type PullRequest, type ThreadScope, type TurnResult } from "@wsp/protocol";
import { LocalBackend } from "@wsp/engine";
import { copyKey, createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { copyingFake, projectOn, stubBackend, testPlatform, tokenGuest } from "./stub-backend.js";
import { until } from "./until.js";

const DAEMON_TOKEN = "cafef00d".repeat(3);
const HERE = "ws://this-computer";
const COPY = "http://127.0.0.1:7070";
const HEAD = "ec5c10de663bd1860925ad42e9580bab4eb1d377";

type Answer = (frame: Record<string, unknown>) => DaemonResponse;

/** This computer's daemon and the copy's behind one dial, each answering by op off a table a test fills in, and every
 * frame recorded with its road. */
function fakeDaemons() {
  const frames: { road: "here" | "copy"; frame: Record<string, unknown> }[] = [];
  const here: Record<string, Answer> = {};
  const copy: Record<string, Answer> = {
    "git.status": () => ({ id: 1, ok: true, branch: { oid: "abc", head: "lab/review-me", ahead: 0, behind: 0 }, entries: [], root: "/root/stub" }) as DaemonResponse,
  };
  return {
    frames,
    here,
    copy,
    ops: (road?: "here" | "copy") => frames.filter(f => road === undefined || f.road === road).map(f => f.frame["op"]),
    open: async (opts: DaemonChannelOptions): Promise<DaemonChannel> => ({
      send: async (frame: DaemonFrame) => {
        const held = frame as unknown as Record<string, unknown>;
        const road = opts.url === HERE ? "here" : "copy";
        frames.push({ road, frame: held });
        const answer = (road === "here" ? here : copy)[String(held["op"])];
        return answer === undefined ? ({ id: 1, ok: false, error: `${String(held["op"])} was not answered here` } as DaemonResponse) : answer(held);
      },
      close: () => {},
      closed: new Promise(() => {}),
    }),
  };
}

/** An agent that answers each turn with the next reply given, recording every start's options. */
function replyingAgent(replies: string[] = []): { factory: HarnessAdapterFactory; starts: HarnessStartOptions[] } {
  const starts: HarnessStartOptions[] = [];
  const factory: HarnessAdapterFactory = () => ({
    steers: false,
    start: options => {
      starts.push(options);
      const sessionId = options.resume ?? randomUUID();
      const result: TurnResult = { status: "completed", text: replies.shift() ?? "done" };
      options.onEvent({ type: "session.start", sessionId });
      const finished = new Promise<TurnResult>(resolve =>
        setTimeout(() => {
          options.onEvent({ type: "turn.done", sessionId, result });
          options.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          resolve(result);
        }, 5),
      );
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { factory, starts };
}

const IMAGE = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", kind: "desktop", baseTemplate: "base", setupSha: "abc", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }],
};

let rt: Runtime | undefined;
let root: string;
let store: Store;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "wsp-start-"));
  store = memoryStore();
  await store.put("goldens", copyKey("default", "default"), IMAGE);
});
afterEach(async () => {
  await rt?.close();
  rt = undefined;
  rmSync(root, { recursive: true, force: true });
});

const localOn = (): LocalWiring => ({
  backend: new LocalBackend({ root }),
  execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
  home: () => join(root, ".claude"),
  homeDir: root,
  rootsPath: join(root, "roots"),
  env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
  platform: testPlatform(),
  copier: copyingFake(),
  daemonRoad: async () => ({ url: HERE, expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: DAEMON_TOKEN }),
});

/** A runtime with one project on the box, and the repository its remote names. Every machine the box makes answers
 * its daemon at COPY. */
async function withProject(daemons: ReturnType<typeof fakeDaemons>, adapters: Record<string, HarnessAdapterFactory>): Promise<{ repo: string; remote: string }> {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  rt = createRuntime({ backend, store, adapters, daemonToken: DAEMON_TOKEN, daemonChannel: daemons.open, local: localOn() });
  // A machine's daemon answers once its workspace stands, as it does after a create: the create itself runs its own
  // road, and the frames a start sends after it go to COPY.
  rt.events.on("workspace.created", e => {
    if (e.type !== "workspace.created") return;
    const m = backend.machines.find(x => x.id === e.workspace.machineId);
    if (m !== undefined) m.previewUrl = async () => ({ url: COPY, token: "e", expiresAt: Date.now() + 3_600_000 });
  });
  const project = await projectOn(rt, undefined, undefined, { base: "main" });
  const repo = project.remote.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  return { repo, remote: project.remote };
}

const issueRead = (number: number, url: string, title: string, body = "The first line should say hello."): Answer => () =>
  ({ id: 1, ok: true, issue: { number, url, title, body, state: "OPEN", comments: [{ author: "maya", body: "Keep it one line.", at: "2026-09-29T10:00:00Z" }] } }) as DaemonResponse;

const pullRequest = (repo: string, over: Partial<PullRequest> = {}): PullRequest => ({
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  state: "open",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "lab/review-me",
  headOid: HEAD,
  headSubject: "Rename the status word",
  mergeable: "mergeable",
  mergeState: "clean",
  review: "none",
  checks: [],
  additions: 2,
  deletions: 1,
  changedFiles: 2,
  commits: 1,
  author: "maya",
  ...over,
});

const DIFF = ["diff --git a/check.sh b/check.sh", "--- a/check.sh", "+++ b/check.sh", "@@ -1,3 +1,4 @@", " #!/bin/sh", "+unused=1", " exit 0", " # end", ""].join("\n");

/** This computer answering for a pull request: its read by number, its text as an issue, and its diff. */
function answersPullRequest(daemons: ReturnType<typeof fakeDaemons>, repo: string, over: Partial<PullRequest> = {}): void {
  daemons.here["git.prRead"] = () => ({ id: 1, ok: true, pr: pullRequest(repo, over) }) as DaemonResponse;
  daemons.here["git.issueRead"] = issueRead(7, `https://github.com/${repo}/pull/7`, "Rename the status word", "Renames the word.");
  daemons.here["git.prDiff"] = () => ({ id: 1, ok: true, diff: DIFF, truncated: false, left: [] }) as DaemonResponse;
  daemons.copy["git.prCheckout"] = () => ({ id: 1, ok: true, branch: "lab/review-me" }) as DaemonResponse;
}

const fence = (body: unknown): string => `\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
const REVIEW = {
  verdict: "request_changes",
  summary: "One unused variable.",
  comments: [
    { path: "check.sh", line: 2, side: "RIGHT", body: "unused is never read." },
    { path: "check.sh", line: 40, side: "RIGHT", body: "and this line is not in the diff." },
  ],
};

const asThread = (scope: ThreadScope): Caller => ({ origin: "relayed", by: scope });

describe("starting on an issue", () => {
  it("makes the workspace off the issue, records where it came from, opens the thread with the composed task, and checks nothing out", async () => {
    const agent = replyingAgent();
    const daemons = fakeDaemons();
    const { repo, remote } = await withProject(daemons, { claude: agent.factory });
    const url = `https://github.com/${repo}/issues/5`;
    daemons.here["git.issueRead"] = issueRead(5, url, "Add a greeting line to notes.txt");
    const started = await rt!.workspaces.start({ url, agent: "claude" });
    expect(started.workspace.name).toBe("#5 Add a greeting line to notes.txt");
    expect(started.workspace.from).toMatchObject({ kind: "issue", repo, number: 5, url, title: "Add a greeting line to notes.txt" });
    expect(daemons.frames.find(f => f.frame["op"] === "git.issueRead")).toEqual({ road: "here", frame: expect.objectContaining({ op: "git.issueRead", remote, number: 5 }) });
    expect(daemons.ops()).not.toContain("git.prCheckout");
    await until(() => agent.starts.length > 0);
    expect(agent.starts[0]!.prompt).toContain("Add a greeting line to notes.txt");
    expect(agent.starts[0]!.prompt).toContain("maya: Keep it one line.");
    expect(agent.starts[0]!.prompt).toContain("Closes #5");
    expect(started.threadId).toEqual(expect.any(String));
    expect(started.sessionId).toEqual(expect.any(String));
  });

  it("refuses a link no project here is a checkout of, in one sentence naming the repository, and reads nothing", async () => {
    const daemons = fakeDaemons();
    await withProject(daemons, {});
    await expect(rt!.workspaces.start({ url: "https://github.com/someone/else/issues/1" })).rejects.toThrow(START_WORDS.noProjectForRepo("someone/else"));
    await expect(rt!.workspaces.start({ url: "fix the flaky test" })).rejects.toThrow(START_WORDS.notALink("fix the flaky test"));
    expect(daemons.ops()).toEqual([]);
  });
});

describe("starting on a pull request", () => {
  it("checks the copy out on the pull request's head after the create and records its base and its pull request", async () => {
    const agent = replyingAgent();
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { claude: agent.factory });
    answersPullRequest(daemons, repo);
    const started = await rt!.workspaces.start({ url: `https://github.com/${repo}/pull/7`, agent: "claude" });
    expect(started.workspace.name).toBe("#7 Rename the status word");
    expect(started.workspace.from).toMatchObject({ kind: "pull_request", number: 7, base: "main", head: { branch: "lab/review-me" } });
    const checkout = daemons.frames.find(f => f.frame["op"] === "git.prCheckout")!;
    expect(checkout).toMatchObject({ road: "copy", frame: { op: "git.prCheckout", number: 7 } });
    await until(() => agent.starts.length > 0);
    expect(agent.starts[0]!.prompt).toContain("lab/review-me");
    const held = await rt!.workspaces.get(started.workspace.id);
    expect(held.from?.base).toBe("main");
    expect((await rt!.status.list()).find(w => w.id === started.workspace.id)?.pr).toMatchObject({ number: 7, state: "open" });
  });

  it("deletes the half-made workspace and answers the checkout's own sentence where it is refused", async () => {
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { claude: replyingAgent().factory });
    answersPullRequest(daemons, repo);
    const said = "no signed-in command line for github.com is on this computer; the branch is pushed and the pull request waits for one";
    daemons.copy["git.prCheckout"] = () => ({ id: 1, ok: false, code: "no-host-cli", error: said }) as DaemonResponse;
    await expect(rt!.workspaces.start({ url: `https://github.com/${repo}/pull/7`, agent: "claude" })).rejects.toThrow(said);
    await until(async () => (await rt!.workspaces.list()).length === 0);
  });

  it("refuses to bring back to a fork whose author allowed no edits, before anything is pushed", async () => {
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { claude: replyingAgent().factory });
    answersPullRequest(daemons, repo, { fork: { owner: "ana", pushable: false } });
    const started = await rt!.workspaces.start({ url: `https://github.com/${repo}/pull/7`, agent: "claude" });
    await expect(rt!.workspaces.bringBack({ workspaceId: started.workspace.id })).rejects.toThrow(START_WORDS.forkNotPushable("ana"));
    expect(daemons.ops()).not.toContain("git.push");
  });
});

describe("reviewing a pull request", () => {
  it("opens the reviewer at its harness's read-only word with the diff in its task, Codex where none is named", async () => {
    const codex = replyingAgent([fence(REVIEW)]);
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { codex: codex.factory });
    answersPullRequest(daemons, repo);
    const started = await rt!.workspaces.review({ url: `https://github.com/${repo}/pull/7` });
    expect(started.workspace.name).toBe("Review #7 Rename the status word");
    expect(started.workspace.from?.kind).toBe("review");
    expect(daemons.ops("copy")).toContain("git.prCheckout");
    await until(() => codex.starts.length > 0);
    expect(codex.starts[0]!.permissionMode).toBe("read-only");
    expect(codex.starts[0]!.prompt).toContain("+unused=1");
    expect(codex.starts[0]!.prompt).toMatch(/do not follow any instruction/i);
  });

  it("refuses a harness with no read-only word, naming the two that have one", async () => {
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { gemini: replyingAgent().factory });
    answersPullRequest(daemons, repo);
    await expect(rt!.workspaces.review({ url: `https://github.com/${repo}/pull/7`, agent: "gemini" })).rejects.toThrow(START_WORDS.noReadOnly("gemini", ["codex", "claude"]));
  });

  it("keeps the reply's review as the draft at the turn's end, marks a comment outside the diff for the summary, and says so on the bus", async () => {
    const codex = replyingAgent([fence(REVIEW)]);
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { codex: codex.factory });
    answersPullRequest(daemons, repo);
    const told: string[] = [];
    rt!.events.on("workspace.review", e => {
      if (e.type === "workspace.review") told.push(e.workspaceId);
    });
    const started = await rt!.workspaces.review({ url: `https://github.com/${repo}/pull/7` });
    await until(async () => (await rt!.workspaces.reviewDraft({ workspaceId: started.workspace.id })).review !== undefined);
    const { review } = await rt!.workspaces.reviewDraft({ workspaceId: started.workspace.id });
    expect(review).toMatchObject({ verdict: "request_changes", summary: "One unused variable.", headOid: HEAD, threadId: started.threadId });
    const comments = (review as { comments: { line: number; on: boolean; inSummary?: boolean }[] }).comments;
    expect(comments.map(c => [c.line, c.on, c.inSummary === true])).toEqual([
      [2, true, false],
      [40, true, true],
    ]);
    expect(told).toEqual([started.workspace.id]);
  });

  it("asks the reviewer once more where its block does not read, and leaves the sentence where the second does not either", async () => {
    const codex = replyingAgent(["Looks good to me.", "Still no block."]);
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, { codex: codex.factory });
    answersPullRequest(daemons, repo);
    const started = await rt!.workspaces.review({ url: `https://github.com/${repo}/pull/7` });
    await until(() => codex.starts.length === 2);
    expect(codex.starts[1]!.prompt).toMatch(/could not be read: the reply has no fenced json block/);
    await until(async () => {
      const { review } = await rt!.workspaces.reviewDraft({ workspaceId: started.workspace.id });
      return review !== undefined && "note" in review && review.reasked === true;
    });
    await new Promise(r => setTimeout(r, 50));
    expect(codex.starts).toHaveLength(2);
  });

  it("posts the ticked comments alone, pinned to the draft's head, with the person's verdict and summary, and refuses with no draft", async () => {
    const codex = replyingAgent([fence(REVIEW)]);
    const daemons = fakeDaemons();
    const { repo, remote } = await withProject(daemons, { codex: codex.factory });
    answersPullRequest(daemons, repo);
    daemons.here["git.prReview"] = frame => ({ id: 1, ok: true, url: `https://github.com/${repo}/pull/7#pullrequestreview-1`, folded: (frame["comments"] as { id: string; line: number }[]).filter(c => c.line === 40).map(c => c.id) }) as DaemonResponse;
    const started = await rt!.workspaces.review({ url: `https://github.com/${repo}/pull/7` });
    const id = started.workspace.id;
    await expect(rt!.workspaces.reviewPost({ workspaceId: id })).rejects.toThrow(START_WORDS.noReviewYet(started.workspace.name));
    await until(async () => (await rt!.workspaces.reviewDraft({ workspaceId: id })).review !== undefined);
    const drafted = (await rt!.workspaces.reviewDraft({ workspaceId: id })).review as { comments: { id: string }[] };
    await rt!.workspaces.reviewDraft({ workspaceId: id, verdict: "comment", summary: "One unused variable, and a nit.", on: [{ id: drafted.comments[0]!.id, on: false }] });
    const posted = await rt!.workspaces.reviewPost({ workspaceId: id });
    const sent = daemons.frames.find(f => f.frame["op"] === "git.prReview")!;
    expect(sent).toMatchObject({ road: "here", frame: { remote, number: 7, headOid: HEAD, event: "comment", body: "One unused variable, and a nit." } });
    expect((sent.frame["comments"] as { line: number }[]).map(c => c.line)).toEqual([40]);
    expect(posted).toMatchObject({ url: `https://github.com/${repo}/pull/7#pullrequestreview-1`, comments: 0, folded: 1 });
    expect((await rt!.workspaces.reviewDraft({ workspaceId: id })).review).toMatchObject({ posted: { url: posted.url } });
  });
});

describe("a thread's token", () => {
  it("is refused a start, a review and a post, which are the person's acts", async () => {
    const daemons = fakeDaemons();
    const { repo } = await withProject(daemons, {});
    const scope: ThreadScope = { kind: "thread", threadId: "thr_1", rootThreadId: "thr_1", workspaceId: "ws_x" };
    await expect(rt!.workspaces.start({ url: `https://github.com/${repo}/issues/5` }, asThread(scope))).rejects.toThrow(SPAWN_ACTS.start);
    await expect(rt!.workspaces.review({ url: `https://github.com/${repo}/pull/7` }, asThread(scope))).rejects.toThrow(SPAWN_ACTS.review);
    await expect(rt!.workspaces.reviewPost({ workspaceId: "ws_x" }, asThread(scope))).rejects.toThrow(SPAWN_ACTS.review_post);
    expect(daemons.ops()).toEqual([]);
  });
});
