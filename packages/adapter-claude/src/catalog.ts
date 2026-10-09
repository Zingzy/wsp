// SPDX-License-Identifier: AGPL-3.0-only
// What the installed Claude Code binary reports about itself, read without a
// prompt: `claude --version`, the flag choices in `claude --help`, and the
// initialize handshake of a stream-json session that is never sent a message.
// The handshake carries the model list with each model's effort levels; the
// CLI spells a 1M context as a "[1m]" suffix on the model. Measured on
// 2.1.257: one line, exit 0 on stdin EOF, no API call.

import { ENV_FROM_INPUT, programWord } from "@wsp/protocol";
import type { AgentLaunch, HarnessCatalogModelProbe, HarnessCatalogProbe, ScreenCommand } from "@wsp/protocol";

const SEP = "__WSP_CATALOG_SEP__";
const INIT_REQUEST = JSON.stringify({ type: "control_request", request_id: "init", request: { subtype: "initialize", hooks: {} } });
const ONE_M = /\[1m\]$/;

/** The CLI's commands that open a screen of its own and so work only in its interactive terminal: a headless turn
 * handed one answers "isn't available in this environment" (seen from wsp 0.2.0 on 2026-09-10). Its init still lists
 * them in slash_commands beside the custom commands and skills that do run, so the composer reads this table to keep
 * them out of its menu; adding one is a row here. */
export const CLAUDE_SCREEN_COMMANDS: ReadonlyArray<ScreenCommand> = [
  { name: "login", control: "sign-in" },
  { name: "logout", control: "sign-in" },
  { name: "model", control: "model" },
  { name: "permissions", control: "access" },
  { name: "config", control: "settings" },
  { name: "help", control: "docs" },
];

export const CONTEXT_WINDOWS = ["200k", "1m"] as const;
export type ContextWindow = (typeof CONTEXT_WINDOWS)[number];

/** A model as the handshake names it: the slug is its full name with any context suffix removed, and both windows are
 * listed only where the CLI offers a "[1m]" variant of it. */
type ClaudeModel = HarnessCatalogModelProbe & { efforts: string[]; contextWindows: ContextWindow[] };

/**
 * One shell line for the guest. --bare skips hooks, plugins and CLAUDE.md, so the
 * handshake answers in about a second and the user's SessionStart hooks do not run
 * on a probe. `cd ~` for the same reason as a session: guest exec carries no HOME.
 * The handshake still writes .claude.json into the config dir it sees, so the probe
 * runs under the same environment as a session, the login's config dir included, read
 * off its input once every inherited CLAUDE_CODE_* mark is dropped the way the session
 * env drops them (the exec shell is bash): `buildEnv` is that input.
 */
export function catalogProbeCommand(options: { launch?: AgentLaunch } = {}): string {
  const claude = programWord("claude", options.launch);
  const handshake = `printf '%s\\n' "${INIT_REQUEST.replaceAll('"', '\\"')}" | ${claude} -p --bare --output-format stream-json --input-format stream-json --verbose`;
  return `${versionProbeCommand(options)}; echo ${SEP}; ${claude} --help; echo ${SEP}; ${handshake}`;
}

/** The probe's first command alone, under the same environment: what says whether lists read off the binary before
 * are still its lists. */
export function versionProbeCommand(options: { launch?: AgentLaunch } = {}): string {
  const claude = programWord("claude", options.launch);
  return `cd ~ && unset \${!CLAUDE_CODE_@} CLAUDECODE FORCE_CODE_TERMINAL; ${ENV_FROM_INPUT}; ${claude} --version`;
}

/** The version `claude --version` prints, the one the probe records; null where it printed none. */
export const parseVersion = (stdout: string): string | null => /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;

function quotedList(help: string, flag: string): string[] {
  const at = help.indexOf(flag);
  if (at === -1) return [];
  const choices = /\(choices:\s*([^)]*)\)/.exec(help.slice(at, at + 600));
  if (choices === null) return [];
  return [...choices[1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
}

function effortChoices(help: string): string[] {
  const at = help.indexOf("--effort <level>");
  if (at === -1) return [];
  const parens = /\(([^)]*)\)/.exec(help.slice(at, at + 300));
  if (parens === null) return [];
  return parens[1]!.split(",").map(s => s.trim()).filter(s => /^[a-z]+$/.test(s));
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function initResponse(section: string): Record<string, unknown> | undefined {
  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const outer = value as Record<string, unknown>;
    if (outer.type !== "control_response") continue;
    const response = outer.response;
    if (typeof response !== "object" || response === null) continue;
    const inner = (response as Record<string, unknown>).response;
    if (typeof inner === "object" && inner !== null) return inner as Record<string, unknown>;
  }
  return undefined;
}

function modelsOf(init: Record<string, unknown>): ClaudeModel[] | undefined {
  if (!Array.isArray(init.models)) return undefined;
  const bySlug = new Map<string, ClaudeModel>();
  let defaultSlug: string | undefined;
  for (const raw of init.models) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const value = str(entry.value);
    if (value === undefined) continue;
    const resolved = str(entry.resolvedModel) ?? value;
    const slug = resolved.replace(ONE_M, "");
    const oneM = ONE_M.test(value) || ONE_M.test(resolved);
    if (value === "default") {
      defaultSlug = slug;
      continue;
    }
    const efforts = Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels.filter((e): e is string => typeof e === "string") : [];
    const known = bySlug.get(slug);
    if (known !== undefined) {
      for (const effort of efforts) if (!known.efforts.includes(effort)) known.efforts.push(effort);
      if (oneM && known.contextWindows.length === 0) known.contextWindows = [...CONTEXT_WINDOWS];
      continue;
    }
    const label = (str(entry.displayName) ?? slug).replace(/\s*\(1M context\)$/i, "");
    const description = str(entry.description);
    bySlug.set(slug, {
      slug,
      label,
      ...(description !== undefined ? { description } : {}),
      efforts,
      contextWindows: oneM ? [...CONTEXT_WINDOWS] : [],
      isDefault: false,
    });
  }
  if (bySlug.size === 0) return undefined;
  const models = [...bySlug.values()];
  for (const model of models) model.isDefault = model.slug === defaultSlug;
  return models;
}

/** Null when the handshake is missing or names no model: the caller falls back to its table. */
export function parseCatalogProbe(stdout: string): HarnessCatalogProbe | null {
  const parts = stdout.split(SEP);
  if (parts.length < 3) return null;
  const [versionPart, help, initPart] = parts as [string, string, string];
  const init = initResponse(initPart);
  if (init === undefined) return null;
  const models = modelsOf(init);
  if (models === undefined) return null;
  const version = parseVersion(versionPart);
  const listed = quotedList(help, "--permission-mode <mode>");
  return {
    version,
    models,
    efforts: effortChoices(help),
    // wsp offers no plan mode, though the binary lists one.
    permissionModes: ["default", ...listed.filter(mode => mode !== "default" && mode !== "plan")],
  };
}
