// SPDX-License-Identifier: AGPL-3.0-only
// A test says the environment it means. Reading a wsp variable off the process
// that happens to be running the suite makes the result depend on the shell
// that started it: every builder on one computer with WSP_LABS or WSP_TURN
// exported saw unrelated cases fail. So a test hands the environment it means
// into the code under test, and the only wsp variables a test may read off its
// own process are the gates that decide whether the file runs at all.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import { ROOT, sourceFiles, testFiles } from "./source-files.js";
import { GATES, RUN_TMPDIR, TEST_ENV } from "../../../vitest.env.js";

/** Every WSP_ variable a package names, by the constant it is exported as, so a read written as
 * process.env[TURN_TOKEN_ENV] is caught as the read of WSP_TURN that it is: the protocol's exports, and every constant
 * a package's own source exports, since a test imports the constant from whichever package holds it. */
function namedConstants(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(protocol)) {
    if (typeof value === "string" && value.startsWith("WSP_")) out[name] = value;
  }
  for (const rel of sourceFiles()) {
    for (const [, name, value] of readFileSync(join(ROOT, rel), "utf8").matchAll(/export const ([A-Z][A-Z0-9_]*) = "(WSP_[A-Z0-9_]+)"/g)) out[name!] = value!;
  }
  return out;
}

/** Every WSP_ variable a workflow step or a package's script sets on purpose, which is a gate for the suite it runs. */
function setOnPurpose(): string[] {
  const workflows = join(ROOT, ".github", "workflows");
  const texts = [
    ...readdirSync(workflows).filter(f => f.endsWith(".yml")).map(f => readFileSync(join(workflows, f), "utf8")),
    readFileSync(join(ROOT, "package.json"), "utf8"),
    ...["apps", "packages"].flatMap(top =>
      readdirSync(join(ROOT, top), { withFileTypes: true })
        .filter(d => d.isDirectory() && existsSync(join(ROOT, top, d.name, "package.json")))
        .map(d => readFileSync(join(ROOT, top, d.name, "package.json"), "utf8")),
    ),
  ];
  return [...new Set(texts.flatMap(text => [...text.matchAll(/\b(WSP_[A-Z0-9_]+)(?:: |=)/g)].map(m => m[1]!)))].sort();
}

/** Every wsp variable this file reads off process.env, whether spelled out or reached through a constant. */
function wspReads(text: string, constants: Record<string, string>): string[] {
  const found: string[] = [];
  const reads = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*["']([^"']+)["']\s*\]|\[\s*([A-Za-z_]\w*)\s*\])/g;
  for (const [, dotted, quoted, through] of text.matchAll(reads)) {
    const name = dotted ?? quoted ?? (through === undefined ? undefined : constants[through]);
    if (name !== undefined && name.startsWith("WSP_")) found.push(name);
  }
  return found;
}

describe("a test reads no wsp variable off the process running it", () => {
  const constants = namedConstants();
  // This file holds the samples that show what the grep catches, so it is the one test file the grep skips.
  const read = testFiles()
    .filter(rel => !rel.endsWith("test-env.test.ts"))
    .map(rel => ({ rel, names: wspReads(readFileSync(join(ROOT, rel), "utf8"), constants) }));

  it("names the two variables that broke this, so the grep cannot go blind", () => {
    expect(constants["LABS_ENV"]).toBe("WSP_LABS");
    expect(constants["TURN_TOKEN_ENV"]).toBe("WSP_TURN");
    // A constant another package holds, which a test imports from there.
    expect(constants["REQUIRE_DAEMON_ENV"]).toBe("WSP_REQUIRE_DAEMON");
    expect(wspReads('process.env[TURN_TOKEN_ENV]\nprocess.env.WSP_LABS\nprocess.env["WSP_TURN"]', constants)).toEqual(["WSP_TURN", "WSP_LABS", "WSP_TURN"]);
    // Naming the variable is what this catches. A spread, an alias, a destructuring or a computed key reaches the
    // same value and is not a finding here on purpose: a spread of process.env into a child's environment is
    // legitimate and already used, and the belt in vitest.env.ts is what makes those spellings read nothing.
    expect(wspReads('vi.stubEnv(LABS_ENV, "1")\nconst env = { ...process.env }\nconst { WSP_LABS: labs } = process.env', constants)).toEqual([]);
  });

  it("opens the cases beside the source as well as the ones under a test folder", () => {
    const files = testFiles();
    expect(files).toContain("apps/web/src/composer-logic.test.ts");
    expect(files.filter(f => f.startsWith("apps/web/src/")).length).toBeGreaterThan(50);
    expect(files).toContain("packages/host/test/verbs.test.ts");
    // Fixtures too, which are where a read is hardest to see.
    expect(files).toContain("apps/web/test/render-browser.ts");
    expect(files.filter(f => !/\.tsx?$/.test(f))).toEqual([]);
  });

  it("reads nothing but the gates", () => {
    const offending = read.flatMap(f => f.names.filter(n => !(n in GATES)).map(n => `${f.rel}: ${n}`));
    expect(offending).toEqual([]);
  });

  it("keeps every variable a workflow or a package's script sets on purpose, so the belt cannot drop one", () => {
    expect(setOnPurpose().filter(name => !(name in GATES))).toEqual([]);
  });

  it("has no gate in the list nothing gates any more", () => {
    const everyRead = new Set(read.flatMap(f => f.names));
    expect(Object.keys(GATES).filter(n => !everyRead.has(n))).toEqual([]);
  });
});

describe("the environment every test runs under", () => {
  it("turns the release check off, so no host a test starts asks GitHub", () => {
    expect(TEST_ENV[protocol.UPDATE_CHECK_ENV]).toBe("0");
  });

  it("makes every folder under the run's own temp folder, the one the Claude Code store guard watches", () => {
    expect(basename(tmpdir())).toMatch(/^wsp-run-\d+$/);
    expect(existsSync(tmpdir())).toBe(true);
    expect(RUN_TMPDIR).toBe(tmpdir());
  });

  it("leaves no launch pair, home, named host, cloud, labs or person's home to a test, since none of them is a gate", () => {
    const aims = [...protocol.LAUNCH_ENV, "WSP_HOME", "WSP_HOST", protocol.CLOUD_ENV, protocol.LABS_ENV, protocol.PERSON_HOME_ENV];
    expect(aims.filter(name => name in GATES)).toEqual([]);
    expect(aims.filter(name => process.env[name] !== undefined)).toEqual([]);
  });

  it("holds no wsp variable of the shell that started the suite but the gates, so no suite dials that shell's host", () => {
    // A suite started inside a wsp thread inherits the pair the thread's launch carries, and code under test that
    // reads the process's own environment would dial that host as that thread.
    const own = new Set([...Object.keys(GATES), ...Object.keys(TEST_ENV)]);
    expect(Object.keys(process.env).filter(name => name.startsWith("WSP_") && !own.has(name))).toEqual([]);
  });
});
