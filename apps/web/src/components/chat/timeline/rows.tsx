// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.tsx at 57a66608 (MIT).
// Differs from upstream: store hooks are props (threadKey replaces the route and thread refs, expansion state is local, checkpoint data and callbacks arrive as optional props); rows come from the adapter; attachments, subagent rows, citations, user-message decorations, artifact templates, editor menus and the load-earlier header are removed.
import { type MessageId, type ProviderSkill, type TurnDiffSummary, type TurnId } from "../adapt";
import { memo, use, useMemo, useState } from "react";
import ChatMarkdown from "../../ChatMarkdown";
import { ReplyRunContext, type ReplyRunScope } from "../InlineRun";
import { ChevronDownIcon, ChevronRightIcon, Undo2Icon } from "lucide-react";
import { Button } from "../../ui/button";
import { ChatFileRow } from "../ChatFiles";
import { CLAMP_FADE_MASK, shouldClampText } from "../clamp";
import { COMPOSER_WORDS } from "../composerWords";
import { useSentFiles } from "../composerFiles";
import { PermissionPromptRow } from "../PermissionPromptRow";
import { SubagentFoldRow } from "../SubagentFoldRow";
import { ProposedPlanCard } from "../ProposedPlanCard";
import { ChangedFilesCard } from "../ChangedFilesTree";
import { MessageCopyButton } from "../MessageCopyButton";
import { resolveAssistantMessageCopyState, shouldPreserveAssistantLineBreaks } from "../MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { cn } from "../../../lib/utils";
import { formatChatTimestamp } from "../../../lib/timestampFormat";
import { SlateUpdatedLine } from "../../../slate/SlateUpdatedLine";
import { QUOTE_SOURCE_ATTRIBUTE } from "../AssistantSelectionToolbar";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./context";
import { WorkingTimelineRow, ThinkingTimelineRow } from "./working";
import { WorkGroupSection, LiveWorkEntryTimelineRow, WorkGroupToggleTimelineRow } from "./workGroup";

// ---------------------------------------------------------------------------
// TimelineRowContent: the actual row component
// ---------------------------------------------------------------------------

