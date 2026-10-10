// SPDX-License-Identifier: AGPL-3.0-only
// The picks a computer starts from: every plugin offered and only the ones
// switched on here ticked, and the one answer about the servers' keys moved
// on every ticked server that carries one.
import { describe, expect, it } from "vitest";
import type { RecipeOptions } from "@wsp/protocol";
import { copiesKeys, everything, keyedServers, setCopyKeys, tick } from "../src/settings/add/choices.js";

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
    expect(copiesKeys(picks, OPTIONS)).toBe(false);
    const yes = setCopyKeys(picks, OPTIONS, true);
    expect(yes.mcp).toEqual({ "aws-mcp": { agents: ["claude", "codex"] }, gsc: { agents: ["claude"], copy: true }, sentry: { agents: ["codex"], copy: true } });
    expect(copiesKeys(yes, OPTIONS)).toBe(true);
    // Taken out and ticked again, a server takes the answer the others stand on.
    expect(tick(tick(yes, "mcp", "sentry", false, OPTIONS), "mcp", "sentry", true, OPTIONS).mcp["sentry"]).toEqual({ agents: ["codex"], copy: true });
    expect(tick(tick(picks, "mcp", "sentry", false, OPTIONS), "mcp", "sentry", true, OPTIONS).mcp["sentry"]).toEqual({ agents: ["codex"] });
    expect(setCopyKeys(yes, OPTIONS, false).mcp).toEqual(picks.mcp);
  });
});
