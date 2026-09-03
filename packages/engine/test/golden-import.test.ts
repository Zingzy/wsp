// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  AGENT_INSTALLERS,
  agentInstallsFor,
  brewfileFor,
  HOMEBREW,
  planFiles,
  recipeHash,
  toolInstallsFor,
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
  `${HOME}/.ssh/config`,
  `${HOME}/.ssh/id_ed25519`,
  `${HOME}/.ssh/id_ed25519.pub`,
  `${HOME}/.zshrc`,
  `${HOME}/.config/starship.toml`,
  `${HOME}/.oh-my-zsh/custom`,
  `${HOME}/Library/Application Support/Cursor/User/settings.json`,
  `${HOME}/Library/Preferences/.wrangler/config/default.toml`,
  `${HOME}/.claude/settings.json`,
  `${HOME}/.claude.json`,
  `${HOME}/.config/gh/hosts.yml`,
  `${HOME}/.codex/auth.json`,
]);
const stat = (abs: string) => {
  if (!present.has(abs)) return undefined;
  if (abs.endsWith("custom")) return { mode: 0o755, dir: true };
  if (abs.includes("/.ssh/") || abs.endsWith("auth.json")) return { mode: 0o600, dir: false };
  return { mode: 0o644, dir: false };
};
const plan = (entries: RecipeEntry[], over: { platform?: "darwin" | "linux"; rewrites?: readonly [string, string][] } = {}) =>
  planFiles(entries, { home: HOME, stat, platform: over.platform ?? "darwin", ...(over.rewrites !== undefined ? { rewrites: over.rewrites } : {}) });

