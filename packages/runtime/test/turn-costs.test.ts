// SPDX-License-Identifier: AGPL-3.0-only
// What a Claude turn files in the ledger, driven end to end: the runtime, the
// Claude adapter and a real process on this computer, with stand-ins for the CLI
// that print the lines Claude Code 2.1.280 printed in print mode (measured
// 2026-10-06 on a Linux machine): a turn its background subagent woke, which
// prints a result per wake, and turns cut at the wall before their last result.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { LocalBackend } from "@wsp/engine";
import { HERE_PLACE_ID, type TurnResult } from "@wsp/protocol";
import { writeStub } from "../../protocol/test/stub-script.js";
import { createRuntime, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore } from "../src/store.js";
import { copyingFake, createOn, stubBackend, testPlatform } from "./stub-backend.js";

const HEAD = `#!/bin/sh
for a; do [ "$prev" = --session-id ] && sid=$a; prev=$a; done
[ -n "$sid" ] || exit 0
read -r _
`;
const INIT = `{"type":"system","subtype":"init","cwd":"$PWD","session_id":"$sid","tools":["Bash","Task"],"model":"claude-opus-5-5"}`;
const call = (id: string, usage: Record<string, number>, parent = "null", model = "claude-opus-5-5") =>
  `{"type":"assistant","message":{"model":"${model}","id":"${id}","type":"message","role":"assistant","content":[{"type":"text","text":"working"}],"usage":${JSON.stringify(usage)}},"parent_tool_use_id":${parent},"session_id":"$sid"}`;
const use = (o: { in: number; read: number; write: number; out: number; cost: number }) =>
  ({ "claude-opus-5-5": { inputTokens: o.in, outputTokens: o.out, cacheReadInputTokens: o.read, cacheCreationInputTokens: o.write, webSearchRequests: 0, costUSD: o.cost, contextWindow: 1_000_000 } });
const result = (o: { text: string; total: number; usage: Record<string, number>; models: ReturnType<typeof use>; woke?: boolean }) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 900, num_turns: 1, result: o.text, session_id: "$sid", total_cost_usd: o.total, usage: o.usage, modelUsage: o.models, ...(o.woke === true ? { origin: { kind: "task-notification" } } : {}) });
const printed = (lines: string[]) => `cat <<EOF\n${lines.join("\n")}\nEOF\n`;

/** The agent hands a job to a subagent in the background and replies; the subagent's end wakes it, and it replies
 * again. Each result's usage counts the agent's own calls since it last stopped; modelUsage counts all of them. */
const woken = (): string =>
  HEAD +
  printed([
    INIT,
    call("msg_1", { input_tokens: 4, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 20_000, output_tokens: 3 }),
    `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a1","task_type":"local_agent","description":"echo there"}],"session_id":"$sid"}`,
    call("msg_2", { input_tokens: 4, cache_creation_input_tokens: 166, cache_read_input_tokens: 24_218, output_tokens: 2 }, `"toolu_1"`),
    result({ text: "Waiting on the subagent.", total: 0.08, usage: { input_tokens: 4, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 20_000, output_tokens: 1_500 }, models: use({ in: 8, read: 44_218, write: 10_166, out: 1_681, cost: 0.08 }) }),
  ]) +
  "sleep 0.3\n" +
  printed([
    `{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"$sid"}`,
    `{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"echo there completed","session_id":"$sid"}`,
    INIT,
    call("msg_3", { input_tokens: 10, cache_creation_input_tokens: 887, cache_read_input_tokens: 27_898, output_tokens: 5 }),
    result({ text: "done", total: 0.1, usage: { input_tokens: 10, cache_creation_input_tokens: 887, cache_read_input_tokens: 27_898, output_tokens: 144 }, models: use({ in: 18, read: 72_116, write: 11_053, out: 1_825, cost: 0.1 }), woke: true }),
  ]) +
  "cat >/dev/null\n";

