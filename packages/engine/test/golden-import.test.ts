// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  UNMEASURED_ROAD,
  PATH_LINE,
  CATALOG_PREFIX,
  AGENT_INSTALLERS,
  CURRENT_LTS,
  HELIX,
  NODE_RELEASES,
  agentInstallsFor,
  agentOwning,
  brewfileFor,
  editorInstallsFor,
  dropGhAccount,
  ghAccounts,
  extensionsFile,
  HOMEBREW,
  remoteEditorFor,
  remoteSettingsPath,
  nodeInstallScript,
  neverCopied,
  nodeMajorFor,
  placeGhToken,
  forGuest,
  planFiles,
  recipeDigest,
  recipeHash,
  refusedPath,
  secretKey,
  secretPath,
  withApiKeyHelper,
  SHELL_FRAMEWORKS,
  shellInstallFor,
  toolInstallsFor,
  toolUninstall,
  BREW_HOUSEKEEPING,
  type BrewTable,
  type DigestedFile,
  type PathInfo,
  type RecipeDigest,
  type RecipeEntry,
} from "../src/golden-import.js";
import { KUBECTL, LINUX_CASKS, caskPinState, catalogEntry, linuxCaskByBin, linuxCaskFor } from "@wsp/catalog";

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
  `${HOME}/.local/bin/deploy`,
  `${HOME}/.local/bin/omp`,
  `${HOME}/.local/bin/agent`,
  `${HOME}/.config/starship.toml`,
  `${HOME}/.oh-my-zsh/custom`,
  `${HOME}/Library/Application Support/Cursor/User/settings.json`,
  `${HOME}/Library/Application Support/Code/User/settings.json`,
  `${HOME}/.config/Code/User/settings.json`,
  `${HOME}/.config/Cursor/User/settings.json`,
  `${HOME}/Library/Application Support/Code - Insiders/User/settings.json`,
  `${HOME}/.config/zed`,
  `${HOME}/Library/Preferences/.wrangler/config/default.toml`,
  `${HOME}/.claude`,
  `${HOME}/.claude/settings.json`,
  `${HOME}/.claude.json`,
  `${HOME}/.config/gh/hosts.yml`,
  `${HOME}/.codex/auth.json`,
  `${HOME}/dotfiles/zshrc`,
  `${HOME}/.config/demo`,
  `${HOME}/.config/demo/settings.toml`,
  `${HOME}/.config/demo/cache`,
  `${HOME}/.demo-token`,
  `${HOME}/.env`,
  `${HOME}/.netrc`,
  `${HOME}/.app/.env.local`,
  `${HOME}/.hermes/.env`,
  `${HOME}/proj/.env`,
]);
/** Links on the fixture laptop: where each resolves, or nowhere. */
const links: Record<string, string | undefined> = {
  [`${HOME}/.zshrc-linked`]: `${HOME}/dotfiles/zshrc`,
  [`${HOME}/.hosts-linked`]: "/etc/hosts",
  [`${HOME}/.key-linked`]: `${HOME}/.ssh/id_ed25519`,
  [`${HOME}/.gone-linked`]: undefined,
};
const isDir = (abs: string) => abs.endsWith("custom") || abs.endsWith("/.ssh") || abs.endsWith("/.ssh/keys") || abs.endsWith("/.claude") || abs.endsWith("/.config/demo") || abs.endsWith("/.config/zed") || abs.endsWith("/demo/cache") || abs.endsWith("/proj/.env");
const stat = (abs: string): PathInfo | undefined => {
  if (abs in links) {
    const target = links[abs];
    if (target === undefined) return { kind: "dangling", target: `${HOME}/nowhere` };
    return { kind: "file", mode: 0o644, size: 7, mtimeMs: 7_000, realpath: target };
  }
  if (!present.has(abs)) return undefined;
  const mode = isDir(abs) || abs.includes("/.local/bin/") ? 0o755 : abs.includes("/.ssh/") || abs.endsWith("auth.json") || abs.endsWith("-token") || abs.endsWith("/.netrc") ? 0o600 : 0o644;
  return { kind: isDir(abs) ? "dir" : "file", mode, size: abs.length, mtimeMs: 1_000, realpath: abs };
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
      { id: "identity/git-user", source: `${HOME}/.gitconfig`, dest: ".gitconfig", mode: 0o644, dir: false, excludes: [], volatile: false },
      { id: "shell/starship", source: `${HOME}/.config/starship.toml`, dest: ".config/starship.toml", mode: 0o644, dir: false, excludes: [], volatile: false },
      { id: "shell/oh-my-zsh", source: `${HOME}/.oh-my-zsh/custom`, dest: ".oh-my-zsh/custom", mode: 0o755, dir: true, excludes: [], volatile: false },
      { id: "identity/ssh-config", source: `${HOME}/.ssh/config`, dest: ".ssh/config", mode: 0o600, dir: false, excludes: [], volatile: false },
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

  it("a hand-installed script or ELF is the one tools row that travels: as a copy with its execute bit, an ELF with its arch; a macOS binary's row does not", () => {
    const p = plan([
      row({ rung: "tools", id: "tools/hand/deploy", paths: ["~/.local/bin/deploy"], bytes: 18, linux: "unknown" }),
      row({ rung: "tools", id: "tools/hand/agent", paths: ["~/.local/bin/agent"], bytes: 9_000_000, linux: "unknown", arch: "aarch64" }),
      row({ rung: "tools", id: "tools/hand/omp", paths: ["~/.local/bin/omp"], bytes: 122_000_000, linux: "no", default: "skip", reason: "installed by hand; no Linux build known" }),
    ]);
    expect(p.files).toEqual([
      { id: "tools/hand/deploy", source: `${HOME}/.local/bin/deploy`, dest: ".local/bin/deploy", mode: 0o755, dir: false, excludes: [], volatile: false },
      { id: "tools/hand/agent", source: `${HOME}/.local/bin/agent`, dest: ".local/bin/agent", mode: 0o755, dir: false, excludes: [], volatile: false, arch: "aarch64" },
    ]);
    expect(p.rungs).toEqual({ tools: 2 });
    expect(p.skipped).toEqual([]);
  });

  it("forGuest sets aside a copy built for another arch than the machine's, or for any arch when the machine's could not be read", () => {
    const p = plan([
      row({ rung: "tools", id: "tools/hand/deploy", paths: ["~/.local/bin/deploy"], bytes: 18, linux: "unknown" }),
      row({ rung: "tools", id: "tools/hand/agent", paths: ["~/.local/bin/agent"], bytes: 9_000_000, linux: "unknown", arch: "aarch64" }),
    ]);
    const same = forGuest(p, { arch: "aarch64" }, HOME);
    expect(same.files.map(f => f.id)).toEqual(["tools/hand/deploy", "tools/hand/agent"]);
    expect(same.skipped).toEqual([]);
    const other = forGuest(p, { arch: "x86_64" }, HOME);
    expect(other.files.map(f => f.id)).toEqual(["tools/hand/deploy"]);
    expect(other.skipped).toEqual([{ id: "tools/hand/agent", path: "~/.local/bin/agent", note: "built for aarch64; the machine is x86_64" }]);
    const unread = forGuest(p, {}, HOME);
    expect(unread.files.map(f => f.id)).toEqual(["tools/hand/deploy"]);
    expect(unread.skipped).toEqual([{ id: "tools/hand/agent", path: "~/.local/bin/agent", note: "built for aarch64; the machine's architecture could not be read" }]);
    expect(p.files).toHaveLength(2);
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
    expect(p.files).toEqual([{ id: "shell/zshrc", source: `${HOME}/.zshrc-linked`, dest: ".zshrc-linked", mode: 0o644, dir: false, excludes: [], volatile: false }]);
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
      ".cursor-server/data/Machine/settings.json",
      ".config/.wrangler/config/default.toml",
      ".claude-cfg/settings.json",
      ".claude-cfg/.claude.json",
    ]);
    // A row that names the directory itself moves with it; the guest's config dir is what CLAUDE_CONFIG_DIR reads.
    const bare = plan([row({ rung: "agents", id: "agents/claude", paths: ["~/.claude"] })], { rewrites: [[".claude/", ".claude-cfg/"]] });
    expect(bare.files.map(f => [f.dest, f.dir])).toEqual([[".claude-cfg", true]]);
  });

  it("an editor's settings.json lands where its remote server reads machine settings, from either laptop", () => {
    const mac = plan([row({ rung: "editors", id: "editors/vscode", paths: ["~/Library/Application Support/Code/User/settings.json"] })]);
    expect(mac.files.map(f => f.dest)).toEqual([".vscode-server/data/Machine/settings.json"]);
    const linux = plan(
      [row({ rung: "editors", id: "editors/vscode", paths: ["~/.config/Code/User/settings.json"] }), row({ rung: "editors", id: "editors/cursor", paths: ["~/.config/Cursor/User/settings.json"] })],
      { platform: "linux" },
    );
    expect(linux.files.map(f => f.dest)).toEqual([".vscode-server/data/Machine/settings.json", ".cursor-server/data/Machine/settings.json"]);
    const insiders = plan([
      row({ rung: "editors", id: "editors/vscode-insiders", paths: ["~/Library/Application Support/Code - Insiders/User/settings.json"] }),
      row({ rung: "editors", id: "editors/zed", paths: ["~/.config/zed"] }),
    ]);
    expect(insiders.files.map(f => [f.dest, f.dir])).toEqual([[".vscode-server-insiders/data/Machine/settings.json", false], [".config/zed", true]]);
    // The path is the remote server's: `--server-data-dir` defaults to ~/.vscode-server, its user data to data/ under it.
    expect(remoteSettingsPath(".vscode-server")).toBe(".vscode-server/data/Machine/settings.json");
  });

  it("a Keychain item becomes a secret to read at pack time on macOS, and a skip note elsewhere", () => {
    const rows = [
      row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
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
    expect(linux.skipped).toEqual([
      { id: "logins/claude", path: "Keychain: Claude Code-credentials", note: "a macOS Keychain item; sign in on the machine" },
      { id: "logins/gh", path: "Keychain: gh:github.com", note: "a macOS Keychain item; sign in on the machine" },
    ]);
  });

  it("a Keychain read is planned only for a Keychain: path the row carries; a gh row with hosts.yml alone reads nothing", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" })]);
    expect(p.secrets).toEqual([]);
    expect(p.files.map(f => f.dest)).toEqual([".config/gh/hosts.yml"]);
    expect(p.skipped).toEqual([]);
  });

  it("the Keychain: prefix is read whatever its case, as the collector's claims are", () => {
    const p = plan([row({ rung: "logins", id: "logins/gh", paths: ["keychain:gh:github.com"], choice: "copy" })]);
    expect(p.secrets.map(s => [s.id, s.service, s.dest])).toEqual([["logins/gh", "gh:github.com", ".config/gh/hosts.yml"]]);
    expect(p.skipped).toEqual([]);
  });

  it("a Keychain: path for a login the table has no reader for is a note, not a silent drop", () => {
    const p = plan([row({ rung: "logins", id: "logins/glab", paths: ["Keychain: glab:gitlab.com"], choice: "copy" })]);
    expect(p.secrets).toEqual([]);
    expect(p.skipped).toEqual([{ id: "logins/glab", path: "Keychain: glab:gitlab.com", note: "no Keychain reader for this login yet; sign in on the machine" }]);
  });

  it("a Helper: path plans the key the settings file's apiKeyHelper prints as a secret to run at pack time, on either platform, with a note when the file names no helper", () => {
    const settings = '{"apiKeyHelper": "security find-generic-password -s anthropic-api-key -w", "model": "opus"}';
    const claude = row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials", "Helper: ~/.claude/settings.json"], choice: "copy" });
    for (const platform of ["darwin", "linux"] as const) {
      const p = planFiles([claude], { home: HOME, stat, platform, read: abs => (abs === `${HOME}/.claude/settings.json` ? settings : undefined), rewrites: [[".claude/", ".claude-cfg/"]] });
      const helper = p.secrets.find(s => s.command !== undefined)!;
      expect(helper).toMatchObject({ id: "logins/claude", service: "~/.claude/settings.json", command: "security find-generic-password -s anthropic-api-key -w", dest: ".claude-cfg/anthropic-api-key" });
      expect(helper.place("sk-ant-x", undefined)).toBe("sk-ant-x\n");
      expect(secretPath(helper)).toBe("Helper: ~/.claude/settings.json");
      expect(secretKey(helper)).toBe("~/.claude/settings.json");
      expect(p.rungs).toEqual({ logins: platform === "darwin" ? 2 : 1 });
    }
    expect(secretPath({ service: "gh:github.com", account: "Zingzy" })).toBe("Keychain: gh:github.com (Zingzy)");
    const none = planFiles([row({ rung: "logins", id: "logins/claude", paths: ["Helper: ~/.claude/settings.json"], choice: "copy" })], { home: HOME, stat, platform: "darwin", read: () => '{"model": "opus"}' });
    expect(none.secrets).toEqual([]);
    expect(none.skipped).toEqual([{ id: "logins/claude", path: "Helper: ~/.claude/settings.json", note: "no apiKeyHelper in ~/.claude/settings.json any more; sign in on the machine" }]);
    const unknown = planFiles([row({ rung: "logins", id: "logins/x", paths: ["Helper: ~/.x/settings.json"], choice: "copy" })], { home: HOME, stat, platform: "darwin", read: () => "{}" });
    expect(unknown.skipped).toEqual([{ id: "logins/x", path: "Helper: ~/.x/settings.json", note: "no helper reader for this login yet; sign in on the machine" }]);
  });

  it("withApiKeyHelper points a copied settings.json at the key file on the machine, drops the helper when no key travels, and leaves a file without one alone", () => {
    const settings = '{\n  "apiKeyHelper": "security find-generic-password -s anthropic-api-key -w",\n  "model": "opus"\n}\n';
    expect(withApiKeyHelper(settings, "cat /root/.claude-cfg/anthropic-api-key")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key",\n  "model": "opus"\n}\n');
    expect(withApiKeyHelper(settings, undefined)).toBe('{\n  "model": "opus"\n}\n');
    expect(withApiKeyHelper(undefined, "cat /root/.claude-cfg/anthropic-api-key")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key"\n}\n');
    for (const text of ['{"model": "opus"}', "{ not json", ""]) expect(withApiKeyHelper(text, undefined)).toBe(text);
    expect(withApiKeyHelper("{ not json", "cat x")).toBe("{ not json");
  });

  it("a Keychain login not chosen as copy is neither read nor noted", () => {
    const p = plan([row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "machine" })]);
    expect(p.secrets).toEqual([]);
    expect(p.skipped).toEqual([]);
  });

  it("plans one gh item per account hosts.yml lists, each placing its own token under its user and the active one under the host; another host keeps its own lines", () => {
    const mac = ["github.com:", "    git_protocol: ssh", "    users:", "        other:", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    expect(ghAccounts(mac, "github.com")).toEqual({ users: ["other", "Zingzy"], active: "Zingzy" });
    expect(ghAccounts(mac, "ghe.corp.example")).toEqual({ users: [] });
    const read = (abs: string) => (abs === `${HOME}/.config/gh/hosts.yml` ? mac : undefined);
    const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" });
    const p = planFiles([gh], { home: HOME, stat, platform: "darwin", read });
    expect(p.secrets.map(s => [s.id, s.service, s.account, s.dest])).toEqual([
      ["logins/gh", "gh:github.com", "other", ".config/gh/hosts.yml"],
      ["logins/gh", "gh:github.com", "Zingzy", ".config/gh/hosts.yml"],
    ]);
    expect(p.secrets.map(secretKey)).toEqual(["gh:github.com (other)", "gh:github.com (Zingzy)"]);
    const existing = ["ghe.corp.example:", "    oauth_token: ghe_theirs", "    git_protocol: ssh", "    users:", "        me:", "    user: me", ...mac.split("\n")].join("\n");
    // The pack places them in turn, each on the other's result.
    const placed = p.secrets[1]!.place("gho_zingzy", p.secrets[0]!.place("gho_other", existing));
    expect(placed).toBe(
      [
        "ghe.corp.example:",
        "    oauth_token: ghe_theirs",
        "    git_protocol: ssh",
        "    users:",
        "        me:",
        "    user: me",
        "github.com:",
        "    oauth_token: gho_zingzy",
        "    git_protocol: ssh",
        "    users:",
        "        other:",
        "            oauth_token: gho_other",
        "        Zingzy:",
        "            oauth_token: gho_zingzy",
        "    user: Zingzy",
        "",
      ].join("\n"),
    );
    // Placed again with fresher tokens, the old lines go and nothing doubles.
    expect(p.secrets[1]!.place("gho_z2", p.secrets[0]!.place("gho_o2", placed))).toBe(placed.replace(/gho_zingzy/g, "gho_z2").replace("gho_other", "gho_o2"));
    // A file without the host gets a block with the account's token under its user alone: nothing marked it active.
    expect(p.secrets[1]!.place("gho_zingzy", undefined)).toBe(["github.com:", "    git_protocol: https", "    users:", "        Zingzy:", "            oauth_token: gho_zingzy", ""].join("\n"));
    expect(placeGhToken("github.com", "gho_zingzy", "ghe.corp.example:\n    user: me\n", "Zingzy")).toBe(["ghe.corp.example:", "    user: me", "github.com:", "    git_protocol: https", "    users:", "        Zingzy:", "            oauth_token: gho_zingzy", ""].join("\n"));
  });

  it("drops an account from hosts.yml: its lines leave the users block, the active mark moves to the first account left, another host is untouched", () => {
    const mac = ["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", "    users:", "        other:", "            git_protocol: https", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    const read = (abs: string) => (abs === `${HOME}/.config/gh/hosts.yml` ? mac : undefined);
    const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" });
    const p = planFiles([gh], { home: HOME, stat, platform: "darwin", read });
    expect(p.secrets.map(s => s.account)).toEqual(["other", "Zingzy"]);
    // The inactive account goes with its nested lines; the active one keeps the host.
    const withoutOther = p.secrets[0]!.drop!(mac);
    expect(withoutOther).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", "    users:", "        Zingzy:", "    user: Zingzy", ""].join("\n"));
    expect(ghAccounts(withoutOther, "github.com")).toEqual({ users: ["Zingzy"], active: "Zingzy" });
    // The active account goes and the one left becomes active, so its token lands under the host too.
    const withoutZingzy = p.secrets[1]!.drop!(mac);
    expect(withoutZingzy).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", "    users:", "        other:", "            git_protocol: https", "    user: other", ""].join("\n"));
    expect(p.secrets[0]!.place("gho_other", withoutZingzy)).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    oauth_token: gho_other", "    git_protocol: ssh", "    users:", "        other:", "            oauth_token: gho_other", "            git_protocol: https", "    user: other", ""].join("\n"));
    // The last account out takes the users block and the active mark with it.
    expect(dropGhAccount("github.com", withoutOther, "Zingzy")).toBe(["ghe.corp.example:", "    users:", "        other:", "    user: other", "github.com:", "    git_protocol: ssh", ""].join("\n"));
    // An account the file does not list changes nothing.
    expect(dropGhAccount("github.com", mac, "nobody")).toBe(mac);
  });

  it("with no account list (no reader, or a hosts.yml naming none) the gh item is one and its token goes under the host alone", () => {
    const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" });
    const p = plan([gh]);
    expect(p.secrets.map(s => [s.id, s.service, s.account])).toEqual([["logins/gh", "gh:github.com", undefined]]);
    expect(planFiles([gh], { home: HOME, stat, platform: "darwin", read: () => "github.com:\n    user: Zingzy\n" }).secrets.map(s => s.account)).toEqual([undefined]);
    const existing = ["github.com:", "    oauth_token: gho_old", "    git_protocol: ssh", "    users:", "        Zingzy:", "    user: Zingzy", ""].join("\n");
    expect(p.secrets[0]!.place("gho_x", existing)).toBe(["github.com:", "    oauth_token: gho_x", "    git_protocol: ssh", "    users:", "        Zingzy:", "    user: Zingzy", ""].join("\n"));
    expect(p.secrets[0]!.place("gho_x", undefined)).toBe(["github.com:", "    oauth_token: gho_x", "    git_protocol: https", ""].join("\n"));
    // A file that knows only another host gets the github.com block appended, the other host untouched.
    expect(placeGhToken("github.com", "gho_x", "ghe.corp.example:\n    oauth_token: ghe_theirs\n    user: me\n")).toBe(
      "ghe.corp.example:\n    oauth_token: ghe_theirs\n    user: me\ngithub.com:\n    oauth_token: gho_x\n    git_protocol: https\n",
    );
  });
});

