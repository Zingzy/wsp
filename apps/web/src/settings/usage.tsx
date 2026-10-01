// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Usage, three lists in the settings list grammar: each account
// with what its agent last said of its limits, what the person's turns used
// over a range split one way under one line chart of the tokens, and each
// computer's CPU, memory and disk over the same range as three small line
// charts. The accounts and the tokens are two ledgers and are never summed.
import { useEffect, useState, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { USAGE_RANGES, USAGE_SPLITS, USAGE_WORDS, accountState, fmtMemGb, fmtTokens, isProviderPlace, resetsWord, usedPrice, type AccountRow, type AccountsAnswer, type LimitKind, type PlaceView, type ReadingsAnswer, type SysPoint, type UsageRange, type UsageSplit, type UsedAnswer } from "@wsp/protocol";
import { ChartPlot, spanPoints } from "../components/machine/MachineSurface.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { SegmentedControl } from "../components/ui/segmented-control.js";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { ComputerGlyph } from "./ComputerGlyph.js";
import { USAGE_PAGE_WORDS as W } from "./format.js";
import { placeName } from "./places.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

const FRAME = "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.04]";
const HEAD = cn("flex h-6 items-center text-muted-foreground", GROUP_LABEL);
const LIST = "-mx-2 flex flex-col gap-0.5";
const ROW = "flex h-13 items-center gap-4 rounded-lg px-2";
const NAME = "truncate text-sm leading-5 text-foreground";
const NOTE = "truncate text-[11px] leading-[14px] text-muted-foreground";
const NUMBER = "font-mono text-xs tabular-nums text-foreground";
const QUIET = "text-[13px] leading-5 text-muted-foreground";
const WINDOW_KINDS: readonly LimitKind[] = ["session", "week"];
const ACCOUNT_COLUMNS = "grid grid-cols-[minmax(0,1fr)_128px_128px_56px_120px] gap-x-4";
const USED_COLUMNS = "grid grid-cols-[minmax(0,1fr)_64px_64px_64px_96px] gap-x-4";
const COMPUTER_COLUMNS = "grid grid-cols-[minmax(0,1fr)_repeat(3,128px)] gap-x-4";

/** A state word as the page draws it, capitalised: the wire's words are the command line's, in its lower case. */
const stateWord = (word: string): string => (word === "" ? "" : word[0]!.toUpperCase() + word.slice(1));

export function usageCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "usage", items: [], body: <UsagePage ctx={ctx} /> }];
}

/** The computers whose own daemon keeps readings: this one and each one joined, never a cloud's list row. */
const readComputers = (places: ReadonlyArray<PlaceView>): PlaceView[] => places.filter(p => !isProviderPlace(p));

function UsagePage({ ctx }: { ctx: SettingsContext }) {
  const { api } = ctx;
  const [range, setRange] = useState<UsageRange>("week");
  const [split, setSplit] = useState<UsageSplit>("agent");
  const [accounts, setAccounts] = useState<AccountsAnswer | null>(null);
  const [used, setUsed] = useState<UsedAnswer | null>(null);
  const [readings, setReadings] = useState<Record<string, ReadingsAnswer | null>>({});
  const computers = readComputers(ctx.places);
  const computerIds = computers.map(p => p.id).join(" ");

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

  useEffect(() => {
    let live = true;
    const ids = computerIds === "" ? [] : computerIds.split(" ");
    for (const id of ids) {
      // A computer that is away or refuses reads as one with no readings, which is what its chart can say.
      void api?.placesReadings?.(id, range).then(
        answer => live && setReadings(r => ({ ...r, [id]: answer })),
        () => live && setReadings(r => ({ ...r, [id]: null })),
      );
    }
    return () => {
      live = false;
    };
  }, [api, range, computerIds]);

  return (
    <div className="flex flex-col gap-10">
      <Accounts accounts={accounts?.accounts ?? null} now={ctx.now} />
      <Used used={used} range={range} split={split} onRange={setRange} onSplit={setSplit} />
      <Computers computers={computers} readings={readings} />
    </div>
  );
}

function Header({ columns, cells, k }: { columns: string; cells: ReadonlyArray<{ word: string; right?: boolean; k?: string }>; k?: string }) {
  return (
    <div data-k={k} className={cn(HEAD, columns)}>
      {cells.map((cell, i) => (
        <span key={i} data-k={cell.k} className={cn("truncate", cell.right === true && "text-right")}>
          {cell.word}
        </span>
      ))}
    </div>
  );
}

function Named({ lead, name, note }: { lead?: ReactNode; name: string; note?: string }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      {lead === undefined ? null : <span className={FRAME}>{lead}</span>}
      <span className="flex min-w-0 flex-col">
        <span data-k="label" className={NAME} title={name}>
          {name}
        </span>
        {note === undefined || note === "" ? null : (
          <span data-k="note" className={NOTE} title={note}>
            {note}
          </span>
        )}
      </span>
    </span>
  );
}

