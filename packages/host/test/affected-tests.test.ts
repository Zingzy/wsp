// SPDX-License-Identifier: AGPL-3.0-only
// Which tests a change runs: the packages it touches and every package declaring them, the test files a chain of
// imports reaches from it, and the whole suite for the root config. Driven through real commits in a throwaway
// workspace whose packages borrow each other's helpers the way this repository's do.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/affected-tests.mjs", import.meta.url));
const NAMED = [
  "packages/host/test/parity.test.ts",
  "packages/host/test/skill.test.ts",
  "packages/host/test/contract.test.ts",
  "packages/host/test/memory.test.ts",
  "packages/protocol/test/stub-script.test.ts",
  "packages/protocol/test/license.test.ts",
  "apps/web/test/no-separator-dots.test.ts",
];
const ALWAYS = [...NAMED, "packages/protocol/test/law.test.ts"].sort();

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

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

const manifest = (name: string, ...uses: string[]): string =>
  JSON.stringify({ name, dependencies: Object.fromEntries(uses.map(use => [use, "workspace:*"])) });

/** proto at the bottom, run declaring it, ui declaring run, and lone declaring nothing while its one borrowing test
 * imports run's helper, which imports proto: the shape of engine's tests borrowing runtime's stub backend. protocol
 * holds the helper that lists the whole tree, one law check that lists it and one test that takes only its root. */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-affected-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "affected@example.invalid");
  git(dir, "config", "user.name", "affected");
  write(dir, {
    "package.json": "{}\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
    "README.md": "# fixture\n",
    "scripts/tidy.mjs": "\n",
    "packages/proto/package.json": manifest("@t/proto"),
    "packages/proto/src/index.ts": "export const proto = 1;\n",
    "packages/proto/test/proto.test.ts": 'import { proto } from "../src/index.js";\n',
    "packages/run/package.json": manifest("@t/run", "@t/proto"),
    "packages/run/src/index.ts": 'import { proto } from "@t/proto";\nexport const run = proto;\n',
    "packages/run/test/helper.ts": 'export { proto } from "@t/proto";\n',
    "packages/run/test/run.test.ts": 'import { run } from "../src/index.js";\n',
    "packages/run/test/built.ts": 'export const BIN = new URL("../dist/index.js", import.meta.url);\n',
    "packages/lone/package.json": manifest("@t/lone"),
    "packages/lone/src/index.ts": "export const lone = 1;\n",
    "packages/lone/test/lone.test.ts": 'import { lone } from "../src/index.js";\n',
    "packages/lone/test/borrow.test.ts": 'import { proto } from "../../run/test/helper.js";\n',
    "packages/lone/test/tidy.test.ts": "\n",
    "packages/lone/test/readme.test.ts": 'const README = new URL("../../../README.md", import.meta.url);\n',
    "packages/lone/test/uses-built.test.ts": 'import { BIN } from "../../run/test/built.js";\n',
    "packages/protocol/package.json": manifest("@t/protocol"),
    "packages/protocol/test/source-files.ts": "export const ROOT = 1;\nexport function sourceFiles() {}\n",
    "packages/protocol/test/law.test.ts": 'import { sourceFiles } from "./source-files.js";\nsourceFiles();\n',
    "packages/protocol/test/root-only.test.ts": 'import { ROOT } from "./source-files.js";\n',
    "apps/ui/package.json": manifest("@t/ui", "@t/run"),
    "apps/ui/src/index.ts": 'import { run } from "@t/run";\n',
    "apps/ui/test/ui.test.ts": 'import "../src/index.js";\n',
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** Commits the change and answers what the script printed against the commit before it. */
function affected(dir: string, change: Record<string, string>, ...flags: string[]): { out: string[]; err: string } {
  write(dir, change);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  const run = spawnSync(process.execPath, [SCRIPT, "HEAD^", ...flags], { cwd: dir, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  return { out: run.stdout.split("\n").filter(Boolean), err: run.stderr };
}

describe("the tests a change runs", () => {
  it("runs the changed package, every package declaring it, and the test that borrows a helper importing it", () => {
    const { out, err } = affected(workspace(), { "packages/proto/src/index.ts": "export const proto = 2;\n" });
    expect(out).toEqual(["apps/ui/", "packages/lone/test/borrow.test.ts", "packages/lone/test/uses-built.test.ts", "packages/proto/", "packages/run/", ...ALWAYS].sort());
    expect(err).toContain("packages/lone/test/borrow.test.ts  imports packages/proto/src/index.ts");
    expect(err).toContain("apps/ui/  declares @t/run");
  });

  it("leaves out what the changed package depends on and what imports nothing of it", () => {
    const { out } = affected(workspace(), { "apps/ui/src/index.ts": 'import { run } from "@t/run";\nexport {};\n' });
    expect(out).toEqual(["apps/ui/", ...ALWAYS].sort());
  });

  it("runs a changed test file alone, without the rest of its package or the tests of its build output", () => {
    const { out } = affected(workspace(), { "packages/run/test/run.test.ts": "\n" });
    expect(out).toEqual(["packages/run/test/run.test.ts", ...ALWAYS].sort());
  });

  it("runs a root script's own test, and a test that reads a root file by URL", () => {
    expect(affected(workspace(), { "scripts/tidy.mjs": "//\n" }).out).toEqual(["packages/lone/test/tidy.test.ts", ...ALWAYS].sort());
    const readme = affected(workspace(), { "README.md": "# changed\n" });
    expect(readme.out).toEqual(["packages/lone/test/readme.test.ts", ...ALWAYS].sort());
    expect(readme.err).toContain("packages/lone/test/readme.test.ts  imports README.md");
  });

  it("prints nothing, which is the whole suite, for the root config and for a folder it does not map", () => {
    const config = affected(workspace(), { "package.json": '{"private":true}\n', "packages/proto/src/index.ts": "//\n" });
    expect(config.out).toEqual([]);
    expect(config.err).toContain("everything  package.json");
    expect(affected(workspace(), { "elsewhere/notes.txt": "\n" }).out).toEqual([]);
  });

  it("answers with --always the named files and every test that lists the whole tree, with no base", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--always"], { cwd: workspace(), encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.split("\n").filter(Boolean)).toEqual([...NAMED, "packages/protocol/test/law.test.ts"]);
  });

  it("lists the test files a change added or modified, and none it deleted", () => {
    const dir = workspace();
    rmSync(join(dir, "packages/lone/test/lone.test.ts"));
    const { out } = affected(dir, { "packages/run/test/run.test.ts": "\n", "packages/run/test/added.test.ts": "\n", "packages/run/src/index.ts": "\n" }, "--changed-tests");
    expect(out).toEqual(["packages/run/test/added.test.ts", "packages/run/test/run.test.ts"]);
  });
});
