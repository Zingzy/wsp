// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's search as a row: a glyph and the word Search, in the grammar
// of the rows under it, on the surface a selected row takes with a hairline
// round it, so it reads as a field on the same tier as the rows and not as a
// second surface. The row is the palette's door: a button whose click
// opens the command palette, which searches every thread by title and shows
// each action's chord. The palette shows no key for itself, so this row's
// tooltip names the one that opens it and the row's face stays clear.
// Nothing here filters the sidebar itself. The caller may place a glyph at
// the row's right edge, the way a section row takes a group action.
import { SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { openCommandPalette } from "../commandPaletteBus.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "../keybindingDefaults.js";
import { shortcutLabelForCommand } from "../keybindings.js";
import { TOP_ROW_CLASS } from "./rowGrammar.js";

/** The selected row's surface with the sidebar's hairline: the row tier, no fill of the field's own. */
export const SEARCH_FIELD_CLASS = "border border-sidebar-border bg-sidebar-row-selected";

const PALETTE_SHORTCUT = shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "commandPalette.toggle");
const SEARCH_TITLE = PALETTE_SHORTCUT ? `Search (${PALETTE_SHORTCUT})` : "Search";

export function SearchRow({ action }: { action?: ReactNode }) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label="Search" data-search-row="" className={cn(TOP_ROW_CLASS, SEARCH_FIELD_CLASS, action !== undefined && "pe-8")} onClick={() => openCommandPalette()}>
              <SearchIcon className="size-3.5" />
              <span>Search</span>
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="bottom">{SEARCH_TITLE}</TooltipPopup>
      </Tooltip>
      {action}
    </>
  );
}
