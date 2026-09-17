// SPDX-License-Identifier: AGPL-3.0-only
// One adapter factory per agent wsp can drive, keyed by catalog id, for every
// client that embeds the runtime: the app and the dev CLI read this table
// rather than wiring adapters of their own. Adding an agent is its id in
// THREAD_AGENTS and its factory here; the type ties the two together. Each
// adapter gets its agent's words from the catalog: its home on the guest, the
// folder the golden's sign-in wrote into, and the command that signs in on a
// machine; the adapter packages carry no catalog rows of their own.
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { CATALOG_AGENTS, keyEnvOf, mintsToken, type ThreadAgent } from "@wsp/catalog";
import type { HarnessAdapterFactory } from "./runtime.js";

/** The sign-in command a person runs on a machine: the row's headless fallback when it has one, else its login. */
const machineLogin = (id: ThreadAgent): string => {
  const signIn = CATALOG_AGENTS.find(a => a.id === id)?.signIn;
  if (signIn === undefined || !("login" in signIn)) throw new Error(`the catalog has no sign-in for ${id}`);
  return signIn.fallback ?? signIn.login;
};

/** What the vault holds for one agent, under the variables that agent's own row declares: its token, else its key,
 * never both. Inside Claude Code an API key outranks the token, so handing both would bill the key on every turn
 * and the token the person minted would never be used. One reader for every agent, so a new one is a row and not
 * a branch here. */
export function secretsOf(vault: Readonly<Record<string, string>>, id: ThreadAgent): { oauthToken?: string; apiKey?: string } {
  const signIn = CATALOG_AGENTS.find(a => a.id === id)?.signIn;
  if (signIn === undefined) return {};
  const token = mintsToken(signIn) ? vault[signIn.tokenEnv] : undefined;
  if (token !== undefined) return { oauthToken: token };
  const keyEnv = keyEnvOf(signIn);
  const key = keyEnv === undefined ? undefined : vault[keyEnv];
  return key === undefined ? {} : { apiKey: key };
}

export const HARNESS_ADAPTERS: Readonly<Record<ThreadAgent, HarnessAdapterFactory>> = {
  claude: ctx => createClaudeAdapter({ exec: ctx.execStream, configDir: ctx.home("claude"), baseEnv: ctx.env, signInRefusal: ctx.signInRefusal, ...secretsOf(ctx.vault, "claude") }),
  codex: ctx => createCodexAdapter({ exec: ctx.execStream, home: ctx.home("codex"), login: machineLogin("codex"), baseEnv: ctx.env, ...secretsOf(ctx.vault, "codex") }),
};
