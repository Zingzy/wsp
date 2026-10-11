// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.tsx at 57a66608 (MIT).
// Differs from upstream: store hooks are props (threadKey replaces the route and thread refs, expansion state is local, checkpoint data and callbacks arrive as optional props); rows come from the adapter; attachments, subagent rows, citations, user-message decorations, artifact templates, editor menus and the load-earlier header are removed.
import { deriveMessagesTimelineRows, entryHiders, type DeriveRowsInput, type MessageId, type MessagesTimelineRow, type ProviderSkill, type TimelineEntry, type TimestampFormat, type TurnDiffSummary, type TurnId, type TurnSummary } from "../adapt";
import { resolveChatListAnchoredEndSpace } from "../../../lib/chatList";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { type ThreadWaitingOn } from "@wsp/protocol";
import type { ExpandedImagePreview } from "../ExpandedImagePreview";
import { CHAT_TIMELINE_ANCHOR_OFFSET, keepTimelineEndVisibleAfterOverlayGrowth } from "../timelineScrollAnchoring";
import { computeStableMessagesTimelineRows, resolveTimelineIsAtEnd, resolveTimelineMinimapHasPersistentGutter, resolveTimelineMinimapHitStripWidth, type StableMessagesTimelineRowsState } from "../MessagesTimeline.logic";
import { cn } from "../../../lib/utils";
import { AssistantSelectionToolbar, type QuotedSelection } from "../AssistantSelectionToolbar";
import { type TimelineRowSharedState, type ReplyRuns, type MachineWait, type TimelineRowActivityState, TimelineRowCtx, TimelineRowActivityCtx, type WorkGroupViewState } from "./context";
import { deriveTimelineMinimapItems, resolveTimelineRowTop, resolveTimelineRowHeight, TimelineMinimap } from "./minimap";
import { TimelineRowContent } from "./rows";
import { useSpawnedChildren } from "../../threads/SpawnTiles";
import type { AnswerPrompt } from "../answerPrompt";
import type { FindMatch } from "../find/search";
import { revealMatch } from "../find/store";

const NOOP_OPEN_TURN_DIFF = (_turnId: TurnId, _filePath?: string) => {};
const NOOP_REWIND = (_messageId: MessageId) => {};
const NOOP_ANSWER_PERMISSION: AnswerPrompt = () => {};
const NOOP_ANCHOR_READY = (_messageId: MessageId, _anchorIndex: number) => {};
const NOOP_IS_AT_END_CHANGE = (_isAtEnd: boolean) => {};
const NOOP_MANUAL_NAVIGATION = () => {};
const EMPTY_TURN_DIFF_SUMMARIES: ReadonlyMap<MessageId, TurnDiffSummary> = new Map();
const EMPTY_REWINDABLE: ReadonlySet<MessageId> = new Set();
const EMPTY_SLATED: ReadonlySet<MessageId> = new Set();

const TIMELINE_LIST_HEADER = <div className="h-3 sm:h-4" />;
const TIMELINE_LIST_FADE_HEADER = (
  <div className="h-[var(--workspace-titlebar-scroll-fade-height)]" />
);

const TIMELINE_LIST_FOOTER = <div className="h-3 sm:h-4" />;
const EMPTY_TIMELINE_SKILLS: ReadonlyArray<ProviderSkill> = [];
const TIMELINE_MAINTAIN_SCROLL_AT_END = {
  animated: false,
  on: {
    dataChange: true,
    itemLayout: true,
    layout: true,
  },
} as const;

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

