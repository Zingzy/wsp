// SPDX-License-Identifier: AGPL-3.0-only
// The words the Image section says and the readings behind them: the record as
// one line of facts, when and where it was built, and what one copy of it
// holds. Every word here is "image"; the person never reads golden, setup or
// copy as a noun for it. Neither of the two rules under this section lives
// here: whether a copy stands on the record is copyStanding in the protocol,
// which the command line reads too, and where today ends is daysBack in the
// app's timestamp reading, which every surface that says "today" reads.
import { fmtBytes, plural, sealedLoginsHeld, type PlaceView, type Recipe, type SealedImage, type SealedImageCopy } from "@wsp/protocol";
import { placeNamed } from "./places.js";
import { APP_LOCALE, daysBack, parseTimestampDate } from "../lib/timestampFormat.js";

export const IMAGE_WORDS = {
  title: "Image",
  image: "Image",
  built: "Built",
  edit: "Edit",
  /** The sheet the six init screens are drawn in, opened from Edit. */
  sheet: "Your image",
  /** The fact beside the row before anything has been sealed. */
  notBuilt: "not built yet",
  /** The one sentence under that row: what will build it and when. */
  firstBuild: "Built from this Mac the first time a workspace is created on another computer or a provider.",
  copyAt: "Copy at",
  version: "Version",
  size: "Size",
  copyBuilt: "Built",
} as const;

/** The clock and the date this section spells a stamp with, both in the app's own locale, as every other stamp in
 * the app reads: the shape of a stamp is the app's and not the shell's the run happens to start in. */
const CLOCK = new Intl.DateTimeFormat(APP_LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DAY = new Intl.DateTimeFormat(APP_LOCALE, { month: "short", day: "numeric" });

/** How many rows of one kind the recipe asks for. A record sealed by a road that carried no small recipe has none
 * to count, and its line says nothing about agents or tools rather than saying zero. */
const rowsOn = (recipe: Recipe, kind: "agent" | "tool"): number => recipe.rows.filter(row => row.on && row.kind === kind).length;

/** The record in the row's fact slot: which version it is, what the image came to on disk, what it carries and how
 * many sign-ins it holds. A field the record does not carry is left out rather than drawn as unknown. The content
 * hash is a fact of the record and not of this row, so it is not here; the copies table says what it decides. */
export function imageFacts(image: SealedImage): string {
  const size = image.usedBytes === undefined ? [] : [fmtBytes(image.usedBytes)];
  const held = image.recipe === undefined ? [] : [plural(rowsOn(image.recipe, "agent"), "agent"), plural(rowsOn(image.recipe, "tool"), "tool")];
  return [`v${image.version}`, ...size, ...held, plural(sealedLoginsHeld(image), "sign-in")].join(" · ");
}

/** A stamp as the section reads one: the clock alone on the day it happened, the day and the clock before that, so
 * the two rows that carry a time read the same. Which day it belongs to is the app's own reading; these are only
 * the words this section says for it. */
export function builtWhen(at: string, now: number = Date.now()): string {
  const when = parseTimestampDate(at);
  if (when === null) return at;
  const clock = CLOCK.format(when);
  const back = daysBack(when, now);
  if (back <= 0) return `today ${clock}`;
  if (back === 1) return `yesterday ${clock}`;
  return `${DAY.format(when)} ${clock}`;
}

/** The copy one computer or provider holds, or nothing where it holds none. A copy names the place by the word a
 * person types for it, which is the id on some rows and the name on others, so the row's own reading answers it.
 * The one match, read by the Remove sentence, the copies table and the New workspace caption alike. */
export const copyOn = (copies: readonly SealedImageCopy[], place: PlaceView): SealedImageCopy | undefined => copies.find(copy => placeNamed(place, copy.place));

/** The Built row: when the record was sealed and which computer it was sealed from. */
export const builtFact = (image: SealedImage, now?: number): string => `${builtWhen(image.sealedAt, now)} · from ${image.sealedFrom}`;
