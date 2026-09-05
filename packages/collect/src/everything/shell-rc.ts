// SPDX-License-Identifier: AGPL-3.0-only
// Pass 6. Exported variables whose name says KEY, TOKEN, SECRET or PASSWORD
// are listed by name and cut from a carried copy of the rc file, wherever
// on the line the assignment sits. Values never leave this pass, so a cut
// line takes its continuation and any open quote, substitution or heredoc
// with it.
import { RC_FILES as SHELL_RUNG_RC } from "../detect/shell.js";
import { type Machine, basename, tilde } from "./host.js";

/** fish reads every .fish file directly in this directory at startup, before config.fish. */
export const FISH_CONF_D = ".config/fish/conf.d";

/** The rc files the shell rung carries, `~`-relative, plus fish's config; fish's conf.d files come through rcFiles and isRcPath. */
export const RC_PATHS = [...SHELL_RUNG_RC.map(n => `.${n}`), ".config/fish/config.fish"] as const;

/** The names an rc file goes by, for a copy of one found under another directory. */
export const RC_NAMES: ReadonlySet<string> = new Set(RC_PATHS.map(basename));

/** Whether a `~`-relative path is an rc file: one of RC_PATHS, or a .fish file directly in conf.d. */
export function isRcPath(rel: string): boolean {
  if ((RC_PATHS as readonly string[]).includes(rel)) return true;
  return rel.slice(0, rel.lastIndexOf("/")) === FISH_CONF_D && rel.endsWith(".fish");
}

/** The rc files as `~`-relative paths: RC_PATHS and the .fish files in conf.d's listing. */
export function rcFiles(confD: readonly string[]): string[] {
  return [...RC_PATHS, ...confD.filter(n => n.endsWith(".fish")).map(n => `${FISH_CONF_D}/${n}`)];
}

export interface RcScan {
  /** `~`-relative. */
  path: string;
  /** Variable names to set on the machine by hand. */
  names: string[];
  /** The file with those assignment lines removed. */
  carried: string;
}

const SECRET_WORDS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD"]);

/** `KEYTIMEOUT` is not a key; the word has to stand alone between underscores. */
export function isSecretName(name: string): boolean {
  return name.toUpperCase().split("_").some(w => SECRET_WORDS.has(w));
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const EXPORTED = new RegExp(`^\\s*(?:export|typeset|declare|readonly|local|env)(?:\\s+-\\w+)*\\s+(.*)$`);
const FISH_SET = new RegExp(`^\\s*set(?:\\s+-\\w+)*\\s+(${NAME})(?:\\s|$)`);
const ASSIGNED = new RegExp(`^["']?(${NAME})=`);
const PLAIN = new RegExp(`^\\s*(${NAME})=`);
/** Words that open a compound command's body; what follows is a simple command of its own. */
const KEYWORDS = /^\s*(?:then|do|else|elif|if|while|until|exec|command|builtin|!)\s+/;
/** `eval 'export X=1'`: the quoted argument is shell again. */
const EVAL = /^\s*eval\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S.*))$/;

