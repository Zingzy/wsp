// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash-command catalog. t3code fills it from provider probes;
// wsp reads it off session.start's harness field (the CLI's own system/init)
// once a session has run, and the harness's registered seed fills the menu
// before that. The model, effort and permission pickers read the runtime's
// harness catalog instead, since those must be right before any session ran.
import type { SessionHarness } from "@wsp/protocol";
import { harnessClient } from "./harnesses.js";
import type { HarnessCatalog, ProviderSlashCommand } from "./view-model.js";

/** The seed catalog of a harness with a registered module, else nothing. */
export function catalogFor(harness: string): HarnessCatalog | null {
  const client = harnessClient(harness);
  return client === undefined ? null : { harness, slashCommands: client.slashCommands };
}

/** The slash commands a session announced, else the harness's seed when the CLI said nothing about them. */
export function catalogFromHarness(input: { readonly id: string; readonly harness: SessionHarness | null }): HarnessCatalog {
  const slashCommands: ReadonlyArray<ProviderSlashCommand> =
    input.harness?.slashCommands !== undefined && input.harness.slashCommands.length > 0
      ? input.harness.slashCommands.map(name => ({ name }))
      : harnessClient(input.id)?.slashCommands ?? [];
  return { harness: input.id, slashCommands };
}
