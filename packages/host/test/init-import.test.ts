// SPDX-License-Identifier: AGPL-3.0-only
// The impure half of golden import on the laptop: packing the planned files
// into one archive with their modes, reading Keychain logins through an
// injected reader (the real one is never run here), and the import the
// recipe's ticks add up to.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUARD_BEGIN, GUARD_END, type ManifestEntry } from "@wsp/collect";
import { NODE_RELEASES, planFiles } from "@wsp/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GOLDEN_SETUP, GOLDEN_SMOKE, MCP_SERVERS_JSON } from "@wsp/catalog";
import { withRefused } from "../../runtime/test/fs-refusal.js";
import { digestOf, importFor, importResultPath, keychainLogins, keychainReader, packPlan, readSecrets, statOf, type SecretReader } from "../src/init-import.js";

vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

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
  writeFileSync(join(home, ".config", "gh", "hosts.yml"), "github.com:\n    git_protocol: ssh\n    users:\n        other:\n        Zingzy:\n    user: Zingzy\n");
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

/** A Keychain with the given items, keyed as the secrets map is (see secretKey), and helper commands keyed by their
 * line; every read is recorded as [service, account], every helper run as [command]. */
function reader(values: Record<string, string>): SecretReader & { reads: (string | undefined)[][] } {
  const reads: (string | undefined)[][] = [];
  return {
    reads,
    read: async (service, account) => {
      reads.push([service, account]);
      const v = values[account === undefined ? service : `${service} (${account})`];
      if (v === undefined) throw new Error(`Command failed: security find-generic-password -s ${service} -w\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`);
      return v;
    },
    run: async command => {
      reads.push([command]);
      const v = values[command];
      if (v === undefined) throw Object.assign(new Error(`Command failed: /bin/sh -c ${command}\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n`), { code: 44 });
      return v;
    },
  };
}

