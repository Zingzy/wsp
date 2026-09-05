// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash-command catalog. t3code fills it from provider probes;
// wsp reads it off session.start's harness field (the CLI's own system/init)
// once a session has run, and the static Claude Code entry seeds the menu
// before that. The model, effort and permission pickers read the runtime's
// harness catalog instead, since those must be right before any session ran.
import type { SessionHarness } from "@wsp/protocol";
import type { HarnessCatalog, ProviderSlashCommand } from "./view-model.js";

export const CLAUDE_CODE_CATALOG: HarnessCatalog = {
  harness: "claude",
  slashCommands: [{ name: "model", description: "Show or change the model for this session", input: { hint: "model name" } }],
};

export function catalogFor(harness: string): HarnessCatalog | null {
  return harness === CLAUDE_CODE_CATALOG.harness ? CLAUDE_CODE_CATALOG : null;
}

/** The slash commands a session announced, else the static seed when the CLI said nothing about them. */
export function catalogFromHarness(input: { readonly harness: SessionHarness | null }): HarnessCatalog {
  const slashCommands: ReadonlyArray<ProviderSlashCommand> =
    input.harness?.slashCommands !== undefined && input.harness.slashCommands.length > 0
      ? input.harness.slashCommands.map(name => ({ name }))
      : CLAUDE_CODE_CATALOG.slashCommands;
  return { harness: CLAUDE_CODE_CATALOG.harness, slashCommands };
}
