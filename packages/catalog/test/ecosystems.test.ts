// SPDX-License-Identifier: AGPL-3.0-only
// The rebuilds a new worktree runs, run for real against a branch whose lockfile is stale: none of them may leave a
// tracked file changed, since the worktree would then hold a change nobody made.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARGO } from "../src/ecosystems/cargo.js";
import { NPM } from "../src/ecosystems/npm.js";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
const onPath = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wsp-eco-"));
  made.push(dir);
  return dir;
};

/** Files written into a folder of their own. */
const folder = (at: string, files: Record<string, string>): string => {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(at, name, ".."), { recursive: true });
    writeFileSync(join(at, name), body);
  }
  return at;
};

/** A repo of these files, its lockfile written by `lock`, then one more commit that changes `manifest` and leaves
 * the lockfile behind it, as a branch does that added a dependency and never ran the install. */
const staleBranch = (at: string, files: Record<string, string>, lock: string, manifest: string, body: string, env: NodeJS.ProcessEnv = process.env): string => {
  folder(at, files);
  execFileSync("sh", ["-c", lock], { cwd: at, stdio: "ignore", env });
  git(at, "init", "-q");
  git(at, "add", ".");
  git(at, "commit", "-qm", "locked");
  writeFileSync(join(at, manifest), body);
  git(at, "commit", "-qam", "a dependency the lockfile lacks");
  return at;
};

/** The rebuild as a new worktree runs it: in the folder, with stdin closed. */
const rebuild = (command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): number | null => spawnSync("sh", ["-c", command], { cwd, env, input: "", stdio: ["pipe", "ignore", "ignore"] }).status;

describe("a module's rebuild on a branch whose lockfile is stale", () => {
  it.skipIf(!onPath("npm"))("npm's leaves package-lock.json as the branch holds it", () => {
    const top = scratch();
    // npm writes its logs and cache under the home.
    const env = { ...process.env, HOME: join(top, "home") };
    folder(join(top, "dep"), { "package.json": JSON.stringify({ name: "dep", version: "1.0.0" }) });
    const app = staleBranch(
      join(top, "app"),
      { "package.json": JSON.stringify({ name: "app", version: "1.0.0" }), ".gitignore": "node_modules/\n" },
      "npm install --package-lock-only --no-audit --no-fund",
      "package.json",
      JSON.stringify({ name: "app", version: "1.0.0", dependencies: { dep: "file:../dep" } }),
      env,
    );
    rebuild(NPM.rebuild, app, env);
    expect(git(app, "status", "--porcelain")).toBe("");
  });

  it.skipIf(!onPath("cargo"))("Cargo's refuses it and leaves Cargo.lock as the branch holds it", () => {
    const top = scratch();
    // A case's HOME is the run's own, where rustup's default folder holds no toolchain: name the login's.
    const env = { ...process.env, HOME: join(top, "home"), CARGO_HOME: join(top, "cargo"), RUSTUP_HOME: process.env["RUSTUP_HOME"] ?? join(userInfo().homedir, ".rustup") };
    const crate = (name: string): Record<string, string> => ({ "Cargo.toml": `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n`, "src/lib.rs": "" });
    folder(join(top, "b"), crate("b"));
    const a = staleBranch(join(top, "a"), { ...crate("a"), ".gitignore": "target/\n" }, "cargo generate-lockfile --offline", "Cargo.toml", `${crate("a")["Cargo.toml"]}b = { path = "../b" }\n`, env);
    expect(rebuild(CARGO.rebuild, a, env)).not.toBe(0);
    expect(git(a, "status", "--porcelain")).toBe("");
  });
});
