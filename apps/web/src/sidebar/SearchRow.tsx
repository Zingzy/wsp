// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's search as a row: a glyph and the word Search, in the grammar
// of the rows under it, with no border and no fill of its own, so it reads as
// a row and not as a field. The row is the palette's door: a button
// whose click opens the command palette, which searches every thread by title
// and shows each action's chord. The palette shows no key for itself, so this
// row's tooltip names the one that opens it and the row's face stays clear.
// Nothing here filters the sidebar itself.
import { SearchIcon } from "lucide-react";
import { openCommandPalette } from "../commandPaletteBus.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useShortcutLabel } from "../shell/useKeybindings.js";
import { ONE_LINE_ROW_CLASS } from "./rowGrammar.js";

export function SearchRow() {
  const paletteShortcut = useShortcutLabel("commandPalette.toggle");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton size="sm" aria-label="Search" data-search-row="" className={ONE_LINE_ROW_CLASS} onClick={() => openCommandPalette()}>
            <SearchIcon className="size-4" />
            <span>Search</span>
          </SidebarMenuButton>
        }
      />
      <TooltipPopup side="bottom">{paletteShortcut === null ? "Search" : `Search (${paletteShortcut})`}</TooltipPopup>
    </Tooltip>
  );
}
