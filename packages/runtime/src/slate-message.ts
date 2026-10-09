// SPDX-License-Identifier: AGPL-3.0-only
// What a slate's send carries to the agent, made safe to read and cut to its cap.
import type { SlateJson } from "@wsp/protocol/slate";

/** A carried value with any line that would read as a second `slate:` line made harmless (12, injection). */
export function defanged(value: SlateJson): SlateJson {
  if (typeof value === "string") return value.replace(/^(\s*slate)\s*:(?=\s*\{)/gm, "$1：");
  if (Array.isArray(value)) return value.map(defanged);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, defanged(v)]));
  return value;
}


/** The longest string inside a value, by the path to it, for cutting a message down to its cap. */
export function longest(value: SlateJson, at: (string | number)[] = []): { at: (string | number)[]; length: number } | undefined {
  if (typeof value === "string") return { at, length: value.length };
  const kids = Array.isArray(value) ? value.map((v, i) => longest(v, [...at, i])) : value !== null && typeof value === "object" ? Object.entries(value).map(([k, v]) => longest(v, [...at, k])) : [];
  return kids.reduce<{ at: (string | number)[]; length: number } | undefined>((best, k) => (k !== undefined && (best === undefined || k.length > best.length) ? k : best), undefined);
}

export function cutAt(value: SlateJson, at: (string | number)[], keep: number): SlateJson {
  if (at.length === 0) return typeof value === "string" ? `${value.slice(0, keep)} (cut)` : value;
  const [head, ...rest] = at;
  if (Array.isArray(value)) return value.map((v, i) => (i === head ? cutAt(v, rest, keep) : v));
  if (value !== null && typeof value === "object") return { ...value, [head as string]: cutAt(value[head as string]!, rest, keep) };
  return value;
}
