// SPDX-License-Identifier: AGPL-3.0-only
// Pass 4. Files that look like credentials, by name, by mode, by the key
// names in a JSON, YAML, TOML or KEY=value file, or by a PEM header. Every
// hit is a flag for the person to see; nothing here is ever pre-ticked, and
// no value read here leaves this function.
import { isLarge } from "./gate.js";
import { type Entry, type Machine, basename } from "./host.js";
import type { Dir } from "./roles.js";
import { roleByName } from "./roles.js";
import { RC_FILES } from "./shell-rc.js";
import { budget, walk } from "./walk.js";

export type Signal = "name" | "mode" | "keys" | "pem" | "gitleaks" | "catalog";

export interface Credential {
  /** Absolute. A directory when the whole tree is key material. */
  path: string;
  bytes: number;
  files: number;
  mode: number;
  mtime: number;
  signals: Signal[];
}

export interface CredentialScan {
  found: Credential[];
  /** What was skipped and why, for the person. */
  notes: string[];
}

export interface CredentialsOptions {
  clock?: () => number;
}

export const MAX_BYTES = 100 * 1024;
export const GITLEAKS_MAX_ROOTS = 50;
const SCAN_DEPTH = 3;

const NAME_PATTERNS = [
  /^\.?credentials/i,
  /^auth\.json$/,
  /^hosts\.yml$/,
  /access[-_]token/i,
  /\.pem$/,
  /\.key$/,
  /^key$/,
  /^id_[a-z0-9]+$/,
  /^\.?netrc$/,
  /^\.env(\..+)?$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /(^|[._-])tokens?([._-]|$)/i,
  /(^|[._-])secrets?([._-]|$)/i,
];
const SKIP_SUFFIXES = [".example", ".sample", ".template", ".dist", ".pub", ".lock"];
/** Owner-only by habit, never a secret. */
const SKIP_NAMES = new Set([".viminfo", ".CFUserTextEncoding", ".z", "known_hosts", ".envrc"]);
const SOURCE_EXTENSIONS = new Set(["go", "ts", "tsx", "js", "mjs", "cjs", "py", "rs", "c", "h", "cc", "cpp", "java", "rb", "md", "html", "css", "svg", "png", "jpg", "gif", "ico", "woff", "woff2", "ttf", "zip", "gz", "tar", "wasm", "node", "so", "dylib"]);
/** Shapes worth opening for key names: the structured formats, plus files without an extension (config, token, .boto). */
const READABLE_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "pem", "key", "env", ""]);
/** Mode on its own is only believed for a structured file. */
const STRUCTURED_EXTENSIONS = new Set(["json", "yaml", "yml", "toml"]);
/** Key names that hold a secret, after `accessToken` and `client-secret` are read as snake case. Bare `key` is left out (a keybinding or a public key far more often) and so is a `_password` suffix (`generate_password` is a command). */
const KEY_NAMES = new Set(["token", "password", "passwd", "secret", "bearer", "auths", "credentials", "_authtoken", "apikey", "api_key", "private_key", "secret_key", "access_key", "secret_access_key"]);
const KEY_SUFFIXES = ["_token", "_secret", "_api_key", "_apikey", "_private_key", "_secret_access_key"];
/** Whole directories of key material; listed as one credential, never read or walked. */
const CREDENTIAL_DIRS = new Set([".gnupg", ".password-store"]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function skippedName(name: string): boolean {
  return SKIP_NAMES.has(name) || /_history$/.test(name) || SKIP_SUFFIXES.some(s => name.endsWith(s)) || SOURCE_EXTENSIONS.has(extension(name));
}

export function nameSignal(name: string): boolean {
  if (skippedName(name)) return false;
  return NAME_PATTERNS.some(p => p.test(name));
}

export function modeSignal(e: Entry): boolean {
  return (e.mode & 0o077) === 0 && e.bytes > 0 && e.bytes <= MAX_BYTES;
}

function jsonKeys(data: unknown, depth: number, out: string[]): void {
  if (typeof data !== "object" || data === null || Array.isArray(data) || depth > SCAN_DEPTH) return;
  for (const [k, v] of Object.entries(data)) {
    out.push(k);
    jsonKeys(v, depth + 1, out);
  }
}

/** Key names at any depth of a JSON object, or the `key:` / `key =` heads of a YAML, TOML, JSONC or KEY=value file. */
export function topLevelKeys(text: string): string[] {
  try {
    const out: string[] = [];
    jsonKeys(JSON.parse(text), 1, out);
    return out;
  } catch {
    const keys: string[] = [];
    for (const line of text.split("\n")) {
      const m = /^\s*(?:\/\/[^\s:]+\/:)?"?([A-Za-z_][\w.-]*)"?\s*[:=]/.exec(line);
      if (m?.[1] !== undefined) keys.push(m[1]);
    }
    return keys;
  }
}

/** `accessToken` reads as `access_token`. */
function normalizeKey(k: string): string {
  return k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
}

export function keysSignal(text: string): boolean {
  return topLevelKeys(text).some(k => {
    const n = normalizeKey(k);
    return KEY_NAMES.has(n) || KEY_SUFFIXES.some(sfx => n.endsWith(sfx));
  });
}

export function pemSignal(text: string): boolean {
  return /^-----BEGIN[ A-Z0-9_-]*PRIVATE KEY/.test(text.trimStart());
}

// Mode alone is believed only for a structured file right inside its app directory whose content did
// not parse as plain config: deeper down, or once the keys read as settings, it marks tracker files,
// lock files and themes far more often than secrets.
async function inspect(m: Machine, path: string, e: Entry, shallow: boolean): Promise<Credential | undefined> {
  const name = basename(path);
  const ext = extension(name);
  if (e.bytes === 0 || skippedName(name)) return undefined;
  const signals: Signal[] = [];
  if (nameSignal(name)) signals.push("name");
  if (modeSignal(e)) signals.push("mode");
  let parsed = false;
  if (e.bytes > 0 && e.bytes <= MAX_BYTES && READABLE_EXTENSIONS.has(ext)) {
    const text = await m.fs.readText(path);
    if (text !== undefined && /^\s*(\{\s*\}|\[\s*\])?\s*$/.test(text)) return undefined;
    if (text !== undefined) {
      parsed = topLevelKeys(text).length > 0;
      if (keysSignal(text)) signals.push("keys");
      if (pemSignal(text)) signals.push("pem");
    }
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1 && signals[0] === "mode" && !(shallow && STRUCTURED_EXTENSIONS.has(ext) && !parsed)) return undefined;
  return { path, bytes: e.bytes, files: 1, mode: e.mode, mtime: e.mtime, signals };
}

/** `gitleaks dir --redact` JSON report: File and RuleID only; Secret and Match are redacted by the flag and never read. A relative File is joined to root. */
export function parseGitleaks(text: string, root = ""): Map<string, string[]> {
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
    const abs = file.startsWith("/") || root === "" ? file : `${root}/${file}`;
    out.set(abs, [...(out.get(abs) ?? []), rule]);
  }
  return out;
}

