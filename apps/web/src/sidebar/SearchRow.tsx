// SPDX-License-Identifier: AGPL-3.0-only
// The sidebar's search as a row: a glyph and the word Search, in the grammar
// of the rows under it. Focus or a click swaps the row for the field at the
// same height, so nothing under it moves; Escape, or leaving an empty field,
// swaps it back. A field with a query stays: the list is filtered and the
// field says why. The caller may place a glyph at the row's right edge, the
// way a section row takes a group action.
import { SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";

/** The grammar the search row and the Workspaces row share: one height, the workspace rows' inset, a 150 ms hover. */
export const TOP_ROW_CLASS = "px-2 transition-[background-color,color] duration-150";

export function SearchRow({ query, onQueryChange, action }: { query: string; onQueryChange: (query: string) => void; action?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef(false);
  const showField = open || query.length > 0;

  useEffect(() => {
    if (showField) fieldRef.current?.focus();
    else if (restoreFocus.current) {
      // Focus comes back to the row without reopening the field it just left.
      rowRef.current?.focus();
      restoreFocus.current = false;
    }
  }, [showField]);

  const close = (): void => {
    restoreFocus.current = true;
    setOpen(false);
    onQueryChange("");
  };

  if (!showField) {
    return (
      <>
        <SidebarMenuButton
          ref={rowRef}
          aria-label="Search threads"
          className={cn(TOP_ROW_CLASS, action !== undefined && "pe-8")}
          onClick={() => setOpen(true)}
          onFocus={() => {
            if (!restoreFocus.current) setOpen(true);
          }}
        >
          <SearchIcon className="size-3.5" />
          <span>Search</span>
        </SidebarMenuButton>
        {action}
      </>
    );
  }
  return (
    <SidebarMenuButton
      render={<div />}
      data-sidebar-search
      className={cn(TOP_ROW_CLASS, "bg-sidebar-row-hover text-sidebar-foreground")}
      onMouseDown={e => {
        // A press on the glyph or the padding would move focus off the input and shut the empty field.
        if (e.target !== fieldRef.current) e.preventDefault();
      }}
    >
      <SearchIcon className="size-3.5" />
      <input
        ref={fieldRef}
        type="search"
        aria-label="Search threads"
        placeholder="Search"
        value={query}
        onChange={e => onQueryChange(e.target.value)}
        onBlur={() => {
          if (query.length === 0) setOpen(false);
        }}
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-sm font-medium text-sidebar-foreground outline-hidden placeholder:text-sidebar-muted-foreground/80 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
      />
    </SidebarMenuButton>
  );
}
