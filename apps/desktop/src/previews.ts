// SPDX-License-Identifier: AGPL-3.0-only
// The page as a picture, one per workspace, held only in this process's
// memory: nothing is written to disk, since a workspace's page can hold a
// transcript. A capture replaces what that workspace held, and the oldest
// leaves once the cap is reached, so a long session cannot grow without end.
const PREVIEW_WIDTH = 480;
const PREVIEW_CAP = 12;
/** The page waits for its capture before it draws the switcher, so a capture answers within this whatever Electron
 * does: capturePage has been seen never to settle. One that lands later is dropped, since the page may have drawn
 * over itself by then. */
const CAPTURE_CEILING_MS = 500;

/** The part of Electron's NativeImage this needs; a fake stands in for it under test. */
export interface PageImage {
  resize(options: { width: number }): PageImage;
  toDataURL(): string;
}

/** The part of a WebContents this needs. */
export interface CapturablePage {
  capturePage(): Promise<PageImage>;
}

export interface PagePreviews {
  capture(workspaceId: string, page: CapturablePage): Promise<void>;
  get(workspaceId: string): string | undefined;
}

export function pagePreviews(width = PREVIEW_WIDTH, cap = PREVIEW_CAP, ceilingMs = CAPTURE_CEILING_MS): PagePreviews {
  const byWorkspaceId = new Map<string, string>();
  return {
    async capture(workspaceId, page) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ceiling = new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), ceilingMs);
      });
      const image = await Promise.race([page.capturePage(), ceiling]).finally(() => clearTimeout(timer));
      if (image === null) return;
      const url = image.resize({ width }).toDataURL();
      byWorkspaceId.delete(workspaceId);
      byWorkspaceId.set(workspaceId, url);
      for (const oldest of byWorkspaceId.keys()) {
        if (byWorkspaceId.size <= cap) break;
        byWorkspaceId.delete(oldest);
      }
    },
    get: workspaceId => byWorkspaceId.get(workspaceId),
  };
}