describe("planFiles: which laptop files travel and where they land", () => {
  it("maps ~ paths to guest-home relative destinations, keeping the mode the laptop has", () => {
    const p = plan([
      row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"], bytes: 225 }),
      row({ rung: "shell", id: "shell/starship", paths: ["~/.config/starship.toml"], bytes: 2258 }),
      row({ rung: "shell", id: "shell/oh-my-zsh", paths: ["~/.oh-my-zsh/custom"], bytes: 1_031_384 }),
      row({ rung: "identity", id: "identity/ssh-config", paths: ["~/.ssh/config"], bytes: 2267 }),
    ]);
    expect(p.files).toEqual([
      { id: "identity/git-user", source: `${HOME}/.gitconfig`, dest: ".gitconfig", mode: 0o644, dir: false },
      { id: "shell/starship", source: `${HOME}/.config/starship.toml`, dest: ".config/starship.toml", mode: 0o644, dir: false },
      { id: "shell/oh-my-zsh", source: `${HOME}/.oh-my-zsh/custom`, dest: ".oh-my-zsh/custom", mode: 0o755, dir: true },
      { id: "identity/ssh-config", source: `${HOME}/.ssh/config`, dest: ".ssh/config", mode: 0o600, dir: false },
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
    expect(p.files).toEqual([{ id: "logins/codex", source: `${HOME}/.codex/auth.json`, dest: ".codex/auth.json", mode: 0o600, dir: false }]);
  });

  it("never includes a private key, even when a recipe says bring", () => {
    const p = plan([
      row({ rung: "identity", id: "identity/ssh-key/id_ed25519", paths: ["~/.ssh/id_ed25519"], default: "skip", reason: "private key", bring: true }),
      row({ rung: "identity", id: "identity/gpg", paths: ["~/.gnupg"], bring: true }),
      row({ rung: "shell", id: "shell/odd", paths: ["~/.ssh/id_rsa"], bring: true }),
      row({ rung: "identity", id: "identity/ssh-public-keys", paths: ["~/.ssh/id_ed25519.pub"], required: true }),
    ]);
    expect(p.files.map(f => f.dest)).toEqual([".ssh/id_ed25519.pub"]);
    expect(p.skipped.map(s => s.note)).toEqual([
      "private key, never copied",
      "GPG keys are never copied",
      "private key, never copied",
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

  it("places the gh token into hosts.yml under the host and each user", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" })]);
    const existing = ["github.com:", "    git_protocol: ssh", "    users:", "        other:", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    expect(p.secrets[0]!.place("gho_x", existing)).toBe(
      [
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
  });
});

describe("recipeHash", () => {
  it("depends on the ticked ids and login choices only, not on order or bytes", () => {
    const a = [row({ rung: "shell", id: "shell/zshrc", bytes: 1 }), row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/bashrc", bring: false })];
    const b = [row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/zshrc", bytes: 99 })];
    expect(recipeHash(a)).toBe(recipeHash(b));
    expect(recipeHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(recipeHash([row({ rung: "logins", id: "logins/gh", choice: "machine" }), row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(recipeHash(a));
    expect(recipeHash([row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(recipeHash(a));
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
    expect(brewfileFor([row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0" })]).text).toBe("");
  });
});

describe("toolInstallsFor", () => {
  it("Homebrew comes first (pinned clone, as its own user), then taps, then formulae, then the other managers with their pins", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/go/sqlc", label: "sqlc (github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1)" }),
      row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" }),
      row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0" }),
      row({ rung: "tools", id: "tools/npm/@monid-ai/cli", label: "@monid-ai/cli@0.3.1" }),
      row({ rung: "tools", id: "tools/npm/pnpm", label: "pnpm" }),
      row({ rung: "tools", id: "tools/pnpm/turbo", label: "turbo@2.5.0" }),
      row({ rung: "tools", id: "tools/bun/eslint", label: "eslint@9.0.0" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty 0.0.56" }),
      row({ rung: "tools", id: "tools/pipx/black", label: "black 24.1.0" }),
      row({ rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep 14.1.0" }),
      row({ rung: "tools", id: "tools/brew/mas", linux: "no" }),
      row({ rung: "tools", id: "tools/go/junk", label: "junk (no module info)" }),
    ]);
    expect(t.installs.map(i => [i.id, i.manager])).toEqual([
      ["tools/homebrew", "brew"],
      ["tools/brew-tap/zingzy/tap", "brew"],
      ["tools/brew/gh", "brew"],
      ["tools/npm/bun", "npm"],
      ["tools/npm/@monid-ai/cli", "npm"],
      ["tools/npm/pnpm", "npm"],
      ["tools/pnpm/turbo", "pnpm"],
      ["tools/bun/eslint", "bun"],
      ["tools/uv/ty", "uv"],
      ["tools/pipx/black", "pipx"],
      ["tools/cargo/ripgrep", "cargo"],
      ["tools/go/sqlc", "go"],
    ]);
    const cmd = (id: string) => t.installs.find(i => i.id === id)!.cmd;
    expect(cmd("tools/homebrew")).toContain(`--branch ${HOMEBREW.tag} https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew`);
    expect(cmd("tools/homebrew")).toContain(`rev-parse HEAD)" = "${HOMEBREW.commit}"`);
    expect(cmd("tools/homebrew")).toContain("useradd");
    expect(cmd("tools/homebrew")).toContain("/etc/profile.d/wsp-golden.sh");
    expect(cmd("tools/brew-tap/zingzy/tap")).toMatch(/su -s \/bin\/bash linuxbrew -c '.*brew tap zingzy\/tap'$/);
    expect(cmd("tools/brew/gh")).toMatch(/su -s \/bin\/bash linuxbrew -c '.*HOMEBREW_NO_AUTO_UPDATE=1.*brew install gh'$/);
    expect(cmd("tools/npm/bun")).toMatch(/npm install -g bun@1\.4\.0$/);
    expect(cmd("tools/npm/@monid-ai/cli")).toMatch(/npm install -g @monid-ai\/cli@0\.3\.1$/);
    expect(cmd("tools/npm/pnpm")).toMatch(/npm install -g pnpm$/);
    expect(cmd("tools/pnpm/turbo")).toMatch(/pnpm add -g turbo@2\.5\.0$/);
    expect(cmd("tools/bun/eslint")).toMatch(/bun add -g eslint@9\.0\.0$/);
    expect(cmd("tools/uv/ty")).toMatch(/uv tool install ty==0\.0\.56$/);
    expect(cmd("tools/pipx/black")).toMatch(/pipx install black==24\.1\.0$/);
    expect(cmd("tools/cargo/ripgrep")).toMatch(/cargo install ripgrep --version 14\.1\.0$/);
    expect(cmd("tools/go/sqlc")).toMatch(/go install github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc@v1\.31\.1$/);
    for (const i of t.installs) expect(i.cmd).toMatch(/^export PATH=/);
    expect(t.skipped).toEqual([
      { id: "tools/brew/mas", note: "no Linux bottle" },
      { id: "tools/go/junk", note: "no module to install from" },
    ]);
    expect(t.brewfile).toBe(['tap "zingzy/tap"', 'brew "gh"', ""].join("\n"));
  });

  it("no Homebrew step when no formula or tap is ticked; unticked rows install nothing", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0" }), row({ rung: "tools", id: "tools/brew/gh", linux: "yes", bring: false })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/npm/bun"]);
    expect(t.brewfile).toBe("");
  });

  it("never pipes a download into a shell", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }), row({ rung: "tools", id: "tools/uv/ty", label: "ty 0.0.56" })]);
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

  it("the hermes and aider installers bring uv by a checksummed release binary and pin the source", () => {
    const hermes = AGENT_INSTALLERS["hermes"]!.install;
    expect(hermes).toContain("sha256sum -c");
    expect(hermes).toMatch(/git clone .*--branch v\d{4}\.\d+\.\d+ https:\/\/github\.com\/NousResearch\/hermes-agent\.git \/root\/\.hermes\/hermes-agent/);
    expect(hermes).toMatch(/rev-parse HEAD\)" = "[0-9a-f]{40}"/);
    expect(hermes).toContain("uv venv --python 3.11 /root/.hermes/venvs/hermes");
    expect(AGENT_INSTALLERS["aider"]!.install).toMatch(/uv tool install --force --python 3\.12 --with pip aider-chat==\d/);
  });
});
