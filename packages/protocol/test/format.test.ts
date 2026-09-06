// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fmtBytes, fmtMemGb } from "../src/index.js";
import { ROOT, sourceFiles } from "./source-files.js";

describe("fmtBytes", () => {
  it("reads whole bytes under a kilobyte, then one decimal in binary units up to GB", () => {
    expect([0, 12, 1023, 1024, 2_048, 3 * 1024 * 1024, 38.2 * 1024 * 1024, 2.3 * 1024 ** 3, 32_000_000_000].map(fmtBytes)).toEqual([
      "0 B", "12 B", "1023 B", "1.0 KB", "2.0 KB", "3.0 MB", "38.2 MB", "2.3 GB", "29.8 GB",
    ]);
  });

  it("a machine size's memory reads as GB, whole when it is whole and with the fraction when there is one", () => {
    expect([1536, 2048, 3000, 4096, 32768].map(fmtMemGb)).toEqual(["1.5 GB", "2 GB", "2.9 GB", "4 GB", "32 GB"]);
  });

  it("has a GB tier and a decimal at MB, where the engine's old rule rounded whole megabytes and stopped at MB", () => {
    expect(fmtBytes(3000 * 1024 * 1024)).toBe("2.9 GB");
    expect(fmtBytes(2048 * 1024 * 1024)).toBe("2.0 GB");
    expect(fmtBytes(250 * 1024 * 1024)).toBe("250.0 MB");
  });
});

describe("one copy of the rule", () => {
  const HOME = join("packages", "protocol", "src", "format.ts");
  // Snapshot storage prints the decimal GB the provider lists and bills in; the process table's rss column has a three-digit budget.
  const EXCEPTIONS = new Set([
    join("packages", "host", "src", "storage.ts"),
    join("apps", "web", "src", "components", "machine", "SnapshotStorageLine.tsx"),
    join("apps", "web", "src", "components", "machine", "format.ts"),
  ]);
  // A byte count divided by a unit constant and closed with a unit suffix, or a table of unit suffixes.
  const RULE = /\/ ?(1024|1e9|1_000_000_000|\(1024 \* 1024\)|1024 \*\* [23]|[KMGT]I?B|[KMGT]iB)\)?[^`\n]*\} ?[KMGT]?i?B`|\[("[KMGT]?i?B?",? ?){3,}\]/;

  const hits = (rel: string): number => [...readFileSync(join(ROOT, rel), "utf8").matchAll(new RegExp(RULE.source, "g"))].length;

  it("no other source file spells out a byte formatter", () => {
    const copies = sourceFiles().filter(rel => rel !== HOME && !EXCEPTIONS.has(rel) && hits(rel) > 0);
    expect(copies).toEqual([]);
  });

  it("each recorded exception holds exactly one formatter: a folded one leaves the list, a second one is a copy", () => {
    expect([...EXCEPTIONS].map(rel => [rel, hits(rel)])).toEqual([...EXCEPTIONS].map(rel => [rel, 1]));
  });
});