export interface MessagesTimelineProps {
  isWorking: boolean;
  /** A subagent's page while the subagent runs, whose last message is not its answer yet. */
  openRun?: boolean;
  /** Set while the workspace is paused, waking or unreachable under a running turn. */
  machineWait?: MachineWait | null;
  isPreparingWorktree?: boolean;
  activeTurnStartedAt: string | null;
  /** The thread this one's running call is stopped behind, with that thread's open question, so the person answers
   * it here rather than hunting for the thread that raised it; null when this thread is behind nobody. */
  waitingOn?: ThreadWaitingOn | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  turns: ReadonlyArray<TurnSummary>;
  turnDiffSummaryByAssistantMessageId?: ReadonlyMap<MessageId, TurnDiffSummary>;
  threadKey: string;
  onOpenTurnDiff?: (turnId: TurnId, filePath?: string) => void;
  rewindableMessageIds?: ReadonlySet<MessageId>;
  slatedMessageIds?: ReadonlySet<MessageId>;
  onRewind?: (messageId: MessageId) => void;
  /** Answers a relayed permission prompt; the turn it blocks runs or is refused as the option says. */
  onAnswerPermission?: AnswerPrompt;
  /** The prompt answered where the composer stands, by its ask id: its row here keeps the record and offers
   * nothing, while every other open prompt (another thread's, a subagent's) keeps its own buttons. */
  dockedAskId?: string | null;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenFile?: (path: string, line?: number) => void;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  skills?: ReadonlyArray<ProviderSkill>;
  anchorMessageId?: MessageId | null;
  onAnchorReady?: (messageId: MessageId, anchorIndex: number) => void;
  contentInsetEndAdjustment?: number;
  /**
   * Whether the timeline should keep pinning to the live edge as content
   * grows. Off while the user is reading history; LegendList's own
   * maintainScrollAtEnd would otherwise re-pin regardless of ChatView's
   * scroll-mode refs whenever the user drifts near the bottom.
   */
  liveFollowEnabled?: boolean;
  onIsAtEndChange?: (isAtEnd: boolean) => void;
  onManualNavigation?: () => void;
  hideEmptyPlaceholder?: boolean;
  topFadeEnabled?: boolean;
  /** Lines that belong to the transcript's end, scrolled with it above the composer's inset. */
  footer?: React.ReactNode;
  /** Absent where the view holds no thread yet: its replies' blocks get no Run. */
  replyRuns?: ReplyRuns | null;
  /** Where a selection quoted out of a reply goes; absent, a selection offers no Quote. */
  onQuote?: (quote: QuotedSelection) => void;
  /** Asks for the thread's older events once the reader is within two screens of the oldest row held. */
  onReachTop?: () => void;
  /** Hands find in thread what it needs of the list, live while the list is mounted; a switch mounts the next list
   * before the last one lets go, so a caller keeps the newest handle it was given. */
  onFinder?: (handle: TimelineFinder, live: boolean) => void;
}

/** What find in thread asks of the transcript on screen. */
export interface TimelineFinder {
  /** The element every row is drawn inside. */
  readonly viewport: HTMLElement;
  /** The transcript's own scroller. */
  scroller(): HTMLElement | null;
  /** The index among the entries of the newest one at or above the bottom of what the reader sees; -1 for none. */
  bottomEntry(): number;
  /** Opens the turn and the run of tool calls hiding the match's entry, and brings its row into view. */
  show(match: FindMatch): void;
}

/** The set with `from` taken out and `to` put in, the same set where neither moves it. */
function swap(open: ReadonlySet<string>, from: string | null, to: string | null): ReadonlySet<string> {
  const drop = from !== null && from !== to && open.has(from);
  const add = to !== null && !open.has(to);
  if (!drop && !add) return open;
  const next = new Set(open);
  if (drop) next.delete(from);
  if (add) next.add(to);
  return next;
}

