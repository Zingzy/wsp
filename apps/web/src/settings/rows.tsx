// SPDX-License-Identifier: AGPL-3.0-only
// The settings pages' grammar, in one place so every page reads it from here
// rather than from each other, after T3 Code's settingsLayout: a quiet head
// over each section, then one soft card, a faint rule between what it holds.
// A row grows with what it says: its title over a sentence that wraps, and
// beside them, in a column of its own, the one mono word and the one control.
// A line is a label and its value or its keycaps. Below 640 px what stood
// beside the words stands under them, so nothing is cut for want of room.
import { Chips, type ChipItem } from "../components/ui/chips.js";
import { ChevronRightIcon } from "lucide-react";
import { Children, type ReactNode } from "react";
import { Kbd, KbdGroup } from "../components/ui/kbd.js";
import { Spaced } from "../components/ui/spaced.js";
import { cn } from "../lib/utils.js";
import { FACT, VALUE } from "./format.js";
import { CARD_INSET, LINE_FLOOR, ROW_FLOOR, SECTION_HEAD, SETTING_TITLE } from "./layout.js";

/** Which mono a word in a slot wears: the foreground for a value a person reads, the muted for a state. */
export type WordClass = "value" | "fact";

/** Words for one slot: a phrase, or facts drawn apart by space and read as one line by a search or a hover. */
export type Words = string | ReadonlyArray<string>;
const wordsLine = (words: Words): string => (typeof words === "string" ? words : words.join(", "));
const WordsSlot = ({ words }: { words: Words }) => (typeof words === "string" ? words : <Spaced parts={words} />);
const WORD_CLASS: Record<WordClass, string> = { value: VALUE, fact: FACT };

/** One row of a settings page as data: its words, which the search reads, and the slot's render. */
export interface SettingsRowData {
  readonly kind: "row";
  readonly id: string;
  readonly title: string;
  /** A glyph before the title, where the row's noun has one of its own: a project's. */
  readonly lead?: ReactNode;
  /** One mono word after the title, in the fact class: the default mark on a computer. */
  readonly mark?: string;
  /** One sentence, or machine words in the mono fact class where `mono` is set; a list is facts held apart by space. */
  readonly description: Words;
  /** The facts as chips in place of the description line, which stays the words a search reads. */
  readonly chips?: readonly ChipItem[];
  readonly mono?: boolean;
  /** The one mono word in the slot, before the control, and the id a door or a list reaches it by. */
  readonly word?: string;
  readonly wordClass?: WordClass;
  readonly wordK?: string;
  /** At most one control: a segmented control, a stepper, a select, a button. */
  readonly control?: ReactNode;
  /** A row that opens a page: the whole row is the button and the slot ends in the chevron. */
  readonly open?: () => void;
  /** Extra attributes the tests and the screenshot list reach the row by. */
  readonly attrs?: Record<string, string>;
}

/** One line: a fact a person scans, or a chord. */
export interface SettingsLineData {
  readonly kind: "line";
  readonly id: string;
  readonly label: string;
  readonly value?: Words;
  readonly valueClass?: WordClass;
  /** Keycaps at the right, one group per chord. */
  readonly keys?: ReadonlyArray<ReadonlyArray<string>>;
  /** A word between the chords where they read as a range. */
  readonly keysJoiner?: string;
  /** One sentence on hover, never a description under the label. */
  readonly hover?: string;
  /** What stands in the keycaps' place where the line can change them; the keys stay the words it is read by. */
  readonly control?: ReactNode;
  readonly attrs?: Record<string, string>;
}

export type SettingsItem = SettingsRowData | SettingsLineData;

/** One card: rows or lines, a sub-head over every card but a page's first, and at most one button under it for
 * the act the card invites. */
export interface SettingsCardData {
  readonly id: string;
  readonly head?: string;
  /** One sentence under the head: what the section is for. */
  readonly lede?: string;
  readonly items: ReadonlyArray<SettingsItem>;
  readonly under?: ReactNode;
  /** A control too large for a row, drawn under the head and over the card's surface where it has rows too. */
  readonly body?: ReactNode;
  /** The rows a search finds in place of the items, for a card whose body draws them its own way. */
  readonly search?: ReadonlyArray<SettingsItem>;
}

/** The words a search reads on an item: its title or label, its description and its hover sentence. */
export function itemWords(item: SettingsItem): string[] {
  return item.kind === "row" ? [item.title, wordsLine(item.description)] : [item.label, ...(item.hover === undefined ? [] : [item.hover])];
}

export const CARD_SURFACE = "overflow-hidden rounded-xl border border-border/60 bg-card/40";
const TITLE_CLASS = SETTING_TITLE;
const LABEL_CLASS = "text-sm leading-5 text-foreground";
const DESCRIPTION_CLASS = "max-w-xl text-[13px] leading-[1.45] text-muted-foreground";
/** The text and what acts on it, each in a column of its own from 640 px, one over the other under it. */
const SPLIT_CLASS = "flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8";
/** The hover a row that opens a page takes: the sidebar rows' step, in the same 150 ms. */
const OPENS_CLASS = "w-full cursor-pointer text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export function Card({ id, head, lede, under, body, children }: { id: string; head?: ReactNode; /** One sentence under the head, for a card whose rows need the why. */ lede?: string; under?: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <section data-settings-card={id} {...(typeof head === "string" ? { "aria-label": head } : {})} className="flex flex-col gap-4">
      {head === undefined && lede === undefined ? null : (
        <div className="flex flex-col gap-1">
          {head === undefined ? null : (
            <h2 data-settings-head className={SECTION_HEAD}>
              {head}
            </h2>
          )}
          {lede === undefined ? null : (
            <p data-settings-lede className={DESCRIPTION_CLASS}>
              {lede}
            </p>
          )}
        </div>
      )}
      {body}
      {body !== undefined && Children.count(children) === 0 ? null : <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>{children}</div>}
      {under === undefined ? null : <div className="flex gap-2">{under}</div>}
    </section>
  );
}

