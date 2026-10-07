// SPDX-License-Identifier: AGPL-3.0-only
// node scripts/public-check.mjs <folder or .tgz>...: whether a public build
// carries a cloud provider. Every script in it is read as code, its comments
// left out, and every page, stylesheet, picture and manifest whole; the README
// is prose about the product and is not read. A provider module or its words
// is a line naming the file, and the exit is 1. The release runs it on the packed
// tarball and on the desktop app's folder before either leaves the runner.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** What a provider leaves in a bundle: its backend classes, its API's address, its key's variable and its name.
 * Solarized is a colour theme the diff viewer ships, not the provider. */
export const PROVIDER_WORDS = [/\bsolari(?!zed)/i, /\bboat\b/i, /\bBox(?:Backend|Machine)\b/, /\bBOX_API_URL\b/, /ascii\.dev/i];

const SCRIPT = new Set([".js", ".mjs", ".cjs"]);
const TEXT = new Set([".json", ".html", ".css", ".svg"]);

/** A script's code with its comments gone: every name and every literal, one to a line. */
export function codeOf(text, fileName = "bundle.js") {
  const out = [];
  const visit = node => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS));
  return out.join("\n");
}

/** Every provider word in one file's text, each once, with the code around it. */
export function wordsIn(text) {
  return PROVIDER_WORDS.flatMap(word => {
    const at = text.search(word);
    return at < 0 ? [] : [{ word: word.source, near: text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ") }];
  });
}

const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});

/** Every provider word under a folder, file by file.
 * @param {string} root
 * @returns {{ file: string, word: string, near: string }[]} */
export function providerWordsUnder(root) {
  return walk(root).flatMap(path => {
    const ext = extname(path);
    if (!SCRIPT.has(ext) && !TEXT.has(ext)) return [];
    const text = readFileSync(path, "utf8");
    return wordsIn(SCRIPT.has(ext) ? codeOf(text, path) : text).map(hit => ({ file: relative(root, path), ...hit }));
  });
}

/** Every provider word in a folder or a tarball, which is unpacked into a folder of its own and taken away after.
 * @param {string} path
 * @returns {{ file: string, word: string, near: string }[]} */
export function providerWords(path) {
  if (!path.endsWith(".tgz")) return providerWordsUnder(path);
  const dir = mkdtempSync(join(tmpdir(), "wsp-public-check-"));
  try {
    execFileSync("tar", ["-xzf", path, "-C", dir]);
    return providerWordsUnder(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: node public-check.mjs <folder or .tgz>...");
    process.exit(3);
  }
  const hits = paths.flatMap(path => providerWords(path).map(hit => ({ path, ...hit })));
  for (const hit of hits) console.error(`${hit.path}: ${hit.file}: ${hit.word} in "${hit.near}"`);
  if (hits.length > 0) {
    console.error(`a public build carries ${hits.length} cloud provider word${hits.length === 1 ? "" : "s"}: build it with PUBLIC_BUILD=1 and every package built again`);
    process.exit(1);
  }
  console.log(`no cloud provider in ${paths.join(", ")}`);
}
