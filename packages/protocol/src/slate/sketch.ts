// SPDX-License-Identifier: AGPL-3.0-only
import type { Slate, SlateEvalContext, SlateJson } from "./types.js";

export function sketchSlate(_doc: Slate | null, _state: Record<string, SlateJson>, _ctx: SlateEvalContext): string {
  return "slate is empty";
}
