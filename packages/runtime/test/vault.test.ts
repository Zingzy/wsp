// SPDX-License-Identifier: AGPL-3.0-only
// The vault at a turn's launch: the variables the wsp home's .env holds reach
// every adapter through the runtime, read at each launch and never copied, so
// a token minted after the host started is in the next turn. Nothing of it is
// on a machine.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { HarnessAdapterContext, HarnessAdapterFactory } from "../src/runtime.js";
import { createRuntime } from "../src/runtime.js";
import { secretsOf } from "../src/adapters.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import type { TurnResult } from "@wsp/protocol";

const TOKEN = "sk-ant-oat01-TESTONLY";
const OPENAI = "sk-x-fake-openai";

/** An adapter that reports every context it was built with and ends its turn at once. */
function recording(): { factory: HarnessAdapterFactory; contexts: HarnessAdapterContext[] } {
  const contexts: HarnessAdapterContext[] = [];
  const factory: HarnessAdapterFactory = ctx => {
    contexts.push(ctx);
    return {
      steers: false,
      start: ({ onEvent }) => {
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "ok" };
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    };
  };
  return { factory, contexts };
}

describe("the vault a turn launches with", () => {
  it("reaches a turn on a cloud fork, read at the launch, so a token minted after the host started is in the next turn", async () => {
    const { factory, contexts } = recording();
    let held: Record<string, string> = {};
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, vault: () => held });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    expect(contexts.at(-1)!.vault).toEqual({});
    held = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };
    await (await rt.sessions.start(ws.id, { prompt: "two" })).finished;
    expect(contexts.at(-1)!.vault).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  });

  it("is empty for a host that wired none, so a turn carries nothing of one", async () => {
    const { factory, contexts } = recording();
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory } });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "x" });
    await (await rt.sessions.start(ws.id, { prompt: "one" })).finished;
    for (const ctx of contexts) expect(ctx.vault).toEqual({});
  });

  it("hands each agent the variables its own catalog row declares, from one record", () => {
    const record = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: "sk-ant-x", OPENAI_API_KEY: OPENAI, SOLARI_API_KEY: "slr_live_x" };
    expect(secretsOf(record, "claude")).toEqual({ oauthToken: TOKEN, apiKey: "sk-ant-x" });
    expect(secretsOf(record, "codex")).toEqual({ apiKey: OPENAI });
    expect(secretsOf({}, "claude")).toEqual({});
    expect(secretsOf({}, "codex")).toEqual({});
  });
});
