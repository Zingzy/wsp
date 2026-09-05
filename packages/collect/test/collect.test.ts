// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { RUNGS, collect, parseManifest } from "../src/index.js";
import { fakeHost } from "./fake-host.js";

/** A developer's MacBook as the collector sees it. */
const LAPTOP = fakeHost({
  files: {
    "~/.gitconfig": 512,
    "~/.ssh/config": 1200,
    "~/.ssh/id_ed25519": 400,
    "~/.ssh/id_ed25519.pub": 100,
    "~/.ssh/known_hosts": 3000,
    "~/.zshrc": 3000,
    "~/.zshenv": 200,
    "~/.config/starship.toml": 900,
    "~/.tmux.conf": 600,
    "~/.zsh_history": 800_000,
    "~/.config/nvim/init.lua": 120_000,
    "~/Library/Application Support/Code/User/settings.json": 2000,
    "~/.config/mise/config.toml": 300,
    "~/.claude/settings.json": 400,
    "~/.claude/CLAUDE.md": 900,
    "~/.claude/.credentials.json": 800,
    "~/.codex/config.toml": 50,
    "~/.codex/auth.json": 900,
    "~/.config/gh/hosts.yml": 200,
    "~/.aws/config": 300,
    "~/go/bin/gopls": 1,
  },
  which: ["git", "brew", "code", "mise", "npm", "claude", "codex", "go"],
  exec: {
    "git config --global --get user.name": "Dev Person\n",
    "git config --global --get user.email": "dev@example.com\n",
    "git config --global --get gpg.format": "ssh\n",
    "code --list-extensions": "ms-python.python\n",
    "brew bundle dump --file=-": 'tap "homebrew/bundle"\nbrew "gh"\nbrew "jq"\ncask "rectangle"\n',
    "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { npm: { version: "10" }, pnpm: { version: "9.12.0" } } }),
    "go version": "go version go1.23.1 darwin/arm64\n",
    "go version -m /Users/dev/go/bin/gopls": "x\n\tpath\tgolang.org/x/tools/gopls\n\tmod\tgolang.org/x/tools/gopls\tv0.16.2\th1:abc=\n",
    'security find-generic-password -s Claude Code-credentials': "found\n",
  },
});

describe("collect", () => {
  it("composes every rung in ladder order into a valid manifest", async () => {
    const manifest = await collect(LAPTOP);
    expect(parseManifest(manifest)).toEqual(manifest);
    const order = manifest.entries.map(e => RUNGS.indexOf(e.rung));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(manifest.entries.map(e => e.rung))).toEqual(new Set(RUNGS.filter(r => r !== "everything")));
  });

  it("matches the fixture laptop snapshot", async () => {
    expect(await collect(LAPTOP)).toMatchSnapshot();
  });

  it("reports each rung's row count as it finishes, in ladder order, before the manifest resolves", async () => {
    const seen: [string, number][] = [];
    const manifest = await collect(LAPTOP, { onRung: (rung, count) => seen.push([rung, count]) });
    expect(seen.map(([r]) => r)).toEqual(RUNGS.filter(r => r !== "everything"));
    for (const [rung, count] of seen) expect(count).toBe(manifest.entries.filter(e => e.rung === rung).length);
    expect(seen.every(([, n]) => n > 0)).toBe(true);
  });

  it("an empty laptop reports zero for every rung the detectors cover", async () => {
    const seen: number[] = [];
    await collect(fakeHost(), { onRung: (_rung, count) => seen.push(count) });
    expect(seen).toEqual(RUNGS.filter(r => r !== "everything").map(() => 0));
  });

  it("an empty laptop is an empty manifest", async () => {
    expect(await collect(fakeHost())).toEqual({ entries: [] });
  });

  it("the agents rung sees the tools rows before it: an MCP command that is a hand-installed script names the tools row bringing its interpreter", async () => {
    const gemini = JSON.stringify({ mcpServers: { notes: { command: "~/.local/bin/notes-mcp" } } });
    const host = fakeHost({
      files: { "~/.gemini/settings.json": gemini },
      which: ["npm"],
      exec: { "npm prefix -g": "/opt/homebrew\n", "npm ls -g --depth=0 --json": JSON.stringify({ dependencies: { tsx: { version: "4.19.0" } } }) },
      bins: { "~/.local/bin/notes-mcp": { head: "#!/opt/homebrew/bin/tsx\nconsole.log(1)\n" } },
    });
    const manifest = await collect(host);
    expect(manifest.entries.find(e => e.id === "tools/hand/notes-mcp")).toMatchObject({ default: "skip", linux: "unknown" });
    expect(manifest.entries.find(e => e.id === "agents/mcp/gemini/notes")?.detail).toBe("stdio: ~/.local/bin/notes-mcp; needs notes-mcp on the machine; it travels as a copy when its row under Installed by hand is ticked, and runs with tsx, so the tsx row has to be ticked too; carries no secret");
  });

  it("a group's scope and what it leaves out ride on the manifest beside the rows", async () => {
    const claude = JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp" } }, projects: { "/Users/dev/code/mono": { mcpServers: { linear: { url: "https://mcp.linear.app/sse" } } } } });
    const manifest = await collect(fakeHost({ files: { "~/.claude.json": claude } }));
    expect(manifest.groups).toEqual([
      { rung: "agents", group: "Claude Code MCP servers", hint: "user scope and your home folder", note: "1 more in 1 project folder stay on this computer (a repo's .mcp.json travels with it)" },
    ]);
    expect(parseManifest(manifest)).toEqual(manifest);
  });
});
