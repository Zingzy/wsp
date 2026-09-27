// SPDX-License-Identifier: AGPL-3.0-only
// The sheet a /btw opens over the thread: the question as the person's own
// row, the crab and Asking until the host answers, then the answer, or the
// host's refusal in its place. Esc, the scrim or Close take it away, and
// nothing of it is kept anywhere: the thread never sees it.
import ChatMarkdown from "../ChatMarkdown";
import { useAppDark } from "../../settings/theme.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { Crab } from "../status/Crab.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog.js";

export function AsideSheet({ question, answer, error, onClose }: { question: string; answer?: string; error?: string; onClose: () => void }) {
  const dark = useAppDark();
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup data-k="aside-sheet">
        <DialogHeader>
          <DialogTitle>Side question</DialogTitle>
          <DialogDescription>Answered from this thread's conversation. Nothing here is kept.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <div data-k="aside-question" className="ms-auto max-w-[80%] whitespace-pre-wrap break-words rounded-2xl bg-message p-3 text-[15px] leading-[22px] text-message-foreground">
            {question}
          </div>
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
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