/** A 56 by 4 meter with the share beside it and when the window starts again under them. */
function WindowCell({ used, resets }: { used: number; resets?: string }) {
  const share = Math.min(100, Math.max(0, Math.round(used)));
  return (
    <span className="flex flex-col justify-center gap-0.5">
      <span className="flex items-center gap-2">
        <span aria-hidden className="block h-1 w-14 overflow-hidden rounded-full bg-foreground/10">
          <span data-k="meter-fill" className="block h-full rounded-full bg-foreground/55 transition-[width] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none" style={{ width: `${share}%` }} />
        </span>
        <span data-k="percent" className={NUMBER}>{`${Math.round(used)}%`}</span>
      </span>
      {resets === undefined ? null : (
        <span data-k="resets" className={NOTE}>
          {resets}
        </span>
      )}
    </span>
  );
}

function Accounts({ accounts, now }: { accounts: ReadonlyArray<AccountRow> | null; now: number }) {
  return (
    <section data-usage-section="accounts" aria-label={W.accounts} className="flex flex-col gap-0.5">
      <Header columns={ACCOUNT_COLUMNS} cells={[{ word: W.accounts }, { word: W.session }, { word: W.week }, { word: W.plan }, { word: "" }]} />
      <div className={LIST}>
        {accounts === null ? null : accounts.length === 0 ? (
          <p data-k="no-accounts" className={cn(ROW, QUIET)}>
            {W.noAccounts}
          </p>
        ) : (
          accounts.map(row => <AccountLine key={row.key} row={row} now={now} />)
        )}
      </div>
    </section>
  );
}

function AccountLine({ row, now }: { row: AccountRow; now: number }) {
  const reached = row.status === "reached";
  const state = stateWord(accountState(row));
  const windows = row.windows ?? [];
  return (
    <div data-usage-account={row.key} className={cn(ROW, ACCOUNT_COLUMNS, "transition-colors duration-150 hover:bg-accent")}>
      <Named lead={<HarnessMark harness={row.agent} label={agentName(row.agent)} className="size-5" />} name={row.label} note={row.computers.join(", ")} />
      {row.note !== undefined && windows.length === 0 ? (
        <span data-k="state" className={cn(QUIET, "col-span-4 truncate text-right")} title={state}>
          {state}
        </span>
      ) : (
        <>
          {WINDOW_KINDS.map(kind => {
            const w = windows.find(x => x.kind === kind);
            return (
              <span key={kind} {...(w === undefined ? {} : { "data-window": kind })}>
                {w === undefined ? null : <WindowCell used={w.usedPercent} {...(w.resetsAt === undefined ? {} : { resets: resetsWord(w.resetsAt, now) })} />}
              </span>
            );
          })}
          <span data-k="plan" className={cn(QUIET, "truncate")}>
            {row.plan ?? ""}
          </span>
          <span data-k="state" className={cn("truncate text-right text-[13px] leading-5", reached ? "text-warning-foreground" : "text-muted-foreground")} title={state}>
            {state}
          </span>
        </>
      )}
    </div>
  );
}