/** Two calls, then work that outlasts the wall: the CLI never gets to print a result. */
const cut = (): string =>
  HEAD +
  printed([
    INIT,
    call("msg_1", { input_tokens: 6, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 0, output_tokens: 7 }),
    call("msg_1", { input_tokens: 6, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 0, output_tokens: 90 }),
    call("msg_2", { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 40_000, output_tokens: 12 }),
  ]) +
  "sleep 30\n";

const TASK_SET = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"a1","task_type":"local_agent","description":"echo there"}],"session_id":"$sid"}`;
const u1 = { input_tokens: 4, cache_creation_input_tokens: 10_000, cache_read_input_tokens: 20_000, output_tokens: 3 };

/** The woken stand-in whose woken agent prints one call and is then cut by the wall before it replies. */
const wokenCut = (): string =>
  HEAD +
  printed([
    INIT,
    call("msg_1", u1),
    TASK_SET,
    call("msg_2", { input_tokens: 4, cache_creation_input_tokens: 166, cache_read_input_tokens: 24_218, output_tokens: 2 }, `"toolu_1"`),
    result({ text: "Waiting on the subagent.", total: 0.08, usage: { ...u1, output_tokens: 1_500 }, models: use({ in: 8, read: 44_218, write: 10_166, out: 1_681, cost: 0.08 }) }),
  ]) +
  "sleep 0.3\n" +
  printed([
    `{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"$sid"}`,
    `{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"echo there completed","session_id":"$sid"}`,
    INIT,
    call("msg_3", { input_tokens: 10, cache_creation_input_tokens: 887, cache_read_input_tokens: 27_898, output_tokens: 5 }),
  ]) +
  "sleep 30\n";

/** The agent replies while its background subagent runs; the subagent prints a call after that reply, and the wall
 * cuts the turn before anything wakes the agent. */
const heldReply = result({ text: "Waiting on the subagent.", total: 0.084016, usage: { ...u1, output_tokens: 1_500 }, models: use({ in: 4, read: 20_000, write: 10_000, out: 1_500, cost: 0.084016 }) });
const afterReply = call("msg_2", { input_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 500_000, output_tokens: 2 }, `"toolu_1"`);
const heldCut = (): string => HEAD + printed([INIT, call("msg_1", u1), TASK_SET, heldReply]) + "sleep 0.3\n" + printed([afterReply]) + "sleep 30\n";

const TASK_NONE = `{"type":"system","subtype":"background_tasks_changed","tasks":[],"session_id":"$sid"}`;
const TASK_DONE = `{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"echo there completed","session_id":"$sid"}`;

/** Opus 5.5 and Sonnet 5 at list price, per token, the CLI's own figure in the stand-ins that need it exact. */
const RATES = { "claude-opus-5-5": { in: 4e-6, out: 2e-5, read: 2e-7, write: 5e-6 }, "claude-sonnet-5": { in: 3e-6, out: 1.5e-5, read: 3e-7, write: 3.75e-6 } };
type Use = { in: number; read: number; write: number; out: number };
const listOf = (model: keyof typeof RATES, t: Use): number => t.in * RATES[model].in + t.read * RATES[model].read + t.write * RATES[model].write + t.out * RATES[model].out;
/** The session's totals at the second result of keptTwice, which reports them at exactly their list price. */
const KEPT_TOTALS: Use = { in: 18, read: 550_000, write: 10_500, out: 1_522 };
const KEPT_LIST = listOf("claude-opus-5-5", KEPT_TOTALS);

/** Two turns on one process: the first a held reply whose background subagent then prints a call and ends with
 * nothing woken, the second one call and a result whose totals run on from the session's start. */
const keptTwice = (): string =>
  HEAD +
  printed([INIT, call("msg_1", u1), TASK_SET, heldReply]) +
  "sleep 0.3\n" +
  printed([afterReply, TASK_NONE, TASK_DONE]) +
  "read -r _\n" +
  printed([
    INIT,
    call("msg_3", { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 30_000, output_tokens: 20 }),
    result({ text: "two", total: KEPT_LIST, usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 30_000, output_tokens: 20 }, models: use({ ...KEPT_TOTALS, cost: KEPT_LIST }) }),
  ]) +
  "cat >/dev/null\n";

/** keptTwice with the background subagent on Sonnet, a model the session had not used: its call after the reply names
 * it bare, and the next result keys it with its context window, as Claude Code keys a 1M model. */
const SONNET_AFTER: Use = { in: 5, read: 0, write: 2_000, out: 40 };
const OPUS_AT_TWO: Use = { in: 14, read: 50_000, write: 10_500, out: 1_520 };
const NEW_MODEL_LIST = listOf("claude-opus-5-5", OPUS_AT_TWO) + listOf("claude-sonnet-5", SONNET_AFTER);
const row = (t: Use, cost: number) => ({ inputTokens: t.in, outputTokens: t.out, cacheReadInputTokens: t.read, cacheCreationInputTokens: t.write, webSearchRequests: 0, costUSD: cost, contextWindow: 1_000_000 });
const keptNewModel = (): string =>
  HEAD +
  printed([INIT, call("msg_1", u1), TASK_SET, heldReply]) +
  "sleep 0.3\n" +
  printed([call("msg_2", { input_tokens: 5, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 0, output_tokens: 3 }, `"toolu_1"`, "claude-sonnet-5"), TASK_NONE, TASK_DONE]) +
  "read -r _\n" +
  printed([
    INIT,
    call("msg_3", { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 30_000, output_tokens: 20 }),
    JSON.stringify({
      type: "result", subtype: "success", is_error: false, duration_ms: 900, num_turns: 1, result: "two", session_id: "$sid", total_cost_usd: NEW_MODEL_LIST,
      usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 30_000, output_tokens: 20 },
      modelUsage: { "claude-opus-5-5": row(OPUS_AT_TWO, listOf("claude-opus-5-5", OPUS_AT_TWO)), "claude-sonnet-5[1m]": row(SONNET_AFTER, listOf("claude-sonnet-5", SONNET_AFTER)) },
    }),
  ]) +
  "cat >/dev/null\n";

/** The first launch answers at its own list price and ends; the second is cut at the wall before any result. */
const doneThenCut = (counter: string): string =>
  HEAD +
  `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n+1)) > ${counter}\nif [ "$n" = 0 ]; then\n` +
  printed([INIT, call("msg_1", u1), result({ text: "done", total: 0.072016, usage: { ...u1, output_tokens: 900 }, models: use({ in: 4, read: 20_000, write: 10_000, out: 900, cost: 0.072016 }) })]) +
  "cat >/dev/null\nelse\n" +
  printed([
    INIT,
    call("msg_7", { input_tokens: 6, cache_creation_input_tokens: 40_000, cache_read_input_tokens: 0, output_tokens: 90 }),
    call("msg_8", { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 40_000, output_tokens: 12 }),
  ]) +
  "sleep 30\nfi\n";

const PRICES = Object.fromEntries(
  Object.entries(RATES).map(([model, r]) => [model, { input_cost_per_token: r.in, output_cost_per_token: r.out, cache_read_input_token_cost: r.read, cache_creation_input_token_cost: r.write }]),
);

describe("what a Claude turn files in the ledger", () => {
  let root: string;
  let rt: Runtime | undefined;

  const runtime = (script: string, deadlineMs?: number): Runtime => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeStub(join(bin, "claude"), script);
    const wiring: LocalWiring = {
      backend: new LocalBackend({ root }),
      execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o, ...(deadlineMs !== undefined ? { deadlineMs } : {}) }),
      home: () => join(root, ".claude"),
      homeDir: root,
      rootsPath: join(root, "roots"),
      env: () => ({ PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` }),
      platform: testPlatform(),
      copier: copyingFake(),
    };
    rt = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: { claude: ctx => createClaudeAdapter({ exec: ctx.execStream, configDir: ctx.home("claude"), baseEnv: ctx.env, resultExitMs: 250 }) },
      local: wiring,
      pricesFetch: async () => PRICES,
    });
    return rt;
  };

  const turn = async (rt: Runtime): Promise<{ result: TurnResult; filed: TurnResult | undefined }> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const result = await (await rt.sessions.start(ws.id, { prompt: "go" })).finished;
    const done = (await rt.sessions.history(ws.id)).find(e => e.type === "session.done");
    return { result, filed: done?.type === "session.done" ? done.result : undefined };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-costs-"));
  });
  afterEach(async () => {
    await rt?.close();
    rt = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it("a turn its background subagent woke counts every token since it started: the turn row's tokens are its split by model", async () => {
    const rt = runtime(woken());
    const { result, filed } = await turn(rt);
    expect(result).toMatchObject({ status: "completed", text: "done", costUsd: 0.1 });
    const split = filed!.models!;
    expect(split.map(m => m.model)).toEqual(["claude-opus-5-5"]);
    const sum = { input: 83_187, output: 1_825, cached: 72_116, cacheWrite: 11_053 };
    expect(split[0]!.tokens).toMatchObject(sum);
    expect(filed!.tokens).toMatchObject(sum);
    const rows = (await rt.usage.used({ range: "day", split: "model" })).rows;
    expect(rows.map(r => [r.tokens.input, r.tokens.output, r.costReported])).toEqual([[83_187, 1_825, 0.1]]);
  }, 10_000);

  it("a woken agent cut before its reply files the calls it printed under the turn's model, the turn counted once", async () => {
    const rt = runtime(wokenCut(), 1_500);
    const { result } = await turn(rt);
    expect(result.status).toBe("failed");
    const rows = (await rt.usage.used({ range: "day", split: "model" })).rows;
    expect(rows.map(r => [r.key, r.tokens.input, r.turns, r.costReported])).toEqual([["claude:claude-opus-5-5", 54_392 + 28_795, 1, 0.08]]);
  }, 10_000);

  it("a held reply the wall cuts before anything wakes the agent files the calls its background subagent printed after it", async () => {
    const rt = runtime(heldCut(), 1_500);
    await turn(rt);
    const rows = (await rt.usage.used({ range: "day", split: "model" })).rows;
    expect(rows.map(r => [r.key, r.tokens.input, r.turns, r.costReported])).toEqual([["claude:claude-opus-5-5", 30_004 + 500_004, 1, 0.084016]]);
    // The reply's cost is its own tokens' list price, and the calls after it, which came with none, take theirs.
    expect(rows[0]!.costList).toBeCloseTo(500_000 * 2e-7 + 4 * 4e-6 + 2 * 2e-5, 9);
    expect(rows[0]!.costReported! + rows[0]!.costList!).toBeCloseTo(rows[0]!.estimate!, 9);
  }, 10_000);

  it("a turn cut at the wall keeps its list price in a row beside a turn of the same hour that reported a cost", async () => {
    const rt = runtime(doneThenCut(join(root, "count")), 1_500);
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    expect((await (await rt.sessions.start(ws.id, { prompt: "go" })).finished).costUsd).toBe(0.072016);
    expect((await (await rt.sessions.start(ws.id, { prompt: "go again" })).finished).status).toBe("failed");
    const rows = (await rt.usage.used({ range: "day", split: "model" })).rows;
    expect(rows.map(r => [r.key, r.tokens.input, r.turns, r.costReported])).toEqual([["claude:claude-opus-5-5", 30_004 + 80_509, 2, 0.072016]]);
    expect(rows[0]!.costList).toBeCloseTo(9 * 4e-6 + 40_500 * 5e-6 + 40_000 * 2e-7 + 102 * 2e-5, 9);
    expect(rows[0]!.costReported! + rows[0]!.costList!).toBeCloseTo(rows[0]!.estimate!, 9);
  }, 15_000);

  /** Two sends on one thread; the second's reply only comes from the process the first left up. */
  const twoOnOneProcess = async (rt: Runtime): Promise<TurnResult> => {
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const one = await rt.sessions.start(ws.id, { prompt: "one" });
    await one.finished;
    const two = await (await rt.sessions.start(ws.id, { prompt: "two", thread: one.view().threadId! })).finished;
    expect(two.text).toBe("two");
    return two;
  };
  const ledgerTotal = async (rt: Runtime): Promise<{ input: number; cost: number; turns: number }> => {
    const rows = (await rt.usage.used({ range: "day", split: "model" })).rows;
    return { input: rows.reduce((n, r) => n + r.tokens.input, 0), cost: rows.reduce((n, r) => n + (r.costReported ?? 0) + (r.costList ?? 0), 0), turns: rows.reduce((n, r) => n + (r.turns ?? 0), 0) };
  };

  it("two turns on a kept process, the first a held reply with calls after it, file the session's tokens and dollars once", async () => {
    const rt = runtime(keptTwice());
    await twoOnOneProcess(rt);
    // The CLI reports every figure at its list price, so a ledger that counts each token and dollar once equals it.
    expect(await ledgerTotal(rt)).toEqual({ input: 560_518, cost: expect.closeTo(KEPT_LIST, 9), turns: 2 });
  }, 15_000);

  it("the second of those turns, its one model withheld, reports no cost of its own rather than $0", async () => {
    const rt = runtime(keptTwice());
    const two = await twoOnOneProcess(rt);
    expect(two.costUsd).toBeUndefined();
    expect(two.models?.map(m => [m.model, m.tokens.input, m.costUsd])).toEqual([["claude-opus-5-5", 30_510, undefined]]);
  }, 15_000);

  it("a model first seen after the held reply, keyed with its context window in the next result, is filed once", async () => {
    const rt = runtime(keptNewModel());
    await twoOnOneProcess(rt);
    const session = OPUS_AT_TWO.in + OPUS_AT_TWO.read + OPUS_AT_TWO.write + SONNET_AFTER.in + SONNET_AFTER.read + SONNET_AFTER.write;
    expect(await ledgerTotal(rt)).toEqual({ input: session, cost: expect.closeTo(NEW_MODEL_LIST, 9), turns: 2 });
  }, 15_000);

  it("a turn cut at the wall before any result files a usage row of the calls it printed", async () => {
    const rt = runtime(cut(), 1_500);
    const { result } = await turn(rt);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/turn limit/);
    expect(result.tokens).toMatchObject({ input: 80_509, output: 102, cached: 40_000, cacheWrite: 40_500 });
    const rows = (await rt.usage.used({ range: "day", split: "model" })).rows;
    expect(rows.map(r => [r.key, r.tokens.input, r.tokens.output, r.turns])).toEqual([["claude:claude-opus-5-5", 80_509, 102, 1]]);
  }, 10_000);
});

describe("a kept process", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-kept-costs-"));
  });
  afterEach(async () => {
    await localExecStream({ root, runDir: join(root, "runs") }).sweep!([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("files each token of the session once across two turns, the calls a held reply's subagent printed after it in the first", async () => {
    writeStub(join(root, "claude"), keptTwice());
    const adapter = createClaudeAdapter({ exec: localExecStream({ root, runDir: join(root, "runs"), pollMs: 20 }), configDir: join(root, ".claude"), launch: { program: join(root, "claude") }, resultExitMs: 250 });
    const first = adapter.start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const one = await first.finished;
    const kept = first.kept?.();
    expect(kept).toBeDefined();
    const two = await kept!.next({ prompt: "two", onEvent: () => {} }).finished;
    await kept!.close();
    const split = (r: TurnResult): number[] => (r.models ?? []).map(m => m.tokens.input);
    // The CLI's totals at the second result: 18 fresh, 550,000 cached and 10,500 written.
    expect([...split(one), ...split(two)].reduce((a, b) => a + b, 0)).toBe(18 + 550_000 + 10_500);
    expect(split(one)).toEqual([30_004, 500_004]);
  }, 20_000);
});
