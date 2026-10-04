// SPDX-License-Identifier: AGPL-3.0-only
// The batch's pure core (02, "The batch").
import type { SlateDoc, SlateJson, SlateProblem, SlateSendStep, SlateStep, SlateValues } from "./types.js";

export interface SlateBatchResult {
  values: SlateValues;
  changed: string[];
  starts: { run: string; why: string }[];
  cancels: string[];
  sends: SlateSendStep[];
  other: SlateStep[];
  problems: SlateProblem[];
}
export function runSlateBatch(doc: SlateDoc, values: SlateValues, writes: { path: string; value: SlateJson }[], ctx: object = {}): SlateBatchResult {
  void doc; void writes; void ctx;
  return { values, changed: [], starts: [], cancels: [], sends: [], other: [], problems: [] };
}
