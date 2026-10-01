// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage, two tabs. Usage: what the turns used over a range, as
// totals, one line per split value, the split as a table, the token mix, the
// threads that used the most and where it was read. Limits: each account with
// what its agent last said of its plan's windows. The accounts and the tokens
// are two ledgers and are never summed.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { agentMark, agentName } from "@wsp/catalog";
import { ArrowUpRightIcon, ChartLineIcon, GaugeIcon } from "lucide-react";
import { USAGE_RANGES, USAGE_SPLITS, USAGE_WORDS, accountState, accountWords, fmtCost, fmtTokens, listWords, logsLine, resetsWord, type AccountRow, type AccountsAnswer, type LimitKind, type UsageRange, type UsageSplit, type UsedAnswer, type UsedRow } from "@wsp/protocol";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { cn } from "../lib/utils.js";
import { ProjectGlyph } from "../projects/look.js";
import { useStore } from "../protocol/store.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { ABOUT_WORDS, USAGE_PAGE_WORDS as W } from "./format.js";
import { GlyphFrame } from "./grid.js";
import { CARD_SURFACE, Card, Row, type SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore, type UsageTab } from "./settingsStore.js";
import { UsageChart, type ChartLine } from "./usageChart.js";

const NUMBER = "font-mono text-xs tabular-nums";
const QUIET = "text-[13px] leading-5 text-muted-foreground";
const WIDE_ONLY = "max-sm:hidden";

/** A state word as the page draws it, capitalised: the wire's words are the command line's, in its lower case. */
const stateWord = (word: string): string => (word === "" ? "" : word[0]!.toUpperCase() + word.slice(1));

const TABS: ReadonlyArray<{ value: UsageTab; label: ReactNode }> = [
  { value: "used", label: <><ChartLineIcon aria-hidden className="size-4" />{W.tabs.used}</> },
  { value: "limits", label: <><GaugeIcon aria-hidden className="size-4" />{W.tabs.limits}</> },
];

/** The page's two tabs, at the top bar's right end: what the agents used, and what each account may still use. */
export function UsageTabs() {
  const tab = useSettingsStore(state => state.usageTab);
  const pick = useSettingsStore(state => state.pickUsageTab);
  return <SegmentedControl data-k="usage-tabs" aria-label={W.tab} value={tab} segments={TABS} onChange={pick} className="h-9 [-webkit-app-region:no-drag]" segmentClassName="gap-2 px-3.5 text-sm" />;
}

export function usageCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "usage", items: [], body: <UsagePage ctx={ctx} /> }];
}

function UsagePage({ ctx }: { ctx: SettingsContext }) {
  const { api } = ctx;
  const tab = useSettingsStore(state => state.usageTab);
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

  // By agent, each agent's models stand under it, read as the model split of the same range.
  const [models, setModels] = useState<readonly UsedRow[]>([]);
  const nested = split === "agent" && (USAGE_SPLITS as readonly string[]).includes("model");
  useEffect(() => {
    if (!nested) return setModels([]);
    let live = true;
    void api?.usageUsed?.(range, "model" as UsageSplit).then(
      answer => live && setModels(answer.rows),
      () => live && setModels([]),
    );
    return () => {
      live = false;
    };
  }, [api, range, nested]);

  return (
    <div className="flex flex-col gap-8">
      {tab === "limits" ? <Limits accounts={accounts?.accounts ?? null} now={ctx.now} /> : <Used used={used} models={models} range={range} split={split} onRange={setRange} onSplit={setSplit} ctx={ctx} />}
    </div>
  );
}

/** How long each window runs, so its pace is the share of it already gone. */
const WINDOW_MS: Partial<Record<LimitKind, number>> = { session: 5 * 3_600_000, week: 7 * 86_400_000, week_opus: 7 * 86_400_000, week_sonnet: 7 * 86_400_000, month: 30 * 86_400_000 };
const POOLED_KINDS: readonly LimitKind[] = ["session", "week", "week_opus", "week_sonnet", "month"];
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

interface Segment {
  readonly account: AccountRow;
  readonly used: number;
  readonly resetsAt?: number;
  /** The share of the window gone by now, 0 to 1, where its reset is known. */
  readonly elapsed?: number;
}