describe("planFiles: files never copied by name", () => {
  it("refuses .env files and .netrc by name on rows without consent; a consent row answered copy and a login row's own .env copy", () => {
    const p = plan([
      row({ rung: "everything", id: "everything/.env", paths: ["~/.env"] }),
      row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"], consent: true, choice: "copy" }),
      row({ rung: "everything", id: "everything/.app/.env.local", paths: ["~/.app/.env.local"], consent: true, choice: "skip" }),
      row({ rung: "shell", id: "shell/app-env", paths: ["~/.app/.env.local"] }),
      row({ rung: "logins", id: "logins/hermes", paths: ["~/.hermes/.env"], choice: "copy" }),
    ]);
    expect(p.files.map(f => [f.dest, f.mode])).toEqual([[".netrc", 0o600], [".hermes/.env", 0o644]]);
    expect(p.skipped.map(s => [s.id, s.note])).toEqual([
      ["everything/.env", ".env files are never copied; set the values on the machine"],
      ["everything/.app/.env.local", "credential-shaped; not copied without your answer on its row"],
      ["shell/app-env", ".env files are never copied; set the values on the machine"],
    ]);
    expect(neverCopied(row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"] }), ".netrc", false)).toBe(".netrc is never copied; sign in on the machine");
    expect(neverCopied(row({ rung: "everything", id: "everything/.netrc", paths: ["~/.netrc"], consent: true, choice: "copy" }), ".netrc", false)).toBeUndefined();
  });

  it("the name rule is about files: a directory named .env (a Python environment) copies, and a missing .env is only missing", () => {
    const p = plan([row({ rung: "everything", id: "everything/proj/.env", paths: ["~/proj/.env"] }), row({ rung: "everything", id: "everything/.gone/.env", paths: ["~/.gone/.env"] })]);
    expect(p.files.map(f => [f.dest, f.dir])).toEqual([["proj/.env", true]]);
    expect(p.skipped).toEqual([{ id: "everything/.gone/.env", path: "~/.gone/.env", note: "no longer on this computer" }]);
    const bare = row({ rung: "everything", id: "everything/.env", paths: ["~/.env"] });
    expect(neverCopied(bare, ".env", false)).toBe(".env files are never copied; set the values on the machine");
    expect(neverCopied(bare, ".env", true)).toBeUndefined();
    expect(neverCopied(bare, ".env", undefined)).toBeUndefined();
  });
});

describe("planFiles: everything rows", () => {
  it("marks the planned paths a row calls volatile, and only those", () => {
    const p = plan([row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], volatile: ["~/.claude.json"] })], { rewrites: [[".claude/", ".claude-cfg/"], [".claude.json", ".claude-cfg/.claude.json"]] });
    expect(p.files.map(f => [f.dest, f.volatile])).toEqual([
      [".claude-cfg/settings.json", false],
      [".claude-cfg/.claude.json", true],
    ]);
  });

  it("carries a row's excludes as absolute paths under the copied source, and only those", () => {
    const p = plan([
      row({ rung: "everything", id: "everything/.config/demo", paths: ["~/.config/demo"], excludes: ["~/.config/demo/cache", "~/.other/thing"], bytes: 300 }),
      row({ rung: "everything", id: "everything/.zshrc", paths: ["~/.zshrc"] }),
    ]);
    expect(p.files.map(f => [f.dest, f.excludes])).toEqual([
      [".config/demo", [`${HOME}/.config/demo/cache`]],
      [".zshrc", []],
    ]);
    expect(p.rungs).toEqual({ everything: 2 });
    expect(p.skipped).toEqual([]);
  });

  it("a credential-shaped row ticked without copy as its answer is skipped with a note; with copy it is planned at its mode", () => {
    const withoutAnswer = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true })]);
    expect(withoutAnswer.files).toEqual([]);
    expect(withoutAnswer.skipped).toEqual([{ id: "everything/.demo-token", path: "~/.demo-token", note: "credential-shaped; not copied without your answer on its row" }]);
    const skip = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true, choice: "skip" })]);
    expect(skip.files).toEqual([]);
    expect(skip.skipped).toHaveLength(1);
    const machine = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true, choice: "machine" })]);
    expect(machine.files).toEqual([]);
    expect(machine.skipped.map(s => s.note)).toEqual(["credential-shaped; not copied without your answer on its row"]);
    const copy = plan([row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], consent: true, choice: "copy", bytes: 40 })]);
    expect(copy.files.map(f => [f.dest, f.mode])).toEqual([[".demo-token", 0o600]]);
    expect(copy.skipped).toEqual([]);
    expect(copy.bytes).toBe(40);
  });
});

