// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's thread tiles warm the transcripts: a tile that comes into view has its thread's head read, so a click
// on it draws the thread in the next frame, and a pointer resting on one for HOVER_MS reads its newest window too.
// One observer watches every tile under the sidebar's root, whatever renders them.
import { useEffect, type RefObject } from "react";
import { useStore } from "../../protocol/store";
import { transcripts } from "./transcripts";

const TILE = '[data-row-id^="thread:"]';
export const HOVER_MS = 60;

const threadOf = (tile: Element): string | null => {
  const id = tile.getAttribute("data-row-id");
  return id?.startsWith("thread:") === true ? id.slice("thread:".length) : null;
};

export function useWarmTiles(root: RefObject<HTMLElement | null>): void {
  const api = useStore(s => s.api);
  useEffect(() => {
    const el = root.current;
    if (el === null || api === null || !transcripts.serves() || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = threadOf(entry.target);
        if (id === null) continue;
        transcripts.see(id, entry.isIntersecting);
        if (entry.isIntersecting) transcripts.warm(id);
      }
    });
    const watched = new Set<Element>();
    const scan = (): void => {
      for (const tile of el.querySelectorAll(TILE)) {
        if (watched.has(tile)) continue;
        watched.add(tile);
        seen.observe(tile);
      }
      for (const tile of [...watched]) {
        if (tile.isConnected) continue;
        watched.delete(tile);
        seen.unobserve(tile);
        const id = threadOf(tile);
        if (id !== null) transcripts.see(id, false);
      }
    };
    scan();
    const rows = new MutationObserver(scan);
    rows.observe(el, { childList: true, subtree: true });
    let over: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOver = (event: PointerEvent): void => {
      const tile = event.target instanceof Element ? event.target.closest(TILE) : null;
      const id = tile === null ? null : threadOf(tile);
      if (id === over) return;
      over = id;
      clearTimeout(timer);
      if (id === null) return;
      timer = setTimeout(() => {
        const held = transcripts.get(id);
        if (held !== undefined) void transcripts.open(held.workspaceId, id).catch(() => {});
      }, HOVER_MS);
    };
    el.addEventListener("pointerover", onOver);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointerover", onOver);
      rows.disconnect();
      seen.disconnect();
      for (const tile of watched) {
        const id = threadOf(tile);
        if (id !== null) transcripts.see(id, false);
      }
    };
  }, [api, root]);
}
