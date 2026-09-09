// SPDX-License-Identifier: AGPL-3.0-only
// The variables the wsp home's .env holds a key under, the record read out of
// that one file, and the two keys the terminal's commands take out of such a
// record. The app's setup reads the home's file alone: a key in the process
// environment or a .env beside a checkout is the terminal's business and never
// reads as saved on a screen.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_AGENTS, hasLogin } from "@wsp/catalog";

export const SOLARI_KEY = "SOLARI_API_KEY";
export const ANTHROPIC_KEY = "ANTHROPIC_API_KEY";

export interface Keys {
  /** The machine provider's key. Absent on a computer set up with no provider: wsp init took the local road, so
   * this computer is the workspace and the provider module wired in its place refuses every machine road. */
  solari?: string;
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

/** The two keys out of one record; an empty value is no key. */
export function keysOf(env: Readonly<Record<string, string | undefined>>): Keys {
  const solari = env[SOLARI_KEY];
  const anthropic = env[ANTHROPIC_KEY];
  return { ...(solari !== undefined && solari !== "" ? { solari } : {}), ...(anthropic !== undefined && anthropic !== "" ? { anthropic } : {}) };
}

/** The variables the catalog's agents read an API key from, each declared once on its agent's sign-in. */
export const AGENT_KEY_VARIABLES: ReadonlySet<string> = new Set(CATALOG_AGENTS.flatMap(a => (hasLogin(a.signIn) && a.signIn.keyEnv !== undefined ? [a.signIn.keyEnv] : [])));

/** The agents' keys a record holds, under the variables the catalog declares: what rides onto the image. */
export function agentKeysIn(env: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => AGENT_KEY_VARIABLES.has(name) && value !== ""));
}

/** The terminal's keys as the image's variables: the one agent key it asks for, under the variable Claude Code reads. */
export function agentKeyEnvs(keys: Pick<Keys, "anthropic">): Record<string, string> {
  return keys.anthropic !== undefined ? { [ANTHROPIC_KEY]: keys.anthropic } : {};
}
