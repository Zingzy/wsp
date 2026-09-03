// SPDX-License-Identifier: AGPL-3.0-only
// Pass 6. Exported variables whose name says KEY, TOKEN, SECRET or PASSWORD
// are listed by name and cut from a carried copy of the rc file. Values
// never leave this pass, so a cut line takes its continuation and any open
// quote, substitution or heredoc with it.
import { RC_FILES as SHELL_RUNG_RC } from "../detect/shell.js";
import { type Machine, tilde } from "./host.js";

/** The rc files the shell rung carries, `~`-relative, plus fish's config. */
export const RC_FILES = [...SHELL_RUNG_RC.map(n => `.${n}`), ".config/fish/config.fish"] as const;

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
const EXPORTED = new RegExp(`^\\s*(?:export|typeset|declare|readonly|local)(?:\\s+-\\w+)*\\s+(.*)$`);
const FISH_SET = new RegExp(`^\\s*set(?:\\s+-\\w+)*\\s+(${NAME})(?:\\s|$)`);
const ASSIGNED = new RegExp(`^["']?(${NAME})=`);

function assignedNames(line: string): string[] {
  const fish = FISH_SET.exec(line);
  if (fish?.[1] !== undefined) return [fish[1]];
  const exported = EXPORTED.exec(line);
  if (exported?.[1] !== undefined) {
    return exported[1].split(/\s+/).map(t => ASSIGNED.exec(t)?.[1]).filter((n): n is string => n !== undefined);
  }
  const plain = new RegExp(`^\\s*(${NAME})=`).exec(line);
  return plain?.[1] === undefined ? [] : [plain[1]];
}

/** What is still open at the end of a line: a quote, a backtick, `$(` groups, a heredoc waiting for its word, or a trailing backslash. */
interface Open {
  quote: "" | "'" | '"' | "`";
  parens: number;
  heredoc?: string;
  continues: boolean;
}

const CLOSED: Open = { quote: "", parens: 0, continues: false };

function isOpen(o: Open): boolean {
  return o.quote !== "" || o.parens > 0 || o.heredoc !== undefined || o.continues;
}

/** `<<WORD`, `<<-WORD`, `<<"WORD"`: the word starts with a letter or underscore, so `x << 2` is arithmetic, and `<<<` is a here-string. */
const HEREDOC = /^<<(?!<)-?\s*(?:"([A-Za-z_]\w*)"|'([A-Za-z_]\w*)'|([A-Za-z_]\w*))/;

/** A `#` outside quotes at the start of a word begins a comment; nothing after it is shell. */
function commentAt(line: string, i: number): boolean {
  return line[i] === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""));
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
    if (o.quote === "'" || o.quote === "`") {
      if (c === o.quote) o.quote = "";
      continue;
    }
    if (o.quote === "" && commentAt(line, i)) break;
    if (o.quote === "" && (c === "'" || c === "`")) {
      o.quote = c;
      continue;
    }
    if (c === '"') {
      o.quote = o.quote === '"' ? "" : '"';
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      o.parens += 1;
      i += 1;
      continue;
    }
    if (c === ")" && o.parens > 0) {
      o.parens -= 1;
      continue;
    }
    if (o.quote === "" && c === "<") {
      const m = HEREDOC.exec(line.slice(i));
      const word = m?.[1] ?? m?.[2] ?? m?.[3];
      if (word !== undefined) {
        o.heredoc = word;
        break;
      }
    }
  }
  return o;
}

/** The heredoc a kept line opens, if any: the one construct a kept line may carry forward, since a comment's stray quote must never hide what follows. */
function heredocOpened(line: string): string | undefined {
  return scanLine(line, CLOSED).heredoc;
}

export function stripExports(text: string): { names: string[]; carried: string } {
  const names: string[] = [];
  const kept: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let cutting: Open | undefined;
  let heredoc: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (cutting !== undefined) {
      const o = scanLine(line, cutting);
      cutting = isOpen(o) ? o : undefined;
      continue;
    }
    if (heredoc !== undefined) {
      kept.push(line);
      if (line.trim() === heredoc) heredoc = undefined;
      continue;
    }
    const hits = assignedNames(line).filter(isSecretName);
    if (hits.length === 0) {
      kept.push(line);
      heredoc = heredocOpened(line);
      continue;
    }
    for (const h of hits) if (!names.includes(h)) names.push(h);
    const o = scanLine(line, CLOSED);
    if (isOpen(o)) cutting = o;
  }
  return { names, carried: kept.join(eol) };
}

export async function shellRc(m: Machine): Promise<RcScan[]> {
  const out: RcScan[] = [];
  for (const name of RC_FILES) {
    const path = `${m.home}/${name}`;
    const text = await m.fs.readText(path);
    if (text === undefined) continue;
    const s = stripExports(text);
    if (s.names.length > 0) out.push({ path: tilde(m.home, path), ...s });
  }
  return out;
}
