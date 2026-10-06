// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.tsx at 57a66608 (MIT).
// Differs from upstream: store hooks are props (threadKey replaces the route and thread refs, expansion state is local, checkpoint data and callbacks arrive as optional props); rows come from the adapter; attachments, subagent rows, citations, user-message decorations, artifact templates, editor menus and the load-earlier header are removed.
import { indicatesFailure, type MessagesTimelineRow } from "../adapt";
import { resolveWorkGroupScrollAnchor } from "../../../work-log/scrollAnchor";
import { memo, use, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { getVirtualizedScrollFadeClassName } from "../../ui/scroll-area";
import { liveWorkEntryLabel, resolveWorkGroupScrollIndex, shouldFollowWorkGroupAppend, workEntryIsVisibleInGroup, workEntryLabelText } from "../MessagesTimeline.logic";
import { cn } from "../../../lib/utils";
import { TimelineRowCtx, WorkGroupViewCtx, type TimelineWorkEntry, type TimelineRow } from "./context";
import { LiveActivityRow, LiveActivityContent, TOOL_GROUP_GLYPHS, workEntryGlyph, SimpleWorkEntryRow } from "./workEntry";

// ---------------------------------------------------------------------------
// Extracted row sections: own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Renders standalone activity or one bounded, virtualized expanded tool group. */
export const WorkGroupSection = memo(function WorkGroupSection({
  anchorKey,
  groupedEntries,
  isExpandedToolGroup,
}: {
  anchorKey: string;
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  isExpandedToolGroup: boolean;
}) {
  const { workspaceRoot, threadKey } = use(TimelineRowCtx);
  const nonEmptyEntries = useMemo(
    () => groupedEntries.filter((entry) => workEntryIsVisibleInGroup(entry, isExpandedToolGroup)),
    [groupedEntries, isExpandedToolGroup],
  );

  if (nonEmptyEntries.length === 0) return null;
  if (isExpandedToolGroup) {
    return (
      <ExpandedWorkGroupEntries
        key={`${threadKey}:${anchorKey}`}
        anchorKey={anchorKey}
        entries={nonEmptyEntries}
        workspaceRoot={workspaceRoot}
      />
    );
  }

  return (
    <section className="-mx-1 space-y-0.5 px-1 py-0.5" aria-label="Activity">
      <div className="space-y-px">
        {nonEmptyEntries.map((workEntry) => (
          <SimpleWorkEntryRow
            key={workEntry.id}
            workEntry={workEntry}
            workspaceRoot={workspaceRoot}
            isExpandedToolGroupEntry={false}
          />
        ))}
      </div>
    </section>
  );
});

function ExpandedWorkGroupEntries({
  anchorKey,
  entries,
  workspaceRoot,
}: {
  anchorKey: string;
  entries: TimelineWorkEntry[];
  workspaceRoot: string | undefined;
}) {
  const { workGroupViewState: viewState, onToggleWorkEntry } = use(TimelineRowCtx);
  const [initialScrollIndex] = useState(() =>
    resolveWorkGroupScrollIndex(entries, viewState.scrollPositions.get(anchorKey)),
  );
  const [restoringPosition, setRestoringPosition] = useState(initialScrollIndex !== undefined);
  const listRef = useRef<LegendListRef>(null);
  const [fades, setFades] = useState({ top: false, bottom: false, viewportHeight: 0 });
  const [appendState, setAppendState] = useState({ entries, follow: false });
  // Capture the pre-change edge once per incoming array, before new layout
  // metrics arrive. Edge/viewport changes never turn a status update into a follow.
  if (appendState.entries !== entries) {
    setAppendState({
      entries,
      follow:
        fades.viewportHeight > 0 &&
        shouldFollowWorkGroupAppend(appendState.entries, entries, fades.bottom ? Infinity : 0),
    });
  }

  const groupView = useMemo(
    () => ({ state: viewState, onToggleEntry: () => onToggleWorkEntry(anchorKey) }),
    [anchorKey, onToggleWorkEntry, viewState],
  );
  const updateScrollFades = useCallback(() => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    const distanceFromEnd = element.scrollHeight - element.clientHeight - element.scrollTop;
    const viewportHeight = element.clientHeight;
    const top = element.scrollTop > 1;
    const bottom = distanceFromEnd > 1;
    setFades((previous) =>
      previous.top === top &&
      previous.bottom === bottom &&
      previous.viewportHeight === viewportHeight
        ? previous
        : { top, bottom, viewportHeight },
    );
  }, []);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState();
    const position = state && resolveWorkGroupScrollAnchor(state);
    if (position) {
      viewState.scrollPositions.set(anchorKey, {
        entryId: position.rowId,
        offset: position.offsetWithinRow,
      });
    }
    updateScrollFades();
  }, [anchorKey, updateScrollFades, viewState]);

  const handleLoad = useCallback(() => {
    const list = listRef.current;
    const element = list?.getScrollableNode();
    if (initialScrollIndex && list && element) {
      // Bootstrap can report the restored target before the DOM has applied it.
      // Reconcile once at load, before releasing the measured anchor row.
      const offset = Math.max(
        0,
        Math.min(list.getState().scroll, element.scrollHeight - element.clientHeight),
      );
      if (Math.abs(element.scrollTop - offset) > 1) {
        void list.scrollToOffset({ offset, animated: false });
      }
    }
    setRestoringPosition(false);
  }, [initialScrollIndex]);

  useLayoutEffect(() => {
    const element = listRef.current?.getScrollableNode();
    if (!element) return;
    updateScrollFades();
    const observer = new ResizeObserver(updateScrollFades);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [updateScrollFades]);

  const renderEntry = useCallback(
    ({ item }: { item: TimelineWorkEntry }) => (
      <SimpleWorkEntryRow
        key={item.id}
        workEntry={item}
        workspaceRoot={workspaceRoot}
        isExpandedToolGroupEntry
      />
    ),
    [workspaceRoot],
  );

  return (
    <WorkGroupViewCtx value={groupView}>
      <LegendList
        ref={listRef}
        data={entries}
        extraData={workspaceRoot}
        keyExtractor={workEntryKey}
        renderItem={renderEntry}
        estimatedItemSize={24}
        drawDistance={240}
        recycleItems
        {...(initialScrollIndex ? { initialScrollIndex } : {})}
        maintainScrollAtEnd={
          appendState.follow ? { animated: false, on: { dataChange: true } } : false
        }
        maintainScrollAtEndThreshold={1 / Math.max(1, fades.viewportHeight)}
        // Measure the restored row even when an intra-row offset puts its
        // estimated bounds outside the list's small bootstrap render window.
        {...(restoringPosition && initialScrollIndex
          ? { alwaysRender: { indices: [initialScrollIndex.index] } }
          : {})}
        maintainVisibleContentPosition
        onLoad={handleLoad}
        onScroll={handleScroll}
        onLayout={updateScrollFades}
        tabIndex={0}
        role="region"
        aria-label="Tool calls"
        data-tool-group-scroll
        className={cn(
          "scrollbar-gutter-stable max-h-[min(18rem,50dvh)] scroll-py-6 overflow-x-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          getVirtualizedScrollFadeClassName(fades),
        )}
      />
    </WorkGroupViewCtx>
  );
}

