// SPDX-License-Identifier: AGPL-3.0-only
// The law tests walk source parsed by TypeScript 6, the last with a JavaScript API, while tsc is 7. A parse never
// throws: on syntax it cannot read it hands back a repaired tree, which a law walks and passes over. So every file
// the repo holds must parse here with no error, and a syntax only 7 reads fails this rather than hiding a string.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { ROOT } from "./source-files.js";

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "*.ts", "*.tsx"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

/** The errors the parser recovered from, which TypeScript keeps on the source file but leaves out of its types. */
function parseErrors(rel: string): string[] {
  const sf = ts.createSourceFile(rel, readFileSync(join(ROOT, rel), "utf8"), ts.ScriptTarget.Latest, false, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const { parseDiagnostics } = sf as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
  return parseDiagnostics.map(d => `${rel}:${sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

it("parses every .ts and .tsx file the repo holds with TypeScript 6 and no error", () => {
  expect(ts.versionMajorMinor).toBe("6.0");
  const files = sourceFiles();
  expect(files.length).toBeGreaterThan(1000);
  expect(files.flatMap(parseErrors)).toEqual([]);
});
