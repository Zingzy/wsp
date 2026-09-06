// SPDX-License-Identifier: AGPL-3.0-only
// How long the last build on this computer took, stage by stage: written into
// the import result at the seal, read back when the next wsp init offers a
// rebuild, so the estimate is the measured one and not a constant.
import { existsSync, readFileSync } from "node:fs";
import type { StageView } from "./init.js";

export interface BuildTimes {
  /** When the seal finished, ISO 8601. */
  at: string;
  /** Milliseconds each clocked stage of the build and the seal ran, in the order they ran. */
  stages: Record<string, number>;
}

/** The one estimate the offer has before this computer has measured a build. */
const ASSUMED = "about ten minutes, not measured on this computer yet";

/** The stages the streams clocked, or nothing when a stage before a closing one has no clock: the builder already
 * held it, so the run was not a rebuild and measures none. */
export function buildTimes(views: readonly StageView[], at: Date): BuildTimes | undefined {
  const stages: Record<string, number> = {};
  for (const view of views) {
    for (const [i, step] of view.steps.entries()) {
      if (step.ms === undefined) {
        if (i === view.steps.length - 1) continue;
        return undefined;
      }
      stages[step.stage] = step.ms;
    }
  }
  return Object.keys(stages).length === 0 ? undefined : { at: at.toISOString(), stages };
}

/** The record the last seal left in the import result, or nothing when the file, the record or its shape is missing. */
export function readBuildTimes(path: string): BuildTimes | undefined {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("build" in parsed)) return undefined;
  const build = parsed.build;
  if (typeof build !== "object" || build === null || !("at" in build) || !("stages" in build)) return undefined;
  const { at, stages } = build;
  if (typeof at !== "string" || typeof stages !== "object" || stages === null) return undefined;
  const entries = Object.entries(stages);
  if (entries.length === 0 || !entries.every(([, ms]) => typeof ms === "number" && Number.isFinite(ms) && ms >= 0)) return undefined;
  return { at, stages: Object.fromEntries(entries) as Record<string, number> };
}

/** What a rebuild from scratch is said to take: the last build's stages summed, or the assumption when none was measured. */
export function rebuildEstimate(last: BuildTimes | undefined): string {
  if (last === undefined) return ASSUMED;
  const total = Object.values(last.stages).reduce((a, b) => a + b, 0);
  if (total < 60_000) return "under a minute last time";
  const minutes = Math.round(total / 60_000);
  return minutes === 1 ? "about a minute last time" : `about ${minutes} minutes last time`;
}
