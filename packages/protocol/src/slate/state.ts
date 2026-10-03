// SPDX-License-Identifier: AGPL-3.0-only
// The slate's own values read and written by one path form, "state.<key>[.<key>|[index]]*", the same in a binding,
// an action, a patch and the tools.
import type { SlateJson, SlateStatePath } from "./types.js";

const SEGMENT = /^(?:\.([a-zA-Z_][a-zA-Z0-9_]*)|\[(-?\d+)\])/;

/** The segments after "state", or undefined when the text is not a state path. */
export function parseSlateStatePath(path: SlateStatePath): (string | number)[] | undefined {
  if (!path.startsWith("state.")) return undefined;
  const segs: (string | number)[] = [];
  let rest = path.slice(5);
  while (rest.length > 0) {
    const m = SEGMENT.exec(rest);
    if (m === null) return undefined;
    segs.push(m[1] !== undefined ? m[1] : Number(m[2]));
    rest = rest.slice(m[0].length);
  }
  return segs.length > 0 && typeof segs[0] === "string" ? segs : undefined;
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

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

export function getSlateState(state: Record<string, SlateJson>, path: SlateStatePath): SlateJson | undefined {
  const segs = parseSlateStatePath(path);
  if (segs === undefined) return undefined;
  let at: SlateJson | undefined = state;
  for (const seg of segs) at = slateStep(at, seg);
  return at;
}

/** A copy of state with the value at path; missing records on the way are made, a list index past the end pads
 * with null. A path that is not a state path, or that steps into a scalar, leaves the state as it was. */
export function setSlateState(state: Record<string, SlateJson>, path: SlateStatePath, value: SlateJson): Record<string, SlateJson> {
  const segs = parseSlateStatePath(path);
  if (segs === undefined || segs.some(s => typeof s === "string" && UNSAFE.has(s))) return state;
  const write = (at: SlateJson | undefined, i: number): SlateJson | undefined => {
    if (i === segs.length) return value;
    const seg = segs[i]!;
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
  const out = write(state, 0);
  return out !== undefined && typeof out === "object" && out !== null && !Array.isArray(out) ? out : state;
}
