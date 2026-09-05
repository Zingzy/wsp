// SPDX-License-Identifier: AGPL-3.0-only
import { CATALOG_AGENTS } from "@wsp/catalog";
import type { Host } from "../host.js";
import type { ManifestEntry } from "../manifest.js";
import { entry, found } from "./common.js";

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
}

/** Aider is not a catalog agent (its project state has no measured resolver, so wsp does not ship it); its row stays for laptops that have it. */
const AIDER: Agent = { id: "aider", label: "Aider", bin: "aider", config: ["~/.aider.conf.yml", "~/.aider.model.settings.yml", "~/.aider.model.metadata.json"] };

/** The catalog's agents in its order, each with the config that travels. */
export const AGENTS: readonly Agent[] = CATALOG_AGENTS.flatMap(a => [...(a.id === "pi" ? [AIDER] : []), { id: a.id, label: a.name, bin: a.bin, config: a.configPaths, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}) }]);

export async function detectAgents(host: Host): Promise<ManifestEntry[]> {
  const rows: ManifestEntry[] = [];
  for (const a of AGENTS) {
    const f = await found(host, a.config);
    if (f.paths.length === 0 && !(await host.exec.which(a.bin))) continue;
    rows.push(entry({ rung: "agents", id: `agents/${a.id}`, label: a.label, ...f, ...(a.volatile !== undefined ? { volatile: a.volatile } : {}) }));
  }
  return rows;
}
