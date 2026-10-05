// SPDX-License-Identifier: AGPL-3.0-only
// Typing anywhere in a thread lands in its composer: a printable key pressed
// while focus is in no field of its own (a tile just clicked, the transcript,
// a pane's button) focuses the editor during that key's keydown, and the
// browser hands the key's text to whatever holds focus once the keydown is
// done, so the first letter is not lost. What keeps its keys is keyOwners'
// one reading; the panel launcher's letters stand down beside a composer
// unless the key was pressed inside the panel.
import { useEffect, useRef, type RefObject } from "react";
import { keyBelongsElsewhere } from "../../keyOwners";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { requestComposerFocus } from "../../shell/shellRequests";
import { EMPTY_DRAFT, useComposerDraftStore } from "./composerDraftStore";

export function typesIntoComposer(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "defaultPrevented">, target: EventTarget | null): boolean {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false;
  // One printable character; a lone space would scroll the page or press the focused button, and starts no message.
  if (event.key.length !== 1 || event.key.trim() === "") return false;
  return !keyBelongsElsewhere(target, event.key);
}

/** Whether a composer stands on screen, whose thread's keys are its own; the prompt dock stands in its place, and a
 * letter typed there is the start of a message too. */
export const composerOnScreen = (): boolean => document.querySelector("[data-chat-composer], [data-prompt-dock]") !== null;

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

/** While `enabled`, the prompt dock stands where the composer would, and a key typed outside any field lands there as
 * a letter lands in the composer: one the dock takes (a digit) is handed to the dock, and any other calls `fold` to
 * put it away and ends the draft with the key. No editor is mounted to hand that key to, so it goes into the draft,
 * and the composer that comes back takes the focus with its caret after it. */
export function useTypeToWrite(workspaceId: string, enabled: boolean, fold: () => void): void {
  const folding = useRef(fold);
  folding.current = fold;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!typesIntoComposer(event, event.target)) return;
      event.preventDefault();
      const dock = document.querySelector<HTMLElement>("[data-prompt-root]");
      if (dock !== null && keyBelongsElsewhere(dock, event.key)) {
        dock.focus({ preventScroll: true });
        dock.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true, cancelable: true }));
        return;
      }
      const store = useComposerDraftStore.getState();
      const prompt = `${(store.drafts[workspaceId] ?? EMPTY_DRAFT).prompt}${event.key}`;
      store.setDraft(workspaceId, { prompt, cursor: collapseExpandedComposerCursor(prompt, prompt.length) });
      folding.current();
      requestComposerFocus(workspaceId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, workspaceId]);
}
