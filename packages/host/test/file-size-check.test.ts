// SPDX-License-Identifier: AGPL-3.0-only
// The size check: a source file outside the tests past 1,500 lines fails, one already past it fails only when it
// grows past its recorded count, and one that drops back passes with a note to delete its line. Driven in throwaway
// repositories with the script and the list this tree carries copied in.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/file-size-check.mjs", import.meta.url));
const LIST = "scripts/file-size-known.json";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const lines = (n: number): string => "x\n".repeat(n);

/** A repository holding these files, tracked, with the script beside them and the list it is given. */
function repo(files: Record<string, string>, known: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-size-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  const all = { ...files, "scripts/file-size-check.mjs": readFileSync(SCRIPT, "utf8"), [LIST]: JSON.stringify(known) };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  return dir;
}

const check = (dir: string, ...flags: string[]) =>
  spawnSync(process.execPath, [join(dir, "scripts/file-size-check.mjs"), ...flags], { cwd: dir, encoding: "utf8" });

describe("the file size check", () => {
  it("passes a tree at the limit, a listed file at its count, the tests and the generated data", () => {
    const dir = repo(
      {
        "src/edge.ts": lines(1500),
        "src/big.rs": lines(2000),
        "src/test/huge.ts": lines(3000),
        "daemon/crates/x/tests/huge.rs": lines(3000),
        "src/huge.test.tsx": lines(3000),
        "packages/collect/src/data/linux-bottles.ts": lines(9000),
        "src/notes.md": lines(3000),
      },
      { "src/big.rs": 2000 },
    );
    const run = check(dir);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("fails a new file past the limit and a listed one past its count, naming each", () => {
    const run = check(repo({ "src/new.mjs": lines(1501), "src/big.ts": lines(2001) }, { "src/big.ts": 2000 }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("src/new.mjs has 1501 lines, over 1500: split it");
    expect(run.stderr).toContain("src/big.ts grew to 2001 lines, past the 2000");
  });

  it("passes a listed file within the limit, gone or shrunk, with a note to delete or lower its line", () => {
    const run = check(repo({ "src/split.ts": lines(1400), "src/shrank.tsx": lines(1800) }, { "src/split.ts": 5000, "src/gone.ts": 1600, "src/shrank.tsx": 1900 }));
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`src/split.ts is down to 1400 lines, within 1500: delete its line from ${LIST}`);
    expect(run.stdout).toContain(`src/gone.ts is gone or no longer checked: delete its line from ${LIST}`);
    expect(run.stdout).toContain("src/shrank.tsx is down to 1800 lines from 1900");
  });

  it("seeds the list with every file over the limit as it stands", () => {
    const dir = repo({ "a.ts": lines(1600), "b.rs": lines(1500), "c/test/d.ts": lines(1600) }, {});
    expect(check(dir, "--seed").status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, LIST), "utf8"))).toEqual({ "a.ts": 1600 });
    expect(check(dir).status).toBe(0);
  });
});
