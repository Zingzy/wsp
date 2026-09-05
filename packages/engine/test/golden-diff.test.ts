// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import type { RecipeDigest } from "@wsp/protocol";
import { SMALL_BYTES, SMALL_TOOLS, describeDiff, diffRecipes, isEmptyDiff, isSmallDelta, removalsFor, rowsToApply, type RecipeDiff } from "../src/golden-diff.js";
import type { RecipeEntry } from "../src/golden-import.js";

const row = (rung: string, id: string, over: Partial<RecipeEntry> = {}): RecipeEntry => ({ rung, id, label: id.slice(id.lastIndexOf("/") + 1), paths: [], bytes: 0, default: "bring", bring: true, ...over });
type DigestFile = RecipeDigest["files"][number];
/** A digested file; the two numbers stand in for the bytes that would be hashed. */
const file = (id: string, dest: string, size = 10, mtimeMs = 1000, path = `~/${dest}`): DigestFile => ({ id, dest, path, digest: `${size}:${mtimeMs}` });
/** The digest the seal writes: the ticked rows as ticks, the planned files as given; `rows` keeps the fixture rows for sizes. */
const snap = (entries: RecipeEntry[], files: DigestFile[] = []): RecipeDigest & { rows: RecipeEntry[] } => ({
  ticks: entries.filter(e => e.bring === true).map(e => ({ id: e.id, ...(e.choice !== undefined ? { choice: e.choice } : {}), ...(e.version !== undefined ? { version: e.version } : {}) })),
  files,
  rows: entries,
});
const bytesIn = (to: { rows: RecipeEntry[] }) => (id: string): number => to.rows.find(e => e.id === id)?.bytes ?? 0;
const EMPTY: RecipeDiff = { files: [], tools: [], agents: [], logins: [] };

