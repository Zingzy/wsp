// SPDX-License-Identifier: AGPL-3.0-only
// The side question /btw opens on its own tab of the right panel: the question,
// the crab and Asking until the host answers, then the answer, or the host's
// refusal in its place. It scrolls inside the panel when the answer runs long,
// and Esc while it shows, or its tab's close, takes it away; nothing of it is
// kept.
import { useEffect } from "react";
import ChatMarkdown from "../ChatMarkdown";
import { useAppDark } from "../../settings/theme.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { Crab } from "../status/Crab.js";
import { PANES } from "../../panes.js";

export const ASIDE_WORDS = {
  note: "Answered from this thread's conversation. Nothing here is kept.",
  asking: "Asking",
} as const;

export function AsideSurface({ question, answer, error, onClose }: { question: string; answer?: string | undefined; error?: string | undefined; onClose: () => void }) {
  const dark = useAppDark();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section data-k="aside-surface" aria-label={PANES.aside.label} className="flex h-full min-h-0 flex-1 flex-col">
      <div data-k="aside-body" className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-4">
        <p className="text-xs leading-4 text-muted-foreground">{ASIDE_WORDS.note}</p>
        <p data-k="aside-question" className="ms-auto mt-4 w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-message px-3 py-2 text-sm leading-5 text-message-foreground">
          {question}
        </p>
        <div className="mt-4">
          {answer !== undefined ? (
            <div data-k="aside-answer" className="min-w-0">
              <ChatMarkdown text={answer} cwd={undefined} resolvedTheme={dark ? "dark" : "light"} parseRawHtml={false} />
            </div>
          ) : error !== undefined ? (
            <RefusalSlot k="aside-refused" said={error} />
          ) : (
            <div data-k="aside-asking" className="flex h-6 items-center gap-2 text-[13px] leading-5 text-muted-foreground">
              <Crab className="text-status-working" />
              {ASIDE_WORDS.asking}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
