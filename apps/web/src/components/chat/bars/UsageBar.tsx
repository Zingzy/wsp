// SPDX-License-Identifier: AGPL-3.0-only
// A turn the agent's usage limit stopped, in the composer's place: the state as
// the title with the agent's sentence under it, then Cancel and Resume at
// reset. Resume at reset arms the host to go on with the turn at the reset;
// Cancel takes that back where it was armed. Where the agent named no reset
// there is nothing to arm and the bar holds its words alone. Either act folds
// the bar back to the composer, where the drawer's row says what stands.
import { GaugeIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { LIMIT_WORDS, type TurnLimit } from "@wsp/protocol";
import { useStore } from "../../../protocol/store";
import { cn } from "../../../lib/utils";
import { NOTE } from "../../../settings/layout";
import { Button } from "../../ui/button";
import { DRAWER_WORDS } from "../ComposerDrawer";
import { Dock, DockBack } from "../Dock";
import { foldBar, useBarRoot } from "../composerBar";

/** A limit's title and the agent's sentence under it, for the bar and the drawer's row. */
export function limitWords(agent: string, limit: TurnLimit, resumeAt: number | null): { title: string; note: string } {
  const name = agentName(agent);
  if (resumeAt !== null) return { title: LIMIT_WORDS.resuming, note: LIMIT_WORDS.armed(name) };
  return { title: LIMIT_WORDS.reached, note: limit.resetsAt === undefined ? LIMIT_WORDS.stoppedUnknown(name) : LIMIT_WORDS.stopped(name) };
}

export function UsageBar({ agent, limit, resumeAt, threadKey, workspaceId }: { agent: string; limit: TurnLimit; resumeAt: number | null; threadKey: string; workspaceId: string }) {
  const armed = resumeAt !== null;
  const { title, note } = limitWords(agent, limit, resumeAt);
  const mark = (resumeAtReset: boolean) => {
    void useStore.getState().api?.markThreads?.([threadKey], { resumeAtReset });
    foldBar(threadKey, workspaceId);
  };
  const barRoot = useBarRoot(threadKey, workspaceId);
  return (
    <Dock
      {...barRoot}
      shell={{ "data-composer-bar": "usage", "data-limit-strip": armed ? "armed" : limit.resetsAt === undefined ? "unknown" : "hit" }}
      mark={<GaugeIcon aria-hidden className="size-4 shrink-0 text-warning" />}
      title={<span data-limit-title>{title}</span>}
      under={
        <p data-limit-note className={cn(NOTE, "break-words")}>
          {note}
        </p>
      }
      back={<DockBack word={DRAWER_WORDS.write} onClick={() => foldBar(threadKey, workspaceId)} />}
      acts={
        limit.resetsAt === undefined ? null : (
          <>
            <Button variant="outline" data-limit-act="cancel" onClick={() => (armed ? mark(false) : foldBar(threadKey, workspaceId))}>
              {LIMIT_WORDS.cancel}
            </Button>
            <Button data-limit-act="resume" held={armed} onClick={() => mark(true)}>
              {LIMIT_WORDS.resume}
            </Button>
          </>
        )
      }
    />
  );
}
