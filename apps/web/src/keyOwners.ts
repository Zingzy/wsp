// SPDX-License-Identifier: AGPL-3.0-only
// Who a typed key belongs to, said once for every handler that listens on the
// window: the composer's type to focus, the panel launcher's letters and the
// keybinding dispatcher. A field a person types in keeps its keys, and so
// does a layer open over the page, a list that reads letters as a search,
// and a place that names the keys it takes while it has focus.

/**
 * A focused editable is a typing context whether or not it has text yet: an empty chat composer at rest is still
 * where the next keystrokes are meant to land. The `:not` clause lets `closest` see past non-editable islands
 * (`contenteditable="false"`) to an editable host around them.
 */
const TYPING_CONTEXT = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** Layers drawn over the page that take the keyboard while they are open, wherever focus is. */
const OPEN_LAYERS = [
  '[data-slot="dialog-popup"]',
  '[data-slot="alert-dialog-popup"]',
  '[data-slot="command-dialog-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="popover-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
  '[aria-modal="true"]',
].join(",");

/** Places that read a typed letter as their own: a dialog, a menu, a list or a combobox's typeahead. */
const LETTER_READERS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="combobox"]';

/** A place that takes some keys as its own while focus is in it, naming them on itself (the prompt dock's digits,
 * arrows, Space, Enter and Esc); every other key pressed there is free for the window's handlers. */
const KEY_TAKER = "[data-owns-keys]";

/** A key as a key taker names it: Space by its name, every other key by its own. */
const keyName = (key: string): string => (key === " " ? "Space" : key);

export function isTypingTarget(target: { closest(selectors: string): unknown } | null): boolean {
  return target?.closest(TYPING_CONTEXT) != null;
}

/** Whether a key pressed at `target` is something else's to take: a field's, an open layer's, a list's search, or
 * one a key taker named. */
export function keyBelongsElsewhere(target: EventTarget | null, key: string): boolean {
  if (document.querySelector(OPEN_LAYERS) !== null) return true;
  if (!(target instanceof Element)) return false;
  const taker = target.closest(KEY_TAKER);
  if (taker !== null && (taker.getAttribute("data-owns-keys") ?? "").split(" ").includes(keyName(key))) return true;
  return isTypingTarget(target) || target.closest(LETTER_READERS) !== null;
}

/** The value a key taker names its keys with. */
export const ownsKeys = (keys: readonly string[]): string => keys.map(keyName).join(" ");
