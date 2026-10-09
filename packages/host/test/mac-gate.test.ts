// SPDX-License-Identifier: AGPL-3.0-only
// What ci's macOS job runs for a change: nothing for a change with no Mac file, the daemon's checks and every platform
// test for daemon files alone or a change to the job itself, and otherwise the tests affected-tests.mjs picks for the
// Mac files alone, never for the rest of the change. Driven through real commits in a throwaway workspace.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scripts = fileURLToPath(new URL("../../../scripts/", import.meta.url));
const PLATFORM = ["apps/desktop/test/main.test.ts", "packages/host/test/platform.test.ts"];

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

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-mac-gate-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "mac-gate@example.invalid");
  git(dir, "config", "user.name", "mac-gate");
  mkdirSync(join(dir, "scripts"));
  for (const name of ["mac-gate.sh", "affected-tests.mjs"]) copyFileSync(join(scripts, name), join(dir, "scripts", name));
  write(dir, {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "apps/*"\n',
    ".github/workflows/ci.yml": "name: ci\n",
    "daemon/src/lib.rs": "\n",
    "packages/host/package.json": JSON.stringify({ name: "@t/host" }),
    "packages/host/src/service.ts": "export const service = 1;\n",
    "packages/host/test/service.test.ts": 'import { service } from "../src/service.js";\n',
    "packages/host/test/platform.test.ts": 'it.runIf(process.platform === "darwin")("x", () => {});\n',
    "packages/lone/package.json": JSON.stringify({ name: "@t/lone" }),
    "packages/lone/src/index.ts": "export const lone = 1;\n",
    "packages/lone/test/lone.test.ts": 'import { lone } from "../src/index.js";\n',
    "apps/desktop/package.json": JSON.stringify({ name: "@t/desktop" }),
    "apps/desktop/src/main.ts": "export {};\n",
    "apps/desktop/test/main.test.ts": "\n",
  });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** Commits the change and answers what the script printed against the commit before it, or against no base. */
function gate(dir: string, change: Record<string, string>, base = "HEAD^"): { run: string; daemon: string; tests: string[]; err: string } {
  write(dir, change);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "change");
  const list = join(dir, ".git", "mac-tests.txt");
  const ran = spawnSync("bash", [join(dir, "scripts", "mac-gate.sh"), base === "" ? "" : git(dir, "rev-parse", base).trim(), list], { cwd: dir, encoding: "utf8" });
  expect(ran.status, ran.stderr).toBe(0);
  const out = Object.fromEntries(ran.stdout.split("\n").filter(Boolean).map(line => line.split("=")));
  return { run: out.run, daemon: out.daemon, tests: readFileSync(list, "utf8").split("\n").filter(Boolean), err: ran.stderr };
}

describe("what a Mac runs for a change", () => {
  it("runs nothing for a change with no Mac file, nor for a note or a record under daemon/", () => {
    expect(gate(workspace(), { "packages/lone/src/index.ts": "export const lone = 2;\n" })).toMatchObject({ run: "0", daemon: "0", tests: [] });
    expect(gate(workspace(), { "daemon/NOTES.md": "#\n", "daemon/crates/x/record/a.json": "{}\n" })).toMatchObject({ run: "0", tests: [] });
  });

  it("runs the daemon's checks and every platform test for daemon files alone", () => {
    expect(gate(workspace(), { "daemon/src/lib.rs": "//\n" })).toMatchObject({ run: "1", daemon: "1", tests: PLATFORM });
  });

  it("picks the tests the Mac files reach and none the rest of the change reaches", () => {
    const { run, daemon, tests, err } = gate(workspace(), {
      "packages/host/src/service.ts": "export const service = 2;\n",
      "apps/desktop/src/added.ts": "export {};\n",
      "packages/lone/src/index.ts": "export const lone = 2;\n",
    });
    expect({ run, daemon }).toEqual({ run: "1", daemon: "0" });
    expect(tests).toEqual(expect.arrayContaining(["apps/desktop/", "packages/host/"]));
    expect(tests.filter(test => test.startsWith("packages/lone/"))).toEqual([]);
    expect(err).toContain("filters from scripts/affected-tests.mjs for the Mac files");
  });

  it("runs the whole of it for a change to the job and where there is no base", () => {
    expect(gate(workspace(), { ".github/workflows/ci.yml": "name: ci\non: push\n" })).toMatchObject({ run: "1", daemon: "1", tests: PLATFORM });
    expect(gate(workspace(), { "scripts/mac-base-red.sh": "#!/bin/sh\n" })).toMatchObject({ run: "1", daemon: "1", tests: PLATFORM });
    expect(gate(workspace(), { "packages/lone/src/index.ts": "//\n" }, "")).toMatchObject({ run: "1", daemon: "1", tests: PLATFORM });
  });

  it("skips the 24 daemon tests main failed on a Mac when the job began, and no more", () => {
    const ci = readFileSync(fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url)), "utf8");
    expect(ci.match(/^ +--skip /gm)).toHaveLength(24);
  });
});
