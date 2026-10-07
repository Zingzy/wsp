// SPDX-License-Identifier: AGPL-3.0-only
// The composer's one row for a turn the agent's usage limit stopped, drawn in
// the composer's own frame as a settings row: the gauge in its glyph frame,
// the state as the title with the agent's sentence under it, then in the row's
// slot the reset as a fact and the one act. Resume at reset arms the host to
// go on with the turn at the reset, and the same button cancels while armed;
// where the agent named no reset there is nothing to arm and the row stands
// bare. Once the turn goes on the strip goes and the composer stands alone;
// the timeline keeps the record as a notice line.
import { GaugeIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { LIMIT_WORDS, resetsWord, type TurnLimit } from "@wsp/protocol";
import { cn } from "../../lib/utils";
import { FACT } from "../../settings/format";
import { GlyphFrame } from "../../settings/grid";
import { LIST_TITLE, NOTE } from "../../settings/layout";
import { LED_SLOT_INDENT, SLOT_CLASS, SPLIT_CLASS } from "../../settings/rows";
import { useMinuteClock } from "../status/useMinuteClock";
import { Button } from "../ui/button";
import { ComposerSurface } from "./ComposerSurface";

export function LimitStrip({
  agent,
  limit,
  resumeAt,
  onResume,
  onCancel,
}: {
  /** The agent whose limit it is, by its harness id. */
  agent: string;
  limit: TurnLimit;
  /** The reset the turn is armed to go on at; null while nobody armed it. */
  resumeAt: number | null;
  onResume: () => void;
  onCancel: () => void;
}) {
  const now = useMinuteClock();
  const name = agentName(agent);
  const armed = resumeAt !== null;
  const resetsAt = limit.resetsAt;
  const title = armed ? LIMIT_WORDS.resuming : LIMIT_WORDS.reached;
  const note = armed ? LIMIT_WORDS.armed(name) : resetsAt === undefined ? LIMIT_WORDS.stoppedUnknown(name) : LIMIT_WORDS.stopped(name);
  return (
    <div className="px-3 pb-2 sm:px-4">
      <ComposerSurface.Shell data-limit-strip={armed ? "armed" : resetsAt === undefined ? "unknown" : "hit"}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className={cn("min-h-15 px-5 py-3", resetsAt === undefined ? "flex items-center" : SPLIT_CLASS)}>
              <div className="flex min-w-0 items-center gap-3">
                <GlyphFrame>
                  <GaugeIcon aria-hidden className="size-4 text-foreground/80" />
                </GlyphFrame>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span data-limit-title className={LIST_TITLE}>
                    {title}
                  </span>
                  <span data-limit-note className={cn(NOTE, "break-words")}>
                    {note}
                  </span>
                </span>
              </div>
              {resetsAt === undefined ? null : (
                <div data-limit-slot className={cn(SLOT_CLASS, LED_SLOT_INDENT)}>
                  <span data-limit-reset className={cn(FACT, "shrink-0")}>
                    {resetsWord(resetsAt, now)}
                  </span>
                  {armed ? (
                    <Button size="xs" variant="outline" data-limit-act="cancel" onClick={onCancel}>
                      {LIMIT_WORDS.cancel}
                    </Button>
                  ) : (
                    <Button size="xs" variant="outline" data-limit-act="resume" onClick={onResume}>
                      {LIMIT_WORDS.resume}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
