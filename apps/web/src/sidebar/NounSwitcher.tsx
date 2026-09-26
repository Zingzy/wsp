// SPDX-License-Identifier: AGPL-3.0-only
// One filter at the head of the sidebar, shared by the projects and the
// computers: a row naming "All ..." or the one row picked, and under it a
// menu on the app's popover primitive with a search field, "All ...", one row
// per thing with its gear and "Add a ..." at its foot. Picking filters what
// the list under it shows and nothing else. With nothing to pick the head is
// held.
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, SettingsIcon, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { cn, normalizeSearchText } from "../lib/utils.js";
import { GLYPH_ROW_CLASS, ONE_LINE_ROW_CLASS, ROW_META_CLASS } from "./rowGrammar.js";

export interface SwitcherWords {
  readonly all: string;
  readonly search: string;
  readonly add: string;
  /** The listbox's name for a screen reader. */
  readonly list: string;
  readonly settingsOf: (name: string) => string;
}

/** One thing the menu can pick, with the glyph it draws in the menu and in the head once picked. */
export interface SwitcherRow {
  readonly id: string;
  readonly name: string;
  readonly meta: string | null;
  readonly glyph: ReactNode;
}

/** One row of the menu: a thing, or the pick that shows them all, whose id is null. */
type Option = Omit<SwitcherRow, "id"> & { readonly id: string | null };

const MENU_ROW_CLASS = "group/option flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[var(--control-radius)] px-2 text-left text-sm text-foreground outline-none";

/** The rows the menu lists for a query: "All ..." always, then every row whose name holds the typed text, case aside. */
function switcherOptions(rows: ReadonlyArray<SwitcherRow>, words: Pick<SwitcherWords, "all">, allGlyph: ReactNode, query: string): Option[] {
  const q = normalizeSearchText(query);
  return [{ id: null, name: words.all, meta: null, glyph: allGlyph }, ...rows.filter(row => q === "" || normalizeSearchText(row.name).includes(q))];
}

export function NounSwitcher({
  noun,
  words,
  AllGlyph,
  rows,
  pick,
  onPick,
  onAdd,
  onSettings,
  action,
  onContextMenu,
}: {
  /** What the head, its menu and their rows are keyed by in the page, "project" or "computer". */
  noun: string;
  words: SwitcherWords;
  AllGlyph: LucideIcon;
  rows: ReadonlyArray<SwitcherRow>;
  /** The row the list is filtered to, or null for every row. */
  pick: SwitcherRow | null;
  onPick: (id: string | null) => void;
  onAdd: () => void;
  onSettings: (id: string) => void;
  /** A glyph the head shows on hover beside its chevron, with its room kept at rest so nothing moves. */
  action?: ReactNode;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const headRef = useRef<HTMLButtonElement>(null);
  const options = useMemo(() => switcherOptions(rows, words, <AllGlyph className="size-4 shrink-0 text-muted-foreground" aria-hidden />, query), [rows, words, AllGlyph, query]);
  /** The last row the keys reach: "Add a ...", after the options. */
  const last = options.length;
  const held = rows.length === 0;
  /** The id of one menu row, which the field names as its active descendant while the keys are on it. */
  const optionId = (id: string | null): string => `${noun}-switcher-option-${id ?? "all"}`;
  const addRowId = `${noun}-switcher-option-add`;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    headRef.current?.focus();
  };
  const choose = (option: Option): void => {
    onPick(option.id);
    close();
  };
  const add = (): void => {
    close();
    onAdd();
  };

  // Every key the menu takes stops here: the popup is a portal under the sidebar's own key handler, which would
  // otherwise walk the tree rows on the same ArrowDown.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setActive(at => (at + (event.key === "ArrowDown" ? 1 : last)) % (last + 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const option = options[active];
      if (option !== undefined) choose(option);
      else add();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  // The head's own ArrowDown opens the menu and goes no further: the rows under it walk on the same key.
  const onHeadKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "ArrowDown" || held) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  return (
    <Popover open={open} onOpenChange={next => setOpen(next && !held)}>
      <div className="group/menu-item relative" {...(onContextMenu === undefined ? {} : { onContextMenu })}>
        <PopoverTrigger
          ref={headRef}
          render={<SidebarMenuButton size="sm" />}
          data-k={`${noun}-switcher`}
          aria-haspopup="listbox"
          aria-expanded={open}
          disabled={held}
          className={cn(ONE_LINE_ROW_CLASS, GLYPH_ROW_CLASS)}
          onKeyDown={onHeadKeyDown}
        >
          {pick === null ? <AllGlyph className="size-4" /> : pick.glyph}
          <span data-switcher-name className="min-w-0 flex-1 truncate">
            {pick?.name ?? words.all}
          </span>
          {pick?.meta == null ? null : (
            <span data-switcher-meta className={cn(ROW_META_CLASS, "shrink-0")}>
              {pick.meta}
            </span>
          )}
          {action === undefined ? null : <span aria-hidden data-switcher-plus-room className="w-5 shrink-0" />}
          <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 transition-transform duration-150", open && "rotate-180")} />
        </PopoverTrigger>
        {action}
      </div>
      <PopoverPopup
        align="start"
        side="bottom"
        sideOffset={4}
        className="w-(--anchor-width) p-0 transition-[opacity,translate] duration-150 data-starting-style:scale-100 data-starting-style:-translate-y-0.5"
        viewportClassName="p-0 [--viewport-inline-padding:0]"
      >
        <div {...{ [`data-${noun}-switcher-menu`]: "" }} className="flex flex-col" onKeyDown={onMenuKeyDown}>
          <label className="flex h-8 items-center gap-2 border-b border-border px-3">
            <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setActive(0);
              }}
              placeholder={words.search}
              aria-label={words.search}
              aria-activedescendant={active === last ? addRowId : optionId(options[active]?.id ?? null)}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-placeholder"
              data-switcher-search
            />
          </label>
          <div role="listbox" aria-label={words.list} className="flex flex-col p-1">
            {options.map((option, index) => (
              <div
                key={option.id ?? "all"}
                id={optionId(option.id)}
                role="option"
                aria-selected={(pick?.id ?? null) === option.id}
                data-switcher-option={option.id ?? "all"}
                data-active={index === active || undefined}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(MENU_ROW_CLASS, index === active && "bg-accent text-accent-foreground")}
              >
                {option.glyph}
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.meta === null ? null : <span className={cn(ROW_META_CLASS, "shrink-0")}>{option.meta}</span>}
                {(pick?.id ?? null) === option.id ? <CheckIcon aria-hidden className="size-4 shrink-0" /> : null}
                {option.id === null ? null : (
                  <button
                    type="button"
                    data-k={`${noun}-settings`}
                    aria-label={words.settingsOf(option.name)}
                    onClick={event => {
                      event.stopPropagation();
                      setOpen(false);
                      onSettings(option.id!);
                    }}
                    className="-mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-background/60 hover:text-foreground"
                  >
                    <SettingsIcon className="size-4" aria-hidden />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="border-t border-border p-1">
            <button
              type="button"
              id={addRowId}
              data-k={`add-${noun}-row`}
              data-active={active === last || undefined}
              onMouseEnter={() => setActive(last)}
              onClick={add}
              className={cn(MENU_ROW_CLASS, active === last && "bg-accent text-accent-foreground")}
            >
              <PlusIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{words.add}</span>
            </button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