describe("recipeDigest and recipeHash", () => {
  const zshrc = (digest = "d1") => ({ id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest });
  const hashOf = (entries: RecipeEntry[], files: DigestedFile[] = []) => recipeHash(recipeDigest(entries, files));

  it("the digest holds the ticked ids with their login answers and tool pins, and the planned files by path with their digest, each sorted", () => {
    const entries = [row({ rung: "tools", id: "tools/npm/bun", version: "1.4.0" }), row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/zshrc", bytes: 3 }), row({ rung: "shell", id: "shell/bashrc", bring: false })];
    const files = [{ id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" }, { id: "logins/gh", path: "~/.config/gh/hosts.yml", dest: ".config/gh/hosts.yml", digest: "d2" }];
    expect(recipeDigest(entries, files)).toEqual({
      ticks: [{ id: "logins/gh", choice: "copy" }, { id: "shell/zshrc" }, { id: "tools/npm/bun", version: "1.4.0" }],
      files: [{ id: "logins/gh", path: "~/.config/gh/hosts.yml", dest: ".config/gh/hosts.yml", digest: "d2" }, { id: "shell/zshrc", path: "~/.zshrc", dest: ".zshrc", digest: "d1" }],
    });
  });

  it("the hash depends on the ticked ids, login choices and tool pins, not on order, byte counts or labels", () => {
    const a = [row({ rung: "shell", id: "shell/zshrc", bytes: 1 }), row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/bashrc", bring: false })];
    const b = [row({ rung: "logins", id: "logins/gh", choice: "copy" }), row({ rung: "shell", id: "shell/zshrc", bytes: 99, label: "renamed" })];
    expect(hashOf(a)).toBe(hashOf(b));
    expect(hashOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf([row({ rung: "logins", id: "logins/gh", choice: "machine" }), row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(hashOf(a));
    expect(hashOf([row({ rung: "shell", id: "shell/zshrc" })])).not.toBe(hashOf(a));
    const bun = (version: string) => [row({ rung: "tools", id: "tools/npm/bun", label: `bun@${version}`, version })];
    expect(hashOf(bun("1.4.0"))).not.toBe(hashOf(bun("1.5.0")));
  });

  it("the login shell enters the digest once, off the ticked shell rows, and a change of it alone changes the hash", () => {
    const withLogin = (login?: string, bring = true) => [row({ rung: "identity", id: "identity/git-user" }), row({ rung: "shell", id: "shell/zshrc", bring, ...(login !== undefined ? { login } : {}) }), row({ rung: "shell", id: "shell/tmux", bring, ...(login !== undefined ? { login } : {}) })];
    expect(recipeDigest(withLogin("zsh"))).toMatchObject({ login: "zsh", ticks: [{ id: "identity/git-user" }, { id: "shell/tmux" }, { id: "shell/zshrc" }] });
    expect(recipeDigest(withLogin())).not.toHaveProperty("login");
    expect(hashOf(withLogin("zsh"))).not.toBe(hashOf(withLogin("fish")));
    expect(hashOf(withLogin("zsh"))).not.toBe(hashOf(withLogin()));
    // With no shell row ticked the login shell decides nothing on the machine, so it stays out.
    expect(recipeDigest(withLogin("zsh", false))).not.toHaveProperty("login");
    expect(hashOf(withLogin("zsh", false))).toBe(hashOf(withLogin("fish", false)));
  });

  it("a terminal font row changes nothing on the machine, so its tick stays out of the digest and the hash", () => {
    const zsh = row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"], bytes: 10 });
    const font = (bring: boolean, family: string) => row({ rung: "shell", id: "shell/terminal-font", label: `terminal font: ${family} (Ghostty)`, bring, font: family });
    const zshAlone = "097e8d1cc07133686c458c3dfd579fe46f30dabc418bdb578af6be6616dfeafd";
    expect(hashOf([zsh])).toBe(zshAlone);
    expect(hashOf([zsh, font(true, "Hack")])).toBe(zshAlone);
    expect(hashOf([zsh, font(true, "Menlo")])).toBe(zshAlone);
    expect(hashOf([zsh, font(false, "Hack")])).toBe(zshAlone);
    expect(recipeDigest([zsh, font(true, "Hack")]).ticks).toEqual([{ id: "shell/zshrc" }]);
  });

  it("a volatile file is in the digest, marked, and never in the hash, whatever its bytes; the same file not volatile is", () => {
    const rows = [row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], volatile: ["~/.claude.json"] })];
    const settings = { id: "agents/claude", path: "~/.claude/settings.json", dest: ".claude-cfg/settings.json", digest: "s1" };
    const state = (digest: string, volatile = true) => ({ id: "agents/claude", path: "~/.claude.json", dest: ".claude-cfg/.claude.json", digest, volatile });
    expect(recipeDigest(rows, [settings, state("c1")]).files).toEqual([{ ...state("c1"), volatile: true }, settings]);
    expect(recipeDigest(rows, [settings, state("c1", false)]).files).toEqual([{ id: "agents/claude", path: "~/.claude.json", dest: ".claude-cfg/.claude.json", digest: "c1" }, settings]);
    expect(hashOf(rows, [settings, state("c1")])).toBe(hashOf(rows, [settings, state("c2")]));
    expect(hashOf(rows, [settings, state("c1")])).toBe(hashOf(rows, [settings]));
    expect(hashOf(rows, [settings, state("c1", false)])).not.toBe(hashOf(rows, [settings, state("c2", false)]));
    expect(hashOf(rows, [{ ...settings, digest: "s2" }, state("c1")])).not.toBe(hashOf(rows, [settings, state("c1")]));
  });

  it("the hash follows a planned file's digest, path and where it lands, in any order, and nothing about the disk", () => {
    const rows = [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"] })];
    const git = { id: "identity/git-user", path: "~/.gitconfig", dest: ".gitconfig", digest: "g1" };
    expect(hashOf(rows, [zshrc(), git])).toBe(hashOf(rows, [git, zshrc()]));
    expect(hashOf(rows, [zshrc(), git])).not.toBe(hashOf(rows, [zshrc("d2"), git]));
    expect(hashOf(rows, [zshrc(), git])).not.toBe(hashOf(rows, [zshrc(), { ...git, dest: ".config/git/config" }]));
    expect(hashOf(rows, [zshrc(), git])).not.toBe(hashOf(rows, [zshrc()]));
    expect(hashOf(rows, [zshrc()])).not.toBe(hashOf(rows));
    // A digest read back from a store hashes the same as the one just computed, whatever its key order.
    const stored = JSON.parse(JSON.stringify(recipeDigest(rows, [git, zshrc()]))) as RecipeDigest;
    expect(recipeHash({ files: stored.files.map(f => ({ digest: f.digest, dest: f.dest, path: f.path, id: f.id })), ticks: stored.ticks })).toBe(hashOf(rows, [zshrc(), git]));
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

  it("a hand-installed row is no install: a locked row is noted as skipped with its own reason, a copied script is neither installed nor skipped here", () => {
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/hand/omp", linux: "no", default: "skip", reason: "installed by hand; no Linux build known" }),
      row({ rung: "tools", id: "tools/hand/blob", linux: "no", default: "skip", reason: "installed by hand; no recognised format" }),
      row({ rung: "tools", id: "tools/hand/deploy", paths: ["~/.local/bin/deploy"], bytes: 18, linux: "unknown" }),
    ]);
    expect(t.installs).toEqual([]);
    expect(t.skipped).toEqual([{ id: "tools/hand/omp", note: "installed by hand; no Linux build known" }, { id: "tools/hand/blob", note: "installed by hand; no recognised format" }]);
    expect(toolUninstall(row({ rung: "tools", id: "tools/hand/deploy" }))).toEqual({ note: "a copied file; it comes off with the files" });
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
      row({ rung: "tools", id: "tools/cargo/bat", label: "bat 0.24.0", version: "0.24.0" }),
      row({ rung: "tools", id: "tools/brew/mas", linux: "no" }),
      row({ rung: "tools", id: "tools/go/junk", label: "junk (no module info)" }),
    ]);
    expect(t.installs.map(i => [i.id, i.manager, i.after])).toEqual([
      ["tools/homebrew", "brew", undefined],
      // Homebrew's own glibc then gcc, each its own brew process, before any formula (the 6.0.21 lock race).
      ["tools/brew-toolchain/glibc", "brew", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "brew", "tools/brew-toolchain/glibc"],
      ["tools/brew-tap/zingzy/tap", "brew", "tools/brew-toolchain/gcc"],
      // What two or more of the formulae (gh and the managers' pipx, rust, go) share installs once, after the taps it may need.
      ["tools/brew-shared", "brew", "tools/brew-toolchain/gcc"],
      ["tools/brew/gh", "brew", "tools/brew-toolchain/gcc"],
      ["tools/npm/bun", "npm", undefined],
      ["tools/npm/@monid-ai/cli", "npm", undefined],
      // bun came as an npm global, so its rows wait on that line rather than on a formula; pnpm and uv are the base's, so their rows wait on nothing.
      ["tools/pnpm/turbo", "pnpm", undefined],
      ["tools/bun/eslint", "bun", "tools/npm/bun"],
      ["tools/uv/ty", "uv", undefined],
      ["tools/manager/pipx", "brew", "tools/brew-toolchain/gcc"],
      ["tools/pipx/black", "pipx", "tools/manager/pipx"],
      ["tools/manager/cargo", "brew", "tools/brew-toolchain/gcc"],
      ["tools/cargo/bat", "cargo", "tools/manager/cargo"],
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
    const shared = cmd("tools/brew-shared");
    expect(shared).toMatch(/su -s \/bin\/bash linuxbrew -c 'export HOMEBREW_NO_AUTO_UPDATE=1 .*NONINTERACTIVE=1\n/);
    expect(shared).toContain(`brew deps --for-each '\\''gh'\\'' '\\''pipx'\\'' '\\''rust'\\'' '\\''go'\\'' | sed`);
    // Homebrew's own toolchain is never in the shared set: it installed before, on request, and stays that way.
    expect(shared).toContain(`grep -vx -e '\\'''\\'' -e glibc -e gcc | sort | uniq -d`);
    expect(shared).toContain("brew install $shared; rc=$?");
    // Installed as dependencies, so autoremove takes them with the formula that fails or leaves.
    expect(shared).toContain("brew tab --no-installed-on-request $shared || true\nexit $rc");
    // Homebrew cleans after each install; one recipe with it off left 2.6 GB of bottles on a 20 GB disk.
    for (const i of t.installs) expect(i.cmd).not.toContain("HOMEBREW_NO_INSTALL_CLEANUP");
    expect(cmd("tools/npm/bun")).toMatch(/npm install -g bun@1\.4\.0$/);
    expect(cmd("tools/npm/@monid-ai/cli")).toMatch(/npm install -g @monid-ai\/cli@0\.3\.1$/);
    expect(cmd("tools/pnpm/turbo")).toMatch(/pnpm add -g turbo@2\.5\.0$/);
    expect(cmd("tools/bun/eslint")).toMatch(/bun add -g eslint@9\.0\.0$/);
    expect(cmd("tools/uv/ty")).toMatch(/uv tool install ty==0\.0\.56$/);
    expect(cmd("tools/manager/pipx")).toMatch(/brew install pipx'$/);
    expect(cmd("tools/pipx/black")).toMatch(/pipx install black==24\.1\.0$/);
    expect(cmd("tools/manager/cargo")).toMatch(/brew install rust'$/);
    expect(cmd("tools/cargo/bat")).toMatch(/cargo install bat --version 0\.24\.0$/);
    expect(cmd("tools/manager/go")).toMatch(/brew install go'$/);
    expect(cmd("tools/go/sqlc")).toMatch(/go install github\.com\/sqlc-dev\/sqlc\/cmd\/sqlc@v1\.31\.1$/);
    for (const i of t.installs) expect(i.cmd).toMatch(/^export PATH=.*PNPM_HOME=/);
    expect(t.skipped).toEqual([
      { id: "tools/brew/mas", note: "no Linux bottle" },
      { id: "tools/go/junk", note: "no module to install from" },
    ]);
    expect(t.base).toEqual([{ id: "tools/npm/pnpm", name: "pnpm", note: "pnpm is part of the base" }]);
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
      row({ rung: "tools", id: "tools/brew/bun", linux: "yes" }),
      row({ rung: "tools", id: "tools/bun/elysia", label: "elysia" }),
      row({ rung: "tools", id: "tools/uv/ty", label: "ty" }),
    ]);
    expect(t.installs.map(i => [i.id, i.after])).toEqual([
      ["tools/homebrew", undefined],
      ["tools/brew-toolchain/glibc", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "tools/brew-toolchain/glibc"],
      ["tools/brew/bun", "tools/brew-toolchain/gcc"],
      ["tools/bun/elysia", "tools/brew/bun"],
      ["tools/uv/ty", undefined],
    ]);
    expect(t.installs.find(i => i.id === "tools/bun/elysia")!.cmd).toMatch(/bun add -g elysia$/);
    expect(t.installs.find(i => i.id === "tools/uv/ty")!.cmd).toMatch(/uv tool install ty$/);
  });

  it("rows the base floor covers install nothing and are listed as the base's, whatever road the Mac had them by; a hand copy still travels", () => {
    // Homebrew's node is the current major and its python the current 3.x: the Mac's versions come from the brew table.
    const table: BrewTable = new Map([
      ["node", { name: "node", fullName: "node", deps: [], macosOnly: false, version: "24.1.0" }],
      ["python", { name: "python", fullName: "python", deps: [], macosOnly: false, version: "3.14.0" }],
      ["python@3.12", { name: "python@3.12", fullName: "python@3.12", deps: [], macosOnly: false, version: "3.12.7" }],
    ]);
    const t = toolInstallsFor([
      row({ rung: "tools", id: "tools/brew/jq", linux: "yes" }),
      row({ rung: "tools", id: "tools/npm/pnpm", label: "pnpm", version: "10.0.0" }),
      row({ rung: "tools", id: "tools/brew/python@3.12", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/node", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/python", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/uv", linux: "yes" }),
      row({ rung: "tools", id: "tools/cargo/ripgrep", label: "ripgrep", version: "14.1.0" }),
      row({ rung: "tools", id: "tools/brew-cask/docker", linux: "no" }),
      row({ rung: "tools", id: "tools/brew/docker-compose", linux: "yes" }),
      row({ rung: "tools", id: "tools/brew/python@3.14", linux: "yes" }),
      row({ rung: "tools", id: "tools/hand/jq", label: "jq", paths: ["~/.local/bin/jq"], linux: "yes" }),
    ], table);
    expect(t.base).toEqual([
      { id: "tools/brew/jq", name: "jq", note: "jq is part of the base" },
      { id: "tools/npm/pnpm", name: "pnpm", note: "pnpm is part of the base" },
      { id: "tools/brew/python@3.12", name: "Python 3.12", note: "Python 3.12 is part of the base" },
      { id: "tools/brew/node", name: "Node 22 with npm", note: "Node 22 is part of the base; this Mac runs Node 24" },
      { id: "tools/brew/python", name: "Python 3.12", note: "Python 3.12 is part of the base; this Mac runs Python 3.14" },
      { id: "tools/brew/uv", name: "uv", note: "uv is part of the base" },
      { id: "tools/cargo/ripgrep", name: "ripgrep", note: "ripgrep is part of the base" },
      { id: "tools/brew-cask/docker", name: "Docker engine and compose", note: "Docker engine and compose is part of the base" },
      { id: "tools/brew/docker-compose", name: "Docker engine and compose", note: "Docker engine and compose is part of the base" },
    ]);
    // A row with no table entry and no version says the base row alone; a versioned row on the floor's major does too.
    expect(toolInstallsFor([row({ rung: "tools", id: "tools/brew/node", linux: "yes" })]).base[0]!.note).toBe("Node 22 with npm is part of the base");
    expect(toolInstallsFor([row({ rung: "tools", id: "tools/npm/node", label: "node", version: "22.20.0" })]).base[0]!.note).toBe("Node 22 with npm is part of the base");
    expect(t.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/python@3.14"]);
    expect(t.skipped).toEqual([]);
    expect(t.brewfile).toBe('brew "python@3.14"\n');
    expect(toolUninstall(row({ rung: "tools", id: "tools/brew/jq" }))).toEqual({ note: "jq is part of the base and stays" });
    expect(toolUninstall(row({ rung: "tools", id: "tools/hand/jq" }))).toEqual({ note: "a copied file; it comes off with the files" });
  });

  it("one formula has nothing to share, so no shared step; two get one between the taps and the first formula", () => {
    const one = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" })]);
    expect(one.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/gh"]);
    const two = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }), row({ rung: "tools", id: "tools/brew/yq", linux: "yes" }), row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" })]);
    expect(two.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew-tap/zingzy/tap", "tools/brew-shared", "tools/brew/gh", "tools/brew/yq"]);
    expect(two.installs.find(i => i.id === "tools/brew-shared")).toMatchObject({ label: "shared Homebrew dependencies", after: "tools/brew-toolchain/gcc" });
    expect(two.installs.find(i => i.id === "tools/brew-shared")!.cmd).toContain(`brew deps --for-each '\\''gh'\\'' '\\''yq'\\'' |`);
  });

  it("the housekeeping after the loop is autoremove then a full cleanup, each as linuxbrew with the tools PATH", () => {
    expect(BREW_HOUSEKEEPING).toHaveLength(2);
    expect(BREW_HOUSEKEEPING[0]).toMatch(/^export PATH=\/root\/\.local\/bin:.*\nsu -s \/bin\/bash linuxbrew -c '.*brew autoremove'$/);
    expect(BREW_HOUSEKEEPING[1]).toMatch(/\nsu -s \/bin\/bash linuxbrew -c '.*brew cleanup -s --prune=all'$/);
  });

  it("a manager needed only for its rows brings Homebrew along even when no formula is ticked", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/cargo/bat", label: "bat 0.24.0", version: "0.24.0" })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/manager/cargo", "tools/cargo/bat"]);
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

describe("catalog rows", () => {
  const catalog = (id: string, over: Partial<RecipeEntry> = {}) => row({ rung: "tools", id: `${CATALOG_PREFIX}${id}`, label: catalogEntry(id)?.name ?? id, linux: "yes", ...over });

  it("a ticked catalog tool this computer has no row for installs by its catalog road, named for its command; a road no golden build has run is noted", () => {
    const t = toolInstallsFor([catalog("gh"), catalog("wrangler"), catalog("ffmpeg"), catalog("kubectl"), catalog("gcloud"), catalog("tmux")]);
    expect(t.installs.map(i => [i.id, i.manager, i.after, i.bin, i.note])).toEqual([
      ["tools/catalog/wrangler", "npm", undefined, "wrangler", UNMEASURED_ROAD],
      ["tools/catalog/gh", "release", undefined, "gh", UNMEASURED_ROAD],
      ["tools/apt-index", "apt", undefined, undefined, undefined],
      ["tools/catalog/ffmpeg", "apt", "tools/apt-index", "ffmpeg", UNMEASURED_ROAD],
      ["tools/catalog/kubectl", "vendor", undefined, "kubectl", UNMEASURED_ROAD],
      ["tools/catalog/gcloud", "vendor", undefined, "gcloud", undefined],
      ["tools/catalog/tmux", "apt", "tools/apt-index", "tmux", UNMEASURED_ROAD],
    ]);
    const cmd = (id: string) => t.installs.find(i => i.id === id)!.cmd;
    for (const i of t.installs) expect(i.cmd).toMatch(/^export PATH=.*PNPM_HOME=/);
    expect(cmd("tools/catalog/wrangler")).toMatch(/\nnpm install -g wrangler$/);
    expect(cmd("tools/catalog/gh")).toContain("'https://api.github.com/repos/cli/cli/releases/latest'");
    expect(cmd("tools/catalog/gh")).toContain("name='gh'");
    expect(cmd("tools/apt-index")).toMatch(/\nexport DEBIAN_FRONTEND=noninteractive\napt-get update -qq$/);
    expect(cmd("tools/catalog/ffmpeg")).toMatch(/\napt-get install -y -qq ffmpeg$/);
    expect(cmd("tools/catalog/kubectl")).toBe(`${PATH_LINE}\n${KUBECTL.install(undefined, undefined)}`);
    expect(t.installs.some(i => i.id === "tools/homebrew")).toBe(false);
    expect(t.skipped).toEqual([]);
    expect(t.base).toEqual([]);
  });

  it("a catalog tool on the Homebrew road brings Homebrew and its toolchain along, waits on them, and shares dependencies with the formulae ticked; a road a golden build has run carries no note", () => {
    const t = toolInstallsFor([catalog("go"), row({ rung: "tools", id: "tools/brew/yq", linux: "yes" })]);
    expect(t.installs.map(i => [i.id, i.after])).toEqual([
      ["tools/homebrew", undefined],
      ["tools/brew-toolchain/glibc", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "tools/brew-toolchain/glibc"],
      ["tools/brew-shared", "tools/brew-toolchain/gcc"],
      ["tools/brew/yq", "tools/brew-toolchain/gcc"],
      ["tools/catalog/go", "tools/brew-toolchain/gcc"],
    ]);
    expect(t.installs.find(i => i.id === "tools/brew-shared")!.cmd).toContain(`brew deps --for-each '\\''yq'\\'' '\\''go'\\'' |`);
    expect(t.installs.at(-1)).toMatchObject({ id: "tools/catalog/go", label: "Go", manager: "brew", bin: "go" });
    expect(t.installs.at(-1)!.cmd).toMatch(/brew install go'$/);
    expect(t.installs.at(-1)).not.toHaveProperty("note");
    // Homebrew's own bootstrap comes along for a catalog formula alone, as it does for a manager's.
    expect(toolInstallsFor([catalog("rust")]).installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/catalog/rust"]);
  });

  it("a catalog tool the floor carries is the base's, an id the catalog does not know is skipped, and a row this computer has keeps its own road at the laptop's version", () => {
    const t = toolInstallsFor([catalog("git"), catalog("nothing", { label: "nothing" }), row({ rung: "tools", id: "tools/npm/wrangler", label: "wrangler", version: "4.1.0" })]);
    expect(t.base).toEqual([{ id: "tools/catalog/git", name: "git", note: "git is part of the base" }]);
    expect(t.skipped).toEqual([{ id: "tools/catalog/nothing", note: "not in the catalog" }]);
    expect(t.installs.map(i => [i.id, i.manager, i.note])).toEqual([["tools/npm/wrangler", "npm", undefined]]);
    expect(t.installs[0]!.cmd).toMatch(/\nnpm install -g wrangler@4\.1\.0$/);
  });

  it("a catalog tool comes off through the same module: the release binary, the formula, the apt package, the npm global, the vendor's tree", () => {
    expect(toolUninstall(catalog("gh"))).toEqual({ cmd: `${PATH_LINE}\nrm -f /usr/local/bin/'gh'` });
    expect(toolUninstall(catalog("go"))).toEqual({ cmd: expect.stringMatching(/brew uninstall go'$/) });
    expect(toolUninstall(catalog("ffmpeg"))).toEqual({ cmd: `${PATH_LINE}\nexport DEBIAN_FRONTEND=noninteractive\napt-get purge -y -qq ffmpeg && apt-get autoremove -y -qq --purge` });
    expect(toolUninstall(catalog("wrangler"))).toEqual({ cmd: `${PATH_LINE}\nnpm uninstall -g wrangler` });
    expect(toolUninstall(catalog("gcloud"))).toEqual({ cmd: expect.stringContaining("rm -rf /opt/google-cloud-sdk") });
    expect(toolUninstall(catalog("git"))).toEqual({ note: "git is part of the base and stays" });
    expect(toolUninstall(catalog("nothing"))).toEqual({ note: "no manager known for this row" });
  });

  it("a catalog go row beside go rows is the manager's step: go installs once, the go rows wait on the catalog row, and no manager step is planned", () => {
    const t = toolInstallsFor([catalog("go"), row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"] })]);
    expect(t.installs.map(i => [i.id, i.after])).toEqual([
      ["tools/homebrew", undefined],
      ["tools/brew-toolchain/glibc", "tools/homebrew"],
      ["tools/brew-toolchain/gcc", "tools/brew-toolchain/glibc"],
      ["tools/catalog/go", "tools/brew-toolchain/gcc"],
      ["tools/go/gopls", "tools/catalog/go"],
    ]);
    expect(t.installs.filter(i => /brew install go'$/.test(i.cmd))).toHaveLength(1);
    expect(t.installs.at(-1)!.cmd).toMatch(/\ngo install golang\.org\/x\/tools\/gopls@v0\.16\.2$/);
  });

  it("a catalog row's version is the install's where the road pins one; where the road cannot, the note says what it installed instead", () => {
    const t = toolInstallsFor([catalog("wrangler", { version: "4.1.0" }), catalog("gh", { version: "v2.86.0" }), catalog("tmux", { version: "3.5a" })]);
    const get = (id: string) => t.installs.find(i => i.id === id)!;
    expect(get("tools/catalog/wrangler").cmd).toMatch(/\nnpm install -g wrangler@4\.1\.0$/);
    expect(get("tools/catalog/wrangler").note).toBe(UNMEASURED_ROAD);
    expect(get("tools/catalog/gh").cmd).toContain("'https://api.github.com/repos/cli/cli/releases/tags/v2.86.0'");
    expect(get("tools/catalog/gh").cmd).not.toContain('[ "$sum" =');
    expect(get("tools/catalog/tmux").cmd).toMatch(/\napt-get install -y -qq tmux$/);
    expect(get("tools/catalog/tmux").note).toBe(`${UNMEASURED_ROAD}; 3.5a asked, installed by apt at its current version`);
  });

  it("a bare row keeps the tag and checksum its first install recorded: the release fetches that tag and checks the sum, and so does the vendor's download", () => {
    const t = toolInstallsFor([catalog("gh", { pin: { tag: "v2.86.0", sha256: "d".repeat(64) } }), catalog("kubectl", { pin: { tag: "v1.37.0", sha256: "e".repeat(64) } })]);
    const gh = t.installs.find(i => i.id === "tools/catalog/gh")!.cmd;
    expect(gh).toContain("'https://api.github.com/repos/cli/cli/releases/tags/v2.86.0'");
    expect(gh).not.toContain("releases/latest");
    expect(gh).toContain(`[ "$sum" = '${"d".repeat(64)}' ]`);
    expect(t.installs.find(i => i.id === "tools/catalog/kubectl")!.cmd).toBe(`${PATH_LINE}\n${KUBECTL.install(undefined, { tag: "v1.37.0", sha256: "e".repeat(64) })}`);
  });
});

describe("command-line tool rows", () => {
  const spoo = row({ rung: "tools", id: "tools/cli/spoo", label: "spoo", paths: ["github.com/spoo-me/spoo-cli@v0.4.1", "github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0"], version: "0.4.1" });

  it("a CLI row takes the road: the release named by its first path, the module in its last path as the go fallback; one with no release is skipped", () => {
    const b = brewfileFor([spoo, row({ rung: "tools", id: "tools/cli/ngrok", label: "ngrok" })]);
    expect(b.roads).toEqual([{ id: "tools/cli/spoo", name: "spoo", source: { repo: "spoo-me/spoo-cli", tag: "v0.4.1" }, go: "github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0" }]);
    expect(b.skipped).toEqual([{ id: "tools/cli/ngrok", note: "no GitHub release to install from" }]);
    expect(b.text).toBe("");
  });

  it("the install fetches the release's Linux asset first and falls back to go install of the module; the command's name is on the step for the check after the stage", () => {
    const t = toolInstallsFor([spoo, row({ rung: "tools", id: "tools/go/gopls", label: "gopls", paths: ["golang.org/x/tools/gopls@v0.16.2"], version: "v0.16.2" })]);
    const step = t.installs.at(-1)!;
    expect(step).toMatchObject({ id: "tools/cli/spoo", label: "spoo", manager: "release", bin: "spoo" });
    expect(step.after).toBeUndefined();
    expect(step.cmd).toContain("https://api.github.com/repos/spoo-me/spoo-cli/releases/tags/v0.4.1");
    expect(step.cmd).toContain('install -m 0755 "$bin" "/usr/local/bin/$name"');
    expect(step.cmd).toContain("GOBIN=/usr/local/bin go install 'github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0'");
    expect(step.cmd).not.toContain('[ "$sum" =');
    // A Go row names its binary too; a formula does not, its command rarely being its name.
    expect(t.installs.find(i => i.id === "tools/go/gopls")).toMatchObject({ bin: "gopls" });
    expect(t.installs.find(i => i.id === "tools/manager/go")).not.toHaveProperty("bin");
    expect(t.installs.map(i => i.id).indexOf("tools/cli/spoo")).toBeGreaterThan(t.installs.map(i => i.id).indexOf("tools/go/gopls"));
  });

  it("a pin for the same tag is checked; one for another tag is not; a row with one path installs the repository itself with go", () => {
    const pinned = toolInstallsFor([{ ...spoo, pin: { tag: "v0.4.1", sha256: "c".repeat(64) } }]).installs.at(-1)!;
    expect(pinned.cmd).toContain(`[ "$sum" = '${"c".repeat(64)}' ]`);
    const moved = toolInstallsFor([{ ...spoo, pin: { tag: "v0.4.0", sha256: "c".repeat(64) } }]).installs.at(-1)!;
    expect(moved.cmd).not.toContain('[ "$sum" =');
    const alone = toolInstallsFor([{ ...spoo, paths: ["github.com/spoo-me/spoo-cli@v0.4.1"] }]).installs.at(-1)!;
    expect(alone.cmd).toContain("go install 'github.com/spoo-me/spoo-cli@v0.4.1'");
  });

  it("a tap formula on the road names its binary too", () => {
    const table: BrewTable = new Map([["zingzy/tap/diskbloom", { name: "diskbloom", fullName: "zingzy/tap/diskbloom", deps: [], macosOnly: false, source: { repo: "Zingzy/diskbloom", tag: "v0.1.0" } }]]);
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "diskbloom", linux: "unknown" })], table);
    expect(t.installs.at(-1)).toMatchObject({ id: "tools/brew/zingzy/tap/diskbloom", manager: "release", bin: "diskbloom" });
    expect(t.installs.at(-1)!.cmd).not.toContain("mv '/usr/local/bin/");
  });

  it("the go fallback lands under the row's command: a module whose last element is another name is moved there, on a CLI row and a tap road alike; a /vN module suffix is not the name", () => {
    const alone = toolInstallsFor([{ ...spoo, paths: ["github.com/spoo-me/spoo-cli@v0.4.1"] }]).installs.at(-1)!;
    expect(alone.cmd).toContain(`GOBIN=/usr/local/bin go install 'github.com/spoo-me/spoo-cli@v0.4.1'\n  mv '/usr/local/bin/spoo-cli' "/usr/local/bin/$name"\n  echo "WSP_ROAD go "`);
    const folded = toolInstallsFor([spoo]).installs.at(-1)!;
    expect(folded.cmd).toContain(`go install 'github.com/spoo-me/spoo-cli/cmd/spoo@v0.3.0'\n  echo "WSP_ROAD go "`);
    expect(folded.cmd).not.toContain("mv '/usr/local/bin/");
    const v2 = toolInstallsFor([{ ...spoo, paths: ["github.com/spoo-me/spoo-cli@v2.0.0", "github.com/spoo-me/spoo/v2@v2.0.0"] }]).installs.at(-1)!;
    expect(v2.cmd).not.toContain("mv '/usr/local/bin/");
    const table: BrewTable = new Map([["spoo-me/tap/spoo", { name: "spoo", fullName: "spoo-me/tap/spoo", deps: [], macosOnly: false, source: { repo: "spoo-me/spoo-cli", tag: "v0.4.1" } }]]);
    const tap = toolInstallsFor([row({ rung: "tools", id: "tools/brew/spoo-me/tap/spoo", label: "spoo", linux: "unknown" })], table).installs.at(-1)!;
    expect(tap).toMatchObject({ manager: "release", bin: "spoo" });
    expect(tap.cmd).toContain(`mv '/usr/local/bin/spoo-cli' "/usr/local/bin/$name"`);
  });
});

describe("editorInstallsFor", () => {
  it("installs each ticked terminal editor: apt for neovim, vim and emacs, helix from its pinned release; unticked rows and config-only rows add nothing", () => {
    const t = editorInstallsFor([
      row({ rung: "editors", id: "editors/nvim", label: "neovim, installed with your config", paths: ["~/.config/nvim"] }),
      row({ rung: "editors", id: "editors/helix", label: "helix, installed" }),
      row({ rung: "editors", id: "editors/vim", label: "vim, installed with your config", paths: ["~/.vimrc"], bring: false }),
      row({ rung: "editors", id: "editors/emacs", label: "emacs, installed with your config", paths: ["~/.emacs.d/init.el"] }),
      row({ rung: "editors", id: "editors/vscode", label: "VS Code settings, for VS Code over SSH", paths: ["~/.config/Code/User/settings.json"] }),
    ]);
    expect(t.installs.map(i => [i.id, i.label, i.manager])).toEqual([
      ["editors/nvim", "neovim", "apt"],
      ["editors/helix", "helix", "release"],
      ["editors/emacs", "emacs", "apt"],
    ]);
    const cmd = (id: string) => t.installs.find(i => i.id === id)!.cmd;
    expect(cmd("editors/nvim")).toContain("command -v nvim >/dev/null 2>&1 ||");
    expect(cmd("editors/nvim")).toContain("apt-get install -y -qq neovim");
    expect(cmd("editors/emacs")).toContain("apt-get install -y -qq emacs-nox");
    // Helix ships as a tarball with its runtime beside the binary, so it is unpacked whole and linked onto PATH.
    expect(cmd("editors/helix")).toContain(`https://github.com/helix-editor/helix/releases/download/${HELIX.version}/$pkg`);
    expect(cmd("editors/helix")).toContain(`x86_64) pkg=helix-${HELIX.version}-x86_64-linux.tar.xz sha=${HELIX.sha256.x86_64}`);
    expect(cmd("editors/helix")).toContain(`aarch64) pkg=helix-${HELIX.version}-aarch64-linux.tar.xz sha=${HELIX.sha256.aarch64}`);
    expect(cmd("editors/helix")).toContain("sha256sum -c -");
    expect(cmd("editors/helix")).toContain("ln -sfn /opt/helix/hx /usr/local/bin/hx");
    for (const i of t.installs) {
      expect(i.cmd).toContain("set -euo pipefail");
      expect(i.cmd).not.toMatch(/curl[^\n]*\|\s*(ba)?sh/);
    }
  });

  it("the ticked extensions of each remote editor are written as one list file for the person to apply from the editor's terminal", () => {
    const t = editorInstallsFor([
      row({ rung: "editors", id: "editors/vscode-ext/ms-python.python", label: "ms-python.python" }),
      row({ rung: "editors", id: "editors/vscode-ext/esbenp.prettier-vscode", label: "esbenp.prettier-vscode" }),
      row({ rung: "editors", id: "editors/vscode-ext/left.out", label: "left.out", bring: false }),
      row({ rung: "editors", id: "editors/cursor-ext/anysphere.cursorpyright", label: "anysphere.cursorpyright" }),
    ]);
    expect(t.installs.map(i => [i.id, i.label, i.manager])).toEqual([
      ["editors/vscode-ext", "VS Code extension list", "script"],
      ["editors/cursor-ext", "Cursor extension list", "script"],
    ]);
    const vscode = t.installs[0]!.cmd;
    expect(vscode).toContain(`mkdir -p "$HOME/.vscode-server"`);
    expect(vscode).toContain(`printf '%s\\n' 'ms-python.python' 'esbenp.prettier-vscode' > "$HOME/${extensionsFile(".vscode-server")}"`);
    expect(vscode).not.toContain("left.out");
    expect(t.installs[1]!.cmd).toContain(`'anysphere.cursorpyright' > "$HOME/.cursor-server/extensions.txt"`);
    expect(remoteEditorFor("editors/cursor-ext/anysphere.cursorpyright")).toEqual({ name: "Cursor", dir: ".cursor-server", cli: "cursor" });
    expect(remoteEditorFor("editors/vscode")).toEqual({ name: "VS Code", dir: ".vscode-server", cli: "code" });
    expect(remoteEditorFor("editors/nvim")).toBeUndefined();
  });

  it("VS Code Insiders has its own server directory; Zed's row is its files alone, no server writes anything for it", () => {
    const insiders = { name: "VS Code Insiders", dir: ".vscode-server-insiders", cli: "code-insiders" };
    expect(remoteEditorFor("editors/vscode-insiders")).toEqual(insiders);
    expect(remoteEditorFor("editors/vscode-insiders-ext")).toEqual(insiders);
    expect(remoteEditorFor("editors/vscode-insiders-ext/ms-python.python")).toEqual(insiders);
    expect(remoteEditorFor("editors/zed")).toBeUndefined();
    const t = editorInstallsFor([
      row({ rung: "editors", id: "editors/vscode-insiders-ext/ms-python.python", label: "ms-python.python" }),
      row({ rung: "editors", id: "editors/vscode-ext/esbenp.prettier-vscode", label: "esbenp.prettier-vscode" }),
      row({ rung: "editors", id: "editors/zed", label: "Zed settings, for Zed over SSH", paths: ["~/.config/zed"] }),
    ]);
    expect(t.installs.map(i => [i.id, i.label])).toEqual([
      ["editors/vscode-ext", "VS Code extension list"],
      ["editors/vscode-insiders-ext", "VS Code Insiders extension list"],
    ]);
    expect(t.installs[1]!.cmd).toContain(`printf '%s\\n' 'ms-python.python' > "$HOME/.vscode-server-insiders/extensions.txt"`);
    expect(t.installs[0]!.cmd).not.toContain("ms-python.python");
  });

  it("an extension id that is not publisher.name is left out of the list rather than run", () => {
    const t = editorInstallsFor([row({ rung: "editors", id: "editors/vscode-ext/$(rm -rf /)", label: "odd" }), row({ rung: "editors", id: "editors/vscode-ext/ok.ext", label: "ok.ext" })]);
    expect(t.installs).toHaveLength(1);
    expect(t.installs[0]!.cmd).toContain("'ok.ext'");
    expect(t.installs[0]!.cmd).not.toContain("rm -rf");
    expect(t.skipped).toEqual([{ id: "editors/vscode-ext/$(rm -rf /)", note: "not an extension id" }]);
  });

  it("with nothing ticked there is nothing to install", () => {
    expect(editorInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" })])).toEqual({ installs: [], skipped: [] });
  });
});

describe("agentOwning", () => {
  it("names the agent whose installer brings an npm or uv package the tools rung would list again; other rows and the git or curl installers own nothing", () => {
    expect(agentOwning("tools/npm/@earendil-works/pi-coding-agent")).toBe("pi");
    expect(agentOwning("tools/npm/@openai/codex")).toBe("codex");
    expect(agentOwning("tools/npm/@google/gemini-cli")).toBe("gemini");
    expect(agentOwning("tools/npm/opencode-ai")).toBe("opencode");
    expect(agentOwning("tools/uv/aider-chat")).toBe("aider");
    expect(agentOwning("tools/npm/wrangler")).toBeUndefined();
    expect(agentOwning("tools/pnpm/@openai/codex")).toBeUndefined();
    expect(agentOwning("tools/npm/hermes")).toBeUndefined();
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

describe("shellInstallFor", () => {
  const shell = (id: string, over: Partial<RecipeEntry> = {}) => row({ rung: "shell", id: `shell/${id}`, paths: [`~/.${id}`], ...over });

  it("zsh's rc files ticked: one apt line for zsh, the ticked frameworks fetched at their pinned commits, then chsh for the uid, all under set -e", () => {
    const plan = shellInstallFor([shell("zshrc"), shell("oh-my-zsh", { paths: ["~/.oh-my-zsh/custom"] }), shell("antidote", { paths: ["~/.zsh_plugins.txt"] }), shell("zinit", { bring: false }), row({ rung: "tools", id: "tools/brew/zsh" })]);
    expect(plan).toMatchObject({ shell: "zsh", frameworks: ["shell/oh-my-zsh", "shell/antidote"] });
    const s = plan!.cmd;
    expect(s.startsWith("set -euo pipefail")).toBe(true);
    expect(s).toContain('export HOME="${HOME:-');
    expect(s).toContain("command -v zsh >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq zsh; }");
    const omz = SHELL_FRAMEWORKS["shell/oh-my-zsh"]!;
    expect(s).toContain(`git -C "$HOME/.oh-my-zsh" fetch -q --depth 1 origin ${omz.commit}`);
    expect(s).toContain(`test "$(git -C "$HOME/.oh-my-zsh" rev-parse HEAD)" = "${omz.commit}"`);
    expect(s).toContain('git -C "$HOME/.antidote" fetch -q --depth 1 origin ');
    expect(s).not.toContain("zinit");
    expect(s).not.toContain("zplug");
    expect(s).toContain('chsh -s "$(command -v zsh)" "$(id -un)"');
    expect(s.indexOf("chsh")).toBeGreaterThan(s.indexOf("rev-parse HEAD"));
    expect(s).not.toMatch(/bash -lc/);
    expect(s).not.toMatch(/\|\s*(bash|sh|zsh)\b/);
    expect(s).not.toMatch(/\bcurl\b/);
  });

  it("only bash's rc files ticked: nothing to install, the guest's bash is the shell", () => {
    expect(shellInstallFor([shell("bashrc"), shell("bash_profile"), shell("zshrc", { bring: false }), shell("starship", { paths: ["~/.config/starship.toml"] })])).toBeUndefined();
  });

  it("a zsh framework ticked on its own still brings zsh, since nothing else can run it", () => {
    expect(shellInstallFor([shell("zplug", { paths: [] })])).toMatchObject({ shell: "zsh", frameworks: ["shell/zplug"] });
  });

  it("fish's config ticked alone: fish, with no framework", () => {
    const plan = shellInstallFor([shell("fish", { paths: ["~/.config/fish"] }), shell("zshrc", { bring: false })]);
    expect(plan).toMatchObject({ shell: "fish", frameworks: [] });
    expect(plan!.cmd).toContain("apt-get install -y -qq fish");
    expect(plan!.cmd).not.toContain("apt-get install -y -qq zsh");
    expect(plan!.cmd).toContain('chsh -s "$(command -v fish)" "$(id -un)"');
  });

  it("zsh and fish rows both ticked: both install, and the computer's login shell picks the one chsh sets, zsh when unknown", () => {
    const both = (login?: string) => shellInstallFor([shell("fish", { paths: ["~/.config/fish"], ...(login !== undefined ? { login } : {}) }), shell("zshrc", login !== undefined ? { login } : {})]);
    for (const plan of [both("zsh"), both("fish"), both()]) {
      expect(plan!.cmd).toContain("apt-get install -y -qq fish");
      expect(plan!.cmd).toContain("apt-get install -y -qq zsh");
    }
    expect(both("zsh")!.shell).toBe("zsh");
    expect(both("zsh")!.cmd).toContain('chsh -s "$(command -v zsh)" "$(id -un)"');
    expect(both("fish")!.shell).toBe("fish");
    expect(both("fish")!.cmd).toContain('chsh -s "$(command -v fish)" "$(id -un)"');
    expect(both()!.shell).toBe("zsh");
    expect(both("bash")!.shell).toBe("zsh");
    // The login shell is read off the recipe whatever is ticked, but a shell with no ticked row is never set.
    expect(shellInstallFor([shell("zshrc"), shell("fish", { paths: ["~/.config/fish"], bring: false, login: "fish" })])!.shell).toBe("zsh");
  });

  it("every framework pin is a full commit on a named branch, cloned over https", () => {
    for (const repo of Object.values(SHELL_FRAMEWORKS)) {
      expect(repo.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(repo.url).toMatch(/^https:\/\/github\.com\/[\w-]+\/[\w-]+\.git$/);
      expect(repo.branch).toMatch(/^(main|master)$/);
      expect(repo.home).not.toMatch(/^[~/]/);
    }
  });
});

describe("casks that are commands with a Linux release of their own", () => {
  const gcloud = (over: Partial<RecipeEntry> = {}) => row({ rung: "tools", id: "tools/brew-cask/gcloud-cli", label: "gcloud-cli", ...over });
  const docker = (over: Partial<RecipeEntry> = {}) => row({ rung: "tools", id: "tools/brew-cask/docker-desktop", label: "docker-desktop", ...over });
  const PIN = { tag: "575.0.0", sha256: "b".repeat(64) };

  it("the table knows gcloud-cli by its cask tokens or its command row, and docker-desktop for the kubectl it ships; an app cask is not in it", () => {
    expect(linuxCaskFor("tools/brew-cask/gcloud-cli")?.bin).toBe("gcloud");
    expect(linuxCaskFor("tools/cli/gcloud")?.bin).toBe("gcloud");
    expect(linuxCaskFor("tools/cli/ngrok")).toBeUndefined();
    expect(linuxCaskFor("tools/brew-cask/google-cloud-sdk")?.bin).toBe("gcloud");
    expect(linuxCaskFor("tools/brew-cask/docker-desktop")?.bin).toBe("kubectl");
    expect(linuxCaskFor("tools/brew-cask/rectangle")).toBeUndefined();
    expect(linuxCaskFor("tools/brew/gcloud-cli")).toBeUndefined();
    expect(linuxCaskByBin("kubectl")?.casks).toEqual(["docker-desktop", "docker"]);
    for (const c of LINUX_CASKS) {
      expect(c.from).not.toMatch(/[()]/);
      expect(c.detail.length).toBeLessThanOrEqual(76);
    }
  });

  it("brewfileFor sets a known cask aside for the install step instead of skipping it, as a cask row or as the command row the collector makes of it; an app cask and a command cask without a release are still skipped", () => {
    const b = brewfileFor([gcloud(), row({ rung: "tools", id: "tools/cli/gcloud", label: "gcloud (gcloud-cli)", version: "575.0.0" }), row({ rung: "tools", id: "tools/brew-cask/rectangle" }), row({ rung: "tools", id: "tools/cli/ngrok" })]);
    expect(b.roads).toEqual([]);
    expect(b.skipped).toEqual([{ id: "tools/brew-cask/rectangle", note: "macOS app, no Linux build" }, { id: "tools/cli/ngrok", note: "no GitHub release to install from" }]);
  });

  it("the command row of gcloud-cli installs from Google's release at the Mac's version, named for its command so the PATH check covers it", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/cli/gcloud", label: "gcloud (gcloud-cli)", version: "575.0.0" })]);
    expect(t.installs.map(i => [i.id, i.manager, i.bin])).toEqual([["tools/cli/gcloud", "vendor", "gcloud"]]);
    expect(t.installs[0]!.cmd).toContain("ver='575.0.0'");
    expect(toolUninstall(row({ rung: "tools", id: "tools/cli/gcloud" }))).toEqual({ cmd: expect.stringContaining("rm -rf /opt/google-cloud-sdk") });
  });

  it("gcloud installs Google's tarball for the Mac's version, links its commands into /usr/local/bin and prints the WSP_ROAD line with the sum and the version", () => {
    const t = toolInstallsFor([gcloud({ version: "575.0.0" })]);
    expect(t.installs.map(i => [i.id, i.manager, i.after, i.bin])).toEqual([["tools/brew-cask/gcloud-cli", "vendor", undefined, "gcloud"]]);
    const cmd = t.installs[0]!.cmd;
    expect(cmd).toContain("set -euo pipefail");
    expect(cmd).toContain("ver='575.0.0'");
    expect(cmd).toContain('pkg="google-cloud-cli-$ver-linux-$a.tar.gz"');
    expect(cmd).toContain('"https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/$pkg"');
    expect(cmd).toMatch(/x86_64\) a=x86_64 ;; aarch64\) a=arm ;;/);
    expect(cmd).toContain(`[ "$a" != arm ] || command -v python3 >/dev/null || { echo "Error: gcloud on arm needs python3 on the machine; Google's arm tarball bundles none" >&2; exit 1; }`);
    expect(cmd).toContain("ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud");
    expect(cmd).toContain('echo "WSP_ROAD release $pkg $sum $ver"');
    expect(cmd).not.toContain("does not match");
    expect(cmd).not.toContain("components-2.json");
  });

  it("without a Mac version and without a pin the current version is read from Google's component list; a pin alone fixes the version to the pinned one", () => {
    const fresh = toolInstallsFor([gcloud()]).installs[0]!.cmd;
    expect(fresh).toContain("https://dl.google.com/dl/cloudsdk/channels/rapid/components-2.json");
    expect(fresh).toContain('[ -n "$ver" ] ||');
    const pinned = toolInstallsFor([gcloud({ pin: PIN })]).installs[0]!.cmd;
    expect(pinned).toContain("ver='575.0.0'");
    expect(pinned).toContain(`[ "$sum" = '${PIN.sha256}' ] ||`);
    expect(pinned).not.toContain("components-2.json");
  });

  it("gcloud across two runs: the first records, the second checks while the Mac's version is the recorded one, and re-records once it moved", () => {
    const cask = linuxCaskFor("tools/brew-cask/gcloud-cli")!;
    expect(caskPinState(cask, gcloud({ version: "575.0.0" }))).toBe("none");
    expect(caskPinState(cask, gcloud({ pin: PIN }))).toBe("same");
    expect(caskPinState(cask, gcloud({ version: "575.0.0", pin: PIN }))).toBe("same");
    const same = toolInstallsFor([gcloud({ version: "575.0.0", pin: PIN })]).installs[0]!.cmd;
    expect(same).toContain(`[ "$sum" = '${PIN.sha256}' ] || { echo "Error: $pkg does not match the checksum recorded on the first install of $ver" >&2; exit 1; }`);
    expect(caskPinState(cask, gcloud({ version: "583.0.0", pin: PIN }))).toBe("moved");
    const moved = toolInstallsFor([gcloud({ version: "583.0.0", pin: PIN })]).installs[0]!.cmd;
    expect(moved).toContain("ver='583.0.0'");
    expect(moved).not.toContain("does not match");
  });

  it("kubectl across two runs: Docker's version never names the release, so the second run checks the recorded sum whatever Docker moved to", () => {
    const cask = linuxCaskFor("tools/brew-cask/docker-desktop")!;
    const pin = { tag: "v1.37.0", sha256: "c".repeat(64) };
    expect(caskPinState(cask, docker({ version: "4.80.0,232116" }))).toBe("none");
    expect(caskPinState(cask, docker({ version: "4.80.0,232116", pin }))).toBe("same");
    expect(caskPinState(cask, docker({ version: "4.81.0,240001", pin }))).toBe("same");
    const cmd = toolInstallsFor([docker({ version: "4.81.0,240001", pin })]).installs[0]!.cmd;
    expect(cmd).toContain("ver='v1.37.0'");
    expect(cmd).toContain(`[ "$sum" = '${pin.sha256}' ] ||`);
    expect(cmd).not.toContain("4.81.0");
  });

  it("a command row that already goes out as a GitHub road installs once, as the road, not again from the cask table", () => {
    const t = toolInstallsFor([row({ rung: "tools", id: "tools/cli/kubectl", label: "kubectl", paths: ["github.com/kubernetes/kubernetes@v1.37.0"] })]);
    expect(t.installs.map(i => [i.id, i.manager])).toEqual([["tools/cli/kubectl", "release"]]);
  });

  it("docker-desktop brings kubectl alone: the static binary at the stable version, checked against the published sum; a pin fixes the version and adds its own check", () => {
    const fresh = toolInstallsFor([docker({ version: "4.80.0,232116" })]).installs[0]!;
    expect(fresh.manager).toBe("vendor");
    expect(fresh.cmd).toContain('ver="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"');
    expect(fresh.cmd).not.toContain("4.80.0");
    expect(fresh.cmd).toContain('url="https://dl.k8s.io/release/$ver/bin/linux/$a/kubectl"');
    expect(fresh.cmd).toMatch(/x86_64\) a=amd64 ;; aarch64\) a=arm64 ;;/);
    expect(fresh.cmd).toContain('echo "$(cat "$tmp/kubectl.sha256")  $tmp/kubectl" | sha256sum -c - >/dev/null');
    expect(fresh.cmd).toContain('install -m 0755 "$tmp/kubectl" /usr/local/bin/kubectl');
    expect(fresh.cmd).toContain('echo "WSP_ROAD release kubectl-$ver-linux-$a $sum $ver"');
    const pinned = toolInstallsFor([docker({ version: "4.80.0,232116", pin: { tag: "v1.37.0", sha256: "c".repeat(64) } })]).installs[0]!.cmd;
    expect(pinned).toContain("ver='v1.37.0'");
    expect(pinned).not.toContain("stable.txt");
    expect(pinned).toContain(`[ "$sum" = '${"c".repeat(64)}' ] || { echo "Error: kubectl $ver does not match`);
  });

  it("an unticked known cask installs nothing; a ticked one comes last, after every manager", () => {
    expect(toolInstallsFor([gcloud({ bring: false })]).installs).toEqual([]);
    const t = toolInstallsFor([gcloud({ version: "575.0.0" }), row({ rung: "tools", id: "tools/npm/wrangler", label: "wrangler@4.106.0", version: "4.106.0" })]);
    expect(t.installs.map(i => i.id)).toEqual(["tools/npm/wrangler", "tools/brew-cask/gcloud-cli"]);
  });

  it("a known cask comes off the machine by the table's command; an app cask was never there", () => {
    expect(toolUninstall(gcloud())).toEqual({ cmd: expect.stringContaining("rm -rf /opt/google-cloud-sdk /usr/local/bin/gcloud /usr/local/bin/gsutil /usr/local/bin/bq") });
    expect(toolUninstall(docker())).toEqual({ cmd: expect.stringContaining("rm -f /usr/local/bin/kubectl") });
    expect(toolUninstall(row({ rung: "tools", id: "tools/brew-cask/rectangle" }))).toEqual({ note: "never installed on Linux" });
  });
});
