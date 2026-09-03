// SPDX-License-Identifier: AGPL-3.0-only
// Pass 6. Exported variables whose name says KEY, TOKEN, SECRET or PASSWORD
// are listed by name and cut from a carried copy of the rc file. Values
// never leave this pass, so a cut line takes its continuation and any open
// quote with it.
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
const EXPORTED = new RegExp(`^\\s*(?:export|typeset|declare)(?:\\s+-\\w+)*\\s+(.*)$`);
const FISH_SET = new RegExp(`^\\s*set(?:\\s+-\\w+)+\\s+(${NAME})(?:\\s|$)`);
const ASSIGNED = new RegExp(`^(${NAME})=`);

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

type Quote = "" | "'" | '"';

/** Where the shell's quoting stands at the end of the line, and whether the line continues onto the next. */
function scanQuotes(line: string, start: Quote): { quote: Quote; continues: boolean } {
  let quote = start;
  let continues = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    continues = false;
    if (c === "\\" && quote !== "'") {
      if (i === line.length - 1) continues = true;
      i += 1;
      continue;
    }
    if (quote === "") {
      if (c === "'" || c === '"') quote = c;
    } else if (c === quote) quote = "";
  }
  return { quote, continues };
}

export function stripExports(text: string): { names: string[]; carried: string } {
  const names: string[] = [];
  const kept: string[] = [];
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let cutting: { quote: Quote } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (cutting !== undefined) {
      const s = scanQuotes(line, cutting.quote);
      cutting = s.quote === "" && !s.continues ? undefined : { quote: s.quote };
      continue;
    }
    const hits = assignedNames(line).filter(isSecretName);
    if (hits.length === 0) {
      kept.push(line);
      continue;
    }
    for (const h of hits) if (!names.includes(h)) names.push(h);
    const s = scanQuotes(line, "");
    if (s.quote !== "" || s.continues) cutting = { quote: s.quote };
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
