// SPDX-License-Identifier: AGPL-3.0-only
// The picks a computer starts from: every plugin offered and only the ones
// switched on here ticked, and the one answer about the servers' keys moved
// on every ticked server that carries one.
import { describe, expect, it } from "vitest";
import type { RecipeOptions } from "@wsp/protocol";
import { copiesKeys, everything, keyedServers, setCopyKeys, tick } from "../src/settings/add/choices.js";
import { setupRows } from "../src/settings/add/setup.js";

const installed = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"].map(n => `${n}@acme`);
const OPTIONS: RecipeOptions = {
  agents: [{ id: "claude", name: "Claude Code", signins: ["vault"] }],
  mcp: [
    { name: "aws-mcp", agents: ["claude", "codex"] },
    { name: "gsc", agents: ["claude"], kind: "token", keys: ["GSC_CREDENTIALS_PATH"] },
    { name: "sentry", agents: ["codex"], kind: "token", keys: ["SENTRY_ACCESS_TOKEN"] },
  ],
  clis: [],
  skills: [],
  plugins: installed.map((name, i) => (i < 6 ? { name, on: true } : { name })),
  configs: [],
};

describe("the picks a computer starts from", () => {
  it("ticks only the plugins switched on here, and offers the rest unticked", () => {
    const picks = everything("studio", OPTIONS, [], {});
    expect(Object.keys(picks.plugins)).toEqual(installed.slice(0, 6));
    expect(OPTIONS.plugins).toHaveLength(13);
  });

  it("ticks every server with no yes to copying keys, and the one answer moves on every ticked server that carries one", () => {
    const picks = everything("studio", OPTIONS, [], {});
    expect(picks.mcp).toEqual({ "aws-mcp": { agents: ["claude", "codex"] }, gsc: { agents: ["claude"] }, sentry: { agents: ["codex"] } });
    expect(keyedServers(picks, OPTIONS)).toEqual([
      { name: "gsc", keys: ["GSC_CREDENTIALS_PATH"] },
      { name: "sentry", keys: ["SENTRY_ACCESS_TOKEN"] },
    ]);
    expect(copiesKeys(picks)).toBe(false);
    const yes = setCopyKeys(picks, true);
    // One answer, kept once: no server row carries an answer of its own.
    expect(yes.copyKeys).toBe(true);
    expect(yes.mcp).toEqual(picks.mcp);
    expect(copiesKeys(yes)).toBe(true);
    // Taken out and ticked again, a server stands under the one answer.
    expect(copiesKeys(tick(tick(yes, "mcp", "sentry", false, OPTIONS), "mcp", "sentry", true, OPTIONS))).toBe(true);
    expect(setCopyKeys(yes, false)).toEqual(picks);
  });

  it("lists a server the setup set aside for its keys under the servers step, by what its keys go by, offering the copy", () => {
    const rows = setupRows({
      setup: { state: "done", addId: "a", startedAt: "x", steps: [{ step: "mcp", state: "done" }], waiting: [] },
      applied: { hash: "h", at: "x", rows: [
        { id: "agents/mcp/codex/sentry", label: "Codex sentry", outcome: "skipped", kind: "server", step: "mcp", note: "not copied", keys: ["SENTRY_ACCESS_TOKEN"] },
        { id: "agents/mcp/claude/notion", label: "Claude Code notion", outcome: "skipped", kind: "server", step: "mcp", note: "unticked" },
      ] },
    }, "studio");
    expect(rows.filter(r => r.sub === true).map(r => [r.id, r.state, r.note, r.copyKeys])).toEqual([["agents/mcp/codex/sentry", "skipped", "Not copied: it needs SENTRY_ACCESS_TOKEN.", true]]);
  });
});
