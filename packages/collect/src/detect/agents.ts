// SPDX-License-Identifier: AGPL-3.0-only
import { CATALOG_AGENTS, hookFiles, type HookCarry } from "@wsp/catalog";
import { expand, tilde, type Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { entry } from "./common.js";
import { presenceOf } from "./presence.js";

interface Agent {
  id: string;
  label: string;
  bin: string;
  /** Config that travels with the agent. An allowlist, because the login file
   * (auth.json, .credentials.json) sits next to it and belongs to the logins
   * rung, and because plugin clones and node_modules reinstall from their index. */
  config: readonly string[];
  /** Config the agent rewrites while it runs: it travels, and never decides whether a golden is the same golden. */
  volatile?: readonly string[];
  /** How its settings name the scripts its hooks run, which travel with it. */
  hooks?: HookCarry;
}

/** Aider is not a catalog agent (its project state has no measured resolver, so wsp does not ship it); its row stays for laptops that have it. */
const AIDER: Agent = { id: "aider", label: "Aider", bin: "aider", config: ["~/.aider.conf.yml", "~/.aider.model.settings.yml", "~/.aider.model.metadata.json"] };

/** The catalog's agents in its order, each with the config that travels, then Aider. */
export const AGENTS: readonly Agent[] = [...CATALOG_AGENTS.map((a): Agent => ({ id: a.id, label: a.name, bin: a.bin, config: a.configPaths, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}), ...(a.hooks !== undefined ? { hooks: a.hooks } : {}) })), AIDER];

/** The manifest row id of an agent, the one spelling readers match on. */
export const agentRowId = (id: string): string => `agents/${id}`;

export async function detectAgents(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const a of AGENTS) {
    const p = await presenceOf(host, { configPaths: [...a.config, ...(await hookScripts(host, a))], bin: a.bin });
    if (p === undefined) continue;
    rows.push(entry({ rung: "agents", id: agentRowId(a.id), label: a.label, paths: p.paths, bytes: p.bytes, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}) }));
  }
  return rows;
}

/** The files the agent's hooks run that no config path of its own already holds, `~/`-relative. */
async function hookScripts(host: Host, a: Agent): Promise<string[]> {
  const text = a.hooks === undefined ? undefined : await host.fs.readText(expand(host, a.hooks.file));
  if (a.hooks === undefined || text === undefined) return [];
  const out: string[] = [];
  for (const abs of hookFiles(a.hooks, text, host.home)) {
    const rel = tilde(host.home, abs);
    if (a.config.some(c => rel === c || rel.startsWith(`${c}/`))) continue;
    if ((await host.fs.stat(abs))?.kind === "file") out.push(rel);
  }
  return out;
}
