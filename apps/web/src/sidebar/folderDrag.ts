// SPDX-License-Identifier: AGPL-3.0-only
// A folder dragged from the desktop over the window: one flag every workspace
// row reads to become a drop tile, kept as a count of the elements the drag has
// entered and not left, since the browser fires an enter on each child before
// the leave on its parent and only the last leave means the drag left the
// window. The page itself cannot read a dropped folder's path; the desktop
// shell's bridge does, so the listeners are installed only where it is there.
import { useEffect } from "react";
import { create } from "zustand";

interface FolderDragState {
  dragging: boolean;
  entered: number;
  enter(): void;
  leave(): void;
  end(): void;
}

export const useFolderDrag = create<FolderDragState>(set => ({
  dragging: false,
  entered: 0,
  enter: () => set(s => ({ entered: s.entered + 1, dragging: true })),
  leave: () =>
    set(s => {
      const entered = Math.max(0, s.entered - 1);
      return { entered, dragging: entered > 0 };
    }),
  end: () => set({ entered: 0, dragging: false }),
}));

/** Whether a drag carries files from outside the page, which is the only kind a tile takes. */
export const carriesFiles = (transfer: DataTransfer | null | undefined): boolean => Array.from(transfer?.types ?? []).includes("Files");

/** The dropped folder, or nothing when what was dropped is a file: the kind of entry is known only at the drop. */
export function droppedFolder(transfer: DataTransfer | null | undefined): File | null {
  const item = transfer?.items?.[0];
  const file = transfer?.files?.[0];
  if (item === undefined || file === undefined) return null;
  const entry = item.webkitGetAsEntry?.();
  return entry !== null && entry !== undefined && entry.isDirectory ? file : null;
}

/** Watches the window for a drag of files while `enabled`; the drop itself is each tile's to take. */
export function useWindowFolderDrag(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const { enter, leave, end } = useFolderDrag.getState();
    const transferOf = (e: Event): DataTransfer | null | undefined => (e as DragEvent).dataTransfer;
    const onEnter = (e: Event): void => {
      if (carriesFiles(transferOf(e))) enter();
    };
    const onLeave = (e: Event): void => {
      if (carriesFiles(transferOf(e))) leave();
    };
    // The window must claim the drag for a drop anywhere on it to reach a tile rather than open the file in the shell.
    const onOver = (e: Event): void => {
      if (useFolderDrag.getState().dragging) e.preventDefault();
    };
    const onDrop = (e: Event): void => {
      if (useFolderDrag.getState().dragging) e.preventDefault();
      end();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
      end();
    };
  }, [enabled]);
}
