// SPDX-License-Identifier: AGPL-3.0-only
// The impure half of golden import on the laptop: packing the planned files
// into one archive with their modes, reading Keychain logins through an
// injected reader (the real one is never run here), and the import the
// recipe's ticks add up to.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "@wsp/collect";
import { NODE_RELEASES, planFiles } from "@wsp/engine";
import { afterEach, describe, expect, it } from "vitest";
import { GOLDEN_SETUP, GOLDEN_SMOKE } from "../src/doctor.js";
import { importFor, importResultPath, keychainLogins, keychainReader, packPlan, readSecrets, statOf, type SecretReader } from "../src/init-import.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small home, links resolved so link targets compare against it the way importFor does. */
function laptop(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wsp-import-home-")));
  dirs.push(home);
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Me\n");
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  writeFileSync(join(home, ".ssh", "config"), "Host work\n", { mode: 0o600 });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE", { mode: 0o600 });
  mkdirSync(join(home, ".oh-my-zsh", "custom", "plugins", "x"), { recursive: true });
  writeFileSync(join(home, ".oh-my-zsh", "custom", "plugins", "x", "x.zsh"), "echo x\n");
  chmodSync(join(home, ".oh-my-zsh", "custom", "plugins", "x", "x.zsh"), 0o755);
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        Zingzy:\n    user: Zingzy\n");
  return home;
}

const row = (over: Partial<ManifestEntry> & Pick<ManifestEntry, "rung" | "id">): ManifestEntry => ({
  label: over.id,
  paths: [],
  bytes: 0,
  default: "bring",
  bring: true,
  ...over,
});

function reader(values: Record<string, string>): SecretReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: async service => {
      reads.push(service);
      const v = values[service];
      if (v === undefined) throw new Error(`Command failed: security find-generic-password -s ${service} -w\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`);
      return v;
    },
  };
}

