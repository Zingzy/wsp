// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage, on the settings cards: each account with what its agent
// last said of its limits, then what the person's turns used over a range,
// said in one line, drawn as one line chart and split one way in a table.
// The accounts and the tokens are two ledgers and are never summed.
import { useEffect, useState, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { USAGE_RANGES, USAGE_SPLITS, USAGE_WORDS, accountState, accountWords, fmtTokens, freshIn, listWords, logsLine, resetsWord, usedHeadline, usedPrice, type AccountRow, type AccountsAnswer, type LimitKind, type UsageRange, type UsageSplit, type UsedAnswer, type UsedRow } from "@wsp/protocol";
import { ChartPlot, spanPoints } from "../components/machine/MachineSurface.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { USAGE_PAGE_WORDS as W } from "./format.js";
import { Card, Row, type SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

const NUMBER = "font-mono text-xs tabular-nums";
const QUIET = "text-[13px] leading-5 text-muted-foreground";
const WINDOW_KINDS: readonly LimitKind[] = ["session", "week"];
/** The used table's columns; below 640 px the name, the fresh tokens and the price. */
const USED_COLUMNS = "grid grid-cols-[minmax(0,1fr)_72px_72px_64px_96px] gap-x-4 max-sm:grid-cols-[minmax(0,1fr)_64px_88px]";
const WIDE_ONLY = "max-sm:hidden";

/** A state word as the page draws it, capitalised: the wire's words are the command line's, in its lower case. */
const stateWord = (word: string): string => (word === "" ? "" : word[0]!.toUpperCase() + word.slice(1));

export function usageCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "usage", items: [], body: <UsagePage ctx={ctx} /> }];
}

