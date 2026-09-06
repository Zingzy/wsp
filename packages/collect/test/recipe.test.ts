// SPDX-License-Identifier: AGPL-3.0-only
// The three sources of a tick, in their order, and the shape the file takes.
import { CATALOG } from "@wsp/catalog";
import { Recipe } from "@wsp/protocol";
import { describe, expect, it } from "vitest";
import { computeRecipe, unknownCommands } from "../src/recipe.js";
import { readHistories } from "../src/history/index.js";
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
    expect(row("gh")).toEqual({ id: "gh", kind: "tool", on: true, source: { kind: "installed", paths: [], bin: true } });
    expect(row("agent-browser")).toEqual({ id: "agent-browser", kind: "tool", on: true, source: { kind: "used", sessions: 2, calls: 2 } });
    // One session's use is recorded but does not tick a row the catalog leaves off; two sessions do (agent-browser above).
    expect(row("go")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 1 } });
    expect(row("pnpm")).toEqual({ id: "pnpm", kind: "tool", on: true, source: { kind: "popular", sessions: 36, images: 3 } });
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

  it("a use below the threshold is the blended rule's answer and vetoes the catalog's own default", async () => {
    // The wizard's screens start from this rule; a tool the catalog ships on that was looked at once stays off.
    const host = fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "jq . package.json") } });
    const row = (r: Awaited<ReturnType<typeof computeRecipe>>, id: string) => r.rows.find(x => x.id === id)!;
    const blended = await computeRecipe(host);
    expect(row(blended, "jq")).toMatchObject({ on: false, source: { kind: "used", sessions: 1, calls: 1 } });
    // A tool the catalog ships on that nothing here touched still follows the catalog.
    expect(row(blended, "curl")).toMatchObject({ on: true, source: { kind: "popular" } });
    // Two sessions is the habit the threshold names, and then it is on.
    const twice = await computeRecipe(fakeHost({ files: { "~/.claude/projects/-Users-dev-proj/s1.jsonl": claudeLine("s1", "jq ."), "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "jq .") } }));
    expect(row(twice, "jq")).toMatchObject({ on: true, source: { kind: "used", sessions: 2 } });
    // An agent's own store is a use now, so the row says so; an agent is still only ever ticked from this computer.
    expect(row(blended, "claude")).toMatchObject({ on: false, kind: "agent", source: { kind: "used", sessions: 1 } });
  });

  it("one rule decides every tick when a rule is named, and the row's source says which one it went on", async () => {
    const used = await computeRecipe(laptop(), { tick: "used" });
    const row = (r: Awaited<ReturnType<typeof computeRecipe>>, id: string) => r.rows.find(x => x.id === id)!;
    // Installed here counts for nothing under used: the source is read used first, so an installed row that
    // reaches the table was never run.
    expect(row(used, "gh")).toMatchObject({ on: false, source: { kind: "installed" } });
    expect(row(used, "agent-browser")).toMatchObject({ on: true, source: { kind: "used", sessions: 2 } });
    expect(row(used, "go")).toMatchObject({ on: true, source: { kind: "used", sessions: 1 } });
    expect(row(used, "pnpm")).toMatchObject({ on: false, source: { kind: "popular" } });
    expect(used.tick).toBe("used");

    const installed = await computeRecipe(laptop(), { tick: "installed" });
    expect(row(installed, "gh")).toMatchObject({ on: true, source: { kind: "installed" } });
    expect(row(installed, "agent-browser")).toMatchObject({ on: false, source: { kind: "used" } });
    expect(row(installed, "pnpm")).toMatchObject({ on: false });

    const byDefault = await computeRecipe(laptop(), { tick: "default" });
    expect(row(byDefault, "pnpm")).toMatchObject({ on: true });
    expect(row(byDefault, "go")).toMatchObject({ on: false });
    expect(row(byDefault, "claude")).toMatchObject({ on: false, kind: "agent" });
  });

  it("holds an agent no adapter can open a thread on off under every rule but installed", async () => {
    const claudeOnly = { threadAgents: ["claude"] };
    const used = await computeRecipe(laptop(), { tick: "used", ...claudeOnly });
    expect(used.rows.find(r => r.id === "claude")).toMatchObject({ on: true, source: { kind: "used" } });
    const codexHere = () => fakeHost({ which: ["codex"], files: { "~/.codex/config.toml": "" } });
    expect((await computeRecipe(codexHere(), { tick: "used", ...claudeOnly })).rows.find(r => r.id === "codex")).toMatchObject({ on: false });
    expect((await computeRecipe(codexHere(), { tick: "installed", ...claudeOnly })).rows.find(r => r.id === "codex")).toMatchObject({ on: true });
  });

  it("weighs the histories by the folders it is given, and carries no rule when none was named", async () => {
    const one = await computeRecipe(laptop(), { tick: "used", folders: ["/Users/dev/nowhere"] });
    expect(one.rows.find(r => r.id === "agent-browser")).toMatchObject({ on: false, source: { kind: "popular" } });
    expect(one.histories.find(h => h.agent === "claude")).toMatchObject({ state: "empty", sessions: 0 });
    expect((await computeRecipe(laptop())).tick).toBeUndefined();
  });

  it("lists the commands the agents ran that no catalog row carries, most-run first, catalog rows and builtins out", async () => {
    const host = fakeHost({
      files: {
        "~/.claude/projects/-Users-dev-proj/s1.jsonl": [claudeLine("s1", "pytest -q && ruff check"), claudeLine("s1", "export X=1; pytest")].join("\n"),
        "~/.claude/projects/-Users-dev-proj/s2.jsonl": claudeLine("s2", "pytest; go build"),
      },
    });
    expect(unknownCommands(await readHistories(host))).toEqual([
      { name: "pytest", calls: 3, sessions: 2 },
      { name: "ruff", calls: 1, sessions: 1 },
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