const workEntryKey = (entry: TimelineWorkEntry) => entry.id;

export function LiveWorkEntryTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "work-live" }> }) {
  const ctx = use(TimelineRowCtx);
  const label = liveWorkEntryLabel(row.entry, ctx.workspaceRoot, row.active);
  const failed = indicatesFailure(row.entry);

  return (
    <button
      type="button"
      className="group/live-work flex min-h-6 w-full max-w-full cursor-pointer items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={failed ? `${workEntryLabelText(label)}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      {row.active ? (
        <LiveActivityRow label={label} tone={row.entry.tone} glyph={workEntryGlyph(row.entry)} failed={failed} />
      ) : (
        <div className="min-h-6 w-fit max-w-full min-w-0 overflow-hidden rounded-md text-sm leading-relaxed">
          <LiveActivityContent
            label={label}
            tone={row.entry.tone}
            glyph={workEntryGlyph(row.entry)}
            failed={failed}
            announceFailure={failed}
          />
        </div>
      )}
    </button>
  );
}

export function WorkGroupToggleTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const Glyph = TOOL_GROUP_GLYPHS[row.summaryKind];
  return (
    <button
      type="button"
      className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-label={row.hasFailure ? `${row.summary}, tool call failed` : undefined}
      aria-expanded={row.expanded}
      onClick={() => ctx.onToggleWorkGroup(row.groupId, row.id)}
    >
      <span className="flex size-6 shrink-0 items-center justify-center text-icon-muted">
        <Glyph className="size-4 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-secondary-label">{row.summary}</span>
    </button>
  );
}
