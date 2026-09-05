// SPDX-License-Identifier: AGPL-3.0-only
// A small laptop as the collector would describe it, fixed so the screens'
// tests can name rows; the real collector is what wsp init runs.
import type { Manifest, ManifestEntry } from "@wsp/collect";

export const FIXTURE: Manifest = {
  entries: [
    { rung: "identity", id: "identity/git-user", label: "git name and email", paths: ["~/.gitconfig"], bytes: 512, default: "bring", required: true },
    { rung: "identity", id: "identity/ssh-config", label: "~/.ssh/config", paths: ["~/.ssh/config"], bytes: 1200, default: "bring" },
    { rung: "identity", id: "identity/ssh-key", label: "~/.ssh/id_ed25519", paths: ["~/.ssh/id_ed25519"], bytes: 400, default: "skip", reason: "private key, never copied" },
    { rung: "shell", id: "shell/zshrc", label: "~/.zshrc", paths: ["~/.zshrc"], bytes: 3000, default: "bring" },
    { rung: "shell", id: "shell/starship", label: "starship prompt", paths: ["~/.config/starship.toml"], bytes: 900, default: "bring" },
    { rung: "editors", id: "editors/nvim", label: "neovim, installed with your config", paths: ["~/.config/nvim"], bytes: 120_000, default: "bring" },
    { rung: "toolchains", id: "toolchains/mise", label: "mise pins", paths: ["~/.config/mise/config.toml"], bytes: 300, default: "bring" },
    { rung: "tools", id: "tools/brew/gh", label: "gh", group: "Homebrew", paths: ["Brewfile"], bytes: 0, default: "bring" },
    { rung: "tools", id: "tools/brew/jq", label: "jq", group: "Homebrew", paths: ["Brewfile"], bytes: 0, default: "bring" },
    { rung: "tools", id: "tools/npm/pnpm", label: "pnpm", group: "npm globals", paths: [], bytes: 0, default: "bring" },
    { rung: "tools", id: "tools/brew/rectangle", label: "rectangle", group: "Homebrew casks", paths: ["Brewfile"], bytes: 0, default: "skip", reason: "macOS app, no Linux build" },
    { rung: "agents", id: "agents/claude", label: "Claude Code", paths: ["~/.claude"], bytes: 40_000, default: "bring" },
    { rung: "agents", id: "agents/codex", label: "Codex", paths: ["~/.codex"], bytes: 8_000, default: "skip" },
    { rung: "logins", id: "logins/gh", label: "GitHub CLI login", group: "CLI logins", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], bytes: 200, default: "bring" },
    { rung: "logins", id: "logins/claude", label: "Claude Code login", group: "Agent logins", paths: ["Keychain: Claude Code-credentials"], bytes: 0, default: "skip" },
    { rung: "logins", id: "logins/codex", label: "Codex login", group: "Agent logins", paths: ["~/.codex/auth.json"], bytes: 300, default: "bring" },
  ],
};

/** What the everything rung finds on the same laptop: a config directory with a cache split out, a
 * credential-shaped file, a large directory, and a Keychain item, as the adapter shapes them. */
export const EVERYTHING: ManifestEntry[] = [
  { rung: "everything", id: "everything/.config/demo", label: "demo", paths: ["~/.config/demo"], excludes: ["~/.config/demo/cache"], bytes: 300, default: "skip", role: "config", files: 2, mtime: Date.UTC(2026, 7, 12, 12), detail: "looks like config; installed by homebrew" },
  { rung: "everything", id: "everything/.demo-token", label: ".demo-token", paths: ["~/.demo-token"], bytes: 40, default: "skip", consent: true, role: "credential", files: 1, mtime: Date.UTC(2026, 7, 12, 12), detail: "credential-shaped" },
  { rung: "everything", id: "everything/.big", label: ".big", paths: ["~/.big"], bytes: 1_258_291, default: "skip", group: "large, review", role: "unknown", files: 900, mtime: Date.UTC(2026, 0, 5, 12), detail: "nothing says what this is; large; never copied without a tick" },
  { rung: "everything", id: "everything/keychain:Raycast", label: "Raycast", paths: [], bytes: 0, default: "skip", reason: "signed in here; the login is bound to this device, sign in on the machine", group: "Keychain, device-bound", role: "device-bound-login", files: 0, mtime: 0 },
];

export const byId = (id: string): ManifestEntry => {
  const e = FIXTURE.entries.find(x => x.id === id);
  if (!e) throw new Error(`no fixture entry ${id}`);
  return e;
};
