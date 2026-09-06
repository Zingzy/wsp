// SPDX-License-Identifier: AGPL-3.0-only
// The rc lines that read another file by a literal path with nothing around
// them, as rustup writes `. "$HOME/.cargo/env"`. On the machine a file under
// home is there only when the pack carried it, and a path outside home is this
// computer's (Homebrew's prefix on the machine is not the Mac's); a bare line
// then prints "no such file" at every shell start. The collector records those
// paths on the rc file's row so the Shell screen can name them, and the pack
// wraps each line whose file it does not carry in a readability test.
import { type Host, expand } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { RC_FILES } from "./shell.js";

interface Bare {
  line: number;
  /** `~`-relative under home, else absolute. */
  path: string;
  indent: string;
  word: string;
  /** The path as written, quotes included. */
  token: string;
  comment: string;
}

/** One `source` or `.` word (nvm writes `\.` to dodge aliases), one path token, an optional comment, nothing else. */
const BARE = /^([ \t]*)(source|\\?\.)[ \t]+("[^"]*"|'[^']*'|[^\s;&|<>()"'\\`]+)[ \t]*(#.*)?$/;

/** The token as a path: `~`-relative when it starts with `~`, `$HOME`, `${HOME}` or the home directory itself,
 * absolute when it starts with `/`, and only when it holds nothing else the shell would expand; a path with a
 * variable, a glob or a dot segment is left to the shell. */
function literalPath(token: string, home: string): string | undefined {
  const raw = /^["']/.test(token) ? token.slice(1, -1) : token;
  const p = raw.replace(/^\$\{HOME\}(?=\/)/, "~").replace(/^\$HOME(?=\/)/, "~");
  const path = p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
  if (!/^(~|)\//.test(path) || /[$`*?[\]\\]/.test(path) || path.split("/").slice(1).some(seg => seg === "" || seg === "." || seg === "..")) return undefined;
  return path;
}

function scan(text: string, home: string): Bare[] {
  const out: Bare[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = BARE.exec(line);
    if (m === null) return;
    const path = literalPath(m[3]!, home);
    if (path !== undefined) out.push({ line: i, path, indent: m[1]!, word: m[2]!, token: m[3]!, comment: m[4] ?? "" });
  });
  return out;
}

/** The files an rc file reads on a bare line, `~`-relative under home and absolute outside it, once each, in the order they first appear. */
export function bareSources(text: string, home: string): string[] {
  return [...new Set(scan(text, home).map(b => b.path))];
}

/** The text with each bare source line whose file is not on the machine wrapped as `[ -r path ] && . path`, keeping
 * its indent, word, token and comment; every other byte as it was. `present` is asked for each path under home,
 * minus its `~/`; a path outside home is this computer's and is always wrapped. */
export function guardSources(text: string, home: string, present: (rel: string) => boolean): string {
  const bare = scan(text, home).filter(b => !(b.path.startsWith("~/") && present(b.path.slice(2))));
  if (bare.length === 0) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  for (const b of bare) lines[b.line] = `${b.indent}[ -r ${b.token} ] && ${b.word} ${b.token}${b.comment === "" ? "" : ` ${b.comment}`}`;
  return lines.join(eol);
}

/** The rc files zsh and bash read, and the alias files those source; inputrc is readline's and fish has its own syntax. */
const SH_RC = new Set(RC_FILES.filter(n => n !== "inputrc").map(n => `shell/${n}`));

/** Puts on each zsh or bash rc row the files it reads on a bare line. */
export async function shellSources(host: Host, rows: readonly ManifestEntry[]): Promise<void> {
  for (const row of rows) {
    const path = row.paths[0];
    if (!SH_RC.has(row.id) || path === undefined) continue;
    const text = await host.fs.readText(expand(host, path));
    if (text === undefined) continue;
    const sources = bareSources(text, host.home);
    if (sources.length > 0) row.sources = sources;
  }
}
