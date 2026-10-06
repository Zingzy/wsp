// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SLATE_LIMITS } from "../../src/slate/index.js";
import { ROOT, sourceFiles } from "../source-files.js";

const READERS = ["packages/protocol/src/", "packages/runtime/src/", "apps/web/src/"];

/** Budgets on the catalog's own text, which only its test can hold. */
const HELD_BY_TESTS = ["catalogIndexTokens", "catalogEntryTokens"];

describe("the slate's limits", () => {
  it("are each read from limits.ts by the code they hold, not written out again", () => {
    const code = sourceFiles()
      .filter(file => READERS.some(dir => file.startsWith(dir)))
      .map(file => readFileSync(join(ROOT, file), "utf8"))
      .join("\n");
    const unread = Object.keys(SLATE_LIMITS).filter(k => !HELD_BY_TESTS.includes(k) && !code.includes(`SLATE_LIMITS.${k}`));
    expect(unread).toEqual([]);
  });
});
