// SPDX-License-Identifier: AGPL-3.0-only
import type { EditorMark } from "../editor.js";

/** Finder draws as a folder, as T3's Open menu draws it, the outline at the glyphs' stroke. */
export const FINDER: EditorMark = {
  id: "finder",
  editors: ["finder"],
  source: "https://github.com/lucide-icons/lucide/blob/0.564.0/icons/folder.svg",
  license: "ISC",
  svg: `<svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
};
