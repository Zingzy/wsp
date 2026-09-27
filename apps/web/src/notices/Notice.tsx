// SPDX-License-Identifier: AGPL-3.0-only
// The toasts: top right of the centre pane, under the header row, newest on
// top, three at most.
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, MessageCircleQuestionIcon, XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button.js";
import { Toaster, toast } from "../components/ui/sonner.js";
import { cn } from "../lib/utils.js";
import { NOTICE_LIMIT, noticeTimeout, useNotices, type Notice as NoticeRecord, type NoticeKind } from "./store.js";

export const CLOSE_NOTICE_LABEL = "Close this message";

/** Each kind's glyph from the status set, its tone, and the word that names the glyph to a screen reader. */
export const NOTICE_KINDS: Readonly<Record<NoticeKind, { word: string; Icon: LucideIcon; tone: string }>> = {
  error: { word: "Failed", Icon: CircleAlertIcon, tone: "text-status-failed" },
  done: { word: "Done", Icon: CircleCheckIcon, tone: "text-status-done" },
  waiting: { word: "Needs you", Icon: MessageCircleQuestionIcon, tone: "text-status-input" },
  note: { word: "Note", Icon: InfoIcon, tone: "text-muted-foreground" },
};

/** Escape belongs to whatever holds the focus first: a field, a dialog or a menu. */
const ownsEscape = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role=dialog], [role=alertdialog], [role=menu], [role=listbox]") !== null);

const dismiss = (id: string): void => useNotices.getState().dismiss(id);

function Notice({ notice }: { notice: NoticeRecord }) {
  const { word, Icon, tone } = NOTICE_KINDS[notice.kind];
  const { action } = notice;
  return (
    <div data-notice="" data-notice-id={notice.id} data-kind={notice.kind} className="flex items-start gap-3 py-3 pr-2 pl-3 font-sans">
      <Icon role="img" aria-label={word} className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <div className="min-w-0 flex-1">
        <p data-notice-title="" className="line-clamp-2 break-words text-[13px] leading-5 font-medium text-foreground">
          {notice.text}
        </p>
        {notice.where === undefined ? null : (
          <p data-notice-where="" className="truncate text-xs leading-4 text-muted-foreground">
            {notice.where}
          </p>
        )}
      </div>
      {action === undefined ? null : (
        <Button
          data-notice-action=""
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => {
            action.run();
            dismiss(notice.id);
          }}
        >
          {action.word}
        </Button>
      )}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        className="shrink-0 opacity-0 transition-opacity duration-150 group-hover/toast:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        aria-label={CLOSE_NOTICE_LABEL}
        onClick={() => dismiss(notice.id)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** The notices store says which toasts stand; Sonner runs their timers, the pause on hover and the swipe. */
export function Notices() {
  const standing = useNotices(s => s.toasts);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const { notices } = useNotices.getState();
    for (const id of standing) {
      const notice = notices.find(n => n.id === id);
      if (shown.current.has(id) || notice === undefined) continue;
      shown.current.add(id);
      const timeout = noticeTimeout(notice);
      toast.custom(() => <Notice notice={notice} />, { id, duration: timeout === 0 ? Infinity : timeout, onDismiss: () => dismiss(id), onAutoClose: () => dismiss(id) });
    }
    for (const id of shown.current) {
      if (standing.includes(id)) continue;
      shown.current.delete(id);
      toast.dismiss(id);
    }
  }, [standing]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = event.target instanceof Element ? event.target.closest("[data-sonner-toast]")?.querySelector<HTMLElement>("[data-notice]")?.dataset.noticeId : undefined;
      const id = focused ?? (ownsEscape(event.target) ? undefined : useNotices.getState().toasts.at(-1));
      if (id === undefined) return;
      event.preventDefault();
      dismiss(id);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return <Toaster visibleToasts={NOTICE_LIMIT} offset={{ top: 8, right: 20 }} mobileOffset={{ top: 8, left: 12, right: 12 }} />;
}
