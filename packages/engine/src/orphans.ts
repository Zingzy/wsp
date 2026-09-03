import { BUILDER_IDLE_MS } from "./golden.js";
import type { MachineBackend } from "./machine.js";

export const WSP_LABEL = "wsp";
export const BUILDER_LABEL = "wsp-builder";
/** Which state file made a builder. Stamped at creation, so unlike the
 * provider's createdAt it survives a resume; a sweep from another state
 * file reads it and leaves the builder alone. */
export const OWNER_LABEL = "wsp-owner";
/** Sleeping experiments on the account wear this label; the reaper never
 * touches one, even when it also wears ours. */
export const RESERVED_LABEL = "poc";

export interface ReapOptions {
  backend: MachineBackend;
  /** Machine ids currently claimed by live workspaces or recorded builders. */
  knownIds: Iterable<string>;
  /** The sweeping state file's id; builders stamped with it are its to kill. */
  owner: string;
  olderThanMs?: number;
  now?: () => number;
}

/** A running builder the sweep left alone: another owner's, or unowned and not yet past the idle backstop. */
export interface SparedBuilder {
  id: string;
  labels: Record<string, string>;
  owner?: string;
  /** Since the createdAt label; absent when the label is missing or unreadable. */
  ageMs?: number;
  rateUsdPerHour: number;
}

export interface ReapResult {
  reaped: string[];
  spared: SparedBuilder[];
}

// Kills running machines that carry our label but that nothing claims.
// Non-wsp machines are never touched; machines without a parseable createdAt
// label are skipped because their age cannot be proven. A builder is killed
// when this owner made it (the record can be lost, the label cannot) or when
// no owner made it and it has outlived the idle window the provider gave it;
// any other running builder is reported, never killed.
export async function reap(opts: ReapOptions): Promise<ReapResult> {
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000;
  const now = opts.now ? opts.now() : Date.now();
  const known = new Set(opts.knownIds);

  const reaped: string[] = [];
  const spared: SparedBuilder[] = [];
  for (const m of await opts.backend.list()) {
    if (m.state !== "running") continue;
    if (RESERVED_LABEL in m.labels) continue;
    if (m.labels[WSP_LABEL] !== "1") continue;
    if (known.has(m.id)) continue;
    const createdAt = Date.parse(m.labels["createdAt"] ?? "");
    const ageMs = Number.isNaN(createdAt) ? undefined : now - createdAt;
    if (m.labels[BUILDER_LABEL] === "1") {
      const owner = m.labels[OWNER_LABEL];
      const orphanPastBackstop = owner === undefined && ageMs !== undefined && ageMs >= BUILDER_IDLE_MS;
      if (owner !== opts.owner && !orphanPastBackstop) {
        spared.push({
          id: m.id,
          labels: m.labels,
          ...(owner !== undefined ? { owner } : {}),
          ...(ageMs !== undefined ? { ageMs } : {}),
          rateUsdPerHour: opts.backend.pricing.rateUsdPerHour(m.size ?? opts.backend.pricing.defaultSize),
        });
        continue;
      }
    } else if (ageMs === undefined || ageMs < olderThanMs) {
      continue;
    }
    await (await opts.backend.get(m.id)).kill();
    reaped.push(m.id);
  }
  return { reaped, spared };
}
