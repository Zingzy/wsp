// SPDX-License-Identifier: AGPL-3.0-only
// Each area keeps an AGENTS.md of what bit people; a note that names a file, function or test the code has since
// moved or dropped sends the next reader after something that is not there, so the names are held here. Codex reads
// at most 32 KiB of these files, so the set stays well under that.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "./source-files.js";

const NOTES = ["packages/runtime", "packages/host", "packages/protocol", "apps/web", "daemon"].map(d => `${d}/AGENTS.md`);
const MAX_LINES = 80;
const MAX_NOTE_BYTES = 4096;
const MAX_SET_BYTES = 26 * 1024;
const PARTS = ["## How it works", "## Invariants", "## Traps", "## One home for"];
const SOURCE = ["*.ts", "*.tsx", "*.mts", "*.mjs", "*.js", "*.rs"];

/** Every backticked span of a note. */
function spans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map(m => m[1]!);
}

/** A span naming a file or folder in the tree: it has a slash or a source extension, and no space or home prefix. */
function isPath(span: string): boolean {
  if (/\s|^[~/$-]|:\/\/|[*<>{}]/.test(span)) return false;
  return span.includes("/") || /\.(ts|tsx|mts|mjs|js|rs|md|json|toml|sh)$/.test(span);
}

/** A span naming a code symbol: `name()` or `a.name()` for a function, or a bare identifier with a capital or an
 * underscore in it. A lower-case single word is prose in code type, a field or a command, and is not held. */
function symbolOf(span: string): string | null {
  const call = /^(?:[A-Za-z_$][\w$]*(?:\.|::))*([A-Za-z_$][\w$]*)\(\)$/.exec(span);
  if (call) return call[1]!;
  if (/^[A-Za-z_$][\w$]*$/.test(span) && /[A-Z_]/.test(span)) return span;
  return null;
}

/** Where each name is declared in the tracked source, by repo-relative file: a function, a binding, a type, a method
 * or a Rust item. A line-start key in an object literal and a bare call statement are not declarations. */
function declared(names: readonly string[]): Map<string, Set<string>> {
  const alt = names.map(n => n.replace(/\$/g, "\\$")).join("|");
  const keyword = new RegExp(`\\b(?:function\\*?|const|let|var|class|interface|type|enum|fn|struct|trait|mod|macro_rules!)\\s+(${alt})\\b`, "g");
  const member = new RegExp(`^[ \\t]*(?:export\\s+)?(?:pub(?:\\([a-z]+\\))?\\s+)?(?:(?:private|public|protected|static|readonly)\\s+)*(?:async\\s+)?(?:get\\s+|set\\s+)?(${alt})\\??\\s*[(<].*$`, "gm");
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SOURCE], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string): void => void (found.get(name) ?? found.set(name, new Set()).get(name)!).add(file);
  for (const f of files.split("\0")) {
    if (f === "" || !existsSync(join(ROOT, f))) continue;
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const m of text.matchAll(keyword)) add(m[1]!, f);
    for (const m of text.matchAll(member)) if (!/;\s*$/.test(m[0]) || /\)\s*:/.test(m[0])) add(m[1]!, f);
  }
  return found;
}

