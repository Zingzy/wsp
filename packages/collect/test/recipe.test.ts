// SPDX-License-Identifier: AGPL-3.0-only
// The three sources of a tick, in their order, and the shape the file takes.
import { CATALOG } from "@wsp/catalog";
import { Recipe } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { computeRecipe } from "../src/recipe.js";
import { fakeHost } from "./fake-host.js";

const claudeLine = (sessionId: string, command: string): string =>
  JSON.stringify({ type: "assistant", sessionId, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command } }] } });

const laptop = () =>
  fakeHost({
    which: ["claude", "gh", "node", "git"],
    files: {
      "~/.claude/settings.json": "{}",
      "~/.claude/skills/": 2048,
      "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", "agent-browser open https://x && export API=sk-ant-x-secret-value"), claudeLine("s1", "go version")].join("\n"),
      "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "agent-browser snapshot"),
    },
  });

describe("computeRecipe", () => {
  it("ticks what is installed here first, then what the agents used, and falls back to the catalog's own default", async () => {
    const recipe = await computeRecipe(laptop(), { now: () => new Date("2026-09-06T03:00:00Z") });
    const row = (id: string) => recipe.rows.find(r => r.id === id)!;
    expect(row("claude")).toEqual({ id: "claude", kind: "agent", on: true, source: { kind: "installed", paths: ["~/.claude/settings.json", "~/.claude/skills"], bin: true }, size: 208 * 1024 * 1024 });
    expect(row("gh")).toEqual({ id: "gh", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true }, size: 42188962 });
    expect(row("agent-browser")).toEqual({ id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 2, calls: 2 }, size: 81702912 });
    // One session's use is recorded but does not tick a row the catalog leaves off; two sessions do (agent-browser above).
    expect(row("go")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 1 } });
    expect(row("pnpm")).toEqual({ id: "pnpm", kind: "tool", on: true, source: { kind: "popular", sessions: 36, images: 3 }, size: 20357120 });
    expect(row("rust")).toMatchObject({ on: false, source: { kind: "popular", sessions: 4, images: 3 } });
    // An agent is never on by default: the ones not found here stay off, with the catalog's evidence as their source.
    expect(row("codex")).toEqual({ id: "codex", kind: "agent", on: false, source: { kind: "popular", sessions: 5, images: 1 }, size: 455 * 1024 * 1024 });
    expect(recipe.rows.map(r => r.id)).toEqual(CATALOG.map(e => e.id));
    expect(recipe.at).toBe("2026-09-06T03:00:00.000Z");
    expect(recipe.histories).toEqual([
      { agent: "claude", state: "read", sessions: 2, calls: 3 },
      { agent: "codex", state: "empty", sessions: 0, calls: 0 },
      { agent: "gemini", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "opencode", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "pi", state: "no-reader", sessions: 0, calls: 0 },
      { agent: "hermes", state: "empty", sessions: 0, calls: 0 },
    ]);
  });

  it("writes the protocol's shape and never a value it read", async () => {
    const recipe = await computeRecipe(laptop());
    const text = JSON.stringify(recipe);
    expect(Recipe.parse(JSON.parse(text))).toEqual(recipe);
    expect(text).not.toContain("sk-ant-x");
    expect(text).not.toContain("https://x");
  });

  it("tells the caller what was found and read as it goes", async () => {
    const present: string[] = [];
    const read: string[] = [];
    await computeRecipe(laptop(), { onPresent: e => present.push(e.id), onHistory: h => read.push(`${h.agent} ${h.state}`) });
    expect(present).toEqual(["claude", "node", "git", "gh"]);
    expect(read[0]).toBe("claude read");
    expect(read).toHaveLength(6);
  });
});
