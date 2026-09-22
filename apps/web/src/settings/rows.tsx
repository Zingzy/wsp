// SPDX-License-Identifier: AGPL-3.0-only
// The settings pages' grammar, in one place so every page reads it from here
// rather than from each other: one card per section, a component hairline at
// its edge and between what it holds, none under the last; a sub-head over
// every card but a page's first; a row of a fixed height with a title over a
// one-line description and one slot at the right edge, holding one mono word
// and at most one control; a line of a fixed height with a label at the left
// and one mono word or keycaps at the right. A card holds rows or lines,
// never both, so a page's rhythm is one height per card.
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Kbd, KbdGroup } from "../components/ui/kbd.js";
import { cn } from "../lib/utils.js";
import { FACT, VALUE } from "./format.js";

/** Which mono a word in a slot wears: the foreground for a value a person reads, the muted for a state. */
export type WordClass = "value" | "fact";
const WORD_CLASS: Record<WordClass, string> = { value: VALUE, fact: FACT };

/** The height every row stands, whatever its words, and the taller one a row takes below 640 px when its control
 * drops under the description: every row of a card that holds one such row takes it, so the card is one height. */
export const ROW_CLASS = "h-13";
export const DROPPED_ROW_CLASS = "max-sm:h-21";
export const LINE_CLASS = "h-8";

/** One row of a settings page as data: its words, which the search reads, and the slot's render. */
export interface SettingsRowData {
  readonly kind: "row";
  readonly id: string;
  readonly title: string;
  /** One mono word after the title, in the fact class: the default mark on a computer. */
  readonly mark?: string;
  /** One sentence, or machine words in the mono fact class where `mono` is set. */
  readonly description: string;
  readonly mono?: boolean;
  /** The one mono word in the slot, before the control, and the id a door or a list reaches it by. */
  readonly word?: string;
  readonly wordClass?: WordClass;
  readonly wordK?: string;
  /** At most one control: a segmented control, a stepper, a select, a button. */
  readonly control?: ReactNode;
  /** A row that opens a page: the whole row is the button and the slot ends in the chevron. */
  readonly open?: () => void;
  /** A control that drops under the description below 640 px: a segmented control or a stepper. */
  readonly drops?: boolean;
  /** Extra attributes the tests and the screenshot list reach the row by. */
  readonly attrs?: Record<string, string>;
}

/** One line: a fact a person scans, or a chord. */
export interface SettingsLineData {
  readonly kind: "line";
  readonly id: string;
  readonly label: string;
  readonly value?: string;
  readonly valueClass?: WordClass;
  /** Keycaps at the right, one group per chord. */
  readonly keys?: ReadonlyArray<ReadonlyArray<string>>;
  /** A word between the chords where they read as a range. */
  readonly keysJoiner?: string;
  /** One sentence on hover, never a description under the label. */
  readonly hover?: string;
  readonly attrs?: Record<string, string>;
}

export type SettingsItem = SettingsRowData | SettingsLineData;

/** One card: rows or lines, a sub-head over every card but a page's first, and at most one button under it for
 * the act the card invites. */
export interface SettingsCardData {
  readonly id: string;
  readonly head?: string;
  readonly items: ReadonlyArray<SettingsItem>;
  readonly under?: ReactNode;
}

/** The words a search reads on an item: its title or label, its description and its hover sentence. */
export function itemWords(item: SettingsItem): string[] {
  return item.kind === "row" ? [item.title, item.description] : [item.label, ...(item.hover === undefined ? [] : [item.hover])];
}

const CARD_SURFACE = "overflow-hidden rounded-[10px] border border-border bg-card";
const TITLE_CLASS = "text-[13px] leading-4 text-foreground";
const DESCRIPTION_CLASS = "text-xs leading-4 text-muted-foreground";
/** The hover a row that opens a page takes: the sidebar rows' step, in the same 150 ms. */
const OPENS_CLASS = "w-full cursor-pointer text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export function Card({ id, head, under, children }: { id: string; head?: ReactNode; under?: ReactNode; children: ReactNode }) {
  return (
    <section data-settings-card={id} {...(typeof head === "string" ? { "aria-label": head } : {})} className="flex flex-col gap-2">
      {head === undefined ? null : (
        <h2 data-settings-head className="text-[13px] leading-4 text-muted-foreground">
          {head}
        </h2>
      )}
      <div className={cn(CARD_SURFACE, "flex flex-col divide-y divide-border")}>{children}</div>
      {under === undefined ? null : <div className="flex gap-2">{under}</div>}
    </section>
  );
}

