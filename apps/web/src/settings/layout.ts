// SPDX-License-Identifier: AGPL-3.0-only
// The settings pages' sizes, in one place so every card, row, line and list
// reads them from here. The inset is a custom property, so one value moves
// every page at once.

/** The inset every card keeps its content at, off --settings-inset (20 px unless a page sets its own). */
export const CARD_INSET = "px-(--settings-inset,20px)";
/** The floor a setting row stands at whatever its control, so rows line up down a card. */
export const ROW_FLOOR = "min-h-15";
/** The floor of a line: a label and its value or its keycaps. */
export const LINE_FLOOR = "min-h-12";
/** A setting row's title: a choice, read like a sentence. */
export const SETTING_TITLE = "text-sm leading-5 font-medium text-foreground";
/** A list row's title: a thing that is named, scanned like a list. */
export const LIST_TITLE = "text-[15px] leading-6 font-medium text-foreground";
/** The line under a title. */
export const NOTE = "text-[13px] leading-5 text-muted-foreground";
/** The head over every card. */
export const SECTION_HEAD = "flex min-h-7 items-center text-[13.5px] font-medium text-foreground/70 group-data-[locked]/settings:text-sm group-data-[locked]/settings:font-normal";
/** The one width every select in a setting row takes, so the controls line up down a card. */
export const SELECT_WIDTH = "h-[30px] min-h-[30px] w-44 rounded-[7px] text-[13px] sm:text-[13px] max-sm:w-36";
/** A field a person types into in a setting row, at the select's height and size, its words in the mono. */
export const ROW_FIELD = "h-[30px] rounded-[7px] font-mono [&_input]:h-[28px] [&_input]:text-[13px] [&_input]:leading-[28px] sm:[&_input]:h-[28px] sm:[&_input]:text-[13px] sm:[&_input]:leading-[28px]";
