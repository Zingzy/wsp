// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  AGENT_INSTALLERS,
  CURRENT_LTS,
  NODE_RELEASES,
  agentInstallsFor,
  brewfileFor,
  HOMEBREW,
  nodeInstallScript,
  nodeMajorFor,
  placeGhToken,
  planFiles,
  recipeHash,
  refusedPath,
  toolInstallsFor,
  type PathInfo,
  type RecipeEntry,
} from "../src/golden-import.js";

const row = (over: Partial<RecipeEntry> & Pick<RecipeEntry, "rung" | "id">): RecipeEntry => ({
  label: over.id,
  paths: [],
  bytes: 0,
  default: "bring",
  bring: true,
  ...over,
});

const HOME = "/Users/me";
const present = new Set([
  `${HOME}/.gitconfig`,
  `${HOME}/.ssh`,
  `${HOME}/.ssh/config`,
  `${HOME}/.ssh/id_ed25519`,
  `${HOME}/.ssh/id_ed25519.pub`,
  `${HOME}/.ssh/known_hosts`,
  `${HOME}/.ssh/keys`,
  `${HOME}/.zshrc`,
  `${HOME}/.config/starship.toml`,
  `${HOME}/.oh-my-zsh/custom`,
  `${HOME}/Library/Application Support/Cursor/User/settings.json`,
  `${HOME}/Library/Preferences/.wrangler/config/default.toml`,
  `${HOME}/.claude/settings.json`,
  `${HOME}/.claude.json`,
  `${HOME}/.config/gh/hosts.yml`,
  `${HOME}/.codex/auth.json`,
  `${HOME}/dotfiles/zshrc`,
]);
/** Links on the fixture laptop: where each resolves, or nowhere. */
const links: Record<string, string | undefined> = {
  [`${HOME}/.zshrc-linked`]: `${HOME}/dotfiles/zshrc`,
  [`${HOME}/.hosts-linked`]: "/etc/hosts",
  [`${HOME}/.key-linked`]: `${HOME}/.ssh/id_ed25519`,
  [`${HOME}/.gone-linked`]: undefined,
};
const isDir = (abs: string) => abs.endsWith("custom") || abs.endsWith("/.ssh") || abs.endsWith("/.ssh/keys");
const stat = (abs: string): PathInfo | undefined => {
  if (abs in links) {
    const target = links[abs];
    if (target === undefined) return { kind: "dangling", target: `${HOME}/nowhere` };
    return { kind: "file", mode: 0o644, size: 7, mtimeMs: 7_000, realpath: target };
  }
  if (!present.has(abs)) return undefined;
  const mode = isDir(abs) ? 0o755 : abs.includes("/.ssh/") || abs.endsWith("auth.json") ? 0o600 : 0o644;
  return { kind: isDir(abs) ? "dir" : "file", mode, size: abs.length, mtimeMs: 1_000, realpath: abs };
};
const plan = (entries: RecipeEntry[], over: { platform?: "darwin" | "linux"; rewrites?: readonly [string, string][] } = {}) =>
  planFiles(entries, { home: HOME, stat, platform: over.platform ?? "darwin", ...(over.rewrites !== undefined ? { rewrites: over.rewrites } : {}) });