const HELPER = "security find-generic-password -s anthropic-api-key -w";
const CLAUDE_SETTINGS = `{\n  "apiKeyHelper": "${HELPER}",\n  "model": "opus"\n}\n`;

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
      [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "shell", id: "shell/tool", paths: ["~/.config/tool"] })],
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
      { id: "shell/tool", path: "~/.config/tool/gone", note: "a link whose target is gone" },
      { id: "shell/tool", path: "~/.config/tool/key", note: "a link to ~/.ssh/id_ed25519: private key, never copied" },
      { id: "shell/tool", path: "~/.config/tool/outside", note: `a link to ${realpathSync("/etc/hosts")}, outside your home directory` },
      { id: "shell/tool", path: "~/.config/tool/self", note: "a link into its own directory" },
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
    const plan = planFiles([row({ rung: "shell", id: "shell/tool", paths: ["~/.config2/tool"] })], { home, stat: statOf, platform: "darwin" });
    expect(plan.files.map(f => f.dest)).toEqual([".config2/tool"]);
    const packed = await packPlan(plan, { secrets: new Map(), home });
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "").sort()).toEqual([".config2/", ".config2/tool/", ".config2/tool/conf"]);
    expect(packed.skipped).toEqual([{ id: "shell/tool", path: "~/.config2/tool/self", note: "a link into its own directory" }]);
  });

  it("a cycle of links between sibling directories inside a copied directory is left out, not walked to ELOOP", async () => {
    const home = laptop();
    mkdirSync(join(home, ".config", "a"), { recursive: true });
    mkdirSync(join(home, ".config", "b"), { recursive: true });
    writeFileSync(join(home, ".config", "a", "a.toml"), "a\n");
    writeFileSync(join(home, ".config", "b", "b.toml"), "b\n");
    symlinkSync(join(home, ".config", "b"), join(home, ".config", "a", "link"));
    symlinkSync(join(home, ".config", "a"), join(home, ".config", "b", "link"));
    const plan = planFiles([row({ rung: "shell", id: "shell/a", paths: ["~/.config/a"] })], { home, stat: statOf, platform: "darwin" });
    const packed = await packPlan(plan, { secrets: new Map(), home });
    // b is reached once through a's link and shipped; b's link back to a is the cycle and stays out.
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "").sort()).toEqual([".config/", ".config/a/", ".config/a/a.toml", ".config/a/link/", ".config/a/link/b.toml"]);
    expect(packed.skipped).toEqual([{ id: "shell/a", path: "~/.config/a/link/link", note: "a link into a directory already copied" }]);
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

  it("readSecrets asks the reader once per Keychain item, one per gh account this computer's hosts.yml lists, and turns a failed read into a refusal that carries security's reason", async () => {
    const home = laptop();
    const rows = [
      row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
      row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      row({ rung: "logins", id: "logins/codex", paths: ["~/.codex/auth.json"], choice: "machine" }),
      row({ rung: "logins", id: "logins/gh2", paths: ["~/.config/gh/hosts.yml"], choice: "copy" }),
    ];
    const wanted = keychainLogins(rows, "darwin", home);
    // gh2 carries hosts.yml alone, so nothing is read from the Keychain for it.
    expect(wanted.map(s => [s.id, s.service, s.account])).toEqual([
      ["logins/gh", "gh:github.com", "other"],
      ["logins/gh", "gh:github.com", "Zingzy"],
      ["logins/claude", "Claude Code-credentials", undefined],
    ]);
    expect(keychainLogins(rows, "linux", home)).toEqual([]);
    const secrets = reader({ "gh:github.com (other)": "gho_fake_other", "gh:github.com (Zingzy)": "gho_fake_token" });
    const read = await readSecrets(wanted, secrets);
    expect(secrets.reads).toEqual([["gh:github.com", "other"], ["gh:github.com", "Zingzy"], ["Claude Code-credentials", undefined]]);
    expect([...read.values]).toEqual([["gh:github.com (other)", "gho_fake_other"], ["gh:github.com (Zingzy)", "gho_fake_token"]]);
    expect(read.refused).toEqual([{ id: "logins/claude", service: "Claude Code-credentials", reason: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }]);
    // An account with no item of its own is dropped from a row another account of which was read; the row is not refused.
    const partial = await readSecrets(wanted.slice(0, 2), reader({ "gh:github.com (Zingzy)": "gho_fake_token" }));
    expect([...partial.values.keys()]).toEqual(["gh:github.com (Zingzy)"]);
    expect(partial.refused).toEqual([]);
    expect(partial.dropped).toEqual([{ id: "logins/gh", service: "gh:github.com", account: "other", left: "other left behind: no token in the Keychain", reason: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }]);
    // With no account read the row is refused once, the reason naming every account.
    const none = await readSecrets(wanted.slice(0, 2), reader({}));
    expect(none.dropped).toEqual([]);
    expect(none.refused).toEqual([
      {
        id: "logins/gh",
        service: "gh:github.com",
        reason: "other: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.; Zingzy: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
      },
    ]);
  });

  it("the Claude helper is run once on this computer with the Keychain reads, its value lands as a 0600 key file and the copied settings.json's helper reads that file; a failed run refuses the login with the command's reason", async () => {
    const home = laptop();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), CLAUDE_SETTINGS);
    const rows = [
      row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json"] }),
      row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials", "Helper: ~/.claude/settings.json"], choice: "copy" }),
    ];
    const wanted = keychainLogins(rows, "darwin", home);
    expect(wanted.map(s => [s.id, s.service, s.command])).toEqual([
      ["logins/claude", "Claude Code-credentials", undefined],
      ["logins/claude", "~/.claude/settings.json", HELPER],
    ]);
    // On Linux the Keychain item is a note; the helper still runs.
    expect(keychainLogins(rows, "linux", home).map(s => s.command)).toEqual([HELPER]);
    const secrets = reader({ [HELPER]: "sk-ant-x-helper" });
    const read = await readSecrets(wanted, secrets);
    expect(secrets.reads).toEqual([["Claude Code-credentials", undefined], [HELPER]]);
    expect([...read.values]).toEqual([["~/.claude/settings.json", "sk-ant-x-helper"]]);
    // The Keychain item was not read while the helper was: the login copies without the OAuth credentials, the row detail saying so.
    expect(read.refused).toEqual([]);
    expect(read.dropped).toEqual([{ id: "logins/claude", service: "Claude Code-credentials", left: "Claude Code-credentials left behind: no token in the Keychain", reason: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }]);
    const plan = planFiles(rows, { home, stat: statOf, read: abs => readFileSync(abs, "utf8"), platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] });
    const packed = await packPlan(plan, { secrets: read.values, home });
    expect(packed.skipped).toEqual([{ id: "logins/claude", path: "Keychain: Claude Code-credentials", note: "Claude Code-credentials left behind: no token in the Keychain" }]);
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".claude-cfg", "anthropic-api-key"), "utf8")).toBe("sk-ant-x-helper\n");
    expect(statSync(join(dir, ".claude-cfg", "anthropic-api-key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key",\n  "model": "opus"\n}\n');
    expect(listTar(packed.tar).some(e => e.path.includes(".credentials.json"))).toBe(false);
    // The helper failing on this computer refuses the login with its exit status, never its output; beside a read
    // Keychain item it is left behind instead, and the copied settings.json loses the helper line.
    const failed = await readSecrets(wanted.slice(1), reader({}));
    expect(failed.refused).toEqual([{ id: "logins/claude", service: "~/.claude/settings.json", command: HELPER, reason: "exit status 44" }]);
    const oauthOnly = await readSecrets(wanted, reader({ "Claude Code-credentials": '{"claudeAiOauth":{"accessToken":"sk-ant-x"}}' }));
    expect(oauthOnly.refused).toEqual([]);
    expect(oauthOnly.dropped.map(d => d.left)).toEqual(["the helper's key left behind: the helper did not run here"]);
    const without = await packPlan(plan, { secrets: oauthOnly.values, home });
    expect(without.skipped).toEqual([
      { id: "logins/claude", path: "Helper: ~/.claude/settings.json", note: "the helper's key left behind: the helper did not run here" },
      { id: "agents/claude", path: "~/.claude/settings.json", note: "apiKeyHelper left out of the copy: the command runs on this computer only" },
    ]);
    expect(readFileSync(join(extract(without.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "model": "opus"\n}\n');
    expect(readFileSync(join(extract(without.tar), ".claude-cfg", ".credentials.json"), "utf8")).toBe('{"claudeAiOauth":{"accessToken":"sk-ant-x"}}');
  });

  it("a copied settings.json whose helper did not travel loses the helper line, with a note, since a helper that fails on the machine is what every request would use", async () => {
    const home = laptop();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), CLAUDE_SETTINGS);
    // The whole directory copied, the login signing in on the machine.
    const plan = planFiles(
      [row({ rung: "agents", id: "agents/claude", paths: ["~/.claude"] }), row({ rung: "logins", id: "logins/claude", paths: ["Helper: ~/.claude/settings.json"], choice: "machine" })],
      { home, stat: statOf, read: abs => readFileSync(abs, "utf8"), platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    expect(packed.skipped).toEqual([{ id: "agents/claude", path: "~/.claude/settings.json", note: "apiKeyHelper left out of the copy: the command runs on this computer only" }]);
    expect(readFileSync(join(extract(packed.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "model": "opus"\n}\n');
    // Refused on this computer: the same drop, and the login's own note.
    const copy = planFiles(
      [row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json"] }), row({ rung: "logins", id: "logins/claude", paths: ["Helper: ~/.claude/settings.json"], choice: "copy" })],
      { home, stat: statOf, read: abs => readFileSync(abs, "utf8"), platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] },
    );
    const refused = await packPlan(copy, { secrets: new Map(), home });
    expect(refused.skipped).toEqual([
      { id: "logins/claude", path: "Helper: ~/.claude/settings.json", note: "the helper did not run here; sign in on the machine" },
      { id: "agents/claude", path: "~/.claude/settings.json", note: "apiKeyHelper left out of the copy: the command runs on this computer only" },
    ]);
    expect(readFileSync(join(extract(refused.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "model": "opus"\n}\n');
    // A settings.json with no helper is copied as it is.
    writeFileSync(join(home, ".claude", "settings.json"), '{"model": "opus"}');
    const plain = await packPlan(planFiles([row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json"] })], { home, stat: statOf, platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] }), { secrets: new Map(), home });
    expect(plain.skipped).toEqual([]);
    expect(readFileSync(join(extract(plain.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{"model": "opus"}');
  });

  it("a hook whose script is a plain file under home travels with the settings and points at its guest path; one naming a file outside home, or none under it, comes out of the copy and is listed as left behind", async () => {
    const home = laptop();
    mkdirSync(join(home, ".claude", "hooks"), { recursive: true });
    mkdirSync(join(home, ".codync"), { recursive: true });
    writeFileSync(join(home, ".claude", "hooks", "remind"), "#!/bin/sh\necho remind\n", { mode: 0o755 });
    writeFileSync(join(home, ".codync", "notify.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    const settings = {
      model: "opus",
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "~/.claude/hooks/remind > /dev/null 2>&1" }, { type: "command", command: `${home}/.codync/notify.sh --quiet`, timeout: 10 }] },
          { matcher: "resume", hooks: [{ type: "command", command: "/opt/homebrew/bin/terminal-notifier -title done" }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "~/.claude/hooks/gone" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "jq -r .tool_input.command" }, { type: "command", command: "/usr/bin/env node -e 1" }] }],
      },
    };
    writeFileSync(join(home, ".claude", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
    const plan = planFiles([row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json"] })], { home, stat: statOf, platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] });
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const dir = extract(packed.tar);
    expect(JSON.parse(readFileSync(join(dir, ".claude-cfg", "settings.json"), "utf8"))).toEqual({
      model: "opus",
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/root/.claude-cfg/hooks/remind > /dev/null 2>&1" }, { type: "command", command: "/root/.codync/notify.sh --quiet", timeout: 10 }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "jq -r .tool_input.command" }, { type: "command", command: "/usr/bin/env node -e 1" }] }],
      },
    });
    expect(readFileSync(join(dir, ".claude-cfg", "hooks", "remind"), "utf8")).toBe("#!/bin/sh\necho remind\n");
    expect(statSync(join(dir, ".claude-cfg", "hooks", "remind")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(dir, ".codync", "notify.sh"), "utf8")).toBe("#!/bin/sh\necho hi\n");
    const left = [
      { id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: /opt/homebrew/bin/terminal-notifier" },
      { id: "agents/claude", path: "~/.claude/settings.json", note: "hook left behind: ~/.claude/hooks/gone" },
    ];
    expect(packed.skipped).toEqual(left);
    expect(packed.leftBehind).toEqual(left);
    // A settings file without hooks, or one whose hooks name no file, is copied as it is and leaves nothing behind.
    writeFileSync(join(home, ".claude", "settings.json"), '{"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo done"}]}]}}');
    const plain = await packPlan(plan, { secrets: new Map(), home });
    expect(plain.skipped).toEqual([]);
    expect(plain.leftBehind).toBeUndefined();
    expect(readFileSync(join(extract(plain.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{"model": "opus", "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo done"}]}]}}');
  });

  it("a copied Codex config loses a notify whose program is a Mac binary, listed as left behind, and keeps every other key as written", async () => {
    const home = laptop();
    mkdirSync(join(home, ".codex", "computer-use"), { recursive: true });
    writeFileSync(join(home, ".codex", "computer-use", "SkyComputerUseClient"), "MZ-ish", { mode: 0o755 });
    const app = `${home}/.codex/computer-use/SkyComputerUseClient`;
    const config = `model = "gpt-5.5"\nnotify = ["${app}", "turn-ended"]\n\n[projects."${home}"]\ntrust_level = "trusted"\n`;
    writeFileSync(join(home, ".codex", "config.toml"), config);
    const plan = planFiles([row({ rung: "agents", id: "agents/codex", paths: ["~/.codex/config.toml"] })], { home, stat: statOf, platform: "darwin" });
    const packed = await packPlan(plan, { secrets: new Map(), home });
    expect(readFileSync(join(extract(packed.tar), ".codex", "config.toml"), "utf8")).toBe(`model = "gpt-5.5"\n\n[projects."${home}"]\ntrust_level = "trusted"\n`);
    const left = [{ id: "agents/codex", path: "~/.codex/config.toml", note: `hook left behind: ${app}` }];
    expect(packed.skipped).toEqual(left);
    expect(packed.leftBehind).toEqual(left);
    // A notify the machine can run travels with the rest of the file, byte for byte.
    const runs = config.replace(app, "/usr/bin/notify-send");
    writeFileSync(join(home, ".codex", "config.toml"), runs);
    const kept = await packPlan(plan, { secrets: new Map(), home });
    expect(readFileSync(join(extract(kept.tar), ".codex", "config.toml"), "utf8")).toBe(runs);
    expect(kept.skipped).toEqual([]);
    expect(kept.leftBehind).toBeUndefined();
    // The shape Codex's own config page writes: the interpreter stays, the script it runs travels to its guest path.
    writeFileSync(join(home, ".codex", "notify.py"), "print('hi')\n", { mode: 0o755 });
    writeFileSync(join(home, ".codex", "config.toml"), config.replace(`"${app}", "turn-ended"`, `"python3", "${home}/.codex/notify.py"`));
    const script = await packPlan(plan, { secrets: new Map(), home });
    const at = extract(script.tar);
    expect(readFileSync(join(at, ".codex", "config.toml"), "utf8")).toBe(config.replace(`"${app}", "turn-ended"`, '"python3", "/root/.codex/notify.py"'));
    expect(readFileSync(join(at, ".codex", "notify.py"), "utf8")).toBe("print('hi')\n");
    expect(statSync(join(at, ".codex", "notify.py")).mode & 0o777).toBe(0o755);
    expect(script.skipped).toEqual([]);
    // The same shape naming a script that is not there: the key goes, listed by the script.
    writeFileSync(join(home, ".codex", "config.toml"), config.replace(`"${app}", "turn-ended"`, '"python3", "~/.codex/gone.py"'));
    const gone = await packPlan(plan, { secrets: new Map(), home });
    expect(readFileSync(join(extract(gone.tar), ".codex", "config.toml"), "utf8")).toBe(`model = "gpt-5.5"\n\n[projects."${home}"]\ntrust_level = "trusted"\n`);
    expect(gone.leftBehind).toEqual([{ id: "agents/codex", path: "~/.codex/config.toml", note: "hook left behind: ~/.codex/gone.py" }]);
  });

  it("a helper key that travels without the Claude Code config lands beside a settings.json holding only the line that reads it, with a note on the login", async () => {
    const home = laptop();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), CLAUDE_SETTINGS);
    const rows = [
      row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json"], bring: false }),
      row({ rung: "logins", id: "logins/claude", paths: ["Helper: ~/.claude/settings.json"], choice: "copy" }),
    ];
    const read = await readSecrets(keychainLogins(rows, "darwin", home), reader({ [HELPER]: "sk-ant-x-helper" }));
    const plan = planFiles(rows, { home, stat: statOf, read: abs => readFileSync(abs, "utf8"), platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] });
    expect(plan.files).toEqual([]);
    const packed = await packPlan(plan, { secrets: read.values, home });
    expect(packed.skipped).toEqual([{ id: "logins/claude", path: "Helper: ~/.claude/settings.json", note: "the machine's settings.json names only the key file; your Claude Code config stayed here" }]);
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".claude-cfg", "anthropic-api-key"), "utf8")).toBe("sk-ant-x-helper\n");
    expect(statSync(join(dir, ".claude-cfg", "anthropic-api-key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key"\n}\n');
    expect(listTar(packed.tar).map(e => e.path).filter(p => p.includes("settings.json"))).toEqual([".claude-cfg/settings.json"]);
    // The config directory ticked without a settings.json in it gets the same file, so the key is read there too.
    rmSync(join(home, ".claude", "settings.json"));
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "be brief\n");
    const helperOnly = [row({ rung: "agents", id: "agents/claude", paths: ["~/.claude"] }), row({ rung: "logins", id: "logins/claude", paths: ["Helper: ~/.claude/settings.json"], choice: "copy" })];
    const dirPlan = planFiles(helperOnly, { home, stat: statOf, read: () => CLAUDE_SETTINGS, platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] });
    const dirPacked = await packPlan(dirPlan, { secrets: read.values, home });
    expect(readFileSync(join(extract(dirPacked.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key"\n}\n');
    // No key, no file: a settings.json nobody asked for never travels.
    const none = await packPlan(plan, { secrets: new Map(), home });
    expect(listTar(none.tar).some(e => e.path.includes("settings.json"))).toBe(false);
  });

  it("the volatile re-pack ships the key file and never a settings.json when the agent row brought one: the first pack's copy, rewritten to read the key, stays on the machine", async () => {
    const home = laptop();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), CLAUDE_SETTINGS);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { a: 1 } }));
    const rows = [
      row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], volatile: ["~/.claude.json"], bytes: 5 }),
      row({ rung: "logins", id: "logins/claude", paths: ["Helper: ~/.claude/settings.json"], choice: "copy" }),
    ];
    const read = await readSecrets(keychainLogins(rows, "darwin", home), reader({ [HELPER]: "sk-ant-x-helper" }));
    const imp = importFor(rows, { home, secrets: read.values, platform: "darwin" });
    expect(imp.files?.volatile?.paths).toEqual(["~/.claude.json", "Helper: ~/.claude/settings.json"]);
    const first = await imp.files!.pack();
    expect(readFileSync(join(extract(first.tar), ".claude-cfg", "settings.json"), "utf8")).toBe('{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key",\n  "model": "opus"\n}\n');
    const again = await imp.files!.volatile!.pack();
    expect(listTar(again.tar).map(e => e.path).filter(p => p !== "" && !p.endsWith("/")).sort()).toEqual([".claude-cfg/.claude.json", ".claude-cfg/anthropic-api-key"]);
    expect(again.skipped).toEqual([]);
    // With no settings.json among the plan's files both packs write the one naming the key file, the same bytes over the same bytes.
    const bare = importFor([{ ...rows[0]!, paths: ["~/.claude.json"], volatile: ["~/.claude.json"] }, rows[1]!], { home, secrets: read.values, platform: "darwin" });
    const stub = '{\n  "apiKeyHelper": "cat /root/.claude-cfg/anthropic-api-key"\n}\n';
    expect(readFileSync(join(extract((await bare.files!.pack()).tar), ".claude-cfg", "settings.json"), "utf8")).toBe(stub);
    expect(readFileSync(join(extract((await bare.files!.volatile!.pack()).tar), ".claude-cfg", "settings.json"), "utf8")).toBe(stub);
  });

  it("a failed helper is reported by its exit status alone: the command line, which may carry the key, never reaches the reason", async () => {
    const home = laptop();
    const inline = "printf sk-ant-x-inline; exit 3";
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: inline }));
    const wanted = keychainLogins([row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials", "Helper: ~/.claude/settings.json"], choice: "copy" })], "darwin", home);
    expect(wanted.map(s => s.command)).toEqual([undefined, inline]);
    // execFile's error names the command in its first line and carries the exit status as code; with no stderr that line is the last one.
    const shell: SecretReader = {
      read: async () => {
        throw new Error("Command failed: security find-generic-password -s Claude Code-credentials -w\nsecurity: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n");
      },
      run: async command => {
        throw Object.assign(new Error(`Command failed: /bin/sh -c ${command}\n`), { code: 3 });
      },
    };
    const refused = await readSecrets(wanted, shell);
    expect(refused.refused).toEqual([{ id: "logins/claude", service: "Claude Code-credentials", reason: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.; exit status 3" }]);
    expect(JSON.stringify(refused.refused.map(r => r.reason))).not.toContain("sk-ant-x-inline");
    // Beside a read Keychain item the same failure is a drop, with the same reason.
    const dropped = await readSecrets(wanted, { ...shell, read: async () => '{"claudeAiOauth":{}}' });
    expect(dropped.dropped.map(d => d.reason)).toEqual(["exit status 3"]);
    // A spawn failure names its code; a signal or an unknown throw says only that there is no status.
    expect((await readSecrets(wanted.slice(1), { ...shell, run: async () => { throw Object.assign(new Error("spawn /bin/sh ENOENT"), { code: "ENOENT" }); } })).refused[0]?.reason).toBe("ENOENT");
    expect((await readSecrets(wanted.slice(1), { ...shell, run: async () => { throw new Error(`Command failed: /bin/sh -c ${inline}`); } })).refused[0]?.reason).toBe("no exit status");
  });

  it("places each secret it was given, gh's per account with the active one under the host, and notes a planned secret it was not given instead of failing", async () => {
    const home = laptop();
    const plan = planFiles(
      [
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
        row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      ],
      { home, stat: statOf, read: abs => readFileSync(abs, "utf8"), platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] },
    );
    const secrets = new Map([
      ["gh:github.com (other)", "gho_fake_other"],
      ["gh:github.com (Zingzy)", "gho_fake_token"],
    ]);
    const packed = await packPlan(plan, { secrets, home });
    expect(packed.skipped).toEqual([{ id: "logins/claude", path: "Keychain: Claude Code-credentials", note: "not read from the Keychain; sign in on the machine" }]);
    const dir = extract(packed.tar);
    const hosts = readFileSync(join(dir, ".config/gh/hosts.yml"), "utf8");
    expect(hosts).toBe(
      ["github.com:", "    oauth_token: gho_fake_token", "    git_protocol: ssh", "    users:", "        other:", "            oauth_token: gho_fake_other", "        Zingzy:", "            oauth_token: gho_fake_token", "    user: Zingzy", ""].join("\n"),
    );
    expect(statSync(join(dir, ".config/gh/hosts.yml")).mode & 0o777).toBe(0o600);
    expect(listTar(packed.tar).some(e => e.path.includes(".credentials.json"))).toBe(false);
    // One account's token missing drops that account: its line leaves the users block, the file travels with the
    // rest, and the note names the account left behind.
    const partial = await packPlan(plan, { secrets: new Map([["gh:github.com (Zingzy)", "gho_fake_token"]]), home });
    expect(partial.skipped.map(s => [s.path, s.note])).toEqual([
      ["Keychain: gh:github.com (other)", "other left behind: no token in the Keychain"],
      ["Keychain: Claude Code-credentials", "not read from the Keychain; sign in on the machine"],
    ]);
    expect(readFileSync(join(extract(partial.tar), ".config/gh/hosts.yml"), "utf8")).toBe(["github.com:", "    oauth_token: gho_fake_token", "    git_protocol: ssh", "    users:", "        Zingzy:", "            oauth_token: gho_fake_token", "    user: Zingzy", ""].join("\n"));
    // The active account dropped: the one left becomes active and the host token is its.
    const active = await packPlan(plan, { secrets: new Map([["gh:github.com (other)", "gho_fake_other"]]), home });
    expect(active.skipped.map(s => [s.path, s.note])).toEqual([
      ["Keychain: gh:github.com (Zingzy)", "Zingzy left behind: no token in the Keychain"],
      ["Keychain: Claude Code-credentials", "not read from the Keychain; sign in on the machine"],
    ]);
    expect(readFileSync(join(extract(active.tar), ".config/gh/hosts.yml"), "utf8")).toBe(["github.com:", "    oauth_token: gho_fake_other", "    git_protocol: ssh", "    users:", "        other:", "            oauth_token: gho_fake_other", "    user: other", ""].join("\n"));
    // No account read keeps the whole row home: hosts.yml and both items are noted, the file does not travel.
    const none = await packPlan(plan, { secrets: new Map(), home });
    expect(none.skipped.map(s => [s.path, s.note])).toEqual([
      ["~/.config/gh/hosts.yml", "not read from the Keychain; sign in on the machine"],
      ["Keychain: gh:github.com (other)", "not read from the Keychain; sign in on the machine"],
      ["Keychain: gh:github.com (Zingzy)", "not read from the Keychain; sign in on the machine"],
      ["Keychain: Claude Code-credentials", "not read from the Keychain; sign in on the machine"],
    ]);
    expect(listTar(none.tar).some(e => e.path.includes("hosts.yml"))).toBe(false);
  });

  it("writes the archive, which holds the secrets, as 0600 from the first byte", async () => {
    // A tar on PATH that records the archive's mode as it is handed the file, then runs the real one.
    const shim = mkdtempSync(join(tmpdir(), "wsp-tar-shim-"));
    dirs.push(shim);
    const record = join(shim, "modes");
    const real = execFileSync("sh", ["-c", "command -v tar"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
    writeFileSync(join(shim, "tar"), `#!/bin/sh\nfor a in "$@"; do case "$a" in *.tgz) "${process.execPath}" -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8) + "\\n")' "$a" >> "${record}" ;; esac; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
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

describe("packPlan: excludes and consent rows", () => {
  function demo(home: string): void {
    mkdirSync(join(home, ".config", "demo", "cache"), { recursive: true });
    writeFileSync(join(home, ".config", "demo", "settings.toml"), "theme = 1\n");
    writeFileSync(join(home, ".config", "demo", "cache", "blob"), "x".repeat(2_000));
    mkdirSync(join(home, ".config", "gsc"), { recursive: true });
    writeFileSync(join(home, ".config", "gsc", "creds.json"), "fake-token\n", { mode: 0o600 });
  }

  it("copies a row's paths minus its excludes: the excluded subtree is not in the archive and is not a skip", async () => {
    const home = laptop();
    demo(home);
    const plan = planFiles(
      [row({ rung: "shell", id: "shell/demo", paths: ["~/.config/demo"], excludes: ["~/.config/demo/cache"], bytes: 10 })],
      { home, stat: statOf, platform: "darwin" },
    );
    expect(plan.files.map(f => f.excludes)).toEqual([[join(home, ".config", "demo", "cache")]]);
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const paths = listTar(packed.tar).map(e => e.path.replace(/\/$/, ""));
    expect(paths).toContain(".config/demo/settings.toml");
    expect(paths.filter(p => p.includes("cache"))).toEqual([]);
    expect(packed.skipped).toEqual([]);
    expect(packed.unpacked).toBe("theme = 1\n".length);
  });

  it("a credential-shaped row travels only with copy as its answer, at 0600; ticked without it, it is a note and nothing is packed", async () => {
    const home = laptop();
    demo(home);
    const token = (over: Partial<ManifestEntry>): ManifestEntry => row({ rung: "agents", id: "agents/mcp/claude/gsc", paths: ["~/.config/gsc/creds.json"], bytes: 11, consent: true, ...over });
    const noAnswer = importFor([token({})], { home, secrets: new Map(), platform: "darwin" });
    expect(noAnswer.files).toMatchObject({ count: 0, skipped: [{ id: "agents/mcp/claude/gsc", path: "~/.config/gsc/creds.json", note: "credential-shaped; not copied without your answer on its row" }] });
    const yes = importFor([token({ choice: "copy" })], { home, secrets: new Map(), platform: "darwin" });
    expect(yes.files).toMatchObject({ count: 1, skipped: [], rungs: { agents: 1 } });
    const packed = await yes.files!.pack();
    const entry = listTar(packed.tar).find(e => e.path === ".config/gsc/creds.json");
    expect(entry?.mode).toMatch(/^-rw-------/);
    expect(packed.skipped).toEqual([]);
  });
});

describe("packPlan: rc files with secret exports", () => {
  it("writes the carried copy of an rc file the recipe marks, without the export lines, and the archive never holds the value", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), "export PATH=$HOME/bin:$PATH\nexport A_KEY=sk-ant-fake-value\nalias ll='ls -l'\n", { mode: 0o644 });
    const plan = planFiles(
      [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"], secrets: ["A_KEY"], bytes: 10 }), row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"] })],
      { home, stat: statOf, platform: "darwin" },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("export PATH=$HOME/bin:$PATH\nalias ll='ls -l'\n");
    expect(gunzipSync(packed.tar).includes("sk-ant-fake-value")).toBe(false);
    expect(packed.cut).toEqual([{ path: "~/.zshrc", names: ["A_KEY"] }]);
    expect(listTar(packed.tar).find(e => e.path === ".zshrc")?.mode).toMatch(/^-rw-r--r--/);
    expect(packed.skipped).toEqual([]);
    // The laptop's file is untouched.
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain("A_KEY");
  });

  it("strips every rc file it stages whatever the recipe says: a row without a secrets field, and fish's config inside its directory row", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), "export PATH=$HOME/bin:$PATH\nexport OLD_TOKEN=fake-old\n", { mode: 0o644 });
    mkdirSync(join(home, ".config", "fish", "functions"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "set -gx FISH_KEY fake-fish\nset -g theme x\n");
    writeFileSync(join(home, ".config", "fish", "functions", "ll.fish"), "function ll\n  ls -l\nend\n");
    const plan = planFiles(
      [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"], bytes: 10 }), row({ rung: "shell", id: "shell/fish", paths: ["~/.config/fish"], bytes: 60 })],
      { home, stat: statOf, platform: "darwin" },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("export PATH=$HOME/bin:$PATH\n");
    expect(readFileSync(join(dir, ".config", "fish", "config.fish"), "utf8")).toBe("set -g theme x\n");
    expect(readFileSync(join(dir, ".config", "fish", "functions", "ll.fish"), "utf8")).toBe("function ll\n  ls -l\nend\n");
    const bytes = gunzipSync(packed.tar);
    expect(bytes.includes("fake-old")).toBe(false);
    expect(bytes.includes("fake-fish")).toBe(false);
    expect(packed.skipped).toEqual([]);
    expect(packed.cut).toEqual([{ path: "~/.config/fish/config.fish", names: ["FISH_KEY"] }, { path: "~/.zshrc", names: ["OLD_TOKEN"] }]);
  });

  it("an rc file's other copies are stripped too: the target of a linked rc inside a directory row, and a dotted copy by name", async () => {
    const home = laptop();
    mkdirSync(join(home, ".dotfiles"));
    writeFileSync(join(home, ".dotfiles", "zshrc"), "export PATH=$HOME/bin:$PATH\nexport GH_TOKEN=fake-twin-value\n");
    writeFileSync(join(home, ".dotfiles", ".bashrc"), "export B_KEY=fake-dotted-value\nalias g=git\n");
    writeFileSync(join(home, ".dotfiles", "README.md"), "export NOT_RC_TOKEN=kept-here\n");
    symlinkSync(join(home, ".dotfiles", "zshrc"), join(home, ".zshrc"));
    const plan = planFiles(
      [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "shell", id: "shell/dotfiles", paths: ["~/.dotfiles"] })],
      { home, stat: statOf, platform: "darwin" },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("export PATH=$HOME/bin:$PATH\n");
    expect(readFileSync(join(dir, ".dotfiles", "zshrc"), "utf8")).toBe("export PATH=$HOME/bin:$PATH\n");
    expect(readFileSync(join(dir, ".dotfiles", ".bashrc"), "utf8")).toBe("alias g=git\n");
    // A file that is not an rc file by name or by identity keeps its lines: the strip is not a grep over the tree.
    expect(readFileSync(join(dir, ".dotfiles", "README.md"), "utf8")).toBe("export NOT_RC_TOKEN=kept-here\n");
    const bytes = gunzipSync(packed.tar);
    expect(bytes.includes("fake-twin-value")).toBe(false);
    expect(bytes.includes("fake-dotted-value")).toBe(false);
    expect(packed.cut).toEqual([
      { path: "~/.dotfiles/.bashrc", names: ["B_KEY"] },
      { path: "~/.dotfiles/zshrc", names: ["GH_TOKEN"] },
      { path: "~/.zshrc", names: ["GH_TOKEN"] },
    ]);
  });

  it("strips by name only at HOME, one directory deep, and fish's own config; a deeper file with an rc name is left as it is", async () => {
    const home = laptop();
    mkdirSync(join(home, ".dotfiles"));
    writeFileSync(join(home, ".dotfiles", ".zshrc"), "export SHALLOW_KEY=fake-shallow\nalias a=b\n");
    mkdirSync(join(home, ".config", "app", "shell"), { recursive: true });
    writeFileSync(join(home, ".config", "app", ".profile"), "export DEEP_KEY=kept-deep\nset -o vi\n");
    writeFileSync(join(home, ".config", "app", "shell", ".bashrc"), "export DEEPER_KEY=kept-deeper\n");
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "set -gx FISH_KEY fake-fish\nset -g theme x\n");
    const plan = planFiles(
      [
        row({ rung: "shell", id: "shell/dotfiles", paths: ["~/.dotfiles"] }),
        row({ rung: "shell", id: "shell/app", paths: ["~/.config/app"] }),
        row({ rung: "shell", id: "shell/fish", paths: ["~/.config/fish"] }),
      ],
      { home, stat: statOf, platform: "darwin" },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".dotfiles", ".zshrc"), "utf8")).toBe("alias a=b\n");
    expect(readFileSync(join(dir, ".config", "fish", "config.fish"), "utf8")).toBe("set -g theme x\n");
    expect(readFileSync(join(dir, ".config", "app", ".profile"), "utf8")).toBe("export DEEP_KEY=kept-deep\nset -o vi\n");
    expect(readFileSync(join(dir, ".config", "app", "shell", ".bashrc"), "utf8")).toBe("export DEEPER_KEY=kept-deeper\n");
    expect(packed.cut).toEqual([{ path: "~/.config/fish/config.fish", names: ["FISH_KEY"] }, { path: "~/.dotfiles/.zshrc", names: ["SHALLOW_KEY"] }]);
  });

  it("a read-only rc file ships stripped at its own mode, and one without a secret ships untouched", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), "export RO_KEY=fake-ro-value\nalias ll='ls -l'\n", { mode: 0o444 });
    writeFileSync(join(home, ".bashrc"), "alias g=git\n", { mode: 0o444 });
    const plan = planFiles([row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "shell", id: "shell/bashrc", paths: ["~/.bashrc"] })], { home, stat: statOf, platform: "darwin" });
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const modeOf = (p: string) => listTar(packed.tar).find(e => e.path === p)?.mode;
    expect(modeOf(".zshrc")).toMatch(/^-r--r--r--/);
    expect(modeOf(".bashrc")).toMatch(/^-r--r--r--/);
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("alias ll='ls -l'\n");
    expect(readFileSync(join(dir, ".bashrc"), "utf8")).toBe("alias g=git\n");
    expect(packed.cut).toEqual([{ path: "~/.zshrc", names: ["RO_KEY"] }]);
    expect(packed.skipped).toEqual([]);
  });
});

describe("packPlan: source guard", () => {
  it("a bare source line whose file is not in the pack, or sits outside home, is wrapped so the machine skips it; one naming this computer's home is wrapped with the home written as $HOME; one whose file travels, a guarded line and a fish config stay as written; the mode holds", async () => {
    const home = laptop();
    mkdirSync(join(home, ".zsh"));
    writeFileSync(join(home, ".zsh", "functions.zsh"), "f() { :; }\n");
    mkdirSync(join(home, ".config", "fish"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "config.fish"), "source ~/.config/fish/local.fish\n");
    const rc = ['. "$HOME/.cargo/env"', "source ~/.zsh/functions.zsh", `source ${home}/.deno/env  # deno`, "[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh", "export RO_KEY=fake-ro-value", "source $ZSH/oh-my-zsh.sh", "source /opt/homebrew/opt/nvm/nvm.sh", `. "${home}/.zsh/functions.zsh"`, ""].join("\n");
    writeFileSync(join(home, ".zshrc"), rc, { mode: 0o444 });
    const rows = [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "shell", id: "shell/zsh", paths: ["~/.zsh"] }), row({ rung: "shell", id: "shell/fish", paths: ["~/.config/fish"] })];
    const packed = await packPlan(planFiles(rows, { home, stat: statOf, platform: "darwin" }), { secrets: new Map(), home });
    expect(listTar(packed.tar).find(e => e.path === ".zshrc")?.mode).toMatch(/^-r--r--r--/);
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe(['[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"', "source ~/.zsh/functions.zsh", '[ -r "$HOME"/.deno/env ] && source "$HOME"/.deno/env # deno', "[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh", "source $ZSH/oh-my-zsh.sh", "[ -r /opt/homebrew/opt/nvm/nvm.sh ] && source /opt/homebrew/opt/nvm/nvm.sh", '[ -r "$HOME/.zsh/functions.zsh" ] && . "$HOME/.zsh/functions.zsh"', ""].join("\n"));
    expect(readFileSync(join(dir, ".config", "fish", "config.fish"), "utf8")).toBe("source ~/.config/fish/local.fish\n");
    expect(packed.cut).toEqual([{ path: "~/.zshrc", names: ["RO_KEY"] }]);
    const without = await packPlan(planFiles([rows[0]!], { home, stat: statOf, platform: "darwin" }), { secrets: new Map(), home });
    expect(readFileSync(join(extract(without.tar), ".zshrc"), "utf8")).toContain("[ -r ~/.zsh/functions.zsh ] && source ~/.zsh/functions.zsh");
  });
});

describe("packPlan: command guard", () => {
  /** The rc as zsh reads it on a machine with only the base on PATH: what it prints to stderr and its last exit status. */
  const zsh = (dir: string): { stderr: string; status: number } => {
    const r = spawnSync("/bin/zsh", ["-f", "-c", `source ./.zshrc; echo "exit=$?"`], { cwd: dir, encoding: "utf8", env: { HOME: dir, PATH: "/usr/bin:/bin" } });
    return { stderr: r.stderr, status: Number(/exit=(\d+)/.exec(r.stdout)?.[1]) };
  };
  const RC = ['eval "$(starship init zsh)"', "alias ls='eza -la'", "diskbloom --quiet", 'export PATH="$HOME/tools:$PATH"', "zoxide query x", "ls", ""].join("\n");
  /** A stub by that name that prints its call to stderr. */
  const stub = (dir: string, name: string): void => writeFileSync(join(dir, name), `#!/bin/sh\necho real-${name} "$@" >&2\n`, { mode: 0o755 });

  it.skipIf(!existsSync("/bin/zsh"))("an rc file calling tools the image does not have ships behind one guard block naming them, so a shell on the machine starts silent; a guarded tool the rc itself puts on PATH still runs; a tool the recipe ticked is not guarded; the names land on the pack once", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), RC);
    writeFileSync(join(home, ".bashrc"), "eval \"$(starship init bash)\"\n");
    const rows = [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "shell", id: "shell/bashrc", paths: ["~/.bashrc"] })];
    const plan = planFiles(rows, { home, stat: statOf, platform: "darwin" });
    const bare = extract((await packPlan(plan, { secrets: new Map(), home })).tar);
    expect(zsh(bare).stderr).toContain("command not found");

    const none = await packPlan(plan, { secrets: new Map(), home, onImage: new Set(["ls", "cat"]) });
    const dir = extract(none.tar);
    const zshrc = readFileSync(join(dir, ".zshrc"), "utf8");
    const guard = (name: string): string => `${name}() { if (unset -f ${name}; command -v ${name}) >/dev/null 2>&1; then unset -f ${name}; ${name} "$@"; else return 127; fi; }`;
    expect(zshrc).toBe([GUARD_BEGIN, guard("starship"), guard("eza"), guard("diskbloom"), guard("zoxide"), "# Guarded above: a call to one of these that is not on this machine is silent instead of an error: starship, eza, diskbloom, zoxide. Tick them in wsp init to install them.", GUARD_END, "", RC].join("\n"));
    expect(readFileSync(join(dir, ".bashrc"), "utf8")).toBe([GUARD_BEGIN, guard("starship"), "# Guarded above: a call to one of these that is not on this machine is silent instead of an error: starship. Tick them in wsp init to install them.", GUARD_END, "", 'eval "$(starship init bash)"', ""].join("\n"));
    // The guard decides at call time: a tool the rc itself puts on PATH after the block runs, the missing ones are silent.
    mkdirSync(join(dir, "tools"));
    stub(join(dir, "tools"), "zoxide");
    expect(zsh(dir)).toEqual({ stderr: "real-zoxide query x\n", status: 127 });
    mkdirSync(join(dir, "bin"));
    for (const name of ["starship", "eza", "diskbloom"]) stub(join(dir, "bin"), name);
    const real = spawnSync("/bin/zsh", ["-f", "-c", "source ./.zshrc"], { cwd: dir, encoding: "utf8", env: { HOME: dir, PATH: `${join(dir, "bin")}:/usr/bin:/bin` } });
    expect(real.stderr.split("\n").filter(l => l !== "")).toEqual(["real-starship init zsh", "real-diskbloom --quiet", "real-zoxide query x", "real-eza -la"]);
    expect(none.silenced).toEqual(["starship", "eza", "diskbloom", "zoxide"]);

    const withEza = await packPlan(plan, { secrets: new Map(), home, onImage: new Set(["ls", "cat", "eza", "zoxide"]) });
    const two = readFileSync(join(extract(withEza.tar), ".zshrc"), "utf8");
    expect(two).toContain(`${guard("starship")}\n${guard("diskbloom")}\n# Guarded above: a call to one of these that is not on this machine is silent instead of an error: starship, diskbloom.`);
    expect(two).not.toContain("eza()");
    expect(withEza.silenced).toEqual(["starship", "diskbloom"]);

    const all = await packPlan(plan, { secrets: new Map(), home, onImage: new Set(["ls", "eza", "starship", "diskbloom", "zoxide"]) });
    expect(readFileSync(join(extract(all.tar), ".zshrc"), "utf8")).toBe(RC);
    expect(all.silenced).toEqual([]);
  });
});

