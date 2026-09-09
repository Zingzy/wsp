// SPDX-License-Identifier: AGPL-3.0-only
// One of the five screens of wsp init, drawn from the data the host hands
// over: the rows the terminal's list draws, grouped where the terminal groups
// them, a tick or an answer word on each, the footer lines under them. The
// ticks and answers live here until Continue sends them; Back keeps them.
import { useState } from "react";
import { CLOUD_SETUP_WORDS, type InitFooterLine, type InitScreen, type InitScreenItem } from "@wsp/protocol";
import { Checkbox } from "../../components/ui/checkbox.js";
import { cn } from "../../lib/utils.js";
import { CARD, GroupLabel, ROW, ROW_LINE, STATE_WORD, SetupFrame } from "./grammar.js";

export interface ScreenAnswer {
  ticks: string[];
  answers: Record<string, string>;
}

/** The footer's tones: the disk line's weight in the app's own colours, the middle tier orange, the top tier red. */
const TONE: Record<NonNullable<InitFooterLine["tone"]>, string> = { yellow: "text-warning-foreground", yellowBright: "text-warning-foreground", red: "text-destructive-foreground" };

export function SetupScreen({ screen, last, onContinue, onBack, refusal }: { screen: InitScreen; last: boolean; onContinue: (answer: ScreenAnswer) => void; onBack: () => void; refusal: string | null }) {
  const [ticks, setTicks] = useState<Set<string>>(() => new Set(screen.ticks));
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...screen.answers }));
  const groups = [...new Set(screen.items.map(i => i.group ?? ""))];
  const grouped = groups.some(g => g !== "");
  const tick = (id: string, on: boolean): void =>
    setTicks(prev => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const cycle = (item: InitScreenItem): void => {
    const choices = item.choices ?? [];
    const at = choices.findIndex(c => c.value === answers[item.id]);
    const next = choices[(at + 1) % choices.length];
    if (next !== undefined) setAnswers(prev => ({ ...prev, [item.id]: next.value }));
  };
  const rows = (items: readonly InitScreenItem[]) =>
    items.map(item => (
      <li key={item.id} data-k="row" data-row={item.id} className={cn(ROW, ROW_LINE)} title={item.detail.join("\n")}>
        {item.choices !== undefined ? (
          <span aria-hidden className="size-4 shrink-0" />
        ) : item.lock === "on" ? (
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
            <span className="size-1.5 rounded-full bg-foreground/70" />
          </span>
        ) : (
          <Checkbox tone="neutral" aria-label={item.label} checked={ticks.has(item.id)} disabled={item.lock === "off"} onCheckedChange={on => tick(item.id, on === true)} />
        )}
        <span className="max-w-[55%] shrink-0 truncate text-sm text-foreground">{item.label}</span>
        {item.why !== undefined ? <span className={cn(STATE_WORD, "hidden min-w-0 flex-1 truncate text-right sm:inline")}>{item.why}</span> : <span className="flex-1" />}
        {item.hint !== undefined ? (
          <span data-k="hint" className={STATE_WORD}>
            {item.hint}
          </span>
        ) : null}
        {item.choices !== undefined ? (
          <button type="button" data-k="answer" data-row={item.id} onClick={() => cycle(item)} className={cn(STATE_WORD, "cursor-pointer rounded-sm border border-input px-1.5 py-0.5 text-foreground hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring outline-none")}>
            {item.choices.find(c => c.value === answers[item.id])?.label ?? answers[item.id]}
          </button>
        ) : null}
      </li>
    ));
  return (
    <SetupFrame
      k={`screen-${screen.id}`}
      label={screen.title}
      counter={screen.counter}
      headline={screen.top}
      refusal={refusal}
      primary={{ word: last ? CLOUD_SETUP_WORDS.screen.build : CLOUD_SETUP_WORDS.screen.keycap, onPress: () => onContinue({ ticks: [...ticks], answers }) }}
      secondary={{ word: CLOUD_SETUP_WORDS.screen.back, onPress: onBack }}
    >
      {screen.items.length === 0 ? (
        <p data-k="empty" className={cn(STATE_WORD, "text-center")}>
          {screen.empty}
        </p>
      ) : (
        <ul className={cn(CARD, "max-h-[50vh] overflow-y-auto")} aria-label={screen.title}>
          {grouped
            ? groups.map(group => (
                <li key={group} className={ROW_LINE}>
                  {group !== "" ? <GroupLabel>{group}</GroupLabel> : null}
                  <ul>{rows(screen.items.filter(i => (i.group ?? "") === group))}</ul>
                </li>
              ))
            : rows(screen.items)}
        </ul>
      )}
      {screen.footer.length > 0 ? (
        <div data-k="footer" className="flex flex-col gap-0.5 px-1 pt-3">
          {screen.footer.map((line, i) => (
            <p key={i} className={cn("font-mono text-[11px] tabular-nums", line.tone !== undefined ? TONE[line.tone] : "text-muted-foreground")}>
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
    </SetupFrame>
  );
}
