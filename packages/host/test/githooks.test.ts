// SPDX-License-Identifier: AGPL-3.0-only
// The hooks under .githooks, driven through real commits in a throwaway repository: what they refuse, the
// sentence each refusal says, and the shapes that look like a refusal and are not.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HOOKS = join(ROOT, ".githooks");
const EM_DASH = String.fromCodePoint(0x2014);

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A repository of its own, reading the hooks this branch carries and nothing of the developer's own config. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-githooks-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "hooks@example.invalid");
  git(dir, "config", "user.name", "hooks");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", HOOKS);
  return dir;
}

function stage(dir: string, rel: string, text: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  git(dir, "add", "--", rel);
}

/** What `git commit` did: the sentence a hook said, or nothing when the commit was taken. */
function commit(dir: string, message: string): string {
  try {
    execFileSync("git", ["-C", dir, "commit", "-m", message], { encoding: "utf8", stdio: "pipe" });
    return "";
  } catch (e) {
    return String((e as { stderr?: Buffer | string }).stderr ?? "").trim();
  }
}

describe("the hooks are what git can run", () => {
  it("carries each of the four as an executable file", () => {
    for (const hook of ["commit-msg", "pre-commit", "pre-merge-commit", "pre-push"]) {
      expect(statSync(join(HOOKS, hook)).mode & 0o111, hook).not.toBe(0);
    }
  });
});

describe("what the commit-msg hook refuses", () => {
  it("takes a message that says what changed", () => {
    const dir = repo();
    stage(dir, "src/a.ts", "export const a = 1;\n");
    expect(commit(dir, "host: the deploy writes the token it is given\n\nSo a run of the daemon names the session.")).toBe("");
    expect(git(dir, "log", "--oneline").trim()).toContain("the deploy writes the token it is given");
  });

  it("refuses an em dash and names the line", () => {
    const dir = repo();
    stage(dir, "src/a.ts", "export const a = 1;\n");
    expect(commit(dir, `host: the token ${EM_DASH} the one the deploy writes`)).toBe(
      "refused: line 1 of the commit message has an em dash or an en dash; write it with a comma, a colon or two sentences",
    );
  });

  it("refuses a co-author trailer", () => {
    const dir = repo();
    stage(dir, "src/a.ts", "export const a = 1;\n");
    expect(commit(dir, "host: the deploy writes the token\n\nCo-Authored-By: Someone <someone@example.invalid>")).toBe(
      "refused: the commit message carries a Co-Authored-By trailer; delete that line",
    );
  });

  it("refuses a ticket number", () => {
    const dir = repo();
    stage(dir, "src/a.ts", "export const a = 1;\n");
    expect(commit(dir, "host: the deploy writes the token\n\nCloses #909.")).toBe(
      "refused: line 3 of the commit message names a ticket number; say what the commit does and leave the number on the tracker",
    );
  });

  it("refuses a tool or a model by name, and reads them as whole words", () => {
    const dir = repo();
    stage(dir, "src/a.ts", "export const a = 1;\n");
    const said = "refused: line 1 of the commit message names a tool or a model; say what changed instead";
    for (const message of ["host: written by Claude", "host: an ANTHROPIC key", "host: run on opus", "host: the fable of it", "host: sonnet", "host: an AI wrote this"]) {
      expect(commit(dir, message), message).toBe(said);
    }
    // The letters live inside other words, and a word that carries them is not the word.
    expect(commit(dir, "host: retain the claudication of the raw bytes")).toBe("");
  });
});

describe("what the pre-commit hook refuses", () => {
  it("refuses a staged .base-sha and names it", () => {
    const dir = repo();
    stage(dir, ".base-sha", "79c0320c5\n");
    expect(commit(dir, "host: the deploy writes the token")).toBe(
      "refused: .base-sha is a working file of the landing gate and never lands; run git rm --cached .base-sha",
    );
  });

  it("refuses an em dash in a staged source file and names the file", () => {
    const dir = repo();
    stage(dir, "src/a.ts", `// the token ${EM_DASH} the one the deploy writes\n`);
    expect(commit(dir, "host: the deploy writes the token")).toBe(
      "refused: a line staged in src/a.ts has an em dash; write it with a comma, a colon or two sentences",
    );
  });

  it("leaves a fixture alone, since a fixture says what it says", () => {
    const dir = repo();
    stage(dir, "daemon/fixtures/contract/words.json", `{ "line": "the token ${EM_DASH} the one written" }\n`);
    stage(dir, "packages/host/test/fixtures/a.json", `{ "line": "${EM_DASH}" }\n`);
    expect(commit(dir, "host: the deploy writes the token")).toBe("");
  });

  it("refuses a ticket label in a staged source file and names the file", () => {
    const said = (file: string): string => `refused: a line staged in ${file} carries a ticket label; name what the code does and leave the number on the tracker`;
    // The labels are built rather than written out: this file is a staged .ts as well, and the hook under test
    // reads its own source and refuses it.
    const n = "904";
    for (const [file, text] of [
      ["src/a.ts", `export const tree = "wsp-${n}";\n`],
      ["src/a.tsx", `export const tree = "live-${n}";\n`],
      ["src/a.rs", `pub const TREE: &str = "${n}-a-worktree";\n`],
    ] as const) {
      const dir = repo();
      stage(dir, file, text);
      expect(commit(dir, "host: the deploy writes the token"), file).toBe(said(file));
    }
  });

  it("reads a version number and a hex sha as what they are, not as a label", () => {
    const dir = repo();
    stage(
      dir,
      "src/a.ts",
      [
        'export const pinned = "2.5.5";',
        'export const release = "0.12.100-alpha.1";',
        'export const runner = "ubuntu-24.04-arm";',
        'export const head = "79c0320c5";',
        'export const digest = "sha-256-gcm";',
        'export const target = "x86_64-unknown-linux-musl";',
        "export const left = 100 - 5;",
        'export const day = "2026-09-17";',
        "",
      ].join("\n"),
    );
    expect(commit(dir, "host: the deploy writes the token")).toBe("");
  });
});

describe("what the prepare script wires", () => {
  it("points git at the versioned hooks", () => {
    const dir = repo();
    git(dir, "config", "--unset", "core.hooksPath");
    const said = execFileSync("node", [join(ROOT, "scripts", "hooks-path.mjs")], { cwd: dir, encoding: "utf8" });
    expect(said.trim()).toBe("hooks: git reads this repository's .githooks");
    expect(git(dir, "config", "--get", "core.hooksPath").trim()).toBe(".githooks");
  });

  it("is not a failed install where there is no git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-githooks-bare-"));
    dirs.push(dir);
    const said = execFileSync("node", [join(ROOT, "scripts", "hooks-path.mjs")], { cwd: dir, encoding: "utf8" });
    expect(said.trim()).toBe("hooks: no git repository here, nothing to wire");
  });
});
