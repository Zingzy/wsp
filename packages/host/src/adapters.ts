// SPDX-License-Identifier: AGPL-3.0-only
// One adapter factory per agent wsp can drive, keyed by catalog id. Adding an
// agent is its id in THREAD_AGENTS and its factory here; the type ties the two
// together. Each adapter gets its agent's words from the catalog: its home on
// the guest, the folder the golden's sign-in wrote into, and the command that
// signs in on a machine; the adapter packages carry no catalog rows of their own.
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { guestAgentHomes } from "@wsp/engine";
import { machineExecStream, type HarnessAdapterFactory } from "@wsp/runtime";
import type { ThreadAgent } from "./thread-agents.js";

const guestHome = (id: ThreadAgent): string => {
  const home = guestAgentHomes()[id];
  if (home === undefined) throw new Error(`the catalog has no home for ${id}`);
  return home;
};

/** The sign-in command a person runs on a machine: the row's headless fallback when it has one, else its login. */
const machineLogin = (id: ThreadAgent): string => {
  const signIn = CATALOG_AGENTS.find(a => a.id === id)?.signIn;
  if (signIn === undefined || !("login" in signIn)) throw new Error(`the catalog has no sign-in for ${id}`);
  return signIn.fallback ?? signIn.login;
};

export const HARNESS_ADAPTERS: Readonly<Record<ThreadAgent, HarnessAdapterFactory>> = {
  claude: ctx => createClaudeAdapter({ exec: machineExecStream(ctx.machine), configDir: guestHome("claude"), baseEnv: ctx.env }),
  codex: ctx => createCodexAdapter({ exec: machineExecStream(ctx.machine), home: guestHome("codex"), login: machineLogin("codex"), baseEnv: ctx.env }),
};
