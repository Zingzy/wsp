// SPDX-License-Identifier: AGPL-3.0-only
// What a workspace looked like when the person last left it, for the switcher
// cards. Two halves: the last line of the thread that was open, which the
// chat view records as it draws it and every shell has, and a picture of the
// page, which only the desktop shell can take. Neither is persisted: a
// transcript's words belong to the machine, not to this computer's disk.
import { create } from "zustand";
import { desktopBridge } from "../lib/desktopShell.js";

/** The last line the chat showed, under the thread it came from: a card drops it once another thread is open. */
export interface WorkspaceLine {
  readonly threadKey: string;
  readonly text: string;
}

interface WorkspacePreviewsState {
  lines: Readonly<Record<string, WorkspaceLine>>;
  images: Readonly<Record<string, string>>;
  noteLine: (workspaceId: string, line: WorkspaceLine) => void;
  /** Replaces every picture at once, so this side holds exactly what the shell answered and nothing the shell has
   * since dropped at its own cap. */
  setImages: (images: Readonly<Record<string, string>>) => void;
}

export const useWorkspacePreviews = create<WorkspacePreviewsState>(set => ({
  lines: {},
  images: {},
  noteLine: (workspaceId, line) =>
    set(s => {
      // A streaming turn redraws its last line on every delta; only a line that actually changed may wake a reader.
      const held = s.lines[workspaceId];
      if (held?.threadKey === line.threadKey && held.text === line.text) return s;
      return { lines: { ...s.lines, [workspaceId]: line } };
    }),
  setImages: images => set({ images }),
}));

/** Asks the desktop shell to photograph the page for the workspace being left. It is asked for from inside the
 * store update that switches, before React has drawn the workspace arriving, so the picture is of the one leaving.
 * A browser tab has no such reach and its cards stay text. */
export function capturePagePreview(workspaceId: string): void {
  const capture = desktopBridge()?.capturePreview;
  if (capture === undefined) return;
  void capture(workspaceId).catch(() => undefined);
}

/** Reads back what the shell holds for the workspaces about to be drawn, and keeps that and nothing else. */
export async function loadPagePreviews(workspaceIds: ReadonlyArray<string>): Promise<void> {
  const read = desktopBridge()?.workspacePreview;
  if (read === undefined) return;
  const found = await Promise.all(
    workspaceIds.map(async workspaceId => [workspaceId, await read(workspaceId).catch(() => undefined)] as const),
  );
  const images: Record<string, string> = {};
  for (const [workspaceId, url] of found) if (url !== undefined) images[workspaceId] = url;
  useWorkspacePreviews.getState().setImages(images);
}
