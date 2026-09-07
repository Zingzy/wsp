// SPDX-License-Identifier: AGPL-3.0-only
// What each harness's CLI accepts at launch, as its own binary spells it, so
// the composer's pickers offer only values the CLI will take. This table is
// the fallback: an adapter that probes reads its lists from the binary on the
// workspace's machine when it answers (catalogFromProbe), and the table lends
// it the labels and descriptions the binary has no words for. Each row carries
// the pin it was read against, its own command, version and day, since a row
// that borrowed another agent's pin would tell the person the wrong thing
// about the list in front of them. Gemini CLI, OpenCode, Pi and Hermes have no
// adapter yet; their catalogs name the flags their CLIs document, so they
// carry no pin of our own reading and the pickers are right the day one lands.
// A list is empty where the CLI has no such flag or takes open values.
import type { HarnessCatalog, HarnessCatalogProbe, HarnessModel, HarnessOption } from "@wsp/protocol";

/** What one row's table was read against: what was run on the row's own binary, the version it reported and the day it
 * was read. A row served from the table carries this as its version, and the footer names the agent beside it, so the
 * binary's own name is not repeated here. */
interface TablePin {
  /** What followed the binary, as it was typed: the flag or subcommand whose answer the lists below came from. */
  read: string;
  version: string;
  date: string;
}

const option = (value: string, label: string, description?: string): HarnessOption => ({
  value,
  label,
  ...(description !== undefined ? { description } : {}),
});

const capitalize = (value: string): string => (value === "xhigh" ? "Extra high" : value.charAt(0).toUpperCase() + value.slice(1));

/** Effort levels in the CLI's own order, with the one a turn that names none runs marked, where the CLI has one. */
const levels = (values: readonly string[], isDefault?: string): HarnessOption[] =>
  values.map(value => (value === isDefault ? { ...option(value, capitalize(value)), isDefault: true } : option(value, capitalize(value))));

const CLAUDE_CONTEXT_WINDOWS: HarnessOption[] = [option("200k", "200k"), { ...option("1m", "1M"), isDefault: true }];

// The handshake lists each model's levels and names no default; the CLI documents high on every model that takes one (code.claude.com/docs/en/model-config, Adjust effort level).
const CLAUDE_EFFORTS: HarnessOption[] = levels(["low", "medium", "high", "xhigh", "max"], "high");

// The table alone cannot say whether a harness steers, or whether it keeps a person's name for a session: only its
// adapter, on a machine, knows either. A client reads a table row as no answer (keepsRename), never as a no.
const fromTable = (
  catalog: Omit<HarnessCatalog, "source" | "version" | "contextWindows" | "steers" | "renames"> & { contextWindows?: HarnessOption[]; pin?: TablePin },
): HarnessCatalog => {
  const { pin, ...rest } = catalog;
  return {
    source: "table",
    version: pin === undefined ? null : `${pin.read} ${pin.version}, ${pin.date}`,
    contextWindows: [],
    steers: false,
    renames: false,
    ...rest,
  };
};

export const HARNESS_CATALOGS: readonly HarnessCatalog[] = [
  fromTable({
    harness: "claude",
    label: "Claude Code",
    pin: { read: "--help", version: "2.1.257", date: "2026-09-05" },
    // The cheapest of the three at $2/$10 per Mtok, as the CLI's own handshake prices them (read 2026-09-07).
    smallModel: "claude-sonnet-5",
    models: [
      { ...option("claude-fable-5-1", "Fable 5.1"), contextWindows: ["200k", "1m"] },
      { ...option("claude-opus-5", "Opus 5"), isDefault: true, contextWindows: ["200k", "1m"] },
      { ...option("claude-sonnet-5", "Sonnet 5"), contextWindows: [] },
    ],
    efforts: CLAUDE_EFFORTS,
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
    // The models and their efforts as the app-server's model/list answered them, and low as the effort it reports
    // for the default model; the sandbox modes are the choices `codex --help` prints for -s. No codex model runs at
    // two context windows, so it takes no window at all.
    pin: { read: "app-server", version: "0.153.0", date: "2026-09-07" },
    // The oldest generation model/list still offers, and the cheapest of them.
    smallModel: "gpt-5.2",
    models: [
      { ...option("gpt-5.6-sol", "GPT-5.6-Sol"), isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { ...option("gpt-5.6-terra", "GPT-5.6-Terra"), efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
      { ...option("gpt-5.6-luna", "GPT-5.6-Luna"), efforts: ["low", "medium", "high", "xhigh", "max"] },
      { ...option("gpt-5.5", "GPT-5.5"), efforts: ["low", "medium", "high", "xhigh"] },
      { ...option("gpt-5.2", "GPT-5.2"), efforts: ["low", "medium", "high", "xhigh"] },
    ],
    efforts: levels(["low", "medium", "high", "xhigh", "max", "ultra"], "low"),
    permissionModes: [
      option("read-only", "Read only", "No edits, no commands that write"),
      option("workspace-write", "Workspace write", "Edits and commands inside the working folder"),
      { ...option("danger-full-access", "Full access", "No sandbox, as every turn on a throwaway machine runs"), isDefault: true },
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

/** The model a thread's title question runs on: the harness row's own smallest, where the catalog in front of us
 * still lists it. Nothing where the harness names none and where the binary no longer offers the one it named, and
 * the question then runs on whatever that CLI runs without a model. */
export function smallestModel(catalog: HarnessCatalog | undefined): string | undefined {
  if (catalog?.smallModel === undefined) return undefined;
  return catalog.models.some(m => m.value === catalog.smallModel) ? catalog.smallModel : undefined;
}

/** The binary's lists in the wire shape: its values and defaults win, the table lends labels and descriptions it knows.
 * A model whose efforts the binary did not name keeps none of its own, so every effort the catalog lists stays open to
 * it; the effort marked default is the one the binary reports for the model it would run, else the table's own mark. */
export function catalogFromProbe(table: HarnessCatalog, probe: HarnessCatalogProbe): HarnessCatalog {
  const known = (list: readonly HarnessOption[], value: string): HarnessOption | undefined => list.find(o => o.value === value);
  const models: HarnessModel[] = probe.models.map(m => ({
    value: m.slug,
    label: known(table.models, m.slug)?.label ?? m.label,
    ...(m.description !== undefined ? { description: m.description } : {}),
    ...(m.isDefault ? { isDefault: true } : {}),
    ...(m.efforts !== undefined ? { efforts: [...m.efforts] } : {}),
    contextWindows: [...m.contextWindows],
  }));
  // The binary named the effort its default model runs at, so its mark replaces the table's; where it named none the
  // table's own mark stands, and the picker shows a default either way.
  const defaultEffort = probe.models.find(m => m.isDefault)?.defaultEffort;
  const effort = (value: string): HarnessOption => {
    const base = known(table.efforts, value) ?? option(value, capitalize(value));
    if (defaultEffort === undefined) return base;
    const { isDefault: _fromTable, ...rest } = base;
    return value === defaultEffort ? { ...rest, isDefault: true } : rest;
  };
  return {
    ...table,
    source: "harness",
    version: probe.version,
    models,
    efforts: probe.efforts.map(effort),
    permissionModes: probe.permissionModes.map(value => known(table.permissionModes, value) ?? option(value, value)),
  };
}
