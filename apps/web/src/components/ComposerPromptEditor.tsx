// Adapted from pingdotgg/t3code apps/web/src/components/ComposerPromptEditor.tsx at 57a66608 (MIT).
// Differs from upstream: every chip's text is what the agent is sent, so the
// prompt carries no placeholder and no list of terminal contexts beside it,
// and the nodes read their fields off the segment the text parses into (a
// file as @path, a skill as $name, a terminal excerpt as a fenced block, a
// quote or a pull request or issue as a blockquote under one header). The
// skill chip is named by the skill's own name, so no skill catalog is a prop.
// The paste plugin makes chips of pasted blocks alone: a pasted @word stays
// text, since code is full of decorators. The command key plugin also relays
// Escape. The editor namespace is ours.
import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { $getRoot, type EditorState } from "lexical";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";

import { clampCollapsedComposerCursor, clampCursor, collapseExpandedComposerCursor, expandCollapsedComposerCursor } from "../composer-logic";
import { cn } from "../lib/utils";
import { ComposerCitationNode } from "./ComposerCitationNode";
import { ComposerMentionNode, ComposerSkillNode, ComposerTerminalContextNode } from "./composer-editor/nodes";
import { $readExpandedSelectionOffsetFromEditorState, $readSelectionOffsetFromEditorState, $setComposerEditorPrompt, $setSelectionAtComposerOffset } from "./composer-editor/selection";
import type { ComposerPromptEditorProps, ComposerSnapshot } from "./composer-editor/types";
import { ComposerChipSelectionPlugin, ComposerCommandKeyPlugin, ComposerHomeEndKeyPlugin, ComposerInlineTokenArrowPlugin, ComposerInlineTokenBackspacePlugin, ComposerInlineTokenPastePlugin, ComposerInlineTokenSelectionNormalizePlugin } from "./composer-editor/plugins";
import { ComposerSurroundSelectionPlugin } from "./composer-editor/surround";

export type { ComposerCommandKey, ComposerPromptEditorHandle, ComposerSnapshot } from "./composer-editor/types";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;

function ComposerPromptEditorInner({ value, cursor, disabled, placeholder, shortPlaceholder, className, onChange, onCommandKeyDown, editorRef }: ComposerPromptEditorProps) {
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const snapshotRef = useRef<ComposerSnapshot>({ value, cursor: initialCursor, expandedCursor: expandCollapsedComposerCursor(value, initialCursor) });
  const isApplyingControlledUpdateRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    if (previousSnapshot.value === value && previousSnapshot.cursor === normalizedCursor) {
      return;
    }

    snapshotRef.current = { value, cursor: normalizedCursor, expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor) };

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !isFocused) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    editor.update(() => {
      const shouldRewriteEditorState = previousSnapshot.value !== value;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(normalizedCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [cursor, editor, value]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      // Lexical answers a selection write by setting the DOM's selection and scrolling the caret into view, which forces
      // a layout of the page, and a thread switch asks for focus in the frame that lays out the next transcript.
      if (document.activeElement === rootElement && snapshotRef.current.cursor === boundedCursor && editor.getEditorState().read(() => $readSelectionOffsetFromEditorState(-1)) === boundedCursor) return;
      rootElement.focus({ preventScroll: true });
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      const current = snapshotRef.current.value;
      snapshotRef.current = { value: current, cursor: boundedCursor, expandedCursor: expandCollapsedComposerCursor(current, boundedCursor) };
      onChangeRef.current(current, boundedCursor);
    },
    [editor],
  );

  const $readSnapshot = useCallback((): ComposerSnapshot => {
    const nextValue = $getRoot().getTextContent();
    const nextCursor = clampCollapsedComposerCursor(nextValue, $readSelectionOffsetFromEditorState(clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor)));
    const nextExpandedCursor = clampCursor(nextValue, $readExpandedSelectionOffsetFromEditorState(clampCursor(nextValue, snapshotRef.current.expandedCursor)));
    return { value: nextValue, cursor: nextCursor, expandedCursor: nextExpandedCursor };
  }, []);

  const readSnapshot = useCallback((): ComposerSnapshot => {
    let snapshot = snapshotRef.current;
    editor.getEditorState().read(() => {
      snapshot = $readSnapshot();
    });
    snapshotRef.current = snapshot;
    return snapshot;
  }, [$readSnapshot, editor]);

  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(collapseExpandedComposerCursor(snapshotRef.current.value, snapshotRef.current.value.length));
      },
      readSnapshot,
    }),
    [focusAt, readSnapshot],
  );

  const handleEditorChange = useCallback(
    (editorState: EditorState) => {
      editorState.read(() => {
        const next = $readSnapshot();
        const previousSnapshot = snapshotRef.current;
        if (previousSnapshot.value === next.value && previousSnapshot.cursor === next.cursor && previousSnapshot.expandedCursor === next.expandedCursor) {
          return;
        }
        if (isApplyingControlledUpdateRef.current) {
          return;
        }
        snapshotRef.current = next;
        onChangeRef.current(next.value, next.cursor);
      });
    },
    [$readSnapshot],
  );

  return (
    <div className="@container/editor relative [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)] [@media(max-width:39.999rem)_and_(pointer:coarse)]:[font-size:max(var(--font-size-prompt,1rem),16px)]">
      <PlainTextPlugin
        contentEditable={
          <ContentEditable
            className={cn(
              // The wrapper owns the appearance preference; keep everything else here.
              "block max-h-50 min-h-17.5 w-full overflow-y-auto whitespace-pre-wrap wrap-break-word bg-transparent leading-relaxed text-foreground focus:outline-none",
              className,
            )}
            data-testid="composer-editor"
            aria-placeholder={placeholder}
            placeholder={<span />}
          />
        }
        placeholder={
          <div className="pointer-events-none absolute inset-0 truncate leading-relaxed text-placeholder">
            {shortPlaceholder === undefined || shortPlaceholder === placeholder ? (
              placeholder
            ) : (
              <>
                <span className="@max-[15rem]/editor:hidden">{placeholder}</span>
                <span className="@min-[15rem]/editor:hidden">{shortPlaceholder}</span>
              </>
            )}
          </div>
        }
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={handleEditorChange} />
      <ComposerCommandKeyPlugin {...(onCommandKeyDown ? { onCommandKeyDown } : {})} />
      <ComposerSurroundSelectionPlugin />
      <ComposerHomeEndKeyPlugin />
      <ComposerInlineTokenArrowPlugin />
      <ComposerInlineTokenSelectionNormalizePlugin />
      <ComposerInlineTokenBackspacePlugin />
      <ComposerInlineTokenPastePlugin />
      <ComposerChipSelectionPlugin />
      <HistoryPlugin />
    </div>
  );
}

export function ComposerPromptEditor({ value, cursor, disabled, placeholder, shortPlaceholder, className, onChange, onCommandKeyDown, editorRef }: ComposerPromptEditorProps) {
  const initialValueRef = useRef(value);
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "wsp-composer-editor",
      editable: true,
      nodes: [ComposerMentionNode, ComposerSkillNode, ComposerCitationNode, ComposerTerminalContextNode],
      editorState: () => {
        $setComposerEditorPrompt(initialValueRef.current);
      },
      onError: (error) => {
        throw error;
      },
    }),
    [],
  );

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        disabled={disabled}
        placeholder={placeholder}
        {...(shortPlaceholder !== undefined ? { shortPlaceholder } : {})}
        onChange={onChange}
        editorRef={editorRef}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
      />
    </LexicalComposer>
  );
}