describe("packPlan: oh-my-zsh plugins", () => {
  it("a plugin named after a tool the recipe knows but the image lacks leaves the plugins list, is named in the guard block and counts as silenced; a plugin that is no tool, or whose tool is on the image, stays", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), "plugins=(\n  git\n  eza\n  z\n  gh\n)\nsource $ZSH/oh-my-zsh.sh\n");
    const plan = planFiles([row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] })], { home, stat: statOf, platform: "darwin" });
    const packed = await packPlan(plan, { secrets: new Map(), home, onImage: new Set(["git", "gh", "z"]), tools: new Set(["git", "gh", "eza", "z"]) });
    expect(readFileSync(join(extract(packed.tar), ".zshrc"), "utf8")).toBe([GUARD_BEGIN, "# plugin eza left out: eza is not on the image", GUARD_END, "", "plugins=(", "  git", "  z", "  gh", ")", "source $ZSH/oh-my-zsh.sh", ""].join("\n"));
    expect(packed.silenced).toEqual(["eza"]);
    const kept = await packPlan(plan, { secrets: new Map(), home, onImage: new Set(["git", "gh", "eza"]), tools: new Set(["git", "gh", "eza"]) });
    expect(readFileSync(join(extract(kept.tar), ".zshrc"), "utf8")).toBe("plugins=(\n  git\n  eza\n  z\n  gh\n)\nsource $ZSH/oh-my-zsh.sh\n");
    expect(kept.silenced).toEqual([]);
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
  it("is the security command with the service and -w, the account before -w when the item is filed per user, built but never run in tests", () => {
    const r = keychainReader();
    expect(r.command("Claude Code-credentials")).toEqual({ file: "security", args: ["find-generic-password", "-s", "Claude Code-credentials", "-w"] });
    expect(r.command("gh:github.com", "Zingzy")).toEqual({ file: "security", args: ["find-generic-password", "-s", "gh:github.com", "-a", "Zingzy", "-w"] });
  });

  it("unwraps the go-keyring form gh stores its token in (74 characters for a 40-character token) and passes any other value through as read", async () => {
    const token = "gho_xfakefakefakefakefakefakefakefakefak";
    expect(token).toHaveLength(40);
    const wrapped = `go-keyring-base64:${Buffer.from(token).toString("base64")}`;
    expect(wrapped).toHaveLength(74);
    const claude = '{"claudeAiOauth":{"accessToken":"sk-ant-x"}}';
    const ran: string[][] = [];
    const r = keychainReader(async (file, args) => {
      ran.push([file, ...args]);
      return { stdout: `${args[2] === "gh:github.com" ? wrapped : claude}\n` };
    });
    await expect(r.read("gh:github.com", "Zingzy")).resolves.toBe(token);
    await expect(r.read("Claude Code-credentials")).resolves.toBe(claude);
    // A helper line runs under sh the way Claude Code runs it, its trailing newline dropped.
    await expect(r.run(HELPER)).resolves.toBe(claude);
    expect(ran).toEqual([
      ["security", "find-generic-password", "-s", "gh:github.com", "-a", "Zingzy", "-w"],
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      ["/bin/sh", "-c", HELPER],
    ]);
  });
});