/** One row: the title over its description at the left, the slot at the right edge. Below 640 px a row whose
 * control drops takes the taller height and puts the slot on a line of its own under the description, the word at
 * its left and the control at its right, so no segment's word is cut. */
export function Row({ id, title, mark, description, mono = false, word, wordClass = "value", wordK, control, open, drops = false, tall = drops, attrs }: Omit<SettingsRowData, "kind"> & { /** Whether the row takes the dropped height below 640 px: its own control drops, or another row's in the same card does. */ tall?: boolean }) {
  const slot =
    word === undefined && control === undefined && open === undefined ? null : (
      <div data-settings-slot className={cn("flex min-w-0 max-w-[60%] shrink items-center gap-3", drops && (word === undefined ? "max-sm:w-full max-sm:max-w-full max-sm:justify-end" : "max-sm:w-full max-sm:max-w-full max-sm:justify-between"))}>
        {word === undefined ? null : (
          <span data-settings-word {...(wordK === undefined ? {} : { "data-k": wordK })} className={cn(WORD_CLASS[wordClass], "min-w-0 truncate text-right")} title={word}>
            {word}
          </span>
        )}
        {control}
        {open === undefined ? null : <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      </div>
    );
  const body = (
    <>
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span data-settings-title className={cn(TITLE_CLASS, "truncate")}>
            {title}
          </span>
          {mark === undefined ? null : (
            <span data-settings-mark className={cn(FACT, "shrink-0")}>
              {mark}
            </span>
          )}
        </span>
        <span data-settings-description className={cn(mono ? FACT : DESCRIPTION_CLASS, "truncate")} title={description}>
          {description}
        </span>
      </div>
      {slot}
    </>
  );
  const rowClass = cn("flex items-center gap-4 px-4", ROW_CLASS, tall && DROPPED_ROW_CLASS, drops && "max-sm:flex-col max-sm:items-stretch max-sm:justify-center max-sm:gap-1");
  if (open !== undefined) {
    return (
      <button type="button" data-settings-row={id} className={cn(rowClass, OPENS_CLASS)} onClick={open} {...attrs}>
        {body}
      </button>
    );
  }
  return (
    <div data-settings-row={id} className={rowClass} {...attrs}>
      {body}
    </div>
  );
}

/** One line: the label at the left, at the right one mono word or the chord's keycaps. The sentence a line has to
 * say is its hover text; a line carries no description. */
export function Line({ id, label, value, valueClass = "value", keys, keysJoiner, hover, attrs }: Omit<SettingsLineData, "kind">) {
  return (
    <div data-settings-line={id} className={cn(LINE_CLASS, "flex items-center gap-4 px-4")} {...(hover === undefined ? {} : { title: hover })} {...attrs}>
      <span data-settings-label className={cn(TITLE_CLASS, "min-w-0 flex-1 truncate")}>
        {label}
      </span>
      {value === undefined ? null : (
        <span data-settings-word className={cn(WORD_CLASS[valueClass], "min-w-0 max-w-[60%] truncate text-right")} title={value}>
          {value}
        </span>
      )}
      {keys === undefined ? null : (
        <span data-settings-keys className="flex shrink-0 items-center gap-2">
          {keys.map((chord, at) => (
            <span key={chord.join("+")} className="flex items-center gap-2">
              {at > 0 && keysJoiner !== undefined ? <span className={FACT}>{keysJoiner}</span> : null}
              <KbdGroup>
                {chord.map(key => (
                  <Kbd key={key} className="font-mono">
                    {key}
                  </Kbd>
                ))}
              </KbdGroup>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** A card's items drawn from their data: the one renderer every page and the search page share. */
export function Cards({ cards }: { cards: ReadonlyArray<SettingsCardData> }) {
  return (
    <>
      {cards.map(card => {
        const tall = card.items.some(item => item.kind === "row" && item.drops === true);
        return (
          <Card key={card.id} id={card.id} head={card.head} under={card.under}>
            {card.items.map(item => {
              if (item.kind === "line") {
                const { kind: _line, ...line } = item;
                return <Line key={item.id} {...line} />;
              }
              const { kind: _row, ...row } = item;
              return <Row key={item.id} {...row} tall={tall} />;
            })}
          </Card>
        );
      })}
    </>
  );
}
