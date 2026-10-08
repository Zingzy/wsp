// SPDX-License-Identifier: AGPL-3.0-only
import { shellQuote } from "./shell-quote.js";

/** The files zsh starts from where ZDOTDIR names that folder, in the order a login shell reads them. */
const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;
/** What bash reads where BASH_ENV names it: after the profile on bash -lc, and alone on bash -c. */
const BASH_ENV_FILE = ".bash_env";

/** The variables that make a turn's shells start from the folder's own files, on this computer and on a box alike. */
export const threadShellVars = (dir: string): { ZDOTDIR: string; BASH_ENV: string } => ({ ZDOTDIR: dir, BASH_ENV: `${dir}/${BASH_ENV_FILE}` });

/** The startup files, by name, that put `dir` back first on PATH. A login shell re-reads the person's profile and
 * rebuilds PATH, which puts the folder behind any wsp the profile adds (Codex runs every command as a login shell, and
 * reached an older install that way, measured 2026-10-05 on codex 0.160.1). So zsh starts from the folder's own files
 * and bash reads its file after the profile: each runs the person's own and then puts the folder back in front. `env`
 * is the environment turns launch under, whose own ZDOTDIR and BASH_ENV the files run in their place. */
export function threadShellFiles(dir: string, env: Readonly<Record<string, string | undefined>> = {}): [string, string][] {
  const first = shellQuote(`:${dir}:`);
  const own = env["ZDOTDIR"] === undefined || env["ZDOTDIR"] === "" ? "$HOME" : shellQuote(env["ZDOTDIR"]);
  // The person's file runs with ZDOTDIR at their own folder, as theirs may read it or move it; zsh reads its next file
  // out of ZDOTDIR, so it points back here after each.
  const zsh = ZSH_FILES.map((name): [string, string] => [
    name,
    [`ZDOTDIR=\${_wsp_zdotdir:-${own}}`, `[[ -r "$ZDOTDIR/${name}" ]] && source "$ZDOTDIR/${name}"`, "_wsp_zdotdir=$ZDOTDIR", `ZDOTDIR=${shellQuote(dir)}`, `[[ :$PATH: == ${first}* ]] || PATH=${shellQuote(dir)}:$PATH`, ""].join("\n"),
  ]);
  const bashEnv = env["BASH_ENV"];
  const bash = [...(bashEnv === undefined || bashEnv === "" ? [] : [`[ -r ${shellQuote(bashEnv)} ] && . ${shellQuote(bashEnv)}`]), `case :$PATH: in ${first}*) ;; *) PATH=${shellQuote(dir)}:$PATH ;; esac`, ""].join("\n");
  return [...zsh, [BASH_ENV_FILE, bash]];
}
