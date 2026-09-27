// Adapted from pingdotgg/t3code apps/web/src/components/chat/AssistantSelectionToolbar.tsx at 57a66608 (MIT).
// Differs from upstream: the selection is quoted as its text with the prompt
// the reply answered, read off the reply's own row, rather than cited by a
// selector into the message; there is no length cap, since the quote is the
// text itself; the button says Quote.
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { observeSelectionActions, resolveSelectionActionPosition, type SelectionActionPoint } from "../../lib/selectionActions";
import { Button } from "../ui/button";

/** The attribute an assistant reply's row carries, holding the prompt that reply answered. */
export const QUOTE_SOURCE_ATTRIBUTE = "data-quote-reply-to";

export interface QuotedSelection {
  readonly text: string;
  readonly replyTo: string | null;
}

/** The selection as a quote: its text and the reply it sits inside, where it starts and ends inside one reply. */
export function readQuotedSelection(viewport: HTMLElement, selection: Selection | null): (QuotedSelection & { range: Range }) | null {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const sourceOf = (node: Node | null) => (node instanceof Element ? node : (node?.parentElement ?? null))?.closest<HTMLElement>(`[${QUOTE_SOURCE_ATTRIBUTE}]`) ?? null;
  const source = sourceOf(range.startContainer);
  if (source === null || !viewport.contains(source) || sourceOf(range.endContainer) !== source) return null;
  const text = selection.toString().trim();
  if (text.length === 0) return null;
  const replyTo = source.getAttribute(QUOTE_SOURCE_ATTRIBUTE) ?? "";
  return { text, replyTo: replyTo.length > 0 ? replyTo : null, range };
}

export function AssistantSelectionToolbar({ viewport, onQuote }: { viewport: HTMLElement | null; onQuote: (quote: QuotedSelection) => void }) {
  const [selection, setSelection] = useState<{ quote: QuotedSelection; position: SelectionActionPoint } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const read = readQuotedSelection(viewport, window.getSelection());
      if (read === null) {
        clear();
        return;
      }
      const rect = read.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom) {
        clear();
        return;
      }
      const rects = read.range.getClientRects();
      setSelection({
        quote: { text: read.text, replyTo: read.replyTo },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({ element: viewport, getActionElement: () => toolbarRef.current, onSelection: update, onDismiss: clear });
    actionsRef.current = actions;
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [viewport]);

  if (!selection) return null;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="outline"
      aria-label="Quote the selection in the message"
      className="fixed z-50"
      style={{ left: selection.position.x, top: selection.position.y }}
      data-quote-selection="true"
      onPointerDown={event => event.preventDefault()}
      onClick={() => {
        onQuote(selection.quote);
        window.getSelection()?.removeAllRanges();
        dismiss();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" />
      Quote
    </Button>,
    document.body,
  );
}
