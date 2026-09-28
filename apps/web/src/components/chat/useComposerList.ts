// SPDX-License-Identifier: AGPL-3.0-only
// One list a composer menu draws from, read every time the menu opens on a new
// token: the copy's files for @, its open pull requests and issues for #. The
// last answer for the same copy and folder stands while the next is read and
// is replaced by it, so every token draws at once and none shows a list older
// than its own read. A list can be asked for ahead of its first token (the
// thread opening asks for the pull requests and issues); a token opening while
// that read is out joins it rather than asking twice. What is kept is kept per
// daemon link, so a new link reads everything again.
import { useEffect, useState } from "react";

interface Kept {
  data?: unknown;
  /** The read still out for this key, which a token opening meanwhile joins rather than asking twice. */
  reading?: Promise<unknown>;
}

const byLink = new WeakMap<object, Map<string, Kept>>();

function keptFor(link: object, key: string): Kept {
  let kept = byLink.get(link);
  if (kept === undefined) byLink.set(link, (kept = new Map()));
  let entry = kept.get(key);
  if (entry === undefined) kept.set(key, (entry = {}));
  return entry;
}

function readInto<T>(entry: Kept, read: () => Promise<T>): Promise<T> {
  if (entry.reading !== undefined) return entry.reading as Promise<T>;
  const reading = read().then(
    data => {
      entry.data = data;
      delete entry.reading;
      return data;
    },
    (e: unknown) => {
      delete entry.reading;
      throw e;
    },
  );
  entry.reading = reading;
  return reading;
}

/** Reads a list ahead of the token that will show it, unless an answer for it is already kept or on its way. */
export function prefetchComposerList<T>(link: object, key: string, read: () => Promise<T>): void {
  const entry = keptFor(link, key);
  if (entry.data !== undefined || entry.reading !== undefined) return;
  void readInto(entry, read).catch(() => {});
}

export interface ComposerList<T> {
  readonly data: T | null;
  readonly error: string | null;
}

/** `link` is the daemon link the list is read over and `key` names the copy and folder, null while the menu is shut;
 * `session` is the token the menu opened on, so a new token reads the list again. */
export function useComposerList<T>(link: object | null, key: string | null, session: string, read: () => Promise<T>): ComposerList<T> {
  const [state, setState] = useState<{ key: string | null; session: string; data: T | null; error: string | null }>({ key: null, session, data: null, error: null });

  useEffect(() => {
    if (key === null || link === null) return;
    let live = true;
    const entry = keptFor(link, key);
    // The kept answer draws meanwhile; a read still out is joined, otherwise the token reads afresh.
    readInto(entry, read).then(
      data => {
        if (live) setState({ key, session, data, error: null });
      },
      (e: unknown) => {
        if (live) setState({ key, session, data: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      live = false;
    };
    // The read is the caller's closure over the same key; a new closure for the same key and token asks nothing new.
  }, [key, link, session]);

  if (key === null || link === null) return { data: null, error: null };
  if (state.key === key && state.session === session) return { data: state.data, error: state.error };
  return { data: (keptFor(link, key).data as T | undefined) ?? null, error: null };
}