function listTar(tar: Buffer): { path: string; mode: string }[] {
  const dir = mkdtempSync(join(tmpdir(), "wsp-import-tar-"));
  dirs.push(dir);
  const tgz = join(dir, "a.tgz");
  writeFileSync(tgz, tar);
  const out = execFileSync("tar", ["-tvzf", tgz], { encoding: "utf8" });
  return out
    .split("\n")
    .filter(l => l.trim() !== "")
    .map(l => {
      const cols = l.trim().split(/\s+/);
      return { path: cols.at(-1)!.replace(/^\.\//, ""), mode: cols[0]! };
    });
}

function extract(tar: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-import-x-"));
  dirs.push(dir);
  writeFileSync(join(dir, "a.tgz"), tar);
  execFileSync("tar", ["-xzf", join(dir, "a.tgz"), "-C", dir]);
  return dir;
}

describe("packPlan", () => {
  it("packs the planned files under their guest paths with the laptop's modes, .ssh closed to 700, and measures the unpacked size", async () => {
    const home = laptop();
    const plan = planFiles(
      [
        row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"] }),
        row({ rung: "identity", id: "identity/ssh-config", paths: ["~/.ssh/config"] }),
        row({ rung: "shell", id: "shell/oh-my-zsh", paths: ["~/.oh-my-zsh/custom"] }),
      ],
      { home, stat: statOf, platform: "darwin" },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    expect(packed.bytes).toBe(packed.tar.length);
    expect(packed.unpacked).toBe("[user]\n\tname = Me\n".length + "Host work\n".length + "echo x\n".length);
    expect(packed.skipped).toEqual([]);
    const entries = listTar(packed.tar);
    const modeOf = (p: string) => entries.find(e => e.path === p || e.path === `${p}/`)?.mode;
    expect(modeOf(".gitconfig")).toMatch(/^-rw-r--r--/);
    expect(modeOf(".ssh")).toMatch(/^drwx------/);
    expect(modeOf(".ssh/config")).toMatch(/^-rw-------/);
    expect(modeOf(".oh-my-zsh/custom/plugins/x/x.zsh")).toMatch(/^-rwxr-xr-x/);
    expect(entries.some(e => e.path.includes("id_ed25519"))).toBe(false);
  });

  it("ships a linked dotfile as the target's bytes at the link's path, and leaves out links inside a copied directory that leave home, hit a refused path, or dangle", async () => {
    const home = laptop();
    mkdirSync(join(home, "dotfiles"));
    writeFileSync(join(home, "dotfiles", "zshrc"), "export FROM=dotfiles\n", { mode: 0o644 });
    symlinkSync(join(home, "dotfiles", "zshrc"), join(home, ".zshrc"));
    mkdirSync(join(home, ".config", "tool"), { recursive: true });
    writeFileSync(join(home, ".config", "tool", "real.toml"), "a = 1\n");
    symlinkSync(join(home, "dotfiles", "zshrc"), join(home, ".config", "tool", "fine"));
    symlinkSync("/etc/hosts", join(home, ".config", "tool", "outside"));
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(home, ".config", "tool", "key"));
    symlinkSync(join(home, "nowhere"), join(home, ".config", "tool", "gone"));
    symlinkSync(join(home, ".config", "tool"), join(home, ".config", "tool", "self"));
    const plan = planFiles(
      [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "editors", id: "editors/tool", paths: ["~/.config/tool"] })],
      { home, stat: statOf, platform: "darwin" },
    );
    expect(plan.files.map(f => [f.dest, f.dir])).toEqual([[".zshrc", false], [".config/tool", true]]);
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const entries = listTar(packed.tar);
    expect(entries.find(e => e.path === ".zshrc")?.mode).toMatch(/^-rw-r--r--/);
    expect(entries.find(e => e.path === ".config/tool/fine")?.mode).toMatch(/^-/);
    expect(entries.map(e => e.path).filter(p => /outside|key|gone|self/.test(p))).toEqual([]);
    expect(entries.some(e => e.mode.startsWith("l"))).toBe(false);
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("export FROM=dotfiles\n");
    expect(readFileSync(join(dir, ".config", "tool", "fine"), "utf8")).toBe("export FROM=dotfiles\n");
    expect([...packed.skipped].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { id: "editors/tool", path: "~/.config/tool/gone", note: "a link whose target is gone" },
      { id: "editors/tool", path: "~/.config/tool/key", note: "a link to ~/.ssh/id_ed25519: private key, never copied" },
      { id: "editors/tool", path: "~/.config/tool/outside", note: `a link to ${realpathSync("/etc/hosts")}, outside your home directory` },
      { id: "editors/tool", path: "~/.config/tool/self", note: "a link into its own directory" },
    ]);
    // The laptop's own link and target are untouched.
    expect(statSync(join(home, "dotfiles", "zshrc")).mode & 0o777).toBe(0o644);
  });

  it("a self link under a directory whose ancestor is itself a link is left out too, instead of looping the pack", async () => {
    const home = laptop();
    mkdirSync(join(home, "dotfiles", "config", "tool"), { recursive: true });
    writeFileSync(join(home, "dotfiles", "config", "tool", "conf"), "a = 1\n");
    symlinkSync(join(home, "dotfiles", "config"), join(home, ".config2"));
    symlinkSync(join(home, ".config2", "tool"), join(home, ".config2", "tool", "self"));
    const plan = planFiles([row({ rung: "editors", id: "editors/tool", paths: ["~/.config2/tool"] })], { home, stat: statOf, platform: "darwin" });
    expect(plan.files.map(f => f.dest)).toEqual([".config2/tool"]);
    const packed = await packPlan(plan, { secrets: new Map(), home });
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "").sort()).toEqual([".config2/", ".config2/tool/", ".config2/tool/conf"]);
    expect(packed.skipped).toEqual([{ id: "editors/tool", path: "~/.config2/tool/self", note: "a link into its own directory" }]);
  });

  it("a cycle of links between sibling directories inside a copied directory is left out, not walked to ELOOP", async () => {
    const home = laptop();
    mkdirSync(join(home, ".config", "a"), { recursive: true });
    mkdirSync(join(home, ".config", "b"), { recursive: true });
    writeFileSync(join(home, ".config", "a", "a.toml"), "a\n");
    writeFileSync(join(home, ".config", "b", "b.toml"), "b\n");
    symlinkSync(join(home, ".config", "b"), join(home, ".config", "a", "link"));
    symlinkSync(join(home, ".config", "a"), join(home, ".config", "b", "link"));
    const plan = planFiles([row({ rung: "editors", id: "editors/a", paths: ["~/.config/a"] })], { home, stat: statOf, platform: "darwin" });
    const packed = await packPlan(plan, { secrets: new Map(), home });
    // b is reached once through a's link and shipped; b's link back to a is the cycle and stays out.
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "").sort()).toEqual([".config/", ".config/a/", ".config/a/a.toml", ".config/a/link/", ".config/a/link/b.toml"]);
    expect(packed.skipped).toEqual([{ id: "editors/a", path: "~/.config/a/link/link", note: "a link into a directory already copied" }]);
  });

  it("parent directories the pack creates keep the laptop's mode, also when a rewrite renames or shortens the path", async () => {
    const home = laptop();
    chmodSync(join(home, ".config"), 0o700);
    chmodSync(join(home, ".config", "gh"), 0o700);
    mkdirSync(join(home, ".claude"), { mode: 0o700 });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    mkdirSync(join(home, "Library", "Application Support", "com.vercel.cli"), { recursive: true });
    // macOS keeps Application Support at 700; paired from the end it stands for .config here.
    chmodSync(join(home, "Library", "Application Support"), 0o700);
    chmodSync(join(home, "Library", "Application Support", "com.vercel.cli"), 0o700);
    writeFileSync(join(home, "Library", "Application Support", "com.vercel.cli", "auth.json"), "{}\n");
    const plan = planFiles(
      [
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" }),
        row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json"] }),
        row({ rung: "logins", id: "logins/vercel", paths: ["~/Library/Application Support/com.vercel.cli/auth.json"], choice: "copy" }),
      ],
      { home, stat: statOf, platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] },
    );
    expect(plan.files.map(f => f.dest)).toEqual([".config/gh/hosts.yml", ".claude-cfg/settings.json", ".config/com.vercel.cli/auth.json"]);
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const entries = listTar(packed.tar);
    const modeOf = (p: string) => entries.find(e => e.path === p || e.path === `${p}/`)?.mode;
    expect(modeOf(".config")).toMatch(/^drwx------/);
    expect(modeOf(".config/gh")).toMatch(/^drwx------/);
    expect(modeOf(".claude-cfg")).toMatch(/^drwx------/);
    expect(modeOf(".config/com.vercel.cli")).toMatch(/^drwx------/);
  });

  it("a login whose Keychain item was not read travels with none of its files, so the warn about signing in on the machine is true", async () => {
    const home = laptop();
    const plan = planFiles(
      [
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
        row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"] }),
      ],
      { home, stat: statOf, platform: "darwin" },
    );
    expect(plan.files.map(f => f.dest)).toEqual([".config/gh/hosts.yml", ".gitconfig"]);
    const packed = await packPlan(plan, { secrets: new Map(), home });
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "")).toEqual([".gitconfig"]);
    expect(packed.skipped).toEqual([
      { id: "logins/gh", path: "~/.config/gh/hosts.yml", note: "not read from the Keychain; sign in on the machine" },
      { id: "logins/gh", path: "Keychain: gh:github.com", note: "not read from the Keychain; sign in on the machine" },
    ]);
  });

  it("a guest directory two laptop directories map onto takes the same-named one's mode whatever the tick order", async () => {
    for (const order of ["gh first", "vercel first"]) {
      const home = laptop();
      chmodSync(join(home, ".config"), 0o755);
      mkdirSync(join(home, "Library", "Application Support", "com.vercel.cli"), { recursive: true });
      chmodSync(join(home, "Library", "Application Support"), 0o700);
      writeFileSync(join(home, "Library", "Application Support", "com.vercel.cli", "auth.json"), "{}\n");
      const gh = row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" });
      const vercel = row({ rung: "logins", id: "logins/vercel", paths: ["~/Library/Application Support/com.vercel.cli/auth.json"], choice: "copy" });
      const plan = planFiles(order === "gh first" ? [gh, vercel] : [vercel, gh], { home, stat: statOf, platform: "darwin" });
      const packed = await packPlan(plan, { secrets: new Map(), home });
      const mode = listTar(packed.tar).find(e => e.path === ".config/")?.mode;
      expect(mode, order).toMatch(/^drwxr-xr-x/);
    }
  });

  it("readSecrets asks the reader once per Keychain login and turns a failed read into a refusal that carries security's reason", async () => {
    const rows = [
      row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
      row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      row({ rung: "logins", id: "logins/codex", paths: ["~/.codex/auth.json"], choice: "machine" }),
      row({ rung: "logins", id: "logins/gh2", paths: ["~/.config/gh/hosts.yml"], choice: "copy" }),
    ];
    const wanted = keychainLogins(rows, "darwin");
    // gh2 carries hosts.yml alone, so nothing is read from the Keychain for it.
    expect(wanted.map(s => [s.id, s.service])).toEqual([["logins/gh", "gh:github.com"], ["logins/claude", "Claude Code-credentials"]]);
    expect(keychainLogins(rows, "linux")).toEqual([]);
    const secrets = reader({ "gh:github.com": "gho_fake_token" });
    const read = await readSecrets(wanted, secrets);
    expect(secrets.reads).toEqual(["gh:github.com", "Claude Code-credentials"]);
    expect([...read.values]).toEqual([["gh:github.com", "gho_fake_token"]]);
    expect(read.refused).toEqual([{ id: "logins/claude", service: "Claude Code-credentials", reason: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }]);
  });

  it("places each secret it was given, and notes a planned secret it was not given instead of failing", async () => {
    const home = laptop();
    const plan = planFiles(
      [
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
        row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      ],
      { home, stat: statOf, platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] },
    );
    const packed = await packPlan(plan, { secrets: new Map([["gh:github.com", "gho_fake_token"]]), home });
    expect(packed.skipped).toEqual([{ id: "logins/claude", path: "Keychain: Claude Code-credentials", note: "not read from the Keychain; sign in on the machine" }]);
    const dir = extract(packed.tar);
    const hosts = readFileSync(join(dir, ".config/gh/hosts.yml"), "utf8");
    expect(hosts).toBe("github.com:\n    oauth_token: gho_fake_token\n    git_protocol: ssh\n    users:\n        Zingzy:\n            oauth_token: gho_fake_token\n    user: Zingzy\n");
    expect(statSync(join(dir, ".config/gh/hosts.yml")).mode & 0o777).toBe(0o600);
    expect(listTar(packed.tar).some(e => e.path.includes(".credentials.json"))).toBe(false);
  });

  it("writes the archive, which holds the secrets, as 0600 from the first byte", async () => {
    // A tar on PATH that records the archive's mode as it is handed the file, then runs the real one.
    const shim = mkdtempSync(join(tmpdir(), "wsp-tar-shim-"));
    dirs.push(shim);
    const record = join(shim, "modes");
    const real = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
    writeFileSync(join(shim, "tar"), `#!/bin/sh\nfor a in "$@"; do case "$a" in *.tgz) stat -f '%Lp' "$a" >> "${record}" ;; esac; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const home = laptop();
    const plan = planFiles([row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" })], { home, stat: statOf, platform: "darwin" });
    const path = process.env["PATH"];
    process.env["PATH"] = `${shim}:${path}`;
    try {
      await packPlan(plan, { secrets: new Map([["gh:github.com", "gho_fake_token"]]), home });
    } finally {
      process.env["PATH"] = path;
    }
    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual(["600"]);
  });
});

describe("statOf", () => {
  it("reports a file, a directory, a link by its target, and a dangling link by where it pointed", () => {
    const home = laptop();
    symlinkSync(join(home, ".gitconfig"), join(home, "link"));
    symlinkSync("missing", join(home, "dangling"));
    expect(statOf(join(home, ".gitconfig"))).toMatchObject({ kind: "file", mode: 0o644, size: "[user]\n\tname = Me\n".length, realpath: join(home, ".gitconfig") });
    expect(statOf(join(home, ".ssh"))).toMatchObject({ kind: "dir", mode: 0o700, realpath: join(home, ".ssh") });
    expect(statOf(join(home, "link"))).toMatchObject({ kind: "file", mode: 0o644, realpath: join(home, ".gitconfig") });
    expect(statOf(join(home, "dangling"))).toEqual({ kind: "dangling", target: join(home, "missing") });
    expect(statOf(join(home, "absent"))).toBeUndefined();
  });
});

describe("keychainReader", () => {
  it("is the security command with the service and -w, built but never run in tests", () => {
    const r = keychainReader();
    expect(r.command("Claude Code-credentials")).toEqual({ file: "security", args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"] });
  });
});

describe("importFor", () => {
  const ticks = (home: string, ...over: ManifestEntry[]) =>
    importFor(
      [
        row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"], bytes: 20 }),
        row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], bytes: 5 }),
        row({ rung: "agents", id: "agents/codex", paths: ["~/.codex/config.toml"] }),
        row({ rung: "tools", id: "tools/brew/jq", linux: "yes" }),
        row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", linux: "unknown" }),
        row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }),
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
        ...over,
      ],
      { home, secrets: new Map(), platform: "darwin" },
    );

  it("maps the ticks to files (Claude's dir under the guest config dir), tools, the Node the agents need, and agents with Claude on the sanctioned line", () => {
    const home = laptop();
    const imp = ticks(home);
    expect(imp.recipeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(imp.files).toMatchObject({ count: 3, rungs: { identity: 1, logins: 2 }, bytes: 20 });
    expect(imp.files?.skipped).toEqual([
      { id: "agents/claude", path: "~/.claude/settings.json", note: "no longer on this computer" },
      { id: "agents/claude", path: "~/.claude.json", note: "no longer on this computer" },
      { id: "agents/codex", path: "~/.codex/config.toml", note: "no longer on this computer" },
    ]);
    expect(imp.tools.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/jq", "tools/npm/bun"]);
    expect(imp.node).toMatchObject({ floor: 16, version: NODE_RELEASES[22].version, agents: ["Codex"] });
    expect(imp.agents.map(a => [a.id, a.install, a.smoke])).toEqual([
      ["agents/claude", GOLDEN_SETUP, GOLDEN_SMOKE],
      ["agents/codex", expect.stringContaining("npm install -g @openai/codex@"), "codex --version"],
    ]);
    expect(imp.skippedAgents).toEqual([]);
    expect(ticks(home, row({ rung: "agents", id: "agents/zed", label: "Zed" })).skippedAgents).toEqual([{ id: "agents/zed", name: "Zed", note: "no installer known" }]);
  });

  it("the recipe hash follows the shipped file's contents changing, through its size and mtime", () => {
    const home = laptop();
    const before = ticks(home).recipeHash;
    expect(ticks(home).recipeHash).toBe(before);
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Someone Else\n");
    expect(ticks(home).recipeHash).not.toBe(before);
  });

  it("the results it reports carry the planned skips too, and go next to the recipe", async () => {
    const home = laptop();
    const results: unknown[] = [];
    const imp = importFor([row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", linux: "unknown" })], {
      home,
      secrets: new Map(),
      platform: "darwin",
      onResult: r => void results.push(r),
    });
    expect(imp.files).toBeUndefined();
    expect(imp.node).toBeUndefined();
    imp.onResult!({ recipeHash: imp.recipeHash, tools: [], agents: [] });
    expect(results).toEqual([{ recipeHash: imp.recipeHash, tools: [{ id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", outcome: "skipped", note: "no Linux bottle known" }], agents: [] }]);
    expect(importResultPath("/x/state.json")).toBe("/x/golden-import.json");
  });
});
