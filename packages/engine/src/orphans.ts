import { BUILDER_IDLE_MS } from "./golden.js";
import type { MachineBackend } from "./machine.js";

export const WSP_LABEL = "wsp";
export const BUILDER_LABEL = "wsp-builder";
/** Which state file made a machine. Stamped at creation, so unlike the
 * provider's createdAt it survives a resume; a sweep from another state
 * file reads it and leaves the machine alone. */
export const OWNER_LABEL = "wsp-owner";
/** Sleeping experiments on the account wear this label; the reaper never
 * touches one, even when it also wears ours. */
export const RESERVED_LABEL = "poc";

export interface ReapOptions {
  backend: MachineBackend;
  /** Machine ids currently claimed by live workspaces, recorded builders, or creates still in flight. */
  knownIds: Iterable<string>;
  /** The sweeping state file's id; machines stamped with it are its to kill. */
  owner: string;
  /** Age an unclaimed non-builder must reach before it is killed; the builder backstop is the idle window it was created with. */
  olderThanMs?: number;
  now?: () => number;
}

export type Whose = "own" | "foreign" | "none";

export interface ReapedMachine {
  id: string;
  /** Off the listing; a machine killed from its record alone has none. */
  labels?: Record<string, string>;
  builder: boolean;
  /** recorded: this state file's record from an earlier process; own: wears this owner's
   * label with no record left; orphan: no owner label and past its backstop. */
  reason: "recorded" | "own" | "orphan";
  ageMs?: number;
}

/** A running machine the sweep left alone: another owner's, or not yet past its backstop. */
export interface SparedMachine {
  id: string;
  labels: Record<string, string>;
  builder: boolean;
  whose: Whose;
  owner?: string;
  /** Since the createdAt label; absent when the label is missing or unreadable. */
  ageMs?: number;
  /** How old an unowned machine must get before this sweep kills it. */
  backstopMs: number;
  rateUsdPerHour: number;
}

export interface ReapResult {
  reaped: ReapedMachine[];
  spared: SparedMachine[];
  /** Set when the listing failed after the recorded kills were already done; nothing else was touched. */
  failed?: string;
}

// Kills running machines that carry our label but that nothing claims.
// Non-wsp machines are never touched; machines without a parseable createdAt
// label are never killed on age, since their age cannot be proven. A machine
// wearing this owner's label dies at once if it is a builder (its record can
// be lost, the label cannot) and past olderThanMs otherwise; one with no owner
// label dies past its backstop; one with another owner is reported, never killed.
export async function reap(opts: ReapOptions): Promise<ReapResult> {
  if (!opts.owner) throw new Error("reap needs the owner id; an empty one would claim every unowned machine");
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000;
  const now = opts.now ? opts.now() : Date.now();
  const known = new Set(opts.knownIds);

  const reaped: ReapedMachine[] = [];
  const spared: SparedMachine[] = [];
  for (const m of await opts.backend.list()) {
    if (m.state !== "running") continue;
    if (RESERVED_LABEL in m.labels) continue;
    if (m.labels[WSP_LABEL] !== "1") continue;
    if (known.has(m.id)) continue;
    const builder = m.labels[BUILDER_LABEL] === "1";
    const owner = m.labels[OWNER_LABEL];
    const whose: Whose = owner === undefined ? "none" : owner === opts.owner ? "own" : "foreign";
    const createdAt = Date.parse(m.labels["createdAt"] ?? "");
    const ageMs = Number.isNaN(createdAt) ? undefined : now - createdAt;
    const backstopMs = builder ? BUILDER_IDLE_MS : olderThanMs;
    const pastBackstop = ageMs !== undefined && ageMs >= backstopMs;
    const kill = whose === "own" ? builder || pastBackstop : whose === "none" && pastBackstop;
    if (!kill) {
      spared.push({
        id: m.id,
        labels: m.labels,
        builder,
        whose,
        ...(owner !== undefined ? { owner } : {}),
        ...(ageMs !== undefined ? { ageMs } : {}),
        backstopMs,
        rateUsdPerHour: opts.backend.pricing.rateUsdPerHour(m.size ?? opts.backend.pricing.defaultSize),
      });
      continue;
    }
    await (await opts.backend.get(m.id)).kill();
    reaped.push({ id: m.id, labels: m.labels, builder, reason: whose === "own" ? "own" : "orphan", ...(ageMs !== undefined ? { ageMs } : {}) });
  }
  return { reaped, spared };
}
