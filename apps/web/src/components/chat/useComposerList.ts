// SPDX-License-Identifier: AGPL-3.0-only
// One list a composer menu draws from, read when the menu opens on a new
// token: the copy's files for @, its open pull requests and issues for #. The
// last answer for the same copy and folder stands while the next is read, so a
// second @ draws at once; a read that failed says why in one sentence.
import { useEffect, useState } from "react";

const kept = new Map<string, unknown>();

export interface ComposerList<T> {
  readonly data: T | null;
  readonly error: string | null;
}

/** `key` names the copy and folder, null while the menu is shut; `session` is the token the menu opened on, so a new
 * token reads the list again. */
export function useComposerList<T>(key: string | null, session: string, read: () => Promise<T>): ComposerList<T> {
  const [state, setState] = useState<{ key: string | null; session: string; data: T | null; error: string | null }>({ key: null, session, data: null, error: null });

  useEffect(() => {
    if (key === null) return;
    let live = true;
    read().then(
      data => {
        kept.set(key, data);
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
  }, [key, session]);

  if (key === null) return { data: null, error: null };
  if (state.key === key && state.session === session) return { data: state.data, error: state.error };
  return { data: (kept.get(key) as T | undefined) ?? null, error: null };
}
