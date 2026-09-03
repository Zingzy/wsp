// SPDX-License-Identifier: AGPL-3.0-only
// The impure half of golden import on the laptop: packing the planned files
// into one archive with their modes, reading Keychain logins through an
// injected reader (the real one is never run here), and the import the
// recipe's ticks add up to.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestEntry } from "@wsp/collect";
import { planFiles } from "@wsp/engine";
import { afterEach, describe, expect, it } from "vitest";
import { GOLDEN_SETUP, GOLDEN_SMOKE } from "../src/doctor.js";
import { importFor, importResultPath, keychainReader, packPlan, type SecretReader } from "../src/init-import.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function laptop(): string {
  const home = mkdtempSync(join(tmpdir(), "wsp-import-home-"));
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

const stat = (abs: string) => {
  try {
    const st = statSync(abs);
    return { mode: st.mode & 0o7777, dir: st.isDirectory() };
  } catch {
    return undefined;
  }
};

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
      if (v === undefined) throw new Error(`security: The specified item could not be found in the keychain. (${service})`);
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

describe("packPlan", () => {
  it("packs the planned files under their guest paths with the laptop's modes, .ssh closed to 700", async () => {
    const home = laptop();
    const plan = planFiles(
      [
        row({ rung: "identity", id: "identity/git-user", paths: ["~/.gitconfig"] }),
        row({ rung: "identity", id: "identity/ssh-config", paths: ["~/.ssh/config"] }),
        row({ rung: "shell", id: "shell/oh-my-zsh", paths: ["~/.oh-my-zsh/custom"] }),
      ],
      { home, stat, platform: "darwin" },
    );
    const secrets = reader({});
    const packed = await packPlan(plan, { secrets });
    expect(packed.bytes).toBe(packed.tar.length);
    expect(packed.skipped).toEqual([]);
    expect(secrets.reads).toEqual([]);
    const entries = listTar(packed.tar);
    const modeOf = (p: string) => entries.find(e => e.path === p || e.path === `${p}/`)?.mode;
    expect(modeOf(".gitconfig")).toMatch(/^-rw-r--r--/);
    expect(modeOf(".ssh")).toMatch(/^drwx------/);
    expect(modeOf(".ssh/config")).toMatch(/^-rw-------/);
    expect(modeOf(".oh-my-zsh/custom/plugins/x/x.zsh")).toMatch(/^-rwxr-xr-x/);
    expect(entries.some(e => e.path.includes("id_ed25519"))).toBe(false);
  });

  it("reads each Keychain login once, places it, and turns a refused read into a note instead of a failure", async () => {
    const home = laptop();
    const plan = planFiles(
      [
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" }),
        row({ rung: "logins", id: "logins/claude", paths: ["Keychain: Claude Code-credentials"], choice: "copy" }),
      ],
      { home, stat, platform: "darwin", rewrites: [[".claude/", ".claude-cfg/"]] },
    );
    const secrets = reader({ "gh:github.com": "gho_fake_token" });
    const packed = await packPlan(plan, { secrets });
    expect(secrets.reads).toEqual(["gh:github.com", "Claude Code-credentials"]);
    expect(packed.skipped).toEqual([{ id: "logins/claude", path: "Keychain: Claude Code-credentials", note: "Keychain read refused or failed; sign in on the machine" }]);
    const dir = mkdtempSync(join(tmpdir(), "wsp-import-x-"));
    dirs.push(dir);
    writeFileSync(join(dir, "a.tgz"), packed.tar);
    execFileSync("tar", ["-xzf", join(dir, "a.tgz"), "-C", dir]);
    const hosts = execFileSync("cat", [join(dir, ".config/gh/hosts.yml")], { encoding: "utf8" });
    expect(hosts).toBe("github.com:\n    oauth_token: gho_fake_token\n    git_protocol: ssh\n    users:\n        Zingzy:\n            oauth_token: gho_fake_token\n    user: Zingzy\n");
    expect(statSync(join(dir, ".config/gh/hosts.yml")).mode & 0o777).toBe(0o600);
    expect(listTar(packed.tar).some(e => e.path.includes(".credentials.json"))).toBe(false);
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
        row({ rung: "tools", id: "tools/npm/bun", label: "bun@1.4.0" }),
        row({ rung: "logins", id: "logins/gh", paths: ["~/.config/gh/hosts.yml"], choice: "copy" }),
        ...over,
      ],
      { home, secrets: reader({}), platform: "darwin" },
    );

  it("maps the ticks to files (Claude's dir under the guest config dir), tools, and agents with Claude on the sanctioned line", () => {
    const home = laptop();
    const imp = ticks(home);
    expect(imp.recipeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(imp.files).toMatchObject({ count: 3, rungs: { identity: 1, logins: 2 }, bytes: 20 });
    expect(imp.files?.skipped).toEqual([
      { id: "agents/claude", path: "~/.claude/settings.json", note: "no longer on this computer" },
      { id: "agents/claude", path: "~/.claude.json", note: "no longer on this computer" },
      { id: "agents/codex", path: "~/.codex/config.toml", note: "no longer on this computer" },
    ]);
    expect(imp.tools.map(t => t.id)).toEqual(["tools/homebrew", "tools/brew/jq", "tools/npm/bun"]);
    expect(imp.agents.map(a => [a.id, a.install, a.smoke])).toEqual([
      ["agents/claude", GOLDEN_SETUP, GOLDEN_SMOKE],
      ["agents/codex", expect.stringContaining("npm install -g @openai/codex@"), "codex --version"],
    ]);
  });

  it("the results it reports carry the planned skips too, and go next to the recipe", async () => {
    const home = laptop();
    const results: unknown[] = [];
    const imp = importFor([row({ rung: "tools", id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", linux: "unknown" })], {
      home,
      secrets: reader({}),
      platform: "darwin",
      onResult: r => void results.push(r),
    });
    expect(imp.files).toBeUndefined();
    imp.onResult!({ recipeHash: imp.recipeHash, tools: [], agents: [] });
    expect(results).toEqual([{ recipeHash: imp.recipeHash, tools: [{ id: "tools/brew/zingzy/tap/diskbloom", label: "zingzy/tap/diskbloom", outcome: "skipped", note: "no Linux bottle known" }], agents: [] }]);
    expect(importResultPath("/x/state.json")).toBe("/x/golden-import.json");
  });
});
