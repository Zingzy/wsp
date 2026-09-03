// SPDX-License-Identifier: AGPL-3.0-only
// Pass 4. Files that look like credentials, by name, by mode, by the key
// names at the top of a JSON, YAML or TOML file, or by a PEM header. Every
// hit is a flag for the person to see; nothing here is ever pre-ticked, and
// no value read here leaves this function.
import { type Entry, type Machine, basename } from "./host.js";
import type { Dir } from "./roles.js";
import { roleByName } from "./roles.js";
import { walk } from "./walk.js";

export type Signal = "name" | "mode" | "keys" | "pem" | "gitleaks";

export interface Credential {
  /** Absolute. */
  path: string;
  bytes: number;
  mode: number;
  mtime: number;
  signals: Signal[];
}

export const MAX_BYTES = 100 * 1024;
const SCAN_DEPTH = 3;

const NAME_PATTERNS = [/^credentials/i, /^auth\.json$/, /^hosts\.yml$/, /access[-_]token/i, /\.pem$/, /^id_[a-z0-9]+$/, /^\.?netrc$/, /token/i, /secret/i];
const SKIP_SUFFIXES = [".example", ".sample", ".template", ".dist", ".pub"];
const SOURCE_EXTENSIONS = new Set(["go", "ts", "tsx", "js", "mjs", "cjs", "py", "rs", "c", "h", "cc", "cpp", "java", "rb", "md", "html", "css", "svg", "png", "jpg", "gif", "ico", "woff", "woff2", "ttf", "zip", "gz", "tar", "wasm", "node", "so", "dylib"]);
const SHAPE_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "pem", "key", ""]);
const KEY_NAMES = new Set(["token", "access_token", "refresh_token", "api_key", "password", "secret", "private_key", "client_secret"]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function nameSignal(name: string): boolean {
  if (SKIP_SUFFIXES.some(s => name.endsWith(s))) return false;
  if (SOURCE_EXTENSIONS.has(extension(name))) return false;
  return NAME_PATTERNS.some(p => p.test(name));
}

export function modeSignal(e: Entry): boolean {
  return (e.mode & 0o077) === 0 && e.bytes > 0 && e.bytes <= MAX_BYTES;
}

/** Top-level key names of a JSON object, or the `key:` / `key =` heads of an indented-format file. */
export function topLevelKeys(text: string): string[] {
  try {
    const data: unknown = JSON.parse(text);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? Object.keys(data) : [];
  } catch {
    const keys: string[] = [];
    for (const line of text.split("\n")) {
      const m = /^([A-Za-z_][\w.-]*)\s*[:=]/.exec(line);
      if (m?.[1] !== undefined) keys.push(m[1]);
    }
    return keys;
  }
}

export function keysSignal(text: string): boolean {
  return topLevelKeys(text).some(k => KEY_NAMES.has(k.toLowerCase().replace(/-/g, "_")));
}

export function pemSignal(text: string): boolean {
  return /^-----BEGIN[ A-Z0-9_-]*PRIVATE KEY/.test(text.trimStart());
}

// Mode on its own is only believed for a file right inside its app directory with a credential-shaped
// extension: deeper down it marks tracker files, lock files and logs far more often than secrets.
async function inspect(m: Machine, path: string, e: Entry, shallow: boolean): Promise<Credential | undefined> {
  const name = basename(path);
  const ext = extension(name);
  if (SKIP_SUFFIXES.some(s => name.endsWith(s)) || SOURCE_EXTENSIONS.has(ext)) return undefined;
  const signals: Signal[] = [];
  if (nameSignal(name)) signals.push("name");
  if (modeSignal(e)) signals.push("mode");
  if (e.bytes > 0 && e.bytes <= MAX_BYTES && SHAPE_EXTENSIONS.has(ext)) {
    const text = await m.fs.readText(path);
    if (text !== undefined) {
      if (keysSignal(text)) signals.push("keys");
      if (pemSignal(text)) signals.push("pem");
    }
  }
  if (signals.length === 0 || (signals.length === 1 && signals[0] === "mode" && !(shallow && SHAPE_EXTENSIONS.has(ext)))) return undefined;
  return { path, bytes: e.bytes, mode: e.mode, mtime: e.mtime, signals };
}

/** `gitleaks dir --redact` JSON report: File and RuleID only; Secret and Match are redacted by the flag and never read. */
export function parseGitleaks(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return out;
  }
  if (!Array.isArray(data)) return out;
  for (const f of data) {
    if (typeof f !== "object" || f === null) continue;
    const file = (f as Record<string, unknown>)["File"];
    const rule = (f as Record<string, unknown>)["RuleID"];
    if (typeof file !== "string" || typeof rule !== "string") continue;
    out.set(file, [...(out.get(file) ?? []), rule]);
  }
  return out;
}

async function gitleaks(m: Machine, roots: string[]): Promise<Map<string, string[]>> {
  const hits = new Map<string, string[]>();
  if (!(await m.exec.which("gitleaks"))) return hits;
  for (const root of roots) {
    const out = await m.exec.run("gitleaks", ["dir", root, "--redact", "--no-banner", "--exit-code", "0", "--report-format", "json", "--report-path", "/dev/stdout"]);
    for (const [file, rules] of parseGitleaks(out ?? "")) hits.set(file, rules);
  }
  return hits;
}

/** Scans the records still unclassified after pass 2; git work trees and cache or state subtrees are left alone. */
export async function credentials(m: Machine, dirs: readonly Dir[]): Promise<Credential[]> {
  const found = new Map<string, Credential>();
  const files: [string, Entry, boolean][] = [];
  const roots: string[] = [];
  for (const d of dirs) {
    if (d.role !== "unknown") continue;
    const e = await m.fs.stat(d.path);
    if (e === undefined || e.kind === "link") continue;
    if (e.kind === "file") {
      files.push([d.path, e, true]);
      continue;
    }
    roots.push(d.path);
    await walk(m.fs, d.path, { maxDepth: SCAN_DEPTH, skip: n => roleByName(n) !== undefined, skipTree: names => names.includes(".git") }, (p, fe) => {
      files.push([p, fe, !p.slice(d.path.length + 1).includes("/")]);
    });
  }
  for (const [p, e, shallow] of files) {
    const c = await inspect(m, p, e, shallow);
    if (c !== undefined) found.set(p, c);
  }
  for (const [file, rules] of await gitleaks(m, roots)) {
    const hit = found.get(file);
    if (hit !== undefined) {
      hit.signals.push("gitleaks");
      continue;
    }
    const e = await m.fs.stat(file);
    if (e?.kind === "file" && rules.length > 0) found.set(file, { path: file, bytes: e.bytes, mode: e.mode, mtime: e.mtime, signals: ["gitleaks"] });
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}
