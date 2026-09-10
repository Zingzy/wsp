// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash-command catalog. t3code fills it from provider probes;
// wsp reads it off session.start's harness field (the CLI's own system/init)
// once a session has run, and the harness's registered seed fills the menu
// before that. The CLI's init lists its screen-only commands beside the ones
// a headless turn runs, so the runtime catalog's table of those is taken out
// of either list here. The model, effort and permission pickers read the
// runtime's harness catalog instead, since those must be right before any
// session ran.
import type { ScreenCommand, SessionHarness } from "@wsp/protocol";
import { harnessClient } from "./harnesses.js";
import type { HarnessCatalog, ProviderSlashCommand } from "./view-model.js";

/** The seed catalog of a harness with a registered module, else nothing. */
export function catalogFor(harness: string): HarnessCatalog | null {
  const client = harnessClient(harness);
  return client === undefined ? null : { harness, slashCommands: client.slashCommands };
}

/** The slash commands a session announced, else the harness's seed when the CLI said nothing about them, less the
 * ones its runtime catalog says work only in the CLI's own terminal. */
export function catalogFromHarness(input: { readonly id: string; readonly harness: SessionHarness | null; readonly screen?: ReadonlyArray<ScreenCommand> }): HarnessCatalog {
  const offered: ReadonlyArray<ProviderSlashCommand> =
    input.harness?.slashCommands !== undefined && input.harness.slashCommands.length > 0
      ? input.harness.slashCommands.map(name => ({ name }))
      : harnessClient(input.id)?.slashCommands ?? [];
  const screen = input.screen ?? [];
  const slashCommands = screen.length === 0 ? offered : offered.filter(c => !screen.some(s => s.name === c.name));
  return { harness: input.id, slashCommands };
}
