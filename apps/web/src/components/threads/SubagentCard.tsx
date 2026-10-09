// SPDX-License-Identifier: AGPL-3.0-only
// A subagent's card, opened when the pointer rests on its row, in the tile card's skin: its title, the status row,
// what it was asked under the message glyph, and its agent's mark with its model.
import { agentName } from "@wsp/catalog";
import type { SubagentView } from "@wsp/protocol";
import { MessageSquareTextIcon } from "lucide-react";
import { CHILD_WORDS } from "../../actions/format.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import type { StatusKind } from "../status/kinds/index.js";
import { restingAge } from "../status/restingAge.js";
import { StatusLine } from "../status/StatusLine.js";
import { TooltipPopup } from "../ui/tooltip.js";
import { subagentStatus } from "./leadTree.js";

export function SubagentCard({ subagent, harness, kind, reason }: { subagent: SubagentView; harness: string; kind: StatusKind; reason: string | undefined }) {
  const status = subagentStatus(subagent);
  const ended = subagent.endedAt === undefined ? null : new Date(subagent.endedAt).toISOString();
  return (
    <TooltipPopup side="right" align="start" sideOffset={6} data-subagent-card className="max-w-72 text-left whitespace-normal">
      <div className="flex min-w-0 flex-col gap-1.5 py-1">
        <p data-tile-card-title className="font-medium text-foreground">
          {subagent.title}
        </p>
        <ul className="flex min-w-0 flex-col gap-1 text-muted-foreground">
          <StatusLine thread={status} kind={kind} age={restingAge({ startedAt: status.startedAt, endedAt: ended })} {...(reason !== undefined ? { reason } : {})} />
          {subagent.asked === undefined ? null : (
            <li data-tile-card-line="asked" className="flex min-w-0 items-start gap-2">
              <span className="mt-0.75 flex shrink-0">
                <MessageSquareTextIcon role="img" aria-label={CHILD_WORDS.asked} className="size-3" />
              </span>
              <span className="line-clamp-3 min-w-0 break-words">{subagent.asked}</span>
            </li>
          )}
          <li data-tile-card-line="agent" className="flex min-w-0 items-start gap-2">
            <span className="mt-0.75 flex shrink-0">
              <HarnessMark harness={harness} label={agentName(harness)} className="size-3" />
            </span>
            <span className="min-w-0 break-words">{subagent.model ?? agentName(harness)}</span>
          </li>
        </ul>
      </div>
    </TooltipPopup>
  );
}
