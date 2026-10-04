// SPDX-License-Identifier: AGPL-3.0-only
// The JSX-like form of 03-syntax.
import type { SlateDoc, SlatePatch, SlateProblem } from "./types.js";

export function parseSlate(text: string): { document?: SlateDoc; errors: SlateProblem[]; warnings: SlateProblem[] } {
  return { errors: [{ code: "P100", name: "bad-syntax", message: `not built yet (${text.length} characters)` }], warnings: [] };
}
export function parseSlatePatch(text: string, current: SlateDoc | null): { patch?: SlatePatch; errors: SlateProblem[] } {
  void current;
  return { errors: [{ code: "P100", name: "bad-syntax", message: `not built yet (${text.length} characters)` }] };
}
export function printSlate(doc: SlateDoc): string {
  return `<slate title=${JSON.stringify(doc.title ?? "")}></slate>`;
}
