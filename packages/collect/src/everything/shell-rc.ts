// SPDX-License-Identifier: AGPL-3.0-only
// Pass 6. Exported variables whose name says KEY, TOKEN, SECRET or PASSWORD
// are listed by name and cut from a carried copy of the rc file, wherever
// on the line the assignment sits. Values never leave this pass, so a cut
// line takes its continuation and any open quote, substitution or heredoc
// with it.
import { RC_FILES as SHELL_RUNG_RC } from "../detect/shell.js";
import { type Machine, tilde } from "./host.js";

/** The rc files the shell rung carries, `~`-relative, plus fish's config. */
export const RC_PATHS = [...SHELL_RUNG_RC.map(n => `.${n}`), ".config/fish/config.fish"] as const;

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
function simpleCommands(line: string): string[] {
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

/** How many kept lines an open `((` may span before the depth is dropped; an unbalanced `((` then only stops `<<` from reading as a heredoc on those lines. */
const ARITH_LINES = 4;

interface Passing {
  heredoc?: string;
  arith: number;
  /** Kept lines carried since the `((` opened. */
  since: number;
}

/** What a kept line may carry forward: a heredoc it opens and the depth of an arithmetic block it left open, for at most ARITH_LINES lines, and nothing else, since a comment's stray quote must never hide what follows. */
function carried(line: string, prev: Passing): Passing {
  const o = scanLine(line, { ...CLOSED, arith: prev.arith });
  if (o.arith === 0) return { heredoc: o.heredoc, arith: 0, since: 0 };
  const since = prev.arith > 0 ? prev.since + 1 : 1;
  return since >= ARITH_LINES ? { heredoc: o.heredoc, arith: 0, since: 0 } : { heredoc: o.heredoc, arith: o.arith, since };
}

export function stripExports(text: string): { names: string[]; carried: string } {
  const names: string[] = [];
  const kept: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let cutting: Open | undefined;
  let passing: Passing = { arith: 0, since: 0 };
  for (const line of text.split(/\r?\n/)) {
    if (cutting !== undefined) {
      const o = scanLine(line, cutting);
      cutting = isOpen(o) ? o : undefined;
      continue;
    }
    if (passing.heredoc !== undefined) {
      kept.push(line);
      if (line.trim() === passing.heredoc) passing = { arith: passing.arith, since: passing.since };
      continue;
    }
    const hits = assignedNames(line).filter(isSecretName);
    if (hits.length === 0) {
      kept.push(line);
      passing = carried(line, passing);
      continue;
    }
    for (const h of hits) if (!names.includes(h)) names.push(h);
    const o = scanLine(line, CLOSED);
    if (isOpen(o)) cutting = o;
  }
  return { names, carried: kept.join(eol) };
}

export interface ShellRcOptions {
  /** Collects rc files that exist but could not be read. */
  notes?: string[];
}

export async function shellRc(m: Machine, opts: ShellRcOptions = {}): Promise<RcScan[]> {
  const out: RcScan[] = [];
  for (const name of RC_PATHS) {
    const path = `${m.home}/${name}`;
    const text = await m.fs.readText(path);
    if (text === undefined) {
      if ((await m.fs.stat(path))?.kind === "file") opts.notes?.push(`${tilde(m.home, path)} could not be read (over 1 MiB or unreadable) and was not scanned`);
      continue;
    }
    const s = stripExports(text);
    if (s.names.length > 0) out.push({ path: tilde(m.home, path), ...s });
  }
  return out;
}
