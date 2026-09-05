// SPDX-License-Identifier: AGPL-3.0-only
// The impure half of golden import on the laptop: packing the planned files
// into one archive with their modes, reading Keychain logins through an
// injected reader (the real one is never run here), and the import the
// recipe's ticks add up to.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "@wsp/collect";
import { NODE_RELEASES, planFiles } from "@wsp/engine";
import { afterEach, describe, expect, it } from "vitest";
import { GOLDEN_SETUP, GOLDEN_SMOKE } from "../src/doctor.js";
import { digestOf, importFor, importResultPath, keychainLogins, keychainReader, packPlan, readSecrets, statOf, type SecretReader } from "../src/init-import.js";

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

/** A Keychain with the given items, keyed as the secrets map is (see secretKey); every read is recorded as [service, account]. */
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
    // An account with no item of its own refuses the row, and the reason names the account.
    const partial = await readSecrets(wanted.slice(0, 2), reader({ "gh:github.com (Zingzy)": "gho_fake_token" }));
    expect([...partial.values.keys()]).toEqual(["gh:github.com (Zingzy)"]);
    expect(partial.refused).toEqual([{ id: "logins/gh", service: "gh:github.com", reason: "other: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." }]);
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
    // One account's token missing keeps the whole row home: hosts.yml and both items are noted, the file does not travel.
    const partial = await packPlan(plan, { secrets: new Map([["gh:github.com (Zingzy)", "gho_fake_token"]]), home });
    expect(partial.skipped.map(s => [s.path, s.note])).toEqual([
      ["~/.config/gh/hosts.yml", "not read from the Keychain; sign in on the machine"],
      ["Keychain: gh:github.com (other)", "not read from the Keychain; sign in on the machine"],
      ["Keychain: Claude Code-credentials", "not read from the Keychain; sign in on the machine"],
    ]);
    expect(listTar(partial.tar).some(e => e.path.includes("hosts.yml"))).toBe(false);
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

