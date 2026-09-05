// SPDX-License-Identifier: AGPL-3.0-only
// What each harness's CLI accepts at launch, as its --help spells it, so the
// composer's pickers offer only values the CLI will take. Codex, Gemini CLI,
// OpenCode, Pi and Hermes have no adapter yet; their catalogs name the flags
// their CLIs document so the pickers are right the day one lands. A list is
// empty where the CLI has no such flag or takes open values.
import type { HarnessCatalog, HarnessOption } from "@wsp/protocol";

const option = (value: string, label: string, description?: string): HarnessOption => ({
  value,
  label,
  ...(description !== undefined ? { description } : {}),
});

const levels = (values: readonly string[]): HarnessOption[] =>
  values.map(value => option(value, value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1)));

export const HARNESS_CATALOGS: readonly HarnessCatalog[] = [
  {
    harness: "claude",
    label: "Claude Code",
    models: [option("claude-fable-5-1", "Fable 5.1"), option("claude-opus-5", "Opus 5"), option("claude-sonnet-5", "Sonnet 5")],
    efforts: levels(["low", "medium", "high", "xhigh", "max"]),
    permissionModes: [
      option("default", "Default", "Tools that need permission are refused; nobody is here to answer a prompt"),
      option("acceptEdits", "Accept edits", "Edits land without asking; commands that need permission are refused"),
      option("plan", "Plan", "Read and plan only; no changes"),
      { ...option("bypassPermissions", "Bypass", "Run every tool without asking"), isDefault: true },
    ],
  },
  {
    harness: "codex",
    label: "Codex",
    models: [],
    efforts: levels(["minimal", "low", "medium", "high", "xhigh"]),
    permissionModes: [
      option("read-only", "Read only", "No edits, no commands that write"),
      option("workspace-write", "Workspace write", "Edits and commands inside the working folder"),
      option("danger-full-access", "Full access", "No sandbox"),
    ],
  },
  {
    harness: "gemini",
    label: "Gemini CLI",
    models: [],
    efforts: [],
    permissionModes: [
      option("default", "Default", "Ask before every tool"),
      option("auto_edit", "Auto edit", "Edits land without asking"),
      option("yolo", "Yolo", "Run every tool without asking"),
    ],
  },
  {
    harness: "opencode",
    label: "OpenCode",
    models: [],
    efforts: [],
    permissionModes: [option("default", "Default", "Ask as configured"), option("auto", "Auto", "Approve everything not explicitly denied")],
  },
  {
    harness: "pi",
    label: "Pi",
    models: [],
    efforts: levels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    permissionModes: [],
  },
  {
    harness: "hermes",
    label: "Hermes Agent",
    models: [],
    efforts: levels(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
    permissionModes: [option("default", "Default", "Ask before dangerous commands"), option("yolo", "Yolo", "Run dangerous commands without asking")],
  },
];

export function harnessCatalog(harness: string): HarnessCatalog | undefined {
  return HARNESS_CATALOGS.find(c => c.harness === harness);
}