/** The simple commands of a line: split outside quotes on `;`, `&&`, `||`, `|`, `&` and braces or parentheses, comment dropped. */
export function simpleCommands(line: string): string[] {
  const out: string[] = [];
  let quote: "" | "'" | '"' = "";
  let cur = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] ?? "";
    if (c === "\\" && quote !== "'") {
      cur += c + (line[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (quote !== "") {
      cur += c;
      if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (commentAt(line, i)) break;
    if (";|&{}()".includes(c)) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(s => {
    let t = s;
    for (let m = KEYWORDS.exec(t); m !== null; m = KEYWORDS.exec(t)) t = t.slice(m[0].length);
    return t;
  }).filter(s => s.trim() !== "");
}

function assignedIn(command: string): string[] {
  const ev = EVAL.exec(command);
  if (ev !== null) return assignedNames(ev[1] ?? ev[2] ?? ev[3] ?? "");
  const fish = FISH_SET.exec(command);
  if (fish?.[1] !== undefined) return [fish[1]];
  const exported = EXPORTED.exec(command);
  if (exported?.[1] !== undefined) {
    return exported[1].split(/\s+/).map(t => ASSIGNED.exec(t)?.[1]).filter((n): n is string => n !== undefined);
  }
  const plain = PLAIN.exec(command);
  return plain?.[1] === undefined ? [] : [plain[1]];
}

function assignedNames(line: string): string[] {
  return simpleCommands(line).flatMap(assignedIn);
}

/** What is still open at the end of a line: a quote, a backtick, `$(` or `${` groups, `((` arithmetic, a heredoc waiting for its word, or a trailing backslash. */
interface Open {
  quote: "" | "'" | '"' | "`" | "$'";
  parens: number;
  braces: number;
  /** Depth of `((` and `$((`; while open, `<<` is a shift and never a heredoc. */
  arith: number;
  heredoc?: string;
  continues: boolean;
}

const CLOSED: Open = { quote: "", parens: 0, braces: 0, arith: 0, continues: false };

function isOpen(o: Open): boolean {
  return o.quote !== "" || o.parens > 0 || o.braces > 0 || o.heredoc !== undefined || o.continues;
}

/** `<<WORD`, `<<-WORD`, `<<"WORD"`, `<<\WORD`: the word starts with a letter or underscore, so `x << 2` is arithmetic. The caller skips `<<<` (a here-string) and `<<` inside `(( ))` before this runs. */
const HEREDOC = /^<<-?\s*(?:"([A-Za-z_]\w*)"|'([A-Za-z_]\w*)'|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))/;

/** A `#` outside quotes at the start of a word begins a comment; nothing after it is shell. After `(` or `{` it is a zsh glob flag, a brace expansion or `${#var}`, never a comment. */
function commentAt(line: string, i: number): boolean {
  return line[i] === "#" && (i === 0 || /[\s;&|]/.test(line[i - 1] ?? ""));
}

/** Carries the shell's quoting state across a line. Inside a heredoc only the terminator word matters. */
function scanLine(line: string, start: Open): Open {
  const o: Open = { ...start, continues: false };
  if (o.heredoc !== undefined) {
    if (line.trim() === o.heredoc) delete o.heredoc;
    return o;
  }
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    o.continues = false;
    if (c === "\\" && o.quote !== "'") {
      if (i === line.length - 1) o.continues = true;
      i += 1;
      continue;
    }
    if (o.quote === "$'") {
      if (c === "'") o.quote = "";
      continue;
    }
    if (o.quote === "'" || o.quote === "`") {
      if (c === o.quote) o.quote = "";
      continue;
    }
    if (o.quote === "" && commentAt(line, i)) break;
    if (o.quote === "" && c === "$" && line[i + 1] === "'") {
      o.quote = "$'";
      i += 1;
      continue;
    }
    if (o.quote === "" && (c === "'" || c === "`")) {
      o.quote = c;
      continue;
    }
    if (c === '"') {
      o.quote = o.quote === '"' ? "" : '"';
      continue;
    }
    if (o.quote === "" && c === "$" && line[i + 1] === "(" && line[i + 2] === "(") {
      o.arith += 1;
      i += 2;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      o.parens += 1;
      i += 1;
      continue;
    }
    if (c === "$" && line[i + 1] === "{") {
      o.braces += 1;
      i += 1;
      continue;
    }
    if (o.quote === "" && c === "(" && line[i + 1] === "(") {
      o.arith += 1;
      i += 1;
      continue;
    }
    if (o.quote === "" && c === ")" && line[i + 1] === ")" && o.arith > 0) {
      o.arith -= 1;
      i += 1;
      continue;
    }
    if (c === ")" && o.parens > 0) {
      o.parens -= 1;
      continue;
    }
    if (c === "}" && o.braces > 0) {
      o.braces -= 1;
      continue;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] === "<") {
      i += 2;
      continue;
    }
    if (o.quote === "" && o.arith === 0 && c === "<") {
      const m = HEREDOC.exec(line.slice(i));
      const word = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4];
      if (word !== undefined) {
        o.heredoc = word;
        break;
      }
    }
  }
  return o;
}