/** One row: the title over its sentence, and beside them the slot, which stands under them below 640 px. */
export function Row({ id, title, lead, mark, description, chips, mono = false, word, wordClass = "value", wordK, control, open, attrs }: Omit<SettingsRowData, "kind">) {
  const slot =
    word === undefined && control === undefined && open === undefined ? null : (
      <div data-settings-slot className="flex min-w-0 items-center gap-3 sm:justify-end">
        {word === undefined ? null : (
          <span data-settings-word {...(wordK === undefined ? {} : { "data-k": wordK })} className={cn(WORD_CLASS[wordClass], "min-w-0 break-words sm:text-right")}>
            {word}
          </span>
        )}
        {control}
        {open === undefined ? null : <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      </div>
    );
  const text = (
    <div className="flex min-w-0 items-center gap-3">
      {lead === undefined ? null : <span className="flex shrink-0 items-center">{lead}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2">
          <span data-settings-title className={cn(TITLE_CLASS, "min-w-0 break-words")}>
            {title}
          </span>
          {mark === undefined ? null : (
            <span data-settings-mark className={cn(FACT, "shrink-0")}>
              {mark}
            </span>
          )}
        </span>
        {chips === undefined ? (
          wordsLine(description) === "" ? null : (
            <span data-settings-description className={cn(mono ? cn(FACT, "break-all leading-[1.45]") : DESCRIPTION_CLASS)}>
              <WordsSlot words={description} />
            </span>
          )
        ) : (
          <Chips items={chips} className="mt-1.5" />
        )}
      </div>
    </div>
  );
  const body = slot === null ? text : (
    <div className={SPLIT_CLASS}>
      {text}
      {slot}
    </div>
  );
  if (open !== undefined) {
    return (
      <button type="button" data-settings-row={id} className={cn("flex flex-col justify-center py-3", CARD_INSET, ROW_FLOOR, OPENS_CLASS)} onClick={open} {...attrs}>
        {body}
      </button>
    );
  }
  return (
    <div data-settings-row={id} className={cn("flex flex-col justify-center py-3", CARD_INSET, ROW_FLOOR)} {...attrs}>
      {body}
    </div>
  );
}

/** A chord's keycaps, one group per chord, with the word between them where they read as a range. */
export function KeyCaps({ keys, joiner }: { keys: ReadonlyArray<ReadonlyArray<string>>; joiner?: string }) {
  return (
    <span data-settings-keys className="flex shrink-0 items-center gap-2 max-sm:justify-start">
      {keys.map((chord, at) => (
        <span key={chord.join("+")} className="flex items-center gap-2">
          {at > 0 && joiner !== undefined ? <span className={FACT}>{joiner}</span> : null}
          <KbdGroup>
            {chord.map(key => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
        </span>
      ))}
    </span>
  );
}

/** One line: the label, and at its right one mono word or the chord's keycaps, under it below 640 px. The sentence
 * a line has to say is its hover text; a line carries no description. */
export function Line({ id, label, value, valueClass = "value", keys, keysJoiner, hover, control, attrs }: Omit<SettingsLineData, "kind">) {
  const right =
    control ??
    (value !== undefined ? (
      <span data-settings-word className={cn(WORD_CLASS[valueClass], "min-w-0 break-words sm:text-right")}>
        <WordsSlot words={value} />
      </span>
    ) : keys === undefined ? null : (
      <KeyCaps keys={keys} {...(keysJoiner === undefined ? {} : { joiner: keysJoiner })} />
    ));
  return (
    <div data-settings-line={id} className={cn("flex flex-col justify-center py-3", CARD_INSET, LINE_FLOOR)} {...(hover === undefined ? {} : { title: hover })} {...attrs}>
      <div className={right === null ? undefined : "flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8"}>
        <span data-settings-label className={cn(LABEL_CLASS, "min-w-0 break-words")}>
          {label}
        </span>
        {right === null ? null : <span className="flex min-w-0 sm:justify-end">{right}</span>}
      </div>
    </div>
  );
}

/** A card's items drawn from their data: the one renderer every page and the search page share. */
export function Cards({ cards }: { cards: ReadonlyArray<SettingsCardData> }) {
  return (
    <>
      {cards.map(card => {
        return (
          <Card key={card.id} id={card.id} head={card.head} {...(card.lede === undefined ? {} : { lede: card.lede })} under={card.under} body={card.body}>
            {card.items.map(item => {
              if (item.kind === "line") {
                const { kind: _line, ...line } = item;
                return <Line key={item.id} {...line} />;
              }
              const { kind: _row, ...row } = item;
              return <Row key={item.id} {...row} />;
            })}
          </Card>
        );
      })}
    </>
  );
}