describe("planFiles: which laptop files travel and where they land", () => {
  it("maps ~ paths to guest-home relative destinations, keeping the mode, size and mtime the laptop has", () => {
    const p = plan([
      row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"], bytes: 225 }),
      row({ rung: "shell", id: "shell/starship", paths: ["~/.config/starship.toml"], bytes: 2258 }),
      row({ rung: "shell", id: "shell/oh-my-zsh", paths: ["~/.oh-my-zsh/custom"], bytes: 1_031_384 }),
      row({ rung: "identity", id: "identity/ssh-config", paths: ["~/.ssh/config"], bytes: 2267 }),
    ]);
    expect(p.files).toEqual([
      { id: "identity/git-user", source: `${HOME}/.gitconfig`, dest: ".gitconfig", mode: 0o644, dir: false, size: `${HOME}/.gitconfig`.length, mtimeMs: 1_000 },
      { id: "shell/starship", source: `${HOME}/.config/starship.toml`, dest: ".config/starship.toml", mode: 0o644, dir: false, size: `${HOME}/.config/starship.toml`.length, mtimeMs: 1_000 },
      { id: "shell/oh-my-zsh", source: `${HOME}/.oh-my-zsh/custom`, dest: ".oh-my-zsh/custom", mode: 0o755, dir: true, size: `${HOME}/.oh-my-zsh/custom`.length, mtimeMs: 1_000 },
      { id: "identity/ssh-config", source: `${HOME}/.ssh/config`, dest: ".ssh/config", mode: 0o600, dir: false, size: `${HOME}/.ssh/config`.length, mtimeMs: 1_000 },
    ]);
    expect(p.bytes).toBe(225 + 2258 + 1_031_384 + 2267);
    expect(p.rungs).toEqual({ identity: 2, shell: 2 });
    expect(p.skipped).toEqual([]);
    expect(p.secrets).toEqual([]);
  });

  it("brings nothing that is unticked, a list row (tools), or a login not chosen as copy", () => {
    const p = plan([
      row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"], bring: false }),
      row({ rung: "tools", id: "tools/brew/gh", paths: ["Brewfile"] }),
      row({ rung: "logins", id: "logins/codex", paths: ["~/.codex/auth.json"], choice: "machine" }),
      row({ rung: "logins", id: "logins/gcloud", paths: ["~/.config/gcloud/credentials.db"], choice: "skip" }),
      row({ rung: "logins", id: "logins/codex2", paths: ["~/.codex/auth.json"] }),
    ]);
    expect(p.files).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  it("a login chosen as copy travels with its mode", () => {
    const p = plan([row({ rung: "logins", id: "logins/codex", paths: ["~/.codex/auth.json"], choice: "copy", bytes: 205 })]);
    expect(p.files.map(f => [f.dest, f.mode])).toEqual([[".codex/auth.json", 0o600]]);
  });

  it("never includes a private key, known_hosts, GPG, or the .ssh directory itself, even when a recipe says bring", () => {
    const p = plan([
      row({ rung: "identity", id: "identity/ssh-key/id_ed25519", paths: ["~/.ssh/id_ed25519"], default: "skip", reason: "private key", bring: true }),
      row({ rung: "identity", id: "identity/gpg", paths: ["~/.gnupg"], bring: true }),
      row({ rung: "shell", id: "shell/odd", paths: ["~/.ssh/id_rsa"], bring: true }),
      row({ rung: "identity", id: "identity/ssh-public-keys", paths: ["~/.ssh/id_ed25519.pub"], required: true }),
      row({ rung: "identity", id: "identity/ssh-dir", paths: ["~/.ssh"] }),
      row({ rung: "identity", id: "identity/ssh-known", paths: ["~/.ssh/known_hosts"] }),
      row({ rung: "identity", id: "identity/ssh-extra", paths: ["~/.ssh/keys"] }),
    ]);
    expect(p.files.map(f => f.dest)).toEqual([".ssh/id_ed25519.pub"]);
    expect(p.skipped.map(s => [s.path, s.note])).toEqual([
      ["~/.ssh/id_ed25519", "private key, never copied"],
      ["~/.gnupg", "GPG keys are never copied"],
      ["~/.ssh/id_rsa", "private key, never copied"],
      ["~/.ssh", "the .ssh directory is never copied whole; tick its config and public keys"],
      ["~/.ssh/known_hosts", "known_hosts is never copied"],
      ["~/.ssh/keys", "a directory under .ssh is never copied whole"],
    ]);
    expect(refusedPath(".ssh/config", false)).toBeUndefined();
    expect(refusedPath(".ssh/config", true)).toBe("a directory under .ssh is never copied whole");
  });

  it("follows a linked dotfile to a target inside home, and refuses one that leaves home, points at a refused path, or is gone", () => {
    const p = plan([
      row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc-linked"], bytes: 7 }),
      row({ rung: "shell", id: "shell/hosts", paths: ["~/.hosts-linked"] }),
      row({ rung: "shell", id: "shell/key", paths: ["~/.key-linked"] }),
      row({ rung: "shell", id: "shell/gone", paths: ["~/.gone-linked"] }),
    ]);
    // The target's bytes ship at the link's path: dest is the link, source is the link (packing follows it).
    expect(p.files).toEqual([{ id: "shell/zshrc", source: `${HOME}/.zshrc-linked`, dest: ".zshrc-linked", mode: 0o644, dir: false, size: 7, mtimeMs: 7_000 }]);
    expect(p.skipped).toEqual([
      { id: "shell/hosts", path: "~/.hosts-linked", note: "a link to /etc/hosts, outside your home directory" },
      { id: "shell/key", path: "~/.key-linked", note: "a link to ~/.ssh/id_ed25519: private key, never copied" },
      { id: "shell/gone", path: "~/.gone-linked", note: "a link to ~/nowhere, which is gone" },
    ]);
  });

  it("a row whose file no longer exists is skipped with a note; a path outside ~ too", () => {
    const p = plan([
      row({ rung: "shell", id: "shell/bashrc", paths: ["~/.bashrc"] }),
      row({ rung: "editors", id: "editors/etc", paths: ["/etc/vimrc"] }),
    ]);
    expect(p.files).toEqual([]);
    expect(p.skipped).toEqual([
      { id: "shell/bashrc", path: "~/.bashrc", note: "no longer on this computer" },
      { id: "editors/etc", path: "/etc/vimrc", note: "not under your home directory" },
    ]);
  });

  it("rewrites macOS library paths to their Linux XDG homes, and applies the caller's rewrites first", () => {
    const p = plan(
      [
        row({ rung: "editors", id: "editors/cursor", paths: ["~/Library/Application Support/Cursor/User/settings.json"] }),
        row({ rung: "logins", id: "logins/wrangler", paths: ["~/Library/Preferences/.wrangler/config/default.toml"], choice: "copy" }),
        row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"] }),
      ],
      { rewrites: [[".claude/", ".claude-cfg/"], [".claude.json", ".claude-cfg/.claude.json"]] },
    );
    expect(p.files.map(f => f.dest)).toEqual([
      ".config/Cursor/User/settings.json",
      ".config/.wrangler/config/default.toml",
      ".claude-cfg/settings.json",
      ".claude-cfg/.claude.json",
    ]);
  });

  it("a Keychain item becomes a secret to read at pack time on macOS, and a skip note elsewhere", () => {
    const rows = [
      row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" }),
    ];
    const mac = plan(rows, { rewrites: [[".claude/", ".claude-cfg/"]] });
    expect(mac.secrets.map(s => [s.id, s.service, s.dest])).toEqual([
      ["logins/claude", "Claude Code-credentials", ".claude-cfg/.credentials.json"],
      ["logins/gh", "gh:github.com", ".config/gh/hosts.yml"],
    ]);
    expect(mac.files.map(f => f.dest)).toEqual([".config/gh/hosts.yml"]);
    expect(mac.secrets[0]!.place("{\"claudeAiOauth\":{}}", undefined)).toBe("{\"claudeAiOauth\":{}}");

    const linux = plan(rows, { platform: "linux" });
    expect(linux.secrets).toEqual([]);
    expect(linux.skipped).toEqual([{ id: "logins/claude", path: "Keychain: Claude Code-credentials", note: "a macOS Keychain item; sign in on the machine" }]);
  });

  it("a Keychain login not chosen as copy is neither read nor noted", () => {
    const p = plan([row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "machine" })]);
    expect(p.secrets).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  it("places the gh token under github.com and its users only; another host keeps its own lines", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" })]);
    const existing = [
      "ghe.corp.example:",
      "    oauth_token: ghe_theirs",
      "    git_protocol: ssh",
      "    users:",
      "        me:",
      "    user: me",
      "github.com:",
      "    git_protocol: ssh",
      "    users:",
      "        other:",
      "        Zingzy:",
      "    user: Zingzy",
      "",
    ].join("\n");
    expect(p.secrets[0]!.place("gho_x", existing)).toBe(
      [
        "ghe.corp.example:",
        "    oauth_token: ghe_theirs",
        "    git_protocol: ssh",
        "    users:",
        "        me:",
        "    user: me",
        "github.com:",
        "    oauth_token: gho_x",
        "    git_protocol: ssh",
        "    users:",
        "        other:",
        "            oauth_token: gho_x",
        "        Zingzy:",
        "            oauth_token: gho_x",
        "    user: Zingzy",
        "",
      ].join("\n"),
    );
    expect(p.secrets[0]!.place("gho_x", undefined)).toBe(["github.com:", "    oauth_token: gho_x", "    git_protocol: https", ""].join("\n"));
    // A file that knows only another host gets the github.com block appended, the other host untouched.
    expect(placeGhToken("github.com", "gho_x", "ghe.corp.example:\n    oauth_token: ghe_theirs\n    user: me\n")).toBe(
      "ghe.corp.example:\n    oauth_token: ghe_theirs\n    user: me\ngithub.com:\n    oauth_token: gho_x\n    git_protocol: https\n",
    );
  });
});

describe("recipeHash", () => {
  const files = (mtimeMs: number, size = 10) => [{ id: "shell/zshrc", dest: ".zshrc", size, mtimeMs }];

  it("depends on the ticked ids, login choices and tool pins, not on order, bytes or labels", () => {
    const a = [row({ rung: "shell", id: "shell/zshrc", bytes: 1 }), row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/bashrc", bring: false })];
    const b = [row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/zshrc", bytes: 99, label: "renamed" })];
    expect(recipeHash(a)).toBe(recipeHash(b));
    expect(recipeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(recipeHash([row({ rung: "logins", id: "logins/gh", choice: "machine" }), row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(recipeHash(a));
    expect(recipeHash([row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(recipeHash(a));
    const bun = (version: string) => [row({ rung: "tools", id: "tools/npm/bun", label: `bun@${version}`, version })];
    expect(recipeHash(bun("1.4.0"))).not.toBe(recipeHash(bun("1.5.0")));
  });

  it("changes when a shipped file's size or mtime changes, so an edited dotfile is applied again", () => {
    const rows = [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] })];
    expect(recipeHash(rows, files(1_000))).toBe(recipeHash(rows, files(1_000)));
    expect(recipeHash(rows, files(1_000))).not.toBe(recipeHash(rows, files(2_000)));
    expect(recipeHash(rows, files(1_000, 10))).not.toBe(recipeHash(rows, files(1_000, 11)));
    expect(recipeHash(rows, files(1_000))).not.toBe(recipeHash(rows));
  });
});

describe("brewfileFor", () => {
  it("lists ticked taps and formulae with a Linux bottle; unknown and macOS-only ones are noted, casks never", () => {
    const b = brewfileFor([
      row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/jq", linux: "yes", bring: false }),
      row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", linux: "unknown" }),
      row({ rung: "tools", id: "tools/brew/mas", linux: "no", bring: true }),
      row({ rung: "tools", id: "tools/brew-cask/rectangle", linux: "no", bring: true }),
      row({ rung: "tools", id: "tools/brew/bat" }),
    ]);
    expect(b.text).toBe(['tap "zingzy/tap"', 'brew "gh"', 'brew "bat"', ""].join("\n"));
    expect(b.taps).toEqual(["zingzy/tap"]);
    expect(b.formulae).toEqual(["gh", "bat"]);
    expect(b.skipped).toEqual([
      { id: "tools/brew/zingzy/tap/diskbloom", note: "no Linux bottle known" },
      { id: "tools/brew/mas", note: "no Linux bottle" },
      { id: "tools/brew-cask/rectangle", note: "macOS app, no Linux build" },
    ]);
  });

  it("is empty when nothing Homebrew is ticked", () => {
    expect(brewfileFor([row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" })]).text).toBe("");
  });
});

describe("toolInstallsFor", () => {
  it("Homebrew comes first (pinned clone, as its own user), then taps, then formulae, then each manager after its own install, with the row's pinned version", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/go/sqlc", label: "sqlc", paths: ["github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1"], version: "v1.31.1" }),
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" }),
      row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }),
      row({ rung: "tools", id: "tools/npm/@monid-ai/cli", label: "@monid-ai/cli@0.3.1", version: "0.3.1" }),
      row({ rung: "tools", id: "tools/npm/pnpm", label: "pnpm" }),
      row({ rung: "tools", id: "tools/pnpm/turbo", label: "turbo@2.5.0", version: "2.5.0" }),
      row({ rung: "tools", id: "tools/bun/eslint", label: "eslint@9.0.0", version: "9.0.0" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty v0.0.56", version: "0.0.56" }),
      row({ rung: "tools", id: "tools/pipx/black", label: "black 24.1.0", version: "24.1.0" }),
      row({ rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep 14.1.0", version: "14.1.0" }),
      row({ rung: "tools", id: "tools/brew/mas", linux: "no" }),
      row({ rung: "tools", id: "tools/go/junk", label: "junk (no module info)" }),
    ]);
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/homebrew", "brew", undefined],
      // Homebrew's own glibc then gcc, each its own brew process, before any formula (the 6.0.21 lock race).
      ["tools/brew-toolchain/glibc", "brew", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "brew", "tools/brew-toolchain/glibc"],
      ["tools/brew-tap/zingzy/tap", "brew", "tools/brew-toolchain/gcc"],
      ["tools/brew/gh", "brew", "tools/brew-toolchain/gcc"],
      ["tools/npm/bun", "npm", undefined],
      ["tools/npm/@monid-ai/cli", "npm", undefined],
      ["tools/npm/pnpm", "npm", undefined],
      // pnpm and bun came as npm globals, so their rows wait on those lines rather than on a formula.
      ["tools/pnpm/turbo", "pnpm", "tools/npm/pnpm"],
      ["tools/bun/eslint", "bun", "tools/npm/bun"],
      ["tools/manager/uv", "uv", undefined],
      ["tools/uv/ty", "uv", "tools/manager/uv"],
      ["tools/manager/pipx", "brew", "tools/brew-toolchain/gcc"],
      ["tools/pipx/black", "pipx", "tools/manager/pipx"],
      ["tools/manager/cargo", "brew", "tools/brew-toolchain/gcc"],
      ["tools/cargo/ripgrep", "cargo", "tools/manager/cargo"],
      ["tools/manager/go", "brew", "tools/brew-toolchain/gcc"],
      ["tools/go/sqlc", "go", "tools/manager/go"],
    ]);
    const cmd = (id: string) => t.installs.find(i => i.id === id)!.cmd;
    expect(cmd("tools/homebrew")).toContain(`--branch ${HOMEBREW.tag} https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew`);
    expect(cmd("tools/homebrew")).toContain(`rev-parse HEAD)" = "${HOMEBREW.commit}"`);
    expect(cmd("tools/homebrew")).toContain("useradd");
    expect(cmd("tools/homebrew")).toContain("/etc/profile.d/wsp-golden.sh");
    expect(cmd("tools/homebrew")).not.toContain("Brewfile");
    expect(cmd("tools/brew-toolchain/glibc")).toMatch(/brew install glibc'$/);
    expect(cmd("tools/brew-toolchain/gcc")).toMatch(/brew install gcc'$/);
    expect(cmd("tools/brew-tap/zingzy/tap")).toMatch(/su -s \/bin\/bash linuxbrew -c '.*brew tap zingzy\/tap'$/);
    expect(cmd("tools/brew/gh")).toMatch(/su -s \/bin\/bash linuxbrew -c '.*HOMEBREW_NO_AUTO_UPDATE=1.*brew install gh'$/);
    expect(cmd("tools/npm/bun")).toMatch(/npm install -g bun@1\.4\.0$/);
    expect(cmd("tools/npm/@monid-ai/cli")).toMatch(/npm install -g @monid-ai\/cli@0\.3\.1$/);
    expect(cmd("tools/npm/pnpm")).toMatch(/npm install -g pnpm$/);
    expect(cmd("tools/pnpm/turbo")).toMatch(/pnpm add -g turbo@2\.5\.0$/);
    expect(cmd("tools/bun/eslint")).toMatch(/bun add -g eslint@9\.0\.0$/);
    expect(cmd("tools/manager/uv")).toContain("sha256sum -c");
    expect(cmd("tools/manager/uv")).toContain("install -m 0755");
    expect(cmd("tools/uv/ty")).toMatch(/uv tool install ty==0\.0\.56$/);
    expect(cmd("tools/manager/pipx")).toMatch(/brew install pipx'$/);
    expect(cmd("tools/pipx/black")).toMatch(/pipx install black==24\.1\.0$/);
    expect(cmd("tools/manager/cargo")).toMatch(/brew install rust'$/);
    expect(cmd("tools/cargo/ripgrep")).toMatch(/cargo install ripgrep --version 14\.1\.0$/);
    expect(cmd("tools/manager/go")).toMatch(/brew install go'$/);
    expect(cmd("tools/go/sqlc")).toMatch(/go install github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc@v1\.31\.1$/);
    for (const i of t.installs) expect(i.cmd).toMatch(/^export PATH=.*PNPM_HOME=/);
    expect(t.skipped).toEqual([
      { id: "tools/brew/mas", note: "no Linux bottle" },
      { id: "tools/go/junk", note: "no module to install from" },
    ]);
    expect(t.brewfile).toBe(['tap "zingzy/tap"', 'brew "gh"', ""].join("\n"));
  });

  it("a Go row's module rides in its first path (the collector's shape) and the version field pins it; an older recipe's label shape still works", () => {
    const fresh = toolInstallsFor([row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], version: "v0.16.2" })]);
    expect(fresh.installs.at(-1)!.cmd).toMatch(/go install golang\.org\/x\/tools\/gopls@v0\.16\.2$/);
    const pinned = toolInstallsFor([row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], version: "v0.17.0" })]);
    expect(pinned.installs.at(-1)!.cmd).toMatch(/gopls@v0\.17\.0$/);
    const old = toolInstallsFor([row({ rung: "tools", id: "tools/go/gopls", label: "gopls (golang.org/x/tools/gopls@v0.16.2)" })]);
    expect(old.installs.at(-1)!.cmd).toMatch(/go install golang\.org\/x\/tools\/gopls@v0\.16\.2$/);
    expect(toolInstallsFor([row({ rung: "tools", id: "tools/go/mystery", label: "mystery (no module info)" })]).skipped).toEqual([{ id: "tools/go/mystery", note: "no module to install from" }]);
  });

  it("a row with no version installs the manager's latest; a manager already ticked as a formula is not installed twice", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/brew/pnpm", linux: "yes" }),
      row({ rung: "tools", id: "tools/pnpm/turbo", label: "turbo" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty" }),
    ]);
    expect(t.installs.map(i => [i.id, i.after])).toEqual([
      ["tools/homebrew", undefined],
      ["tools/brew-toolchain/glibc", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "tools/brew-toolchain/glibc"],
      ["tools/brew/pnpm", "tools/brew-toolchain/gcc"],
      ["tools/pnpm/turbo", "tools/brew/pnpm"],
      ["tools/manager/uv", undefined],
      ["tools/uv/ty", "tools/manager/uv"],
    ]);
    expect(t.installs.find(i => i.id === "tools/pnpm/turbo")!.cmd).toMatch(/pnpm add -g turbo$/);
    expect(t.installs.find(i => i.id === "tools/uv/ty")!.cmd).toMatch(/uv tool install ty$/);
  });

  it("a manager needed only for its rows brings Homebrew along even when no formula is ticked", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep 14.1.0", version: "14.1.0" })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/manager/cargo", "tools/cargo/ripgrep"]);
  });

  it("no Homebrew step when no formula, tap or manager needs it; unticked rows install nothing", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }), row({ rung: "tools", id: "tools/brew/gh", linux: "yes", bring: false })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/npm/bun"]);
    expect(t.brewfile).toBe("");
  });

  it("never pipes a download into a shell", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty 0.0.56", version: "0.0.56" }),
      row({ rung: "tools", id: "tools/cargo/rg", label: "rg" }),
      row({ rung: "tools", id: "tools/pnpm/x", label: "x" }),
    ]);
    for (const i of t.installs) expect(i.cmd).not.toMatch(/\|\s*(ba)?sh\b/);
  });
});

