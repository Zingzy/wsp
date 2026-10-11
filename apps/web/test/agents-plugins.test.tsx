// SPDX-License-Identifier: AGPL-3.0-only
// The Plugins tab in a task's panel, which Settings > Agents draws through the
// same kind: each agent's plugins grouped by agent and then by project, a row's
// switch where the host turns it, On or Off for a project's, Missing for one
// the agent loads nothing of; a plugin's page with where it comes from and what
// it brings, each kind with its count; and the switch going to the host.
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { pluginMissingLine, projectPluginRefusal, type PluginRow } from "@wsp/protocol";
import { pluginKey, type PluginActs } from "../src/components/agents/agentsRows.js";
import { AGENTS_REPORT } from "./fixtures/agents-report.js";
import { back, descriptionOf, drawPanel, factOf, factsOf, head, headsOf, openRow, panel, rowIds, rowOf, stateOf, tab, titleOf } from "./agents-panel-harness.js";

afterEach(cleanup);

const PLUGINS = AGENTS_REPORT.plugins!;
const keyOf = (agent: string, id: string): string => pluginKey(PLUGINS.find(p => p.agent === agent && p.id === id)!);
const VERCEL = keyOf("claude", "vercel@claude-plugins-official");
const MEM = keyOf("claude", "claude-mem@thedotmack");
const CREATOR = keyOf("claude", "skill-creator@claude-plugins-official");
const RUST = keyOf("claude", "rust-analyzer-lsp@claude-plugins-official");
const CODEX_BRAG = keyOf("codex", "brag@brag");
const CHROME = keyOf("codex", "chrome@openai-bundled");

/** A plugins road that keeps what it was asked, refusing one plugin. */
function fakePlugins(refused: Record<string, string> = {}): PluginActs & { turned: [string, boolean][] } {
  const turned: [string, boolean][] = [];
  return { turned, toggle: (row: PluginRow, on: boolean) => void turned.push([pluginKey(row), on]), busyOf: () => false, refusedOf: key => refused[key] };
}

const switchOf = (key: string): HTMLElement | null => rowOf(key).querySelector<HTMLElement>("[data-k=kind-on]");
const marksOf = (key: string): string[] => [...rowOf(key).querySelectorAll<HTMLElement>("[data-row-marks] [data-harness-mark]")].map(m => m.dataset["harnessMark"] ?? "");
const search = (q: string): void => void fireEvent.change(panel().querySelector<HTMLInputElement>("[data-k=kind-search]")!, { target: { value: q } });
const underRows = (): [string, string, string][] =>
  [...panel().querySelectorAll<HTMLElement>("[data-settings-card=kind-under] [data-settings-row]")].map(r => [r.querySelector("[data-settings-title]")?.textContent ?? "", r.querySelector("[data-settings-description]")?.textContent ?? "", r.querySelector("[data-settings-word]")?.textContent ?? ""]);

describe("the Plugins list", () => {
  it("groups Claude Code's plugins, then Codex's, then each project's, a row each with its glyph, name, agent's mark and marketplace", () => {
    drawPanel({ ctx: { where: "box", plugins: fakePlugins() } });
    tab("Plugins");
    expect(headsOf().slice(0, 3)).toEqual(["Claude Code on spoochecked 3 min ago", "Codex", "wsp~/wsp"]);
    expect(rowIds()).toEqual([keyOf("claude", "brag@brag"), MEM, CREATOR, VERCEL, CODEX_BRAG, CHROME, RUST]);
    expect(titleOf(VERCEL)).toBe("vercel");
    expect(descriptionOf(VERCEL)).toBe("claude-plugins-official");
    expect(marksOf(VERCEL)).toEqual(["claude"]);
    expect(marksOf(CODEX_BRAG)).toEqual(["codex"]);
    expect(rowOf(VERCEL).querySelector("[data-settings-glyph] svg.lucide-puzzle, svg.lucide-puzzle")).not.toBeNull();
  });

  it("stands a switch on the login's own plugins, On or Off on a project's, and Missing with no switch on one the agent cannot load", () => {
    drawPanel({ ctx: { where: "box", plugins: fakePlugins() } });
    tab("Plugins");
    expect(switchOf(VERCEL)?.getAttribute("aria-checked")).toBe("true");
    expect(switchOf(MEM)?.getAttribute("aria-checked")).toBe("false");
    expect(stateOf(VERCEL)).toBeNull();
    expect(stateOf(CREATOR)).toEqual(["Missing", "waiting"]);
    expect(switchOf(CREATOR)).toBeNull();
    expect(stateOf(CHROME)).toEqual(["Missing", "waiting"]);
    expect(switchOf(CHROME)).toBeNull();
    expect(stateOf(RUST)).toEqual(["On", "good"]);
    expect(switchOf(RUST)).toBeNull();
  });

  it("finds a plugin by its name, its marketplace, or anything it brings", () => {
    drawPanel({ ctx: { where: "box", plugins: fakePlugins() } });
    tab("Plugins");
    search("nextjs");
    expect(rowIds()).toEqual([VERCEL]);
    search("thedotmack");
    expect(rowIds()).toEqual([MEM]);
    search("rust-analyzer");
    expect(rowIds()).toEqual([RUST]);
    search("brag-slim");
    expect(rowIds()).toEqual([keyOf("claude", "brag@brag"), CODEX_BRAG]);
    search("nothing like it");
    expect(panel().querySelector("[data-settings-line=kind-none]")?.textContent).toBe('Nothing matches "nothing like it".');
  });

  it("sends a switch to the host from the row, and says under the row why the host refused it", () => {
    const plugins = fakePlugins({ [MEM]: "There is no plugin claude-mem@thedotmack for Claude Code there, so nothing was switched." });
    drawPanel({ ctx: { where: "box", plugins } });
    tab("Plugins");
    fireEvent.click(switchOf(VERCEL)!);
    fireEvent.click(switchOf(MEM)!);
    expect(plugins.turned).toEqual([
      [VERCEL, false],
      [MEM, true],
    ]);
    expect(rowOf(MEM).closest("[data-kind-item]")?.querySelector("[data-k=kind-row-refused]")?.textContent).toBe("There is no plugin claude-mem@thedotmack for Claude Code there, so nothing was switched.");
  });

  it("says no plugins on the computer where it has none", () => {
    drawPanel({ report: { ...AGENTS_REPORT, plugins: [] } });
    tab("Plugins");
    expect(panel().querySelector("[data-settings-line=kind-none]")?.textContent).toBe("No plugins on spoo yet.");
    // A report an older host kept carries no plugins, which reads as none.
    const { plugins: _gone, ...older } = AGENTS_REPORT;
    cleanup();
    drawPanel({ report: older });
    tab("Plugins");
    expect(panel().querySelector("[data-settings-line=kind-none]")?.textContent).toBe("No plugins on spoo yet.");
  });
});