const RANGES = USAGE_RANGES.map(value => ({ value, label: W.ranges[value] }));
const SPLITS = USAGE_SPLITS.map(value => ({ value, label: W.splits[value] }));

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
  const top = Math.max(0, ...used.series.map(s => s.tokens));
  const total = used.series.reduce((sum, s) => sum + s.tokens, 0);
  const n = used.series.length;
  if (top === 0) {
    return (
      <div data-usage-chart="tokens" className={cn("flex h-32 items-center justify-center", QUIET)}>
        {USAGE_WORDS.noUse}
      </div>
    );
  }
  const points = used.series.map((s, i) => ({ at: n > 1 ? i / (n - 1) : 0, share: s.tokens / top }));
  return (
    <div data-usage-chart="tokens" className="flex flex-col gap-2 py-1">
      <div className="flex items-baseline justify-between">
        <span className={cn("text-muted-foreground", GROUP_LABEL)}>{W.tokens}</span>
        <span data-k="total" className={NUMBER}>
          {fmtTokens(total)}
        </span>
      </div>
      <ChartPlot runs={[spanPoints(points, 0, 1, p => p.share)]} label={W.tokens} end className="text-foreground/80" />
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

function Used({ used, range, split, onRange, onSplit }: { used: UsedAnswer | null; range: UsageRange; split: UsageSplit; onRange: (r: UsageRange) => void; onSplit: (s: UsageSplit) => void }) {
  return (
    <section data-usage-section="used" aria-label={W.used} className="flex flex-col gap-0.5">
      <div className={HEAD}>{W.used}</div>
      <div className="flex h-11 items-center justify-between gap-4">
        <SegmentedControl data-k="usage-range" aria-label={W.used} value={range} segments={RANGES} onChange={onRange} />
        <SegmentedControl data-k="usage-split" aria-label={W.splits[split]} value={split} segments={SPLITS} onChange={onSplit} />
      </div>
      {used === null ? null : <TokensChart used={used} />}
      {used === null || used.rows.length === 0 ? null : (
        <>
          <Header
            k="used-head"
            columns={USED_COLUMNS}
            cells={[{ word: W.splits[used.split], k: "split-head" }, { word: W.in, right: true }, { word: W.out, right: true }, { word: W.cached, right: true }, { word: W.price, right: true }]}
          />
          <div className={LIST}>
            {used.rows.map(row => {
              const price = usedPrice(row);
              return (
                <div key={row.key} data-used-row={row.key} className={cn("flex h-11 items-center rounded-lg px-2 transition-colors duration-150 hover:bg-accent", USED_COLUMNS)}>
                  <Named name={row.label} {...(row.outside === true ? { note: USAGE_WORDS.outsideWsp } : {})} />
                  <span data-k="in" className={cn(NUMBER, "text-right")}>
                    {fmtTokens(row.tokens.input)}
                  </span>
                  <span data-k="out" className={cn(NUMBER, "text-right")}>
                    {fmtTokens(row.tokens.output)}
                  </span>
                  <span data-k="cached" className={cn(NUMBER, "text-right text-muted-foreground")}>
                    {fmtTokens(row.tokens.cached)}
                  </span>
                  <span className="flex flex-col items-end">
                    {price.figure === undefined ? null : (
                      <span data-k="price" className={cn(NUMBER, "text-muted-foreground")}>
                        {price.figure}
                      </span>
                    )}
                    {price.word === undefined ? null : (
                      <span data-k="price-word" className={NOTE}>
                        {price.word}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

const shareOf = (m: { used: number; total: number }): number => (m.total > 0 ? m.used / m.total : 0);
const READINGS: ReadonlyArray<{ k: string; word: string; share: (p: SysPoint) => number }> = [
  { k: "cpu", word: W.cpu, share: p => p.cpu / 100 },
  { k: "mem", word: W.memory, share: p => shareOf(p.mem) },
  { k: "disk", word: W.disk, share: p => shareOf(p.disk) },
];

/** The readings as runs: a step with no reading between two that have one ends a run, so a stopped computer's
 * stretch is a gap and no line crosses it. */
function runsOf(points: readonly SysPoint[], stepMs: number): SysPoint[][] {
  const runs: SysPoint[][] = [];
  for (const p of points) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    if (run !== undefined && prev !== undefined && p.at - prev.at <= stepMs * 1.5) run.push(p);
    else runs.push([p]);
  }
  return runs;
}

function Computers({ computers, readings }: { computers: ReadonlyArray<PlaceView>; readings: Readonly<Record<string, ReadingsAnswer | null>> }) {
  return (
    <section data-usage-section="computers" aria-label={W.computers} className="flex flex-col gap-0.5">
      <Header columns={COMPUTER_COLUMNS} cells={[{ word: W.computers }, { word: W.cpu }, { word: W.memory }, { word: W.disk }]} />
      <div className={LIST}>
        {computers.map(place => (
          <ComputerLine key={place.id} place={place} read={readings[place.id]} />
        ))}
      </div>
    </section>
  );
}

function ComputerLine({ place, read }: { place: PlaceView; read: ReadingsAnswer | null | undefined }) {
  const points = read?.points ?? [];
  const last = points[points.length - 1];
  return (
    <div data-usage-computer={place.id} className={cn(ROW, COMPUTER_COLUMNS)}>
      <span className="flex min-w-0 items-center gap-3">
        <span className={FRAME}>
          <ComputerGlyph place={place} className="size-4 text-foreground/80" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span data-k="label" className={NAME}>
            {placeName(place)}
          </span>
          {place.shape === undefined ? null : (
            <span data-k="note" className={cn(NOTE, "flex gap-3")}>
              <span>{`${place.shape.cpu} cores`}</span>
              <span>{fmtMemGb(place.shape.memMb)}</span>
            </span>
          )}
        </span>
      </span>
      {read === undefined ? null : read === null || last === undefined ? (
        <span data-k="no-readings" className={cn(QUIET, "col-span-3 truncate")}>
          {USAGE_WORDS.noReadings}
        </span>
      ) : (
        READINGS.map(reading => (
          <span key={reading.k} data-reading={reading.k} className="flex items-center gap-2">
            <ChartPlot runs={runsOf(points, read.stepMs).map(run => spanPoints(run, read.from, read.to, reading.share))} label={`${reading.word} over the range`} end={false} fill={false} height="h-8" className="min-w-0 flex-1 text-foreground/80" />
            <span data-k="last" className={cn(NUMBER, "w-9 shrink-0 text-right")}>{`${Math.round(reading.share(last) * 100)}%`}</span>
          </span>
        ))
      )}
    </div>
  );
}
