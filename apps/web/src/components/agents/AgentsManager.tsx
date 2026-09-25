// SPDX-License-Identifier: AGPL-3.0-only
// The agents, MCP servers and skills on one computer or for one task, drawn
// by two hosts: a task's right panel and a computer's page in Settings. A
// head says whose they are, the tabs pick a kind, one toolbar searches,
// groups and adds, and the list stands in groups with no rules between rows.
// A row opens its detail in place of the list, with Back; a kind may add a
// level of rows under the detail and one row's own level under that. Every
// kind is a registered module, so this file never names one. Its root is the
// container every width rule reads.
import { ListFilterIcon, PlusIcon, RefreshCwIcon, SearchIcon, SlidersHorizontalIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { offlineFor, type AgentsReport } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { Button } from "../ui/button.js";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group.js";
import { Menu, MenuGroup, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu.js";
import { SegmentedControl } from "../ui/segmented-control.js";
import { Skeleton } from "../ui/skeleton.js";
import { Spinner } from "../ui/spinner.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip.js";
import { ActButton } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W, editImageAct, heldReason, notYet, onImage, pausedReport, refusedLines, type RefusedLine, type RowAct, type RowsContext } from "./agentsRows.js";
import { HEAD, NARROW, TABS } from "./agentsWidths.js";
import { AgentsRow } from "./AgentsRow.js";
import { DetailLevel, UnderLevelView, UnderRowLevel } from "./AgentsDetail.js";
import { AGENTS_KINDS } from "./kinds/index.js";
import type { AgentsShell, AnyKind, GroupBy } from "./kinds/kind.js";
import { focusRow, rovingKeys } from "./roving.js";

export type { AgentsShell } from "./kinds/kind.js";

/** What the head says: the panel's one line (whose these are, the project's folder on its name's hover), or the
 * page's one sentence. */
export interface AgentsHead {
  readonly title?: ReactNode;
  readonly line?: string;
  /** The link to the computer's own page, from a task's panel. */
  readonly manage?: { readonly computer: string; readonly open: () => void };
}

export interface AgentsManagerProps {
  readonly shell: AgentsShell;
  readonly head: AgentsHead;
  readonly report: AgentsReport | null;
  readonly reading: boolean;
  /** The host's sentence for a read it refused, drawn only while no report stands. */
  readonly error?: string | null;
  /** What the empty lines name: the computer. */
  readonly on: string;
  readonly ctx: RowsContext;
  /** Read again; absent where nothing is read, as on a cloud's page. */
  readonly onRefresh?: () => void;
  readonly now: number;
  /** Lines under the list beside the report's own refusals: the recipe's rows that are not there. */
  readonly misses?: readonly RefusedLine[];
  /** The kinds drawn, in tab order; the registry unless a test names fewer. */
  readonly kinds?: readonly AnyKind[];
}

type Level = { readonly kind: "list" } | { readonly kind: "detail"; readonly key: string } | { readonly kind: "under"; readonly key: string } | { readonly kind: "under-row"; readonly key: string; readonly row: string };

const GROUP_WORDS: Record<GroupBy, string> = { none: "None", agent: "Agent", source: "Source", scope: "Scope" };
const LABEL = "font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground";

/** The nearest box that scrolls, whose place the list keeps while a detail stands over it. */
const scrollerOf = (el: HTMLElement | null): HTMLElement | null => {
  for (let at = el?.parentElement ?? null; at !== null; at = at.parentElement) {
    const y = getComputedStyle(at).overflowY;
    if (y === "auto" || y === "scroll") return at;
  }
  return null;
};

const typingIn = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

export function AgentsManager({ shell, head, report, reading, error = null, on, ctx: given, onRefresh, now, misses = [], kinds = AGENTS_KINDS }: AgentsManagerProps) {
  const [tabId, setTabId] = useState(kinds[0]!.id);
  const [level, setLevel] = useState<Level>({ kind: "list" });
  const [query, setQuery] = useState("");
  const [grouping, setGrouping] = useState<Record<string, GroupBy>>({});
  const root = useRef<HTMLElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const kept = useRef<{ key: string; top: number } | null>(null);

  const tab = kinds.find(k => k.id === tabId) ?? kinds[0]!;
  const paused = pausedReport(report);
  const held = given.heldWhy ?? (paused ? W.paused : null);
  const ctx: RowsContext = { ...given, ...(held === null ? {} : { heldWhy: held }), ...(report?.reach === undefined ? {} : { reach: report.reach }) };
  const staleWord = paused ? W.paused : given.heldWhy !== null && given.heldWhy !== undefined ? W.away : undefined;
  const dim = reading || held !== null;
  const page = shell === "page";

  const itemsOf = new Map(kinds.map(k => [k.id, report === null ? [] : k.items(report, ctx)]));
  const items = itemsOf.get(tab.id) ?? [];
  const shown = items.filter(item => tab.matches(item, query));
  const by = grouping[tab.id] ?? tab.defaultGroup(shell);
  const groups = tab.groups(shown, by, ctx).filter(g => g.items.length > 0);
  const count = report === null ? null : tab.count(items);
  const lines: RefusedLine[] = [...(report === null ? [] : refusedLines(report.refused)), ...misses, ...(report === null && error !== null ? [{ id: "read-refused", label: error }] : [])];
  const readAgo = report === null ? undefined : W.readAgo(offlineFor(now - Date.parse(report.readAt)));
  const current = level.kind === "list" ? undefined : items.find(item => tab.key(item) === level.key);
  const at: Level = level.kind !== "list" && current === undefined ? { kind: "list" } : level;
  if (at !== level) setLevel(at);

  const open = (key: string): void => {
    const scroller = scrollerOf(root.current);
    kept.current = { key, top: scroller?.scrollTop ?? 0 };
    setLevel({ kind: "detail", key });
  };
  const backToList = (): void => setLevel({ kind: "list" });
  // Back on the list: the scroll it had, and focus on the row that was opened.
  useLayoutEffect(() => {
    if (at.kind !== "list" || kept.current === null) return;
    const { key, top } = kept.current;
    kept.current = null;
    const scroller = scrollerOf(root.current);
    if (scroller !== null) scroller.scrollTop = top;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-agents-rows] [data-row-trigger]") ?? [])];
    const index = rows.findIndex(r => r.closest<HTMLElement>("[data-agents-row]")?.dataset["agentsRow"] === key);
    if (index >= 0) focusRow(rows, index);
  }, [at.kind]);

  const pick = (next: string): void => {
    setTabId(next);
    setQuery("");
    setLevel({ kind: "list" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === "/" && !typingIn(e.target) && search.current !== null) {
      e.preventDefault();
      search.current.focus();
    }
  };

  const add: RowAct = onImage(ctx) ? editImageAct(ctx) : { ...notYet("add", W.add, PlusIcon), hover: heldReason(ctx) ?? W.notYet };

  const staleMark =
    staleWord === undefined ? null : (
      <span data-k="agents-stale" className={cn(FACT, "shrink-0")} {...(given.heldWhy ? { title: given.heldWhy } : {})}>
        {staleWord}
      </span>
    );
  const manage =
    head.manage === undefined ? null : (
      <>
        <Button data-k="agents-manage" size="xs" variant="ghost-muted" className={cn("shrink-0", HEAD.linkHidden)} onClick={head.manage.open}>
          <SlidersHorizontalIcon aria-hidden className="size-3.5" />
          {W.manageAll(head.manage.computer)}
        </Button>
        <span className={cn("hidden", HEAD.glyphShown)}>
          <Tooltip>
            <TooltipTrigger render={<Button data-k="agents-manage-glyph" size="icon-xs" variant="ghost" aria-label={W.manageAll(head.manage.computer)} onClick={head.manage.open} />}>
              <SlidersHorizontalIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{W.manageAll(head.manage.computer)}</TooltipPopup>
          </Tooltip>
        </span>
      </>
    );
  const headRow =
    head.title === undefined ? (
      <div data-agents-head className="flex min-h-6 items-center gap-3 px-4 pb-3">
        <p data-k="agents-line" className="min-w-0 flex-1 truncate text-xs leading-4 text-muted-foreground" title={head.line}>
          {head.line}
        </p>
        {staleMark}
        {readAgain()}
      </div>
    ) : (
      <div data-agents-head className="flex items-center gap-2 px-4 pt-4 pb-3">
        <h2 data-k="agents-title" className="min-w-0 truncate text-[13px] leading-6 font-medium text-foreground" {...(typeof head.title === "string" ? { title: head.title } : {})}>
          {head.title}
        </h2>
        {staleMark}
        <span className="-mr-1 ml-auto flex shrink-0 items-center gap-1">
          {manage}
          {readAgain()}
        </span>
      </div>
    );

  function readAgain() {
    if (onRefresh === undefined) return null;
    if (reading) {
      return (
        <span className="flex size-6 items-center justify-center">
          <Spinner className="size-3.5 text-muted-foreground" />
        </span>
      );
    }
    return (
      <span className="inline-flex" title={held ?? readAgo}>
        <Button data-k="agents-read-again" aria-label={W.readAgain} size="icon-xs" variant="ghost" held={held !== null} onClick={onRefresh}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </span>
    );
  }

  const tabs = (
    <div className="px-4">
      <SegmentedControl
        value={tab.id}
        onChange={pick}
        className="flex w-full"
        segmentClassName={cn("flex-auto gap-1.5 whitespace-nowrap px-3 text-sm", TABS.narrowPad)}
        segments={kinds.map(k => {
          const Icon = k.icon;
          const n = report === null ? null : k.count(itemsOf.get(k.id) ?? []);
          return {
            value: k.id,
            label: (
              <TabLabel word={k.word}>
                <Icon aria-hidden className="size-4 shrink-0" />
                <span data-segment-word className={NARROW.hidden}>
                  {k.word}
                </span>
                {n === null ? null : (
                  <span data-segment-count className={cn(FACT, "text-xs", TABS.countHidden)}>
                    {n}
                  </span>
                )}
              </TabLabel>
            ),
          };
        })}
      />
    </div>
  );

  const toolbar =
    tab.search === undefined ? null : (
      <div data-agents-toolbar className="flex h-8 items-center gap-1.5 px-4">
        <InputGroup variant="ghost" className="-ms-3 h-8 min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={search}
            data-k="agents-search"
            value={query}
            placeholder={tab.search}
            aria-label={tab.search}
            spellCheck={false}
            className="font-mono text-[13px] sm:text-[13px]"
            onChange={e => {
              setQuery(e.target.value);
              setLevel({ kind: "list" });
            }}
            onKeyDown={e => {
              if (e.key !== "Escape" || query !== "") return;
              e.preventDefault();
              const rows = [...(root.current?.querySelectorAll<HTMLElement>("[data-agents-rows] [data-row-trigger]") ?? [])];
              const active = rows.findIndex(r => r.tabIndex === 0);
              focusRow(rows, Math.max(active, 0));
            }}
          />
        </InputGroup>
        {count === null ? null : (
          <span data-k="agents-count" className={cn(FACT, "hidden shrink-0", TABS.countShown)}>
            {query.trim() === "" ? tab.noun(count) : W.of(shown.length, count)}
          </span>
        )}
        {tab.groupings.length === 0 ? null : (
          <Menu>
            <Tooltip>
              <TooltipTrigger render={<MenuTrigger render={<Button data-k="agents-view" size="icon" variant="ghost" aria-label={W.groupAndSort} />} />}>
                <ListFilterIcon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{W.groupAndSort}</TooltipPopup>
            </Tooltip>
            <MenuPopup align="end">
              <MenuGroup>
                <MenuGroupLabel>{W.groupBy}</MenuGroupLabel>
                <MenuRadioGroup value={by} onValueChange={value => setGrouping(g => ({ ...g, [tab.id]: value as GroupBy }))}>
                  {tab.groupings.map(g => (
                    <MenuRadioItem key={g} value={g} data-k={`group-${g}`}>
                      {GROUP_WORDS[g]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{W.sortBy}</MenuGroupLabel>
                <MenuRadioGroup value="name">
                  <MenuRadioItem value="name">{W.name}</MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </MenuPopup>
          </Menu>
        )}
        <span className="inline-flex shrink-0" title={add.hover ?? tab.add}>
          <Button data-k="agents-add" size="default" variant="outline" aria-label={add.id === "edit-image" ? W.editImage : tab.add} held={add.run === undefined} {...(add.run === undefined ? {} : { onClick: add.run })}>
            {add.icon === undefined ? null : <add.icon aria-hidden className="size-4" />}
            <span className={TABS.addWordHidden}>{add.label}</span>
          </Button>
        </span>
      </div>
    );

  const rowHeight = tab.rowHeight;
  const emptyBox = "flex min-h-[168px] items-center justify-center px-4 text-center text-[13px] text-muted-foreground";
  const list =
    report === null ? (
      reading || error === null ? (
        <div data-agents-rows aria-busy className="flex flex-col gap-0.5">
          {[0, 1, 2].map(n => (
            <Skeleton key={n} data-k="agents-skeleton" className={cn("mx-2 rounded-lg", rowHeight)} />
          ))}
        </div>
      ) : null
    ) : shown.length === 0 ? (
      query.trim() !== "" ? (
        <p data-k="agents-empty" className={emptyBox}>
          {W.nothingMatches(query.trim())}
        </p>
      ) : page ? (
        <div data-k="agents-empty" className="mx-4 flex min-h-[168px] flex-col items-center justify-center gap-3 rounded-lg bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[12px_12px]">
          <span className="rounded-md border border-dashed border-border bg-background px-2 py-1 font-mono text-xs text-muted-foreground">{tab.none}</span>
          <ActButton act={{ ...add, label: add.id === "edit-image" ? W.editImage : tab.add }} />
        </div>
      ) : (
        <p data-k="agents-empty" className={emptyBox}>
          {tab.empty(on)}
        </p>
      )
    ) : (
      // Labels and rows stand 2 px apart alike, a label's words centred in its slot: one rhythm down the list.
      <div data-agents-rows aria-busy={reading} onKeyDown={rovingKeys} className="flex flex-col gap-0.5">
        {groups.map((group, g) => (
          <div key={group.id} role="group" data-agents-group={group.id} {...(group.label === undefined ? {} : { "aria-label": group.label })} className="flex flex-col gap-0.5">
            {group.label === undefined ? null : (
              <div data-group-label className={cn(LABEL, "flex h-8 items-center gap-2 px-4")}>
                <span>{group.label}</span>
                {group.path === undefined ? null : <span className="truncate normal-case tracking-normal">{group.path}</span>}
              </div>
            )}
            <div role="list" className="flex flex-col gap-0.5">
              {group.items.map((item, i) => {
                const key = tab.key(item);
                return <AgentsRow key={key} row={tab.row(item, ctx)} height={rowHeight} dim={dim} first={g === 0 && i === 0} onOpen={() => open(key)} />;
              })}
            </div>
          </div>
        ))}
      </div>
    );

  const backLabel = W.back(tab.word);
  const levelView =
    at.kind === "list" || current === undefined
      ? null
      : (() => {
          const detail = tab.detail(current, ctx, { openUnder: () => setLevel({ kind: "under", key: at.key }) });
          const under = detail.under;
          const row = at.kind === "under-row" ? under?.rows?.find(r => r.key === at.row) : undefined;
          if (at.kind === "detail" || under === undefined) return <DetailLevel key={at.key} view={detail} back={backToList} backLabel={backLabel} />;
          const toUnder = (): void => setLevel({ kind: "under", key: at.key });
          if (row !== undefined) return <UnderRowLevel key={`row-${row.key}`} row={row} back={toUnder} backLabel={W.back(under.title)} />;
          return <UnderLevelView key="under" level={under} back={() => setLevel({ kind: "detail", key: at.key })} backLabel={W.back(detail.title)} now={now} onRow={r => setLevel({ kind: "under-row", key: at.key, row: r.key })} />;
        })();

  return (
    // On the page the content stands on the cards' text edge, their hairline and px-5, 5 px past the panel's.
    <section ref={root} data-agents-manager data-shell={shell} aria-label={W.section} onKeyDown={onKeyDown} className={cn("@container flex flex-col", page ? "px-[5px]" : "min-h-0 flex-1")}>
      {/* The page scrolls as a whole, so its head pins over the list on the page's grained ground; the panel's head
          stands still and only the list under it scrolls, since the panel's ground is the glass and clear. */}
      <div data-agents-top className={cn("flex flex-col pb-1", page ? "sticky top-0 z-10 bg-background surface-grain" : "flex-none")}>
        {headRow}
        <div className="flex flex-col gap-3">
          {tabs}
          {toolbar}
        </div>
      </div>
      <div data-agents-body className={cn("flex flex-col pt-2", !page && "min-h-0 flex-1 overflow-y-auto", dim && at.kind !== "list" && "opacity-50")}>
        {at.kind === "list" ? list : levelView}
        {at.kind !== "list" || lines.length === 0 ? null : (
          <div data-agents-refused className="mt-2 flex flex-col px-4">
            {lines.map(line => (
              <p key={line.id} data-refused-line={line.id} className="flex min-h-7 items-center gap-2 py-1">
                <span data-refused-label className={cn(FACT, line.value !== undefined && "text-foreground", "min-w-0 shrink-0 truncate")} title={line.label}>
                  {line.label}
                </span>
                {line.value === undefined ? null : (
                  <span data-refused-value className={cn(FACT, "min-w-0 truncate")} title={line.value}>
                    {line.value}
                  </span>
                )}
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** A tab's face; its tooltip opens only while the word is hidden, since it says nothing more than the word. */
function TabLabel({ word, children }: { word: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const face = useRef<HTMLSpanElement | null>(null);
  const hidden = (): boolean => {
    const el = face.current?.querySelector<HTMLElement>("[data-segment-word]");
    return el === null || el === undefined || getComputedStyle(el).display === "none";
  };
  return (
    <Tooltip open={open} onOpenChange={next => setOpen(next && hidden())}>
      <TooltipTrigger render={<span ref={face} data-segment-label aria-label={word} className="flex items-center gap-1.5" />}>{children}</TooltipTrigger>
      <TooltipPopup side="bottom">{word}</TooltipPopup>
    </Tooltip>
  );
}
