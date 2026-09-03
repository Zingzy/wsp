// SPDX-License-Identifier: AGPL-3.0-only
// Converts a mackup checkout into data/catalog.json. Runs against the built
// package, so build first. `--check` compares instead of writing and exits 1
// on any difference, which is how a re-sync proves the file is current.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { convertMackup, renderCatalog } from "../dist/index.js";

const args = process.argv.slice(2);
const check = args.includes("--check");
const checkout = args.find(a => !a.startsWith("--"));
if (checkout === undefined) {
  console.error("usage: node scripts/convert-mackup.mjs <mackup checkout> [--check]");
  process.exit(2);
}

const appsDir = join(checkout, "src", "mackup", "applications");
const commit = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const cfgs = readdirSync(appsDir)
  .filter(f => f.endsWith(".cfg"))
  .map(f => ({ id: f.slice(0, -4), text: readFileSync(join(appsDir, f), "utf8") }));

const catalog = convertMackup(cfgs, commit);
const out = new URL("../data/catalog.json", import.meta.url);
const rendered = renderCatalog(catalog);
console.error(`${cfgs.length} cfg files at ${commit.slice(0, 7)}: ${catalog.entries.length} kept, ${catalog.dropped.length} dropped as macOS-only`);

if (check) {
  let current;
  try {
    current = readFileSync(out, "utf8");
  } catch {
    current = "";
  }
  if (current !== rendered) {
    console.error("data/catalog.json differs from the conversion; rerun without --check to update it");
    process.exit(1);
  }
  console.error("data/catalog.json is current");
} else {
  writeFileSync(out, rendered);
}
