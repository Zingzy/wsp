// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import {
  AGENT_INSTALLERS,
  CURRENT_LTS,
  HELIX,
  NODE_RELEASES,
  agentInstallsFor,
  brewfileFor,
  editorInstallsFor,
  ghAccounts,
  extensionsFile,
  HOMEBREW,
  remoteEditorFor,
  remoteSettingsPath,
  nodeInstallScript,
  neverCopied,
  nodeMajorFor,
  placeGhToken,
  planFiles,
  recipeDigest,
  recipeHash,
  refusedPath,
  secretKey,
  SHELL_FRAMEWORKS,
  shellInstallFor,
  toolInstallsFor,
  BREW_HOUSEKEEPING,
  type DigestedFile,
  type PathInfo,
  type RecipeDigest,
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
  `${HOME}/Library/Application Support/Code/User/settings.json`,
  `${HOME}/.config/Code/User/settings.json`,
  `${HOME}/.config/Cursor/User/settings.json`,
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
const isDir = (abs: string) => abs.endsWith("custom") || abs.endsWith("/.ssh") || abs.endsWith("/.ssh/keys") || abs.endsWith("/.claude") || abs.endsWith("/.config/demo") || abs.endsWith("/demo/cache") || abs.endsWith("/proj/.env");
const stat = (abs: string): PathInfo | undefined => {
  if (abs in links) {
    const target = links[abs];
    if (target === undefined) return { kind: "dangling", target: `${HOME}/nowhere` };
    return { kind: "file", mode: 0o644, size: 7, mtimeMs: 7_000, realpath: target };
  }
  if (!present.has(abs)) return undefined;
  const mode = isDir(abs) ? 0o755 : abs.includes("/.ssh/") || abs.endsWith("auth.json") || abs.endsWith("-token") || abs.endsWith("/.netrc") ? 0o600 : 0o644;
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
    // A file without the host gets a block for the account, marked active.
    expect(p.secrets[1]!.place("gho_zingzy", undefined)).toBe(["github.com:", "    oauth_token: gho_zingzy", "    git_protocol: https", "    users:", "        Zingzy:", "            oauth_token: gho_zingzy", "    user: Zingzy", ""].join("\n"));
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
      // What two or more of the formulae (gh and the managers' pipx, rust, go) share installs once, after the taps it may need.
      ["tools/brew-shared", "brew", "tools/brew-toolchain/gcc"],
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

  it("one formula has nothing to share, so no shared step; two get one between the taps and the first formula", () => {
    const one = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" })]);
    expect(one.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/gh"]);
    const two = toolInstallsFor([row({ rung: "tools", id: "tools/brew/gh", linux: "yes" }), row({ rung: "tools", id: "tools/brew/jq", linux: "yes" }), row({ rung: "tools", id: "tools/brew-tap/zingzy/tap", linux: "yes" })]);
    expect(two.installs.map(i => i.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew-tap/zingzy/tap", "tools/brew-shared", "tools/brew/gh", "tools/brew/jq"]);
    expect(two.installs.find(i => i.id === "tools/brew-shared")).toMatchObject({ label: "shared Homebrew dependencies", after: "tools/brew-toolchain/gcc" });
    expect(two.installs.find(i => i.id === "tools/brew-shared")!.cmd).toContain(`brew deps --for-each '\\''gh'\\'' '\\''jq'\\'' |`);
  });

  it("the housekeeping after the loop is autoremove then a full cleanup, each as linuxbrew with the tools PATH", () => {
    expect(BREW_HOUSEKEEPING).toHaveLength(2);
    expect(BREW_HOUSEKEEPING[0]).toMatch(/^export PATH=\/root\/\.local\/bin:.*\nsu -s \/bin\/bash linuxbrew -c '.*brew autoremove'$/);
    expect(BREW_HOUSEKEEPING[1]).toMatch(/\nsu -s \/bin\/bash linuxbrew -c '.*brew cleanup -s --prune=all'$/);
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
      ["editors/vscode-ext", "VS Code extension list", "list"],
      ["editors/cursor-ext", "Cursor extension list", "list"],
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
