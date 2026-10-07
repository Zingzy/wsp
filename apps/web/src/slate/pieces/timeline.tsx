// SPDX-License-Identifier: AGPL-3.0-only
// Spans over clock time, Gantt style: each row a name at the left, its bar on a shared clock in the middle and at the
// right its length, or its state in words while it runs, failed or waits. Rows of one group sit under the group's
// name. A done bar is the quiet ink, a running one the slate's accent, a failed one the bad tone; each has the keycap
// bevel a button has.
import { fmtElapsed } from "@wsp/protocol";
import { slateSpanState, slateTime as at, type SlateJson, type SlateSpanState as State } from "@wsp/protocol/slate";
import type { ReactNode } from "react";
import { KEYCAP_BEVEL } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import type { PieceView } from "../SlateView.js";
import { NOTE, str } from "./look.js";

type Span = { name: string; group: string | undefined; start: number | undefined; end: number | undefined; state: State };

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The clock steps an axis may take; past the last it doubles, so any span, even one from 1970, ends in four ticks. */
const STEPS = [5, 10, 15, 30].map(n => n * SECOND).concat([1, 2, 5, 10, 15, 30].map(n => n * MINUTE), [1, 2, 3, 6, 12].map(n => n * HOUR), [1, 2, 7, 14, 30, 90, 180, 365].map(n => n * DAY));
/** A step at most a third of the span, so the clock draws two to four words, a third of the track apart at least. */
const MOST_STEPS = 3;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number): string => String(n).padStart(2, "0");

/** The ticks across a span on the first step a third of it or more, each with its word: a time of day, with the
 * weekday once the span passes a day, or the date once a step is a day or more. */
