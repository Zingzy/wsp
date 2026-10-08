// SPDX-License-Identifier: AGPL-3.0-only
// Work on a joined computer as its own daemon reads it off the agents' logs there: filed under that computer, a wsp
// turn there counted once, and its plan readings on the Limits rows, a computer away read as not read.
import { describe, expect, it } from "vitest";
import { USAGE_WORDS, type TurnResult, type UsageLogsReply } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { createOn, projectOn, stubBackend } from "./stub-backend.js";
import { report, wiring } from "./place-join.js";
import { ctx, sockets, code, join, forks, asRoot, KEEPS_NO_IMAGE, ROOT_LOGIN } from "./places-fixture.js";
import { until } from "./until.js";
import type { WsClient } from "./ws-client.js";

const tokens = (input: number) => ({ input, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 });

/** A box's daemon answering usage.logs with what the case hands it, keeping every frame it was asked. */
function readsLogs(c: WsClient, logs: () => UsageLogsReply, asked: Record<string, unknown>[]): void {
  c.onFrame(raw => {
    const frame = raw as unknown as Record<string, unknown>;
    if (frame["op"] !== "usage.logs") return;
    asked.push(frame);
    c.say({ id: frame["id"], ok: true, ...logs() });
  });
}

/** A Claude harness whose every turn runs as one session and reports its tokens. */
const oneSession = (sessionId: string, input: number): HarnessAdapterFactory => () => ({
  steers: false,
  start: ({ onEvent }) => {
    const result: TurnResult = { status: "completed", text: "ok", model: "claude-opus-5", tokens: { input, output: 1 } };
    onEvent({ type: "session.start", sessionId, model: "claude-opus-5" });
    onEvent({ type: "turn.done", sessionId, result });
    onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
    return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
  },
});

async function host(adapters: Record<string, HarnessAdapterFactory> = {}) {
  const hostKey = newPlaceKeyPair();
  ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters, placeLinks: wiring(hostKey), pricesFetch: async () => ({}) });
  ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
  return { rt: ctx.runtime, hostKey };
}

describe("work on a joined computer outside wsp", () => {
  it("is read by that computer's own daemon off the agents' stores and filed under it, a folder in its project under that project", async () => {
    const { rt, hostKey } = await host();
    const asked: Record<string, unknown>[] = [];
    let folder = "";
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      report: report("srv", { agents: ["claude"] }),
      answers: c => {
        forks(c, undefined, undefined, KEEPS_NO_IMAGE);
        readsLogs(c, () => ({ rows: [{ agent: "claude", session: "s-term", at: Date.now(), model: "claude-opus-5", folder: `${folder}/src`, tokens: tokens(40) }, { agent: "claude", session: "s-else", at: Date.now(), model: "claude-opus-5", folder: "/tmp/else", tokens: tokens(5) }], limits: [] }), asked);
      },
    });
    sockets.push(client.ws);
    const project = await projectOn(rt, "srv");
    folder = project.path;
    const byComputer = await rt.usage.used({ range: "day", split: "computer", outside: true });
    expect(byComputer.rows.map(r => [r.key, r.label, r.tokens.input])).toEqual([[placeId, "srv", 45]]);
    expect(byComputer.logs).toEqual({ agents: ["Claude Code"], computers: ["srv"] });
    expect((await rt.usage.used({ range: "day", split: "project", outside: true })).rows.map(r => [r.label, r.tokens.input])).toEqual([
      [project.name, 40],
      ["No project", 5],
    ]);
    // Work in a terminal there runs on that computer's own login of the agent.
    expect((await rt.usage.used({ range: "day", split: "account", outside: true })).rows.map(r => [r.key, r.label])).toEqual([[`claude@${placeId}`, "Claude Code signed in on srv"]]);
    // The daemon is named the stores the catalog keeps, one per agent whose store counts tokens, and reads them itself.
    expect(asked).toHaveLength(1);
    expect(asked[0]!["stores"]).toEqual(
      expect.arrayContaining([
        { agent: "claude", format: "claude-jsonl", root: "~/.claude/projects" },
        { agent: "codex", format: "codex-rollout", root: "~/.codex/sessions" },
        { agent: "opencode", format: "opencode-sqlite", root: "~/.local/share/opencode/opencode.db" },
      ]),
    );
  });

  it("counts a turn wsp ran there once, though its session is in that computer's logs too", async () => {
    const { rt, hostKey } = await host({ claude: oneSession("sess-box", 10) });
    const asked: Record<string, unknown>[] = [];
    const { client } = await join(hostKey, {
      code: await code(),
      report: report("srv", { agents: ["claude"], login: ROOT_LOGIN }),
      answers: c => {
        forks(c, undefined, asRoot, KEEPS_NO_IMAGE);
        readsLogs(c, () => ({ rows: [{ agent: "claude", session: "sess-box", at: Date.now(), model: "claude-opus-5", tokens: tokens(10) }, { agent: "claude", session: "s-term", at: Date.now(), model: "claude-opus-5", tokens: tokens(7) }], limits: [] }), asked);
      },
    });
    sockets.push(client.ws);
    const ws = await createOn(rt, { name: "x", on: "srv" });
    await (await rt.sessions.start(ws.id, { prompt: "go", harness: "claude" })).finished;
    const bySource = await rt.usage.used({ range: "day", split: "source" });
    expect(asked).toHaveLength(1);
    expect(bySource.rows.map(r => [r.key, r.label, r.tokens.input, r.turns])).toEqual([
      ["wsp", USAGE_WORDS.wspThreads, 10, 1],
      ["log", USAGE_WORDS.outsideWsp, 7, 0],
    ]);
  });

  it("puts a plan reading off that computer's logs on its account's row, and a computer away reads as not read rather than as nothing used", async () => {
    const { rt, hostKey } = await host();
    const at = Date.now() - 60_000;
    const asked: Record<string, unknown>[] = [];
    const signedIn = (name: string) => report(name, { agents: ["codex"], logins: ["codex/auth.json"] });
    const srv = await join(hostKey, {
      code: await code(),
      report: signedIn("srv"),
      answers: c => readsLogs(c, () => ({ rows: [], limits: [{ agent: "codex", at, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_790_690_000 }, secondary: { usedPercent: 12, windowDurationMins: 10_080 }, planType: "pro" }] }), asked),
    });
    sockets.push(srv.client.ws);
    const askedAway: Record<string, unknown>[] = [];
    const away = await join(hostKey, { code: await code(), report: signedIn("mini"), answers: c => readsLogs(c, () => ({ rows: [], limits: [] }), askedAway) });
    away.client.ws.close();
    await until(() => rt.places?.link(away.placeId) === undefined);
    await rt.usage.used({ range: "day", split: "source" });
    expect([asked.length, askedAway.length]).toEqual([1, 0]);
    const rows = (await rt.usage.accounts()).accounts;
    expect(rows.find(a => a.key === `codex@${srv.placeId}`)).toMatchObject({
      computers: ["srv"],
      plan: "pro",
      windows: [
        { kind: "session", usedPercent: 40, resetsAt: 1_790_690_000_000 },
        { kind: "week", usedPercent: 12 },
      ],
      readAt: at,
    });
    const asleep = rows.find(a => a.key === `codex@${away.placeId}`);
    expect(asleep).toMatchObject({ computers: ["mini"], note: USAGE_WORDS.unread });
    expect(asleep).not.toHaveProperty("windows");
  });
});
