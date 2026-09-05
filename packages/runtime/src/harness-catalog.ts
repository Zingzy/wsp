// SPDX-License-Identifier: AGPL-3.0-only
// What each harness's CLI accepts at launch, as its --help spells it, so the
// composer's pickers offer only values the CLI will take. This table is the
// fallback: Claude Code's lists come from the binary on the workspace's
// machine when it answers (catalogFromProbe), and the table lends it the
// labels and descriptions the binary has no words for. Codex, Gemini CLI,
// OpenCode, Pi and Hermes have no adapter yet; their catalogs name the flags
// their CLIs document so the pickers are right the day one lands. A list is
// empty where the CLI has no such flag or takes open values.
import type { ClaudeCatalogProbe } from "@wsp/adapter-claude";
import type { HarnessCatalog, HarnessModel, HarnessOption } from "@wsp/protocol";

/** What the table was read against; a catalog served from it carries this as its version. */
export const TABLE_PIN = "claude --help 2.1.257, 2026-09-05";

const option = (value: string, label: string, description?: string): HarnessOption => ({
  value,
  label,
  ...(description !== undefined ? { description } : {}),
});

const capitalize = (value: string): string => (value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1));

const levels = (values: readonly string[]): HarnessOption[] => values.map(value => option(value, capitalize(value)));

const CLAUDE_CONTEXT_WINDOWS: HarnessOption[] = [option("200k", "200k"), { ...option("1m", "1M"), isDefault: true }];

const fromTable = (catalog: Omit<HarnessCatalog, "source" | "version" | "contextWindows"> & { contextWindows?: HarnessOption[] }): HarnessCatalog => ({
  source: "table",
  version: TABLE_PIN,
  contextWindows: [],
  ...catalog,
});

export const HARNESS_CATALOGS: readonly HarnessCatalog[] = [
  fromTable({
    harness: "claude",
    label: "Claude Code",
    models: [
      { ...option("claude-fable-5-1", "Fable 5.1"), contextWindows: ["200k", "1m"] },
      { ...option("claude-opus-5", "Opus 5"), isDefault: true, contextWindows: ["200k", "1m"] },
      { ...option("claude-sonnet-5", "Sonnet 5"), contextWindows: [] },
    ],
    efforts: levels(["low", "medium", "high", "xhigh", "max"]),
    contextWindows: CLAUDE_CONTEXT_WINDOWS,
    permissionModes: [
      option("default", "Default", "Tools that need permission are refused; nobody is here to answer a prompt"),
      option("acceptEdits", "Accept edits", "Edits land without asking; commands that need permission are refused"),
      option("plan", "Plan", "Read and plan only; no changes"),
      { ...option("bypassPermissions", "Bypass", "Run every tool without asking"), isDefault: true },
      option("auto", "Auto", "The auto mode classifier decides each permission; runs as Default where it is not enabled"),
      option("manual", "Manual", "Ask before every tool; the CLI reports Default for it in print mode"),
      option("dontAsk", "Don't ask", "Tools that need permission are refused, without a prompt"),
    ],
  }),
  fromTable({
    harness: "codex",
    label: "Codex",
    models: [],
    efforts: levels(["minimal", "low", "medium", "high", "xhigh"]),
    permissionModes: [
      option("read-only", "Read only", "No edits, no commands that write"),
      option("workspace-write", "Workspace write", "Edits and commands inside the working folder"),
      option("danger-full-access", "Full access", "No sandbox"),
    ],
  }),
  fromTable({
    harness: "gemini",
    label: "Gemini CLI",
    models: [],
    efforts: [],
    permissionModes: [
      option("default", "Default", "Ask before every tool"),
      option("auto_edit", "Auto edit", "Edits land without asking"),
      option("yolo", "Yolo", "Run every tool without asking"),
    ],
  }),
  fromTable({
    harness: "opencode",
    label: "OpenCode",
    models: [],
    efforts: [],
    permissionModes: [option("default", "Default", "Ask as configured"), option("auto", "Auto", "Approve everything not explicitly denied")],
  }),
  fromTable({
    harness: "pi",
    label: "Pi",
    models: [],
    efforts: levels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    permissionModes: [],
  }),
  fromTable({
    harness: "hermes",
    label: "Hermes Agent",
    models: [],
    efforts: levels(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    permissionModes: [option("default", "Default", "Ask before dangerous commands"), option("yolo", "Yolo", "Run dangerous commands without asking")],
  }),
];

export function harnessCatalog(harness: string): HarnessCatalog | undefined {
  return HARNESS_CATALOGS.find(c => c.harness === harness);
}

/** The binary's lists in the wire shape: its values and defaults win, the table lends labels and descriptions it knows. */
export function catalogFromProbe(probe: ClaudeCatalogProbe): HarnessCatalog {
  const table = harnessCatalog("claude")!;
  const known = (list: readonly HarnessOption[], value: string): HarnessOption | undefined => list.find(o => o.value === value);
  const models: HarnessModel[] = probe.models.map(m => ({
    value: m.slug,
    label: known(table.models, m.slug)?.label ?? m.label,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.isDefault ? { isDefault: true } : {}),
    efforts: [...m.efforts],
    contextWindows: [...m.contextWindows],
  }));
  return {
    harness: table.harness,
    label: table.label,
    source: "harness",
    version: probe.version,
    models,
    efforts: probe.efforts.map(value => known(table.efforts, value) ?? option(value, capitalize(value))),
    contextWindows: table.contextWindows,
    permissionModes: probe.permissionModes.map(value => known(table.permissionModes, value) ?? option(value, value)),
  };
}
