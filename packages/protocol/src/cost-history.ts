// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's cost history is the ticks where its burn rate changed. Between
// two ticks of one rate the accrued total is linear, so the ticks between them
// carry nothing; the runtime and the app both fold a series with this rule.
import type { WorkspaceCostEvent } from "./index.js";

/** Rate changes on every nap, wake and upgrade; hourly flips for a month stay well under this. */
export const COST_HISTORY_CAP = 4096;

/** The series with `tick` appended: a tick that continues the rate of the two before it replaces the newest, so the
 * series holds the first tick, the last tick of each rate, the first tick of the next and the newest. Equal rates
 * stand for one straight run because the runtime's accrued total is its rate times awake time, never a step. */
export function appendCostPoint(points: readonly WorkspaceCostEvent[], tick: WorkspaceCostEvent): WorkspaceCostEvent[] {
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const collinear = last !== undefined && prev !== undefined && prev.rateUsdPerHour === last.rateUsdPerHour && last.rateUsdPerHour === tick.rateUsdPerHour;
  const next = collinear ? [...points.slice(0, -1), tick] : [...points, tick];
  return next.length > COST_HISTORY_CAP ? next.slice(next.length - COST_HISTORY_CAP) : next;
}
