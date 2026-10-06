// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/ComposerPromptEditor.tsx at 57a66608 (MIT).
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $createRangeSelectionFromDom,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $createLineBreakNode,
  $createTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_BACKSPACE_COMMAND,
  BLUR_COMMAND,
  FOCUS_COMMAND,
  PASTE_COMMAND,
  $getRoot,
  DecoratorNode,
  type LexicalNode,
} from "lexical";
import { useEffect } from "react";

import { isCollapsedCursorAdjacentToInlineToken } from "../../composer-logic";
import { collectPastedBlockTokens } from "../../composer-editor-mentions";
import { isMacPlatform } from "../../lib/utils";
import { $createTokenNode, isComposerInlineTokenNode } from "./nodes";
import { $getComposerRootLength, $readSelectionOffsetFromEditorState, $setSelectionAtComposerOffset, getAbsoluteOffsetForPoint } from "./selection";
import type { ComposerCommandKey } from "./types";

export function ComposerCommandKeyPlugin(props: {
  onCommandKeyDown?: (key: ComposerCommandKey, event: KeyboardEvent) => boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (key: ComposerCommandKey, event: KeyboardEvent | null): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }

      if (key === "Enter" && (event.isComposing || event.keyCode === 229)) {
        event.stopPropagation();
        return true;
      }

      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => handleCommand("Escape", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => handleCommand("Tab", event),
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterEscape();
      unregisterTab();
    };
  }, [editor, props]);

  return null;
}

export function ComposerHomeEndKeyPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) => {
        if (!isMacPlatform(navigator.platform)) {
          return false;
        }
        if (event.key !== "Home" && event.key !== "End") {
          return false;
        }
        if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
          return false;
        }

        const rootElement = editor.getRootElement();
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        if (!rootElement || !selection || !anchorNode || !rootElement.contains(anchorNode)) {
          return false;
        }
        if (selection.rangeCount === 0 || typeof selection.modify !== "function") {
          return false;
        }

        event.preventDefault();
        event.stopPropagation();

        selection.modify(
          event.shiftKey ? "extend" : "move",
          event.key === "Home" ? "backward" : "forward",
          "lineboundary",
        );
        editor.update(() => {
          $setSelection($createRangeSelectionFromDom(selection, editor));
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

export function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

export function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

export function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          $setSelectionAtComposerOffset(tokenStart);
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor]);

  return null;
}

/**
 * Chips render as non-editable decorators, so the browser never paints the
 * native text selection over them; without help, a selection spanning chips
 * is only visible in the slivers between them. Mirror the selection onto the
 * chips with a data attribute the stylesheet turns into a highlight overlay.
 */
export function ComposerChipSelectionPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let selectedKeys = new Set<string>();
    // Lexical keeps the range selection on blur without emitting an update,
    // so focus is tracked separately; while blurred the native highlight is
    // gone and the mirrored one has to go with it.
    let hasFocus = editor.getRootElement() === document.activeElement;

    const applyKeys = (nextKeys: Set<string>) => {
      for (const key of selectedKeys) {
        if (!nextKeys.has(key)) {
          editor.getElementByKey(key)?.removeAttribute("data-composer-chip-selected");
        }
      }
      for (const key of nextKeys) {
        editor.getElementByKey(key)?.setAttribute("data-composer-chip-selected", "true");
      }
      selectedKeys = nextKeys;
    };

    const readSelectedKeys = () => {
      const nextKeys = new Set<string>();
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          for (const node of selection.getNodes()) {
            if (node instanceof DecoratorNode) {
              nextKeys.add(node.getKey());
            }
          }
        }
      });
      return nextKeys;
    };

    const unregisterUpdate = editor.registerUpdateListener(() => {
      applyKeys(hasFocus ? readSelectedKeys() : new Set());
    });
    const unregisterFocus = editor.registerCommand(
      FOCUS_COMMAND,
      () => {
        hasFocus = true;
        applyKeys(readSelectedKeys());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        hasFocus = false;
        applyKeys(new Set());
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      unregisterUpdate();
      unregisterFocus();
      unregisterBlur();
    };
  }, [editor]);

  return null;
}

export function ComposerInlineTokenPastePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        event => {
          if (!(event instanceof ClipboardEvent) || event.clipboardData === null) return false;
          const text = event.clipboardData.getData("text/plain");
          const tokens = collectPastedBlockTokens(text);
          const selection = $getSelection();
          if (tokens.length === 0 || event.clipboardData.files.length > 0 || !$isRangeSelection(selection)) return false;
          const nodes: LexicalNode[] = [];
          const appendText = (value: string) => {
            const lines = value.split("\n");
            for (let index = 0; index < lines.length; index += 1) {
              const line = lines[index] ?? "";
              if (line.length > 0) nodes.push($createTextNode(line));
              if (index < lines.length - 1) nodes.push($createLineBreakNode());
            }
          };
          let cursor = 0;
          for (const token of tokens) {
            if (token.start > cursor) appendText(text.slice(cursor, token.start));
            nodes.push($createTokenNode(token.segment));
            cursor = token.end;
          }
          if (cursor < text.length) appendText(text.slice(cursor));
          selection.insertNodes(nodes);
          event.preventDefault();
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );

  return null;
}
