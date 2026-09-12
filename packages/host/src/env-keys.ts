// SPDX-License-Identifier: AGPL-3.0-only
// The variables the wsp home's .env holds a key under, the record read out of
// that one file, and the agents' keys the terminal's commands take out of such
// a record. A provider's key is its row's own and is read through the pick's
// environment, never named here. The app's setup reads the home's file alone: a
// key in the process environment or a .env beside a checkout is the terminal's
// business and never reads as saved on a screen.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_AGENTS, hasLogin } from "@wsp/catalog";

export const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";

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

/** The wsp home's .env as it stands. */
export function savedEnv(home: string): Record<string, string> {
  return parseEnvFile(join(home, ".env"));
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

/** The variables the catalog's agents read an API key from, each declared once on its agent's sign-in. */
export const AGENT_KEY_VARIABLES: ReadonlySet<string> = new Set(CATALOG_AGENTS.flatMap(a => (hasLogin(a.signIn) && a.signIn.keyEnv !== undefined ? [a.signIn.keyEnv] : [])));

/** The agents' keys a record holds, under the variables the catalog declares: what rides onto the image. */
export function agentKeysIn(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => AGENT_KEY_VARIABLES.has(name) && keyIn(env, name) !== undefined));
}

/** The terminal's keys as the image's variables: the one agent key it asks for, under the variable Claude Code reads. */
export function agentKeyEnvs(keys: Pick<Keys, "anthropic">): Record<string, string> {
  return keys.anthropic !== undefined ? { [ANTHROPIC_KEY]: keys.anthropic } : {};
}
