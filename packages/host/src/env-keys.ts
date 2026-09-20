// SPDX-License-Identifier: AGPL-3.0-only
// The variables a host's own .env holds a key under, the record read out of
// that one file, and the agents' keys the terminal's commands take out of such
// a record. A provider's key is its row's own and is read through the pick's
// environment, never named here. The app's setup reads that one file alone: a
// key in the process environment or a .env beside a checkout is the terminal's
// business and never reads as saved on a screen.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeOwn } from "@wsp/own-file";
import { VAULT_VARIABLES } from "@wsp/catalog";

export const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";

/** Where a key is read from, as a line says it: one wording for the screen that asks for one, for the refusal that
 * says there was nobody to ask, and for the doctor's line on a key that is not here. It lives beside the reader of
 * those files so every sentence about them reads off one spelling. */
export const KEY_LAYER_WORDS = "the environment, ./.env, or the .env beside your state file (~/.wsp/.env unless you named a state)";

export interface Keys {
  /** The agents' key. The provider's is not here: which variable holds it is the provider row's own declaration,
   * and it travels in the environment the provider is picked out of. */
  anthropic?: string;
}

export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** The one file a host reads its own keys and its provider pick out of, and writes them to: the .env beside the
 * state file it serves, as everything else a host writes for itself sits there. A host on another state file
 * reads no key of the wsp home's, and on the home's own state file this is the home's own .env. */
export const envFileFor = (statePath: string): string => join(dirname(statePath), ".env");

/** That file as it stands. */
export function savedEnv(statePath: string): Record<string, string> {
  return parseEnvFile(envFileFor(statePath));
}

/** The key a record holds under a variable, or nothing: an empty value is no key. The one place that rule is
 * written, so every road that reads a key out of an environment, a layer or a saved file reads it the same. */
export function keyIn(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value !== "" ? value : undefined;
}

/** The agents' keys out of one record. */
export function keysOf(env: Readonly<Record<string, string | undefined>>): Keys {
  const anthropic = keyIn(env, ANTHROPIC_KEY);
  return anthropic !== undefined ? { anthropic } : {};
}

/** What the vault hands a turn: a record cut to the variables the catalog declares, empty values dropped. Nothing
 * of it is written to a machine; the runtime reads it at each launch and sets it in that turn's environment. */
export function vaultOf(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries([...VAULT_VARIABLES].flatMap(name => (keyIn(env, name) !== undefined ? [[name, env[name]!]] : [])));
}

/** The one writer of the wsp home's .env: a key line it knows is rewritten in place and the rest appended, through
 * the owner's writer. One variable is one line here and one line in the reader above, so a value carrying a line
 * break is refused before anything is written rather than becoming a second variable of its own. */
export function writeEnvFile(path: string, set: Record<string, string>): void {
  for (const [name, value] of Object.entries(set)) {
    if (/[\n\r]/.test(value)) throw new Error(`the value for ${name} carries a line break, and one variable is one line`);
  }
  const pending = new Map(Object.entries(set));
  const lines: string[] = [];
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const key = line.match(/^([A-Z_]+)=/)?.[1];
      const value = key === undefined ? undefined : pending.get(key);
      if (key === undefined || value === undefined) {
        lines.push(line);
        continue;
      }
      lines.push(`${key}=${value}`);
      pending.delete(key);
    }
    while (lines.at(-1) === "") lines.pop();
  }
  for (const [k, v] of pending) lines.push(`${k}=${v}`);
  writeOwn(dirname(path), basename(path), `${lines.join("\n")}\n`);
}
