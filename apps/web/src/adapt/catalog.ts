// SPDX-License-Identifier: AGPL-3.0-only
// Static Claude Code catalog for the composer's slash-command, model and
// permission-mode pickers. t3code fills these from provider probes; wsp has no
// probe op yet, so one entry each seeds the pickers until the lists are
// filled. Slugs are the CLI's own: the runtime passes them through unchanged.
import type { HarnessCatalog } from "./view-model.js";

export const CLAUDE_CODE_CATALOG: HarnessCatalog = {
  harness: "claude",
  slashCommands: [{ name: "model", description: "Show or change the model for this session", input: { hint: "model name" } }],
  models: [{ slug: "claude-opus-5", name: "Claude Opus 5", shortName: "Opus 5", isCustom: false, isDefault: true }],
  permissionModes: [
    { slug: "bypassPermissions", name: "Bypass permissions", description: "Run every tool without asking; what the runtime passes today", isDefault: true },
  ],
};

export function catalogFor(harness: string): HarnessCatalog | null {
  return harness === CLAUDE_CODE_CATALOG.harness ? CLAUDE_CODE_CATALOG : null;
}
