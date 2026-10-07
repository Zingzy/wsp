// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { shellQuote, type McpServerSpec } from "@wsp/protocol";

/** Where the desktop app puts the wsp command on this computer: a small script under the wsp home that runs the
 * host the app bundles. A script and never a link into the app bundle, since macOS translocation and updates move
 * that path; the app rewrites it on every launch. The MCP configs the app writes run this same path. */
export const shimPath = (home: string): string => join(home, "bin", "wsp");

/** The folder a turn on this computer finds wsp in before anything on the person's PATH, beside the state file the
 * host serves. Not the app's own folder above: the person's MCP configs run that script, and a host started any
 * other way would point them at its own build. */
export const threadBinDir = (statePath: string): string => join(dirname(statePath), "thread-bin");

/** The files zsh starts from where ZDOTDIR names that folder, in the order a login shell reads them. */
const ZSH_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const;
/** What bash reads where BASH_ENV names it: after the profile on bash -lc, and alone on bash -c. */
const BASH_ENV_FILE = ".bash_env";

/** The variables a turn here launches with to find the folder's wsp first. A login shell re-reads the person's profile
 * and rebuilds PATH, which puts the folder behind any wsp the profile adds (Codex runs every command as zsh -lc, and
 * reached an older install that way, measured 2026-10-05 on codex 0.160.1). So zsh starts from the folder's own files
 * and bash reads its file after the profile: each runs the person's own and then puts the folder back in front. The
 * variables ride the environment every agent hands its shells, so this holds whatever the agent and whatever wsp the
 * profile finds, an install from before this one included. */
export function threadShellEnv(bin: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const path = env["PATH"];
  return { PATH: path === undefined || path === "" ? bin : `${bin}${delimiter}${path}`, ZDOTDIR: bin, BASH_ENV: join(bin, BASH_ENV_FILE) };
}

/** Writes the folder: the one script, running the command this host was started as, and the shells' startup files.
 * A thread's shell otherwise runs whichever wsp PATH holds, and an older build there read this host's lock as no host
 * and refused (measured 2026-09-29). Rewritten at every start, so it follows the build that is serving. `env` is the
 * environment turns launch under, whose own ZDOTDIR and BASH_ENV the files run in their place. */
export function writeThreadWsp(statePath: string, wsp: McpServerSpec, env: Readonly<Record<string, string | undefined>> = {}): string {
  const dir = threadBinDir(statePath);
  const file = join(dir, "wsp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `#!/bin/sh\nexec ${[wsp.command, ...wsp.args].map(shellQuote).join(" ")} "$@"\n`);
  chmodSync(file, 0o755);
  const first = shellQuote(`:${dir}:`);
  const own = env["ZDOTDIR"] === undefined || env["ZDOTDIR"] === "" ? "$HOME" : shellQuote(env["ZDOTDIR"]);
  // The person's file runs with ZDOTDIR at their own folder, as theirs may read it or move it; zsh reads its next file
  // out of ZDOTDIR, so it points back here after each.
  for (const name of ZSH_FILES) {
    writeFileSync(join(dir, name), [`ZDOTDIR=\${_wsp_zdotdir:-${own}}`, `[[ -r "$ZDOTDIR/${name}" ]] && source "$ZDOTDIR/${name}"`, "_wsp_zdotdir=$ZDOTDIR", `ZDOTDIR=${shellQuote(dir)}`, `[[ :$PATH: == ${first}* ]] || PATH=${shellQuote(dir)}:$PATH`, ""].join("\n"));
  }
  const bashEnv = env["BASH_ENV"];
  writeFileSync(join(dir, BASH_ENV_FILE), [...(bashEnv === undefined || bashEnv === "" ? [] : [`[ -r ${shellQuote(bashEnv)} ] && . ${shellQuote(bashEnv)}`]), `case :$PATH: in ${first}*) ;; *) PATH=${shellQuote(dir)}:$PATH ;; esac`, ""].join("\n"));
  return dir;
}
