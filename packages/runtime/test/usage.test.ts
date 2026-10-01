// SPDX-License-Identifier: AGPL-3.0-only
// The usage records as the runtime keeps them: a turn's end files its tokens
// under the sign-in its machine ran it with, a limit the harness printed files
// that account's reading, and the two answers never add one into the other.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HERE_PLACE_ID, type AdapterEvent, type DaemonFrame, type DaemonResponse, type HarnessLimit, type TurnResult } from "@wsp/protocol";
import type { DaemonChannel, DaemonChannelOptions } from "../src/daemon-channel.js";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, fakeLocal, projectOn, stubBackend, tokenGuest } from "./stub-backend.js";

/** A harness whose one turn prints what the case gives it before its result. */
const turning = (result: TurnResult, before: (sessionId: string) => AdapterEvent[] = () => []): HarnessAdapterFactory => () => ({
  steers: false,
  start: options => {
    const sessionId = `sess-${Math.random().toString(36).slice(2, 8)}`;
    const finished = (async () => {
      options.onEvent({ type: "session.start", sessionId, model: "claude-opus-5" });
      for (const e of before(sessionId)) options.onEvent(e);
      options.onEvent({ type: "turn.done", sessionId, result });
      options.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

const OAUTH = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token" };
const window: HarnessLimit = { windows: [{ kind: "session", usedPercent: 40, resetsAt: Date.now() + 3_600_000 }, { kind: "week", usedPercent: 12 }], status: "ok" };

let rt: Runtime | undefined;
afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

async function runtimeWith(adapter: HarnessAdapterFactory, vault: Record<string, string> = OAUTH) {
  const backend = stubBackend();
  backend.execImpl = tokenGuest;
  rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: adapter }, vault: () => vault, pricesFetch: async () => ({}) });
  const ws = await createOn(rt, { golden: "snap_g", name: "usage" });
  return { rt, ws };
}

describe("a turn's end in the ledger", () => {
  it("files the turn's tokens and the harness's cost under the vault's sign-in, the workspace's project and its computer", async () => {
    const result: TurnResult = { status: "completed", text: "done", costUsd: 0.12, model: "claude-opus-5", tokens: { input: 2_000, output: 300, cached: 1_500, cacheWrite: 200 } };
    const { rt, ws } = await runtimeWith(turning(result));
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    const byAccount = await rt.usage.used({ range: "day", split: "account" });
    expect(byAccount.rows).toEqual([{ key: "claude:vault-token", label: "Claude Code with your sign-in", tokens: { input: 2_000, output: 300, cached: 1_500, cacheWrite: 200, reasoning: 0 }, costReported: 0.12, priced: true, turns: 1 }]);
    const byProject = await rt.usage.used({ range: "day", split: "project" });
    expect(byProject.rows.map(r => r.label)).toEqual([ws.project.name]);
    const byAgent = await rt.usage.used({ range: "day", split: "agent" });
    expect(byAgent.rows.map(r => r.label)).toEqual(["Claude Code"]);
  });

  it("files nothing for a turn that reported no tokens and no cost", async () => {
    const { rt, ws } = await runtimeWith(turning({ status: "completed", text: "done" }));
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    expect((await rt.usage.used({ range: "day", split: "agent" })).rows).toEqual([]);
  });
});

describe("an account's limits", () => {
  it("keeps the reading a turn printed under the account the turn ran on, and the ledger's answer carries none of it", async () => {
    const { rt, ws } = await runtimeWith(turning({ status: "completed", text: "done", tokens: { input: 10, output: 1 } }, sessionId => [{ type: "limit", sessionId, limit: window }]));
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    const { accounts } = await rt.usage.accounts();
    expect(accounts).toEqual([
      expect.objectContaining({ key: "claude:vault-token", agent: "claude", label: "Claude Code with your sign-in", windows: window.windows, status: "ok", readAt: expect.any(Number) }),
    ]);
    expect(accounts[0]!.computers).toHaveLength(1);
    const used = await rt.usage.used({ range: "day", split: "account" });
    expect(JSON.stringify(used)).not.toContain("usedPercent");
  });

  it("says a turn signed in with a key has no plan limit", async () => {
    const { rt, ws } = await runtimeWith(turning({ status: "completed", text: "done" }, sessionId => [{ type: "limit", sessionId, limit: { windows: [], keyed: true } }]), { ANTHROPIC_API_KEY: "sk-ant-api-test" });
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    expect((await rt.usage.accounts()).accounts).toEqual([expect.objectContaining({ key: "claude:vault-key", note: "pays per token, no plan limit", label: "Claude Code with an API key" })]);
  });
});

describe("this computer's own sign-ins", () => {
  it("lists each agent signed in here off this computer's own read, before any turn has reported a limit", async () => {
    const asked: unknown[] = [];
    const row = (id: string, signIn: string) => ({ id, name: id, installed: true, road: "npm", signIn, signInRoad: "login", wspTools: false });
    const backend = stubBackend();
    rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: {},
      vault: () => ({}),
      pricesFetch: async () => ({}),
      agentsReader: {
        read: async (on, o) => (asked.push([on, o]), { home: "/Users/maya", user: "maya", agents: [row("claude", "signed-in"), row("codex", "signed-in"), row("opencode", "signed-in"), row("gemini", "none")], skills: [], servers: [], refused: [] }) as never,
        tools: async () => ({ auth: "open", readAt: "2026-09-25T12:00:00.000Z" }) as never,
      },
    });
    const { accounts } = await rt.usage.accounts();
    expect(accounts.map(a => [a.key, a.note, a.computers.length])).toEqual([
      ["claude@here", "not read yet: shows after its next turn", 1],
      ["codex@here", "not read yet: shows after its next turn", 1],
      ["opencode@here", "reports no plan limit", 1],
    ]);
    // A read for the accounts asks no vendor for its newest version.
    expect(asked).toEqual([[{ kind: "here" }, { latest: false }]]);
  });
});

