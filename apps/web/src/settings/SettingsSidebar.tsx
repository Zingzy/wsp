// SPDX-License-Identifier: AGPL-3.0-only
// The settings sidebar, in the app sidebar's place while Settings is open: the
// frame row, a search field, one 28 px row per group with the open one lifted,
// under a group that lists nouns one row per noun, each a page of its own and
// each standing whether its group is open or not, and Back at the foot, which
// closes Settings as Escape does. Typing in the field filters every group's
// rows; a group with no match dims, and at a phone's width the field's results
// replace the group list in the sheet, a tap opening the row's page and
// shutting the sheet. ArrowUp and ArrowDown walk the rows in visual order, as
// the workspace sidebar's do.
import { ProjectGlyph } from "../projects/look.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Input } from "../components/ui/input.js";
import { SidebarContent, SidebarMenuButton, useSidebar } from "../components/ui/sidebar.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { resolveAdjacentThreadId } from "../sidebar/Sidebar.logic.js";
import { FOOT_ROW_CLASS, ONE_LINE_ROW_CLASS, ROW_META_CLASS } from "../sidebar/rowGrammar.js";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome.js";
import { SETTINGS_WORDS } from "./format.js";
import { drawnGroups, searchGroup, type SettingsGroup } from "./groups.js";
import type { SettingsItem } from "./rows.js";
import { useSettingsAt, useSettingsContext } from "./settingsContext.js";
import { atId, groupOf, sameAt, useSettingsStore, type SettingsAt } from "./settingsStore.js";

/** How far a row with no match for the typed text stands back. Opacity, not another ink: the sidebar's rest ink
 * is darker than its muted ink on the dark side, so dimming by ink read brighter there and did nothing on light. */
const DIMMED = "opacity-50";

/** A computer's own icon on its row, off the places list the row was made from. */
function SubComputerGlyph({ id }: { id: string }) {
  const place = useStore(s => s.places.find(p => p.id === id));
  return place === undefined ? null : <ComputerGlyph place={place} />;
}

/** The page's sections in view now: each top-level card the settings page draws, watched as it scrolls, so the
 * sidebar's trail lights the ones a person is looking at. */
function useCardsInView(page: string): ReadonlySet<string> {
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const root = document.querySelector("[data-settings-page]");
    if (root === null || typeof IntersectionObserver === "undefined") return;
    const showing = new Set<string>();
    const watch = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset["settingsCard"];
        if (id === undefined) continue;
        if (entry.isIntersecting) showing.add(id);
        else showing.delete(id);
      }
      setSeen(new Set(showing));
    });
    const observe = (): void => {
      watch.disconnect();
      showing.clear();
      for (const card of root.querySelectorAll(":scope > section[data-settings-card]")) watch.observe(card);
    };
    observe();
    const drawn = new MutationObserver(observe);
    drawn.observe(root, { childList: true });
    return () => {
      watch.disconnect();
      drawn.disconnect();
    };
  }, [page]);
  return seen;
}

/** Scrolls the page to one of its sections, at once under reduced motion. */
function revealSection(id: string): void {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  document.querySelector(`[data-settings-page] > section[data-settings-card="${id}"]`)?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
}

/** Brings the row a search result names into view once its page is drawn. */
function revealItem(id: string): void {
  let tries = 0;
  const look = (): void => {
    const found = document.querySelector(`[data-settings-row="${id}"], [data-settings-line="${id}"]`);
    if (found !== null) {
      found.scrollIntoView({ block: "center" });
      // The row a result named flashes once, so the eye lands on it.
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== true) found.animate?.([{ backgroundColor: "color-mix(in srgb, var(--foreground) 9%, transparent)" }, { backgroundColor: "transparent" }], { duration: 900, easing: "ease-out" });
    }
    else if (tries++ < 10) window.requestAnimationFrame(look);
  };
  window.requestAnimationFrame(look);
}

