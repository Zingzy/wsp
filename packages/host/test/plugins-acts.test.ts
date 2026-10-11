// SPDX-License-Identifier: AGPL-3.0-only
// A plugin turned on or off on a computer: found by the module the report
// reads, so a plugin the report does not list, a missing one and a project's
// are refused with the reason, and the login's own is written where the agent
// reads it, under its store.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import { missingPluginRefusal, noSuchPluginRefusal, pluginMissingLine, projectPluginRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, type AgentHome } from "../../collect/test/agent-home.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { agentsReader } from "../src/agents-reader.js";
import { pluginsActs } from "../src/plugins-acts.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function fixture(): AgentHome {
  const root = mkdtempSync(join(tmpdir(), "wsp-plugins-acts-"));
  roots.push(root);
  return agentHome(root);
}

/** This computer's Host over the fixture's home, every line it runs kept. */
function here(at: AgentHome, lines: string[] = []): Host {
  const live = nodeHost();
  return { ...live, home: at.home, exec: { ...live.exec, run: (cmd, args, o) => (lines.push(args.at(-1) ?? ""), live.exec.run(cmd, args, { ...o, env: { PATH: `${at.bin}:/usr/bin:/bin`, HOME: at.home, ...o?.env } })) } };
}

describe("turning a plugin on or off", () => {
  it("writes enabledPlugins for the login's own plugin in the user settings, runs no claude command, and answers its row off", async () => {
    const at = fixture();
    const lines: string[] = [];
    const settings = join(at.home, ".claude/settings.json");
    writeFileSync(settings, JSON.stringify({ model: "opus", enabledPlugins: { "other@official": true } }, null, 2));
    const turned = await pluginsActs({ here: () => here(at, lines) }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: false });
    expect(turned.plugin).toMatchObject({ agent: "claude", id: "frontend@official", scope: "user", on: false, path: "~/.claude/plugins/cache/official/frontend/abc123" });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ model: "opus", enabledPlugins: { "other@official": true, "frontend@official": false } });
    // claude plugin enable and disable first download every user plugin whose folder is missing (2.1.296).
    expect(lines.filter(l => l.includes("claude "))).toEqual([]);
    await pluginsActs({ here: () => here(at, lines) }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: true });
    expect(JSON.parse(readFileSync(settings, "utf8")).enabledPlugins["frontend@official"]).toBe(true);
  });

  it("writes the settings file under the folder the store names, where Claude Code reads it", async () => {
    const at = fixture();
    const store = join(at.home, "store-claude");
    renameSync(join(at.home, ".claude"), store);
    const index = join(store, "plugins/installed_plugins.json");
    writeFileSync(index, readFileSync(index, "utf8").replaceAll(`${at.home}/.claude/`, `${store}/`));
    const host = { ...here(at), stores: { claude: store } };
    await pluginsActs({ here: () => host }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: false });
    expect(JSON.parse(readFileSync(join(store, "settings.json"), "utf8"))).toEqual({ enabledPlugins: { "frontend@official": false } });
    expect(existsSync(join(at.home, ".claude"))).toBe(false);
  });

  it("writes through a settings file linked into the home, as claude plugin disable does, and refuses one linked out of it", async () => {
    const at = fixture();
    const settings = join(at.home, ".claude/settings.json");
    const dotfiles = join(at.home, "dotfiles/claude-settings.json");
    mkdirSync(dirname(dotfiles), { recursive: true });
    writeFileSync(dotfiles, JSON.stringify({ model: "opus" }));
    symlinkSync(dotfiles, settings);
    await pluginsActs({ here: () => here(at) }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: false });
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(dotfiles, "utf8"))).toEqual({ model: "opus", enabledPlugins: { "frontend@official": false } });
    const outside = join(at.home, "../outside.json");
    writeFileSync(outside, "{}");
    rmSync(settings);
    symlinkSync(outside, settings);
    await expect(pluginsActs({ here: () => here(at) }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: true })).rejects.toThrow(/outside the folder it belongs to/);
    expect(readFileSync(outside, "utf8")).toBe("{}");
  });

  it("on this computer reads and writes the store a local launch reads", async () => {
    const at = fixture();
    const store = join(at.home, "launch-claude");
    renameSync(join(at.home, ".claude"), store);
    const index = join(store, "plugins/installed_plugins.json");
    writeFileSync(index, readFileSync(index, "utf8").replaceAll(`${at.home}/.claude/`, `${store}/`));
    const on = { kind: "here" as const, stores: { claude: store } };
    const read = await agentsReader({ vault: () => ({}), here: () => here(at) }).read(on);
    expect(read.plugins?.find(p => p.id === "frontend@official")).toMatchObject({ agent: "claude", on: true, path: "~/launch-claude/plugins/cache/official/frontend/abc123" });
    await pluginsActs({ here: () => here(at) }).toggle(on, { agent: "claude", plugin: "frontend@official", on: false });
    expect(JSON.parse(readFileSync(join(store, "settings.json"), "utf8"))).toEqual({ enabledPlugins: { "frontend@official": false } });
    expect(existsSync(join(at.home, ".claude"))).toBe(false);
  });

  it("refuses with the read's own reason where the agent's plugins could not be read, never that the plugin is not there", async () => {
    const at = fixture();
    const live = here(at);
    const deaf: Host = { ...live, exec: { ...live.exec, run: async () => undefined } };
    await expect(pluginsActs({ here: () => deaf }).toggle({ kind: "here" }, { agent: "codex", plugin: "brag@brag", on: false })).rejects.toThrow(/^Codex's app server did not answer, so Codex's plugins were not read\. /);
    await expect(pluginsActs({ here: () => deaf }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: false })).rejects.toThrow(/^Claude Code's plugin files could not be read\. /);
  });

  it("refuses an id the report does not list, which claude plugin enable would write all the same", async () => {
    const at = fixture();
    const lines: string[] = [];
    await expect(pluginsActs({ here: () => here(at, lines) }).toggle({ kind: "here" }, { agent: "claude", plugin: "nope@official", on: true })).rejects.toThrow(noSuchPluginRefusal("nope@official", "Claude Code"));
    expect(lines.some(l => l.includes("claude plugin"))).toBe(false);
  });

  it("refuses a missing plugin with why no turn loads it", async () => {
    const at = fixture();
    const index = join(at.home, ".claude/plugins/installed_plugins.json");
    const read = JSON.parse(readFileSync(index, "utf8")) as { plugins: Record<string, unknown[]> };
    read.plugins["gone@official"] = [{ scope: "user", installPath: join(at.home, ".claude/plugins/cache/official/gone/1") }];
    writeFileSync(index, JSON.stringify(read));
    const line = pluginMissingLine({ id: "gone@official", marketplace: "official", missing: "folder", on: true }, "Claude Code", "this computer");
    await expect(pluginsActs({ here: () => here(at) }).toggle({ kind: "here" }, { agent: "claude", plugin: "gone@official", on: false })).rejects.toThrow(missingPluginRefusal(line));
  });

  it("refuses a project's plugin, which is set in its repo, naming the file", async () => {
    const at = fixture();
    const on = { kind: "here" as const, projects: [{ id: "pr_app", name: "app", path: at.project }] };
    await expect(pluginsActs({ here: () => here(at) }).toggle(on, { agent: "claude", plugin: "other@official", on: false })).rejects.toThrow(projectPluginRefusal("other@official", "~/code/app/.claude/settings.json"));
  });

  it("refuses Codex's plugins the same way, off its app server's list", async () => {
    const at = fixture();
    await expect(pluginsActs({ here: () => here(at) }).toggle({ kind: "here" }, { agent: "codex", plugin: "brag@brag", on: false })).rejects.toThrow(noSuchPluginRefusal("brag@brag", "Codex"));
  });
});
