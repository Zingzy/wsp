// SPDX-License-Identifier: AGPL-3.0-only
// pre-review's --laws list is the one list of laws: the landing runs it on the squash, so a law missing from it runs
// on a branch nowhere before CI. Read off the LAWS array in scripts/pre-review.sh.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, testFiles } from "./source-files.js";

/** The laws the landing ran from a list of its own until 2026-10-07, four of them then missing from this one. */
const LANDING = [
  "packages/host/test/words.test.ts",
  "packages/host/test/boat-words.test.ts",
  "packages/protocol/test/person-words.test.ts",
  "apps/web/test/plain-words.test.ts",
  "packages/host/test/parity.test.ts",
  "packages/host/test/skill.test.ts",
  "packages/host/test/contract.test.ts",
  "packages/host/test/cloud.test.ts",
  "apps/web/test/no-caps.test.ts",
  "apps/web/test/no-separator-dots.test.ts",
  "packages/protocol/test/daemon-contract.test.ts",
  "packages/protocol/test/area-notes.test.ts",
  "packages/protocol/test/test-hygiene.test.ts",
  "packages/protocol/test/repo-names.test.ts",
  "packages/protocol/test/fixture-privacy.test.ts",
  "packages/host/test/file-size-check.test.ts",
  "apps/web/test/design-literals.test.ts",
  "apps/web/test/design-pieces.test.ts",
];

/** The files the LAWS array names, one per line between its parentheses. */
function lawsOf(script: string): string[] {
  const body = /^LAWS=\(\n([\s\S]*?)^\)$/m.exec(script)?.[1];
  if (body === undefined) throw new Error("scripts/pre-review.sh holds no LAWS=( ... ) array");
  return body
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
}

const LAWS = lawsOf(readFileSync(join(ROOT, "scripts/pre-review.sh"), "utf8"));

describe("pre-review's list of laws", () => {
  it("names every law the landing runs", () => {
    expect(LANDING.filter(law => !LAWS.includes(law))).toEqual([]);
  });

  it("names every test that holds the tree to an allowed list", () => {
    const held = testFiles().filter(f => /\.test\.tsx?$/.test(f) && !f.endsWith("/allowed.test.ts") && /\bholdTo\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(held).toContain("packages/protocol/test/fixture-privacy.test.ts");
    expect(held.filter(f => !LAWS.includes(f))).toEqual([]);
  });

  it("names only files that are there, each once", () => {
    expect(LAWS.filter(law => !existsSync(join(ROOT, law)))).toEqual([]);
    expect(LAWS.filter((law, i) => LAWS.indexOf(law) !== i)).toEqual([]);
  });

  it("names itself, since a law added anywhere turns it red", () => {
    expect(LAWS).toContain("packages/protocol/test/law-list.test.ts");
  });
});
