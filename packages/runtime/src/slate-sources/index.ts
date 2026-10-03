// SPDX-License-Identifier: AGPL-3.0-only
// The host's resolvers, one module per source (06-sources). A path is read by its first segment's module and then
// walked by name and index; a source missing here reads as not there yet, which is what the renderer draws quietly.
import type { SlateJson } from "@wsp/protocol";
import type { HostSlateSource, SlateSourceContext } from "./context.js";
import { costSource } from "./cost.js";
import { gitSource } from "./git.js";
import { prSource } from "./pr.js";
import { stateSource } from "./state.js";
import { threadSource } from "./thread.js";
import { timeSource } from "./time.js";
import { usageSource } from "./usage.js";

export type { HostSlateSource, SlateSourceContext, SlateWorkspaceFacts } from "./context.js";

export const HOST_SLATE_SOURCES: ReadonlyMap<string, HostSlateSource> = new Map([threadSource, usageSource, costSource, timeSource, gitSource, prSource, stateSource].map(s => [s.name, s]));

/** A path's segments: "pr.checks[0].name" is pr, checks, 0, name. */
export function pathSegments(path: string): (string | number)[] {
  const segs: (string | number)[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(-?\d+)\]/g)) segs.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return segs;
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

/** One value walked down by segments; undefined where a step finds nothing. */
export function walk(value: SlateJson | undefined, segs: readonly (string | number)[]): SlateJson | undefined {
  let at = value;
  for (const seg of segs) {
    if (at === null || at === undefined || typeof at !== "object") return undefined;
    if (Array.isArray(at)) {
      if (typeof seg !== "number") return undefined;
      at = at[seg < 0 ? at.length + seg : seg];
    } else {
      if (typeof seg !== "string" || UNSAFE.has(seg) || !Object.prototype.hasOwnProperty.call(at, seg)) return undefined;
      at = at[seg];
    }
  }
  return at;
}

/** Each named source viewed once: what a sketch, a read or a press resolves its paths out of. */
export async function viewSources(names: Iterable<string>, ctx: SlateSourceContext): Promise<Map<string, SlateJson | undefined>> {
  const views = new Map<string, SlateJson | undefined>();
  for (const name of new Set(names)) {
    const source = HOST_SLATE_SOURCES.get(name);
    if (source === undefined) continue;
    views.set(name, await Promise.resolve(source.view(ctx)).catch(() => undefined));
  }
  return views;
}

/** A path read out of the views viewSources made. */
export function resolveIn(views: ReadonlyMap<string, SlateJson | undefined>, path: string): SlateJson | undefined {
  const [head, ...rest] = pathSegments(path);
  if (typeof head !== "string") return undefined;
  return walk(views.get(head), rest);
}
