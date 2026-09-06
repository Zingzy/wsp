// SPDX-License-Identifier: AGPL-3.0-only
import { detectAgents } from "./detect/agents.js";
import { shellAliases } from "./detect/aliases.js";
import type { Detector } from "./detect/common.js";
import { detectEditors } from "./detect/editors.js";
import { detectIdentity } from "./detect/identity.js";
import { detectLogins } from "./detect/logins.js";
import { detectMcp, mcpGroups } from "./detect/mcp.js";
import { detectShell } from "./detect/shell.js";
import { shellSources } from "./detect/sources.js";
import { detectTerminalFont } from "./detect/terminal.js";
import { detectToolchains } from "./detect/toolchains.js";
import { detectTools } from "./detect/tools.js";
import { type Lookup, lookup as catalogLookup } from "./catalog.js";
import { everything } from "./everything/everything.js";
import type { Machine } from "./everything/host.js";
import { claimedPaths, entriesFor, rungPrograms } from "./everything-entries.js";
import type { Host } from "./host.js";
import { type GroupNote, type Manifest, type ManifestEntry, RUNGS, type Rung, parseManifest } from "./manifest.js";

export const DETECTORS: Record<Exclude<Rung, "everything">, Detector> = {
  identity: detectIdentity,
  shell: async host => {
    const rows = await detectShell(host);
    await shellSources(host, rows);
    return [...rows, ...(await detectTerminalFont(host))];
  },
  editors: detectEditors,
  toolchains: detectToolchains,
  tools: detectTools,
  agents: async (host, prior) => [...(await detectAgents(host)), ...(await detectMcp(host, prior))],
  logins: detectLogins,
};

/** What a rung's groups cover and leave out, read after the rung's rows. */
const GROUP_NOTES: Partial<Record<Rung, (host: Host, rows: readonly ManifestEntry[]) => Promise<GroupNote[]>>> = { agents: mcpGroups };

export interface CollectOptions {
  /** Called after each rung's detector with its row count, so a spinner can count rows as they land. */
  onRung?: (rung: Rung, count: number) => void;
  /** The laptop as the everything rung reads it; without it that rung is left out. */
  machine?: Machine;
  /** The catalog the everything rung consults; the shipped one by default. */
  lookup?: Lookup;
  /** Told once when the everything rung could not be read; the seven rungs still come back. */
  onNote?: (note: string) => void;
}

/** Runs every rung's detector in ladder order, then the everything rung over what they left
 * unclaimed, and validates the result against the schema. */
export async function collect(host: Host, opts: CollectOptions = {}): Promise<Manifest> {
  const entries: ManifestEntry[] = [];
  const groups: GroupNote[] = [];
  for (const rung of RUNGS) {
    if (rung === "everything") continue;
    const rows = await DETECTORS[rung](host, entries);
    opts.onRung?.(rung, rows.length);
    entries.push(...rows);
    groups.push(...(await (GROUP_NOTES[rung]?.(host, rows) ?? [])));
  }
  // The shell's aliases are matched against the tools rows, so they are read once every rung is in.
  await shellAliases(host, entries);
  if (opts.machine !== undefined) {
    let rows: ManifestEntry[] = [];
    try {
      const found = await everything(opts.machine, { lookup: opts.lookup ?? catalogLookup, claimed: claimedPaths(entries), ...rungPrograms(entries) });
      rows = entriesFor(found.rows);
      // The row carrying an rc file, itself or the directory around it, learns which exported names its copy drops; values stay on the laptop.
      const under = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`);
      for (const scan of found.shell) {
        for (const e of [...entries, ...rows]) {
          if (!e.paths.some(p => under(scan.path, p))) continue;
          e.secrets = [...new Set([...(e.secrets ?? []), ...scan.names])];
        }
      }
    } catch (e) {
      opts.onNote?.(`Everything else could not be read and is left out: ${e instanceof Error ? e.message : String(e)}`);
    }
    opts.onRung?.("everything", rows.length);
    entries.push(...rows);
  }
  return parseManifest({ entries, ...(groups.length > 0 ? { groups } : {}) });
}
