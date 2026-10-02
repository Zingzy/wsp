// SPDX-License-Identifier: AGPL-3.0-only
// The agents' lists as harnesses.list hands them to a client with no workspace
// named: the host's own table rows for Claude Code, Codex and OpenCode, each
// marked where a new thread starts (the model, its effort, the access that
// asks nobody) and the default agent marked. Shared by the settings tests and
// the wireframe.
import type { HarnessCatalog, HarnessOption } from "@wsp/protocol";

const option = (value: string, label: string): HarnessOption => ({ value, label });
const levels = (values: readonly string[], marked: string): HarnessOption[] => values.map(v => ({ ...option(v, v === "xhigh" ? "Extra high" : v.charAt(0).toUpperCase() + v.slice(1)), ...(v === marked ? { isDefault: true } : {}) }));
const table = { source: "table" as const, contextWindows: [], steers: false, renames: false, images: false };

export const CLAUDE_CATALOG: HarnessCatalog = {
  ...table,
  harness: "claude",
  label: "Claude Code",
  version: "--help 2.1.286, 2026-09-23",
  isDefault: true,
  models: [
    { ...option("claude-opus-5-5", "Opus 5.5"), isDefault: true, fast: true, efforts: ["low", "medium", "high", "xhigh", "max"], contextWindows: ["200k", "1m"] },
    { ...option("claude-fable-5-1", "Fable 5.1"), efforts: ["low", "medium", "high", "xhigh", "max"], contextWindows: ["200k", "1m"] },
    { ...option("claude-sonnet-5", "Sonnet 5"), efforts: ["low", "medium", "high", "xhigh", "max"], contextWindows: [] },
    { ...option("claude-haiku-4-5-20251001", "Haiku 4.5"), efforts: [], contextWindows: [] },
  ],
  legacyModels: [
    { ...option("claude-opus-5", "Opus 5"), fast: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindows: ["200k", "1m"] },
    { ...option("claude-sonnet-4-6", "Sonnet 4.6"), efforts: ["low", "medium", "high", "max"], contextWindows: ["200k", "1m"] },
  ],
  hiddenModels: [
    { ...option("claude-opus-4-8", "Opus 4.8"), fast: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", contextWindows: ["200k", "1m"] },
    { ...option("claude-sonnet-4-5", "Sonnet 4.5"), efforts: [], contextWindows: ["200k", "1m"] },
  ],
  efforts: levels(["low", "medium", "high", "xhigh", "max"], "high"),
  access: { ask: "default", "auto-edit": "acceptEdits", full: "bypassPermissions" },
  bypassMode: "bypassPermissions",
  readOnlyMode: "dontAsk",
  permissionModes: [
    option("default", "Default"),
    option("acceptEdits", "Accept edits"),
    { ...option("bypassPermissions", "Bypass"), isDefault: true },
    option("auto", "Auto"),
    option("manual", "Manual"),
    option("dontAsk", "Don't ask"),
  ],
};

export const CODEX_CATALOG: HarnessCatalog = {
  ...table,
  harness: "codex",
  label: "Codex",
  version: "app-server 0.153.0, 2026-09-07",
  models: [
    { ...option("gpt-5.6-sol", "GPT-5.6-Sol"), isDefault: true, fast: true, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
    { ...option("gpt-5.6-terra", "GPT-5.6-Terra"), fast: true, efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
    { ...option("gpt-5.6-luna", "GPT-5.6-Luna"), fast: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  ],
  legacyListed: true,
  legacyModels: [{ ...option("gpt-5.5", "GPT-5.5"), fast: true, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }],
  efforts: levels(["low", "medium", "high", "xhigh", "max", "ultra"], "low"),
  access: { ask: "workspace-write", full: "danger-full-access", plan: "read-only" },
  bypassMode: "danger-full-access",
  readOnlyMode: "read-only",
  permissionModes: [option("read-only", "Read only"), option("workspace-write", "Workspace write"), { ...option("danger-full-access", "Full access"), isDefault: true }],
};

export const OPENCODE_CATALOG: HarnessCatalog = {
  ...table,
  harness: "opencode",
  label: "OpenCode",
  version: "run --help 1.18.18, 2026-09-27",
  models: [],
  efforts: [],
  access: { full: "auto" },
  bypassMode: "auto",
  permissionModes: [{ ...option("auto", "Auto"), isDefault: true }],
};

export const HARNESSES: HarnessCatalog[] = [CLAUDE_CATALOG, CODEX_CATALOG, OPENCODE_CATALOG];