describe("agentInstallsFor", () => {
  it("every known agent has a pinned installer, its version check, and the documentation it was read from", () => {
    for (const [name, a] of Object.entries(AGENT_INSTALLERS)) {
      expect(a.name, name).not.toBe("");
      expect(a.install, name).not.toMatch(/\|\s*(ba)?sh\b/);
      expect(a.install, name).not.toMatch(/@latest\b/);
      expect(a.install, name).toMatch(/@\d|==\d|--branch v?\d|releases\/download\/\d/);
      expect(a.smoke, name).toMatch(/--version/);
    }
    expect(Object.keys(AGENT_INSTALLERS).sort()).toEqual(["aider", "codex", "gemini", "hermes", "opencode", "pi"]);
    // Engines floors as the registry states them at the pinned versions.
    expect(Object.fromEntries(Object.entries(AGENT_INSTALLERS).map(([k, a]) => [k, a.node]))).toEqual({ codex: 16, gemini: 20, opencode: undefined, aider: undefined, pi: 22, hermes: undefined });
  });

  it("installs only the ticked agents, in recipe order, letting the caller supply an installer the table lacks", () => {
    const claude = { name: "Claude Code", install: "curl -fsSL https://claude.ai/install.sh | bash", smoke: "claude --version" };
    const a = agentInstallsFor(
      [
        row({ rung: "agents", id: "agents/claude" }),
        row({ rung: "agents", id: "agents/codex" }),
        row({ rung: "agents", id: "agents/gemini", bring: false }),
        row({ rung: "agents", id: "agents/unknown-thing" }),
        row({ rung: "shell", id: "shell/zshrc" }),
      ],
      { claude },
    );
    expect(a.installs.map(i => [i.id, i.name, i.smoke])).toEqual([
      ["agents/claude", "Claude Code", "claude --version"],
      ["agents/codex", "Codex", "codex --version"],
    ]);
    expect(a.installs[1]!.install).toContain("npm install -g @openai/codex@");
    expect(a.skipped).toEqual([{ id: "agents/unknown-thing", note: "no installer known" }]);
  });

  it("asks for Node once, at the lowest supported pinned major that meets every ticked agent's floor, else the current LTS, and never without a floor", () => {
    const today = new Date("2026-09-03T00:00:00Z");
    // Node 20 left maintenance in April 2026: a Gemini-only recipe gets 22, not 20.
    const gemini = agentInstallsFor([row({ rung: "agents", id: "agents/gemini" }), row({ rung: "agents", id: "agents/opencode" })], {}, today);
    expect(gemini.node).toMatchObject({ floor: 20, version: NODE_RELEASES[22].version, agents: ["Gemini CLI"] });
    const codexOnly = agentInstallsFor([row({ rung: "agents", id: "agents/codex" })], {}, today);
    expect(codexOnly.node).toMatchObject({ floor: 16, version: NODE_RELEASES[22].version, agents: ["Codex"] });
    const both = agentInstallsFor([row({ rung: "agents", id: "agents/gemini" }), row({ rung: "agents", id: "agents/pi" })], {}, today);
    expect(both.node).toMatchObject({ floor: 22, version: NODE_RELEASES[22].version, agents: ["Gemini CLI", "Pi"] });
    expect(agentInstallsFor([row({ rung: "agents", id: "agents/opencode" }), row({ rung: "agents", id: "agents/aider" })], {}, today).node).toBeUndefined();
    expect(agentInstallsFor([row({ rung: "agents", id: "agents/pi", bring: false })], {}, today).node).toBeUndefined();
    // While 20 was still in maintenance it was the lowest satisfying major.
    expect(nodeMajorFor(20, new Date("2026-01-15T00:00:00Z"))).toBe(20);
    expect(nodeMajorFor(20, today)).toBe(22);
    expect(nodeMajorFor(16, today)).toBe(22);
    expect(nodeMajorFor(22, new Date("2028-01-01T00:00:00Z"))).toBe(CURRENT_LTS);
    expect(nodeMajorFor(24, today)).toBeUndefined();
  });

  it("an agent whose floor no pinned major meets is set aside with a note rather than installed on a Node its engines refuse", () => {
    const a = agentInstallsFor(
      [row({ rung: "agents", id: "agents/future" }), row({ rung: "agents", id: "agents/codex" })],
      { future: { name: "Future", install: "npm install -g future@1.0.0", smoke: "future --version", node: 24 } },
    );
    expect(a.installs.map(i => i.id)).toEqual(["agents/codex"]);
    expect(a.skipped).toEqual([{ id: "agents/future", note: "needs Node 24, none pinned" }]);
    expect(a.node).toMatchObject({ floor: 16, agents: ["Codex"] });
  });

  it("the Node script keeps a guest whose major meets the floor, else installs the pinned, sha256-checked release into /usr/local", () => {
    const script = nodeInstallScript(20, NODE_RELEASES[20]);
    expect(script).toContain('echo "NODE_HAVE $node_have"');
    expect(script).toContain('-ge 20 ]; then echo "NODE_KEPT $node_have"; exit 0; fi');
    expect(script).toContain(`https://nodejs.org/dist/v${NODE_RELEASES[20].version}/`);
    expect(script).toContain(`node-v${NODE_RELEASES[20].version}-linux-x64.tar.gz sha=${NODE_RELEASES[20].sha256.x86_64}`);
    expect(script).toContain(`node-v${NODE_RELEASES[20].version}-linux-arm64.tar.gz sha=${NODE_RELEASES[20].sha256.aarch64}`);
    expect(script).toContain("sha256sum -c");
    expect(script).toContain("-C /usr/local --strip-components=1");
    // The install is proven by the node on the agents' PATH being the pinned one before it is reported.
    const installed = script.indexOf(`echo "NODE_INSTALLED v${NODE_RELEASES[20].version}"`);
    const check = script.indexOf(`test "$(node --version)" = "v${NODE_RELEASES[20].version}"`);
    const path = script.indexOf('export PATH="/usr/local/bin:$PATH"');
    expect(path).toBeGreaterThan(script.indexOf("--strip-components=1"));
    expect(check).toBeGreaterThan(path);
    expect(installed).toBeGreaterThan(check);
    expect(script).not.toMatch(/apt|nvm|\| *sh\b|\| *bash\b/);
    for (const r of Object.values(NODE_RELEASES)) {
      expect(r.sha256.x86_64).toMatch(/^[0-9a-f]{64}$/);
      expect(r.sha256.aarch64).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("the hermes and aider installers bring uv by a checksummed release binary and pin the source", () => {
    const hermes = AGENT_INSTALLERS["hermes"]!.install;
    expect(hermes).toContain("sha256sum -c");
    expect(hermes).toMatch(/git clone .*--branch v\d{4}\.\d+\.\d+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git \/root\/\.hermes\/hermes-agent/);
    expect(hermes).toMatch(/rev-parse HEAD\)" = "[0-9a-f]{40}"/);
    expect(hermes).toContain("uv venv --python 3.11 /root/.hermes/venvs/hermes");
    expect(AGENT_INSTALLERS["aider"]!.install).toMatch(/uv tool install --force --python 3\.12 --with pip aider-chat==\d/);
  });
});
