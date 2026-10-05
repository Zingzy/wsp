// SPDX-License-Identifier: AGPL-3.0-only
// Typing anywhere in a thread lands in its composer: a printable key pressed
// while focus is in no field of its own (a tile just clicked, the transcript,
// a pane's button) focuses the editor during that key's keydown, and the
// browser hands the key's text to whatever holds focus once the keydown is
// done, so the first letter is not lost. What keeps its keys is keyOwners'
// one reading; the panel launcher's letters stand down beside a composer
// unless the key was pressed inside the panel.
import { useEffect, type RefObject } from "react";
import { keyBelongsElsewhere } from "../../keyOwners";

export function typesIntoComposer(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented">, target: EventTarget | null): boolean {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  // One printable character; a lone space would scroll the page or press the focused button, and starts no message.
  if (event.key.length !== 1 || event.key.trim() === "") return false;
  return !keyBelongsElsewhere(target);
}

/** Whether a composer stands on screen, whose thread's keys are its own. */
export const composerOnScreen = (): boolean => document.querySelector("[data-chat-composer]") !== null;

/** While `enabled`, a key typed in the thread outside any field focuses the editor `focus` reaches. */
export function useTypeToFocus(focus: RefObject<{ focus: () => void } | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (typesIntoComposer(event, event.target)) focus.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, focus]);
}