/** Each row of the note's one-home table as the file it names, repo-relative, and the functions in its last cell. */
function homeRows(text: string, folder: string): { file: string; names: string[] }[] {
  const rows: { file: string; names: string[] }[] = [];
  for (const line of part(text, "## One home for").split("\n")) {
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    const file = /^`([^`]+)`$/.exec(cells[1] ?? "")?.[1];
    if (cells.length !== 3 || file === undefined) continue;
    const names = spans(cells[2]!).map(symbolOf).filter((n): n is string => n !== null);
    rows.push({ file: existsSync(join(ROOT, folder, file)) ? join(folder, file) : file, names });
  }
  return rows;
}

/** A span naming a test file or a test folder. */
function isTestPath(span: string): boolean {
  return isPath(span) && /(\.test\.tsx?$|(^|\/)tests?(\/|$))/.test(span);
}

/** The Rust test functions in the tracked source, by name. */
function rustTests(): Set<string> {
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.rs"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  const out = new Set<string>();
  for (const f of files.split("\0")) {
    if (f === "" || !existsSync(join(ROOT, f))) continue;
    for (const m of readFileSync(join(ROOT, f), "utf8").matchAll(/#\[(?:tokio::)?test[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*(?:async\s+)?fn\s+(\w+)/g)) out.add(m[1]!);
  }
  return out;
}

/** The text under a heading, up to the next heading of the same level. */
function part(text: string, heading: string): string {
  const at = text.indexOf(`\n${heading}\n`);
  if (at < 0) return "";
  const body = text.slice(at + heading.length + 2);
  const next = body.search(/^## /m);
  return next < 0 ? body : body.slice(0, next);
}

/** Each numbered item of a part, with its indented continuation lines. */
function numbered(body: string): string[] {
  const items: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\d+\. /.test(line)) items.push(line);
    else if (/^\s+\S/.test(line) && items.length > 0) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

describe("the notes together", () => {
  it(`stay within ${MAX_SET_BYTES / 1024} KiB, root included`, () => {
    const bytes = ["AGENTS.md", ...NOTES].reduce((n, f) => n + (existsSync(join(ROOT, f)) ? readFileSync(join(ROOT, f)).length : 0), 0);
    expect(bytes).toBeLessThanOrEqual(MAX_SET_BYTES);
  });

  it("are each pointed at from the root note, which keeps a short map and a glossary", () => {
    const root = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(NOTES.filter(n => !root.includes(`\`${n}\``))).toEqual([]);
    expect(part(root, "## Map").trim().split("\n").length).toBeLessThanOrEqual(10);
    const terms = part(root, "## Glossary").split("\n").filter(l => /^- \*\*/.test(l));
    expect(terms.length).toBeGreaterThanOrEqual(15);
    expect(terms.filter(l => !/ Avoid: /.test(l))).toEqual([]);
  });

  it("name in the root note only files and symbols the tree still has", () => {
    const text = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
    expect(spans(text).filter(isPath).filter(p => !existsSync(join(ROOT, p)))).toEqual([]);
    const names = [...new Set(spans(text).map(symbolOf).filter((n): n is string => n !== null))];
    const found = declared(names);
    expect(names.filter(n => !found.has(n))).toEqual([]);
  });
});

describe.each(NOTES)("%s", note => {
  const file = join(ROOT, note);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";

  it("exists, with a CLAUDE.md beside it that links to it", () => {
    expect(text).not.toBe("");
    const link = join(dirname(file), "CLAUDE.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("AGENTS.md");
  });

  it(`stays within ${MAX_LINES} lines and ${MAX_NOTE_BYTES} bytes`, () => {
    expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(MAX_LINES);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_NOTE_BYTES);
  });

  it("has its four parts in order", () => {
    const at = PARTS.map(p => text.indexOf(`\n${p}\n`));
    expect(at.every(i => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("says how the area works in three to five lines", () => {
    const lines = part(text, "## How it works").split("\n").filter(l => l.trim() !== "");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("names the test behind every invariant, or says it has none yet", () => {
    const items = numbered(part(text, "## Invariants"));
    expect(items.length).toBeGreaterThan(0);
    const rust = rustTests();
    const tested = (item: string): boolean =>
      item.includes("(no test yet)") || spans(item).some(s => isTestPath(s) || rust.has(symbolOf(s) ?? ""));
    expect(items.filter(i => !tested(i))).toEqual([]);
  });

  it("ends every trap with the ticket that paid for it", () => {
    const traps = text.slice(text.indexOf("\n## Traps\n"), text.indexOf("\n## One home for\n"));
    const items = traps.split("\n").filter(l => /^- /.test(l));
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter(l => !/\(#\d+(, #\d+)*\)\.?$/.test(l))).toEqual([]);
  });

  it("names only files that exist, from its own folder or the repo root", () => {
    const missing = spans(text).filter(isPath).filter(p => !existsSync(join(dirname(file), p)) && !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it("names only functions and symbols the source still declares", () => {
    const names = [...new Set(spans(text).map(symbolOf).filter((n): n is string => n !== null))];
    expect(names.length).toBeGreaterThan(0);
    const found = declared(names);
    expect(names.filter(n => !found.has(n))).toEqual([]);
  });

  it("finds each one-home function declared in the file its row names", () => {
    const rows = homeRows(text, dirname(note));
    expect(rows.length).toBeGreaterThan(0);
    const found = declared([...new Set(rows.flatMap(r => r.names))]);
    const astray = rows.flatMap(r => r.names.filter(n => !found.get(n)?.has(r.file)).map(n => `${n} in ${r.file}`));
    expect(astray).toEqual([]);
  });
});
