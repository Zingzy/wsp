// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/file-size-check.mjs [--seed]
//
// Fails when a tracked .ts, .tsx, .mjs or .rs file outside the test folders is over 1,500 lines. A file already over
// it when the check came in is listed in file-size-known.json with its count then, and fails only when it grows past
// that count. One that drops to the limit or under, or goes, passes with a note to delete its line, so a split never
// fails its own landing. --seed writes the list from the tree as it is, which drops those lines.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 1500;
const SOURCE = /\.(ts|tsx|mjs|rs)$/;
const TESTS = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[^/]+$/;
/** Generated data, which nobody edits by hand. */
const EXEMPT = new Set(["packages/collect/src/data/linux-bottles.ts"]);

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const listPath = join(root, "scripts", "file-size-known.json");
const list = "scripts/file-size-known.json";

const counts = new Map();
for (const file of execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }).split("\0")) {
  if (!SOURCE.test(file) || TESTS.test(file) || EXEMPT.has(file)) continue;
  const text = readFileSync(join(root, file), "utf8");
  counts.set(file, text.split("\n").length - (text === "" || text.endsWith("\n") ? 1 : 0));
}

if (process.argv.includes("--seed")) {
  const over = [...counts].filter(([, lines]) => lines > LIMIT).sort(([a], [b]) => a.localeCompare(b));
  writeFileSync(listPath, `${JSON.stringify(Object.fromEntries(over), null, 2)}\n`);
  process.stdout.write(`${list}: ${over.length} files over ${LIMIT} lines\n`);
  process.exit(0);
}

const known = JSON.parse(readFileSync(listPath, "utf8"));
const failures = [];
const note = line => process.stdout.write(`${line}\n`);
for (const [file, recorded] of Object.entries(known)) {
  const lines = counts.get(file);
  if (lines === undefined) note(`${file} is gone or no longer checked: delete its line from ${list}`);
  else if (lines <= LIMIT) note(`${file} is down to ${lines} lines, within ${LIMIT}: delete its line from ${list}`);
  else if (lines > recorded) failures.push(`${file} grew to ${lines} lines, past the ${recorded} ${list} holds it to: move code out of it`);
  else if (lines < recorded) note(`${file} is down to ${lines} lines from ${recorded}; lowering its count in ${list} keeps it there`);
}
for (const [file, lines] of counts) {
  if (lines > LIMIT && !Object.hasOwn(known, file)) failures.push(`${file} has ${lines} lines, over ${LIMIT}: split it`);
}

for (const failure of failures) process.stderr.write(`${failure}\n`);
if (failures.length > 0) process.exit(1);
process.stdout.write(`${counts.size} files checked, none past ${LIMIT} lines or its recorded count\n`);
