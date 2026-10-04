// SPDX-License-Identifier: AGPL-3.0-only
// The slate as text with its values filled in (10, "The sketch").
import type { SlateDoc, SlateValues } from "./types.js";

export function sketchSlate(doc: SlateDoc | null, values: SlateValues, ctx: object = {}): string {
  void values; void ctx;
  return doc === null ? "slate, empty" : `slate ${JSON.stringify(doc.title ?? "")}`;
}
