// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage, two tabs. Usage: what the turns used over a range, as
// totals, one line per split value, the split as a table, the token mix, the
// threads that used the most and where it was read. Limits: each account with
// what its agent last said of its plan's windows. The accounts and the tokens
// are two ledgers and are never summed.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { agentMark, agentName } from "@wsp/catalog";
import { BoxIcon, ChartLineIcon, CircleDashedIcon, GaugeIcon, MonitorIcon, UserRoundIcon } from "lucide-react";
import { USAGE_RANGES, USAGE_SPLITS, USAGE_WORDS, accountState, accountWords, creditsWord, resetQuestion, fmtCost, fmtTokens, listWords, logsLine, resetsWord, type AccountRow, type AccountsAnswer, type LimitKind, type UsageRange, type UsageSplit, type UsedAnswer, type UsedRow } from "@wsp/protocol";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../components/ui/button.js";
import { addNotice, noticeFailure } from "../notices/store.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { PROJECT_HUES, ProjectGlyph } from "../projects/look.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { ABOUT_WORDS, RESET_LINE_WORDS, USAGE_PAGE_WORDS as W } from "./format.js";
import { GlyphFrame } from "./grid.js";
import { CARD_SURFACE, Card, type SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore, type UsageTab } from "./settingsStore.js";
import { CHART_HEIGHT, UsageChart, type ChartLine } from "./usageChart.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { DigitRoll } from "../components/ui/digit-roll.js";

const NUMBER = "font-mono text-xs tabular-nums";
const ROW_NUMBER = "font-mono text-sm tabular-nums";
/** A table on this page: a hairline under its head and between its rows, no box, its text on the page's edge. */
const BARE_TABLE = "flex flex-col border-b border-border/50 [&>*]:border-t [&>*]:border-border/50";
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
    <div key={tab} className="flex animate-settle-in flex-col gap-8 motion-reduce:animate-none">
      {tab === "limits" ? <Limits accounts={accounts?.accounts ?? null} now={ctx.now} onAccount={row => setAccounts(held => (held === null ? held : { ...held, accounts: held.accounts.map(a => (a.key === row.key ? row : a)) }))} /> : <Used used={used} models={models} range={range} split={split} onRange={setRange} onSplit={setSplit} ctx={ctx} />}
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

/** One window of a pool: what is left as its big figure with the verdict under it, and beside them a segment per
 * account filled by what it has used, the even-pace mark on each. */