/** What a kept line may carry forward: a heredoc it opens and the depth of an arithmetic block it left open, and nothing else, since a comment's stray quote must never hide what follows. An open `((` only stops `<<` from being read as a heredoc until its `))`, which over-cuts a heredoc body and never leaks. */
function carried(line: string, arith: number): Pick<Open, "heredoc" | "arith"> {
  const o = scanLine(line, { ...CLOSED, arith });
  return { heredoc: o.heredoc, arith: o.arith };
}

/** The arithmetic depth is one stream over the file: a cut line reads it and writes it back like a kept line does. */
export function stripExports(text: string): { names: string[]; carried: string } {
  const names: string[] = [];
  const kept: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let cutting: Open | undefined;
  let passing: Pick<Open, "heredoc" | "arith"> = { arith: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (cutting !== undefined) {
      const o = scanLine(line, cutting);
      if (isOpen(o)) cutting = o;
      else {
        cutting = undefined;
        passing = { arith: o.arith };
      }
      continue;
    }
    if (passing.heredoc !== undefined) {
      kept.push(line);
      if (line.trim() === passing.heredoc) passing = { arith: passing.arith };
      continue;
    }
    const hits = assignedNames(line).filter(isSecretName);
    if (hits.length === 0) {
      kept.push(line);
      passing = carried(line, passing.arith);
      continue;
    }
    for (const h of hits) if (!names.includes(h)) names.push(h);
    const o = scanLine(line, { ...CLOSED, arith: passing.arith });
    if (isOpen(o)) cutting = o;
    else passing = { arith: o.arith };
  }
  return { names, carried: kept.join(eol) };
}

const SOURCE = /^\s*(?:source|\.)\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;

/** The files an rc file reads with `source` or `.` by a literal path (`~/x`, `$HOME/x`, `/abs/x`), in order, once each.
 * A path holding another variable, a glob or a substitution is skipped: what it means is only known to a running shell. */
export function sourcedPaths(text: string, home: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const cmd of simpleCommands(line.replace(/\$\{HOME\}/g, "$HOME"))) {
      const m = SOURCE.exec(cmd);
      const raw = m?.[1] ?? m?.[2] ?? m?.[3];
      if (raw === undefined) continue;
      const p = raw.replace(/^(?:~|\$HOME)(?=\/)/, home);
      if (!p.startsWith("/") || /[$`*?[]/.test(p) || out.includes(p)) continue;
      out.push(p);
    }
  }
  return out;
}

export interface ShellRcOptions {
  /** Collects rc files that exist but could not be read. */
  notes?: string[];
  /** Collects the files the rc files source, resolved, so a copy of one under another row is known to be stripped by identity. */
  sourced?: Set<string>;
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

export async function shellRc(m: Machine, opts: ShellRcOptions = {}): Promise<RcScan[]> {
  const out: RcScan[] = [];
  // Read through the link so a stowed rc file is scanned; the scan is reported under the path the shell reads.
  const scan = async (path: string): Promise<string | undefined> => {
    const real = (await m.fs.realpath(path)) ?? path;
    const text = await m.fs.readText(real);
    if (text === undefined) {
      if ((await m.fs.stat(real))?.kind === "file") opts.notes?.push(`${tilde(m.home, path)} could not be read (over 1 MiB or unreadable) and was not scanned`);
      return undefined;
    }
    const s = stripExports(text);
    if (s.names.length > 0) out.push({ path: tilde(m.home, path), ...s });
    return text;
  };
  const rcs = rcFiles(await m.fs.list(`${m.home}/${FISH_CONF_D}`)).map(rel => `${m.home}/${rel}`);
  const own = new Set<string>();
  for (const p of rcs) own.add((await m.fs.realpath(p)) ?? p);
  const followed = new Set<string>();
  for (const path of rcs) {
    const text = await scan(path);
    if (text === undefined) continue;
    // One level: what an rc file sources is an rc file too; what those source in turn is not followed.
    for (const s of sourcedPaths(text, m.home)) {
      const real = await m.fs.realpath(s);
      if (real === undefined || !under(real, m.home) || own.has(real) || followed.has(real) || (await m.fs.stat(real))?.kind !== "file") continue;
      followed.add(real);
      opts.sourced?.add(real);
      await scan(s);
    }
  }
  return out;
}
