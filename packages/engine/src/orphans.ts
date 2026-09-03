import { BUILDER_IDLE_MS } from "./golden.js";
import type { MachineBackend } from "./machine.js";

export const WSP_LABEL = "wsp";
export const BUILDER_LABEL = "wsp-builder";
/** Which state file made a machine. Stamped at creation, so unlike the
 * provider's createdAt it survives a resume; a sweep from another state
 * file reads it and leaves the machine alone. */
export const OWNER_LABEL = "wsp-owner";
/** An own machine is claimed only once its create returns; a listing during
 * the create could show it unclaimed. Whether the provider lists a machine
 * mid-create is unmeasured, so a machine this young is spared on age alone. */
export const OWN_GRACE_MS = 60_000;
/** Sleeping experiments on the account wear this label; the reaper never
 * touches one, even when it also wears ours. */
export const RESERVED_LABEL = "poc";

export interface ReapOptions {
  backend: MachineBackend;
  /** Ids claimed by live workspaces, recorded builders, creates still in flight and kills just done.
   * Read after the listing returns, so a create that lands during it already counts. */
  knownIds: () => Iterable<string>;
  /** The sweeping state file's id; machines stamped with it are its to kill. */
  owner: string;
  /** Age an unclaimed unowned non-builder must reach before it is killed; the unowned builder backstop is the idle window it was created with. */
  olderThanMs?: number;
  now?: () => number;
}

export type Whose = "own" | "foreign" | "none";

export interface ReapedMachine {
  id: string;
  /** Off the listing; a machine killed from its record alone has none. */
  labels?: Record<string, string>;
  builder: boolean;
  /** recorded: this state file's record from an earlier process, not sealable; expired: a kept
   * first-life record past six hours by its createdAt label; own: wears this owner's label with
   * no record left; orphan: no owner label and past its backstop. */
  reason: "recorded" | "expired" | "own" | "orphan";
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

export interface ReapFailure {
  /** The machine whose kill failed; absent when the listing itself failed. */
  id?: string;
  message: string;
}

export interface ReapResult {
  reaped: ReapedMachine[];
  spared: SparedMachine[];
  /** One entry per thing that went wrong: a kill that failed, or the listing itself; the rest of the sweep still ran. */
  failed?: ReapFailure[];
}

/** An age for a person. A createdAt stamped by a clock ahead of ours reads as zero, never negative. */
export function describeAge(ms: number | undefined): string {
  if (ms === undefined) return "age unknown";
  const age = Math.max(0, ms);
  if (age < 60_000) return `${Math.floor(age / 1000)} s old`;
  if (age < 3_600_000) return `${Math.floor(age / 60_000)} min old`;
  return `${(age / 3_600_000).toFixed(1)} h old`;
}

// Kills running machines that carry our label but that nothing claims.
// Non-wsp machines are never touched; machines without a parseable createdAt
// label are never killed on age, since their age cannot be proven. A machine
// wearing this owner's label dies once its create grace is over, whatever its
// kind (its record can be lost, the label cannot); one with no owner label
// dies past its backstop; one with another owner is reported, never killed.
// Nothing here fetches a machine it leaves alone: a per-machine GET resets the
// provider's idle timer (measured), so only the listing is read for those.
export async function reap(opts: ReapOptions): Promise<ReapResult> {
  if (!opts.owner) throw new Error("reap needs the owner id; an empty one would claim every unowned machine");
  const olderThanMs = opts.olderThanMs ?? 10 * 60_000;
  const now = opts.now ? opts.now() : Date.now();
  const rows = await opts.backend.list();
  const known = new Set(opts.knownIds());

  const reaped: ReapedMachine[] = [];
  const spared: SparedMachine[] = [];
  const failed: ReapFailure[] = [];
  for (const m of rows) {
    if (m.state !== "running") continue;
    if (RESERVED_LABEL in m.labels) continue;
    if (m.labels[WSP_LABEL] !== "1") continue;
    if (known.has(m.id)) continue;
    const builder = m.labels[BUILDER_LABEL] === "1";
    const owner = m.labels[OWNER_LABEL];
    const whose: Whose = owner === undefined ? "none" : owner === opts.owner ? "own" : "foreign";
    const createdAt = Date.parse(m.labels["createdAt"] ?? "");
    const ageMs = Number.isNaN(createdAt) ? undefined : now - createdAt;
    const backstopMs = whose === "own" ? OWN_GRACE_MS : builder ? BUILDER_IDLE_MS : olderThanMs;
    const pastBackstop = ageMs !== undefined && ageMs >= backstopMs;
    const kill = whose === "own" ? ageMs === undefined || pastBackstop : whose === "none" && pastBackstop;
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
    try {
      await (await opts.backend.get(m.id)).kill();
    } catch (e) {
      // The listing lags a kill (measured): a row that is gone by the time it is fetched is no failure.
      if ((e as { kind?: string }).kind === "missing") continue;
      failed.push({ id: m.id, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    reaped.push({ id: m.id, labels: m.labels, builder, reason: whose === "own" ? "own" : "orphan", ...(ageMs !== undefined ? { ageMs } : {}) });
  }
  return { reaped, spared, ...(failed.length > 0 ? { failed } : {}) };
}