function UsagePage({ ctx }: { ctx: SettingsContext }) {
  const { api } = ctx;
  const [range, setRange] = useState<UsageRange>("week");
  const [split, setSplit] = useState<UsageSplit>("agent");
  const [accounts, setAccounts] = useState<AccountsAnswer | null>(null);
  const [used, setUsed] = useState<UsedAnswer | null>(null);

  useEffect(() => {
    let live = true;
    void api?.usageAccounts?.().then(
      answer => live && setAccounts(answer),
      () => live && setAccounts({ accounts: [] }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    let live = true;
    void api?.usageUsed?.(range, split).then(
      answer => live && setUsed(answer),
      () => live && setUsed(null),
    );
    return () => {
      live = false;
    };
  }, [api, range, split]);

  return (
    <div className="flex flex-col gap-8">
      <Limits accounts={accounts?.accounts ?? null} now={ctx.now} />
      <Used used={used} range={range} split={split} onRange={setRange} onSplit={setSplit} />
    </div>
  );
}

/** A window's thin meter with its share, and when it starts again, in mono. */
function WindowLine({ kind, used, resets }: { kind: LimitKind; used: number; resets?: string }) {
  const share = Math.min(100, Math.max(0, Math.round(used)));
  return (
    <span data-window={kind} className="grid grid-cols-[3.5rem_5rem_2.5rem_auto] items-center gap-x-3">
      <span data-k="window" className={QUIET}>
        {kind === "session" ? W.session : W.week}
      </span>
      <span aria-hidden className="block h-1 w-20 overflow-hidden rounded-full bg-foreground/10">
        <span data-k="meter-fill" className="block h-full rounded-full bg-foreground/55 transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" style={{ width: `${share}%` }} />
      </span>
      <span data-k="percent" className={cn(NUMBER, "text-right text-foreground")}>{`${Math.round(used)}%`}</span>
      <span data-k="resets" className={cn(NUMBER, "text-muted-foreground")}>
        {resets ?? ""}
      </span>
    </span>
  );
}

function AccountLine({ row, now }: { row: AccountRow; now: number }) {
  const windows = (row.windows ?? []).filter(w => WINDOW_KINDS.includes(w.kind));
  const state = stateWord(accountState(row));
  const reached = row.status === "reached";
  const slot = (
    <span className="flex flex-col gap-1.5 sm:items-end">
      {windows.map(w => (
        <WindowLine key={w.kind} kind={w.kind} used={w.usedPercent} {...(w.resetsAt === undefined ? {} : { resets: resetsWord(w.resetsAt, now) })} />
      ))}
      {state === "" ? null : (
        <span data-k="state" className={cn("text-[13px] leading-5", reached ? "text-warning-foreground" : "text-muted-foreground")}>
          {state}
        </span>
      )}
    </span>
  );
  // A computer's own login names its computer in its title already, so the line under it would only say it again.
  const own = row.computers.length === 1 && row.label === accountWords({ agentName: agentName(row.agent), ownOn: row.computers[0] });
  const where = own ? "" : listWords(row.computers);
  return <Row id={`account-${row.key}`} title={row.label} lead={<HarnessMark harness={row.agent} label={agentName(row.agent)} className="size-4" />} description={where} control={slot} attrs={{ "data-usage-account": row.key }} />;
}

function Limits({ accounts, now }: { accounts: ReadonlyArray<AccountRow> | null; now: number }) {
  // Until the accounts arrive the card holds one row's room, so Used under it does not move when they land.
  if (accounts === null)
    return (
      <Card id="usage-limits" head={W.limits}>
        <div data-k="limits-loading" aria-busy className="h-[68px]" />
      </Card>
    );
  // An agent that reports no limit at all has nothing to read on a row of its own, so it is named once under the list.
  const unlimited = accounts.filter(row => row.note === USAGE_WORDS.noLimit && (row.windows ?? []).length === 0);
  const listed = accounts.filter(row => !unlimited.includes(row));
  const names = [...new Set(unlimited.map(row => agentName(row.agent)))];
  return (
    <Card
      id="usage-limits"
      head={W.limits}
      {...(names.length === 0
        ? {}
        : {
            under: (
              <p data-k="no-limit" className={cn(QUIET, "px-4")}>
                {W.noLimit(names)}
              </p>
            ),
          })}
    >
      {listed.length === 0 ? (
        <p data-k="no-accounts" className={cn(QUIET, "px-4 py-3")}>
          {W.noAccounts}
        </p>
      ) : (
        listed.map(row => <AccountLine key={row.key} row={row} now={now} />)
      )}
    </Card>
  );
}

/** A small quiet choice: words, the picked one in the foreground on the hover fill. */
function Choice<T extends string>({ k, attr, label, value, options, onPick }: { k: string; attr: string; label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onPick: (value: T) => void }) {
  return (
    <div data-k={k} role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          {...{ [`data-${attr}`]: option.value }}
          aria-pressed={option.value === value}
          onClick={() => onPick(option.value)}
          className={cn("rounded-md px-2 py-0.5 text-[13px] leading-5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", option.value === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const RANGES = USAGE_RANGES.map(value => ({ value, label: W.ranges[value] }));
const SPLITS = USAGE_SPLITS.map(value => ({ value, label: W.splits[value] }));

/** The words a step of the chart goes by: its hour in a day's range, its day otherwise. */
const stepWord = (used: UsedAnswer): Intl.DateTimeFormat =>
  used.range === "day" ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) : new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** The ticks under the tokens chart: each hour's in a day's range every sixth, each day's in a week, every fifth day
 * in a month, placed where their point is. */
function ticksOf(used: UsedAnswer): { at: number; word: string }[] {
  const n = used.series.length;
  const every = used.range === "day" ? 6 : used.range === "month" ? 5 : 1;
  const word =
    used.range === "day"
      ? new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23" })
      : used.range === "week"
        ? new Intl.DateTimeFormat("en-US", { weekday: "short" })
        : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
  return used.series.flatMap((s, i) => (i % every === 0 ? [{ at: n > 1 ? i / (n - 1) : 0, word: word.format(s.t) }] : []));
}

function TokensChart({ used }: { used: UsedAnswer }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const top = Math.max(0, ...used.series.map(s => s.tokens));
  const n = used.series.length;
  if (top === 0) {
    return (
      <div data-usage-chart="tokens" className={cn("flex h-32 items-center justify-center px-4", QUIET)}>
        {USAGE_WORDS.noUse}
      </div>
    );
  }
  const points = used.series.map((s, i) => ({ at: n > 1 ? i / (n - 1) : 0, share: s.tokens / top }));
  const run = spanPoints(points, 0, 1, p => p.share);
  const word = stepWord(used);
  return (
    <div data-usage-chart="tokens" className="flex flex-col gap-2 px-4 pt-4 pb-3">
      <div className="relative">
        <ChartPlot runs={[run]} label={W.tokens} end fill={false} marked={hovered === null ? undefined : run[hovered]} className="text-primary" />
        {/* Each step's figure on its hover: a band of the chart's width per point, centred on it. */}
        <div className="absolute inset-0 flex">
          {used.series.map((s, i) => (
            <Tooltip key={s.t}>
              <TooltipTrigger
                delay={0}
                render={<span data-k="point" className="h-full flex-1" style={n > 1 && (i === 0 || i === n - 1) ? { flexGrow: 0.5 } : undefined} onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(current => (current === i ? null : current))} />}
              />
              <TooltipPopup side="top" sideOffset={6}>
                <span data-k="point-figure" className={NUMBER}>{`${word.format(s.t)}: ${fmtTokens(s.tokens)} tokens`}</span>
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="relative h-4 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">
        {ticksOf(used).map(tick => (
          <span key={tick.at} data-k="tick" className={cn("absolute top-0", tick.at === 0 ? "" : tick.at === 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: `${tick.at * 100}%` }}>
            {tick.word}
          </span>
        ))}
      </div>
    </div>
  );
}

function UsedLine({ row }: { row: UsedRow }) {
  const price = usedPrice(row);
  return (
    <div data-used-row={row.key} className={cn(USED_COLUMNS, "items-center px-4 py-3")}>
      <span data-k="label" className="min-w-0 break-words text-sm leading-5 text-foreground">
        {row.label}
      </span>
      <span data-k="fresh" className={cn(NUMBER, "text-right text-foreground")}>
        {fmtTokens(freshIn(row.tokens))}
      </span>
      <span data-k="cached" className={cn(NUMBER, "text-right text-muted-foreground", WIDE_ONLY)}>
        {fmtTokens(row.tokens.cached)}
      </span>
      <span data-k="out" className={cn(NUMBER, "text-right text-foreground", WIDE_ONLY)}>
        {fmtTokens(row.tokens.output)}
      </span>
      <span className="flex flex-col items-end">
        {price.figure === undefined ? null : (
          <span data-k="price" className={cn(NUMBER, "text-foreground")}>
            {price.figure}
          </span>
        )}
        {price.word === undefined ? null : (
          <span data-k="price-word" className="text-[11px] leading-[14px] text-muted-foreground">
            {price.word}
          </span>
        )}
      </span>
    </div>
  );
}

function Used({ used, range, split, onRange, onSplit }: { used: UsedAnswer | null; range: UsageRange; split: UsageSplit; onRange: (r: UsageRange) => void; onSplit: (s: UsageSplit) => void }) {
  const body: ReactNode = (
    <div className="flex flex-col gap-3 px-4">
      {used === null ? null : (
        <p data-k="used-headline" className="text-sm leading-5 text-foreground">
          {usedHeadline(used)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <Choice k="usage-range" attr="range" label={W.range} value={range} options={RANGES} onPick={onRange} />
        <Choice k="usage-split" attr="split" label={W.split} value={split} options={SPLITS} onPick={onSplit} />
      </div>
    </div>
  );
  return (
    <section data-usage-section="used" aria-label={W.used}>
      <Card
        id="usage-used"
        head={W.used}
        body={body}
        {...(used?.logs === undefined || used.rows.length === 0
          ? {}
          : {
              under: (
                <p data-k="logs" className={cn(QUIET, "px-4")}>
                  {logsLine(used.logs)}
                </p>
              ),
            })}
      >
        {used === null ? null : <TokensChart used={used} />}
        {used === null || used.rows.length === 0 ? null : (
          <div data-k="used-head" className={cn(USED_COLUMNS, "px-4 py-2 text-xs leading-4 text-muted-foreground")}>
            <span data-k="split-head">{W.splits[used.split]}</span>
            <span className="text-right">{W.fresh}</span>
            <span className={cn("text-right", WIDE_ONLY)}>{W.cached}</span>
            <span className={cn("text-right", WIDE_ONLY)}>{W.out}</span>
            <span className="text-right">{W.price}</span>
          </div>
        )}
        {used?.rows.map(row => <UsedLine key={row.key} row={row} />)}
      </Card>
    </section>
  );
}