describe("recipe diff", () => {
  const cases: { name: string; from: RecipeDigest; to: RecipeDigest; diff: RecipeDiff; apply: string[] }[] = [
    {
      name: "a file added",
      from: snap([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc")]),
      to: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc"), file("shell/starship", ".config/starship.toml")]),
      diff: { ...EMPTY, files: [{ id: "shell/starship", dest: ".config/starship.toml", change: "added" }] },
      apply: ["shell/starship"],
    },
    {
      name: "a file whose bytes changed",
      from: snap([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc", 10)]),
      to: snap([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc", 11)]),
      diff: { ...EMPTY, files: [{ id: "shell/zshrc", dest: ".zshrc", change: "changed" }] },
      apply: ["shell/zshrc"],
    },
    {
      name: "a volatile file whose bytes moved is no change: its tool rewrites it, or the machine renders it",
      from: snap([row("logins", "logins/gh", { choice: "copy" })], [{ ...file("logins/gh", ".config/gh/hosts.yml", 10, 1000), volatile: true }]),
      to: snap([row("logins", "logins/gh", { choice: "copy" })], [{ ...file("logins/gh", ".config/gh/hosts.yml", 10, 2000), volatile: true }]),
      diff: EMPTY,
      apply: [],
    },
    {
      name: "a file removed (its row unticked)",
      from: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc"), file("shell/starship", ".config/starship.toml")]),
      to: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship", { bring: false })], [file("shell/zshrc", ".zshrc")]),
      diff: { ...EMPTY, files: [{ id: "shell/starship", dest: ".config/starship.toml", change: "removed" }] },
      apply: [],
    },
    {
      name: "a file whose dest moved is a removal and an addition",
      from: snap([row("agents", "agents/claude")], [file("agents/claude", ".claude", 10, 1000, "~/.claude")]),
      to: snap([row("agents", "agents/claude")], [file("agents/claude", ".claude-cfg", 10, 1000, "~/.claude")]),
      diff: { ...EMPTY, files: [{ id: "agents/claude", dest: ".claude-cfg", change: "added" }, { id: "agents/claude", dest: ".claude", change: "removed" }] },
      apply: ["agents/claude"],
    },
    {
      name: "a tool added",
      from: snap([]),
      to: snap([row("tools", "tools/brew/jq")]),
      diff: { ...EMPTY, tools: [{ id: "tools/brew/jq", label: "jq", change: "added" }] },
      apply: ["tools/brew/jq"],
    },
    {
      name: "a tool's pin changed",
      from: snap([row("tools", "tools/npm/bun", { version: "1.4.0" })]),
      to: snap([row("tools", "tools/npm/bun", { version: "1.5.0" })]),
      diff: { ...EMPTY, tools: [{ id: "tools/npm/bun", label: "bun", change: "changed", from: "1.4.0", to: "1.5.0" }] },
      apply: ["tools/npm/bun"],
    },
    {
      name: "a tool removed",
      from: snap([row("tools", "tools/brew/jq"), row("tools", "tools/npm/bun", { version: "1.4.0" })]),
      to: snap([row("tools", "tools/brew/jq")]),
      diff: { ...EMPTY, tools: [{ id: "tools/npm/bun", label: "bun", change: "removed", from: "1.4.0" }] },
      apply: [],
    },
    {
      name: "a terminal editor ticked later, with or without a config, is an install named as the machine will name it",
      from: snap([row("editors", "editors/nvim")], [file("editors/nvim", ".config/nvim")]),
      to: snap([row("editors", "editors/nvim"), row("editors", "editors/vim"), row("editors", "editors/helix")], [file("editors/nvim", ".config/nvim"), file("editors/helix", ".config/helix")]),
      diff: { ...EMPTY, files: [{ id: "editors/helix", dest: ".config/helix", change: "added" }], tools: [{ id: "editors/vim", label: "vim", change: "added" }, { id: "editors/helix", label: "helix", change: "added" }] },
      apply: ["editors/vim", "editors/helix"],
    },
    {
      name: "a terminal editor unticked comes off with its config",
      from: snap([row("editors", "editors/nvim"), row("editors", "editors/vim")], [file("editors/nvim", ".config/nvim")]),
      to: snap([row("editors", "editors/vim")]),
      diff: { ...EMPTY, files: [{ id: "editors/nvim", dest: ".config/nvim", change: "removed" }], tools: [{ id: "editors/nvim", label: "neovim", change: "removed" }] },
      apply: [],
    },
    {
      name: "a remote editor's settings row is its file alone",
      from: snap([]),
      to: snap([row("editors", "editors/vscode")], [file("editors/vscode", ".vscode-server/data/Machine/settings.json")]),
      diff: { ...EMPTY, files: [{ id: "editors/vscode", dest: ".vscode-server/data/Machine/settings.json", change: "added" }] },
      apply: ["editors/vscode"],
    },
    {
      name: "the first extension ticked adds its editor's list, written from every ticked extension row",
      from: snap([]),
      to: snap([row("editors", "editors/vscode-ext/ms-python.python")]),
      diff: { ...EMPTY, tools: [{ id: "editors/vscode-ext", label: "VS Code extension list", change: "added", rows: ["editors/vscode-ext/ms-python.python"] }] },
      apply: ["editors/vscode-ext/ms-python.python"],
    },
    {
      name: "one more extension ticked is a change of the list, planned from every ticked row and never the one row alone",
      from: snap([row("editors", "editors/vscode-ext/ms-python.python")]),
      to: snap([row("editors", "editors/vscode-ext/ms-python.python"), row("editors", "editors/vscode-ext/esbenp.prettier-vscode")]),
      diff: { ...EMPTY, tools: [{ id: "editors/vscode-ext", label: "VS Code extension list", change: "changed", rows: ["editors/vscode-ext/esbenp.prettier-vscode", "editors/vscode-ext/ms-python.python"] }] },
      apply: ["editors/vscode-ext/ms-python.python", "editors/vscode-ext/esbenp.prettier-vscode"],
    },
    {
      name: "one extension unticked is a change of the list from the rows still ticked",
      from: snap([row("editors", "editors/vscode-ext/ms-python.python"), row("editors", "editors/vscode-ext/esbenp.prettier-vscode")]),
      to: snap([row("editors", "editors/vscode-ext/ms-python.python")]),
      diff: { ...EMPTY, tools: [{ id: "editors/vscode-ext", label: "VS Code extension list", change: "changed", rows: ["editors/vscode-ext/ms-python.python"] }] },
      apply: ["editors/vscode-ext/ms-python.python"],
    },
    {
      name: "the last extension unticked removes the list; another editor's list is untouched",
      from: snap([row("editors", "editors/vscode-ext/ms-python.python"), row("editors", "editors/cursor-ext/anysphere.cursorpyright")]),
      to: snap([row("editors", "editors/cursor-ext/anysphere.cursorpyright")]),
      diff: { ...EMPTY, tools: [{ id: "editors/vscode-ext", label: "VS Code extension list", change: "removed" }] },
      apply: [],
    },
    {
      name: "an agent added",
      from: snap([row("agents", "agents/claude")]),
      to: snap([row("agents", "agents/claude"), row("agents", "agents/codex")]),
      diff: { ...EMPTY, agents: [{ id: "agents/codex", label: "codex", change: "added" }] },
      apply: ["agents/codex"],
    },
    {
      name: "an agent removed",
      from: snap([row("agents", "agents/claude"), row("agents", "agents/codex")]),
      to: snap([row("agents", "agents/claude")]),
      diff: { ...EMPTY, agents: [{ id: "agents/codex", label: "codex", change: "removed" }] },
      apply: [],
    },
    {
      name: "a login now copied",
      from: snap([row("logins", "logins/gh", { choice: "machine" })]),
      to: snap([row("logins", "logins/gh", { choice: "copy" })], [file("logins/gh", ".config/gh/hosts.yml")]),
      diff: { ...EMPTY, files: [{ id: "logins/gh", dest: ".config/gh/hosts.yml", change: "added" }], logins: [{ id: "logins/gh", label: "gh", from: "machine", to: "copy" }] },
      apply: ["logins/gh"],
    },
    {
      name: "a login no longer copied takes its files off",
      from: snap([row("logins", "logins/gh", { choice: "copy" })], [file("logins/gh", ".config/gh/hosts.yml"), { id: "logins/gh", dest: ".config/gh/hosts.yml", path: "Keychain: gh:github.com", digest: "k", volatile: true }]),
      to: snap([row("logins", "logins/gh", { choice: "machine" })]),
      // The file and the Keychain secret land on one guest path, so one removal takes both off.
      diff: { ...EMPTY, files: [{ id: "logins/gh", dest: ".config/gh/hosts.yml", change: "removed" }], logins: [{ id: "logins/gh", label: "gh", from: "copy", to: "machine" }] },
      apply: [],
    },
    {
      name: "a login row unticked",
      from: snap([row("logins", "logins/codex", { choice: "copy" })]),
      to: snap([row("logins", "logins/codex", { bring: false, choice: "copy" })]),
      diff: { ...EMPTY, logins: [{ id: "logins/codex", label: "codex", from: "copy" }] },
      apply: [],
    },
    {
      name: "a ticked file gone from this computer is kept on the golden with a note, never removed",
      from: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc"), file("shell/starship", ".config/starship.toml")]),
      to: snap([row("shell", "shell/zshrc"), row("shell", "shell/starship")], [file("shell/zshrc", ".zshrc")]),
      diff: { ...EMPTY, files: [{ id: "shell/starship", dest: ".config/starship.toml", change: "missing" }] },
      apply: [],
    },
    {
      name: "the same recipe is no change, whatever the row order or the hash",
      from: snap([row("shell", "shell/zshrc"), row("tools", "tools/brew/jq")], [file("shell/zshrc", ".zshrc")]),
      to: snap([row("tools", "tools/brew/jq"), row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc")]),
      diff: EMPTY,
      apply: [],
    },
  ];

  it.each(cases)("$name", ({ from, to, diff, apply }) => {
    const got = diffRecipes(from, to);
    expect(got).toEqual(diff);
    expect([...rowsToApply(got)].sort()).toEqual(apply.sort());
    expect(isEmptyDiff(got)).toBe(diff === EMPTY);
    expect(removalsFor(got, from).map(r => r.id)).toEqual(diff.files.filter(f => f.change === "removed").map(f => f.id).concat(diff.tools.filter(t => t.change === "removed").map(t => t.id), diff.agents.filter(a => a.change === "removed").map(a => a.id)));
  });

  it("a missing file is described as kept, and a login flipped to sign in says it will not be in the golden", () => {
    const from = snap([row("shell", "shell/zshrc"), row("logins", "logins/gh", { choice: "copy" })], [file("shell/zshrc", ".zshrc")]);
    const to = snap([row("shell", "shell/zshrc"), row("logins", "logins/gh", { choice: "machine" })], []);
    expect(describeDiff(diffRecipes(from, to))).toEqual([
      "kept on the golden, no longer on this computer: ~/.zshrc",
      "gh: sign in on the machine is not done by an update, so it would not be in the golden; pick the rebuild for it",
    ]);
    expect(isSmallDelta(diffRecipes(from, to), bytesIn(to))).toBe(false);
  });

  it("an unticked row on either side is not a tool, agent or login of that side", () => {
    const from = snap([row("tools", "tools/brew/jq", { bring: false }), row("agents", "agents/codex", { bring: false })]);
    const to = snap([row("tools", "tools/brew/jq"), row("agents", "agents/codex")]);
    expect(diffRecipes(from, to)).toEqual({ ...EMPTY, tools: [{ id: "tools/brew/jq", label: "jq", change: "added" }], agents: [{ id: "agents/codex", label: "codex", change: "added" }] });
  });
});

describe("removals", () => {
  const removed = (entries: RecipeEntry[], files: DigestFile[] = []) => {
    const from = snap(entries, files);
    return removalsFor(diffRecipes(from, snap([])), from, { claude: { name: "Claude Code", install: "curl -fsSL https://claude.ai/install.sh | bash", smoke: "claude --version" } });
  };

  it("a removed file is deleted at its guest path, quoted; a dest that could leave home is refused", () => {
    expect(removed([row("shell", "shell/zshrc")], [file("shell/zshrc", ".zshrc")])).toEqual([{ what: "file", id: "shell/zshrc", label: "~/.zshrc", cmd: "rm -rf -- '/root/.zshrc'" }]);
    expect(removed([row("shell", "shell/x")], [file("shell/x", "it's here/a")])[0]!.cmd).toBe(`rm -rf -- '/root/it'\\''s here/a'`);
    for (const dest of ["", "..", "a/../b", "./a", "a//b"]) {
      expect(removed([row("shell", "shell/x")], [file("shell/x", dest)])[0]).toEqual({ what: "file", id: "shell/x", label: `~/${dest}`, note: "path refused; left on the machine" });
    }
  });

  it.each([
    ["tools/brew/jq", /brew uninstall jq/],
    ["tools/brew-tap/homebrew/cask-fonts", /brew untap homebrew\/cask-fonts/],
    ["tools/npm/bun", /npm uninstall -g bun$/],
    ["tools/pnpm/turbo", /pnpm remove -g turbo$/],
    ["tools/bun/elysia", /bun remove -g elysia$/],
    ["tools/uv/ruff", /uv tool uninstall ruff$/],
    ["tools/pipx/httpie", /pipx uninstall httpie$/],
    ["tools/cargo/ripgrep", /cargo uninstall ripgrep$/],
    ["tools/cli/spoo", /rm -f \/usr\/local\/bin\/'spoo'$/],
  ])("a removed %s is uninstalled through its manager, on the tools PATH", (id, cmd) => {
    const [r] = removed([row("tools", id)]);
    expect(r).toMatchObject({ what: "tool", id });
    expect(r!.cmd).toMatch(/^export PATH=/);
    expect(r!.cmd).toMatch(cmd);
    expect(r!.note).toBeUndefined();
  });

  it.each([
    ["tools/go/gopls", "go has no uninstall; the binary stays in /root/go/bin"],
    ["tools/brew-cask/rectangle", "never installed on Linux"],
    ["tools/mas/xcode", "never installed on Linux"],
    ["tools/other/x", "no manager known for this row"],
  ])("a removed %s has no command and is noted", (id, note) => {
    expect(removed([row("tools", id)])).toEqual([{ what: "tool", id, label: expect.any(String), note }]);
  });

  it.each([
    ["editors/nvim", "neovim", "apt-get purge -y -qq neovim && apt-get autoremove -y -qq --purge"],
    ["editors/vim", "vim", "apt-get purge -y -qq vim && apt-get autoremove -y -qq --purge"],
    ["editors/emacs", "emacs", "apt-get purge -y -qq emacs-nox && apt-get autoremove -y -qq --purge"],
    ["editors/helix", "helix", "rm -rf /opt/helix /usr/local/bin/hx"],
  ])("a removed %s is taken off by the road that put it on: apt purged with what it alone pulled in, helix's tree and link", (id, label, cmd) => {
    const got = removed([row("editors", id, { label: `${label}, installed with your config` })]);
    expect(got).toEqual([{ what: "editor", id, label, cmd: expect.stringContaining(cmd) }]);
    if (id !== "editors/helix") expect(got[0]!.cmd).toContain("export DEBIAN_FRONTEND=noninteractive\n");
  });

  it("a removed extension list is its file taken off the machine", () => {
    expect(removed([row("editors", "editors/cursor-ext/anysphere.cursorpyright")])).toEqual([{ what: "editor", id: "editors/cursor-ext", label: "Cursor extension list", cmd: "rm -f -- '/root/.cursor-server/extensions.txt'" }]);
  });

  it("a removed tap formula comes off through brew when brew put it there, else its road binary leaves /usr/local/bin", () => {
    const [r] = removed([row("tools", "tools/brew/zingzy/tap/diskbloom")]);
    expect(r).toMatchObject({ what: "tool", id: "tools/brew/zingzy/tap/diskbloom" });
    expect(r!.cmd).toMatch(/^export PATH=/);
    expect(r!.cmd).toMatch(/if \[ -x \/home\/linuxbrew\/.linuxbrew\/bin\/brew \] && su .*brew list --formula zingzy\/tap\/diskbloom.* >\/dev\/null 2>&1; then su .*brew uninstall zingzy\/tap\/diskbloom.*; else rm -f \/usr\/local\/bin\/'diskbloom'; fi$/);
  });

  it("a removed agent comes off through the inverse of its installer, with its smoke; one without an inverse is noted", () => {
    const got = removed([row("agents", "agents/codex"), row("agents", "agents/aider"), row("agents", "agents/hermes"), row("agents", "agents/claude"), row("agents", "agents/zed")]);
    expect(got).toEqual([
      { what: "agent", id: "agents/codex", label: "codex", cmd: 'export PATH="/usr/local/bin:$PATH"\nnpm uninstall -g @openai/codex', smoke: "codex --version" },
      { what: "agent", id: "agents/aider", label: "aider", cmd: "uv tool uninstall aider-chat", smoke: "aider --version" },
      { what: "agent", id: "agents/hermes", label: "hermes", cmd: "rm -rf /root/.hermes/venvs/hermes /root/.hermes/hermes-agent /usr/local/bin/hermes", smoke: "hermes --version" },
      { what: "agent", id: "agents/claude", label: "claude", note: "Claude Code has no uninstaller; left on the machine", smoke: "claude --version" },
      { what: "agent", id: "agents/zed", label: "zed", note: "no installer known, so nothing to uninstall" },
    ]);
  });

  it("pi's installer runs with --ignore-scripts and still uninstalls by package", () => {
    expect(removed([row("agents", "agents/pi")])[0]!.cmd).toBe('export PATH="/usr/local/bin:$PATH"\nnpm uninstall -g @earendil-works/pi-coding-agent');
  });
});

describe("describing and sizing the delta", () => {
  it("one line per kind of change, in plain words", () => {
    const from = snap([row("shell", "shell/zshrc"), row("tools", "tools/npm/bun", { version: "1.4.0" }), row("editors", "editors/helix"), row("agents", "agents/codex"), row("logins", "logins/gh", { choice: "copy" }), row("logins", "logins/codex", { choice: "machine" })], [
      file("shell/zshrc", ".zshrc"),
      file("logins/gh", ".config/gh/hosts.yml"),
    ]);
    const to = snap(
      [row("shell", "shell/zshrc"), row("shell", "shell/starship"), row("tools", "tools/npm/bun", { version: "1.5.0" }), row("tools", "tools/brew/jq"), row("editors", "editors/vim"), row("editors", "editors/vscode-ext/ms-python.python"), row("agents", "agents/aider"), row("logins", "logins/gh", { choice: "machine" }), row("logins", "logins/codex", { choice: "copy" })],
      [file("shell/zshrc", ".zshrc", 99), file("shell/starship", ".config/starship.toml"), file("logins/codex", ".codex/auth.json")],
    );
    expect(describeDiff(diffRecipes(from, to))).toEqual([
      "add 2 files: ~/.config/starship.toml, ~/.codex/auth.json",
      "add 1 tool: jq",
      "add 2 editors: vim, VS Code extension list",
      "add 1 agent: aider",
      "update 1 file: ~/.zshrc",
      "update 1 tool: bun (1.4.0 to 1.5.0)",
      "remove 1 file: ~/.config/gh/hosts.yml",
      "remove 1 editor: helix",
      "remove 1 agent: codex",
      "gh: sign in on the machine is not done by an update, so it would not be in the golden; pick the rebuild for it",
      "copy the codex",
    ]);
  });

  it("small: no agent added, at most SMALL_TOOLS tool installs, at most SMALL_BYTES to upload", () => {
    const base = snap([]);
    const tools = (n: number) => Array.from({ length: n }, (_, i) => row("tools", `tools/brew/t${i}`));
    expect(isSmallDelta(diffRecipes(base, snap(tools(SMALL_TOOLS))), bytesIn(snap(tools(SMALL_TOOLS))))).toBe(true);
    expect(isSmallDelta(diffRecipes(base, snap(tools(SMALL_TOOLS + 1))), bytesIn(snap(tools(SMALL_TOOLS + 1))))).toBe(false);
    // A terminal editor is one install like any tool.
    const withEditor = snap([...tools(SMALL_TOOLS), row("editors", "editors/vim")]);
    expect(isSmallDelta(diffRecipes(base, withEditor), bytesIn(withEditor))).toBe(false);
    const agent = snap([row("agents", "agents/codex")]);
    expect(isSmallDelta(diffRecipes(base, agent), bytesIn(agent))).toBe(false);
    const gone = snap([row("agents", "agents/codex")]);
    expect(isSmallDelta(diffRecipes(gone, base), bytesIn(base))).toBe(true);
    const big = snap([row("editors", "editors/nvim", { bytes: SMALL_BYTES + 1 })], [file("editors/nvim", ".config/nvim")]);
    expect(isSmallDelta(diffRecipes(base, big), bytesIn(big))).toBe(false);
    const fits = snap([row("editors", "editors/nvim", { bytes: SMALL_BYTES })], [file("editors/nvim", ".config/nvim")]);
    expect(isSmallDelta(diffRecipes(base, fits), bytesIn(fits))).toBe(true);
    // A row already on the golden and unchanged does not count against the upload.
    const same = snap([row("editors", "editors/nvim", { bytes: SMALL_BYTES + 1 }), row("shell", "shell/zshrc", { bytes: 5 })], [file("editors/nvim", ".config/nvim"), file("shell/zshrc", ".zshrc")]);
    const before = snap([row("editors", "editors/nvim", { bytes: SMALL_BYTES + 1 })], [file("editors/nvim", ".config/nvim")]);
    expect(isSmallDelta(diffRecipes(before, same), bytesIn(same))).toBe(true);
  });
});