describe("work done outside wsp", () => {
  const logRow = (session: string, folder: string, input: number) => ({ agent: "claude", session, at: Date.now(), model: "claude-opus-5", folder, tokens: { input, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 } });

  it("files the logs' rows as outside wsp, a folder inside a project under it and any other under no project, and reads none once turned off", async () => {
    let reads = 0;
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    let project = "";
    rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: turning({ status: "completed", text: "done" }) },
      pricesFetch: async () => ({}),
      local: fakeLocal(mkdtempSync(join(tmpdir(), "wsp-usage-local-"))),
      logUsage: async () => {
        reads++;
        return [logRow("s-in", `${project}/src`, 40), logRow("s-out", "/somewhere/else", 5)];
      },
    });
    // A log on this computer is work in a folder here, so it maps to this computer's projects alone.
    const here = await projectOn(rt, HERE_PLACE_ID);
    project = here.path;
    const rows = (await rt.usage.used({ range: "day", split: "project", outside: true })).rows;
    const used = await rt.usage.used({ range: "day", split: "project", outside: true });
    expect(rows.map(r => [r.label, r.tokens.input])).toEqual([
      [here.name, 40],
      ["No project", 5],
    ]);
    // The answer says whose logs it counted, by the agent's name.
    expect(used.logs?.agents).toEqual(["Claude Code"]);
    // Only a reader that asks for them gets them: the command line and its tool, whose answer an agent reads, never do.
    expect((await rt.usage.used({ range: "day", split: "project" })).rows).toEqual([]);
    await rt.preferences.set({ usageLogs: false });
    const off = reads;
    expect((await rt.usage.used({ range: "day", split: "project", outside: true })).rows).toEqual([]);
    expect(reads).toBe(off);
  });
});

describe("work outside wsp on this computer", () => {
  it("is filed under this computer's own login, not under the vault's token that a thread here ran on", async () => {
    const backend = stubBackend();
    rt = createRuntime({
      backend,
      store: memoryStore(),
      adapters: { claude: turning({ status: "completed", text: "done", tokens: { input: 10, output: 1 } }, sessionId => [{ type: "limit", sessionId, limit: window }]) },
      vault: () => OAUTH,
      pricesFetch: async () => ({}),
      local: fakeLocal(mkdtempSync(join(tmpdir(), "wsp-usage-local-"))),
      logUsage: async () => [{ agent: "claude", session: "s-terminal", at: Date.now(), model: "claude-opus-5", folder: "/somewhere", tokens: { input: 7, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 } }],
    });
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "here" });
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    const rows = (await rt.usage.used({ range: "day", split: "account", outside: true })).rows;
    expect(rows.map(r => [r.key, r.label, r.tokens.input])).toEqual([
      ["claude:vault-token", "Claude Code with your sign-in", 10],
      ["claude@here", expect.stringMatching(/^Claude Code signed in on /), 7],
    ]);
  });
});

