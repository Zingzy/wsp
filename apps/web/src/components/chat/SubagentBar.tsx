// SPDX-License-Identifier: AGPL-3.0-only
// A subagent's page bar, in the composer's place and in T3 Code's order and weights: inside the composer's shell,
// host and surface, at its row's height, radius and border, since nobody writes to a subagent. Nobody types there, so
// it hugs what it says, centred in the composer's column, at the composer row's insets (20 px left, 16 under 640, 8
// right) with 12 px between its groups: the agent's mark and the model, 6 px apart, the model a label and not a menu;
// the state, muted and tabular, clipped with the whole of it on hover, wrapping under 640 px where there is no hover;
// then Back to lead, a ghost button whose words stand on its tooltip under 640 px. A running subagent's time is the
// timeline's own WorkingTimer, written to its node once a second, so the page never draws again while it ticks. Stop
// is on its row's hover. A screen reader hears the state word once each time it changes.
import { agentName } from "@wsp/catalog";
import { fmtDuration, type SubagentView } from "@wsp/protocol";
import { ArrowUpLeftIcon } from "lucide-react";
import { ComposerSurface } from "./ComposerSurface";
import { HarnessMark } from "./HarnessMark";
import { WorkingTimer } from "./timeline/working";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const SUBAGENT_BAR_WORDS = {
  back: "Back to lead",
  workingFor: "Working for",
  workedFor: (ran: string | null): string => (ran === null ? "Done" : `Worked for ${ran}`),
  stoppedAfter: (ran: string | null): string => (ran === null ? "Stopped" : `Stopped after ${ran}`),
  failedWhy: (why: string | undefined): string => (why === undefined ? "Failed" : `Failed: ${why}`),
  state: { running: "Working", done: "Done", failed: "Failed", stopped: "Stopped" },
} as const;

/** What an ended subagent's bar says: how long it worked, why it failed, or when it was stopped. */
function endedLine(subagent: SubagentView): string {
  const ran = subagent.endedAt === undefined ? null : fmtDuration(subagent.endedAt - subagent.startedAt);
  if (subagent.state === "failed") return SUBAGENT_BAR_WORDS.failedWhy(subagent.failure);
  return subagent.state === "stopped" ? SUBAGENT_BAR_WORDS.stoppedAfter(ran) : SUBAGENT_BAR_WORDS.workedFor(ran);
}

export function SubagentBar({ subagent, harness, model, onBack }: { subagent: SubagentView; harness: string; model: string; onBack: () => void }) {
  const running = subagent.state === "running";
  const ended = running ? null : endedLine(subagent);
  const state = (
    <span data-subagent-state className="min-w-0 break-words text-note text-muted-foreground tabular-nums max-sm:line-clamp-3 sm:truncate">
      {ended ?? (
        <>
          {SUBAGENT_BAR_WORDS.workingFor} <WorkingTimer createdAt={new Date(subagent.startedAt).toISOString()} />
        </>
      )}
    </span>
  );
  return (
    <div className="relative w-full px-3 pt-1.5 pb-4 sm:px-5 sm:pt-2 sm:pb-5">
      <ComposerSurface.Shell data-subagent-composer className="w-fit">
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div data-subagent-bar className="flex min-h-12 items-center gap-3 py-2 ps-4 pe-2 sm:ps-5">
              <Tooltip>
                <TooltipTrigger render={<span data-subagent-model className="inline-flex shrink-0 items-center gap-1.5 text-note text-foreground" />}>
                  <HarnessMark harness={harness} label={agentName(harness)} className="size-4" />
                  <span className="max-sm:sr-only">{model}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">{`${agentName(harness)}, ${model}`}</TooltipPopup>
              </Tooltip>
              {ended === null ? (
                state
              ) : (
                <Tooltip>
                  <TooltipTrigger render={<span className="flex min-w-0" />}>{state}</TooltipTrigger>
                  <TooltipPopup side="top" className="max-w-96 whitespace-normal">
                    {ended}
                  </TooltipPopup>
                </Tooltip>
              )}
              <span role="status" className="sr-only">
                {SUBAGENT_BAR_WORDS.state[subagent.state]}
              </span>
              <span className="ms-auto flex shrink-0 items-center">
                <Tooltip>
                  <TooltipTrigger render={<Button type="button" variant="ghost" data-subagent-back aria-label={SUBAGENT_BAR_WORDS.back} onClick={onBack} />}>
                    <ArrowUpLeftIcon aria-hidden />
                    <span className="max-sm:hidden">{SUBAGENT_BAR_WORDS.back}</span>
                  </TooltipTrigger>
                  <TooltipPopup side="top">{SUBAGENT_BAR_WORDS.back}</TooltipPopup>
                </Tooltip>
              </span>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
