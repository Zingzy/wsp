// SPDX-License-Identifier: AGPL-3.0-only
// pnpm exec vitest run $(node scripts/affected-tests.mjs <base>)
//
// The vitest filters for the change from <base> to HEAD, one per line: the folder of every workspace package a
// changed file sits in and of every package that declares one as a dependency, however indirectly; every test file
// that imports a changed file through any chain of imports, across packages; a changed test file by itself; and the
// files that run on every change. Nothing on stdout means the whole suite: a change to the root config, the
// workflows or a folder this file does not map. Why each one was picked goes to stderr.
// --changed-tests prints instead the test files the change added or modified, which the flake gate repeats, and
// --always (no base) the files that run on every change: the ones named below, and every test that lists the whole
// tree through source-files.ts, which is how a law check over all packages is written.
// Committed changes only, so CI and a gate on a checkout of the same commit pick the same files.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ALWAYS = [
  "packages/host/test/parity.test.ts",
  "packages/host/test/skill.test.ts",
  "packages/host/test/contract.test.ts",
  "packages/host/test/memory.test.ts",
  "packages/protocol/test/stub-script.test.ts",
  // Laws over every package that read more than source-files.ts lists: every manifest, and the .css beside the code.
  "packages/protocol/test/license.test.ts",
  "apps/web/test/no-separator-dots.test.ts",
];
const WHOLE_TREE = "packages/protocol/test/source-files.ts";
const TEST = /\.test\.(ts|tsx|mjs)$/;
const TESTS_FOLDER = /(^|\/)test\//;
const SOURCE = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|new URL\(\s*)["']([^"'\n]+)["']/g;
/** Folders outside the workspace packages that tests read by path, and the tests that read them: no import names
 * these, so the graph cannot see them. A top folder missing here runs the whole suite. */
const OUTSIDE = {
  // No test reads the repo's own agent skills.
  ".claude": [],
  ".githooks": ["packages/host/test/githooks.test.ts", "packages/host/test/hooks-path.test.ts"],
  daemon: ["packages/protocol/", "packages/engine/", "packages/runtime/", "packages/daemon/", "packages/host/", "packages/wspx/"],
  // Read by the license law alone, which runs on every change.
  docs: [],
  skills: ["packages/host/", "packages/wspx/", "apps/desktop/"],
};

const args = process.argv.slice(2);
const changedTests = args.includes("--changed-tests");
const always = args.includes("--always");
const base = args.find(arg => !arg.startsWith("--"));
if (base === undefined && !always) {
  process.stderr.write("usage: node scripts/affected-tests.mjs <base> [--changed-tests] | --always\n");
  process.exit(3);
}

const git = (...words) => execFileSync("git", words, { encoding: "utf8", maxBuffer: 64 << 20 });
const root = git("rev-parse", "--show-toplevel").trim();
const diff = filter => git("diff", "--name-only", "--no-renames", ...filter, base, "HEAD").split("\n").filter(Boolean);
const tracked = git("ls-files").split("\n").filter(Boolean);
const why = (target, reason) => process.stderr.write(`${target}  ${reason}\n`);

