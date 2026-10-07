// SPDX-License-Identifier: AGPL-3.0-only
// The bell at the right end of the header row: the notices a toast said
// once, newest first, so one gone before it was read can be read again.
import { BellIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover.js";
import { clockLabel } from "../lib/timestampFormat.js";
import { cn } from "../lib/utils.js";
import { NOTICE_KINDS } from "./Notice.js";
import { useNotices, type Notice } from "./store.js";

export const BELL_WORDS = {
  label: "Notices",
  unread: (n: number): string => `Notices, ${n} unread`,
  clear: "Clear all",
  empty: "Nothing yet",
} as const;

function NoticeRow({ notice, onAct }: { notice: Notice; onAct: () => void }) {
  const { word, Icon, tone } = NOTICE_KINDS[notice.kind];
  const { action } = notice;
  return (
    <li data-notice-row="" data-kind={notice.kind} className="flex h-18 items-start gap-3 px-2 py-2">
      <Icon role="img" aria-label={word} className={cn("mt-0.5 size-4 shrink-0", tone)} />
      <div className="min-w-0 flex-1 select-text">
        <p data-notice-row-text="" className="line-clamp-2 break-words text-note leading-5 text-foreground" title={notice.text}>
          {notice.text}
        </p>
        <p className="flex min-w-0 gap-3 text-xs leading-4 text-muted-foreground">
          {notice.where === undefined ? null : <span className="min-w-0 truncate">{notice.where}</span>}
          <span className="shrink-0 tabular-nums">{clockLabel(new Date(notice.at).toISOString())}</span>
        </p>
      </div>
      <div data-notice-row-action="" className="flex shrink-0">
        {action === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              action.run();
              onAct();
            }}
          >
            {action.word}
          </Button>
        )}
      </div>
    </li>
  );
}

export function NoticesBell() {
  const notices = useNotices(s => s.notices);
  const unread = useNotices(s => s.unread);
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (next) useNotices.getState().read();
      }}
    >
      <PopoverTrigger
        data-k="notices-bell"
        aria-label={unread === 0 ? BELL_WORDS.label : BELL_WORDS.unread(unread)}
        title={BELL_WORDS.label}
        className={cn(
          "inline-flex h-7 min-w-7 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-1.5 transition-colors duration-150 hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]",
          unread > 0 || open ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <BellIcon aria-hidden className="size-3.5" />
        {unread === 0 ? null : (
          <span data-k="notices-unread" className="font-mono text-meta leading-4 tabular-nums text-muted-foreground">
            {unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" viewportClassName="py-1 [--viewport-inline-padding:--spacing(1)]">
        <div data-notices-list="" className="flex w-90 max-w-full flex-col">
          {notices.length === 0 ? (
            <p data-k="notices-empty" className="py-6 text-center text-note leading-5 text-muted-foreground">
              {BELL_WORDS.empty}
            </p>
          ) : (
            <>
              <ul className="flex max-h-96 flex-col overflow-y-auto">
                {notices.map(n => (
                  <NoticeRow key={n.id} notice={n} onAct={() => setOpen(false)} />
                ))}
              </ul>
              <div className="flex justify-end border-t border-border/50 px-1 pt-1">
                <Button data-k="notices-clear" size="xs" variant="ghost" onClick={() => useNotices.getState().clear()}>
                  {BELL_WORDS.clear}
                </Button>
              </div>
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
