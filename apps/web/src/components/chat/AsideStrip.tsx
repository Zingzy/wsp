// SPDX-License-Identifier: AGPL-3.0-only
// The strip a /btw grows above the composer's box: the question, the crab and
// Asking until the host answers, then the answer, or the host's refusal in its
// place. It stands out of the composer's flow, so the thread's inset and the
// box stay where they were, and scrolls inside itself when the answer runs
// long. Esc or its close control take it away, and nothing of it is kept.
import { useEffect } from "react";
import { XIcon } from "lucide-react";
import ChatMarkdown from "../ChatMarkdown";
import { useAppDark } from "../../settings/theme.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { Crab } from "../status/Crab.js";
import { Button } from "../ui/button.js";

export function AsideStrip({ question, answer, error, onClose }: { question: string; answer?: string; error?: string; onClose: () => void }) {
  const dark = useAppDark();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div data-k="aside-strip" className="pointer-events-none absolute inset-x-3 bottom-full z-20 sm:inset-x-5">
      <div className="dropdown-glass popover-shadow pointer-events-auto mx-auto flex w-full max-w-3xl flex-col rounded-[12px]">
        <div className="flex items-start gap-2 ps-3 pe-1.5 pt-1.5">
          <p data-k="aside-question" className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-sm leading-5 text-foreground">
            {question}
          </p>
          <Button size="icon-xs" variant="ghost-muted" aria-label="Close side question" title="Close side question" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
        <div data-k="aside-body" className="max-h-[min(40vh,20rem)] overflow-y-auto px-3 pt-1 pb-2.5">
          {answer !== undefined ? (
            <div data-k="aside-answer" className="min-w-0">
              <ChatMarkdown text={answer} cwd={undefined} resolvedTheme={dark ? "dark" : "light"} parseRawHtml={false} />
            </div>
          ) : error !== undefined ? (
            <RefusalSlot k="aside-refused" said={error} />
          ) : (
            <div data-k="aside-asking" className="flex h-6 items-center gap-2 text-[13px] leading-5 text-muted-foreground">
              <Crab className="text-status-working" />
              Asking
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
