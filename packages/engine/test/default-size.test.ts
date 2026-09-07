// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, sourceFiles } from "../../protocol/test/source-files.js";

describe("one place for the size a machine is built at", () => {
  const HOME = join("packages", "engine", "src", "solari-backend.ts");
  // A vCPU count or a memory size written into a spec or a recipe; a road that names none takes pricing.defaultSize.
  const RULE = /\b(cpu|memMb):\s*\d/;

  it("no source file outside the backend's own table names a size", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && RULE.test(readFileSync(join(ROOT, rel), "utf8")));
    expect(copies).toEqual([]);
  });
});