/** Each workspace package by its folder, read off the globs pnpm-workspace.yaml lists. */
const packages = new Map();
const globs = [...readFileSync(join(root, "pnpm-workspace.yaml"), "utf8").matchAll(/^\s*-\s*["']?([\w.-]+)\/\*["']?\s*$/gm)].map(m => m[1]);
for (const file of tracked) {
  const parts = file.split("/");
  if (parts.length !== 3 || parts[2] !== "package.json" || !globs.includes(parts[0])) continue;
  const manifest = JSON.parse(readFileSync(join(root, file), "utf8"));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
  packages.set(`${parts[0]}/${parts[1]}`, { name: manifest.name, uses: Object.keys(deps).filter(dep => String(deps[dep]).startsWith("workspace:")) });
}
const byName = new Map([...packages].map(([dir, { name }]) => [name, dir]));

function packageOf(file) {
  const parts = file.split("/");
  const dir = `${parts[0]}/${parts[1]}`;
  return parts.length > 2 && packages.has(dir) ? dir : undefined;
}

if (changedTests) {
  for (const file of diff(["--diff-filter=AM"])) if (TEST.test(file) && packageOf(file) !== undefined) process.stdout.write(`${file}\n`);
  process.exit(0);
}

const files = new Set(tracked);
const ENDINGS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js", ".d.ts", "/index.ts", "/index.tsx", "/index.js"];
/** The tracked files a specifier names, as vitest's aliases and TypeScript's .js-for-.ts rule find them; a folder
 * names every file under it. */
function resolve(path) {
  const bare = path.replace(/\?.*$/, "").replace(/\/$/, "");
  const stem = bare.replace(/\.[mc]?js$/, "");
  for (const candidate of [...ENDINGS.map(end => bare + end), ...ENDINGS.map(end => stem + end)]) if (files.has(candidate)) return [candidate];
  return tracked.filter(file => file.startsWith(`${bare}/`));
}

/** Who imports whom, file by file and across packages, since one package's tests borrow another's helpers and only
 * the files a chain of imports reaches can see a change. An import of a package's build output, which names no
 * tracked file, stands for every file of that package outside its tests. */
const importers = new Map();
const packageImporters = new Map();
const add = (map, key, file) => (map.get(key) ?? map.set(key, new Set()).get(key)).add(file);
for (const file of tracked) {
  if (packageOf(file) === undefined || !SOURCE.test(file)) continue;
  for (const [, spec] of readFileSync(join(root, file), "utf8").matchAll(SPECIFIER)) {
    const named = spec.startsWith("@") ? byName.get(spec.split("/").slice(0, 2).join("/")) : undefined;
    if (!spec.startsWith(".") && named === undefined) continue;
    const path = named === undefined ? normalize(join(dirname(file), spec)) : `${named}/${spec.split("/").slice(2).join("/") || "src/index.ts"}`;
    const found = resolve(path);
    for (const target of found) add(importers, target, file);
    if (found.length === 0 && packageOf(path) !== undefined) add(packageImporters, packageOf(path), file);
  }
}

/** Every package that declares one of these as a workspace dependency, directly or through another. */
function declaredDependents(changed) {
  const reached = new Map(changed);
  const queue = [...changed.keys()];
  while (queue.length > 0) {
    const name = packages.get(queue.shift()).name;
    for (const [user, { uses }] of packages) {
      if (reached.has(user) || !uses.includes(name)) continue;
      reached.set(user, `declares ${name}`);
      queue.push(user);
    }
  }
  return reached;
}

/** Every test file that imports one of these, however many files lie between, with the changed file it reaches. */
function importingTests(changed) {
  const seen = new Map(changed.map(file => [file, file]));
  const queue = [...changed];
  const visit = (file, from) => seen.has(file) || (seen.set(file, seen.get(from)), queue.push(file));
  while (queue.length > 0) {
    const file = queue.shift();
    for (const user of importers.get(file) ?? []) visit(user, file);
    if (!TESTS_FOLDER.test(file) && !TEST.test(file)) for (const user of packageImporters.get(packageOf(file)) ?? []) visit(user, file);
  }
  return [...seen].filter(([file]) => TEST.test(file) && files.has(file) && !changed.includes(file));
}

const everyChange = new Map([
  ...ALWAYS.map(file => [file, "runs on every change"]),
  ...[...(importers.get(WHOLE_TREE) ?? [])]
    .filter(file => TEST.test(file) && /\b(sourceFiles|testFiles)\(/.test(readFileSync(join(root, file), "utf8")))
    .sort()
    .map(file => [file, `reads every package through ${WHOLE_TREE}`]),
]);
if (always) {
  for (const file of everyChange.keys()) process.stdout.write(`${file}\n`);
  process.exit(0);
}

const withTests = new Set(tracked.filter(file => TEST.test(file)).map(packageOf).filter(Boolean));
const picked = new Map();
const pick = (target, reason) => picked.has(target) || picked.set(target, reason);
const changedPackages = new Map();
const changedFiles = diff([]);

for (const file of changedFiles) {
  const top = file.includes("/") ? file.split("/")[0] : "";
  const dir = packageOf(file);
  if (dir !== undefined) {
    if (!TEST.test(file)) changedPackages.has(dir) || changedPackages.set(dir, `${file} changed`);
    else if (existsSync(join(root, file))) pick(file, "changed");
  } else if (top === "" && file.endsWith(".md")) {
    // The license law reads these on every change; a test reading one by URL is found through its imports below.
  } else if (top === "scripts") {
    const name = file.split("/").pop().replace(/\.[^.]+$/, "");
    for (const test of tracked.filter(t => t.endsWith(`/test/${name}.test.ts`))) pick(test, `tests ${file}`);
  } else if (Object.hasOwn(OUTSIDE, top)) for (const target of OUTSIDE[top]) pick(target, `reads ${file}`);
  else {
    why("everything", `${file} is outside the packages and the folders mapped above, so any test may read it`);
    process.exit(0);
  }
}

for (const [dir, reason] of declaredDependents(changedPackages)) if (withTests.has(dir)) pick(`${dir}/`, reason);
for (const [file, reached] of importingTests(changedFiles)) pick(file, `imports ${reached}, directly or through other files`);
for (const [file, reason] of everyChange) pick(file, reason);

const folders = [...picked.keys()].filter(target => target.endsWith("/"));
for (const [target, reason] of [...picked].sort(([a], [b]) => a.localeCompare(b))) {
  if (!target.endsWith("/") && folders.some(folder => target.startsWith(folder))) continue;
  why(target, reason);
  process.stdout.write(`${target}\n`);
}
