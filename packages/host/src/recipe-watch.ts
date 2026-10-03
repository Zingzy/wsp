// SPDX-License-Identifier: AGPL-3.0-only
// Noticing a change on this computer to something a followed recipe holds: a
// skill's files, a config's files, an agent's own files and the file it keeps
// its servers in, and once a day the versions the managers list. Only what a
// recipe holds is watched; something new on this computer changes nothing.
// A folder is watched recursively at its real path, since an edit through a
// symlinked folder fires nothing on the link; a file is watched by itself and
// watched again after an editor's rename-replace; the home itself never is.
import { watch as fsWatch, statSync } from "node:fs";
import type { RecipeFile } from "@wsp/protocol";
import { itemSources } from "./recipes.js";

/** fs.watch as the watcher uses it, injected in tests. */
export type WatchFn = (path: string, o: { recursive: boolean }, listener: (event: string, name: string | null) => void) => { close(): void; on(event: "error" | "close", fn: () => void): unknown };

/** The timer the watcher arms after a burst, injected in tests. */
export interface WatchTimers {
  set(fn: () => void, ms: number): { unref?(): unknown };
  clear(timer: { unref?(): unknown }): void;
}

export interface RecipeWatchOptions {
  home: string;
  /** Every recipe some computer follows, read at each refresh. */
  followed(): Promise<{ slug: string; file: RecipeFile }[]>;
  /** Something those recipes hold changed here: the slugs that hold it. */
  changed(slugs: readonly string[]): void;
  /** Reads the versions the managers list again; the watcher then says every followed recipe may have moved. */
  versions?(): Promise<unknown>;
  watch?: WatchFn;
  timers?: WatchTimers;
  /** How long a burst of events on one path is let settle before it counts as one change. */
  debounceMs?: number;
  /** How often the versions are read again. */
  versionsEveryMs?: number;
}

export const WATCH_DEBOUNCE_MS = 2_000;
export const VERSIONS_EVERY_MS = 24 * 60 * 60_000;

const NODE_TIMERS: WatchTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: t => clearTimeout(t as NodeJS.Timeout) };

/** One path watched and the items it is read for, each with the recipes that hold it and what it last read as. */
interface Watched {
  path: string;
  recursive: boolean;
  items: Map<string, { slugs: Set<string>; digest(): string }>;
  handle?: ReturnType<WatchFn>;
  timer?: { unref?(): unknown };
}

/** Starts watching what the followed recipes hold; `refresh` reads them again and moves the watches to match, and
 * `close` takes every watch and timer away. Nothing is armed while nothing happens: no poll, and a timer only for the
 * burst it settles and for the daily versions read. */
export function recipeWatch(o: RecipeWatchOptions): { refresh(): Promise<void>; close(): void; watching(): { path: string; recursive: boolean }[] } {
  const watch = o.watch ?? (fsWatch as unknown as WatchFn);
  const timers = o.timers ?? NODE_TIMERS;
  const debounceMs = o.debounceMs ?? WATCH_DEBOUNCE_MS;
  const held = new Map<string, Watched>();
  /** What each item last read as, by `<slug> <key>`: a burst that leaves an item as it was says nothing, as a rewrite
   * of an agent's whole state file around a server entry it did not touch. */
  const last = new Map<string, string>();
  let closed = false;

  const fire = (w: Watched): void => {
    if (w.timer !== undefined) timers.clear(w.timer);
    w.timer = timers.set(() => {
      w.timer = undefined;
      const moved = new Set<string>();
      for (const [key, item] of w.items) {
        const now = item.digest();
        for (const slug of item.slugs) {
          if (last.get(`${slug} ${key}`) === now) continue;
          last.set(`${slug} ${key}`, now);
          moved.add(slug);
        }
      }
      if (moved.size > 0) o.changed([...moved]);
    }, debounceMs);
    w.timer.unref?.();
  };

  /** Arms one watch, and arms it again whenever it ends: an editor's rename-replace takes the file a watch was on
   * away, and a watch that errors is a watch on nothing. Either way what it watches may have changed. */
  const arm = (w: Watched): void => {
    if (closed || held.get(w.path) !== w) return;
    try {
      statSync(w.path);
    } catch {
      return;
    }
    let handle: ReturnType<WatchFn>;
    try {
      handle = watch(w.path, { recursive: w.recursive }, event => {
        fire(w);
        if (!w.recursive && event === "rename") again(w, handle);
      });
    } catch {
      return;
    }
    w.handle = handle;
    handle.on("error", () => again(w, handle));
  };
  const again = (w: Watched, handle: ReturnType<WatchFn>): void => {
    if (w.handle !== handle) return;
    handle.close();
    w.handle = undefined;
    fire(w);
    arm(w);
  };

  const refresh = async (): Promise<void> => {
    const want = new Map<string, { recursive: boolean; items: Watched["items"] }>();
    for (const { slug, file } of await o.followed()) {
      for (const source of itemSources(file, o.home)) {
        // What an item reads as when it is first watched is the point its changes count from.
        if (!last.has(`${slug} ${source.key}`)) last.set(`${slug} ${source.key}`, source.digest());
        for (const path of source.paths) {
          if (path === o.home) continue;
          let recursive = false;
          try {
            recursive = statSync(path).isDirectory();
          } catch {
            continue;
          }
          const at = want.get(path) ?? want.set(path, { recursive, items: new Map() }).get(path)!;
          const item = at.items.get(source.key) ?? at.items.set(source.key, { slugs: new Set(), digest: source.digest }).get(source.key)!;
          item.slugs.add(slug);
        }
      }
    }
    if (closed) return;
    for (const [path, w] of held) {
      if (want.has(path) && want.get(path)!.recursive === w.recursive) continue;
      w.handle?.close();
      if (w.timer !== undefined) timers.clear(w.timer);
      held.delete(path);
    }
    for (const [path, at] of want) {
      const w = held.get(path);
      if (w !== undefined) {
        w.items = at.items;
        continue;
      }
      const made: Watched = { path, recursive: at.recursive, items: at.items };
      held.set(path, made);
      arm(made);
    }
  };

  /** The versions the managers list, read now and then once a day where any recipe is followed, each read followed
   * by every followed recipe. */
  let versionsTimer: { unref?(): unknown } | undefined;
  const versions = async (): Promise<void> => {
    if (o.versions === undefined || closed) return;
    const slugs = (await o.followed().catch(() => [])).map(r => r.slug);
    if (slugs.length > 0) {
      await o.versions().catch(() => undefined);
      if (!closed) o.changed(slugs);
    }
    if (closed) return;
    versionsTimer = timers.set(() => void versions(), o.versionsEveryMs ?? VERSIONS_EVERY_MS);
    versionsTimer.unref?.();
  };
  void versions();

  return {
    refresh,
    close: () => {
      closed = true;
      for (const w of held.values()) {
        w.handle?.close();
        if (w.timer !== undefined) timers.clear(w.timer);
      }
      held.clear();
      if (versionsTimer !== undefined) timers.clear(versionsTimer);
    },
    watching: () => [...held.values()].filter(w => w.handle !== undefined).map(w => ({ path: w.path, recursive: w.recursive })),
  };
}