describe("digestOf", () => {
  it("reads the names, modes and bytes under a path, leaves excludes out, and never reads stat times", async () => {
    const home = laptop();
    const demo = join(home, ".config", "demo");
    mkdirSync(join(demo, "cache"), { recursive: true });
    writeFileSync(join(demo, "settings.json"), "{}\n");
    writeFileSync(join(demo, "cache", "blob"), "1");
    const excludes = [join(demo, "cache")];
    const d0 = digestOf(demo, excludes, home);
    expect(d0).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(demo, "cache", "blob"), "22");
    writeFileSync(join(demo, "settings.json"), "{}\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(demo, "settings.json"), later, later);
    utimesSync(demo, later, later);
    expect(digestOf(demo, excludes, home)).toBe(d0);
    expect(digestOf(demo, [], home)).not.toBe(d0);
    // Same length, one byte different: only the bytes read can tell these apart.
    writeFileSync(join(demo, "settings.json"), "{]\n");
    const d1 = digestOf(demo, excludes, home);
    expect(d1).not.toBe(d0);
    chmodSync(join(demo, "settings.json"), 0o600);
    const d2 = digestOf(demo, excludes, home);
    expect(d2).not.toBe(d1);
    writeFileSync(join(demo, "extra"), "");
    const d3 = digestOf(demo, excludes, home);
    expect(d3).not.toBe(d2);
    // A file that cannot be read digests by its error and is left for the pack to fail on.
    await withRefused(join(demo, "settings.json"), () => {
      expect(digestOf(demo, excludes, home)).toMatch(/^[0-9a-f]{64}$/);
      expect(digestOf(demo, excludes, home)).not.toBe(d3);
    });
    expect(digestOf(demo, excludes, home)).toBe(d3);
  });

  it("a link to the planned directory or one of its parents digests as the pack refuses it: the siblings behind it never enter", () => {
    const home = laptop();
    const demo = join(home, ".config", "demo");
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, "settings.json"), "{}\n");
    symlinkSync(join(home, ".config"), join(demo, "up"));
    symlinkSync(demo, join(demo, "self"));
    const d0 = digestOf(demo, [], home);
    writeFileSync(join(home, ".config", "sibling.txt"), "new\n");
    expect(digestOf(demo, [], home)).toBe(d0);
    writeFileSync(join(demo, "settings.json"), "{]\n");
    expect(digestOf(demo, [], home)).not.toBe(d0);
  });

  it("link targets enter the digest relative to home, so the same layout under another home digests the same", () => {
    const layout = (home: string): string => {
      const demo = join(home, ".config", "demo");
      mkdirSync(demo, { recursive: true });
      writeFileSync(join(demo, "settings.json"), "{}\n");
      symlinkSync(join(home, "nowhere"), join(demo, "gone"));
      symlinkSync(join(home, ".ssh", "id_ed25519"), join(demo, "key"));
      symlinkSync("/etc/hosts", join(demo, "outside"));
      symlinkSync(join(home, ".config"), join(demo, "up"));
      return demo;
    };
    const a = laptop();
    const b = laptop();
    expect(a).not.toBe(b);
    expect(digestOf(layout(a), [], a)).toBe(digestOf(layout(b), [], b));
  });

  it("follows a link into home and reads its target's bytes; a link outside home, to a private key or back into a walked directory digests by where it points", () => {
    const home = laptop();
    const demo = join(home, ".config", "demo");
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(home, ".shared"), "shared\n");
    symlinkSync(join(home, ".shared"), join(demo, "inside"));
    symlinkSync("/etc/hosts", join(demo, "outside"));
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(demo, "key"));
    symlinkSync(demo, join(demo, "loop"));
    const d0 = digestOf(demo, [], home);
    expect(d0).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(home, ".shared"), "changed\n");
    const d1 = digestOf(demo, [], home);
    expect(d1).not.toBe(d0);
    writeFileSync(join(home, ".ssh", "id_ed25519"), "OTHER PRIVATE", { mode: 0o600 });
    expect(digestOf(demo, [], home)).toBe(d1);
    expect(digestOf(join(demo, "inside"), [], home)).toBe(digestOf(join(home, ".shared"), [], home));
  });
});

