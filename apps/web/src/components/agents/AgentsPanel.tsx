// SPDX-License-Identifier: AGPL-3.0-only
// The agents, tool servers and skills a task can use, at the right panel's
// width, drawn with Settings > Agents' own cards and rows. The tabs stand at
// the top; a row opens its item's page in place of the list, and the panel,
// which has no crumb, stands a back and the page's name in the tabs' place;
// Escape takes the same step. The first card names the computer, whose name
// opens its page in Settings.
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { AgentsCards, AGENTS_TABS } from "../../settings/agents.js";
import { KindPages, type KindRead, type Stale } from "../../settings/agentKinds.js";
import { AGENTS_PAGE_WORDS, capitalised, SETTINGS_WORDS } from "../../settings/format.js";
import { Slash } from "../../settings/grid.js";
import type { AgentsLevel, AgentsTab } from "../../settings/settingsStore.js";
import { addNotice, noticeFailure } from "../../notices/store.js";
import { isTypingTarget } from "../../keyOwners.js";
import { Button } from "../ui/button.js";
import { SegmentedControl } from "../ui/segmented-control.js";
import { AGENTS_LIST_WORDS as W, pausedReport, type RowsContext } from "./agentsRows.js";
import { agentRowId } from "./kinds/agents.js";
import { AGENTS_KINDS } from "./kinds/index.js";

const NOTIFY = { done: (line: string) => void addNotice({ kind: "done", text: line }), failed: (e: unknown) => noticeFailure(e) };

export interface AgentsPanelProps {
  /** The computer the rows are on as the heads name it, and the road to its page in Settings. */
  readonly on: { readonly name: string; readonly open?: () => void };
  readonly read: KindRead;
  readonly ctx: RowsContext;
  readonly now: number;
}

/** What takes a key of its own on a form: a field, a select, a toggle, a switch, a button. */
const CONTROL = "button, a[href], input, textarea, select, [tabindex], [role=combobox], [role=radio], [role=switch], [role=checkbox]";

/** The Not read card in a task's panel holds the report's own lines: the recipe's rows are its computer's page's. */
const NO_MISSES = [] as const;

export function AgentsPanel({ on, read, ctx: given, now }: AgentsPanelProps) {
  const [tab, setTab] = useState<AgentsTab>("agents");
  const [level, setLevel] = useState<AgentsLevel | null>(null);
  const { report } = read;
  const paused = pausedReport(report);
  // A paused task's report is the last one read while it ran, so nothing it offers can be done now.
  const held = given.heldWhy ?? (paused ? W.paused : null);
  const ctx: RowsContext = { ...given, on: on.name, ...(held === null ? {} : { heldWhy: held }), ...(report?.reach === undefined ? {} : { reach: report.reach }) };
  const stale: Stale | undefined = paused ? { word: capitalised(W.paused) } : given.heldWhy !== null && given.heldWhy !== undefined ? { word: capitalised(W.notAnswering), why: given.heldWhy } : undefined;
  const computer = { ...on, ...(stale === undefined ? {} : { stale }) };
  const nav = { level, open: setLevel };
  const pick = (next: AgentsTab): void => {
    setTab(next);
    setLevel(null);
  };
  const up = level?.kind === "found" ? level.up : null;
  const backTo = up?.name ?? AGENTS_PAGE_WORDS.tabs[tab];
  const backButton = useRef<HTMLButtonElement | null>(null);
  // An open page takes focus on its back, since the row that opened it is gone and Escape must land in the panel.
  useEffect(() => {
    if (level !== null) backButton.current?.focus({ preventScroll: true });
  }, [level]);
  // Escape steps back one page. A field keeps its own Escape, as does a popup or a dialog drawn outside the panel; an add
  // page holds what was typed into it, so there only Escape on the page itself or on its back leaves it.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement;
    if (e.key !== "Escape" || level === null || !e.currentTarget.contains(target) || isTypingTarget(target)) return;
    if (level.kind === "add" && target !== backButton.current && target.closest(CONTROL) !== null) return;
    e.preventDefault();
    e.stopPropagation();
    setLevel(up);
  };
  return (
    <section data-agents-panel aria-label={W.section} onKeyDown={onKeyDown} className="@container/panel flex min-h-0 flex-1 flex-col [--settings-inset:16px] [--settings-slot:0px] [--settings-text:8rem]">
      <div data-agents-top className="flex flex-none items-center p-4">
        {level === null ? (
          <SegmentedControl data-k="agents-tabs" aria-label={W.section} value={tab} segments={AGENTS_TABS} onChange={pick} className="flex h-8 w-full" segmentClassName="flex-auto gap-1.5 whitespace-nowrap px-2.5 text-[13px]" />
        ) : (
          <span className="flex h-8 min-w-0 items-center gap-2 text-[13px]">
            <Button ref={backButton} data-k="agents-back" variant="ghost" size="xs" aria-label={SETTINGS_WORDS.backTo(backTo)} className="-ml-2 shrink-0 gap-1 text-[13px] text-muted-foreground hover:text-foreground" onClick={() => setLevel(up)}>
              <ChevronLeftIcon aria-hidden className="size-4" />
              {backTo}
            </Button>
            <Slash />
            <span data-k="agents-page" className="min-w-0 truncate font-medium text-foreground">
              {level.name}
            </span>
          </span>
        )}
      </div>
      <div data-agents-body className="flex min-h-0 flex-1 flex-col gap-[30px] overflow-y-auto px-4 pb-6">
        {tab === "agents" && level === null ? (
          <AgentsCards read={read} rows={ctx} on={computer} now={now} misses={NO_MISSES} notify={NOTIFY} openOf={row => () => setLevel({ kind: "item", key: agentRowId(row.id), name: row.name })} />
        ) : (
          <KindPages key={tab} kind={AGENTS_KINDS[tab]} read={read} rows={ctx} on={computer} nav={nav} now={now} misses={NO_MISSES} />
        )}
      </div>
    </section>
  );
}
