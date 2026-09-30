// SPDX-License-Identifier: AGPL-3.0-only
// The chat thread for one workspace: the transplanted timeline over the
// adapter's entries, the empty-thread headline before the first turn, and the
// settled footer with the last turn's duration and cost. The composer is a
// render-prop slot filled by whoever mounts the view. A new-thread request
// for this workspace clears the thread, whether it arrived before or after
// the view mounted; a view pinned to an older thread unpins first, since the
// new thread opens as the workspace's latest. A send from a thread that never
// started runs as that thread's first turn, so the pin stays where it is.
// Under the transcript stand the threads this one's agent opened, one line each
// with where it runs and its status, and the footer weighs the turn's own cost
// against what those threads spent.
import { HeroAtmosphere, HeroMark } from "./EmptyHero.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon } from "lucide-react";
import type { LegendListRef } from "@legendapp/list/react";
import { workspaceWord } from "@wsp/protocol";
import { Button } from "../ui/button";
import { useCapabilities, useHarnessCatalog, usePlaces, useSidebarProjects, useStatus, useStore, useThreadSessions, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { TreeRows } from "../../tree/TreeRows.js";
import { Facts } from "../Facts.js";
import { useMachineLine } from "../../notices/workspaceLines.js";
import { openNamedFile } from "../../files/open";
import { threadFolderOf } from "../../files/root";
import { cn } from "../../lib/utils";
import { DEFAULT_TIMESTAMP_FORMAT, turnWait, type MessageId, type TimestampFormat, type TurnDiffSummary, type TurnSummary } from "./adapt";
import { useDiffStore } from "../../diffs/store";
import { useRightPanelStore } from "../../rightPanelStore";
import { useReadStamp } from "./useReadStamp";
import { threadsOpenedBy, type ThreadOnWorkspace } from "../../sidebar/threadTree";
import { computerName, useComputerName } from "../../sidebar/workspaceRows";
import { TimelineRuleLine } from "./TimelineRuleLine";
import { MessagesTimeline, type MachineWait, type ReplyRuns } from "./MessagesTimeline";
import { useNewThreadRequests } from "./newThreadRequests";
import { useChatThread, type ChatThreadHandle } from "./useChatThread";
import { rewindableReplies, type RewindableReply } from "./RewindDialog";
import { requestRewind } from "../../shell/shellRequests";
import { DEFAULT_HARNESS } from "./ComposerOptionPickers";
import { TRANSCRIPT_LOADING } from "../../transcript-words";
import { useAppDark } from "../../settings/theme";
import { insertIntoComposer } from "./composerInsert";
import { quoteText } from "../../composer-editor-mentions";
import type { QuotedSelection } from "./AssistantSelectionToolbar";

const noopImageExpand = () => {};

export function ChatView({
  workspaceId,
  threadId = null,
  timestampFormat = DEFAULT_TIMESTAMP_FORMAT,
  children,
}: {
  workspaceId: string;
  threadId?: string | null;
  timestampFormat?: TimestampFormat;
  children?: ((thread: ChatThreadHandle) => ReactNode) | undefined;
}) {
  const workspace = useWorkspace(workspaceId);
  // The page starts on the dark side (index.html) and the preference flips it after the first paint, so a side read
  // once during a render stays wrong until something else repaints: a fenced block highlighted for the other side
  // draws its line in the ink the box's own background is.
  const appDark = useAppDark();
  const wake = useStore(s => s.wake);
  const newThread = useStore(s => s.newThread);
  const readingThread = useStore(s => s.readingThread);
  const freshThread = useStore(s => s.freshThread && s.selectedId === workspaceId);
  const thread = useChatThread(workspaceId, threadId, freshThread);
  // Every workspace's threads, not this one's: a thread this one's agent opened may run anywhere, and nothing in
  // the transcript itself records that a turn opened one.
  const projects = useSidebarProjects();
  const opened = useMemo(() => threadsOpenedBy(projects, thread.threadKey), [projects, thread.threadKey]);
  const api = useStore(s => s.api);
  const listRef = useRef<LegendListRef | null>(null);
  const { view } = thread;
  const empty = view.entries.length === 0 && !view.running;
  const cwd = view.cwd ?? undefined;
  const onQuote = useCallback((quote: QuotedSelection) => insertIntoComposer(workspaceId, quoteText(quote)), [workspaceId]);
  // A file named in the transcript opens as its own tab in the Files pane at the line it names, read against the
  // folder the thread worked in, which is what the agent wrote the path from.
  const onOpenFile = useCallback(
    (path: string, line?: number) => {
      const from = cwd ?? threadFolderOf(workspaceId);
      if (from !== null) openNamedFile(workspaceId, path, from, line);
    },
    [cwd, workspaceId],
  );
  // The prompt row's own options: the answer travels straight to the runtime and the row closes on the event the
  // runtime records, never on the reply here, so two clients watching one prompt end up saying the same thing.
  const onAnswerPermission = useCallback(
    (sessionId: string, askId: string, optionId: string) => {
      void api?.answerPermission?.(sessionId, askId, optionId);
    },
    [api],
  );
  // A Working thread on a workspace that is not running is a contradiction: the row says what it waits for instead,
  // naming the workspace and, while it wakes, where it runs, since that is what the send is waiting on.
  const state = useWorkspaceState(workspaceId);
  const capabilities = useCapabilities();
  const where = useComputerName(workspaceId);
  const runs = useMemo(() => ({ name: workspace?.name ?? workspaceId, where }), [workspace, workspaceId, where]);
  const machineWait = useMemo<MachineWait | null>(() => {
    if (state === null || !view.running) return null;
    const wait = turnWait(state, runs);
    if (wait === null) return null;
    return { label: wait.label, elapsed: wait.elapsed, onWake: wait.wake ? () => void wake(workspaceId) : null };
  }, [state, view.running, wake, workspaceId, runs]);
  // Nothing is running and the workspace is paused, which is no fault: a machine naps when its work is done. One quiet
  // word under the transcript in the timeline's own rule grammar, with the wake beside it, never a dialog.
  const paused = state === "paused" && !view.running ? workspaceWord(state, capabilities?.pauseMode) : null;
  const { startNewThread, hydrated, threadKey } = thread;
  // A reply's shell blocks run in the thread the view holds, in its folder: the one its start named, else the
  // workspace's thread folder, as a file named in the transcript opens. Neither known, or no thread yet, offers no Run.
  const replyRuns = useMemo<ReplyRuns | null>(() => {
    const folder = cwd ?? threadFolderOf(workspaceId);
    return thread.thread === undefined || folder === null ? null : { workspaceId, threadId: thread.thread, cwd: folder, runs: view.runs };
  }, [cwd, thread.thread, view.runs, workspaceId]);
  const turnRows = useThreadSessions(workspaceId, threadKey);
  useReadStamp(turnRows);
  const catalog = useHarnessCatalog(turnRows.at(-1)?.harness ?? DEFAULT_HARNESS, workspaceId);
  // What each turn changed hangs under that turn's last reply, and opens the Changes pane on the turn's own range.
  // Keyed on what it draws rather than on the entries, so a streamed chunk hands the timeline the same map.
  const diffPlaces = view.turns.flatMap(turn => {
    if (turn.changes === null) return [];
    const last = view.entries.findLast(e => e.kind === "message" && e.message.role === "assistant" && e.message.turnId === turn.turnId);
    return last?.kind === "message" ? [{ messageId: last.message.id, turn: turn.turnId, changes: turn.changes }] : [];
  });
  const diffKey = JSON.stringify(diffPlaces.map(p => [p.messageId, p.turn, p.changes.to, p.changes.shared]));
  const diffPlacesRef = useRef(diffPlaces);
  diffPlacesRef.current = diffPlaces;
  const turnDiffs = useMemo(
    () => new Map<MessageId, TurnDiffSummary>(diffPlacesRef.current.map(p => [p.messageId, { turnId: p.turn, files: p.changes.files, shared: p.changes.shared }])),
    [diffKey],
  );
  const turnsRef = useRef(view.turns);
  turnsRef.current = view.turns;
  const onOpenTurnDiff = useCallback(
    (turnId: string, path?: string) => {
      const changes = turnsRef.current.find(t => t.turnId === turnId)?.changes;
      const at = cwd ?? threadFolderOf(workspaceId);
      if (!changes || at === null) return;
      useDiffStore.getState().openTurn(workspaceId, { turnId, cwd: at, from: changes.from, to: changes.to, ...(path === undefined ? {} : { path }) });
      useRightPanelStore.getState().open(workspaceId, "diff");
    },
    [cwd, workspaceId],
  );
  const asked = useNewThreadRequests(s => s.pending.has(workspaceId));
  useEffect(() => {
    // The latest view takes the request once its transcript is in, so it knows which thread it leaves behind.
    const consume = () => {
      const requests = useNewThreadRequests.getState();
      if (!requests.pending.has(workspaceId)) return;
      if (threadId !== null) newThread(workspaceId);
      else if (hydrated && requests.take(workspaceId)) startNewThread();
    };
    consume();
    return useNewThreadRequests.subscribe(consume);
  }, [hydrated, newThread, startNewThread, threadId, workspaceId]);
  // With nothing picked, the thread this view settled on is what the person is reading, whether the transcript
  // carried it or its own first turn opened it: the store records it in the address, and the header reads the same
  // pick the body does. The key is the workspace's own until a session.start gives the view a thread, and a view
  // about to clear itself for a new thread still holds the one it is leaving.
  useEffect(() => {
    if (!hydrated || asked || threadId !== null || threadKey === workspaceId) return;
    readingThread(workspaceId, threadKey);
  }, [asked, hydrated, readingThread, threadId, threadKey, workspaceId]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(true);
  const onIsAtEndChange = useCallback((next: boolean) => {
    atEndRef.current = next;
    setAtEnd(next);
  }, []);
  // The transcript's end spacer reads the composer's height from a variable set here, so a composer that grows by a
  // line moves no React state and the last message stays pinned above it while the reader is at the end.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    if (root === null || composer === null) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--chat-composer-inset", `${composer.offsetHeight}px`);
      const scroller = listRef.current?.getScrollableNode();
      if (atEndRef.current && scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const showTranscript = thread.hydrated && !empty;
  // Rewind to here stands on each earlier reply that kept something to go back to, and opens the one dialog.
  const cutsConversation = catalog?.rewindsConversation === true;
  const rewindable = useMemo(() => (api?.rewindThread === undefined ? new Map<string, RewindableReply>() : rewindableReplies(view.turns, view.entries, cutsConversation)), [api, view.turns, view.entries, cutsConversation]);
  // The set and the handler reach every row through the timeline's shared context, so they move only when which
  // replies can be rewound moves, never on a streamed chunk: a settled reply would redraw on every one.
  const rewindableKey = [...rewindable.keys()].join("\n");
  const rewindableIds = useMemo(() => new Set(rewindableKey === "" ? [] : rewindableKey.split("\n")), [rewindableKey]);
  const rewindRef = useRef({ rewindable, threadId: turnRows.at(-1)?.threadId ?? threadId, agent: catalog?.label ?? turnRows.at(-1)?.harness ?? DEFAULT_HARNESS, cutsConversation });
  rewindRef.current = { rewindable, threadId: turnRows.at(-1)?.threadId ?? threadId, agent: catalog?.label ?? turnRows.at(-1)?.harness ?? DEFAULT_HARNESS, cutsConversation };
  const onRewind = useCallback(
    (messageId: string) => {
      const now = rewindRef.current;
      const reply = now.rewindable.get(messageId);
      if (reply === undefined || now.threadId === null) return;
      requestRewind({ workspaceId, threadId: now.threadId, ...reply, cutsConversation: now.cutsConversation, agent: now.agent });
    },
    [workspaceId],
  );
  // A turn that completed says so by its reply standing; any other ending keeps its own line, since the state word
  // is the news.
  const settledOnReply = view.settled?.state === "completed";
  // What the machine needs from the person, said here on the thread they are reading and nowhere else.
  const machine = useMachineLine(workspaceId);
  const footer = thread.hydrated ? (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      {opened.length > 0 ? <OpenedThreads workspaceId={workspaceId} opened={opened} /> : null}
      {view.settled !== null && !settledOnReply ? <SettledFooter turn={view.settled} /> : null}
      {paused !== null ? (
        <TimelineRuleLine data-workspace-paused line={paused}>
          <Button size="xs" variant="outline" className="font-sans text-[13px] font-medium" onClick={() => void wake(workspaceId)}>
            Wake
          </Button>
        </TimelineRuleLine>
      ) : null}
      {machine !== null ? <TimelineRuleLine data-machine-line line={machine} /> : null}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative isolate h-full min-h-0 text-foreground [--empty-lift:calc((100%-var(--chat-composer-inset,0px)-5.5rem)/2)]">
      <div className="absolute inset-0">
        {!thread.hydrated ? (
          <div className="flex h-full items-center justify-center pb-(--chat-composer-inset) text-sm text-muted-foreground">{TRANSCRIPT_LOADING}</div>
        ) : empty ? (
          // A fresh thread centres the headline and the composer as one stack; the composer glides to its dock
          // when the first message goes.
          <>
            <HeroAtmosphere {...(workspace?.project?.id === undefined ? {} : { projectId: workspace.project.id })} />
            <div className="absolute inset-x-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem)]">
              <EmptyThread name={workspace?.project.name ?? workspaceId} {...(workspace?.project?.id === undefined ? {} : { projectId: workspace.project.id })} />
            </div>
          </>
        ) : (
          <MessagesTimeline
            isWorking={view.running}
            machineWait={machineWait}
            activeTurnStartedAt={view.activeTurnStartedAt}
            waitingOn={turnRows.at(-1)?.waitingOn ?? null}
            listRef={listRef}
            timelineEntries={view.entries}
            turns={view.turns}
            turnDiffSummaryByAssistantMessageId={turnDiffs}
            onOpenTurnDiff={onOpenTurnDiff}
            threadKey={threadId === null ? workspaceId : `${workspaceId}/${threadId}`}
            onImageExpand={noopImageExpand}
            onAnswerPermission={onAnswerPermission}
            onOpenFile={onOpenFile}
            onIsAtEndChange={onIsAtEndChange}
            footer={footer}
            markdownCwd={cwd}
            workspaceRoot={cwd}
            resolvedTheme={appDark ? "dark" : "light"}
            timestampFormat={timestampFormat}
            onQuote={onQuote}
            rewindableMessageIds={rewindableIds}
            onRewind={onRewind}
            replyRuns={replyRuns}
          />
        )}
      </div>
      <div
        ref={composerRef}
        data-chat-composer-dock
        data-at-end={!showTranscript || atEnd || undefined}
        data-centred={(thread.hydrated && empty) || undefined}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 *:pointer-events-auto transition-[bottom] duration-300 ease-out data-centred:bottom-(--empty-lift) motion-reduce:transition-none"
      >
        <ScrollToEnd hidden={!showTranscript || atEnd} onClick={() => void listRef.current?.scrollToEnd({ animated: true })} />
        {children?.(thread)}
      </div>
    </div>
  );
}

/** Rides over the composer while the reader is above the transcript's end; kept mounted so it fades both ways. */
function ScrollToEnd({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <div className="pointer-events-none! absolute inset-x-0 bottom-full flex justify-center pb-2">
      <button
        type="button"
        data-scroll-to-end
        aria-hidden={hidden || undefined}
        tabIndex={hidden ? -1 : 0}
        onClick={onClick}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-popover/95 px-3 text-xs text-muted-foreground shadow-[0_8px_20px_-8px_rgb(0_0_0/45%),0_2px_4px_-2px_rgb(0_0_0/30%)] off-mac:glass-backdrop transition-[opacity,translate,color] duration-200 ease-out hover:text-foreground motion-reduce:transition-none",
          hidden ? "pointer-events-none translate-y-1 opacity-0" : "pointer-events-auto translate-y-0 opacity-100",
        )}
      >
        <ArrowDownIcon className="size-3.5" aria-hidden />
        Scroll to end
      </button>
    </div>
  );
}

/** The question over a thread with no message yet, naming the project: `picker` stands in for the name where the
 * project is still the person's to change. */
export function EmptyThread({ name, projectId, picker }: { name: string; projectId?: string; picker?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 px-6">
      <HeroMark {...(projectId === undefined ? {} : { projectId })} />
      <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        What should we build in{" "}
        {picker ?? <span className="inline-block max-w-64 truncate align-baseline">{name}</span>}?
      </h1>
    </div>
  );
}

/** The threads this thread's agent opened, wherever each runs, one line each under the reply, so a person reading the
 * opener can reach every thread it started without hunting the sidebar for it; each with its workspace's branch against
 * this workspace's where the host read this workspace's children. */
function OpenedThreads({ workspaceId, opened }: { workspaceId: string; opened: ReadonlyArray<ThreadOnWorkspace> }) {
  const places = usePlaces();
  const tree = useStatus(workspaceId)?.tree;
  const name = useWorkspace(workspaceId)?.name ?? workspaceId;
  return <TreeRows lead={{ id: workspaceId, name }} tree={tree} className="mt-2" rows={opened.map(({ thread, runs }) => ({ thread, place: computerName(places, runs) }))} />;
}

const TURN_STATUS: Record<TurnSummary["state"], string> = {
  running: "running",
  completed: "completed",
  interrupted: "interrupted",
  error: "failed",
};

/** A turn that ended any way but completed says how, in one word: the fold above it says how long it worked, and a
 * price is not the line's to say. */
function SettledFooter({ turn }: { turn: TurnSummary }) {
  return (
    <Facts
      data-testid="settled-footer"
      parts={[TURN_STATUS[turn.state]]}
      className={cn("w-full px-1 pb-2 font-mono text-[11px] tabular-nums", turn.state !== "completed" ? "text-destructive" : "text-muted-foreground")}
    />
  );
}