describe("packPlan: everything rows", () => {
  function demo(home: string): void {
    mkdirSync(join(home, ".config", "demo", "cache"), { recursive: true });
    writeFileSync(join(home, ".config", "demo", "settings.toml"), "theme = 1\n");
    writeFileSync(join(home, ".config", "demo", "cache", "blob"), "x".repeat(2_000));
    writeFileSync(join(home, ".demo-token"), "fake-token\n", { mode: 0o600 });
  }

  it("copies a row's paths minus its excludes: the excluded subtree is not in the archive and is not a skip", async () => {
    const home = laptop();
    demo(home);
    const plan = planFiles(
      [row({ rung: "everything", id: "everything/.config/demo", paths: ["~/.config/demo"], excludes: ["~/.config/demo/cache"], bytes: 10 })],
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
    const token = (over: Partial<ManifestEntry>): ManifestEntry => row({ rung: "everything", id: "everything/.demo-token", paths: ["~/.demo-token"], bytes: 11, consent: true, ...over });
    const noAnswer = importFor([token({})], { home, secrets: new Map(), platform: "darwin" });
    expect(noAnswer.files).toMatchObject({ count: 0, skipped: [{ id: "everything/.demo-token", path: "~/.demo-token", note: "credential-shaped; not copied without your answer on its row" }] });
    const yes = importFor([token({ choice: "copy" })], { home, secrets: new Map(), platform: "darwin" });
    expect(yes.files).toMatchObject({ count: 1, skipped: [], rungs: { everything: 1 } });
    const packed = await yes.files!.pack();
    const entry = listTar(packed.tar).find(e => e.path === ".demo-token");
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
      [row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }), row({ rung: "everything", id: "everything/.dotfiles", paths: ["~/.dotfiles"] })],
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
        row({ rung: "everything", id: "everything/.dotfiles", paths: ["~/.dotfiles"] }),
        row({ rung: "everything", id: "everything/.config/app", paths: ["~/.config/app"] }),
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

  it("inside a dotfiles-manager home a plain copy is stripped by its mapped name: ~/.dotfiles/zshrc and chezmoi's dot_zshrc, not a README", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), "export PATH=$HOME/bin:$PATH\nexport OWN_KEY=fake-own\n");
    mkdirSync(join(home, ".dotfiles", "zsh"), { recursive: true });
    writeFileSync(join(home, ".dotfiles", "zshrc"), "export PATH=$HOME/bin:$PATH\nexport PLAIN_KEY=fake-plain\n");
    writeFileSync(join(home, ".dotfiles", "zsh", "aliases"), "alias g=git\nexport ALIAS_TOKEN=fake-alias\n");
    writeFileSync(join(home, ".dotfiles", "README.md"), "export README_TOKEN=kept\n");
    mkdirSync(join(home, ".local", "share", "chezmoi", "dot_config", "fish"), { recursive: true });
    writeFileSync(join(home, ".local", "share", "chezmoi", "dot_zshrc"), "export CHEZ_KEY=fake-chez\nalias ll='ls -l'\n");
    writeFileSync(join(home, ".local", "share", "chezmoi", "dot_config", "fish", "config.fish"), "set -gx CHEZ_FISH_KEY fake-chez-fish\nset -g theme x\n");
    writeFileSync(join(home, ".local", "share", "chezmoi", "dot_gitconfig"), "[user]\n\tname = Me\n");
    const plan = planFiles(
      [
        row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }),
        row({ rung: "everything", id: "everything/.dotfiles", paths: ["~/.dotfiles"] }),
        row({ rung: "everything", id: "everything/.local/share/chezmoi", paths: ["~/.local/share/chezmoi"] }),
      ],
      { home, stat: statOf, platform: "darwin" },
    );
    const packed = await packPlan(plan, { secrets: new Map(), home });
    const dir = extract(packed.tar);
    expect(readFileSync(join(dir, ".zshrc"), "utf8")).toBe("export PATH=$HOME/bin:$PATH\n");
    expect(readFileSync(join(dir, ".dotfiles", "zshrc"), "utf8")).toBe("export PATH=$HOME/bin:$PATH\n");
    expect(readFileSync(join(dir, ".dotfiles", "zsh", "aliases"), "utf8")).toBe("alias g=git\n");
    expect(readFileSync(join(dir, ".dotfiles", "README.md"), "utf8")).toBe("export README_TOKEN=kept\n");
    expect(readFileSync(join(dir, ".local", "share", "chezmoi", "dot_zshrc"), "utf8")).toBe("alias ll='ls -l'\n");
    expect(readFileSync(join(dir, ".local", "share", "chezmoi", "dot_config", "fish", "config.fish"), "utf8")).toBe("set -g theme x\n");
    expect(readFileSync(join(dir, ".local", "share", "chezmoi", "dot_gitconfig"), "utf8")).toBe("[user]\n\tname = Me\n");
    const bytes = gunzipSync(packed.tar);
    for (const v of ["fake-own", "fake-plain", "fake-alias", "fake-chez", "fake-chez-fish"]) expect(bytes.includes(v)).toBe(false);
    expect(packed.cut).toEqual([
      { path: "~/.dotfiles/zsh/aliases", names: ["ALIAS_TOKEN"] },
      { path: "~/.dotfiles/zshrc", names: ["PLAIN_KEY"] },
      { path: "~/.local/share/chezmoi/dot_config/fish/config.fish", names: ["CHEZ_FISH_KEY"] },
      { path: "~/.local/share/chezmoi/dot_zshrc", names: ["CHEZ_KEY"] },
      { path: "~/.zshrc", names: ["OWN_KEY"] },
    ]);
  });

  it("the mapping reaches chezmoi's attribute prefixes and .tmpl, fish's conf.d, a stow directory the row names, and one level of what an rc sources", async () => {
    const home = laptop();
    writeFileSync(join(home, ".zshrc"), "source ~/.zsh/secrets.zsh\nsource ~/.zsh/*.zsh\nexport PATH=$HOME/bin:$PATH\n");
    mkdirSync(join(home, ".zsh"));
    writeFileSync(join(home, ".zsh", "secrets.zsh"), "export SRC_KEY=fake-sourced\nsource ~/.zsh/level2.zsh\nalias s=ls\n");
    writeFileSync(join(home, ".zsh", "level2.zsh"), "export L2_KEY=kept-two-levels-down\n");
    mkdirSync(join(home, ".config", "fish", "conf.d"), { recursive: true });
    writeFileSync(join(home, ".config", "fish", "conf.d", "work.fish"), "set -gx WORK_KEY fake-confd\nset -g theme x\n");
    writeFileSync(join(home, ".config", "fish", "conf.d", "notes.txt"), "set -gx NOTE_KEY kept-not-fish\n");
    const chez = join(home, ".local", "share", "chezmoi");
    mkdirSync(join(chez, "exact_dot_config", "fish", "conf.d"), { recursive: true });
    mkdirSync(join(chez, "dot_config", "app"), { recursive: true });
    writeFileSync(join(chez, "private_dot_zshrc"), "export PRIV_KEY=fake-priv\nalias a=b\n");
    writeFileSync(join(chez, "dot_zshrc.tmpl"), "export TMPL_KEY={{ fake-tmpl }}\nalias c=d\n");
    writeFileSync(join(chez, "exact_dot_config", "fish", "conf.d", "private_work.fish.tmpl"), "set -gx CHEZ_CONFD_KEY fake-chez-confd\nset -g y 1\n");
    writeFileSync(join(chez, "dot_config", "app", "settings"), "export APP_TOKEN=kept-not-rc\n");
    writeFileSync(join(chez, "private_dot_gitconfig"), "[user]\n\tname = Me\n");
    mkdirSync(join(home, "code", "dots", "zsh"), { recursive: true });
    writeFileSync(join(home, "code", "dots", "zsh", ".zshrc"), "export STOW_KEY=fake-stow\nalias e=f\n");
    writeFileSync(join(home, "code", "dots", "zsh", "aliases"), "export STOW_ALIAS_TOKEN=fake-stow-alias\n");
    mkdirSync(join(home, "code", "other"));
    writeFileSync(join(home, "code", "other", "zshrc"), "export OTHER_KEY=kept-not-a-manager-home\n");
    const imp = importFor(
      [
        row({ rung: "shell", id: "shell/zshrc", paths: ["~/.zshrc"] }),
        row({ rung: "shell", id: "shell/fish", paths: ["~/.config/fish"] }),
        row({ rung: "everything", id: "everything/.zsh", paths: ["~/.zsh"] }),
        row({ rung: "everything", id: "everything/.local/share/chezmoi", paths: ["~/.local/share/chezmoi"], manager: "chezmoi" }),
        row({ rung: "everything", id: "everything/code/dots", paths: ["~/code/dots"], manager: "stow" }),
        row({ rung: "everything", id: "everything/code/other", paths: ["~/code/other"] }),
      ],
      { home, secrets: new Map(), platform: "darwin" },
    );
    const packed = await imp.files!.pack();
    const dir = extract(packed.tar);
    const read = (...p: string[]) => readFileSync(join(dir, ...p), "utf8");
    expect(read(".zshrc")).toBe("source ~/.zsh/secrets.zsh\nsource ~/.zsh/*.zsh\nexport PATH=$HOME/bin:$PATH\n");
    expect(read(".zsh", "secrets.zsh")).toBe("source ~/.zsh/level2.zsh\nalias s=ls\n");
    expect(read(".zsh", "level2.zsh")).toBe("export L2_KEY=kept-two-levels-down\n");
    expect(read(".config", "fish", "conf.d", "work.fish")).toBe("set -g theme x\n");
    expect(read(".config", "fish", "conf.d", "notes.txt")).toBe("set -gx NOTE_KEY kept-not-fish\n");
    expect(read(".local", "share", "chezmoi", "private_dot_zshrc")).toBe("alias a=b\n");
    expect(read(".local", "share", "chezmoi", "dot_zshrc.tmpl")).toBe("alias c=d\n");
    expect(read(".local", "share", "chezmoi", "exact_dot_config", "fish", "conf.d", "private_work.fish.tmpl")).toBe("set -g y 1\n");
    expect(read(".local", "share", "chezmoi", "dot_config", "app", "settings")).toBe("export APP_TOKEN=kept-not-rc\n");
    expect(read(".local", "share", "chezmoi", "private_dot_gitconfig")).toBe("[user]\n\tname = Me\n");
    expect(read("code", "dots", "zsh", ".zshrc")).toBe("alias e=f\n");
    expect(read("code", "dots", "zsh", "aliases")).toBe("");
    expect(read("code", "other", "zshrc")).toBe("export OTHER_KEY=kept-not-a-manager-home\n");
    const bytes = gunzipSync(packed.tar);
    expect(bytes.includes("fake-")).toBe(false);
    for (const v of ["kept-two-levels-down", "kept-not-fish", "kept-not-rc", "kept-not-a-manager-home"]) expect(bytes.includes(v), v).toBe(true);
    expect(packed.cut).toEqual([
      { path: "~/.config/fish/conf.d/work.fish", names: ["WORK_KEY"] },
      { path: "~/.local/share/chezmoi/dot_zshrc.tmpl", names: ["TMPL_KEY"] },
      { path: "~/.local/share/chezmoi/exact_dot_config/fish/conf.d/private_work.fish.tmpl", names: ["CHEZ_CONFD_KEY"] },
      { path: "~/.local/share/chezmoi/private_dot_zshrc", names: ["PRIV_KEY"] },
      { path: "~/.zsh/secrets.zsh", names: ["SRC_KEY"] },
      { path: "~/code/dots/zsh/.zshrc", names: ["STOW_KEY"] },
      { path: "~/code/dots/zsh/aliases", names: ["STOW_ALIAS_TOKEN"] },
    ]);
    expect(packed.skipped).toEqual([]);
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
    expect(ran).toEqual([
      ["security", "find-generic-password", "-s", "gh:github.com", "-a", "Zingzy", "-w"],
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    ]);
  });
});

