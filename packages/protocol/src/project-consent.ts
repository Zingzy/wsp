// SPDX-License-Identifier: AGPL-3.0-only
// What an import carries when nobody has changed a tick: which secret-shaped
// files travel, which land rewritten, and whose sessions come along. The app's
// import dialog starts its ticks from these and wsp init's first import takes
// them as they are, so the two roads consent to the same thing.
import type { ProjectAgent, ProjectPlan, ProjectSecret } from "./index.js";

/** A rewrite removes the credentials, so it starts ticked; a file that would travel as it is never does. */
export function defaultConsent(secrets: readonly ProjectSecret[]): ReadonlySet<string> {
  return new Set(secrets.filter(s => s.rewrite !== undefined).map(s => s.path));
}

/** The request the ticks become: offered files rewrite, the rest carry; everything unticked is cut and named by the runtime. */
export function consentRequest(secrets: readonly ProjectSecret[], ticked: ReadonlySet<string>): { carry: string[]; rewrite: string[] } {
  const chosen = secrets.filter(s => ticked.has(s.path));
  return {
    carry: chosen.filter(s => s.rewrite === undefined).map(s => s.path),
    rewrite: chosen.filter(s => s.rewrite !== undefined).map(s => s.path),
  };
}

/** Only an agent with sessions the plan could read has anything to send; the runtime never reads one it cannot. */
export const canTravel = (a: ProjectAgent): boolean => a.error === undefined && a.sessions > 0;

/** An agent whose sessions can travel starts ticked; one with none, or whose store could not be read, does not. */
export function defaultAgents(agents: readonly ProjectAgent[]): ReadonlySet<string> {
  return new Set(agents.filter(canTravel).map(a => a.agent));
}

/** The request the agent ticks become, in the plan's order; nothing when none is ticked, which the runtime reads the same. */
export function agentsRequest(agents: readonly ProjectAgent[], ticked: ReadonlySet<string>): string[] | undefined {
  const chosen = agents.filter(a => ticked.has(a.agent)).map(a => a.agent);
  return chosen.length === 0 ? undefined : chosen;
}

/** The whole consent with every default left alone, for a caller with no ticks to offer. */
export function defaultImportConsent(plan: ProjectPlan): { carry: string[]; rewrite: string[]; agents?: string[] } {
  const secrets = consentRequest(plan.secrets, defaultConsent(plan.secrets));
  const agents = agentsRequest(plan.agents, defaultAgents(plan.agents));
  return { ...secrets, ...(agents === undefined ? {} : { agents }) };
}
