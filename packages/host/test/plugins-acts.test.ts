// SPDX-License-Identifier: AGPL-3.0-only
// A plugin turned on or off on a computer: found by the module the report
// reads, so a plugin the report does not list, a missing one and a project's
// are refused with the reason, and the login's own goes through the agent's
// own command pointed at its store.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import { missingPluginRefusal, noSuchPluginRefusal, pluginMissingLine, projectPluginRefusal } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { agentHome, type AgentHome } from "../../collect/test/agent-home.js";
import { writeStub } from "../../protocol/test/stub-script.js";
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
  it("runs claude plugin disable at user scope for the login's own plugin, and answers its row off", async () => {
    const at = fixture();
    const lines: string[] = [];
    const turned = await pluginsActs({ here: () => here(at, lines) }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: false });
    expect(turned.plugin).toMatchObject({ agent: "claude", id: "frontend@official", scope: "user", on: false, path: "~/.claude/plugins/cache/official/frontend/abc123" });
    expect(lines.filter(l => l.includes("claude plugin"))).toEqual([expect.stringMatching(/^claude plugin disable 'frontend@official' --scope user --json <\/dev\/null/)]);
  });

  it("points the line at the folder the store names, where Claude Code reads its settings", async () => {
    const at = fixture();
    const lines: string[] = [];
    const store = join(at.home, ".claude");
    const host = { ...here(at, lines), stores: { claude: store } };
    await pluginsActs({ here: () => host }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: true });
    expect(lines.filter(l => l.includes("claude plugin"))).toEqual([expect.stringMatching(new RegExp(`^export CLAUDE_CONFIG_DIR='${store}'; claude plugin enable 'frontend@official' --scope user --json`))]);
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

  it("says why the agent's own command did not take, in its own words", async () => {
    const at = fixture();
    writeStub(join(at.bin, "claude"), `echo '{"command":"enable","outcome":"failed","message":"Plugin needs a newer Claude Code."}'; exit 1`);
    await expect(pluginsActs({ here: () => here(at) }).toggle({ kind: "here" }, { agent: "claude", plugin: "frontend@official", on: true })).rejects.toThrow("Plugin needs a newer Claude Code, so nothing was switched.");
  });

  it("refuses Codex's plugins the same way, off its app server's list", async () => {
    const at = fixture();
    await expect(pluginsActs({ here: () => here(at) }).toggle({ kind: "here" }, { agent: "codex", plugin: "brag@brag", on: false })).rejects.toThrow(noSuchPluginRefusal("brag@brag", "Codex"));
  });
});