export function SettingsSidebar() {
  const ctx = useSettingsContext();
  const at = useSettingsAt();
  const search = useSettingsStore(s => s.search);
  const setSearch = useSettingsStore(s => s.setSearch);
  const closeSettings = useStore(s => s.closeSettings);
  const { isMobile, setOpenMobile } = useSidebar();
  const rootRef = useRef<HTMLDivElement>(null);
  const groups = drawnGroups();
  const openGroup = groupOf(at);
  const inView = useCardsInView(atId(at));
  const matches = search === "" ? null : new Map(groups.map(group => [group.id, searchGroup(group, ctx, search)] as const));
  // While the results stand in the centre no row is the page, so none is lifted; on the phone the results are in
  // this sheet and the centre keeps the page it was on, which stays lifted.
  const lifting = matches === null || isMobile;

  const go = (next: SettingsAt): void => {
    ctx.go(next);
    if (isMobile) setOpenMobile(false);
  };
  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Escape") return;
    // The dispatcher closes Settings on any Escape not already taken, so the field takes the ones that are its own:
    // a clear while it holds text, and on the phone's sheet a shut of the sheet.
    if (search !== "") {
      event.preventDefault();
      setSearch("");
    } else if (isMobile) {
      event.preventDefault();
      setOpenMobile(false);
    }
  };

  const rows = (): HTMLElement[] => Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []);
  const focusRow = (id: string | null): void => {
    if (id === null) return;
    rows().find(r => r.dataset["rowId"] === id)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target instanceof HTMLInputElement && e.key !== "ArrowDown") return;
    const ids = rows().map(r => r.dataset["rowId"] ?? "");
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-sidebar-row]")?.dataset["rowId"] ?? null;
    switch (e.key) {
      case "ArrowDown":
        focusRow(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: current, direction: "next" }) ?? current);
        break;
      case "ArrowUp":
        if (current === null) return;
        focusRow(resolveAdjacentThreadId({ threadIds: ids, currentThreadId: current, direction: "previous" }) ?? current);
        break;
      case "Home":
        if (current === null) return;
        focusRow(ids[0] ?? null);
        break;
      case "End":
        if (current === null) return;
        focusRow(ids.at(-1) ?? null);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const header = (
    <div data-settings-search className="flex flex-col px-[var(--sidebar-content-inset)] pt-3 pb-1">
      <label className="flex h-7 items-center gap-2 border-b border-sidebar-border px-2">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        <Input
          unstyled
          nativeInput
          size="compact"
          data-k="settings-search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          onKeyDown={onFieldKeyDown}
          placeholder={SETTINGS_WORDS.search}
          aria-label={SETTINGS_WORDS.search}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 [&_input]:bg-transparent [&_input]:px-0 [&_input]:text-[13px] [&_input]:text-sidebar-foreground [&_input]:placeholder:text-sidebar-muted-foreground"
        />
      </label>
    </div>
  );

  const groupRow = (group: SettingsGroup): React.JSX.Element => {
    const groupAt: SettingsAt = { kind: "group", group: group.id };
    const open = openGroup === group.id;
    const dimmed = matches !== null && (matches.get(group.id)?.length ?? 0) === 0;
    const Glyph = group.glyph;
    // A group's pages stand only while it is open: computers and projects grow without bound, and listing them all
    // under a closed group buried every group below.
    const under = open ? (group.sub?.(ctx) ?? []) : [];
    // A page with no pages under it lists its own sections instead, lit while they are on screen.
    const trail = open && under.length === 0 && matches === null && at.kind === "group" ? group.cards(ctx).filter((card): card is typeof card & { head: string } => card.head !== undefined) : [];
    const meta = group.meta?.(ctx);
    return (
      <li key={group.id} className="flex flex-col">
        <SidebarMenuButton
          size="sm"
          isActive={lifting && sameAt(at, groupAt)}
          data-sidebar-row
          data-row-id={`group:${group.id}`}
          data-k={`settings-${group.id}`}
          data-depth={0}
          {...(dimmed ? { "data-dimmed": "" } : {})}
          onClick={() => go(groupAt)}
          // The group whose page is a sub-page reads in the foreground ink without a fill; a group with no match
          // for the typed text stands back by DIMMED, never by another ink.
          className={cn(ONE_LINE_ROW_CLASS, open && !sameAt(at, groupAt) && "text-sidebar-foreground", dimmed && DIMMED)}
        >
          <Glyph className="size-4" />
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
          {meta === undefined ? null : (
            <span data-settings-meta className={cn(ROW_META_CLASS, "shrink-0")}>
              {meta}
            </span>
          )}
        </SidebarMenuButton>
        {trail.length === 0 ? null : (
          <ul data-k="settings-trail" className="ml-[14px] flex min-w-0 flex-col">
            {trail.map(card => (
              <li key={card.id}>
                <SidebarMenuButton
                  size="sm"
                  data-sidebar-row
                  data-row-id={`section:${card.id}`}
                  data-depth={1}
                  {...(inView.has(card.id) ? { "data-in-view": "" } : {})}
                  onClick={() => revealSection(card.id)}
                  className={cn(ONE_LINE_ROW_CLASS, "transition-colors duration-150", inView.has(card.id) ? "text-sidebar-foreground" : "text-sidebar-muted-foreground")}
                >
                  <span className="min-w-0 flex-1 truncate">{card.head}</span>
                </SidebarMenuButton>
              </li>
            ))}
          </ul>
        )}
        {under.length === 0 ? null : (
          <ul className="ml-[14px] flex min-w-0 flex-col">
            {under.map(sub => (
              <li key={atId(sub.at)}>
                {/* A sub-row dims with its group: lit under a dimmed head it reads as the one thing that matched. */}
                <SidebarMenuButton size="sm" isActive={lifting && sameAt(at, sub.at)} data-sidebar-row data-row-id={atId(sub.at)} data-depth={1} {...(dimmed ? { "data-dimmed": "" } : {})} onClick={() => go(sub.at)} className={cn(ONE_LINE_ROW_CLASS, dimmed && DIMMED)}>
                  {sub.at.kind === "project" ? <ProjectGlyph projectId={sub.at.id} /> : null}
                  {sub.at.kind === "computer" ? <SubComputerGlyph id={sub.at.id} /> : null}
                  {/* Held in a span, so the row's rule that greys a bare icon leaves the agent's own inks alone. */}
                  {sub.at.kind === "agent" ? (
                    <span className="flex shrink-0">
                      <HarnessMark harness={sub.at.id} label={sub.name} className="size-4" />
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">{sub.name}</span>
                </SidebarMenuButton>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  /** At a phone's width the results stand in the sheet: the matching titles, one row each under their group. */
  const resultRows = (): React.JSX.Element[] =>
    groups.flatMap(group => {
      const items = matches?.get(group.id) ?? [];
      if (items.length === 0) return [];
      const title = (item: SettingsItem): string => (item.kind === "row" ? item.title : item.label);
      return [
        <li key={group.id} className="flex flex-col">
          <span className="flex h-7 items-center px-2 text-[13px] text-sidebar-muted-foreground">{group.name}</span>
          <ul className="ml-[14px] flex min-w-0 flex-col">
            {items.map(item => (
              <li key={item.id}>
                <SidebarMenuButton
                  size="sm"
                  data-sidebar-row
                  data-row-id={`result:${group.id}:${item.id}`}
                  data-depth={1}
                  onClick={() => {
                    go({ kind: "group", group: group.id });
                    revealItem(item.id);
                  }}
                  className={ONE_LINE_ROW_CLASS}
                >
                  <span className="min-w-0 flex-1 truncate">{title(item)}</span>
                </SidebarMenuButton>
              </li>
            ))}
          </ul>
        </li>,
      ];
    });

  return (
    <>
      <SidebarChromeHeader />
      <div ref={rootRef} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col">
        <SidebarContent fixedHeader={header}>
          <ul data-settings-groups className="flex w-full min-w-0 flex-col gap-1 px-[var(--sidebar-content-inset)] pt-1">
            {isMobile && matches !== null ? resultRows() : groups.map(groupRow)}
          </ul>
        </SidebarContent>
        <SidebarChromeFooter>
          <div className="px-1">
            <button type="button" data-k="settings-back" onClick={closeSettings} className={FOOT_ROW_CLASS}>
              <ArrowLeftIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{SETTINGS_WORDS.back}</span>
              <span className={cn(ROW_META_CLASS, "shrink-0")}>esc</span>
            </button>
          </div>
        </SidebarChromeFooter>
      </div>
    </>
  );
}
