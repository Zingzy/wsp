// SPDX-License-Identifier: AGPL-3.0-only
// Noticing a change on this computer to something a followed recipe holds: a
// skill's files, a config's files, an agent's own files and the file it keeps
// its servers in, and once a day the versions the managers list. Only what a
// recipe holds is watched; something new on this computer changes nothing.
// A folder is watched recursively at its real path, since an edit through a
// symlinked folder fires nothing on the link; a file is watched through its
// folder, by its name, so a rename-replace or an unlink and a write of it is
// still heard; the home is never watched recursively.
import { watch as fsWatch, statSync } from "node:fs";
import { basename, dirname } from "node:path";
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

/** The items a burst on a watched folder may have moved: every item under a folder watched whole, and the items of
 * one file watched through its folder, by the file's name. */
type Items = Map<string, { slugs: Set<string>; digest(): string }>;

/** One folder watched: recursively where an item is the folder itself (a skill), else alone, for the files in it an
 * item reads (a config, an agent's own file), so an editor's rename-replace or an unlink and a write of the file is
 * still heard. */
interface Watched {
  path: string;
  recursive: boolean;
  whole: Items;
  byName: Map<string, Items>;
  handle?: ReturnType<WatchFn>;
  timer?: { unref?(): unknown };
  touched: Set<Items>;
}

/** Starts watching what the followed recipes hold; `refresh` reads them again and moves the watches to match, and
 * `close` takes every watch and timer away. Nothing is armed while nothing happens: no poll, and a timer only for the
 * burst it settles and for the daily versions read. The home is never watched recursively. */
export function recipeWatch(o: RecipeWatchOptions): { refresh(): Promise<void>; close(): void; watching(): { path: string; recursive: boolean }[] } {
  const watch = o.watch ?? (fsWatch as unknown as WatchFn);
  const timers = o.timers ?? NODE_TIMERS;
  const debounceMs = o.debounceMs ?? WATCH_DEBOUNCE_MS;
  const held = new Map<string, Watched>();
  /** What each item last read as, by `<slug> <key>`: a burst that leaves an item as it was says nothing, as a rewrite
   * of an agent's whole state file around a server entry it did not touch. */
  const last = new Map<string, string>();
  let closed = false;

  const fire = (w: Watched, name: string | null): void => {
    w.touched.add(w.whole);
    if (name === null) for (const items of w.byName.values()) w.touched.add(items);
    else {
      const items = w.byName.get(basename(name));
      if (items !== undefined) w.touched.add(items);
    }
    if (w.timer !== undefined) timers.clear(w.timer);
    w.timer = timers.set(() => {
      w.timer = undefined;
      const moved = new Set<string>();
      for (const items of w.touched) {
        for (const [key, item] of items) {
          const now = item.digest();
          for (const slug of item.slugs) {
            if (last.get(`${slug} ${key}`) === now) continue;
            last.set(`${slug} ${key}`, now);
            moved.add(slug);
          }
        }
      }
      w.touched.clear();
      if (moved.size > 0) o.changed([...moved]);
    }, debounceMs);
    w.timer.unref?.();
  };

  /** Arms one watch, and arms it again when it errors, which is a watch on nothing: what it watched may have moved. */
  const arm = (w: Watched): void => {
    if (closed || held.get(w.path) !== w) return;
    try {
      if (!statSync(w.path).isDirectory()) return;
    } catch {
      return;
    }
    let handle: ReturnType<WatchFn>;
    try {
      handle = watch(w.path, { recursive: w.recursive }, (_event, name) => fire(w, name));
    } catch {
      return;
    }
    w.handle = handle;
    handle.on("error", () => {
      if (w.handle !== handle) return;
      handle.close();
      w.handle = undefined;
      fire(w, null);
      arm(w);
    });
  };

  const refresh = async (): Promise<void> => {
    const want = new Map<string, { recursive: boolean; whole: Items; byName: Map<string, Items> }>();
    const at = (path: string, recursive: boolean) => {
      const got = want.get(path) ?? want.set(path, { recursive: false, whole: new Map(), byName: new Map() }).get(path)!;
      if (recursive) got.recursive = true;
      return got;
    };
    const add = (items: Items, key: string, slug: string, digest: () => string): void => void (items.get(key) ?? items.set(key, { slugs: new Set(), digest }).get(key)!).slugs.add(slug);
    for (const { slug, file } of await o.followed()) {
      for (const source of itemSources(file, o.home)) {
        // What an item reads as when it is first watched is the point its changes count from.
        if (!last.has(`${slug} ${source.key}`)) last.set(`${slug} ${source.key}`, source.digest());
        for (const path of source.paths) {
          let folder = false;
          try {
            folder = statSync(path).isDirectory();
          } catch {
            folder = false;
          }
          if (folder && path !== o.home) add(at(path, true).whole, source.key, slug, source.digest);
          else if (!folder) {
            const named = at(dirname(path), false).byName;
            add(named.get(basename(path)) ?? named.set(basename(path), new Map()).get(basename(path))!, source.key, slug, source.digest);
          }
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
    for (const [path, wanted] of want) {
      const w = held.get(path);
      if (w !== undefined) {
        w.whole = wanted.whole;
        w.byName = wanted.byName;
        continue;
      }
      const made: Watched = { path, recursive: wanted.recursive, whole: wanted.whole, byName: wanted.byName, touched: new Set() };
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
