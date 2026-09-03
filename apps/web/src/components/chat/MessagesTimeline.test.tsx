// Adapted from pingdotgg/t3code apps/web/src/components/chat/MessagesTimeline.test.tsx at 57a66608 (MIT).
// Differs from upstream: the XSS probe global is __xss instead of the branded name; cases for removed features are dropped.
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";
import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry, TurnSummary } from "./adapt";

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    anchoredEndSpace?: {
      anchorIndex: number;
    };
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    ref?: Ref<LegendListRef>;
  }) => {
    return (
      <div
        data-testid={legendListTestId}
        data-anchor-index={props.anchoredEndSpace?.anchorIndex}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    turns: [],
    turnDiffSummaryByAssistantMessageId: new Map(),
    threadKey: "thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildTurn(
  turnId: string,
  state: TurnSummary["state"],
  startedAt: string | null,
  completedAt: string | null,
): TurnSummary {
  return {
    turnId,
    sessionId: "session-1",
    state,
    prompt: null,
    model: null,
    durationMs: null,
    costUsd: null,
    error: null,
    startedAt,
    completedAt,
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "message-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: "message-1",
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders elapsed time for a completed turn", () => {
    const turnId = "turn-with-fold";
    const assistantEntry = buildAssistantTimelineEntry("Done.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        turns={[
          buildTurn(turnId, "completed", "2026-03-17T19:12:20.000Z", "2026-03-17T19:12:28.000Z"),
        ]}
        timelineEntries={[
          {
            id: "work-entry-with-fold",
            kind: "work",
            createdAt: "2026-03-17T19:12:22.000Z",
            entry: {
              id: "work-with-fold",
              createdAt: "2026-03-17T19:12:22.000Z",
              turnId,
              label: "Ran command",
              tone: "tool",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            ...assistantEntry,
            message: { ...assistantEntry.message, turnId },
          },
        ]}
      />,
    );

    expect(markup).toContain("Worked for 8.0s");
  });

  it("keeps assistant changed-files headers sticky below the thread header", () => {
    const assistantMessageId = "message-assistant-with-files";
    const turnId = "turn-with-files";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        turns={[buildTurn(turnId, "completed", MESSAGE_CREATED_AT, MESSAGE_CREATED_AT)]}
        timelineEntries={[
          {
            id: assistantMessageId,
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the fixture.",
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                checkpointTurnCount: 1,
                checkpointRef: "checkpoint-with-files",
                status: "ready" as const,
                files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
                assistantMessageId,
                completedAt: MESSAGE_CREATED_AT,
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("sticky top-2 z-10");
    expect(markup).not.toContain("self-start");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("!size-[22px]");
    expect(markup).toContain("size-3");
    expect(markup).toContain('aria-label="Collapse all folders"');
    expect(markup).toContain('aria-label="Open diff"');
    expect(markup).toContain("1 changed file");
  });

  it("treats only the strict list end as the live edge", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
    // Within the pixel band above the content bottom counts as the end...
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 1170,
        scrollLength: 800,
      }),
    ).toBe(true);
    // ...but half a viewport up (LegendList's isNearEnd territory) does not.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 900,
        scrollLength: 800,
      }),
    ).toBe(false);
    // The composer inset is part of contentLength and must not count as
    // distance-to-end.
    expect(
      resolveTimelineIsAtEnd(
        { isAtEnd: false, contentLength: 2100, scroll: 1170, scrollLength: 800 },
        100,
      ),
    ).toBe(true);
    // Geometry missing (older state shape): fall back to the strict flag.
    expect(resolveTimelineIsAtEnd({ isAtEnd: false })).toBe(false);

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);

    // No usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(792)).toBe(0);
    // Partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14);
    // Full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(1400)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(0)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0);

    // The collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40);
    expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe("22rem");
  });

  it("keeps reserved end space when tool work starts while reading history", () => {
    const turnId = "turn-with-active-tool";
    const firstEntry = buildUserTimelineEntry("Run the command.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        anchorMessageId={firstEntry.message.id}
        liveFollowEnabled={false}
        timelineEntries={[
          firstEntry,
          {
            id: "entry-active-tool",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-active-tool",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-active-tool",
              label: "Run command",
              tone: "tool",
              itemType: "command_execution",
              command: "git status",
              toolLifecycleStatus: "inProgress",
              sourceActivityKind: "tool.started",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('data-anchor-index="0"');
    expect(markup).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  it("hands end-following back to the list once the send anchor is released", () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "message-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: "message-2",
      },
    };
    const timelineEntries = [firstEntry, secondEntry];

    // While the send anchor holds the end space open, ChatView owns streaming
    // scrolls and LegendList must not re-pin behind it.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={firstEntry.message.id}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');

    // Dropping the anchor is what actually gives end-following back, so
    // returning to the live edge has to release it — re-enabling live follow
    // alone leaves nothing pinned to the stream.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          timelineEntries={timelineEntries}
        />,
      ),
    ).toContain('data-maintain-scroll-at-end="enabled"');

    // Reading history still wins over both.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          anchorMessageId={null}
          liveFollowEnabled={false}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  it("renders collapse controls for long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
    expect(markup).toContain("rounded-2xl bg-message p-3");
  });

  it("preserves arbitrary XML-like tags and comparisons in rendered user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Without reading a file, do you have <global-agent-instructions scope="workspace">',
              'Before <nested data-value="a&b">inside</nested> after',
              "</global-agent-instructions> in your context?",
              "Comparison: 2 < 3 and 5 > 4.",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;global-agent-instructions scope=&quot;workspace&quot;&gt;");
    expect(markup).toContain(
      "Before &lt;nested data-value=&quot;a&amp;b&quot;&gt;inside&lt;/nested&gt; after",
    );
    expect(markup).toContain("&lt;/global-agent-instructions&gt; in your context?");
    expect(markup).toContain("Comparison: 2 &lt; 3 and 5 &gt; 4.");
  });

  it("preserves XML-like source inside user code spans and fences", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Inline `<tag attr="x">`',
              "",
              "```xml",
              '<root><child enabled="true" /></root>',
              "```",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;tag attr=&quot;x&quot;&gt;");
    expect(markup).toContain("&lt;root&gt;&lt;child enabled=&quot;true&quot; /&gt;&lt;/root&gt;");
  });

  it("renders unsafe user HTML as inert source text", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '<script>globalThis.__xss = 1</script><img src="x" onerror="globalThis.__xss = 2">',
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;script&gt;globalThis.__xss = 1&lt;/script&gt;");
    expect(markup).toContain(
      "&lt;img src=&quot;x&quot; onerror=&quot;globalThis.__xss = 2&quot;&gt;",
    );
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toMatch(/<img(?:\s|>)/i);
  });

  it("sanitizes executable HTML while preserving supported assistant markup", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry(
            [
              '<details open onclick="globalThis.__xss = 1">',
              "<summary>Safe details</summary>",
              "<script>globalThis.__xss = 2</script>",
              '<img src="x" onerror="globalThis.__xss = 3">',
              '<a href="javascript:globalThis.__xss = 4">Unsafe link</a>',
              "</details>",
            ].join(""),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Safe details");
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toContain("onclick=");
    expect(markup).not.toContain("onerror=");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("globalThis.__xss");
  });

  it("keeps the copy button for collapsed long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Context compacted",
              tone: "info",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
  });

  it("summarizes changed files in one line", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/repo/apps/web/src/session-logic.ts"],
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/repo"
      />,
    );

    expect(markup).toContain("Changed 1 file");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/repo/apps/web/src/session-logic.ts");
  });

  it("keeps mixed-success tool groups neutral", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: null,
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands");
    expect(markup).not.toContain('aria-label="Tool call failed"');
  });

  it("keeps the collapsed summary icon neutral when the group ends in a failure", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: null,
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands");
    expect(markup).toContain("lucide-terminal");
    expect(markup).not.toContain("lucide-x");
    expect(markup).not.toContain("text-destructive");
    // The failure stays discoverable for screen readers.
    expect(markup).toContain("tool call failed");
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:29.000Z",
              turnId: null,
              label: "Status updated",
              tone: "info",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:30.000Z",
              turnId: null,
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands and received 1 update");
    expect(markup).not.toContain('aria-label="Hidden work includes a failure"');
  });

  it("shows the animated one-line label for a live tool group", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[
          {
            id: "entry-live",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-live",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-live",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
              sourceActivityKind: "tool.started",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Working for");
    expect(markup).toContain("Running pnpm");
    expect(markup).toContain("live-activity-focus");
  });

  it("scopes a live row failure to the tool named by the row", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-failed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-failed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "failed",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-running",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-running",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-running",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
              sourceActivityKind: "tool.started",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Running pnpm");
    expect(markup).not.toContain("tool call failed");
  });

  it("renders initial thinking as the shared live activity row", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[]}
      />,
    );

    expect(markup).toContain("Thinking");
    expect(markup).toContain("lucide-brain");
    expect(markup).toContain('data-timeline-row-id="live-activity-row"');
  });

  it("keeps the completed command in the shared activity row with a past-tense label", () => {
    const turnId = "turn-live";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        turns={[buildTurn(turnId, "running", MESSAGE_CREATED_AT, null)]}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-completed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-completed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "completed",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran pnpm");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("live-activity-focus");
    expect(markup).not.toContain("Running pnpm");
    expect(markup).not.toContain("Thinking");
    expect(markup).not.toContain('data-timeline-row-kind="thinking"');
  });

  it("keeps failed lifecycle entries discoverable in mixed activity summaries", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              turnId: null,
              label: "Status updated",
              tone: "info",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
              sourceActivityKind: "tool.completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Received 1 update and used 1 tool, tool call failed"');
    // Ordinary tool failures render muted, not red.
    expect(markup).not.toContain("text-destructive");
  });

  it("keeps the red treatment for severe orchestration failures", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              turnId: null,
              label: "Status updated",
              tone: "info",
              sourceActivityKind: "tool.completed",
            },
          },
          {
            id: "entry-turn-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-turn-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              turnId: null,
              label: "Provider turn start failed",
              tone: "error",
              sourceActivityKind: "runtime.error",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain("text-destructive");
  });

  it("groups settled tool calls behind a toggle row and renders assistant markdown", async () => {
    const userEntry = buildUserTimelineEntry("List the files.");
    const assistantBase = buildAssistantTimelineEntry(
      ["Here is the listing helper:", "", "```ts", "const answer = 42;", "```"].join("\n"),
    );
    const assistantEntry = {
      ...assistantBase,
      id: "message-assistant",
      message: { ...assistantBase.message, id: "message-assistant" },
    };
    const timelineEntries: TimelineEntry[] = [
      userEntry,
      assistantEntry,
      {
        id: "entry-command",
        kind: "work",
        createdAt: "2026-03-17T19:12:29.000Z",
        entry: {
          id: "work-command",
          createdAt: "2026-03-17T19:12:29.000Z",
          turnId: null,
          label: "Ran command",
          tone: "tool",
          itemType: "command_execution",
          command: "ls",
          toolLifecycleStatus: "completed",
          sourceActivityKind: "tool.completed",
        },
      },
      {
        id: "entry-thinking",
        kind: "work",
        createdAt: "2026-03-17T19:12:30.000Z",
        entry: {
          id: "work-thinking",
          createdAt: "2026-03-17T19:12:30.000Z",
          turnId: null,
          label: "Thinking",
          tone: "thinking",
          preview: "quiet reasoning",
          detail: "quiet reasoning, at length",
          sourceActivityKind: "reasoning",
        },
      },
    ];

    // Markdown code blocks suspend while their highlighter loads.
    const view = await act(async () =>
      render(
        <MessagesTimeline
          {...buildProps()}
          turns={[
            buildTurn("turn-settled", "completed", MESSAGE_CREATED_AT, "2026-03-17T19:12:31.000Z"),
          ]}
          timelineEntries={timelineEntries}
        />,
      ),
    );
    const { container, getByRole } = view;

    expect(container.textContent).toContain("List the files.");
    expect(container.textContent).toContain("Here is the listing helper:");
    expect(container.textContent).toContain("const answer = 42;");
    expect(container.querySelector("code")).not.toBeNull();

    // Reasoning is not a tool: the collapsed group counts the command only and shows neither.
    const toggle = getByRole("button", { name: "Ran 1 command" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-timeline-row-kind="work"]')).toBeNull();
    expect(container.textContent).not.toContain("quiet reasoning");

    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(getByRole("button", { name: "Ran 1 command" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const expandedGroup = container.querySelector('[data-timeline-row-kind="work"]');
    expect(expandedGroup).not.toBeNull();
    const commandRow = within(expandedGroup as HTMLElement).getByRole("button", { name: "ls" });
    expect(commandRow.getAttribute("aria-expanded")).toBe("false");
    // The reasoning row collapses to its preview line and expands to the full text.
    const thinkingRow = within(expandedGroup as HTMLElement).getByRole("button", {
      name: "quiet reasoning",
    });
    expect(thinkingRow.getAttribute("aria-expanded")).toBe("false");
    expect((expandedGroup as HTMLElement).textContent).not.toContain("at length");

    await act(async () => {
      fireEvent.click(thinkingRow);
    });

    expect(thinkingRow.getAttribute("aria-expanded")).toBe("true");
    expect((expandedGroup as HTMLElement).textContent).toContain("quiet reasoning, at length");

    await act(async () => {
      fireEvent.click(commandRow);
    });

    expect(commandRow.getAttribute("aria-expanded")).toBe("true");
    expect(within(expandedGroup as HTMLElement).getByText("Command")).toBeTruthy();
    expect((expandedGroup as HTMLElement).querySelector("pre")?.textContent).toBe("ls");
  });
});