describe("importFor", () => {
  const ticks = (home: string, ...over: ManifestEntry[]) =>
    importFor(
      [
        row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"], bytes: 20 }),
        row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], bytes: 5 }),
        row({ rung: "agents", id: "agents/codex", paths: ["~/.codex/config.toml"] }),
        row({ rung: "tools", id: "tools/brew/yq", linux: "yes" }),
        row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", linux: "unknown" }),
        row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }),
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
        ...over,
      ],
      { home, secrets: new Map(), platform: "darwin" },
    );

  it("with every row of the manifest, the MCP plan names each agent's config on the guest, keeps the ticked servers and drops the rest; MCP rows are never agents to install", () => {
    const home = laptop();
    const all: ManifestEntry[] = [
      row({ rung: "agents", id: "agents/claude", paths: ["~/.claude.json"] }),
      row({ rung: "agents", id: "agents/mcp/claude/github" }),
      row({ rung: "agents", id: "agents/mcp/claude/notes", bring: false, default: "skip", reason: "command ~/Library/x is macOS-only, will not run" }),
      row({ rung: "agents", id: "agents/mcp/claude/home/zomato" }),
      row({ rung: "agents", id: "agents/mcp/claude/gsc", consent: true, choice: "skip" }),
      row({ rung: "agents", id: "agents/codex", bring: false }),
      row({ rung: "agents", id: "agents/mcp/codex/grafana" }),
    ];
    const picked = all.filter(e => e.bring);
    const imp = importFor(picked, { home, secrets: new Map(), platform: "darwin", rows: all });
    expect(imp.mcp).toEqual({
      agents: [
        {
          id: "claude", label: "Claude Code",
          scopes: [
            { files: ["/root/.claude-cfg/.claude.json"], format: MCP_SERVERS_JSON, keep: ["github"], drop: [{ name: "notes", reason: "command ~/Library/x is macOS-only, will not run" }, { name: "gsc", reason: "credential-shaped; not copied without your answer on its row" }] },
            { files: ["/root/.claude-cfg/.claude.json"], format: MCP_SERVERS_JSON, project: { from: home, to: "/root" }, keep: ["zomato"], drop: [] },
          ],
          aside: [],
        },
        { id: "codex", label: "Codex", scopes: [], aside: [{ id: "agents/mcp/codex/grafana", name: "grafana", reason: "Codex is not ticked, so its config did not travel" }] },
      ],
      guestHome: "/root",
      rewrites: [[`${home}/`, "/root/"], ["/opt/homebrew/", "/home/linuxbrew/.linuxbrew/"]],
      binDirs: [`${home}/.local/bin/`, "~/.local/bin/", "/opt/homebrew/bin/", "/opt/homebrew/sbin/", "/usr/local/bin/", "/usr/bin/", "/bin/"],
      tools: [],
    });
    expect(imp.agents.map(a => a.id)).toEqual(["agents/claude"]);
    expect(imp.skippedAgents).toEqual([]);
    expect(importFor(picked, { home, secrets: new Map(), platform: "darwin" }).mcp).toBeUndefined();
  });

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
    expect(imp.tools.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/yq", "tools/npm/bun"]);
    expect(imp.node).toMatchObject({ floor: 16, version: NODE_RELEASES[22].version, agents: ["Codex"] });
    expect(imp.agents.map(a => [a.id, a.install, a.smoke])).toEqual([
      ["agents/claude", GOLDEN_SETUP, GOLDEN_SMOKE],
      ["agents/codex", expect.stringContaining("npm install -g @openai/codex@"), "codex --version"],
    ]);
    expect(imp.skippedAgents).toEqual([]);
    expect(imp.baseTools).toEqual([]);
    expect(ticks(home, row({ rung: "agents", id: "agents/zed", label: "Zed" })).skippedAgents).toEqual([{ id: "agents/zed", name: "Zed", note: "no installer known" }]);
    // A ticked row the base floor covers is no step and no skip: it lands in the result as installed, by the base row's name.
    const covered = ticks(home, row({ rung: "tools", id: "tools/brew/jq", label: "jq" }), row({ rung: "tools", id: "tools/npm/pnpm", label: "pnpm" }));
    expect(covered.tools.map(t => t.id)).not.toContain("tools/brew/jq");
    expect(covered.skippedTools!.map(s => s.id)).not.toContain("tools/brew/jq");
    expect(covered.baseTools).toEqual([{ id: "tools/brew/jq", label: "jq", note: "jq is part of the base" }, { id: "tools/npm/pnpm", label: "pnpm", note: "pnpm is part of the base" }]);
  });

  it("carries the person's shell when zsh's rows are ticked, with the frameworks among them, and none when only bash's are", () => {
    const home = laptop();
    const zsh = ticks(home, row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "shell", id: "shell/oh-my-zsh", paths: ["~/.oh-my-zsh/custom"] }));
    expect(zsh.shell).toMatchObject({ shell: "zsh", frameworks: ["shell/oh-my-zsh"] });
    expect(zsh.shell?.cmd).toContain('chsh -s "$(command -v zsh)"');
    expect(ticks(home, row({ rung: "shell", id: "shell/bashrc", paths: ["~/.bashrc"] }))).not.toHaveProperty("shell");
  });

  it("the recipe hash follows the shipped file's bytes, not its stat times: a rewrite with the same bytes keeps it, a changed byte moves it", () => {
    const home = laptop();
    const before = ticks(home).recipeHash;
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Me\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(home, ".gitconfig"), later, later);
    expect(ticks(home).recipeHash).toBe(before);
    expect(ticks(home).recipe).toMatchObject({
      ticks: expect.arrayContaining([{ id: "identity/git-user" }, { id: "logins/gh", choice: "copy" }, expect.objectContaining({ id: "tools/npm/bun", version: "1.4.0", road: "npm" })]),
      files: expect.arrayContaining([{ id: "identity/git-user", path: "~/.gitconfig", dest: ".gitconfig", digest: expect.stringMatching(/^[0-9a-f]{64}$/) }]),
    });
    // Same length, one byte different: the size in the digest line cannot carry this.
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Mo\n");
    expect(ticks(home).recipeHash).not.toBe(before);
  });

  it("a volatile file travels but never moves the recipe hash, and packs on its own for the re-import on attach", async () => {
    const home = laptop();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { a: 1 } }));
    // A row the catalog does not know, so the saved list alone decides here; the catalog's own row is the next test.
    const rows = (volatile?: string[]) => [
      row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"], bytes: 20 }),
      row({ rung: "agents", id: "agents/zed", paths: ["~/.claude/settings.json", "~/.claude.json"], ...(volatile !== undefined ? { volatile } : {}), bytes: 5 }),
    ];
    const imp = (volatile?: string[]) => importFor(rows(volatile), { home, secrets: new Map(), platform: "darwin" });
    const before = imp(["~/.claude.json"]);
    expect(before.recipe?.files.map(f => [f.path, f.volatile])).toEqual([["~/.claude.json", true], ["~/.claude/settings.json", undefined], ["~/.gitconfig", undefined]]);
    expect(before.files?.volatile?.paths).toEqual(["~/.claude.json"]);
    const plain = imp().recipeHash;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { a: 1, b: 2 } }));
    expect(imp(["~/.claude.json"]).recipeHash).toBe(before.recipeHash);
    expect(imp().recipeHash).not.toBe(plain);
    writeFileSync(join(home, ".claude", "settings.json"), "{]\n");
    expect(imp(["~/.claude.json"]).recipeHash).not.toBe(before.recipeHash);
    const packed = await before.files!.volatile!.pack();
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "" && !p.endsWith("/"))).toEqual([".claude-cfg/.claude.json"]);
    expect(packed.skipped).toEqual([]);
    expect(imp().files?.volatile).toBeUndefined();
  });

  it("a Claude row saved without a volatile list gets the catalog's: ~/.claude.json stays out of the hash and packs for the re-import", () => {
    const home = laptop();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { a: 1 } }));
    // The row as a recipe file from before the list existed carries it: paths only.
    const saved = [row({ rung: "agents", id: "agents/claude", paths: ["~/.claude/settings.json", "~/.claude.json"], bytes: 5 })];
    const imp = () => importFor(saved, { home, secrets: new Map(), platform: "darwin" });
    const before = imp();
    expect(before.recipe?.files.map(f => [f.path, f.volatile])).toEqual([["~/.claude.json", true], ["~/.claude/settings.json", undefined]]);
    expect(before.files?.volatile?.paths).toEqual(["~/.claude.json"]);
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { a: 1, b: 2 } }));
    expect(imp().recipeHash).toBe(before.recipeHash);
    // A saved list that names a path the catalog does not is kept only where the catalog has no row.
    const other = importFor([row({ rung: "agents", id: "agents/zed", paths: ["~/.gitconfig"], volatile: ["~/.gitconfig"], bytes: 5 })], { home, secrets: new Map(), platform: "darwin" });
    expect(other.recipe?.files.map(f => [f.path, f.volatile])).toEqual([["~/.gitconfig", true]]);
    expect(other.files?.volatile?.paths).toEqual(["~/.gitconfig"]);
  });

  it("a row the catalog knows takes the catalog's list even when the saved row carries one: a codex config change moves the hash", () => {
    const home = laptop();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "model = \"a\"\n");
    const saved = [row({ rung: "agents", id: "agents/codex", paths: ["~/.codex/config.toml"], volatile: ["~/.codex/config.toml"], bytes: 5 })];
    const imp = () => importFor(saved, { home, secrets: new Map(), platform: "darwin" });
    const before = imp();
    expect(before.recipe?.files.map(f => [f.path, f.volatile])).toEqual([["~/.codex/config.toml", undefined]]);
    expect(before.files?.volatile).toBeUndefined();
    writeFileSync(join(home, ".codex", "config.toml"), "model = \"b\"\n");
    expect(imp().recipeHash).not.toBe(before.recipeHash);
  });

  it("a Keychain login enters the digest as the sha256 of its value once read, marked volatile, out of the hash; its files re-render and re-upload on attach", async () => {
    const home = laptop();
    const secrets = new Map<string, string>();
    const gh = [row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy", bytes: 200 })];
    const imp = () => importFor(gh, { home, secrets, platform: "darwin" });
    const unread = imp();
    // Before the Keychain is read the file is already volatile and the value has no entry yet.
    expect(unread.recipe?.files).toEqual([{ id: "logins/gh", path: "~/.config/gh/hosts.yml", dest: ".config/gh/hosts.yml", digest: expect.stringMatching(/^[0-9a-f]{64}$/), volatile: true }]);
    // One entry per account this computer's hosts.yml lists, each under its own key.
    secrets.set("gh:github.com (other)", "gho_o1");
    secrets.set("gh:github.com (Zingzy)", "gho_one");
    const one = imp();
    expect(one.recipe?.files.filter(f => f.path.startsWith("Keychain:"))).toEqual([
      { id: "logins/gh", path: "Keychain: gh:github.com (Zingzy)", dest: ".config/gh/hosts.yml", digest: createHash("sha256").update("gho_one").digest("hex"), volatile: true },
      { id: "logins/gh", path: "Keychain: gh:github.com (other)", dest: ".config/gh/hosts.yml", digest: createHash("sha256").update("gho_o1").digest("hex"), volatile: true },
    ]);
    expect(one.recipeHash).toBe(unread.recipeHash);
    // The same import read after the Keychain: the getter sees the value the Map holds now.
    secrets.set("gh:github.com (Zingzy)", "gho_two");
    expect(unread.recipe?.files.find(f => f.path === "Keychain: gh:github.com (Zingzy)")?.digest).toBe(createHash("sha256").update("gho_two").digest("hex"));
    expect(imp().recipeHash).toBe(unread.recipeHash);
    expect(one.files?.volatile?.paths).toEqual(["~/.config/gh/hosts.yml", "Keychain: gh:github.com (other)", "Keychain: gh:github.com (Zingzy)"]);
    const packed = await one.files!.volatile!.pack();
    expect(listTar(packed.tar).map(e => e.path).filter(p => p !== "" && !p.endsWith("/"))).toEqual([".config/gh/hosts.yml"]);
    const hosts = gunzipSync(packed.tar).toString("utf8");
    expect(hosts).toContain("github.com:\n    oauth_token: gho_two\n");
    expect(hosts).toContain("        other:\n            oauth_token: gho_o1\n        Zingzy:\n            oauth_token: gho_two\n");
  });

  it("the plan carries the skips it made itself, and the results go next to the recipe", async () => {
    const home = laptop();
    const results: unknown[] = [];
    const onResult = (r: unknown) => void results.push(r);
    const imp = importFor([row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", linux: "unknown" })], {
      home,
      secrets: new Map(),
      platform: "darwin",
      onResult,
    });
    expect(imp.files).toBeUndefined();
    expect(imp.node).toBeUndefined();
    expect(imp.skippedTools).toEqual([{ id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", note: "no Linux bottle known" }]);
    expect(imp.onResult).toBe(onResult);
    expect(importResultPath("/x/state.json")).toBe("/x/golden-import.json");
  });
});
