// SPDX-License-Identifier: AGPL-3.0-only
// New thread as a person finds it: the sidebar's first row, with the word and
// its chord on its face, and the pencil glyph the header holds beside the
// sidebar toggle wherever the sidebar is away (collapsed, a phone's closed
// sheet, Settings). Both open New thread on its project, or ask for one where
// the person asked to pick every time, and both are held while there is no
// project to open one on: aria-disabled rather than the disabled attribute, so
// the pointer still reaches the tooltip that says what it is.
import { SquarePenIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { openNewThread } from "../shell/NewThreadPicks.js";
import { useShortcutLabel } from "../shell/useKeybindings.js";
import { ONE_LINE_ROW_CLASS, ROW_META_CLASS } from "./rowGrammar.js";
import { NEW_WORKSPACE } from "./words.js";
import { newThreadTitle } from "./workspaceRows.js";

const HELD_CLASS = "aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent";

export function NewThreadRow() {
  const shortcut = useShortcutLabel("chat.new");
  const held = useStore(s => s.projects.length === 0);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton size="sm" data-new-thread-row="" aria-label={NEW_WORKSPACE} aria-disabled={held || undefined} className={cn(ONE_LINE_ROW_CLASS, HELD_CLASS)} onClick={openNewThread}>
            <SquarePenIcon className="size-4" />
            <span className="min-w-0 flex-1 truncate">{NEW_WORKSPACE}</span>
            {/* A phone has no keyboard to press it on. */}
            {shortcut === null ? null : <span data-new-thread-chord className={cn(ROW_META_CLASS, "shrink-0 max-md:hidden")}>{shortcut}</span>}
          </SidebarMenuButton>
        }
      />
      <TooltipPopup side="bottom">{newThreadTitle(shortcut)}</TooltipPopup>
    </Tooltip>
  );
}

export function NewThreadGlyph() {
  const shortcut = useShortcutLabel("chat.new");
  const held = useStore(s => s.projects.length === 0);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            data-new-thread-glyph=""
            aria-label={NEW_WORKSPACE}
            aria-disabled={held || undefined}
            className={cn("size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]", HELD_CLASS)}
            onClick={openNewThread}
          />
        }
      >
        <SquarePenIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{newThreadTitle(shortcut)}</TooltipPopup>
    </Tooltip>
  );
}