function PoolWindow({ kind, segments, now }: { kind: LimitKind; segments: readonly Segment[]; now: number }) {
  const used = Math.round(segments.reduce((n, s) => n + Math.min(100, s.used), 0) / segments.length);
  const verdict = verdictOf(segments, kind, now);
  return (
    <div data-window={kind} className="grid grid-cols-[minmax(11rem,14rem)_minmax(0,1fr)] items-center gap-x-10 py-4 max-sm:grid-cols-1 max-sm:gap-y-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span data-k="window" className="text-[12.5px] leading-5 text-muted-foreground">
          {W.windows[kind] ?? kind}
        </span>
        <span className="flex items-baseline gap-2">
          <DigitRoll value={`${Math.max(0, 100 - used)}%`} className="font-mono text-2xl leading-8 font-medium text-foreground" data-k="left" />
          <span className="text-[12.5px] text-muted-foreground">{W.left}</span>
        </span>
        <span data-k="verdict" className={cn("truncate text-[12.5px] leading-5", verdict.tone === "warn" ? "text-warning-foreground" : verdict.tone === "quiet" ? "text-muted-foreground" : "text-foreground/80")}>
          {verdict.word}
        </span>
      </div>
      <span className="flex h-5 gap-1">
        {segments.map(s => (
          <Tooltip key={s.account.key}>
            <TooltipTrigger delay={0} render={<span data-k="segment" className="relative flex-1 overflow-visible rounded-[5px] bg-foreground/[0.09]" />}>
              <span data-k="meter-fill" className={cn("absolute inset-y-0 left-0 rounded-[5px] transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", s.used >= 90 ? "bg-warning" : "bg-foreground/55")} style={{ width: `${Math.min(100, Math.max(0, s.used))}%` }} />
              {s.elapsed === undefined ? null : <span data-k="pace" aria-hidden className="absolute -inset-y-1 w-0.5 rounded-full bg-foreground/80" style={{ left: `${s.elapsed * 100}%` }} />}
            </TooltipTrigger>
            <TooltipPopup side="top" sideOffset={8}>
              <span className="flex flex-col gap-0.5 text-xs">
                <span className="text-foreground">{s.account.label}</span>
                <span className="font-mono text-muted-foreground tabular-nums">{`${Math.round(s.used)}% used${s.resetsAt === undefined ? "" : `, ${resetsWord(s.resetsAt, now)}`}`}</span>
              </span>
            </TooltipPopup>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}

/** One agent's subscription accounts as a pool: who they are, what they draw now, and one line per window. */
/** One account's banked resets under its pool's head, and Use reset where one is banked: it asks the one question the
 * command line asks, spends on yes, says what the host answered and puts the row it sends back in place. */
function ResetLine({ row, now, onAccount }: { row: AccountRow; now: number; onAccount: (row: AccountRow) => void }) {
  const api = useStore(s => s.api);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const credits = row.credits;
  if (credits === undefined) return null;
  const use = (): void => {
    if (api?.usageReset === undefined) return;
    setBusy(true);
    void api
      .usageReset(row.key)
      .then(
        answer => {
          addNotice({ kind: answer.outcome === "reset" ? "note" : "error", text: answer.said });
          if (answer.account !== undefined) onAccount(answer.account);
        },
        noticeFailure,
      )
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };
  return (
    <div data-usage-resets={row.key} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 pt-3 text-[12.5px] text-muted-foreground">
      <span className="flex min-w-0 items-baseline gap-2">
        <span>{RESET_LINE_WORDS.resets}</span>
        <span data-k="banked" className="font-mono text-foreground/80 tabular-nums">
          {creditsWord(credits, now)}
        </span>
      </span>
      {credits.count === 0 || api?.usageReset === undefined ? null : (
        <Button variant="outline" size="xs" data-k="use-reset" disabled={busy} onClick={() => setAsking(true)}>
          {busy ? RESET_LINE_WORDS.using : RESET_LINE_WORDS.use}
        </Button>
      )}
      <AlertDialog open={asking} onOpenChange={open => !busy && setAsking(open)}>
        <AlertDialogPopup data-reset-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle data-k="reset-title">{RESET_LINE_WORDS.use}</AlertDialogTitle>
            <AlertDialogDescription data-k="reset-question">{resetQuestion(row.label, credits.count)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{RESET_LINE_WORDS.cancel}</AlertDialogClose>
            <Button data-k="reset-confirm" disabled={busy} onClick={use}>
              {busy ? RESET_LINE_WORDS.using : RESET_LINE_WORDS.use}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function Pool({ agent, accounts, now, onAccount }: { agent: string; accounts: readonly AccountRow[]; now: number; onAccount: (row: AccountRow) => void }) {
  const kinds = POOLED_KINDS.filter(kind => accounts.some(a => a.windows?.some(w => w.kind === kind)));
  const computers = [...new Set(accounts.flatMap(a => a.computers))];
  const title = accounts.length === 1 ? accounts[0]!.label : W.accounts(accounts.length, agentName(agent));
  const burn = accounts.reduce((n, a) => n + (a.burn?.tokensPerMinute ?? 0), 0);
  const threads = accounts.reduce((n, a) => n + (a.burn?.threads ?? 0), 0);
  const readAt = Math.min(...accounts.map(a => a.readAt ?? now));
  return (
    <Card id={`usage-pool-${agent}`} head={agentName(agent)}>
      <div data-usage-pool={agent} className={cn("flex flex-col pt-5", CARD_PAD)}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <Identity mark={agentGlyph(agent)} title={title} line={listWords(computers)} />
          <span className="flex flex-wrap items-center gap-x-5 text-[12.5px] text-muted-foreground">
            {burn > 0 ? <span data-k="burn">{W.burn(fmtTokens(burn), threads)}</span> : null}
            <span data-k="read-at">{W.checked(ABOUT_WORDS.readWhen(Math.max(0, now - readAt)))}</span>
          </span>
        </div>
        {accounts.map(row => (
          <ResetLine key={row.key} row={row} now={now} onAccount={onAccount} />
        ))}
        <div className="mt-2 flex flex-col [&>*]:border-t [&>*]:border-border/50">
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
  return (
    <div data-usage-account={row.key} className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-5", CARD_PAD)}>
      <Identity mark={agentGlyph(row.agent)} title={row.label} line={where} />
      {state === "" ? null : (
        <span data-k="state" className={cn("text-[13px] leading-5", row.status === "reached" ? "text-warning-foreground" : "text-muted-foreground")}>
          {state}
        </span>
      )}
    </div>
  );
}

function Limits({ accounts, now, onAccount }: { accounts: ReadonlyArray<AccountRow> | null; now: number; onAccount: (row: AccountRow) => void }) {
  // Until the accounts arrive the card holds one row's room, so nothing moves when they land.
  if (accounts === null) return <LimitsSkeleton />;
  const windowed = accounts.filter(row => (row.windows ?? []).some(w => POOLED_KINDS.includes(w.kind)));
  const agents = [...new Set(windowed.map(row => row.agent))];
  // An agent that reports no limit at all has nothing to read on a row of its own, so it is named once under the list.
  const unlimited = accounts.filter(row => row.note === USAGE_WORDS.noLimit && (row.windows ?? []).length === 0);
  const quiet = accounts.filter(row => !windowed.includes(row) && !unlimited.includes(row));
  const names = [...new Set(unlimited.map(row => agentName(row.agent)))];
  if (accounts.length === 0)
    return (
      <Card id="usage-limits">
        <p data-k="no-accounts" className={cn(QUIET, CARD_PAD, "py-5")}>
          {W.noAccounts}
        </p>
      </Card>
    );
  return (
    <div className="flex flex-col gap-10">
      {agents.map(agent => (
        <Pool key={agent} agent={agent} accounts={windowed.filter(row => row.agent === agent)} now={now} onAccount={onAccount} />
      ))}
      {quiet.length === 0 && names.length === 0 ? null : (
        <Card
          id="usage-limits"
          head={W.noPlanLimit}
          {...(names.length === 0
            ? {}
            : {
                under: (
                  <p data-k="no-limit" className={cn(QUIET, CARD_PAD)}>
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

/** The inset every card on this page keeps its content at. */
const CARD_PAD = "px-5";

/** The page's one way of naming a thing: its mark in a frame, its title, and under it a line or a figure. Pools,
 * accounts, split rows and threads all name themselves this way, so they read at one size. */
function Identity({ mark, title, line, under }: { mark: ReactNode; title: string; line?: string; under?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      {mark === null ? null : <GlyphFrame>{mark}</GlyphFrame>}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-settings-title className="truncate text-[15px] leading-6 font-medium text-foreground">
          {title}
        </span>
        {line === undefined || line === "" ? null : (
          <span data-settings-description className="truncate text-[13px] leading-5 text-muted-foreground">
            {line}
          </span>
        )}
        {under}
      </span>
    </span>
  );
}

const agentGlyph = (agent: string): ReactNode => <HarnessMark harness={agent} label={agentName(agent)} className="size-4" />;

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

/** The hues a computer, an account or a project takes by rank: none of them orange, Claude's, nor the done and failed
 * greens and reds; past them the neutral ramp. */
const SPLIT_INKS = ["text-sky-500", "text-violet-500", "text-amber-500", "text-pink-500", "text-teal-500", "text-muted-foreground"];
const BRAND_INK = "[--line:var(--line-light)] dark:[--line:var(--line-dark)] text-(--line)";

/** A line's ink: the agent's own colour where its mark carries one, a project's own hue where one was picked, else
 * the next hue by rank. */
function inkOf(split: UsageSplit, key: string, rank: number, projectHue?: string): ChartLine["ink"] {
  const agent = agentOf(split, key);
  const ink = agent === undefined ? undefined : agentMark(agent)?.inks?.[0];
  if (ink !== undefined) return { className: BRAND_INK, style: { "--line-light": ink.light, "--line-dark": ink.dark } as CSSProperties };
  if (projectHue !== undefined && projectHue !== "") return { className: projectHue };
  return { className: agent === undefined ? SPLIT_INKS[Math.min(rank, SPLIT_INKS.length - 1)]! : "text-muted-foreground" };
}

/** The mark a split row leads with: the agent's, the computer's or the project's glyph, in its frame. */
/** The glyph a split row leads with: the agent's, the computer's or the project's; null where the value has none. */
function splitGlyph(split: UsageSplit, key: string, ctx: SettingsContext): ReactNode {
  const agent = agentOf(split, key);
  if (agent !== undefined && agentMark(agent) !== undefined) return agentGlyph(agent);
  if (split === "computer") {
    const place = ctx.places.find(p => p.id === key || p.name === key);
    if (place !== undefined) return <ComputerGlyph place={place} className="size-4 text-foreground/80" />;
  }
  if (split === "project" && ctx.projects.some(p => p.id === key)) return <ProjectGlyph projectId={key} />;
  // A value with no glyph of its own still takes a frame, so every row's name starts at one edge.
  const Fallback = FALLBACK_GLYPHS[split as keyof typeof FALLBACK_GLYPHS];
  return Fallback === undefined ? null : <Fallback aria-hidden className="size-4 text-muted-foreground" />;
}

/** The glyph a split value with none of its own takes: use filed under no project reads as none. */
const FALLBACK_GLYPHS = { project: CircleDashedIcon, computer: MonitorIcon, account: UserRoundIcon, model: BoxIcon, agent: BoxIcon };

const sumOf = (rows: readonly UsedRow[], pick: (row: UsedRow) => number | undefined): number | undefined => {
  const picked = rows.map(pick).filter((n): n is number => n !== undefined);
  return picked.length === 0 ? undefined : picked.reduce((a, b) => a + b, 0);
};
/** A row's API estimate: the host's list price over every token where it sends one, else what the row carried. */
const estimateOf = (row: UsedRow): number | undefined => row.estimate ?? (row.costReported === undefined && row.costList === undefined ? undefined : (row.costReported ?? 0) + (row.costList ?? 0));
const percent = (part: number, whole: number): string => (whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`);

function Stat({ k, label, value, note }: { k: string; label: string; value: string; note?: string }) {
  return (
    <div data-k={k} className="flex min-w-0 flex-col gap-1.5 px-5 py-5">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <DigitRoll value={value} className="font-mono text-[26px] leading-8 font-medium text-foreground" />
      {note === undefined ? null : <span className="truncate text-xs text-muted-foreground">{note}</span>}
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
    ...(turns === undefined ? [] : [<Stat key="turns" k="stat-turns" label={W.turns} value={turns.toLocaleString("en-US")} note={W.turnsNote} />]),
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
      <div aria-hidden className="flex h-3 gap-0.5 overflow-hidden rounded-[4px]">
        {parts.map(p => (p.n === 0 ? null : <span key={p.k} className={p.ink} style={{ width: `${(p.n / all) * 100}%`, minWidth: 2 }} />))}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-muted-foreground">
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

const SPLIT_COLUMNS = "grid grid-cols-[minmax(0,1fr)_104px_96px_80px_120px] gap-x-6 max-sm:grid-cols-[minmax(0,1fr)_72px_88px] max-sm:gap-x-4";
const SPLIT_COLUMNS_NO_TURNS = "grid grid-cols-[minmax(0,1fr)_104px_96px_120px] gap-x-6 max-sm:grid-cols-[minmax(0,1fr)_72px_88px] max-sm:gap-x-4";

function SplitRow({ row, split, share, turns, ink, sub = false, ctx }: { row: UsedRow; split: UsageSplit; share: number; turns: boolean; ink?: ChartLine["ink"]; sub?: boolean; ctx: SettingsContext }) {
  const estimate = estimateOf(row);
  return (
    <div data-used-row={row.key} {...(sub ? { "data-sub": "" } : {})} className={cn(turns ? SPLIT_COLUMNS : SPLIT_COLUMNS_NO_TURNS, "items-center", sub ? "py-2.5" : "py-4")}>
      {sub ? (
        <span className="flex min-w-0 flex-col gap-1.5 ps-11">
          <span data-k="label" className="min-w-0 truncate text-sm leading-5 text-foreground/80">
            {row.label}
          </span>
        </span>
      ) : (
        <Identity
          mark={splitGlyph(split, row.key, ctx)}
          title={row.label}
          under={
            <span aria-hidden className="mt-1 block h-1 max-w-64 overflow-hidden rounded-full bg-foreground/[0.08]">
              <span className={cn("block h-full rounded-full bg-current transition-[width] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none", ink === undefined ? "text-foreground/45" : ink.className)} style={{ ...ink?.style, width: `${Math.max(1, share * 100)}%` }} />
            </span>
          }
        />
      )}
      <span data-k="tokens" className={cn(ROW_NUMBER, "text-right text-foreground")}>
        {fmtTokens(row.tokens.input + row.tokens.output)}
      </span>
      <span data-k="cache-hit" className={cn(ROW_NUMBER, "text-right text-muted-foreground", WIDE_ONLY)}>
        {percent(row.tokens.cached, row.tokens.input)}
      </span>
      {turns ? (
        <span data-k="turns" className={cn(ROW_NUMBER, "text-right text-muted-foreground", WIDE_ONLY)}>
          {row.turns === undefined ? "" : row.turns.toLocaleString("en-US")}
        </span>
      ) : null}
      <span data-k="price" className={cn(ROW_NUMBER, "text-right", estimate === undefined ? "text-muted-foreground" : "text-foreground")}>
        {estimate === undefined ? USAGE_WORDS.notPriced : fmtCost(estimate)}
      </span>
    </div>
  );
}

/** The Usage tab while its answer is on the way, in the loaded page's own shape and heights so nothing moves when
 * it lands. */
function UsedSkeleton({ range }: { range: UsageRange }) {
  return (
    <div data-k="used-loading" aria-busy className="flex flex-col gap-10">
      <div className={cn(CARD_SURFACE, "grid grid-cols-4 divide-x divide-border/50 max-sm:grid-cols-2 max-sm:divide-x-0")}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="flex flex-col gap-1.5 px-5 py-5">
            <Skeleton className="my-1 h-3 w-16" />
            <Skeleton className="my-0.5 h-7 w-28" />
            <Skeleton className="my-0.5 h-3 w-24" />
          </div>
        ))}
      </div>
      <section className="flex flex-col gap-4">
        <h2 data-settings-head className="flex min-h-7 items-center text-sm font-normal text-foreground/70">
          {W.chartHead[range]}
        </h2>
        <div className="flex gap-6">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 gap-y-3">
          <span className="flex flex-col justify-between py-1" style={{ height: CHART_HEIGHT }}>
            {[0, 1, 2, 3, 4].map(i => (
              <Skeleton key={i} className="h-2.5 w-8" />
            ))}
          </span>
          <Skeleton className="rounded-md opacity-60" style={{ height: CHART_HEIGHT }} />
          <span />
          <span className="h-4" />
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <Skeleton className="h-3.5 w-20" />
        <div className={BARE_TABLE}>
          <div className="py-3">
            <Skeleton className="h-3 w-24" />
          </div>
          {[0, 1].map(i => (
            <div key={i} className="flex items-center gap-3 py-4">
              <Skeleton className="size-8 rounded-md" />
              <span className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-1 w-48" />
              </span>
              <Skeleton className="h-3.5 w-16" />
              <Skeleton className="ms-6 h-3.5 w-20" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** The Limits tab while the accounts are on the way: one pool's card with two windows, as most people have. */
function LimitsSkeleton() {
  return (
    <div data-k="limits-loading" aria-busy className="flex flex-col gap-4">
      <Skeleton className="h-3.5 w-16" />
      <div className={cn(CARD_SURFACE, "flex flex-col gap-4 px-4 py-4")}>
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-md" />
          <span className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-28" />
          </span>
        </div>
        {[0, 1].map(i => (
          <div key={i} className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem_minmax(0,10rem)] items-center gap-x-4">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-2.5" />
            <Skeleton className="ms-auto h-3 w-8" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Used({ used, models, range, split, onRange, onSplit, ctx }: { used: UsedAnswer | null; models: readonly UsedRow[]; range: UsageRange; split: UsageSplit; onRange: (r: UsageRange) => void; onSplit: (s: UsageSplit) => void; ctx: SettingsContext }) {
  const controls = (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <SegmentedControl data-k="usage-range" aria-label={W.range} value={range} segments={RANGES} onChange={onRange} className="h-9" segmentClassName="px-3.5 text-sm" />
      <SegmentedControl data-k="usage-split" aria-label={W.split} value={split} segments={SPLITS} onChange={onSplit} className="h-9" segmentClassName="px-3.5 text-sm" />
    </div>
  );
  if (used === null)
    return (
      <section data-usage-section="used" aria-label={W.used} className="flex flex-col gap-10">
        {controls}
        <UsedSkeleton range={range} />
      </section>
    );
  const tokensOf = (row: UsedRow): number => row.tokens.input + row.tokens.output;
  const ranked = [...used.rows].sort((a, b) => tokensOf(b) - tokensOf(a));
  const top = tokensOf(ranked[0] ?? { tokens: { input: 0, output: 0, cached: 0 } } as UsedRow);
  const word = stepWord(used);
  const lineRows = used.lines ?? [{ key: "tokens", label: W.tokens, points: used.series.map(s => s.tokens) }];
  const hueOf = (key: string): string | undefined => (split === "project" ? PROJECT_HUES[ctx.preferences.projectLook[key]?.hue ?? "neutral"].text : undefined);
  // A hue a project picked is that project's alone, so the hues handed out by rank skip it; use with no project is grey.
  const picked = new Set(lineRows.map(line => hueOf(line.key)).filter((hue): hue is string => hue !== undefined && hue !== ""));
  const free = SPLIT_INKS.filter(hue => !picked.has(hue));
  let next = 0;
  const lines: ChartLine[] = lineRows.map(line => {
    if (used.lines === undefined) return { key: line.key, label: line.label, points: line.points, ink: { className: "text-foreground" } };
    const unowned = split === "project" && !ctx.projects.some(p => p.id === line.key);
    const own = hueOf(line.key);
    const ink = unowned ? { className: "text-muted-foreground" } : own !== undefined && own !== "" ? { className: own } : agentOf(split, line.key) !== undefined ? inkOf(split, line.key, 0) : { className: free[Math.min(next++, free.length - 1)]! };
    return { key: line.key, label: line.label, points: line.points, ink };
  });
  const inkByKey = new Map(used.lines === undefined ? [] : lines.map(line => [line.key, line.ink] as const));
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
          <Card
            id="usage-chart"
            head={W.chartHead[used.range]}
            body={<div className="flex flex-col gap-4">
              {used.lines === undefined ? (
                <div data-k="usage-legend" className="flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-0.5 w-3.5 rounded-full bg-foreground" />
                    {W.allOf[used.split]}
                  </span>
                </div>
              ) : (
                <div data-k="usage-legend" className="flex flex-wrap gap-x-6 gap-y-2 text-[13.5px] text-muted-foreground">
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
            </div>}
          />
          <Card
            id="usage-used"
            head={W.by(W.splits[used.split])}
            body={
              <div className={BARE_TABLE}>
            <div data-k="used-head" className={cn(turns ? SPLIT_COLUMNS : SPLIT_COLUMNS_NO_TURNS, "py-3 text-[13px] leading-4 text-muted-foreground")}>
              <span data-k="split-head">{nestedHead ? W.agentAndModel : W.splits[used.split]}</span>
              <span className="text-right">{W.tokens}</span>
              <span className={cn("text-right", WIDE_ONLY)}>{W.cacheHit}</span>
              {turns ? <span className={cn("text-right", WIDE_ONLY)}>{W.turns}</span> : null}
              <span className="text-right">{W.estimate}</span>
            </div>
            {ranked.map((row, i) => {
              const own = used.split === "agent" ? models.filter(m => agentOf("model" as UsageSplit, m.key) === row.key).sort((a, b) => tokensOf(b) - tokensOf(a)) : [];
              return (
                <div key={`${used.split}:${row.key}`} data-used-group={row.key} className="flex animate-settle-in flex-col pb-1 motion-reduce:animate-none [&>[data-sub]]:-mt-0.5" style={{ animationDelay: `${Math.min(i, 6) * 30}ms` }}>
                  <SplitRow row={row} split={used.split} share={top === 0 ? 0 : tokensOf(row) / top} turns={turns} {...(inkByKey.has(row.key) ? { ink: inkByKey.get(row.key)! } : {})} ctx={ctx} />
                  {own.map(model => (
                    <SplitRow key={model.key} row={model} split={"model" as UsageSplit} share={tokensOf(row) === 0 ? 0 : tokensOf(model) / tokensOf(row)} turns={turns} sub ctx={ctx} />
                  ))}
                </div>
              );
            })}
              </div>
            }
          />
          <section data-settings-card="usage-mix-card" aria-label={W.mix} className="flex flex-col gap-4">
            <h2 data-settings-head className="flex min-h-7 items-center text-sm font-normal text-foreground/70">
              {W.mix}
            </h2>
            <Mix used={used} />
          </section>
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
