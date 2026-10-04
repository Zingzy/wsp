// SPDX-License-Identifier: AGPL-3.0-only
// The slate's own values read and written by one path form, "$name[.field|[index]]*", the same in a binding, a
// step, a patch, the tools and the batch.
import type { SlateJson, SlateOwnPath, SlateValues } from "./types.js";

const SEGMENT = /^(?:\.([a-zA-Z_][a-zA-Z0-9_]*)|\[(-?\d+)\])/;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** The name and the segments after it, or undefined when the text is not an own path. */
export function parseSlateOwnPath(path: SlateOwnPath): { name: string; segs: (string | number)[] } | undefined {
  const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)/.exec(path);
  if (m === null) return undefined;
  const segs: (string | number)[] = [];
  let rest = path.slice(m[0].length);
  while (rest.length > 0) {
    const s = SEGMENT.exec(rest);
    if (s === null) return undefined;
    segs.push(s[1] !== undefined ? s[1] : Number(s[2]));
    rest = rest.slice(s[0].length);
  }
  return { name: m[1]!, segs };
}

export const slateOwnPathText = (name: string, segs: readonly (string | number)[]): string =>
  `$${name}${segs.map(s => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("")}`;

/** One step into a value: a record's own field, or a list's item counting back from the end for a negative index. */
export function slateStep(value: SlateJson | undefined, seg: string | number): SlateJson | undefined {
  if (value === null || value === undefined || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    if (typeof seg !== "number") return undefined;
    return value[seg < 0 ? value.length + seg : seg];
  }
  if (typeof seg !== "string" || UNSAFE.has(seg) || !Object.prototype.hasOwnProperty.call(value, seg)) return undefined;
  return value[seg];
}

export function getSlateValue(values: SlateValues, path: SlateOwnPath): SlateJson | undefined {
  const p = parseSlateOwnPath(path);
  if (p === undefined || !Object.prototype.hasOwnProperty.call(values, p.name)) return undefined;
  let at: SlateJson | undefined = values[p.name];
  for (const seg of p.segs) at = slateStep(at, seg);
  return at;
}

/** A copy of values with value at path, or undefined when the path is not an own path or steps through a scalar.
 * Missing records on the way are made; a list index past the end pads with null. */
export function setSlateValue(values: SlateValues, path: SlateOwnPath, value: SlateJson): SlateValues | undefined {
  const p = parseSlateOwnPath(path);
  if (p === undefined || UNSAFE.has(p.name) || p.segs.some(s => typeof s === "string" && UNSAFE.has(s))) return undefined;
  const write = (at: SlateJson | undefined, i: number): SlateJson | undefined => {
    if (i === p.segs.length) return value;
    const seg = p.segs[i]!;
    if (typeof seg === "number") {
      const list = Array.isArray(at) ? [...at] : at === undefined || at === null ? [] : undefined;
      if (list === undefined) return undefined;
      const index = seg < 0 ? list.length + seg : seg;
      if (index < 0) return undefined;
      const next = write(list[index], i + 1);
      if (next === undefined) return undefined;
      while (list.length < index) list.push(null);
      list[index] = next;
      return list;
    }
    const rec = at !== undefined && at !== null && typeof at === "object" && !Array.isArray(at) ? { ...at } : at === undefined || at === null ? {} : undefined;
    if (rec === undefined) return undefined;
    const next = write(Object.prototype.hasOwnProperty.call(rec, seg) ? rec[seg] : undefined, i + 1);
    if (next === undefined) return undefined;
    rec[seg] = next;
    return rec;
  };
  const next = write(values[p.name], 0);
  return next === undefined ? undefined : { ...values, [p.name]: next };
}

/** Deep equality over JSON, the one rule for "changed" (02, "Equality"). */
export function slateEqual(a: SlateJson | undefined, b: SlateJson | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bl = b as SlateJson[];
    return a.length === bl.length && a.every((v, i) => slateEqual(v, bl[i]));
  }
  const ak = Object.keys(a);
  const br = b as Record<string, SlateJson>;
  return ak.length === Object.keys(br).length && ak.every(k => Object.prototype.hasOwnProperty.call(br, k) && slateEqual(a[k], br[k]));
}
