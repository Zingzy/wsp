// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMemoryDir, claudeProjectKey, defaultSeedChoice, type SeedFile, type SeedPlan } from "@wsp/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { packSeed } from "../src/project-seed.js";

const root = mkdtempSync(join(tmpdir(), "wsp-seed-"));
const folder = join(root, "spoo-landing");
const claude = join(root, ".claude");
const key = claudeProjectKey(folder);

mkdirSync(folder, { recursive: true });
mkdirSync(join(folder, ".claude"), { recursive: true });
mkdirSync(join(folder, ".git"), { recursive: true });
mkdirSync(join(folder, "node_modules", "left"), { recursive: true });
writeFileSync(join(folder, ".env.local"), "TOKEN=abc\n");
writeFileSync(join(folder, ".claude", "settings.local.json"), "{}\n");
writeFileSync(join(folder, ".claude", "other.json"), "{}\n");
writeFileSync(join(folder, ".git", "config"), "[core]\n");
writeFileSync(join(folder, "node_modules", "left", "index.js"), "module.exports = 1\n");
writeFileSync(join(folder, ".git-credentials"), "https://x:y@github.com\n");
mkdirSync(claudeMemoryDir(claude, key), { recursive: true });
writeFileSync(join(claudeMemoryDir(claude, key), "MEMORY.md"), "- one thing\n");
writeFileSync(join(claudeMemoryDir(claude, key), "one.md"), "the thing\n");

afterAll(() => rmSync(root, { recursive: true, force: true }));

const file = (path: string, kind: SeedFile["kind"], dir = false): SeedFile => ({ path, dir, bytes: 10, kind, ticked: kind === "config" });

const PLAN: SeedPlan = {
  source: folder,
  remote: "https://github.com/spoo-me/frontend.git",
  branch: "main",
  defaultBranch: "main",
  unpushed: { commits: 1, base: "aa11bb22" },
  uncommitted: 0,
  memory: { key, files: 2, bytes: 20 },
  files: [file(".env.local", "config"), file(".claude", "unknown", true), file(".claude/settings.local.json", "config"), file("node_modules", "rebuilt", true), file(".git-credentials", "never")],
  remembered: false,
};

/** The paths inside a gzipped archive, as tar itself reads them back. */
function inside(tar: Buffer): string[] {
  const at = join(root, "read.tgz");
  writeFileSync(at, tar);
  return execFileSync("tar", ["-tzf", at], { encoding: "utf8" }).split("\n").filter(line => line !== "");
}

const fakeGit = async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({ exitCode: 0, stdout: "From 1 Mon Sep 17 00:00:00 2026\nSubject: [PATCH] a thing\n", stderr: "" });

describe("the archive a folder seeds a project with", () => {
  it("carries the ticked paths at their own relative paths, the memory folder and the patch, and nothing else", async () => {
    const packed = await packSeed({ plan: PLAN, choice: defaultSeedChoice(PLAN), claudeStateHome: claude, run: fakeGit });
    expect(inside(packed.tar).sort()).toEqual([".claude/settings.local.json", ".env.local", ".wsp-seed/commits.patch", ".wsp-seed/memory/MEMORY.md", ".wsp-seed/memory/one.md"]);
    expect(packed.files).toBe(5);
    expect(packed.commits).toBe(1);
    expect(packed.bytes).toBeGreaterThan(0);
  });

  it("carries a whole ticked folder and still nothing of the repository's own history", async () => {
    const packed = await packSeed({ plan: PLAN, choice: { files: [".env.local", ".claude"], memory: false, commits: false }, claudeStateHome: claude, run: fakeGit });
    expect(inside(packed.tar).sort()).toEqual([".claude/other.json", ".claude/settings.local.json", ".env.local"]);
    expect(inside(packed.tar).some(path => path.startsWith(".git/"))).toBe(false);
  });

  it("refuses a login the choice named, even though the menu showed it", async () => {
    await expect(packSeed({ plan: PLAN, choice: { files: [".git-credentials"], memory: false, commits: false }, claudeStateHome: claude, run: fakeGit })).rejects.toThrow(
      /\.git-credentials is a login, and a login never travels/,
    );
  });

  it("refuses the repository's own folder, whatever asked for it", async () => {
    const plan = { ...PLAN, files: [...PLAN.files, file(".git", "unknown", true)] };
    await expect(packSeed({ plan, choice: { files: [".git"], memory: false, commits: false }, claudeStateHome: claude, run: fakeGit })).rejects.toThrow(/the repository's own folder/);
  });

  it("refuses a path the menu never showed", async () => {
    await expect(packSeed({ plan: PLAN, choice: { files: ["app/page.tsx"], memory: false, commits: false }, claudeStateHome: claude, run: fakeGit })).rejects.toThrow(/is not on the seed menu/);
  });

  it("carries no memory and no patch where the person dropped them", async () => {
    const packed = await packSeed({ plan: PLAN, choice: { files: [".env.local"], memory: false, commits: false }, claudeStateHome: claude, run: fakeGit });
    expect(inside(packed.tar)).toEqual([".env.local"]);
    expect(packed.commits).toBe(0);
  });

  it("says what git said when the patch could not be written", async () => {
    const failed = async (): Promise<{ exitCode: number; stdout: string; stderr: string }> => ({ exitCode: 128, stdout: "", stderr: "fatal: bad revision 'aa11bb22..HEAD'\n" });
    await expect(packSeed({ plan: PLAN, choice: defaultSeedChoice(PLAN), claudeStateHome: claude, run: failed })).rejects.toThrow(/fatal: bad revision/);
  });
});
