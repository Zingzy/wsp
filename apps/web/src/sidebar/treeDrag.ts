// SPDX-License-Identifier: AGPL-3.0-only
// A root tree dragged in the sidebar, on the browser's own drag events and with
// no React draw until the drop: that a drag is on, which tree it carries and
// which head or edge the pointer is over are attributes this writes on the
// sidebar's DOM, and the CSS beside them dims the tile, folds its tree and shows
// the empty heads. A draw at drag start was a 124 ms task with 400 threads at 4x
// CPU slowdown, and a layout change in the dragstart handler itself ends the
// drag in Chromium, whose drag needs the dragged node under the pointer after
// dragstart, so the heads show one frame later. Each attribute goes on the few
// elements whose look it changes and never on an ancestor of the list: a rule
// keyed on the sidebar's root restyled all 400 tiles, a 210 ms frame (measured).
import { useEffect, type RefObject } from "react";
import type { SidebarSection } from "./threadTree.js";
import type { OrderedSection } from "./treeOrder.js";

/** Where a drop lands: on a head (a section, its empty room, or the Settled row), or on the edge before or after one
 * root of Pinned or the list. */
export type DropPlace = { readonly kind: "head"; readonly place: SidebarSection | "settled" } | { readonly kind: "edge"; readonly section: OrderedSection; readonly rootId: string; readonly after: boolean };

/** What the sidebar does with a drop, read at the drop off its latest draw. */
export type DropTree = (rootId: string, at: DropPlace) => void;

/** The attributes the drag writes. */
export const DRAG = {
  /** On the sidebar's root, one frame after dragstart, while a tree is dragged; no rule reads it. */
  on: "data-tree-dragging",
  /** With the same frame, on each head and gap that stands only while a tree is dragged. */
  shown: "data-drop-shown",
  /** On the dragged root's item, with the same frame. */
  source: "data-drag-source",
  /** On the section or the Settled row a drop on a head would land in. */
  over: "data-drop-over",
} as const;

const ORDERED: ReadonlySet<string> = new Set<OrderedSection>(["pinned", "threads"]);

interface Dragging {
  readonly rootId: string;
  readonly item: HTMLElement;
  frame: number | null;
  at: DropPlace | null;
  over: HTMLElement | null;
}

/** A root item of Pinned or the list that a drop can land beside: a root a drag carries, a workspace's tile, a
 * group's head; never a snoozed tree at the foot, whose key the list does not sort by. */
const isEdgeRoot = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.dataset["root"] !== undefined && el.dataset["rootFixed"] === undefined;

const rootSibling = (item: HTMLElement, step: "previousElementSibling" | "nextElementSibling"): HTMLElement | null => {
  let at = item[step];
  while (at !== null && !(at instanceof HTMLElement && at.dataset["root"] !== undefined)) at = at[step];
  return at as HTMLElement | null;
};

/** The place under the pointer, read off the DOM at the moment; null where a drop would change nothing. */
function placeAt(target: EventTarget | null, y: number, drag: Dragging): DropPlace | null {
  if (!(target instanceof Element)) return null;
  if (target.closest("[data-drop-settled]") !== null) return { kind: "head", place: "settled" };
  const section = target.closest<HTMLElement>("[data-section]");
  const id = section?.dataset["section"] as SidebarSection | undefined;
  if (section == null || id === undefined) return null;
  const item = target.closest<HTMLElement>("[data-root]");
  if (!ORDERED.has(id) || target.closest("[data-section-head]") !== null || item === null || !section.contains(item)) return { kind: "head", place: id };
  if (item === drag.item) return null;
  if (!isEdgeRoot(item)) return { kind: "head", place: id };
  const head = (item.firstElementChild ?? item).getBoundingClientRect();
  const after = !(y < head.top + head.height / 2);
  // The edges on either side of the dragged tree are where it already stands.
  if (rootSibling(item, after ? "nextElementSibling" : "previousElementSibling") === drag.item) return null;
  return { kind: "edge", section: id as OrderedSection, rootId: item.dataset["root"]!, after };
}

const samePlace = (a: DropPlace | null, b: DropPlace | null): boolean =>
  a === b || (a !== null && b !== null && (a.kind === "head" ? b.kind === "head" && a.place === b.place : b.kind === "edge" && a.section === b.section && a.rootId === b.rootId && a.after === b.after));

