// SPDX-License-Identifier: AGPL-3.0-only
// The composer's slash-command, model and permission-mode pickers. t3code
// fills these from provider probes; wsp reads them off session.start's
// harness field (the CLI's own system/init) once a session has run, and the
// static Claude Code catalog seeds the pickers before that. Slugs are the
// CLI's own: the runtime passes them through unchanged.
import type { SessionHarness } from "@wsp/protocol";
import type { HarnessCatalog, PermissionMode, ProviderModel, ProviderSlashCommand } from "./view-model.js";

const PERMISSION_MODE_NAMES: Readonly<Record<string, { name: string; description: string }>> = {
  default: { name: "Default", description: "Ask before tools that change things" },
  acceptEdits: { name: "Accept edits", description: "Apply file edits without asking; still ask for commands" },
  plan: { name: "Plan", description: "Read and plan only; no changes" },
  bypassPermissions: { name: "Bypass permissions", description: "Run every tool without asking; what the runtime passes today" },
  dontAsk: { name: "Don't ask", description: "Refuse anything that would need a prompt" },
};

export function permissionMode(slug: string, isDefault = false): PermissionMode {
  const known = PERMISSION_MODE_NAMES[slug];
  return { slug, name: known?.name ?? slug, ...(known !== undefined ? { description: known.description } : {}), ...(isDefault ? { isDefault } : {}) };
}

export const CLAUDE_CODE_CATALOG: HarnessCatalog = {
  harness: "claude",
  slashCommands: [{ name: "model", description: "Show or change the model for this session", input: { hint: "model name" } }],
  models: [{ slug: "claude-opus-5", name: "Claude Opus 5", shortName: "Opus 5", isCustom: false, isDefault: true }],
  permissionModes: [permissionMode("bypassPermissions", true)],
};

export function catalogFor(harness: string): HarnessCatalog | null {
  return harness === CLAUDE_CODE_CATALOG.harness ? CLAUDE_CODE_CATALOG : null;
}

/** The catalog a session announced; each part falls back to the static one when the CLI said nothing about it. */
export function catalogFromHarness(input: { readonly harness: SessionHarness | null; readonly model: string | null }): HarnessCatalog {
  const slashCommands: ReadonlyArray<ProviderSlashCommand> =
    input.harness?.slashCommands !== undefined && input.harness.slashCommands.length > 0
      ? input.harness.slashCommands.map(name => ({ name }))
      : CLAUDE_CODE_CATALOG.slashCommands;
  const models: ReadonlyArray<ProviderModel> =
    input.model !== null ? [{ slug: input.model, name: input.model, isCustom: false, isDefault: true }] : CLAUDE_CODE_CATALOG.models;
  const permissionModes: ReadonlyArray<PermissionMode> =
    input.harness?.permissionMode !== undefined ? [permissionMode(input.harness.permissionMode, true)] : CLAUDE_CODE_CATALOG.permissionModes;
  return { harness: CLAUDE_CODE_CATALOG.harness, slashCommands, models, permissionModes };
}