function clockTicks(from: number, span: number): Array<{ t: number; word: string }> {
  // The step is picked off the span alone: laying out five-second steps across a span from 1970 would be hundreds of millions.
  let step = STEPS.find(s => span / s <= MOST_STEPS) ?? STEPS.at(-1)!;
  while (span / step > MOST_STEPS) step *= 2;
  const first = Math.ceil(from / step) * step;
  return Array.from({ length: Math.max(0, Math.floor((from + span - first) / step) + 1) }, (_, i) => first + i * step).map(t => {
    const d = new Date(t);
    if (step >= 365 * DAY) return { t, word: String(d.getFullYear()) };
    if (step >= DAY) return { t, word: `${d.getDate()} ${MONTH[d.getMonth()]}` };
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${step < MINUTE ? `:${pad(d.getSeconds())}` : ""}`;
    return { t, word: span >= DAY ? `${WEEKDAY[d.getDay()]} ${time}` : time };
  });
}

/** A row's track: the clock's ticks drawn as the Usage chart draws its grid, at each tick's share of the span. */
function Track({ at, children }: { at: readonly number[]; children?: ReactNode }) {
  return (
    <span className="relative h-5 min-w-0">
      <svg aria-hidden className="absolute inset-0 size-full overflow-visible text-border" viewBox="0 0 100 20" preserveAspectRatio="none">
        {at.map(x => (
          <line key={x} x1={x} x2={x} y1={0} y2={20} stroke="currentColor" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {children}
    </span>
  );
}

const BAR: Record<Exclude<State, "waiting">, string> = {
  done: "bg-[color-mix(in_srgb,var(--foreground)_42%,var(--background))]",
  running: "bg-[var(--slate-accent,var(--primary))]",
  failed: "bg-error-foreground",
};
const WORD: Record<Exclude<State, "done">, { word: string; ink: string }> = {
  running: { word: "Running", ink: "text-[var(--slate-accent,var(--primary))]" },
  failed: { word: "Failed", ink: "text-error-foreground" },
  waiting: { word: "Waiting", ink: "text-muted-foreground" },
};

export const timeline: PieceView = {
  type: "timeline",
  card: false,
  accent: true,
  rowScoped: ["name", "start", "end", "state", "group"],
  // With no now of its own, a running span ends at the slate's clock, which then ticks each second while it is drawn.
  reads: piece => (piece.props?.["now"] === undefined ? ["time.now"] : []),
  component: function TimelinePiece({ piece, props, slate }) {
    const label = str(props["label"]) ?? "";
    const items = Array.isArray(props["items"]) ? props["items"] : [];
    const read = (prop: string, item: SlateJson, index: number) => slate.resolve(piece.props?.[prop], { item, index }) as SlateJson | undefined;
    const now = at(props["now"]) ?? at(slate.evaluate("time.now")) ?? Date.now();
    const spans: Span[] = items.map((item, index) => {
      const start = at(read("start", item, index));
      const end = at(read("end", item, index));
      const state = slateSpanState(read("state", item, index), start, end);
      return { name: str(read("name", item, index)) ?? "", group: str(read("group", item, index)), start, end: state === "running" ? (end ?? now) : end, state };
    });
    const times = spans.flatMap(s => [s.start, s.end]).filter((t): t is number => t !== undefined);
    const from = Math.min(...times);
    const span = Math.max(1, Math.max(...times) - from);
    const x = (t: number): number => ((t - from) / span) * 100;
    const ticks = times.length === 0 ? [] : clockTicks(from, span);
    const tickAt = ticks.map(({ t }) => x(t));
    const groups = spans.reduce<Array<{ group: string | undefined; rows: Span[] }>>((all, s) => {
      const last = all.at(-1);
      if (last !== undefined && last.group === s.group) last.rows.push(s);
      else all.push({ group: s.group, rows: [s] });
      return all;
    }, []);
    const comma = label.indexOf(", ");
    return (
      <figure data-slate-timeline className="@container flex min-w-0 flex-col gap-2.5">
        <figcaption className="flex flex-wrap items-baseline gap-x-2 text-note leading-5 text-foreground">
          {comma < 0 ? label : label.slice(0, comma)}
          {comma < 0 ? null : <span className="text-xs leading-4 text-muted-foreground">{label.slice(comma + 2)}</span>}
        </figcaption>
        {spans.length === 0 ? (
          <span className={NOTE}>Not read yet</span>
        ) : (
          <div className="grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 @min-[520px]:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto]">
            {groups.map(({ group, rows }, g) => (
              <div key={g} className="contents">
                {group === undefined ? null : <span className={cn("col-span-3 text-xs leading-4 text-muted-foreground", g > 0 && "pt-2")}>{group}</span>}
                {rows.map((s, r) => (
                  <div key={r} data-slate-span={s.state} className="contents">
                    <span className="truncate text-note leading-5 text-foreground">{s.name}</span>
                    <Track at={tickAt}>
                      {s.start === undefined || s.end === undefined ? null : (
                        <span
                          className={cn("absolute top-1/2 h-3 -translate-y-1/2 rounded-xs", KEYCAP_BEVEL, BAR[s.state === "waiting" ? "done" : s.state])}
                          style={{ left: `${x(s.start)}%`, width: `max(4px, ${x(s.end) - x(s.start)}%)` }}
                        />
                      )}
                    </Track>
                    <span className="min-w-14 text-right font-mono text-xs leading-5 tabular-nums">
                      {s.state === "done" ? (
                        <span className="text-muted-foreground">{s.start === undefined || s.end === undefined ? "" : fmtElapsed(s.end - s.start)}</span>
                      ) : (
                        <span className={WORD[s.state].ink}>
                          <span className="font-sans">{WORD[s.state].word}</span>
                          {s.state === "running" && s.start !== undefined ? <span className="text-muted-foreground"> {fmtElapsed(now - s.start)}</span> : null}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            <span aria-hidden />
            <span className="relative h-4 font-mono text-meta leading-4 text-muted-foreground tabular-nums">
              {ticks.map(({ t, word }, i) => (
                <span key={t} data-slate-tick className={cn("absolute top-0 whitespace-nowrap", x(t) > 85 ? "-translate-x-full" : i === 0 && x(t) < 8 ? "" : "-translate-x-1/2")} style={{ left: `${x(t)}%` }}>
                  {word}
                </span>
              ))}
            </span>
            <span aria-hidden />
          </div>
        )}
      </figure>
    );
  },
};
