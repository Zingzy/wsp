// SPDX-License-Identifier: AGPL-3.0-only
// The settings pages' grammar, in one place so every page reads it from here
// rather than from each other, after T3 Code's settingsLayout: a quiet head
// over each section, then one soft card, a faint rule between what it holds.
// A row grows with what it says: its title over a sentence that wraps, and
// beside them, in a column of its own, the one mono word and the one control.
// A line is a label and its value or its keycaps. Below 640 px what stood
// beside the words stands under them, so nothing is cut for want of room.
import { Chips, type ChipItem } from "../components/ui/chips.js";
import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { Children, type ReactNode } from "react";
import { Kbd, KbdGroup } from "../components/ui/kbd.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Spaced } from "../components/ui/spaced.js";
import { cn } from "../lib/utils.js";
import { FACT, SETTINGS_WORDS, VALUE } from "./format.js";

const RESET_WORD = SETTINGS_WORDS.resetRow;
import { CARD_INSET, LINE_FLOOR, LIST_TITLE, NOTE, ROW_FLOOR, SECTION_HEAD, SETTING_TITLE } from "./layout.js";

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
  /** The mark in the row's own sans note ink rather than the mono fact, where it is a word and not a figure. */
  readonly markWord?: true;
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
  /** Present only while the row is off its default: an arrow beside the title puts that one row back. */
  readonly reset?: () => void;
  /** A title that warns: a computer that runs an older wsp. */
  readonly tone?: "warning";
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
  /** The card's one empty line: what is not there yet, in the quiet note, the one voice every empty card speaks in. */
  readonly empty?: true;
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

export const CARD_SURFACE = "overflow-hidden rounded-[11px] border border-border/60 bg-card/40 group-data-[locked]/settings:rounded-xl";
const TITLE_CLASS = SETTING_TITLE;
const LABEL_CLASS = "text-sm leading-5 text-foreground";
const DESCRIPTION_CLASS = "max-w-xl text-[13px] leading-[1.45] text-muted-foreground";
/** The text and what acts on it, each in a column of its own from 640 px, one over the other under it. */
const SPLIT_CLASS = "flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-5";
/** The hover a row that opens a page takes: the sidebar rows' step, in the same 150 ms. */
const OPENS_CLASS = "w-full cursor-pointer text-left transition-colors duration-150 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

export function Card({ id, head, lede, under, body, children }: { id: string; head?: ReactNode; /** One sentence under the head, for a card whose rows need the why. */ lede?: string; under?: ReactNode; body?: ReactNode; children?: ReactNode }) {
  return (
    <section data-settings-card={id} {...(typeof head === "string" ? { "aria-label": head } : {})} className="flex flex-col gap-3 group-data-[locked]/settings:gap-4">
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
      {/* A card with nothing in it draws no surface: an empty bordered box reads as a fault. */}
      {Children.count(children) === 0 ? null : <div className={cn(CARD_SURFACE, "flex flex-col [&>*+*]:border-t [&>*+*]:border-border/50")}>{children}</div>}
      {under === undefined ? null : <div className="flex gap-2">{under}</div>}
    </section>
  );
}

/** One row: the title over its sentence, and beside them the slot, which stands under them below 640 px. */
export function Row({ id, title, lead, mark, markWord, description, chips, mono = false, word, wordClass = "value", wordK, control, open, reset, tone, attrs }: Omit<SettingsRowData, "kind">) {
  const slot =
    word === undefined && control === undefined && open === undefined ? null : (
      <div data-settings-slot className="flex min-w-0 items-center gap-3 sm:justify-end">
        {word === undefined ? null : (
          <span data-settings-word {...(wordK === undefined ? {} : { "data-k": wordK })} className={cn(WORD_CLASS[wordClass], "min-w-0 break-words sm:text-right")}>
            {word}
          </span>
        )}
        {control === undefined ? null : (
          <span data-settings-control className="contents">
            {control}
          </span>
        )}
        {open === undefined ? null : <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      </div>
    );
  const text = (
    <div className="flex min-w-0 items-center gap-3">
      {lead === undefined ? null : <span className="flex shrink-0 items-center">{lead}</span>}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2">
          <span data-settings-title className={cn(TITLE_CLASS, "min-w-0 break-words", tone === "warning" && "text-warning-foreground")}>
            {title}
          </span>
          {mark === undefined ? null : (
            <span data-settings-mark className={cn(markWord === true ? NOTE : FACT, "shrink-0")}>
              {mark}
            </span>
          )}
          {reset === undefined ? null : (
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-xs" data-k="row-reset" aria-label={RESET_WORD} onClick={reset} />}>
                <RotateCcwIcon aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">{RESET_WORD}</TooltipPopup>
            </Tooltip>
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
  // A slot holding the chevron alone stays beside the words at every width: on a line of its own it reads as a stray.
  const chevronOnly = word === undefined && control === undefined && open !== undefined;
  const body = slot === null ? text : (
    <div className={chevronOnly ? "flex items-center justify-between gap-5" : SPLIT_CLASS}>
      {text}
      {slot}
    </div>
  );
  if (open !== undefined && control !== undefined) {
    // A button may not hold a button, so a row that opens a page and acts as well is a link that leaves its control be.
    return (
      <div
        role="link"
        tabIndex={0}
        data-settings-row={id}
        className={cn("flex flex-col justify-center py-3", CARD_INSET, ROW_FLOOR, OPENS_CLASS)}
        onClick={event => {
          if (!(event.target instanceof Element && event.target.closest("[data-settings-control]") !== null)) open();
        }}
        onKeyDown={event => {
          if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            open();
          }
        }}
        {...attrs}
      >
        {body}
      </div>
    );
  }
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
export function Line({ id, label, value, valueClass = "value", keys, keysJoiner, hover, control, empty, attrs }: Omit<SettingsLineData, "kind">) {
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
        <span data-settings-label className={cn(empty === true ? NOTE : LABEL_CLASS, "min-w-0 break-words")}>
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

/** The row a computer's or a project's page opens on: its glyph in its frame, its name, one line of one kind of
 * fact under it, and a figure or an act at the right. It stands in place of a page title, since the top bar's
 * crumbs already name the page. */
export function HeadRow({ glyph, title, mark, line, slot, attrs }: { glyph: ReactNode; title: string; /** One mono fact after the name: an agent's version. */ mark?: string; line?: ReactNode; slot?: ReactNode; attrs?: Record<string, string> }) {
  return (
    <div data-settings-head-row className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-4", CARD_INSET, ROW_FLOOR)} {...attrs}>
      <span className="flex min-w-40 flex-1 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.04]">{glyph}</span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span data-settings-title className={cn(LIST_TITLE, "truncate")}>
              {title}
            </span>
            {mark === undefined ? null : (
              <span data-settings-mark className={cn(FACT, "shrink-0")}>
                {mark}
              </span>
            )}
          </span>
          {line === undefined ? null : (
            <span data-settings-description className={cn(NOTE, "truncate")}>
              {line}
            </span>
          )}
        </span>
      </span>
      {slot}
    </div>
  );
}

/** One row's room while what fills the card is on its way: a title bar over a line bar, at the row's own floor. */
export function RowSkeleton({ k }: { k: string }) {
  return (
    <div data-k={k} aria-busy className={cn(CARD_SURFACE, "flex flex-col justify-center gap-2 py-3", CARD_INSET, ROW_FLOOR)}>
      <Skeleton className="h-3.5 w-40" />
      <Skeleton className="h-3 w-64" />
    </div>
  );
}
