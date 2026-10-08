// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { shellQuote, threadShellFiles, threadShellVars, type McpServerSpec } from "@wsp/protocol";

/** Where the desktop app puts the wsp command on this computer: a small script under the wsp home that runs the
 * host the app bundles. A script and never a link into the app bundle, since macOS translocation and updates move
 * that path; the app rewrites it on every launch. The MCP configs the app writes run this same path. */
export const shimPath = (home: string): string => join(home, "bin", "wsp");

/** The folder a turn on this computer finds wsp in before anything on the person's PATH, beside the state file the
 * host serves. Not the app's own folder above: the person's MCP configs run that script, and a host started any
 * other way would point them at its own build. */
export const threadBinDir = (statePath: string): string => join(dirname(statePath), "thread-bin");

/** The variables a turn here launches with to find the folder's wsp first, whatever the agent and whatever wsp the
 * person's profile finds, an install from before this one included: the variables ride the environment every agent
 * hands its shells, and the folder's startup files put it back in front after a login shell rebuilds PATH. */
export function threadShellEnv(bin: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const path = env["PATH"];
  return { PATH: path === undefined || path === "" ? bin : `${bin}${delimiter}${path}`, ...threadShellVars(bin) };
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
  for (const [name, text] of threadShellFiles(dir, env)) writeFileSync(join(dir, name), text);
  return dir;
}
