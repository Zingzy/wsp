// SPDX-License-Identifier: AGPL-3.0-only
// One of an agent's own subagents in the sidebar, under the thread whose agent runs it: the slim one-line row with
// the bot's glyph, its title and its status, its card on rest, and while it runs Stop subagent beside the row in
// the status's place on hover, in the two presses every row's Stop takes, and alone in its menu. It names no project or computer of its own for a tile's first
// row to carry. A press opens its own page; the row of the page open is marked.
import type { SubagentView } from "@wsp/protocol";
import { BotIcon } from "lucide-react";
import { memo, type MouseEvent } from "react";
import { openContextMenu, runAction } from "../actions/contextMenu.js";
import { resolveActions } from "../actions/registry.js";
import { childActions, type ChildTarget } from "../actions/threadActions.js";
import { useChildVerbs } from "../actions/verbs.js";
import type { StatusKind } from "../components/status/kinds/index.js";
import { restingAge } from "../components/status/restingAge.js";
import { LINE_SLOT_CLASS, ThreadStatus } from "../components/status/ThreadStatus.js";
import { subagentStatus } from "../components/threads/leadTree.js";
import { SubagentCard } from "../components/threads/SubagentCard.js";
import { sameSubagentRow } from "../components/threads/ThreadRows.js";
import { SidebarMenuButton } from "../components/ui/sidebar.js";
import { Tooltip, TooltipTrigger } from "../components/ui/tooltip.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { GLYPH_ROW_CLASS, ONE_LINE_ROW_CLASS, SLOT_YIELDS_CLASS, STOP_ROOM_CLASS } from "./rowGrammar.js";
import { StopAct } from "./StopAct.js";

/** How long the pointer rests on the row before its card opens, the tile card's own delay. */
const CARD_DELAY_MS = 450;

type SubagentRowProps = {
  subagent: SubagentView;
  target: ChildTarget;
  kind: StatusKind;
  note: string | undefined;
  depth: number;
  rowId?: string;
  /** The lead thread whose page holds the subagent's lines, where the row opens it; absent, the row opens nothing. */
  lead?: { workspaceId: string; threadId: string } | undefined;
  /** Whether its page is the one open. */
  active?: boolean;
};

export const SubagentRow = memo(function SubagentRow({ subagent, target, kind, note, depth, rowId, lead, active = false }: SubagentRowProps) {
  const verbs = useChildVerbs();
  const acts = resolveActions(childActions, target, verbs);
  const stop = acts.find(act => act.id === "stop-subagent" && act.refusal === null);
  const ended = subagent.endedAt === undefined ? null : new Date(subagent.endedAt).toISOString();
  const status = subagentStatus(subagent);
  return (
    <div className="group/menu-item relative min-w-0" data-stop-row {...(stop !== undefined ? { "data-has-action": "" } : {})}>
      <Tooltip>
        <TooltipTrigger
          delay={CARD_DELAY_MS}
          data-slot="sidebar-menu-button"
          render={
            <SidebarMenuButton
              size="sm"
              data-sidebar-row
              data-row-id={rowId ?? `subagent:${target.sessionId}:${subagent.id}`}
              data-depth={depth}
              data-subagent-row={subagent.id}
              data-child-part={target.part}
              isActive={active}
              className={cn(ONE_LINE_ROW_CLASS, GLYPH_ROW_CLASS, "gap-1.5")}
              {...(lead !== undefined && subagent.parentToolUseId !== undefined ? { onClick: () => useStore.getState().select(lead.workspaceId, lead.threadId, subagent.parentToolUseId) } : {})}
              {...(acts.length > 0 ? { onContextMenu: (event: MouseEvent<HTMLElement>) => void openContextMenu(event, acts) } : {})}
            />
          }
        >
          <BotIcon aria-hidden data-subagent-mark className="size-3 shrink-0 text-sidebar-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground">{subagent.title}</span>
          <span className={cn("flex shrink-0", stop !== undefined && [SLOT_YIELDS_CLASS, STOP_ROOM_CLASS])}>
            <ThreadStatus thread={status} age={restingAge({ startedAt: status.startedAt, endedAt: ended })} kind={kind} className={LINE_SLOT_CLASS} />
          </span>
        </TooltipTrigger>
        <SubagentCard subagent={subagent} harness={target.harness} workspaceId={lead?.workspaceId ?? null} kind={kind} reason={note} />
      </Tooltip>
      {stop === undefined ? null : <StopAct on="sidebar" label={stop.title} onStop={() => void runAction(stop)} />}
    </div>
  );
}, (a, b) => a.depth === b.depth && a.rowId === b.rowId && a.active === b.active && a.lead?.workspaceId === b.lead?.workspaceId && a.lead?.threadId === b.lead?.threadId && sameSubagentRow(a, b));
