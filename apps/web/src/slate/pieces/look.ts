// SPDX-License-Identifier: AGPL-3.0-only
// The meaning words a slate may say, drawn in the app's own tokens (05-styling). The agent picks a word; this file
// is the whole of how each one looks, in every theme, since every class reads a theme token.
import { fmtBytes, fmtCost, fmtDuration, fmtTokens, type SlateJson } from "@wsp/protocol";
import type { SlateEngine } from "../engine.js";

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
  accent: "text-primary",
};

/** A tone on a meter's fill: default is foreground at 55 percent on a 10 percent track. */
export const TONE_FILL: Record<Tone, string> = {
  default: "bg-foreground/55",
  muted: "bg-muted-foreground",
  good: "bg-success",
  warning: "bg-warning",
  bad: "bg-error-foreground",
  info: "bg-status-input",
  accent: "bg-primary",
};

/** The tone a value names, with accent kept for the slate's one loud piece and the rest drawn default. */
export function toneOf(value: SlateJson | undefined, slate: SlateEngine, id: string): Tone {
  if (typeof value !== "string" || !TONES.has(value)) return "default";
  if (value === "accent" && !slate.isLoud("accent", id)) return "default";
  return value as Tone;
}

export const GAP: Record<string, string> = { tight: "gap-1", normal: "gap-2", loose: "gap-4" };
export const gapOf = (value: SlateJson | undefined): string => GAP[typeof value === "string" ? value : "normal"] ?? GAP["normal"]!;

/** The type ladder's three steps a text may take. */
export const TEXT_SIZE: Record<string, string> = {
  small: "text-xs leading-4",
  normal: "text-sm leading-5",
  large: "text-[15px] leading-[22px]",
};

export const str = (value: SlateJson | undefined): string | undefined =>
  value === undefined || value === null ? undefined : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value);

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
    case "duration":
      return fmtDuration(value);
    case "integer":
      return Math.round(value).toLocaleString("en-US");
    default:
      return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
}