describe("a plugin's page", () => {
  it("says what it is, where it comes from with the repo as a link, its version, scope and folder, and what it brings with a count per kind", () => {
    drawPanel({ ctx: { where: "box", plugins: fakePlugins() } });
    tab("Plugins");
    openRow(VERCEL);
    expect(panel().querySelector("[data-k=kind-about]")?.textContent).toBe("Build and deploy web apps and agents");
    expect(head().querySelector("[data-k=kind-status]")?.textContent).toBe("On");
    expect(factsOf()).toEqual([
      ["Marketplace", "claude-plugins-official"],
      ["Version", "0.50.0"],
      ["Scope", "User"],
      ["Path", "~/.claude/plugins/cache/claude-plugins-official/vercel/0.50.0"],
    ]);
    expect(factOf("marketplace")?.querySelector("button[data-fact-value]")?.getAttribute("title")).toBe("https://github.com/anthropics/claude-plugins-official");
    expect(underRows()).toEqual([
      ["Skills", "vercel:ai-sdk, vercel:deployments-cicd, vercel:nextjs, vercel:vercel-cli", "4"],
      ["Commands", "vercel:bootstrap, vercel:deploy, vercel:env, vercel:status", "4"],
      ["Subagents", "vercel:ai-architect, vercel:deployment-expert, vercel:performance-optimizer", "3"],
      ["Hooks", "PostToolUse, SessionEnd, SessionStart", "3"],
      ["Tool servers", "plugin:vercel:vercel", "1"],
    ]);
    expect(panel().querySelector("[data-settings-card=kind-under] [data-settings-head]")?.textContent).toContain("What it brings");
    expect(head().querySelector("[data-k=kind-on]")?.getAttribute("aria-checked")).toBe("true");
  });

  it("says why a missing plugin loads nowhere, Claude Code's for its folder and Codex's for its marketplace, with no switch", () => {
    drawPanel({ ctx: { where: "box", plugins: fakePlugins() } });
    tab("Plugins");
    openRow(CREATOR);
    const creator = PLUGINS.find(p => p.id === "skill-creator@claude-plugins-official")!;
    expect(panel().querySelector("[data-k=kind-about]")?.textContent).toBe(pluginMissingLine(creator, "Claude Code", "spoo"));
    expect(panel().querySelector("[data-k=kind-about]")?.textContent).toBe("Claude Code has skill-creator@claude-plugins-official on, but its folder is not on spoo, so no turn loads it.");
    expect(head().querySelector("[data-k=kind-on]")).toBeNull();
    expect(panel().querySelector("[data-settings-card=kind-under]")).toBeNull();
    back();
    openRow(CHROME);
    expect(panel().querySelector("[data-k=kind-about]")?.textContent).toBe("The config.toml on spoo names chrome@openai-bundled, but Codex lists no such plugin there. Its marketplace, openai-bundled, is a folder that is not on spoo.");
    expect(head().querySelector("[data-k=kind-on]")).toBeNull();
  });

  it("names the file a project's plugin is set in, and switches none of it here", () => {
    drawPanel({ ctx: { where: "box", plugins: fakePlugins() } });
    tab("Plugins");
    openRow(RUST);
    expect(head().querySelector("[data-k=kind-status]")?.textContent).toBe("On");
    expect(factsOf()).toEqual([
      ["Marketplace", "claude-plugins-official"],
      ["Version", "1.0.0"],
      ["Scope", "Local"],
      ["Path", "~/.claude/plugins/cache/claude-plugins-official/rust-analyzer-lsp/1.0.0"],
      ["Set in", "~/wsp/.claude/settings.local.json"],
    ]);
    expect(head().querySelector("[data-k=kind-on]")).toBeNull();
    expect(projectPluginRefusal("rust-analyzer-lsp@claude-plugins-official", "~/wsp/.claude/settings.local.json")).toBe("rust-analyzer-lsp@claude-plugins-official is set in the repo at ~/wsp/.claude/settings.local.json, so it is not switched here.");
    expect(underRows()).toEqual([["Language servers", "rust-analyzer", "1"]]);
  });

  it("turns the plugin off from its page through the host", () => {
    const plugins = fakePlugins();
    drawPanel({ ctx: { where: "box", plugins } });
    tab("Plugins");
    openRow(CODEX_BRAG);
    fireEvent.click(head().querySelector("[data-k=kind-on]")!);
    expect(plugins.turned).toEqual([[CODEX_BRAG, false]]);
  });
});
