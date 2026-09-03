// SPDX-License-Identifier: AGPL-3.0-only
// Pass 6. Exported variables whose name says KEY, TOKEN, SECRET or PASSWORD
// are listed by name and cut from a carried copy of the rc file. Values
// never leave this pass.
import { type Machine, tilde } from "./host.js";

/** The rc files the shell rung already carries. */
export const RC_FILES = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".bashrc", ".bash_profile", ".profile"] as const;

export interface RcScan {
  /** `~`-relative. */
  path: string;
  /** Variable names to set on the machine by hand. */
  names: string[];
  /** The file with those assignment lines removed. */
  carried: string;
}

const SECRET_WORDS = new Set(["KEY", "TOKEN", "SECRET", "PASSWORD"]);

/** `KEYTIMEOUT` is not a key; the word has to stand alone between underscores. */
export function isSecretName(name: string): boolean {
  return name.toUpperCase().split("_").some(w => SECRET_WORDS.has(w));
}

function assignedNames(line: string): string[] {
  const exported = /^\s*export\s+(.*)$/.exec(line);
  if (exported?.[1] !== undefined) {
    return exported[1].split(/\s+/).map(t => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(t)?.[1]).filter((n): n is string => n !== undefined);
  }
  const plain = /^\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
  return plain?.[1] === undefined ? [] : [plain[1]];
}

export function stripExports(text: string): { names: string[]; carried: string } {
  const names: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const hits = assignedNames(line).filter(isSecretName);
    if (hits.length === 0) {
      kept.push(line);
      continue;
    }
    for (const h of hits) if (!names.includes(h)) names.push(h);
  }
  return { names, carried: kept.join("\n") };
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
