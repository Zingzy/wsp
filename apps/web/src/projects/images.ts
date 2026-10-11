// SPDX-License-Identifier: AGPL-3.0-only
// The images projects wear, as this window holds them: one object URL per hash
// a project or a drawn recipe row names, revoked once nothing names the hash.
// A hash never changes its bytes, so each is read from the host once per
// connection; one the host does not keep is not asked again until the socket
// is live again. Nothing here decodes ahead of the page: with fifty images a
// decode of its own took the renderer from +5.6 MB to +13.5 MB, and an <img>
// loaded out of the flow first to +11 MB (Chromium 151), so a mark draws its
// <img> as soon as the URL is here.
import { create } from "zustand";
import { notRead } from "../notices/store.js";
import type { Api } from "../protocol/client.js";

export const useProjectIcons = create<{ urls: Readonly<Record<string, string>> }>(() => ({ urls: {} }));

let api: Api | null = null;
let named: ReadonlySet<string> = new Set();
/** Hashes a drawn row names apart from the record, such as a recipe's folder, each with how many rows name it. */
const wanted = new Map<string, number>();
const asking = new Set<string>();
const missing = new Set<string>();

const needed = (): Set<string> => new Set([...named, ...wanted.keys()]);

const urlOf = (dataUrl: string): string => URL.createObjectURL(new Blob([Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(",") + 1)), c => c.charCodeAt(0))], { type: "image/png" }));

const revoke = (url: string): void => URL.revokeObjectURL(url);

function settle(): void {
  const need = needed();
  const { urls } = useProjectIcons.getState();
  const gone = Object.keys(urls).filter(hash => !need.has(hash));
  if (gone.length > 0) {
    for (const hash of gone) revoke(urls[hash]!);
    useProjectIcons.setState({ urls: Object.fromEntries(Object.entries(urls).filter(([hash]) => need.has(hash))) });
  }
  const ask = [...need].filter(hash => urls[hash] === undefined && !asking.has(hash) && !missing.has(hash));
  const read = api?.projectIcons;
  if (ask.length === 0 || read === undefined) return;
  for (const hash of ask) asking.add(hash);
  void read(ask)
    .then(answer => {
      const landed: Record<string, string> = {};
      const need = needed();
      for (const hash of ask) {
        const data = answer[hash];
        if (data == null) missing.add(hash);
        else if (need.has(hash)) landed[hash] = urlOf(data);
      }
      if (Object.keys(landed).length > 0) useProjectIcons.setState(s => ({ urls: { ...s.urls, ...landed } }));
    })
    .catch(notRead("Project images"))
    .finally(() => {
      for (const hash of ask) asking.delete(hash);
    });
}

/** What the record names now and the socket to read through; asks for every hash this window lacks. `again` is a
 * fresh connection, after which a hash the host did not keep is asked once more. */
export function followProjectIcons(next: { api: Api | null; projectIcon: Readonly<Record<string, string>> | undefined; again?: boolean }): void {
  api = next.api;
  named = new Set(Object.values(next.projectIcon ?? {}));
  if (next.again === true) missing.clear();
  settle();
}

/** Holds a hash a row names apart from the record until the release it answers is called. */
export function wantProjectIcon(hash: string): () => void {
  wanted.set(hash, (wanted.get(hash) ?? 0) + 1);
  settle();
  return () => {
    const n = (wanted.get(hash) ?? 1) - 1;
    if (n > 0) wanted.set(hash, n);
    else wanted.delete(hash);
    settle();
  };
}

/** Forgets every URL and question, for a test or a window starting over. */
export function resetProjectIcons(): void {
  for (const url of Object.values(useProjectIcons.getState().urls)) revoke(url);
  useProjectIcons.setState({ urls: {} });
  api = null;
  named = new Set();
  wanted.clear();
  asking.clear();
  missing.clear();
}