/** The entries a row draws, by id. */
function rowEntryIds(row: MessagesTimelineRow): ReadonlyArray<string> {
  switch (row.kind) {
    case "message":
    case "proposed-plan":
    case "permission":
    case "subagent":
      return [row.id];
    case "work":
    case "work-live":
      return row.groupedEntries.map(e => e.id);
    case "work-toggle":
      return [row.id.slice("work-toggle:".length)];
    case "spawn":
      return [row.id.slice("spawn:".length)];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// MessagesTimeline: list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  openRun = false,
  machineWait = null,
  isPreparingWorktree = false,
  activeTurnStartedAt,
  waitingOn = null,
  listRef,
  timelineEntries,
  turns,
  turnDiffSummaryByAssistantMessageId = EMPTY_TURN_DIFF_SUMMARIES,
  threadKey,
  onOpenTurnDiff = NOOP_OPEN_TURN_DIFF,
  rewindableMessageIds = EMPTY_REWINDABLE,
  slatedMessageIds = EMPTY_SLATED,
  onRewind = NOOP_REWIND,
  onAnswerPermission = NOOP_ANSWER_PERMISSION,
  dockedAskId = null,
  onImageExpand,
  onOpenFile,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  skills = EMPTY_TIMELINE_SKILLS,
  anchorMessageId = null,
  onAnchorReady = NOOP_ANCHOR_READY,
  contentInsetEndAdjustment = 0,
  liveFollowEnabled = true,
  onIsAtEndChange = NOOP_IS_AT_END_CHANGE,
  onManualNavigation = NOOP_MANUAL_NAVIGATION,
  hideEmptyPlaceholder = false,
  topFadeEnabled = false,
  footer = null,
  replyRuns = null,
  onQuote,
  onReachTop,
  onFinder,
}: MessagesTimelineProps) {
  const latestTurn = turns[turns.length - 1] ?? null;
  // A switch keeps the list it leaves mounted until the next one paints, and that list letting go of its handle
  // must not clear the one the next list just set.
  const ownList = useRef<LegendListRef | null>(null);
  const setList = useCallback(
    (handle: LegendListRef | null) => {
      if (handle !== null) listRef.current = handle;
      else if (listRef.current === ownList.current) listRef.current = null;
      ownList.current = handle;
    },
    [listRef],
  );
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<TurnId>>(new Set());
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(new Set());
  // Scroll/disclosure state outlives virtualized rows, but never the current thread.
  const workGroupViewState = useMemo<WorkGroupViewState>(
    () => ({ scrollPositions: new Map(), expandedEntries: new Set() }),
    [threadKey],
  );
  const [disclosureToggleSettling, setDisclosureToggleSettling] = useState(false);
  const [minimapStripMap] = useState(() => new Map<string, HTMLSpanElement>());
  const disclosureAnchorKeyRef = useRef<string | null>(null);
  const disclosureSettleFrameRef = useRef<number | null>(null);
  const disclosureSettleSecondFrameRef = useRef<number | null>(null);
  const previousContentInsetEndAdjustmentRef = useRef(contentInsetEndAdjustment);

  useEffect(() => {
    return () => {
      if (disclosureSettleFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleFrameRef.current);
      }
      if (disclosureSettleSecondFrameRef.current !== null) {
        cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
      }
    };
  }, []);

  const suspendEndScrollMaintenanceForDisclosure = useCallback((anchorKey: string) => {
    disclosureAnchorKeyRef.current = anchorKey;
    setDisclosureToggleSettling(true);
    if (disclosureSettleFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleFrameRef.current);
    }
    if (disclosureSettleSecondFrameRef.current !== null) {
      cancelAnimationFrame(disclosureSettleSecondFrameRef.current);
    }
    disclosureSettleFrameRef.current = requestAnimationFrame(() => {
      disclosureSettleSecondFrameRef.current = requestAnimationFrame(() => {
        disclosureAnchorKeyRef.current = null;
        setDisclosureToggleSettling(false);
        disclosureSettleFrameRef.current = null;
        disclosureSettleSecondFrameRef.current = null;
      });
    });
  }, []);

  const shouldRestoreVisibleContentPosition = useCallback((row: MessagesTimelineRow) => {
    const disclosureAnchorKey = disclosureAnchorKeyRef.current;
    return disclosureAnchorKey === null || row.id === disclosureAnchorKey;
  }, []);

  const maintainVisibleContentPosition = useMemo(
    () => ({
      data: true,
      size: true,
      shouldRestorePosition: shouldRestoreVisibleContentPosition,
    }),
    [shouldRestoreVisibleContentPosition],
  );

  const onToggleTurnFold = useCallback(
    (turnId: TurnId) => {
      suspendEndScrollMaintenanceForDisclosure(`turn-fold:${turnId}`);
      setExpandedTurnIds((existing) => {
        const next = new Set(existing);
        if (next.has(turnId)) {
          next.delete(turnId);
        } else {
          next.add(turnId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );
  const onToggleWorkGroup = useCallback(
    (groupId: string, anchorKey: string) => {
      suspendEndScrollMaintenanceForDisclosure(anchorKey);
      setExpandedWorkGroupIds((existing) => {
        const next = new Set(existing);
        if (next.has(groupId)) {
          next.delete(groupId);
        } else {
          next.add(groupId);
        }
        return next;
      });
    },
    [suspendEndScrollMaintenanceForDisclosure],
  );

  // An in-session interrupt leaves its turn expanded so the user keeps their
  // place; the next turn (or a reload, since this is local state) folds it.
  const previousLatestTurnRef = useRef(latestTurn);
  useEffect(() => {
    const previous = previousLatestTurnRef.current;
    previousLatestTurnRef.current = latestTurn;
    if (!latestTurn || previous?.turnId === undefined) {
      return;
    }
    if (latestTurn.turnId === previous.turnId) {
      if (previous.state === "running" && latestTurn.state === "interrupted") {
        setExpandedTurnIds((existing) => {
          const next = new Set(existing);
          next.add(latestTurn.turnId);
          return next;
        });
      }
      return;
    }
    setExpandedTurnIds((existing) => {
      if (!existing.has(previous.turnId)) {
        return existing;
      }
      const next = new Set(existing);
      next.delete(previous.turnId);
      return next;
    });
  }, [latestTurn]);

  // A thread with no runtime id is nobody's lead: a child names its lead by that id.
  const spawned = useSpawnedChildren(threadKey.includes("/") ? threadKey.slice(threadKey.indexOf("/") + 1) : null);
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        turns,
        expandedTurnIds,
        expandedWorkGroupIds,
        isWorking,
        activeTurnStartedAt,
        waitingOn,
        openRun,
        ...(spawned !== undefined ? { children: spawned } : {}),
      }),
    [timelineEntries, turns, expandedTurnIds, expandedWorkGroupIds, isWorking, activeTurnStartedAt, waitingOn, openRun, spawned],
  );
  const rows = useStableRows(rawRows);
  const deriveInput = useRef<DeriveRowsInput | null>(null);
  deriveInput.current = { timelineEntries, turns, isWorking, activeTurnStartedAt, waitingOn, openRun, ...(spawned !== undefined ? { children: spawned } : {}) };
  const minimapItems = useMemo(() => deriveTimelineMinimapItems(rows), [rows]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const replyToOf = useCallback((id: string) => {
    let asked = "";
    for (const row of rowsRef.current) {
      if (row.kind !== "message") continue;
      if (row.message.role === "user") asked = row.message.text;
      else if (row.message.id === id) return asked;
    }
    return "";
  }, []);
  const [timelineViewportElement, setTimelineViewportElement] = useState<HTMLDivElement | null>(
    null,
  );
  useLayoutEffect(() => {
    keepTimelineEndVisibleAfterOverlayGrowth({
      timeline: ownList.current,
      previousOverlayHeight: previousContentInsetEndAdjustmentRef.current,
      overlayHeight: contentInsetEndAdjustment,
      followingEnd: liveFollowEnabled && anchorMessageId === null,
    });
    previousContentInsetEndAdjustmentRef.current = contentInsetEndAdjustment;
  }, [anchorMessageId, contentInsetEndAdjustment, liveFollowEnabled]);
  const [minimapHasPersistentGutter, setMinimapHasPersistentGutter] = useState(false);
  const [minimapHitStripWidth, setMinimapHitStripWidth] = useState(0);
  const handleAnchorReady = useCallback(
    (info: { anchorIndex: number | undefined }) => {
      if (anchorMessageId !== null && info.anchorIndex !== undefined) {
        onAnchorReady(anchorMessageId, info.anchorIndex);
      }
    },
    [anchorMessageId, onAnchorReady],
  );
  const anchoredEndSpace = useMemo(() => {
    const config = resolveChatListAnchoredEndSpace(
      rows,
      anchorMessageId,
      (row) => (row.kind === "message" && row.message.role === "user" ? row.message.id : null),
      { anchorOffset: CHAT_TIMELINE_ANCHOR_OFFSET },
    );
    return config ? { ...config, onReady: handleAnchorReady } : undefined;
  }, [anchorMessageId, handleAnchorReady, rows]);

  const settledRef = useRef(false);
  // The list's own signal fires after a page lands too, so a reader held at the top with no scroll event to give
  // still gets the next page.
  const handleStartReached = useCallback(() => {
    if (settledRef.current) onReachTop?.();
  }, [onReachTop]);
  const handleScroll = useCallback(() => {
    const state = ownList.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state, contentInsetEndAdjustment);
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    // Checked on every scroll and after every page lands, so a reader still at the top asks for the next one; not
    // before the list first stood at its end, since it opens there and reads as at the top while it gets there.
    if (isAtEnd === true) settledRef.current = true;
    if (onReachTop !== undefined && settledRef.current && state !== undefined && (state.scroll ?? Infinity) < 2 * (state.scrollLength ?? 0)) {
      onReachTop();
    }
    if (!state || minimapItems.length === 0) {
      return;
    }

    const scrollTop = state.scroll ?? 0;
    const scrollBottom = scrollTop + (state.scrollLength ?? 0);

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (!strip) {
        continue;
      }

      const rowTop = resolveTimelineRowTop(state, item.rowIndex);
      const rowHeight = resolveTimelineRowHeight(state, item.rowIndex);
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, rowHeight ?? 1) > scrollTop;

      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [
    contentInsetEndAdjustment,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    onReachTop,
  ]);

  useEffect(() => {
    const frame = requestAnimationFrame(handleScroll);
    return () => cancelAnimationFrame(frame);
  }, [handleScroll, rows.length]);

  useEffect(() => {
    if (!timelineViewportElement) {
      return;
    }

    const measure = () => {
      const viewportWidth = timelineViewportElement.getBoundingClientRect().width;
      const nextHasPersistentGutter = resolveTimelineMinimapHasPersistentGutter(viewportWidth);
      setMinimapHasPersistentGutter((current) =>
        current === nextHasPersistentGutter ? current : nextHasPersistentGutter,
      );
      setMinimapHitStripWidth(resolveTimelineMinimapHitStripWidth(viewportWidth));
    };

    const frame = requestAnimationFrame(measure);

    const observer = new ResizeObserver(measure);
    observer.observe(timelineViewportElement);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [timelineViewportElement, rows.length]);

  // Chromium leaves select-all's range empty when the composer is the last selectable thing; select-all starts at
  // body with no button held, which a drag from the chrome does not, so it takes the text last pressed in instead.
  useEffect(() => {
    if (!timelineViewportElement) return;
    let pressed = false;
    let pressedOn: Element | null = null;
    const press = (event: PointerEvent) => {
      pressed = event.type === "pointerdown";
      if (pressed) pressedOn = event.target instanceof Element ? event.target : null;
    };
    /** The outermost selectable text around the last press, outside the transcript: a PR body, a file, a diff. */
    const paneText = (): Element | null => {
      if (pressedOn === null || timelineViewportElement.contains(pressedOn)) return null;
      let text: Element | null = null;
      for (let node: Element | null = pressedOn; node !== null && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).userSelect === "text") text = node;
      }
      return text;
    };
    const onSelectStart = (event: Event) => {
      if (pressed || event.target !== document.body) return;
      event.preventDefault();
      window.getSelection()?.selectAllChildren(paneText() ?? timelineViewportElement);
    };
    const presses = ["pointerdown", "pointerup", "pointercancel"] as const;
    for (const type of presses) document.addEventListener(type, press, true);
    document.addEventListener("selectstart", onSelectStart);
    return () => {
      for (const type of presses) document.removeEventListener(type, press, true);
      document.removeEventListener("selectstart", onSelectStart);
    };
  }, [timelineViewportElement]);

  // Find in thread: which entry each row draws last, and a match's row brought into view once its folds are open.
  const rowEntryIndex = useMemo(() => {
    const at = new Map(timelineEntries.map((e, i) => [e.id, i]));
    const out = new Map<string, number>();
    let last = -1;
    for (const row of rows) {
      for (const id of rowEntryIds(row)) last = Math.max(last, at.get(id) ?? last);
      out.set(row.id, last);
    }
    return out;
  }, [rows, timelineEntries]);
  const rowEntryIndexRef = useRef(rowEntryIndex);
  rowEntryIndexRef.current = rowEntryIndex;
  const expandedRef = useRef({ turns: expandedTurnIds, groups: expandedWorkGroupIds });
  expandedRef.current = { turns: expandedTurnIds, groups: expandedWorkGroupIds };
  /** The folds find opened for the match it shows, closed again when it moves on; one the person opened stays. */
  const findOpened = useRef<{ turn: string | null; group: string | null }>({ turn: null, group: null });
  const pendingShow = useRef<string | null>(null);
  /** Brings the row drawing the entry into view unless it already is; false while no row draws it yet. */
  const scrollToEntry = useCallback(
    (entryId: string): boolean => {
      const shown = rowsRef.current;
      const index = shown.findIndex(row => row.kind !== "work-toggle" && row.kind !== "work-live" && rowEntryIds(row).includes(entryId));
      if (index < 0) return false;
      const scroller = ownList.current?.getScrollableNode();
      const element = timelineViewportElement?.querySelector(`[data-timeline-row-id="${CSS.escape(shown[index]!.id)}"]`) ?? null;
      if (scroller != null && element !== null) {
        const box = scroller.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        if (rect.bottom > box.top && rect.top < box.bottom) return true;
      }
      void ownList.current?.scrollToIndex({ index, animated: false, viewPosition: 0.4 });
      return true;
    },
    [timelineViewportElement],
  );
  useLayoutEffect(() => {
    if (pendingShow.current !== null && scrollToEntry(pendingShow.current)) pendingShow.current = null;
  }, [rows, scrollToEntry]);
  useLayoutEffect(() => {
    if (onFinder === undefined || timelineViewportElement === null) return;
    const handle: TimelineFinder = {
      viewport: timelineViewportElement,
      scroller: () => ownList.current?.getScrollableNode() ?? null,
      bottomEntry: () => {
        const scroller = ownList.current?.getScrollableNode();
        if (scroller == null) return -1;
        const inset = parseFloat(getComputedStyle(scroller).getPropertyValue("--chat-composer-inset")) || 0;
        const limit = scroller.getBoundingClientRect().bottom - inset;
        let best = -1;
        for (const element of timelineViewportElement.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
          const rect = element.getBoundingClientRect();
          if (rect.height > 0 && rect.top < limit) best = Math.max(best, rowEntryIndexRef.current.get(element.dataset.timelineRowId ?? "") ?? -1);
        }
        return best;
      },
      show: match => {
        const input = deriveInput.current;
        if (input === null) return;
        const { turnId, groupId } = entryHiders(input, match.entryId);
        const { turns, groups } = expandedRef.current;
        const was = findOpened.current;
        const turn = turnId !== null && (!turns.has(turnId) || was.turn === turnId) ? turnId : null;
        const group = groupId !== null && (!groups.has(groupId) || was.group === groupId) ? groupId : null;
        findOpened.current = { turn, group };
        revealMatch(match);
        const turnsNext = swap(turns, was.turn, turn);
        const groupsNext = swap(groups, was.group, group);
        if (turnsNext === turns && groupsNext === groups && scrollToEntry(match.entryId)) return;
        pendingShow.current = match.entryId;
        setExpandedTurnIds(turnsNext);
        setExpandedWorkGroupIds(groupsNext);
      },
    };
    onFinder(handle, true);
    return () => onFinder(handle, false);
  }, [onFinder, timelineViewportElement, scrollToEntry]);

  const leadKey = spawned?.lead ?? null;
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      timestampFormat,
      threadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      turnDiffSummaryByAssistantMessageId,
      rewindableMessageIds,
      slatedMessageIds,
      onRewind,
      onAnswerPermission,
      dockedAskId,
      onImageExpand,
      onOpenFile,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      onToggleWorkEntry: suspendEndScrollMaintenanceForDisclosure,
      workGroupViewState,
      replyRuns,
      leadKey,
    }),
    [
      timestampFormat,
      threadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      skills,
      turnDiffSummaryByAssistantMessageId,
      rewindableMessageIds,
      slatedMessageIds,
      onRewind,
      onAnswerPermission,
      dockedAskId,
      onImageExpand,
      onOpenFile,
      onOpenTurnDiff,
      onToggleTurnFold,
      onToggleWorkGroup,
      suspendEndScrollMaintenanceForDisclosure,
      workGroupViewState,
      replyRuns,
      leadKey,
    ],
  );
  const activityState = useMemo<TimelineRowActivityState>(
    () => ({
      isWorking,
      isPreparingWorktree,
      machineWait,
    }),
    [isWorking, isPreparingWorktree, machineWait],
  );

  // Stable renderItem: no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-clip select-text" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    if (hideEmptyPlaceholder) {
      return null;
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-placeholder text-sm">Send a message to start the conversation.</p>
      </div>
    );
  }

  return (
    <TimelineRowCtx value={sharedState}>
      <TimelineRowActivityCtx value={activityState}>
        <div
          ref={setTimelineViewportElement}
          className="relative h-full min-h-0"
        >
          <LegendList<MessagesTimelineRow>
            ref={setList}
            data={rows}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            renderItem={renderItem}
            estimatedItemSize={90}
            initialScrollAtEnd
            {...(anchoredEndSpace ? { anchoredEndSpace } : {})}
            contentInsetEndAdjustment={contentInsetEndAdjustment}
            maintainScrollAtEnd={
              anchoredEndSpace || !liveFollowEnabled || disclosureToggleSettling
                ? false
                : TIMELINE_MAINTAIN_SCROLL_AT_END
            }
            maintainVisibleContentPosition={maintainVisibleContentPosition}
            onScroll={handleScroll}
            {...(onReachTop === undefined ? {} : { onStartReached: handleStartReached, onStartReachedThreshold: 2 })}
            className={cn(
              "scrollbar-gutter-both h-full min-h-0 overflow-x-hidden overscroll-y-contain px-3 [overflow-anchor:none] sm:px-5",
              topFadeEnabled && "topbar-scroll-fade",
            )}
            ListHeaderComponent={topFadeEnabled ? TIMELINE_LIST_FADE_HEADER : TIMELINE_LIST_HEADER}
            ListFooterComponent={
              <>
                {footer}
                {TIMELINE_LIST_FOOTER}
                <div aria-hidden className="h-(--chat-composer-inset,0px)" />
              </>
            }
          />
          {onQuote !== undefined ? <AssistantSelectionToolbar viewport={timelineViewportElement} replyToOf={replyToOf} onQuote={onQuote} /> : null}
          <TimelineMinimap
            items={minimapItems}
            hasPersistentGutter={minimapHasPersistentGutter}
            hitStripWidth={minimapHitStripWidth}
            stripMap={minimapStripMap}
            onSelect={(item) => {
              onManualNavigation();
              void ownList.current?.scrollToIndex({
                index: item.rowIndex,
                animated: true,
                viewOffset: 24,
              });
            }}
          />
        </div>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

function getItemType(item: MessagesTimelineRow) {
  return item.kind === "message" ? `message:${item.message.role}` : item.kind;
}

// ---------------------------------------------------------------------------
// Structural sharing: reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}