describe("digestOf", () => {
  it("reads the names, modes and bytes under a path, leaves excludes out, and never reads stat times", () => {
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
    chmodSync(join(demo, "settings.json"), 0o000);
    expect(digestOf(demo, excludes, home)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(demo, excludes, home)).not.toBe(d3);
    chmodSync(join(demo, "settings.json"), 0o600);
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
        row({ rung: "tools", id: "tools/brew/jq", linux: "yes" }),
        row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", linux: "unknown" }),
        row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0", version: "1.4.0" }),
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml", "Keychain: gh:github.com"], choice: "copy" }),
        ...over,
      ],
      { home, secrets: new Map(), platform: "darwin" },
    );

  it("ticked editors rows become installs ahead of the tools, and their settings.json lands in the remote server's data dir", () => {
    const home = laptop();
    mkdirSync(join(home, "Library", "Application Support", "Code", "User"), { recursive: true });
    writeFileSync(join(home, "Library", "Application Support", "Code", "User", "settings.json"), "{}\n");
    const imp = ticks(
      home,
      row({ rung: "editors", id: "editors/nvim", label: "neovim, installed with your config", paths: ["~/.config/nvim"], bytes: 10 }),
      row({ rung: "editors", id: "editors/vscode", label: "VS Code settings, for VS Code over SSH", paths: ["~/Library/Application Support/Code/User/settings.json"], bytes: 3 }),
      row({ rung: "editors", id: "editors/vscode-ext/ms-python.python", label: "ms-python.python" }),
    );
    expect(imp.tools.map(t => t.id)).toEqual(["editors/nvim", "editors/vscode-ext", "tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/jq", "tools/npm/bun"]);
    expect(imp.recipe?.files.map(f => f.dest)).toContain(".vscode-server/data/Machine/settings.json");
  });

  it("with every row of the manifest, the MCP plan names each agent's config on the guest, keeps the ticked servers and drops the rest; MCP rows are never agents to install", () => {
    const home = laptop();
    const all: ManifestEntry[] = [
      row({ rung: "agents", id: "agents/claude", paths: ["~/.claude.json"] }),
      row({ rung: "agents", id: "agents/mcp/claude/github" }),
      row({ rung: "agents", id: "agents/mcp/claude/notes", bring: false, default: "skip", reason: "command ~/Library/x is macOS-only, will not run" }),
      row({ rung: "agents", id: "agents/mcp/claude/home/zomato" }),
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
            { files: ["/root/.claude-cfg/.claude.json"], format: "claude", keep: ["github"], drop: [{ name: "notes", reason: "command ~/Library/x is macOS-only, will not run" }] },
            { files: ["/root/.claude-cfg/.claude.json"], format: "claude", project: { from: home, to: "/root" }, keep: ["zomato"], drop: [] },
          ],
          aside: [],
        },
        { id: "codex", label: "Codex", scopes: [], aside: [{ id: "agents/mcp/codex/grafana", name: "grafana", reason: "Codex is not ticked, so its config did not travel" }] },
      ],
      guestHome: "/root",
      rewrites: [[`${home}/`, "/root/"], ["/opt/homebrew/", "/home/linuxbrew/.linuxbrew/"]],
      binDirs: [`${home}/.local/bin/`, "~/.local/bin/", "/opt/homebrew/bin/", "/opt/homebrew/sbin/", "/usr/local/bin/", "/usr/bin/", "/bin/"],
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
    expect(imp.tools.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew-toolchain/glibc", "tools/brew-toolchain/gcc", "tools/brew/jq", "tools/npm/bun"]);
    expect(imp.node).toMatchObject({ floor: 16, version: NODE_RELEASES[22].version, agents: ["Codex"] });
    expect(imp.agents.map(a => [a.id, a.install, a.smoke])).toEqual([
      ["agents/claude", GOLDEN_SETUP, GOLDEN_SMOKE],
      ["agents/codex", expect.stringContaining("npm install -g @openai/codex@"), "codex --version"],
    ]);
    expect(imp.skippedAgents).toEqual([]);
    expect(ticks(home, row({ rung: "agents", id: "agents/zed", label: "Zed" })).skippedAgents).toEqual([{ id: "agents/zed", name: "Zed", note: "no installer known" }]);
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
      ticks: expect.arrayContaining([{ id: "identity/git-user" }, { id: "logins/gh", choice: "copy" }, { id: "tools/npm/bun", version: "1.4.0" }]),
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
