// SPDX-License-Identifier: AGPL-3.0-only
// The palette's page of a project's conversations kept outside wsp: one list, newest first, each row the agent's
// mark, the title, under it the first prompt where it differs, the branch and the size, and its age at the right in
// the status slot. A row open in another app says so first, and one a wsp thread runs on says that. Pure over what
// it is handed, as the rest of the palette's items are.
import { ArrowLeftIcon, HistoryIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { CONVERSATION_WORDS, fmtBytes, refusalLine, type OutsideConversation, type ProjectView } from "@wsp/protocol";
import { cn } from "../../lib/utils.js";
import { isAnswer, type ConversationsRead } from "../../shell/conversations.js";
import { compactTimeLabel } from "../../sidebar/workspaceRows.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Facts } from "../Facts.js";
import { LINE_SLOT_CLASS } from "../status/ThreadStatus.js";
import { Spinner } from "../ui/spinner.js";
import { type CommandPaletteActionItem, type CommandPaletteSubmenuItem, ITEM_ICON_CLASS } from "./CommandPalette.logic.js";

/** The value of the row that opens the page, which the project's menu opens the palette on. */
export const CONVERSATIONS_PAGE = "page:conversations";

export interface ConversationsPageInput {
  /** The project the page lists, which is the one on screen or the one its menu named; null where neither is. */
  readonly project: ProjectView | null;
  /** The computer the project is on, by its name. */
  readonly computer: string;
  /** The list as the host last answered it, absent while it is read. */
  readonly read: ConversationsRead | undefined;
  /** What a row does: opens the thread already on it, asks first for one open elsewhere, or holds it. */
  readonly pick: (row: OutsideConversation) => void;
}

const nothing = async (): Promise<void> => {};

function rowOf(row: OutsideConversation, pick: (row: OutsideConversation) => void): CommandPaletteActionItem {
  const name = agentName(row.agent);
  const prompt = row.firstPrompt !== undefined && row.firstPrompt !== row.title ? row.firstPrompt : undefined;
  const first = row.thread !== undefined ? [CONVERSATION_WORDS.thread] : row.live ? [CONVERSATION_WORDS.live] : [];
  return {
    kind: "action",
    value: `conversation:${row.agent}:${row.id}`,
    searchTerms: [row.title, row.firstPrompt ?? "", row.branch ?? "", name],
    icon: <HarnessMark harness={row.agent} label={name} className="size-4" />,
    title: row.title,
    // The first prompt is the one fact that gives way, so the branch and the size stay whole on a narrow row.
    description: (
      <span className="flex min-w-0 items-center gap-x-3">
        {first.length > 0 ? <span className="shrink-0 whitespace-nowrap">{first[0]}</span> : null}
        {prompt !== undefined ? <span className={cn("min-w-0 truncate", first.length > 0 && "max-sm:hidden")}>{`${first.length > 0 ? " " : ""}${prompt} `}</span> : null}
        <Facts parts={[row.branch, row.bytes !== undefined ? fmtBytes(row.bytes) : undefined]} className="shrink-0" />
      </span>
    ),
    titleTrailingContent: <span className={cn("inline-flex shrink-0 items-center whitespace-nowrap tabular-nums", LINE_SLOT_CLASS)}>{compactTimeLabel(new Date(row.lastAt).toISOString())}</span>,
    run: async () => pick(row),
  };
}

/** The palette's row for the page: the page itself on a project, held with the reason on none. */
export function conversationsPage(input: ConversationsPageInput): CommandPaletteSubmenuItem | CommandPaletteActionItem {
  const head = { searchTerms: ["resume a conversation", "pick up a conversation", "claude code", "codex"], icon: <HistoryIcon className={ITEM_ICON_CLASS} />, title: CONVERSATION_WORDS.row };
  if (input.project === null) return { kind: "action", value: "action:resume-conversation", ...head, description: CONVERSATION_WORDS.openProjectFirst, disabled: true, run: nothing };
  const { read } = input;
  const answered = isAnswer(read) ? read : undefined;
  const rows = (answered?.rows ?? []).map(row => rowOf(row, input.pick));
  const held = (answered?.held ?? []).map(
    (h): CommandPaletteActionItem => ({
      kind: "action",
      value: `conversations-held:${h.agent}`,
      searchTerms: [agentName(h.agent)],
      icon: <HarnessMark harness={h.agent} label={agentName(h.agent)} className="size-4" />,
      title: CONVERSATION_WORDS.heldRow(agentName(h.agent)),
      description: CONVERSATION_WORDS.heldNote(input.computer),
      disabled: true,
      run: nothing,
    }),
  );
  const empty =
    read === undefined ? (
      <span data-conversations-reading className="inline-flex items-center gap-2">
        <Spinner className="size-4 text-muted-foreground" />
        {CONVERSATION_WORDS.reading(input.computer)}
      </span>
    ) : answered === undefined ? (
      <span data-refused>{"said" in read ? (read.fix === undefined ? read.said : refusalLine(read.said, read.fix)) : ""}</span>
    ) : rows.length === 0 ? (
      CONVERSATION_WORDS.empty
    ) : (
      CONVERSATION_WORDS.noMatch
    );
  return {
    kind: "submenu",
    value: CONVERSATIONS_PAGE,
    ...head,
    description: input.project.name,
    addonIcon: <ArrowLeftIcon className="text-icon-muted" />,
    placeholder: CONVERSATION_WORDS.search,
    emptyStateMessage: empty,
    groups: rows.length + held.length === 0 ? [] : [{ value: "conversations", label: CONVERSATION_WORDS.group(input.project.name), items: [...rows, ...held] }],
  };
}
