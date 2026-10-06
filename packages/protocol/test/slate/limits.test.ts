// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SLATE_LIMITS } from "../../src/slate/index.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(join(repo, dir), { withFileTypes: true, recursive: true })
    .filter(e => e.isFile() && /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name))
    .map(e => readFileSync(join(e.parentPath, e.name), "utf8"));

/** Budgets on the catalog's own text, which only its test can hold. */
const HELD_BY_TESTS = ["catalogIndexTokens", "catalogEntryTokens"];

describe("the slate's limits", () => {
  it("are each read from limits.ts by the code they hold, not written out again", () => {
    const code = ["packages/protocol/src", "packages/runtime/src", "apps/web/src"].flatMap(sources).join("\n");
    const unread = Object.keys(SLATE_LIMITS).filter(k => !HELD_BY_TESTS.includes(k) && !code.includes(`SLATE_LIMITS.${k}`));
    expect(unread).toEqual([]);
  });
});