describe("a wsp thread's own transcript", () => {
  it("is never filed as outside wsp, even from a turn that reported no tokens and so filed no row", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const fixed: HarnessAdapterFactory = () => ({
      steers: false,
      start: options => {
        const finished = (async () => {
          const result: TurnResult = { status: "completed", text: "done" };
          options.onEvent({ type: "session.start", sessionId: "sess-wsp", model: "claude-opus-5" });
          options.onEvent({ type: "turn.done", sessionId: "sess-wsp", result });
          options.onEvent({ type: "session.end", sessionId: "sess-wsp", exitCode: 0, sawResult: true });
          return result;
        })();
        return { localId: "sess-wsp", finished, interrupt: async () => {} };
      },
    });
    const row = (session: string) => ({ agent: "claude", session, at: Date.now(), model: "claude-opus-5", folder: "/somewhere", tokens: { input: 9, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 } });
    rt = createRuntime({ backend, store: memoryStore(), adapters: { claude: fixed }, vault: () => OAUTH, pricesFetch: async () => ({}), logUsage: async () => [row("sess-wsp"), row("sess-mine")] });
    const ws = await createOn(rt, { golden: "snap_g", name: "usage" });
    await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    const rows = (await rt.usage.used({ range: "day", split: "agent", outside: true })).rows;
    expect(rows.map(r => [r.key, r.tokens.input])).toEqual([["claude", 9]]);
  });
});

describe("a computer's readings", () => {
  async function readingsFrom(answer: (frame: Record<string, unknown>) => DaemonResponse) {
    const frames: Record<string, unknown>[] = [];
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const open = async (_o: DaemonChannelOptions): Promise<DaemonChannel> => ({
      send: async (frame: DaemonFrame) => {
        frames.push(frame as unknown as Record<string, unknown>);
        return answer(frame as unknown as Record<string, unknown>);
      },
      close: () => {},
      closed: new Promise(() => {}),
    });
    rt = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: "cafef00d".repeat(3), daemonChannel: open, pricesFetch: async () => ({}) });
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    backend.machines[0]!.previewUrl = async () => ({ url: "http://127.0.0.1:7070", token: "e", expiresAt: Date.now() + 3_600_000 });
    return { rt, ws, frames };
  }

  it("asks the machine's daemon for its kept minutes over the range, folded into the range's step", async () => {
    const point = { at: Date.now() - 600_000, cpu: 12.5, load1: 0.3, mem: { used: 1, total: 4 }, disk: { used: 2, total: 8 } };
    const { rt, ws, frames } = await readingsFrom(frame => ({ id: 1, ok: true, ...(frame["op"] === "sys.history" ? { points: [point], stepMs: 1_800_000, truncated: false } : {}) }) as DaemonResponse);
    const answer = await rt.usage.readings({ workspaceId: ws.id }, "week");
    expect(answer.points).toEqual([point]);
    expect(answer.to - answer.from).toBe(7 * 86_400_000);
    expect(frames.find(f => f["op"] === "sys.history")).toMatchObject({ op: "sys.history", from: answer.from, to: answer.to, stepMs: 1_800_000 });
  });

  it("hands on a daemon's refusal as it said it: one from before it kept readings names the op, and the page reads any refusal as no readings", async () => {
    const { rt, ws } = await readingsFrom(frame => (frame["op"] === "sys.history" ? { id: 1, ok: false, error: "unknown op: sys.history" } : { id: 1, ok: true }) as DaemonResponse);
    await expect(rt.usage.readings({ workspaceId: ws.id }, "day")).rejects.toThrow("unknown op: sys.history");
  });
});
