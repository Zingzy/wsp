// SPDX-License-Identifier: AGPL-3.0-only
// A picture of the page for each thread as the person last left it, for the
// switcher cards. Only the desktop shell can take one, so a browser tab's
// wells keep the glyph, and it is never persisted: a page can hold a transcript,
// whose words belong to the machine and not to this computer's disk.
import { create } from "zustand";
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

/** Asks the desktop shell to photograph the page for the thread being left. It is asked for from inside the store
 * update that switches, before React has drawn the thread arriving, so the picture is of the one leaving. A browser
 * tab has no such reach and its wells keep the project's glyph. The shell keys its pictures by whatever id it is
 * handed. */
export function capturePagePreview(threadId: string): void {
  const capture = desktopBridge()?.capturePreview;
  if (capture === undefined) return;
  void capture(threadId).catch(() => undefined);
}

/** Reads back what the shell holds for the threads about to be drawn, and keeps that and nothing else. */
export async function loadPagePreviews(threadIds: ReadonlyArray<string>): Promise<void> {
  const read = desktopBridge()?.workspacePreview;
  if (read === undefined) return;
  const found = await Promise.all(threadIds.map(async threadId => [threadId, await read(threadId).catch(() => undefined)] as const));
  const images: Record<string, string> = {};
  for (const [threadId, url] of found) if (url !== undefined) images[threadId] = url;
  useWorkspacePreviews.getState().setImages(images);
}
