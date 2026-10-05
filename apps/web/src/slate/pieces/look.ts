// SPDX-License-Identifier: AGPL-3.0-only
// The meaning words a slate may say, drawn in the app's own tokens (05-styling). The agent picks a word; this file
// is the whole of how each one looks, in every theme, since every class reads a theme token.
import { fmtBytes, fmtCost, fmtDuration, fmtInr, fmtTokens, type SlateJson, type SlatePropValue } from "@wsp/protocol";
import type { SlateEngine } from "../engine.js";
import { truthy } from "../actions.js";
import { whenOf } from "../paths.js";

export type Tone = "default" | "muted" | "good" | "warning" | "bad" | "info" | "accent";
const TONES: ReadonlySet<string> = new Set(["default", "muted", "good", "warning", "bad", "info", "accent"]);

/** A tone on a word or a figure. */
export const TONE_INK: Record<Tone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  good: "text-success",
  warning: "text-warning",
  bad: "text-error-foreground",
  info: "text-status-input",
  accent: "text-[var(--slate-accent,var(--primary))]",
};

/** A tone on a meter's fill: default is foreground at 55 percent on a 10 percent track. */
export const TONE_FILL: Record<Tone, string> = {
  default: "bg-foreground/55",
  muted: "bg-muted-foreground",
  good: "bg-success",
  warning: "bg-warning",
  bad: "bg-error-foreground",
  info: "bg-status-input",
  accent: "bg-[var(--slate-accent,var(--primary))]",
};

/** The tone a value names, with accent kept for the slate's one loud piece and the rest drawn default. */
export function toneOf(value: SlateJson | undefined, slate: SlateEngine, id: string): Tone {
  if (typeof value !== "string" || !TONES.has(value)) return "default";
  if (value === "accent" && !slate.isLoud("accent", id)) return "default";
  return value as Tone;
}

/** The steps a layout's children stand apart: 4, 12 (pieces, the owner's spacing of 2026-10-05) and 16. */
export const GAP: Record<string, string> = { tight: "gap-1", normal: "gap-3", loose: "gap-4" };
export const gapOf = (value: SlateJson | undefined): string => GAP[typeof value === "string" ? value : "normal"] ?? GAP["normal"]!;

export const str = (value: SlateJson | undefined): string | undefined =>
  value === undefined || value === null ? undefined : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);

/** The sentence a control is held by: a non-empty text holds it, anything else (null, false, "") lets it go. */
export const heldBy = (value: SlateJson | undefined): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

const WORD = /^[A-Za-z][a-z]*[,.:;!?]?$/;
/** Text that reads as a sentence, three plain words or more, rather than a figure, an id, a time or a path: mono on
 * it draws in the normal face. */
export const isSentence = (value: SlateJson | undefined): boolean => typeof value === "string" && value.trim().split(/\s+/).filter(word => WORD.test(word)).length >= 3;

export const num = (value: SlateJson | undefined): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A figure through the formatter its word names; a word this build does not know reads plain. */
export function figure(value: SlateJson | undefined, format: SlateJson | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return str(value);
  switch (format) {
    case "tokens":
      return fmtTokens(value);
    case "bytes":
      return fmtBytes(value);
    case "percent":
      return `${Math.round(value)}%`;
    case "usd":
      return fmtCost(value);
    case "inr":
      return fmtInr(value);
    case "duration":
      return fmtDuration(value);
    case "integer":
      return Math.round(value).toLocaleString("en-US");
    default:
      return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}

/** A note: a meta line, a count under a list, what a figure was read from. */
export const NOTE = "text-xs leading-4 text-muted-foreground";

/** A text the agent wrote muted, quiet or small with no tone of its own: a meta line, drawn as a note. */
export function isNoteText(slate: SlateEngine, id: string): boolean {
  const piece = slate.piece(id);
  if (piece?.type !== "text") return false;
  const read = (name: string) => (piece.props?.[name] === undefined ? undefined : slate.resolve(piece.props[name]));
  const tone = read("tone");
  const emphasis = read("emphasis");
  if (read("size") === "large" || emphasis === "strong" || (tone !== undefined && tone !== "muted" && tone !== "default")) return false;
  return tone === "muted" || emphasis === "quiet" || read("size") === "small";
}

/** The items of a list prop the document wrote out whose when holds, as the view resolved them; a list from a value
 * has no when of its own and comes whole. */
export function present<T>(slate: SlateEngine, raw: SlatePropValue | undefined, resolved: readonly T[]): T[] {
  if (!Array.isArray(raw) || raw.length !== resolved.length) return [...resolved];
  return resolved.filter((_, at) => {
    const when = whenOf(raw[at]);
    return when === undefined || truthy(slate.evaluate(when));
  });
}

/** The segmented control as the toolbar and the bar lists' switch draw it: the keycap's edge and fill, 26 px segments. */
export const SEGMENTED = "h-9 gap-0.5 rounded-[10px] border-input bg-input-fill shadow-[inset_0_1px_0_var(--keycap-top)]";
export const SEGMENT = "rounded-lg px-3.5";
