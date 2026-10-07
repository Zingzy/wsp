// SPDX-License-Identifier: AGPL-3.0-only
// A picture of the page for each thread as the person last left it, for the
// switcher cards. Only the desktop shell can take one, so a browser tab's
// wells keep the glyph, and it is never persisted: a page can hold a transcript,
// whose words belong to the machine and not to this computer's disk.
import { create } from "zustand";
import { OPEN_LAYERS } from "../keyOwners.js";
import { desktopBridge } from "../lib/desktopShell.js";

interface WorkspacePreviewsState {
  images: Readonly<Record<string, string>>;
  /** Replaces every picture at once, so this side holds exactly what the shell answered and nothing the shell has
   * since dropped at its own cap. */
  setImages: (images: Readonly<Record<string, string>>) => void;
}

export const useWorkspacePreviews = create<WorkspacePreviewsState>(set => ({
  images: {},
  setImages: images => set({ images }),
}));

/** What the shell photographs is the frame on screen, so nothing is asked for while anything is drawn over the page:
 * the layers that take the keys, and the switcher, a toast, a tooltip or a sheet, none of which do. The switcher a walk
 * ended on is still drawn when the switch lands. */
const OVER_THE_PAGE = [OPEN_LAYERS, "[data-workspace-switcher]", "[data-sonner-toast]", '[data-slot="tooltip-popup"]', '[data-slot="sheet-popup"]'].join(",");

/** The shell keys its pictures by whatever id it is handed, so each is filed under the theme it was drawn in, and a
 * picture of another theme is never read back. This side's map is keyed the same way. */
const pictureKey = (threadId: string): string => `${document.documentElement.dataset["theme"] ?? ""}/${threadId}`;

/** Asks the desktop shell to photograph the page for a thread while that thread is the one drawn: the one leaving, from
 * inside the store update that switches before React has drawn the thread arriving, or the one on screen as the
 * switcher opens, before it paints. A browser tab has no such reach and its wells keep the project's glyph. */
export async function capturePagePreview(threadId: string): Promise<void> {
  const capture = desktopBridge()?.capturePreview;
  if (capture === undefined || document.querySelector(OVER_THE_PAGE) !== null) return;
  await capture(pictureKey(threadId)).catch(() => undefined);
}

/** Reads back what the shell holds for the threads about to be drawn, in the theme drawn now, and keeps that and
 * nothing else. */
export async function loadPagePreviews(threadIds: ReadonlyArray<string>): Promise<void> {
  const read = desktopBridge()?.workspacePreview;
  if (read === undefined) return;
  const found = await Promise.all(threadIds.map(async threadId => [pictureKey(threadId), await read(pictureKey(threadId)).catch(() => undefined)] as const));
  const images: Record<string, string> = {};
  for (const [key, url] of found) if (url !== undefined) images[key] = url;
  useWorkspacePreviews.getState().setImages(images);
}

/** The pictures held for these threads in the theme drawn now, by thread: one read under another theme is not drawn,
 * however long the next read takes. */
export function picturesInTheme(images: Readonly<Record<string, string>>, threadIds: ReadonlyArray<string>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const threadId of threadIds) {
    const url = images[pictureKey(threadId)];
    if (url !== undefined) found[threadId] = url;
  }
  return found;
}