/** The scrolling box the list stands in. */
const scrollerOf = (el: HTMLElement): HTMLElement | null => el.closest<HTMLElement>("[data-slot=scroll-area-viewport]");

/** Drives the drag over the sidebar `rootRef` holds. The tree list there carries the one drop line as
 * `[data-drop-line]`, positioned against the list `[data-sidebar-tree]`; each root item carries `data-root` with its
 * id, its tile is `draggable` where the tree moves, and the Settled row's item carries `data-drop-settled`. A head
 * that stands only while a tree is dragged carries `data-drop-only`, and a gap that does `data-drop-gap`. */
export function useTreeDrag(rootRef: RefObject<HTMLElement | null>, drop: RefObject<DropTree>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    let drag: Dragging | null = null;
    const line = (): HTMLElement | null => root.querySelector<HTMLElement>("[data-drop-line]");
    const show = (d: Dragging, at: DropPlace | null): void => {
      if (samePlace(d.at, at)) return;
      d.at = at;
      d.over?.removeAttribute(DRAG.over);
      d.over = null;
      const mark = line();
      if (at?.kind === "head") {
        d.over = at.place === "settled" ? root.querySelector<HTMLElement>("[data-drop-settled]") : root.querySelector<HTMLElement>(`[data-section="${at.place}"]`);
        d.over?.setAttribute(DRAG.over, "");
      }
      if (mark === null) return;
      const item = at?.kind === "edge" ? ([...root.querySelectorAll<HTMLElement>(`[data-section="${at.section}"] [data-root]`)].find(el => el.dataset["root"] === at.rootId) ?? null) : null;
      const list = mark.parentElement;
      if (at?.kind !== "edge" || item === null || list === null) {
        mark.hidden = true;
        return;
      }
      const box = item.getBoundingClientRect();
      mark.style.top = `${(at.after ? box.bottom : box.top) - list.getBoundingClientRect().top - 1}px`;
      mark.hidden = false;
    };
    const end = (): void => {
      if (drag === null) return;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      show(drag, null);
      drag.item.removeAttribute(DRAG.source);
      for (const el of root.querySelectorAll(`[${DRAG.shown}]`)) el.removeAttribute(DRAG.shown);
      root.removeAttribute(DRAG.on);
      drag = null;
    };
    const onStart = (e: DragEvent): void => {
      const tile = e.target instanceof Element ? e.target.closest<HTMLElement>('[draggable="true"]') : null;
      const item = tile?.closest("li");
      if (tile == null || !(item instanceof HTMLElement) || item.dataset["root"] === undefined) return;
      end();
      const title = item.querySelector("[data-thread-title], [data-attempt-title]")?.textContent ?? "";
      e.dataTransfer?.setData("text/plain", title);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      const d: Dragging = { rootId: item.dataset["root"]!, item, frame: null, at: null, over: null };
      drag = d;
      d.frame = requestAnimationFrame(() => {
        d.frame = null;
        if (drag !== d) return;
        const head = item.firstElementChild ?? item;
        const before = head.getBoundingClientRect().top;
        root.setAttribute(DRAG.on, "");
        for (const el of root.querySelectorAll("[data-drop-only], [data-drop-gap]")) el.setAttribute(DRAG.shown, "");
        item.setAttribute(DRAG.source, "");
        // The heads that show over the tile push it down; the list scrolls by as much, so it stays under the pointer.
        const moved = head.getBoundingClientRect().top - before;
        const scroller = scrollerOf(item);
        if (moved !== 0 && scroller !== null) scroller.scrollTop += moved;
      });
    };
    const onOver = (e: DragEvent): void => {
      if (drag === null) return;
      const at = placeAt(e.target, e.clientY, drag);
      show(drag, at);
      if (at === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    };
    const onDrop = (e: DragEvent): void => {
      if (drag === null) return;
      e.preventDefault();
      const at = placeAt(e.target, e.clientY, drag);
      const { rootId } = drag;
      end();
      if (at !== null) drop.current(rootId, at);
    };
    root.addEventListener("dragstart", onStart);
    root.addEventListener("dragenter", onOver);
    root.addEventListener("dragover", onOver);
    root.addEventListener("drop", onDrop);
    root.addEventListener("dragend", end);
    return () => {
      end();
      root.removeEventListener("dragstart", onStart);
      root.removeEventListener("dragenter", onOver);
      root.removeEventListener("dragover", onOver);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("dragend", end);
    };
  }, [rootRef, drop]);
}
