// SPDX-License-Identifier: AGPL-3.0-only
// A workspace's setup as the Add a computer dialog's step rows in one settings
// card, in the conversation's column: while it runs, the step under way
// ticking; refused, the step it stopped on with the reason, Retry and Dismiss;
// landed, every step done, standing as the thread's first content until its
// first message, so nothing on the page moves when the create ends.
import type { ReactNode } from "react";
import { Button } from "../ui/button.js";
import { useStore, type Creation } from "../../protocol/store.js";
import { RetryActs, StepRow, useNow } from "../../settings/add/StepRow.js";
import { Card } from "../../settings/rows.js";
import { CREATE_STEP_WORDS, creationSteps } from "../../shell/creationLog.js";

/** What the card is headed while the create runs and once it has landed. */
export const SETUP_HEADS = {
  running: (name: string): string => `Setting up ${name}`,
  landed: (name: string): string => `${name} is set up`,
} as const;

/** `landedAt` is when the create ended, for the card that stays on the workspace it became. */
export function SetupCard({ creation, landedAt }: { creation: Creation; landedAt?: number }) {
  const retry = useStore(s => s.retryCreation);
  const dismiss = useStore(s => s.dismissCreation);
  const now = useNow(creation.failed === null && landedAt === undefined);
  const acts = (
    <>
      <RetryActs onRetry={() => void retry(creation.key)} />
      <Button variant="ghost" size="xs" onClick={() => dismiss(creation.key)}>
        Dismiss
      </Button>
    </>
  );
  const head = creation.failed !== null ? CREATE_STEP_WORDS.failed : landedAt === undefined ? SETUP_HEADS.running(creation.name) : SETUP_HEADS.landed(creation.name);
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <Card id="setting-up" head={head}>
        {creationSteps(creation, landedAt ?? now, landedAt !== undefined).map(row => (
          <StepRow key={row.id} row={row} {...(row.state === "failed" ? { acts } : {})} />
        ))}
      </Card>
    </div>
  );
}

/** The room over the composer the card stands in the middle of, the same on the page a create runs on and on the
 * thread it lands as, so the card stays where it was when the one becomes the other. `above` is the message that
 * asked for the create, where one did. */
export function SetupRoom({ above, children }: { above?: ReactNode; children: ReactNode }) {
  return (
    <div data-k="setting-up-room" className="absolute inset-x-0 top-0 bottom-(--chat-composer-inset,0px) flex flex-col gap-4 overflow-y-auto px-3 pt-3 sm:px-5 sm:pt-4">
      {above}
      <div className="flex flex-1 items-center justify-center pb-6">{children}</div>
    </div>
  );
}