// gitleaks dir takes one path and never enters a symlinked directory, so it is one process per root;
// the roots are the small unknown ones, where a secret would hide among config, capped in number.
async function gitleaks(m: Machine, roots: string[], notes: string[]): Promise<Map<string, string[]>> {
  const hits = new Map<string, string[]>();
  if (roots.length === 0 || !(await m.exec.which("gitleaks"))) return hits;
  if (roots.length > GITLEAKS_MAX_ROOTS) {
    notes.push(`gitleaks skipped: ${roots.length} candidate roots, the cap is ${GITLEAKS_MAX_ROOTS}`);
    return hits;
  }
  for (const root of roots) {
    const out = await m.exec.run("gitleaks", ["dir", root, "--redact", "--no-banner", "--exit-code", "0", "--report-format", "json", "--report-path", "/dev/stdout"]);
    for (const [file, rules] of parseGitleaks(out ?? "", root)) hits.set(file, rules);
  }
  return hits;
}

/** Scans the records still unclassified after pass 2; rc files belong to pass 6, and git work trees and cache or state subtrees are left alone. */
export async function credentials(m: Machine, dirs: readonly Dir[], opts: CredentialsOptions = {}): Promise<CredentialScan> {
  const clock = opts.clock ?? Date.now;
  const notes: string[] = [];
  const found = new Map<string, Credential>();
  const files: [string, Entry, boolean][] = [];
  const roots: string[] = [];
  const rc = new Set(RC_FILES.map(n => `${m.home}/${n}`));
  for (const d of dirs) {
    if (d.role !== "unknown" || rc.has(d.path)) continue;
    const e = await m.fs.stat(d.linkTarget ?? d.path);
    if (e === undefined || e.kind === "link") continue;
    if (e.kind === "file") {
      files.push([d.path, e, true]);
      continue;
    }
    if (CREDENTIAL_DIRS.has(basename(d.path))) {
      found.set(d.path, { path: d.path, bytes: d.bytes, files: d.files, mode: e.mode, mtime: d.mtime, signals: ["name"] });
      continue;
    }
    if (!isLarge(d) && d.measured === "exact") roots.push(d.path);
    const where = d.linkTarget ?? d.path;
    await walk(m.fs, where, { maxDepth: SCAN_DEPTH, budget: budget(clock), skip: n => roleByName(n) !== undefined, skipTree: names => names.includes(".git") }, (p, fe) => {
      const inside = p.slice(where.length + 1);
      files.push([`${d.path}/${inside}`, fe, !inside.includes("/")]);
    });
  }
  for (const [p, e, shallow] of files) {
    const c = await inspect(m, p, e, shallow);
    if (c !== undefined) found.set(p, c);
  }
  for (const [file, rules] of await gitleaks(m, roots, notes)) {
    const hit = found.get(file);
    if (hit !== undefined) {
      hit.signals.push("gitleaks");
      continue;
    }
    const e = await m.fs.stat(file);
    if (e?.kind === "file" && rules.length > 0) found.set(file, { path: file, bytes: e.bytes, files: 1, mode: e.mode, mtime: e.mtime, signals: ["gitleaks"] });
  }
  return { found: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)), notes };
}
