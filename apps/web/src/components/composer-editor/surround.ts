// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ComposerPromptEditor.tsx at 57a66608 (MIT).
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $getRoot, HISTORY_MERGE_TAG } from "lexical";
import { useEffect, useEffectEvent, useRef } from "react";

import { collapseExpandedComposerCursor } from "../../composer-logic";
import { selectionTouchesMentionBoundary } from "../../composer-editor-mentions";
import { $selectionTouchesInlineToken, $setComposerEditorPrompt, $setSelectionRangeAtComposerOffsets, getSelectionRangeForExpandedComposerOffsets } from "./selection";

const SURROUND_SYMBOLS: [string, string][] = [
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["'", "'"],
  ['"', '"'],
  ["“", "”"],
  ["`", "`"],
  ["<", ">"],
  ["«", "»"],
  ["*", "*"],
  ["_", "_"],
];
const SURROUND_SYMBOLS_MAP = new Map<string, string>(SURROUND_SYMBOLS);
const BACKTICK_SURROUND_CLOSE_SYMBOL = SURROUND_SYMBOLS_MAP.get("`") ?? null;

export function ComposerSurroundSelectionPlugin() {
  const [editor] = useLexicalComposerContext();
  const pendingSurroundSelectionRef = useRef<{
    value: string;
    expandedStart: number;
    expandedEnd: number;
  } | null>(null);
  const pendingDeadKeySelectionRef = useRef<{
    value: string;
    expandedStart: number;
    expandedEnd: number;
  } | null>(null);

  const applySurroundInsertion = useEffectEvent((inputData: string): boolean => {
    const surroundCloseSymbol = SURROUND_SYMBOLS_MAP.get(inputData);
    const pendingSurroundSelection = pendingSurroundSelectionRef.current;
    if (!surroundCloseSymbol) {
      pendingSurroundSelectionRef.current = null;
      return false;
    }

    let handled = false;
    editor.update(() => {
      const selectionSnapshot =
        pendingSurroundSelection ??
        (() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || selection.isCollapsed()) {
            return null;
          }
          if ($selectionTouchesInlineToken(selection)) {
            return null;
          }
          const range = getSelectionRangeForExpandedComposerOffsets(selection);
          if (!range || range.start === range.end) {
            return null;
          }
          const value = $getRoot().getTextContent();
          if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
            return null;
          }
          return {
            value,
            expandedStart: range.start,
            expandedEnd: range.end,
          };
        })();

      if (!selectionSnapshot || !surroundCloseSymbol) {
        return;
      }

      const selectedText = selectionSnapshot.value.slice(
        selectionSnapshot.expandedStart,
        selectionSnapshot.expandedEnd,
      );
      const nextValue = `${selectionSnapshot.value.slice(0, selectionSnapshot.expandedStart)}${inputData}${selectedText}${surroundCloseSymbol}${selectionSnapshot.value.slice(selectionSnapshot.expandedEnd)}`;
      $setComposerEditorPrompt(nextValue);
      const selectionStart = collapseExpandedComposerCursor(
        nextValue,
        selectionSnapshot.expandedStart,
      );
      $setSelectionRangeAtComposerOffsets(
        selectionStart + inputData.length,
        selectionStart + inputData.length + selectedText.length,
      );
      handled = true;
      pendingSurroundSelectionRef.current = null;
    });

    return handled;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (pendingDeadKeySelectionRef.current) {
        if (event.key === "Dead" || event.key === " " || event.code === "Space") {
          return;
        }
        pendingDeadKeySelectionRef.current = null;
      }

      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey) {
        pendingSurroundSelectionRef.current = null;
        pendingDeadKeySelectionRef.current = null;
        return;
      }

      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        if ($selectionTouchesInlineToken(selection)) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const range = getSelectionRangeForExpandedComposerOffsets(selection);
        if (!range || range.start === range.end) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const value = $getRoot().getTextContent();
        if (selectionTouchesMentionBoundary(value, range.start, range.end)) {
          pendingSurroundSelectionRef.current = null;
          pendingDeadKeySelectionRef.current = null;
          return;
        }
        const snapshot = {
          value,
          expandedStart: range.start,
          expandedEnd: range.end,
        };
        pendingSurroundSelectionRef.current = snapshot;
        pendingDeadKeySelectionRef.current = null;
      });
    };

    const onBeforeInput = (event: InputEvent) => {
      if (
        event.inputType === "insertCompositionText" &&
        event.data === "`" &&
        BACKTICK_SURROUND_CLOSE_SYMBOL !== null &&
        pendingSurroundSelectionRef.current
      ) {
        pendingDeadKeySelectionRef.current = pendingSurroundSelectionRef.current;
        return;
      }

      if (pendingDeadKeySelectionRef.current) {
        return;
      }

      if (event.inputType === "insertCompositionText") {
        return;
      }

      if (typeof event.data !== "string") {
        pendingSurroundSelectionRef.current = null;
        return;
      }
      const inputData = event.inputType === "insertText" ? event.data : null;
      if (!inputData || inputData.length !== 1) {
        pendingSurroundSelectionRef.current = null;
        return;
      }
      if (!applySurroundInsertion(inputData)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const tryApplyDeadKeyBacktickSurround = (options?: { finalAttempt?: boolean }) => {
      queueMicrotask(() => {
        editor.update(
          () => {
            const pendingDeadKeySelection = pendingDeadKeySelectionRef.current;
            if (!pendingDeadKeySelection) {
              return;
            }

            const currentValue = $getRoot().getTextContent();
            const backtickCloseSymbol = BACKTICK_SURROUND_CLOSE_SYMBOL;
            if (backtickCloseSymbol === null) {
              pendingDeadKeySelectionRef.current = null;
              return;
            }

            const expectedResolvedValue = `${pendingDeadKeySelection.value.slice(0, pendingDeadKeySelection.expandedStart)}\`${pendingDeadKeySelection.value.slice(pendingDeadKeySelection.expandedEnd)}`;
            if (currentValue !== expectedResolvedValue) {
              if (options?.finalAttempt) {
                pendingSurroundSelectionRef.current = null;
                pendingDeadKeySelectionRef.current = null;
              }
              return;
            }

            const selectedText = pendingDeadKeySelection.value.slice(
              pendingDeadKeySelection.expandedStart,
              pendingDeadKeySelection.expandedEnd,
            );
            const replacementStart = collapseExpandedComposerCursor(
              currentValue,
              pendingDeadKeySelection.expandedStart,
            );
            $setSelectionRangeAtComposerOffsets(replacementStart, replacementStart + 1);
            const replacementSelection = $getSelection();
            if (!$isRangeSelection(replacementSelection)) {
              pendingSurroundSelectionRef.current = null;
              pendingDeadKeySelectionRef.current = null;
              return;
            }
            replacementSelection.insertText(`\`${selectedText}${backtickCloseSymbol}`);
            $setSelectionRangeAtComposerOffsets(
              replacementStart + 1,
              replacementStart + 1 + selectedText.length,
            );
            pendingSurroundSelectionRef.current = null;
            pendingDeadKeySelectionRef.current = null;
          },
          { tag: HISTORY_MERGE_TAG },
        );
      });
    };

    const onInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (
        inputEvent.inputType === "insertText" ||
        inputEvent.inputType === "insertCompositionText"
      ) {
        tryApplyDeadKeyBacktickSurround();
      }
    };

    const onCompositionEnd = () => {
      tryApplyDeadKeyBacktickSurround({ finalAttempt: true });
    };

    let activeRootElement: HTMLElement | null = null;
    const unregisterRootListener = editor.registerRootListener((rootElement, prevRootElement) => {
      prevRootElement?.removeEventListener("keydown", onKeyDown);
      prevRootElement?.removeEventListener("beforeinput", onBeforeInput, true);
      prevRootElement?.removeEventListener("input", onInput);
      prevRootElement?.removeEventListener("compositionend", onCompositionEnd);
      rootElement?.addEventListener("keydown", onKeyDown);
      rootElement?.addEventListener("beforeinput", onBeforeInput, true);
      rootElement?.addEventListener("input", onInput);
      rootElement?.addEventListener("compositionend", onCompositionEnd);
      activeRootElement = rootElement;
    });

    return () => {
      if (activeRootElement) {
        activeRootElement.removeEventListener("keydown", onKeyDown);
        activeRootElement.removeEventListener("beforeinput", onBeforeInput, true);
        activeRootElement.removeEventListener("input", onInput);
        activeRootElement.removeEventListener("compositionend", onCompositionEnd);
      }
      unregisterRootListener();
    };
  }, [editor]);

  return null;
}
