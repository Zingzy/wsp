// SPDX-License-Identifier: AGPL-3.0-only
// The laws judge the tree that lands, the branch merged with origin/main, so a branch that passes alone and fails
// once it meets main is caught before its report. Driven in a throwaway origin and clone whose one law, a stand-in
// for test-files.sh, holds the notes folder to three files: main adding one and the branch adding one each pass alone.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";

const SCRIPT = fileURLToPath(new URL("../../../scripts/pre-review.sh", import.meta.url));

/** Each run says where it ran, whether it saw this clone's installs and how pnpm was told to treat them. */
const LAW = `#!/bin/sh
printf '%s %s %s\\n' "$(pwd -P)" "$(cat node_modules/marker 2>/dev/null)" "\${pnpm_config_verify_deps_before_run:-check}" >>"$LAW_RUNS"
if [ "$(ls notes | wc -l)" -le 3 ]; then echo " Test Files  1 passed (1)"; exit 0; fi
echo " FAIL  notes.test.ts > the notes stay at three files"
echo " Test Files  1 failed (1)"
exit 1
`;

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trimEnd();

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

/** An origin holding the script and the law, and a clone on a branch off its main with installs git ignores. */
function clone(): { origin: string; work: string; runs: string } {
  const top = mkdtempSync(join(tmpdir(), "wsp-pre-review-"));
  dirs.push(top);
  const origin = join(top, "origin");
  const work = join(top, "work");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "user.email", "pre-review@example.invalid");
  git(origin, "config", "user.name", "pre-review");
  mkdirSync(join(origin, "scripts"));
  copyFileSync(SCRIPT, join(origin, "scripts/pre-review.sh"));
  writeStub(join(origin, "scripts/test-files.sh"), LAW);
  write(origin, { ".gitignore": "node_modules/\n", "notes/one.md": "one\n", "notes/shared.md": "as it was\n" });
  commit(origin, {}, "base");
  execFileSync("git", ["clone", "-q", origin, work]);
  git(work, "config", "user.email", "pre-review@example.invalid");
  git(work, "config", "user.name", "pre-review");
  git(work, "switch", "-q", "-c", "feature");
  write(work, { "node_modules/marker": "installed\n" });
  return { origin, work, runs: join(top, "runs.txt") };
}

/** This run's environment less the pnpm settings the pnpm that started it hands down, which the script decides. */
const pnplessEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("pnpm_config_")));

function laws(work: string, runs: string): { status: number | null; out: string; ran: string[] } {
  const run = spawnSync("bash", [join(work, "scripts/pre-review.sh"), "--laws"], { cwd: work, encoding: "utf8", env: { ...pnplessEnv(), LAW_RUNS: runs } });
  const ran = existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean) : [];
  rmSync(runs, { force: true });
  const logs = /^logs: (.+)$/m.exec(run.stdout);
  if (logs) dirs.push(logs[1]!);
  return { status: run.status, out: run.stdout + run.stderr, ran };
}

/** What the run could have written to the branch or its folder: its own refs, the status, the worktrees. */
function untouched(work: string): string {
  return [git(work, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"), git(work, "status", "--porcelain"), git(work, "worktree", "list", "--porcelain")].join("\n--\n");
}

describe("the laws on the branch merged with origin/main", () => {
  it("goes red on a branch that passes alone and fails once main moves, writing nothing to the branch or its folder", () => {
    const { origin, work, runs } = clone();
    commit(work, { "notes/two.md": "two\n" }, "feature");
    commit(origin, { "notes/three.md": "three\n" }, "main moves");
    const before = untouched(work);

    const run = laws(work, runs);
    expect(run.status, run.out).toBe(1);
    const merged = /a throwaway merge commit ([0-9a-f]+) in (\S+)/.exec(run.out);
    expect(run.out).toContain(`the laws run on this folder merged with origin/main ${git(origin, "rev-parse", "--short", "HEAD")}, a throwaway merge commit`);
    expect(merged, run.out).not.toBeNull();
    expect(run.out).toContain("FAIL  the laws: notes.test.ts > the notes stay at three files");
    expect(run.ran).toEqual([`${merged![2]} installed false`]);
    expect(untouched(work)).toBe(before);
    expect(existsSync(merged![2]!)).toBe(false);
    expect(git(work, "branch", "--all", "--contains", merged![1]!)).toBe("");
  });

  it("merges the folder as it stands, its uncommitted and untracked changes with it, and leaves them where they were", () => {
    const { origin, work, runs } = clone();
    commit(work, { "notes/two.md": "two\n" }, "feature");
    commit(origin, { "notes/three.md": "three\n" }, "main moves");
    rmSync(join(work, "notes/one.md"));
    const before = untouched(work);
    expect(laws(work, runs).status).toBe(0);
    expect(untouched(work)).toBe(before);

    write(work, { "notes/four.md": "four\n" });
    const untracked = laws(work, runs);
    expect(untracked.status, untracked.out).toBe(1);
    expect(git(work, "status", "--porcelain")).toBe(" D notes/one.md\n?? notes/four.md");
  });

  it("names the files a branch that conflicts with main conflicts in, and runs no law on a tree that cannot land", () => {
    const { origin, work, runs } = clone();
    commit(work, { "notes/shared.md": "as the branch has it\n", "notes/other.md": "x\n" }, "feature");
    commit(origin, { "notes/shared.md": "as main has it\n" }, "main moves");
    const before = untouched(work);

    const run = laws(work, runs);
    expect(run.status, run.out).toBe(1);
    expect(run.out).toContain(`FAIL  the laws: this folder conflicts with origin/main ${git(origin, "rev-parse", "--short", "HEAD")} in notes/shared.md, so no tree of it can land; merge origin/main in and resolve them`);
    expect(run.out).not.toContain("the laws run on");
    expect(run.ran).toEqual([]);
    expect(untouched(work)).toBe(before);
  });

  it("runs on the folder itself while the branch holds origin/main", () => {
    const { work, runs } = clone();
    commit(work, { "notes/two.md": "two\n" }, "feature");
    const run = laws(work, runs);
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain(`the laws run on this folder, which holds origin/main ${git(work, "rev-parse", "--short", "origin/main")}`);
    expect(run.out).toContain("PASS  the laws: 1 passed (1)");
    expect(run.ran).toEqual([`${git(work, "rev-parse", "--show-toplevel")} installed check`]);
  });
});