const segmentOf = (account: AccountRow, kind: LimitKind, now: number): Segment | undefined => {
  const w = account.windows?.find(x => x.kind === kind);
  if (w === undefined) return undefined;
  const length = WINDOW_MS[kind];
  const elapsed = w.resetsAt === undefined || length === undefined ? undefined : Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / length));
  return { account, used: w.usedPercent, ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }), ...(elapsed === undefined ? {} : { elapsed }) };
};

/** The pool's one sentence: reached, when it runs out at this pace, or how it stands against an even pace. */
function verdictOf(segments: readonly Segment[], kind: LimitKind, now: number): { word: string; tone: "warn" | "quiet" | "plain" } {
  if (segments.every(s => s.used >= 100)) return { word: W.reached, tone: "warn" };
  const length = WINDOW_MS[kind];
  const soonest = segments.map(s => s.resetsAt).filter((t): t is number => t !== undefined).sort((x, y) => x - y)[0];
  const resets = soonest === undefined ? "" : resetsWord(soonest, now);
  const paced = segments.filter((s): s is Segment & { elapsed: number; resetsAt: number } => s.elapsed !== undefined && s.resetsAt !== undefined && s.elapsed > 0.02);
  if (length === undefined || paced.length === 0) return { word: stateWord(resets), tone: "plain" };
  // The pool runs out when its last account does, each at the rate it has used its window so far.
  const outs = paced.map(s => (s.used <= 0 ? Infinity : s.resetsAt - length + (now - (s.resetsAt - length)) * (100 / s.used)));
  const out = Math.max(...outs);
  const lastReset = Math.max(...paced.map(s => s.resetsAt));
  if (out < lastReset) return { word: W.runsOut(out - now < 86_400_000 ? clock.format(out) : new Intl.DateTimeFormat("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(out)), tone: "warn" };
  const ratio = paced.reduce((n, s) => n + s.used / 100 / s.elapsed, 0) / paced.length;
  if (ratio > 1.05) return { word: W.aheadOfPace(resets), tone: "warn" };
  if (ratio < 0.95) return { word: W.underPace(resets), tone: "quiet" };
  return { word: W.onPace(resets), tone: "plain" };
}

/** One window of a pool: a segment per account filled by what it has used, the even-pace mark on each, the pool's
 * share and its verdict. */
function PoolWindow({ kind, segments, now }: { kind: LimitKind; segments: readonly Segment[]; now: number }) {
  const share = Math.round(segments.reduce((n, s) => n + Math.min(100, s.used), 0) / segments.length);
  const verdict = verdictOf(segments, kind, now);
  return (
    <div data-window={kind} className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem_minmax(0,10rem)] items-center gap-x-4 max-sm:grid-cols-[4.5rem_minmax(0,1fr)_3rem] max-sm:gap-y-1">
      <span data-k="window" className={QUIET}>
        {W.windows[kind] ?? kind}
      </span>
      <span className="flex h-2.5 gap-[3px]">
        {segments.map(s => (
          <Tooltip key={s.account.key}>
            <TooltipTrigger
              delay={0}
              render={<span data-k="segment" className="relative flex-1 overflow-visible rounded-[3px] bg-foreground/[0.09]" />}
            >
              <span data-k="meter-fill" className={cn("absolute inset-y-0 left-0 rounded-[3px] transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", s.used >= 90 ? "bg-warning" : "bg-foreground/55")} style={{ width: `${Math.min(100, Math.max(0, s.used))}%` }} />
              {s.elapsed === undefined ? null : <span data-k="pace" aria-hidden className="absolute -inset-y-1 w-[1.5px] rounded-full bg-foreground/80" style={{ left: `${s.elapsed * 100}%` }} />}
            </TooltipTrigger>
            <TooltipPopup side="top" sideOffset={6}>
              <span className="flex flex-col gap-0.5 text-xs">
                <span className="text-foreground">{s.account.label}</span>
                <span className="font-mono text-muted-foreground tabular-nums">{`${Math.round(s.used)}%${s.resetsAt === undefined ? "" : `, ${resetsWord(s.resetsAt, now)}`}`}</span>
              </span>
            </TooltipPopup>
          </Tooltip>
        ))}
      </span>
      <span data-k="percent" className={cn(NUMBER, "text-right text-foreground")}>{`${share}%`}</span>
      <span data-k="verdict" className={cn("truncate text-[12.5px] max-sm:col-start-2 max-sm:col-span-2", verdict.tone === "warn" ? "text-warning-foreground" : verdict.tone === "quiet" ? "text-muted-foreground" : "text-foreground/80")}>
        {verdict.word}
      </span>
    </div>
  );
}

/** One agent's subscription accounts as a pool: who they are, what they draw now, and one line per window. */
function Pool({ agent, accounts, now }: { agent: string; accounts: readonly AccountRow[]; now: number }) {
  const kinds = POOLED_KINDS.filter(kind => accounts.some(a => a.windows?.some(w => w.kind === kind)));
  const computers = [...new Set(accounts.flatMap(a => a.computers))];
  const title = accounts.length === 1 ? accounts[0]!.label : W.accounts(accounts.length, agentName(agent));
  const burn = accounts.reduce((n, a) => n + (a.burn?.tokensPerMinute ?? 0), 0);
  const threads = accounts.reduce((n, a) => n + (a.burn?.threads ?? 0), 0);
  const readAt = Math.min(...accounts.map(a => a.readAt ?? now));
  return (
    <Card id={`usage-pool-${agent}`} head={agentName(agent)}>
      <div data-usage-pool={agent} className="flex flex-col gap-4 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span className="flex min-w-0 items-center gap-3">
            <GlyphFrame>
              <HarnessMark harness={agent} label={agentName(agent)} className="size-4" />
            </GlyphFrame>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm leading-5 font-medium text-foreground">{title}</span>
              <span className="truncate text-[13px] text-muted-foreground">{listWords(computers)}</span>
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-x-5 text-[12.5px] text-muted-foreground">
            {burn > 0 ? <span data-k="burn">{W.burn(fmtTokens(burn), threads)}</span> : null}
            <span data-k="read-at">{W.checked(ABOUT_WORDS.readWhen(Math.max(0, now - readAt)))}</span>
          </span>
        </div>
        <div className="flex flex-col gap-3">
          {kinds.map(kind => {
            const segments = accounts
              .map(a => segmentOf(a, kind, now))
              .filter((s): s is Segment => s !== undefined)
              .sort((x, y) => (x.resetsAt ?? Infinity) - (y.resetsAt ?? Infinity));
            return <PoolWindow key={kind} kind={kind} segments={segments} now={now} />;
          })}
        </div>
      </div>
    </Card>
  );
}

function AccountLine({ row }: { row: AccountRow }) {
  const state = stateWord(accountState(row));
  // A computer's own login names its computer in its title already, so the line under it would only say it again.
  const own = row.computers.length === 1 && row.label === accountWords({ agentName: agentName(row.agent), ownOn: row.computers[0] });
  const where = own ? "" : listWords(row.computers);
  const slot =
    state === "" ? undefined : (
      <span data-k="state" className={cn("text-[13px] leading-5", row.status === "reached" ? "text-warning-foreground" : "text-muted-foreground")}>
        {state}
      </span>
    );
  return <Row id={`account-${row.key}`} title={row.label} lead={<HarnessMark harness={row.agent} label={agentName(row.agent)} className="size-4" />} description={where} {...(slot === undefined ? {} : { control: slot })} attrs={{ "data-usage-account": row.key }} />;
}

function Limits({ accounts, now }: { accounts: ReadonlyArray<AccountRow> | null; now: number }) {
  // Until the accounts arrive the card holds one row's room, so nothing moves when they land.
  if (accounts === null)
    return (
      <Card id="usage-limits">
        <div data-k="limits-loading" aria-busy className="h-[68px]" />
      </Card>
    );
  const windowed = accounts.filter(row => (row.windows ?? []).some(w => POOLED_KINDS.includes(w.kind)));
  const agents = [...new Set(windowed.map(row => row.agent))];
  // An agent that reports no limit at all has nothing to read on a row of its own, so it is named once under the list.
  const unlimited = accounts.filter(row => row.note === USAGE_WORDS.noLimit && (row.windows ?? []).length === 0);
  const quiet = accounts.filter(row => !windowed.includes(row) && !unlimited.includes(row));
  const names = [...new Set(unlimited.map(row => agentName(row.agent)))];
  if (accounts.length === 0)
    return (
      <Card id="usage-limits">
        <p data-k="no-accounts" className={cn(QUIET, "px-4 py-3")}>
          {W.noAccounts}
        </p>
      </Card>
    );
  return (
    <div className="flex flex-col gap-10">
      {agents.map(agent => (
        <Pool key={agent} agent={agent} accounts={windowed.filter(row => row.agent === agent)} now={now} />
      ))}
      {quiet.length === 0 && names.length === 0 ? null : (
        <Card
          id="usage-limits"
          head={W.noPlanLimit}
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
          {quiet.map(row => (
            <AccountLine key={row.key} row={row} />
          ))}
        </Card>
      )}
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

/** The agent a split value belongs to, where the split names one: the agent itself, an account by its key's agent,
 * a model by its maker's agent. */
function agentOf(split: UsageSplit, key: string): string | undefined {
  if (split === "agent") return key;
  if (split === "account") return key.split(/[:@]/)[0];
  if ((split as string) === "model") return /^claude|^(opus|sonnet|haiku|fable)/i.test(key) ? "claude" : /^(gpt|o\d|codex)/i.test(key) ? "codex" : undefined;
  return undefined;
}

const NEUTRAL_INKS = ["text-foreground", "text-muted-foreground", "text-muted-foreground/55", "text-muted-foreground/35"];
const BRAND_INK = "[--line:var(--line-light)] dark:[--line:var(--line-dark)] text-(--line)";

/** A line's ink: the agent's own colour where its mark carries one, else a step down the neutral ramp by rank. */
function inkOf(split: UsageSplit, key: string, rank: number): ChartLine["ink"] {
  const agent = agentOf(split, key);
  const ink = agent === undefined ? undefined : agentMark(agent)?.inks?.[0];
  if (ink !== undefined) return { className: BRAND_INK, style: { "--line-light": ink.light, "--line-dark": ink.dark } as CSSProperties };
  return { className: NEUTRAL_INKS[Math.min(rank, NEUTRAL_INKS.length - 1)]! };
}

/** The mark a split row leads with: the agent's, the computer's or the project's glyph, in its frame. */
function SplitMark({ split, rowKey, ctx }: { split: UsageSplit; rowKey: string; ctx: SettingsContext }) {
  const agent = agentOf(split, rowKey);
  if (agent !== undefined && agentMark(agent) !== undefined)
    return (
      <GlyphFrame>
        <HarnessMark harness={agent} label={agentName(agent)} className="size-4" />
      </GlyphFrame>
    );
  if (split === "computer") {
    const place = ctx.places.find(p => p.id === rowKey || p.name === rowKey);
    if (place !== undefined)
      return (
        <GlyphFrame>
          <ComputerGlyph place={place} className="size-4 text-foreground/80" />
        </GlyphFrame>
      );
  }
  if (split === "project" && ctx.projects.some(p => p.id === rowKey))
    return (
      <GlyphFrame>
        <ProjectGlyph projectId={rowKey} />
      </GlyphFrame>
    );
  return null;
}

const sumOf = (rows: readonly UsedRow[], pick: (row: UsedRow) => number | undefined): number | undefined => {
  const picked = rows.map(pick).filter((n): n is number => n !== undefined);
  return picked.length === 0 ? undefined : picked.reduce((a, b) => a + b, 0);
};
/** A row's API estimate: the host's list price over every token where it sends one, else what the row carried. */
const estimateOf = (row: UsedRow): number | undefined => row.estimate ?? (row.costReported === undefined && row.costList === undefined ? undefined : (row.costReported ?? 0) + (row.costList ?? 0));
const percent = (part: number, whole: number): string => (whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`);

function Stat({ k, label, value, note }: { k: string; label: string; value: string; note?: string }) {
  return (
    <div data-k={k} className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-lg leading-6 font-medium text-foreground tabular-nums">{value}</span>
      {note === undefined ? null : <span className="truncate text-[11.5px] text-muted-foreground/80">{note}</span>}
    </div>
  );
}

function Totals({ used }: { used: UsedAnswer }) {
  const input = sumOf(used.rows, r => r.tokens.input) ?? 0;
  const cached = sumOf(used.rows, r => r.tokens.cached) ?? 0;
  const tokens = input + (sumOf(used.rows, r => r.tokens.output) ?? 0);
  const estimate = sumOf(used.rows, estimateOf);
  const turns = sumOf(used.rows, r => r.turns);
  const saved = sumOf(used.rows, r => r.saved);
  const stats = [
    <Stat key="tokens" k="stat-tokens" label={W.tokens} value={fmtTokens(tokens)} note={W.fromCache(percent(cached, input))} />,
    ...(estimate === undefined ? [] : [<Stat key="estimate" k="stat-estimate" label={W.estimate} value={fmtCost(estimate)} note={W.atListPrice} />]),
    ...(used.counts === undefined ? [] : [<Stat key="threads" k="stat-threads" label={W.threads} value={used.counts.threads.toLocaleString("en-US")} note={W.onComputers(used.counts.computers)} />]),
    ...(turns === undefined ? [] : [<Stat key="turns" k="stat-turns" label={W.turns} value={turns.toLocaleString("en-US")} />]),
    <Stat key="cache" k="stat-cache" label={W.cacheHit} value={percent(cached, input)} {...(saved === undefined ? {} : { note: W.saved(fmtCost(saved)) })} />,
  ];
  return (
    <div data-k="usage-totals" className={cn(CARD_SURFACE, "grid divide-x divide-border/50 max-sm:grid-cols-2 max-sm:divide-x-0")} style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
      {stats}
    </div>
  );
}

function Mix({ used }: { used: UsedAnswer }) {
  const input = sumOf(used.rows, r => r.tokens.input) ?? 0;
  const cached = sumOf(used.rows, r => r.tokens.cached) ?? 0;
  const write = sumOf(used.rows, r => r.tokens.cacheWrite);
  const out = sumOf(used.rows, r => r.tokens.output) ?? 0;
  const parts = [
    { k: "fresh", label: W.fresh, n: Math.max(0, input - cached - (write ?? 0)), ink: "bg-primary" },
    ...(write === undefined ? [] : [{ k: "cache-write", label: W.cacheWrite, n: write, ink: "bg-primary/50" }]),
    { k: "cached", label: W.cached, n: cached, ink: "bg-foreground/20" },
    { k: "out", label: W.out, n: out, ink: "bg-foreground/80" },
  ];
  const all = parts.reduce((a, p) => a + p.n, 0);
  if (all === 0) return null;
  return (
    <div data-k="usage-mix" className="flex flex-col gap-3">
      <div aria-hidden className="flex h-2.5 gap-0.5 overflow-hidden rounded-[4px]">
        {parts.map(p => (p.n === 0 ? null : <span key={p.k} className={p.ink} style={{ width: `${(p.n / all) * 100}%`, minWidth: 2 }} />))}
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted-foreground">
        {parts.map(p => (
          <span key={p.k} data-k={`mix-${p.k}`} className="flex items-center gap-2">
            <span aria-hidden className={cn("size-2 rounded-[2px]", p.ink)} />
            {p.label}
            <span className="font-mono text-foreground tabular-nums">{fmtTokens(p.n)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const SPLIT_COLUMNS = "grid grid-cols-[minmax(0,1fr)_88px_76px_64px_96px] gap-x-4 max-sm:grid-cols-[minmax(0,1fr)_72px_88px]";
const SPLIT_COLUMNS_NO_TURNS = "grid grid-cols-[minmax(0,1fr)_88px_76px_96px] gap-x-4 max-sm:grid-cols-[minmax(0,1fr)_72px_88px]";

function SplitRow({ row, split, share, turns, sub = false, ctx }: { row: UsedRow; split: UsageSplit; share: number; turns: boolean; sub?: boolean; ctx: SettingsContext }) {
  const estimate = estimateOf(row);
  return (
    <div data-used-row={row.key} {...(sub ? { "data-sub": "" } : {})} className={cn(turns ? SPLIT_COLUMNS : SPLIT_COLUMNS_NO_TURNS, "items-center px-4", sub ? "py-2" : "py-3")}>
      <span className={cn("flex min-w-0 items-center gap-3", sub && "ps-11")}>
        {sub ? null : <SplitMark split={split} rowKey={row.key} ctx={ctx} />}
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span data-k="label" className={cn("min-w-0 truncate leading-5", sub ? "text-[13px] text-foreground/80" : "text-sm text-foreground")}>
            {row.label}
          </span>
          <span aria-hidden className="block h-1 max-w-48 overflow-hidden rounded-full bg-foreground/[0.08]">
            <span className="block h-full rounded-full bg-foreground/45" style={{ width: `${Math.max(1, share * 100)}%` }} />
          </span>
        </span>
      </span>
      <span data-k="tokens" className={cn(NUMBER, "text-right text-foreground")}>
        {fmtTokens(row.tokens.input + row.tokens.output)}
      </span>
      <span data-k="cache-hit" className={cn(NUMBER, "text-right text-muted-foreground", WIDE_ONLY)}>
        {percent(row.tokens.cached, row.tokens.input)}
      </span>
      {turns ? (
        <span data-k="turns" className={cn(NUMBER, "text-right text-muted-foreground", WIDE_ONLY)}>
          {row.turns === undefined ? "" : row.turns.toLocaleString("en-US")}
        </span>
      ) : null}
      <span data-k="price" className={cn(NUMBER, "text-right", estimate === undefined ? "text-muted-foreground" : "text-foreground")}>
        {estimate === undefined ? USAGE_WORDS.notPriced : fmtCost(estimate)}
      </span>
    </div>
  );
}

function TopThreads({ used }: { used: UsedAnswer }) {
  const select = useStore(s => s.select);
  const closeSettings = useStore(s => s.closeSettings);
  if (used.threads === undefined || used.threads.length === 0) return null;
  return (
    <Card id="usage-threads" head={W.topThreads}>
      {used.threads.map(thread => (
        <button
          key={thread.threadId}
          type="button"
          data-usage-thread={thread.threadId}
          onClick={() => {
            select(thread.workspaceId, thread.threadId);
            closeSettings();
          }}
          className="grid w-full grid-cols-[minmax(0,1fr)_112px_72px_84px_16px] items-center gap-x-4 px-4 py-3 text-left transition-colors duration-150 hover:bg-accent/60 max-sm:grid-cols-[minmax(0,1fr)_72px_16px]"
        >
          <span className="flex min-w-0 items-center gap-3">
            <HarnessMark harness={thread.agent} label={agentName(thread.agent)} className="size-4" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm leading-5 text-foreground">{thread.title}</span>
              {thread.workspace === undefined ? null : <span className="truncate text-xs text-muted-foreground">{thread.workspace}</span>}
            </span>
          </span>
          <span className={cn("truncate text-right text-[13px] text-muted-foreground", WIDE_ONLY)}>{thread.computer ?? ""}</span>
          <span className={cn(NUMBER, "text-right text-foreground")}>{fmtTokens(thread.tokens)}</span>
          <span className={cn(NUMBER, "text-right text-foreground", WIDE_ONLY)}>{thread.estimate === undefined ? "" : fmtCost(thread.estimate)}</span>
          <ArrowUpRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
        </button>
      ))}
    </Card>
  );
}

function Sources({ used }: { used: UsedAnswer }) {
  if (used.sources === undefined || used.sources.length === 0) return null;
  return (
    <Card id="usage-sources" head={W.sources}>
      {used.sources.map(source => (
        <div key={source.source} data-usage-source={source.source} className="grid grid-cols-[minmax(0,1fr)_96px_96px] items-center gap-x-4 px-4 py-3">
          <span className="text-sm leading-5 text-foreground">{source.source === "wsp" ? W.fromWsp : W.fromLogs}</span>
          <span className={cn(NUMBER, "text-right text-foreground")}>{fmtTokens(source.tokens)}</span>
          <span className={cn(NUMBER, "text-right text-foreground")}>{source.estimate === undefined ? "" : fmtCost(source.estimate)}</span>
        </div>
      ))}
    </Card>
  );
}

function Used({ used, models, range, split, onRange, onSplit, ctx }: { used: UsedAnswer | null; models: readonly UsedRow[]; range: UsageRange; split: UsageSplit; onRange: (r: UsageRange) => void; onSplit: (s: UsageSplit) => void; ctx: SettingsContext }) {
  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <SegmentedControl data-k="usage-range" aria-label={W.range} value={range} segments={RANGES} onChange={onRange} />
      <SegmentedControl data-k="usage-split" aria-label={W.split} value={split} segments={SPLITS} onChange={onSplit} />
    </div>
  );
  if (used === null) return <section data-usage-section="used" aria-label={W.used} className="flex flex-col gap-8">{controls}</section>;
  const tokensOf = (row: UsedRow): number => row.tokens.input + row.tokens.output;
  const ranked = [...used.rows].sort((a, b) => tokensOf(b) - tokensOf(a));
  const top = tokensOf(ranked[0] ?? { tokens: { input: 0, output: 0, cached: 0 } } as UsedRow);
  const word = stepWord(used);
  const lineRows = used.lines ?? [{ key: "tokens", label: W.tokens, points: used.series.map(s => s.tokens) }];
  const lines: ChartLine[] = lineRows.map((line, rank) => ({ key: line.key, label: line.label, points: line.points, ink: used.lines === undefined ? { className: "text-foreground" } : inkOf(split, line.key, rank) }));
  const empty = ranked.length === 0;
  const turns = used.rows.some(r => r.turns !== undefined);
  const nestedHead = used.split === "agent" && models.length > 0;
  return (
    <section data-usage-section="used" aria-label={W.used} className="flex flex-col gap-10">
      {controls}
      {empty ? (
        <p data-k="no-use" className={cn(QUIET, "py-10 text-center")}>
          {USAGE_WORDS.noUse}
        </p>
      ) : (
        <>
          <Totals used={used} />
          <Card id="usage-chart" head={W.chartHead[used.range]}>
            <div className="flex flex-col gap-4 px-4 pt-4 pb-3">
              {used.lines === undefined ? (
                <div data-k="usage-legend" className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-0.5 w-3.5 rounded-full bg-foreground" />
                    {W.allOf[used.split]}
                  </span>
                </div>
              ) : (
                <div data-k="usage-legend" className="flex flex-wrap gap-x-5 gap-y-1.5 text-[12.5px] text-muted-foreground">
                  {lines.map(line => {
                    const agent = agentOf(split, line.key);
                    return (
                      <span key={line.key} className="flex items-center gap-2">
                        <span aria-hidden className={cn("h-0.5 w-3.5 rounded-full bg-current", line.ink.className)} style={line.ink.style} />
                        {agent === undefined || agentMark(agent) === undefined ? null : <HarnessMark harness={agent} label={agentName(agent)} className="size-3" />}
                        {line.label}
                      </span>
                    );
                  })}
                </div>
              )}
              <UsageChart steps={used.series.map(s => s.t)} lines={lines} stepWord={t => word.format(t)} ticks={ticksOf(used)} />
            </div>
          </Card>
          <Card id="usage-used" head={W.by(W.splits[used.split])}>
            <div data-k="used-head" className={cn(turns ? SPLIT_COLUMNS : SPLIT_COLUMNS_NO_TURNS, "px-4 py-2.5 text-xs leading-4 text-muted-foreground")}>
              <span data-k="split-head">{nestedHead ? W.agentAndModel : W.splits[used.split]}</span>
              <span className="text-right">{W.tokens}</span>
              <span className={cn("text-right", WIDE_ONLY)}>{W.cacheHit}</span>
              {turns ? <span className={cn("text-right", WIDE_ONLY)}>{W.turns}</span> : null}
              <span className="text-right">{W.estimate}</span>
            </div>
            {ranked.map(row => {
              const own = used.split === "agent" ? models.filter(m => agentOf("model" as UsageSplit, m.key) === row.key).sort((a, b) => tokensOf(b) - tokensOf(a)) : [];
              return (
                <div key={row.key} data-used-group={row.key} className="flex flex-col pb-1 [&>[data-sub]]:-mt-0.5">
                  <SplitRow row={row} split={used.split} share={top === 0 ? 0 : tokensOf(row) / top} turns={turns} ctx={ctx} />
                  {own.map(model => (
                    <SplitRow key={model.key} row={model} split={"model" as UsageSplit} share={tokensOf(row) === 0 ? 0 : tokensOf(model) / tokensOf(row)} turns={turns} sub ctx={ctx} />
                  ))}
                </div>
              );
            })}
          </Card>
          <section data-settings-card="usage-mix-card" aria-label={W.mix} className="flex flex-col gap-4">
            <h2 data-settings-head className="flex min-h-7 items-center text-sm font-normal text-foreground/70">
              {W.mix}
            </h2>
            <Mix used={used} />
          </section>
          <TopThreads used={used} />
          <Sources used={used} />
          {used.logs === undefined ? null : (
            <p data-k="logs" className={QUIET}>
              {logsLine(used.logs)}
            </p>
          )}
        </>
      )}
    </section>
  );
}