export const TimelineRowContent = memo(function TimelineRowContent({ row }: { row: TimelineRow }) {
  const isExpandedToolGroup = row.kind === "work" && row.isExpandedToolGroup;
  const isExpandedToolGroupHeader =
    (row.kind === "work-toggle" && row.expanded) || (row.kind === "work-live" && row.expanded);

  return (
    <div
      className={cn(
        // Commentary (non-terminal assistant) rows carry no metadata row, so
        // they sit closer to the work that follows them.
        isExpandedToolGroup
          ? "pb-1"
          : isExpandedToolGroupHeader
            ? "pb-0"
            : row.kind === "turn-fold" || row.kind === "working"
              ? "pb-1.5"
              : (row.kind === "message" &&
                    row.message.role === "assistant" &&
                    !row.showAssistantMeta) ||
                  row.kind === "work" ||
                  row.kind === "work-live" ||
                  row.kind === "work-toggle" ||
                  row.kind === "thinking"
                ? "pb-2"
                : "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" ? (
        <WorkGroupSection
          anchorKey={row.id}
          groupedEntries={row.groupedEntries}
          isExpandedToolGroup={row.isExpandedToolGroup}
        />
      ) : null}
      {row.kind === "work-live" ? <LiveWorkEntryTimelineRow row={row} /> : null}
      {row.kind === "work-toggle" ? <WorkGroupToggleTimelineRow row={row} /> : null}
      {row.kind === "turn-fold" ? <TurnFoldTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "user" ? <UserTimelineRow row={row} /> : null}
      {row.kind === "message" && row.message.role === "assistant" ? (
        <AssistantTimelineRow row={row} />
      ) : null}
      {row.kind === "proposed-plan" ? <ProposedPlanTimelineRow row={row} /> : null}
      {row.kind === "permission" ? <PermissionTimelineRow row={row} /> : null}
      {row.kind === "subagent" ? <SubagentTimelineRow row={row} /> : null}
      {row.kind === "working" ? <WorkingTimelineRow row={row} /> : null}
      {row.kind === "thinking" ? <ThinkingTimelineRow /> : null}
    </div>
  );
});

/** The person's message: what the transcript draws, and what a workspace still being made draws for the message that
 * asked for it. */
export const PERSON_BUBBLE = "relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground";

function UserTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  // The pixels are this tab's, held under the request id its own send carried, or the host's, which keeps every
  // message's images until its thread goes.
  const files = useSentFiles(row.message);

  return (
    <div className="group flex flex-col items-end gap-1">
      <div
        className={PERSON_BUBBLE}
        {...(row.message.steered === true ? { "data-user-message-steered": "true", title: COMPOSER_WORDS.sentWhileWorking } : {})}
      >
        <ChatFileRow records={row.message.attachments ?? []} files={files} />
        <CollapsibleUserMessageBody
          text={row.message.text}
          skills={ctx.skills}
          markdownCwd={ctx.markdownCwd}
        />
      </div>
      <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
        <div className="flex shrink-0 items-center gap-2">
          <p className="text-muted-foreground text-xs tabular-nums">
            {formatChatTimestamp(row.message.createdAt, ctx.timestampFormat)}
          </p>
          <div className="flex items-center gap-0.5">
            {row.message.text.trim().length > 0 && (
              <MessageCopyButton text={row.message.text} variant="ghost" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Rewind to here on an earlier reply: kept off a thread that is working, since a rewind never stops a turn. */
function RewindButton({ messageId }: { messageId: MessageId }) {
  const ctx = use(TimelineRowCtx);
  const activity = use(TimelineRowActivityCtx);
  if (activity.isWorking) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" size="icon-xs" variant="ghost" onClick={() => ctx.onRewind(messageId)} aria-label="Rewind to here" data-k="rewind-to-here" />}>
        <Undo2Icon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Rewind to here</TooltipPopup>
    </Tooltip>
  );
}

function TurnFoldTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "turn-fold" }> }) {
  const ctx = use(TimelineRowCtx);
  const Icon = row.expanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div className="pb-2 pt-1">
      <button
        type="button"
        aria-expanded={row.expanded}
        data-scroll-anchor-ignore
        onClick={() => ctx.onToggleTurnFold(row.turnId)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{row.label}</span>
        <Icon className="size-3.5" />
      </button>
    </div>
  );
}

function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
  const runs = ctx.replyRuns;
  const turnId = row.message.turnId;
  const runScope = useMemo<ReplyRunScope | null>(
    () => (runs === null || turnId === null ? null : { workspaceId: runs.workspaceId, threadId: runs.threadId, turnId, messageId: row.message.id, cwd: runs.cwd, runs: runs.runs }),
    [runs, turnId, row.message.id],
  );

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5" {...{ [QUOTE_SOURCE_ATTRIBUTE]: row.message.id }}>
        <ReplyRunContext value={runScope}>
          <ChatMarkdown
            text={messageText}
            cwd={ctx.markdownCwd}
            isStreaming={Boolean(row.message.streaming)}
            lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
            skills={ctx.skills}
            onImageExpand={ctx.onImageExpand}
            onOpenFile={ctx.onOpenFile}
            resolvedTheme={ctx.resolvedTheme}
          />
        </ReplyRunContext>
        <AssistantChangedFilesSection
          turnSummary={ctx.turnDiffSummaryByAssistantMessageId.get(row.message.id)}
          resolvedTheme={ctx.resolvedTheme}
          onOpenTurnDiff={ctx.onOpenTurnDiff}
        />
        {ctx.slatedMessageIds.has(row.message.id) ? <SlateUpdatedLine /> : null}
        {row.showAssistantMeta ? (
          <div data-reply-meta className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] tabular-nums opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/assistant:opacity-100">
            <span className="flex items-center gap-0.5">
              <AssistantCopyButton row={row} />
              {ctx.rewindableMessageIds.has(row.message.id) ? <RewindButton messageId={row.message.id} /> : null}
            </span>
            {!row.message.streaming && (
              <p data-reply-time className="whitespace-nowrap text-muted-foreground tabular-nums">
                {formatChatTimestamp(row.message.updatedAt, ctx.timestampFormat)}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

function AssistantCopyButton({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: row.message.text ?? null,
    showCopyButton: row.showAssistantCopyButton,
    streaming: row.assistantCopyStreaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        resolvedTheme={ctx.resolvedTheme}
      />
    </div>
  );
}

function PermissionTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "permission" }> }) {
  const ctx = use(TimelineRowCtx);
  return <PermissionPromptRow asker={row.asker} permission={row.permission} onAnswer={ctx.onAnswerPermission} docked={ctx.dockedAskId === row.permission.askId} />;
}

function SubagentTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "subagent" }> }) {
  const ctx = use(TimelineRowCtx);
  return <SubagentFoldRow onAnswer={ctx.onAnswerPermission} subagent={row.subagent} />;
}

/** Owns the expand-all state for one turn's changed files,
 *  so toggling re-renders only this component, not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  // A turn that only moved HEAD still shows the one line naming the move, and one that changed nothing of its own
  // still shows what else changed in its folder.
  if (checkpointFiles.length === 0 && turnSummary.moved.length === 0 && (turnSummary.others?.length ?? 0) === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when the turn changed files or moved HEAD,
 *  so its hooks run unconditionally (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(false);

  return (
    <ChangedFilesCard
      turnId={turnSummary.turnId}
      files={checkpointFiles}
      moved={turnSummary.moved}
      {...(turnSummary.others !== undefined ? { others: turnSummary.others } : {})}
      folder={turnSummary.folder === true}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() => setAllDirectoriesExpanded((current) => !current)}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

// The fade and the length rule are the pane's too, so they live in one place and are read from there.
const COLLAPSED_USER_MESSAGE_FADE_MASK = CLAMP_FADE_MASK;
const shouldCollapseUserMessage = shouldClampText;

const CollapsibleUserMessageBody = memo(function CollapsibleUserMessageBody(props: {
  text: string;
  skills: ReadonlyArray<ProviderSkill>;
  markdownCwd: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasVisibleBody = props.text.trim().length > 0;
  const canCollapse = hasVisibleBody && shouldCollapseUserMessage(props.text);
  const isCollapsed = canCollapse && !expanded;
  const toggle = canCollapse ? (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-expanded={expanded}
      data-scroll-anchor-ignore
      onClick={() => setExpanded((value) => !value)}
      className="-mr-1 h-6 rounded-md px-1.5 text-secondary-label text-xs hover:bg-muted/55 hover:text-message-foreground"
    >
      {expanded ? "Show less" : "Show full message"}
    </Button>
  ) : null;

  return (
    <div className="relative">
      {hasVisibleBody ? (
        <div
          className={cn("relative", isCollapsed && "max-h-44 overflow-hidden")}
          data-user-message-body="true"
          data-user-message-collapsed={isCollapsed ? "true" : "false"}
          data-user-message-collapsible={canCollapse ? "true" : "false"}
          data-user-message-fade={isCollapsed ? "true" : "false"}
          style={
            isCollapsed
              ? {
                  WebkitMaskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                  maskImage: COLLAPSED_USER_MESSAGE_FADE_MASK,
                }
              : undefined
          }
        >
          <UserMessageBody text={props.text} skills={props.skills} markdownCwd={props.markdownCwd} />
        </div>
      ) : null}
      {toggle === null ? null : (
        <div
          className={cn("flex items-center justify-end", isCollapsed ? "absolute inset-x-0 bottom-0" : "mt-1.5")}
          data-user-message-footer="true"
        >
          {toggle}
        </div>
      )}
    </div>
  );
});

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  skills: ReadonlyArray<ProviderSkill>;
  markdownCwd: string | undefined;
}) {
  const ctx = use(TimelineRowCtx);

  if (props.text.length === 0) {
    return null;
  }

  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdownCwd}
      skills={props.skills}
      className="text-message-foreground"
      lineBreaks
      parseRawHtml={false}
      onOpenFile={ctx.onOpenFile}
      resolvedTheme={ctx.resolvedTheme}
    />
  );
});
