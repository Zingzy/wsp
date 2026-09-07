// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's search as a row: a glyph, the word Search and the palette's
// chord, in the grammar of the rows under it. The row is the palette's door:
// a button whose click opens the command palette, which searches every thread
// by title. Nothing here filters the sidebar itself.
import { SearchIcon } from "lucide-react";
import { openCommandPalette } from "../commandPaletteBus.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";

/** The grammar the search row and the section rows share: the workspace rows' inset, a 150 ms hover. */
export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";
/** The muted mono meta a top row carries at its right: the search row's chord, a shut section row's count. */
export const TOP_ROW_META_CLASS = "font-mono text-[11px] text-muted-foreground/55";
const PALETTE_SHORTCUT = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "commandPalette.toggle");

export function SearchRow() {
  return (
    <SidebarMenuButton
      aria-label="Search"
      className={TOP_ROW_CLASS}
      onClick={() => openCommandPalette()}
    >
      <SearchIcon className="size-3.5" />
      <span>Search</span>
      {PALETTE_SHORTCUT !== null ? <kbd className={cn("ms-auto", TOP_ROW_META_CLASS)}>{PALETTE_SHORTCUT}</kbd> : null}
    </SidebarMenuButton>
  );
}
