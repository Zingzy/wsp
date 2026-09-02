import type { MachineBackend } from "./machine.js";

export const WSP_LABEL = "wsp";
export const BUILDER_LABEL = "wsp-builder";
/** Sleeping experiments on the account wear this label; the reaper never
 * touches one, even when it also wears ours. */
export const RESERVED_LABEL = "poc";

export interface ReapOptions {
  backend: MachineBackend;
  /** Machine ids currently claimed by live workspaces or recorded builders. */
  knownIds: Iterable<string>;
  olderThanMs?: number;
  now?: () => number;
}

// Kills running machines that carry our label but that nothing claims.
// Non-wsp machines are never touched; machines without a parseable createdAt
// label are skipped because their age cannot be proven. A builder is the
// exception: no process can seal one it has no record of, so its age is moot.
export async function reap(opts: ReapOptions): Promise<string[]> {
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000;
  const now = opts.now ? opts.now() : Date.now();
  const known = new Set(opts.knownIds);

  const reaped: string[] = [];
  for (const m of await opts.backend.list()) {
    if (m.state !== "running") continue;
    if (RESERVED_LABEL in m.labels) continue;
    if (m.labels[WSP_LABEL] !== "1") continue;
    if (known.has(m.id)) continue;
    if (m.labels[BUILDER_LABEL] !== "1") {
      const createdAt = Date.parse(m.labels["createdAt"] ?? "");
      if (Number.isNaN(createdAt) || now - createdAt < olderThanMs) continue;
    }
    await (await opts.backend.get(m.id)).kill();
    reaped.push(m.id);
  }
  return reaped;
}
