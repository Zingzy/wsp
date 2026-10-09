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
// A subagent's page is the same view over the lead's transcript cut to that
// subagent's lines, with no turn of its own to fold, count or close.
import { HeroField, HeroMark } from "./EmptyHero.js";
import { SetupCard, SetupRoom } from "./SetupCard.js";
import { holdEndOnFooterShrink } from "./footerHold.js";
import { answerPrompt } from "./answerPrompt.js";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownIcon } from "lucide-react";
import type { LegendListRef } from "@legendapp/list/react";
import { CAP_RAISE_ACT, threadKeyOf, USAGE_WORDS, WAKE_ACT, capWaitLine, folderOnJoined, workspaceKind, workspaceWord } from "@wsp/protocol";
import { openComputerSettings } from "../../settings/openAt";
import { Button } from "../ui/button";
import { useCapabilities, useHarnessCatalog, usePlaces, useSidebarProjects, useStatus, useStore, useThreadSessions, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { childNodesOf, TreeRows } from "../../tree/TreeRows.js";
import { Facts } from "../Facts.js";
import { useMachineLine } from "../../notices/workspaceLines.js";
import { openNamedFile } from "../../files/open";
import { threadFolderOf } from "../../files/root";
import { cn } from "../../lib/utils";
import { DEFAULT_TIMESTAMP_FORMAT, launchIn, subagentEntries, subagentRunOf, turnWait, type MessageId, type TimestampFormat, type TurnDiffSummary, type TurnSummary } from "./adapt";
import { onlyOf, useDiffStore } from "../../diffs/store";
import { useRightPanelStore } from "../../rightPanelStore";
import { useReadStamp } from "./useReadStamp";
import { threadsOpenedBy } from "../../sidebar/threadTree";
import { computerName, useComputerName } from "../../sidebar/workspaceRows";
import { TimelineRuleLine } from "./TimelineRuleLine";
import { LoopbackLinks, openInBrowser } from "../../browser/loopbackLinks";
import { useBrowserTabs } from "../../browser/tabs";
import { MessagesTimeline, type MachineWait, type ReplyRuns } from "./MessagesTimeline";
import { useNewThreadRequests } from "./newThreadRequests";
import { useChatThread, type ChatThreadHandle } from "./useChatThread";
import { useOpenSubagentRun } from "./openSubagent";
import { lastReplies, rewindableReplies, type RewindableReply } from "./RewindDialog";
import { requestRewind } from "../../shell/shellRequests";
import { TRANSCRIPT_LOADING } from "../../transcript-words";
import { useAppDark } from "../../settings/theme";
import { insertIntoComposer } from "./composerInsert";
import { quoteText } from "../../composer-editor-mentions";
import type { QuotedSelection } from "./AssistantSelectionToolbar";

const noopImageExpand = () => {};
const NO_TURNS: ReadonlyArray<TurnSummary> = [];
const NO_IDS: ReadonlySet<string> = new Set();
const NO_DIFFS = new Map<MessageId, TurnDiffSummary>();

export function ChatView({
  workspaceId,
  threadId = null,
  timestampFormat = DEFAULT_TIMESTAMP_FORMAT,
  docked,
  subagent = null,
  children,
}: {
  workspaceId: string;
  threadId?: string | null;
  /** One of the thread's subagents, by the call that launched it, whose page this is; null on the thread's own. */
  subagent?: string | null;
  timestampFormat?: TimestampFormat;
  /** The prompt the composer's slot is answering, by ask id, read off the thread it is shown for; that prompt's
   * timeline row then keeps the record alone. Absent, or null for a thread, and every row keeps its buttons. */
  docked?: ((thread: ChatThreadHandle) => string | null) | undefined;
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
  const turnRows = useThreadSessions(workspaceId, thread.threadKey);
  // A turn its computer's threads at once holds back has no start in the transcript yet, and still reads as working:
  // the timeline's working row says what holds it, with the setting that lets it start.
  const capped = turnRows.at(-1)?.capped;
  // The subagent's own fold in the lead's transcript, and what the listing says it was asked while that fold is unread.
  const run = useMemo(() => (subagent === null ? null : subagentRunOf(view.entries, subagent)), [subagent, view.entries]);
  const listed = subagent === null ? undefined : turnRows.flatMap(row => row.subagents ?? []).find(sub => sub.parentToolUseId === subagent);
  const listedAsk = listed?.asked ?? null;
  const pageState = listed?.state ?? run?.state ?? null;
  const pageEntries = useMemo(() => (subagent === null ? null : subagentEntries(run, listedAsk, pageState)), [subagent, run, listedAsk, pageState]);
  // The lead's first read is its newest page, which an older subagent's launch is past: its page reads back a page at
  // a time until the launch is in or nothing older is left. A call neither the transcript nor the listing knows then
  // opens the lead.
  const [readWhole, setReadWhole] = useState<string | null>(null);
  const pageKey = subagent === null ? null : `${threadId}/a/${subagent}`;
  const launched = subagent !== null && launchIn(view.entries, subagent);
  const { older } = thread;
  useEffect(() => {
    if (pageKey === null || !thread.hydrated || launched) return;
    let live = true;
    void older().then(more => {
      if (live && !more) setReadWhole(pageKey);
    });
    return () => {
      live = false;
    };
  }, [pageKey, thread.hydrated, launched, older, view.entries]);
  const unknown = pageKey !== null && readWhole === pageKey && run === null && listed === undefined;
  useEffect(() => {
    if (unknown && threadId !== null) useStore.getState().select(workspaceId, threadId);
  }, [unknown, workspaceId, threadId]);
  useEffect(() => {
    if (run === null) return;
    useOpenSubagentRun.setState({ run });
    return () => useOpenSubagentRun.setState({ run: null });
  }, [run]);
  const working = subagent === null && (view.running || capped !== undefined);
  const empty = pageEntries === null && view.entries.length === 0 && !working;
  // A workspace an agent forked out of a thread stands before its thread's row is listed. The fork opens that thread
  // inside the parent's own turn, so it is on its way while that turn runs; after it, nothing is coming. The host
  // stamps the fork's createdAt and each row's startedAt off one clock, so a later turn of the parent never counts.
  const forkWaits = useStore(s => {
    const parent = workspace?.parentThreadId;
    if (workspace == null || parent === undefined || threadId !== null || thread.fresh || (s.sessions[workspaceId]?.length ?? 0) > 0) return false;
    const made = Date.parse(workspace.createdAt);
    return Object.values(s.sessions).some(rows => {
      const opener = rows.findLast(row => threadKeyOf(row) === parent);
      return opener?.status === "running" && (opener.startedAt ?? 0) <= made;
    });
  });
  // A create asked with no message that landed here keeps its setup as the thread's first content, the composer
  // where it stood, until the first message: a page that moved as the create ended read as a fault.
  const landed = useStore(s => (s.landed?.workspaceId === workspaceId ? s.landed : null));
  const dropLanded = useStore(s => s.dropLanded);
  const setupStands = landed !== null && (!thread.hydrated || empty);
  useEffect(() => {
    if (landed !== null && thread.hydrated && !empty) dropLanded(workspaceId);
  }, [landed, thread.hydrated, empty, dropLanded, workspaceId]);
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
  // runtime records, never on the reply here, so two clients watching one prompt end up saying the same thing; the
  // reply comes back only as a refusal, said under the row.
  const onAnswerPermission = useMemo(() => answerPrompt(api), [api]);
  // A Working thread on a workspace that is not running is a contradiction: the row says what it waits for instead,
  // naming the workspace and, while it wakes, where it runs, since that is what the send is waiting on.
  const state = useWorkspaceState(workspaceId);
  const capabilities = useCapabilities();
  const where = useComputerName(workspaceId);
  const runs = useMemo(() => ({ name: workspace?.name ?? workspaceId, where }), [workspace, workspaceId, where]);
  const machineWait = useMemo<MachineWait | null>(() => {
    if (state === null || !working) return null;
    const wait = turnWait(state, runs);
    if (wait !== null) return { label: wait.label, elapsed: wait.elapsed, act: wait.wake ? { label: WAKE_ACT, run: () => void wake(workspaceId) } : null };
    if (capped === undefined) return null;
    return { label: capWaitLine(capped), elapsed: true, act: { label: CAP_RAISE_ACT, run: () => openComputerSettings(capped.placeId) } };
  }, [state, working, wake, workspaceId, runs, capped]);
  // Nothing is running and the workspace is paused, which is no fault: a machine naps when its work is done. One quiet
  // word under the transcript in the timeline's own rule grammar, with the wake beside it, never a dialog.
  const paused = state === "paused" && !working ? workspaceWord(state, capabilities?.pauseMode) : null;
  const { startNewThread, hydrated, threadKey } = thread;
  // A reply's shell blocks run in the thread the view holds, in its folder: the one its start named, else the
  // workspace's thread folder, as a file named in the transcript opens. Neither known, or no thread yet, offers no Run.
  const replyRuns = useMemo<ReplyRuns | null>(() => {
    const folder = cwd ?? threadFolderOf(workspaceId);
    return thread.thread === undefined || folder === null ? null : { workspaceId, threadId: thread.thread, cwd: folder, runs: view.runs };
  }, [cwd, thread.thread, view.runs, workspaceId]);
  useReadStamp(turnRows);
  // The agent this thread ran on, which a rewind names; a thread with no turn has none.
  const agent = turnRows.at(-1)?.harness ?? view.agent;
  const catalog = useHarnessCatalog(agent, workspaceId);
  // What each turn changed hangs under that turn's last reply, and opens the Changes pane on the turn's own range.
  // Keyed on what it draws rather than on the entries, so a streamed chunk hands the timeline the same map.
  const diffPlaces = view.turns.flatMap(turn => {
    if (turn.changes === null) return [];
    const last = view.entries.findLast(e => e.kind === "message" && e.message.role === "assistant" && e.message.turnId === turn.turnId);
    return last?.kind === "message" ? [{ messageId: last.message.id, turn: turn.turnId, changes: turn.changes }] : [];
  });
  const diffKey = JSON.stringify(diffPlaces.map(p => [p.messageId, p.turn, p.changes.to]));
  const diffPlacesRef = useRef(diffPlaces);
  diffPlacesRef.current = diffPlaces;
  const turnDiffs = useMemo(
    () =>
      new Map<MessageId, TurnDiffSummary>(
        diffPlacesRef.current.map(({ messageId, turn, changes: { files, others, shared } }) => [
          messageId,
          { turnId: turn, files, ...(others !== undefined ? { others } : shared === true ? { folder: true as const } : {}) },
        ]),
      ),
    [diffKey],
  );
  const turnsRef = useRef(view.turns);
  turnsRef.current = view.turns;
  const onOpenTurnDiff = useCallback(
    (turnId: string, path?: string) => {
      const changes = turnsRef.current.find(t => t.turnId === turnId)?.changes;
      const at = cwd ?? threadFolderOf(workspaceId);
      if (!changes || at === null) return;
      const only = onlyOf(changes, path);
      useDiffStore.getState().openTurn(workspaceId, { turnId, cwd: at, from: changes.from, to: changes.to, ...(path === undefined ? {} : { path }), ...(only === undefined ? {} : { only }) });
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
  // pick the body does. The key is the workspace's own until the host holds a thread for the view's send or a
  // session.start gives it one, and a view about to clear itself for a new thread still holds the one it is leaving.
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
  const footerRef = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    let scroller = node.parentElement;
    while (scroller !== null && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const content = scroller?.firstElementChild;
    return scroller == null || content == null ? undefined : holdEndOnFooterShrink(node, scroller, content);
  }, []);
  const showTranscript = thread.hydrated && !empty;
  // Rewind to here stands on each earlier reply that kept something to go back to, and opens the one dialog.
  const cutsConversation = catalog?.rewindsConversation === true;
  const byCount = catalog?.rewindsByCount === true;
  const rewindable = useMemo(() => (api?.rewindThread === undefined || agent === null ? new Map<string, RewindableReply>() : rewindableReplies(view.turns, view.entries, cutsConversation, byCount)), [agent, api, view.turns, view.entries, cutsConversation, byCount]);
  // The set and the handler reach every row through the timeline's shared context, so they move only when which
  // replies can be rewound moves, never on a streamed chunk: a settled reply would redraw on every one.
  const rewindableKey = [...rewindable.keys()].join("\n");
  const rewindableIds = useMemo(() => new Set(rewindableKey === "" ? [] : rewindableKey.split("\n")), [rewindableKey]);
  // A turn the agent wrote the slate in says so once, under its last reply.
  const replies = lastReplies(view.entries);
  const slatedKey = view.turns.flatMap(turn => (turn.slated === true && replies.has(turn.turnId) ? [replies.get(turn.turnId)!] : [])).join("\n");
  const slatedIds = useMemo(() => new Set(slatedKey === "" ? [] : slatedKey.split("\n")), [slatedKey]);
  const rewindRef = useRef({ rewindable, threadId: turnRows.at(-1)?.threadId ?? threadId, agent: catalog?.label ?? agent ?? "", cutsConversation });
  rewindRef.current = { rewindable, threadId: turnRows.at(-1)?.threadId ?? threadId, agent: catalog?.label ?? agent ?? "", cutsConversation };
  const onRewind = useCallback(
    (messageId: string) => {
      const now = rewindRef.current;
      const reply = now.rewindable.get(messageId);
      if (reply === undefined || now.threadId === null) return;
      requestRewind({ workspaceId, threadId: now.threadId, ...reply, cutsConversation: now.cutsConversation && reply.kept === undefined, agent: now.agent });
    },
    [workspaceId],
  );
  // A turn that completed says so by its reply standing, and one that failed in words by the row those words stand
  // in; any other ending keeps its own line, since the state word is the news. A turn a usage limit stopped says the
  // Usage page's own word for it, in the muted ink: it is news, not a fault, and the strip over the composer carries
  // the way on.
  const settledOnReply =
    view.settled?.state === "completed" || (view.settled?.state === "error" && view.settled.error !== null && (view.settled.limit ?? null) === null);
  // What the machine needs from the person, said here on the thread they are reading and nowhere else.
  const machine = useMachineLine(workspaceId);
  const footer = thread.hydrated && pageEntries === null ? (
    <div ref={footerRef} className="mx-auto w-full min-w-0 max-w-3xl">
      {opened.length > 0 ? <OpenedThreads workspaceId={workspaceId} leadKey={thread.threadKey} /> : null}
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

  // One list per thread shown: a thread drawn from what the transcripts hold replaces the last one with no loading
  // line between, and opens at its own end rather than at the offset the last one was read to.
  const drawn: Drawn | null =
    setupStands || !thread.hydrated || empty
      ? null
      : {
          key: pageEntries === null ? thread.drawKey : `${thread.drawKey}/a/${subagent}`,
          node: (
            <MessagesTimeline
              isWorking={working}
              openRun={run?.state === "running"}
              machineWait={pageEntries === null ? machineWait : null}
              activeTurnStartedAt={pageEntries === null ? view.activeTurnStartedAt : null}
              waitingOn={pageEntries === null ? (turnRows.at(-1)?.waitingOn ?? null) : null}
              listRef={listRef}
              timelineEntries={pageEntries ?? view.entries}
              turns={pageEntries === null ? view.turns : NO_TURNS}
              turnDiffSummaryByAssistantMessageId={pageEntries === null ? turnDiffs : NO_DIFFS}
              onOpenTurnDiff={onOpenTurnDiff}
              threadKey={`${threadId === null ? workspaceId : `${workspaceId}/${threadId}`}${pageEntries === null ? "" : `/a/${subagent}`}`}
              onImageExpand={noopImageExpand}
              onAnswerPermission={onAnswerPermission}
              dockedAskId={pageEntries === null ? (docked?.(thread) ?? null) : null}
              onOpenFile={onOpenFile}
              onIsAtEndChange={onIsAtEndChange}
              footer={footer}
              markdownCwd={cwd}
              workspaceRoot={cwd}
              resolvedTheme={appDark ? "dark" : "light"}
              timestampFormat={timestampFormat}
              onQuote={onQuote}
              rewindableMessageIds={pageEntries === null ? rewindableIds : NO_IDS}
              slatedMessageIds={pageEntries === null ? slatedIds : NO_IDS}
              onRewind={onRewind}
              replyRuns={pageEntries === null ? replyRuns : null}
              {...(pageEntries === null ? { onReachTop: thread.older } : {})}
            />
          ),
        };
  const leaving = useLeaving(drawn);
  // A thread in a folder on a computer the person joined names that computer's ports in its links: they open in a
  // Browser tab, which holds the port's forward to this computer while it shows it.
  const opensForwarded = useMemo(
    () => (workspace !== null && folderOnJoined(workspaceKind(workspace)) ? openInBrowser(at => useRightPanelStore.getState().openBrowser(workspaceId, useBrowserTabs.getState().createTab(workspaceId, at))) : null),
    [workspace, workspaceId],
  );

  return (
    <div ref={rootRef} data-chat-view {...(subagent === null ? {} : { "data-subagent-page": subagent })} className="relative isolate h-full min-h-0 text-foreground [--empty-lift:calc((100%-var(--chat-composer-inset,0px)-5.5rem)/2)]">
      <div className="absolute inset-0">
        {setupStands ? (
          <SetupRoom>
            <SetupCard creation={landed.creation} landedAt={landed.at} />
          </SetupRoom>
        ) : !thread.hydrated || (empty && forkWaits) ? (
          <div className="flex h-full items-center justify-center pb-(--chat-composer-inset) text-sm text-muted-foreground">{TRANSCRIPT_LOADING}</div>
        ) : empty ? (
          // A fresh thread centres the headline and the composer as one stack; the composer glides to its dock
          // when the first message goes.
          <>
            <HeroField />
            <div className="absolute inset-x-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem)]">
              <EmptyThread name={workspace?.project.name ?? workspaceId} {...(workspace?.project?.id === undefined ? {} : { projectId: workspace.project.id })} />
            </div>
          </>
        ) : null}
        <LoopbackLinks value={opensForwarded}>
          {[leaving, drawn].map(shown =>
            shown === null ? null : shown === leaving ? (
              <div key={shown.key} aria-hidden inert className="absolute inset-0 [content-visibility:hidden]">
                {shown.node}
              </div>
            ) : (
              <div key={shown.key} className="absolute inset-0">
                {shown.node}
              </div>
            ),
          )}
        </LoopbackLinks>
      </div>
      <div
        ref={composerRef}
        data-chat-composer-dock
        data-at-end={!showTranscript || atEnd || undefined}
        data-centred={(thread.hydrated && empty && !setupStands && !forkWaits) || undefined}
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 *:pointer-events-auto transition-[bottom] duration-300 ease-out data-centred:bottom-(--empty-lift) motion-reduce:transition-none"
      >
        <ScrollToEnd hidden={!showTranscript || atEnd} onClick={() => void listRef.current?.scrollToEnd({ animated: true })} />
        {children?.(thread)}
      </div>
    </div>
  );
}

type Drawn = { readonly key: string; readonly node: ReactNode };

/** The transcript a switch replaced, held hidden until the next one has painted: removing its rows inside the
 * switch's frame put their teardown in front of that paint. Rendered as the element it last committed, so React
 * does not render it again while it waits. A key must never come back while its list is held, which `drawKey`
 * only growing keeps true: React would reuse the held list as the shown one, and the shared listRef would go null
 * when the other list let go. */
function useLeaving(drawn: Drawn | null): Drawn | null {
  const committed = useRef<Drawn | null>(null);
  const [shownKey, setShownKey] = useState(drawn?.key ?? null);
  const [leaving, setLeaving] = useState<Drawn | null>(null);
  if (shownKey !== (drawn?.key ?? null)) {
    setShownKey(drawn?.key ?? null);
    setLeaving(drawn === null || committed.current?.key === drawn.key ? null : committed.current);
  }
  useLayoutEffect(() => {
    committed.current = drawn;
  });
  useEffect(() => (leaving === null ? undefined : afterPaint(() => setLeaving(null))), [leaving]);
  return leaving;
}

/** Runs once the frame being drawn has painted: a frame callback runs before that paint, a task queued from it after. */
function afterPaint(run: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(run);
  });
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
  };
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
 * this workspace's where the host read this workspace's children. Drawn again only when what it reads moves, never
 * on the opener's own streamed events. */
const OpenedThreads = memo(function OpenedThreads({ workspaceId, leadKey }: { workspaceId: string; leadKey: string }) {
  const places = usePlaces();
  const projects = useSidebarProjects();
  const tree = useStatus(workspaceId)?.tree;
  const name = useWorkspace(workspaceId)?.name ?? workspaceId;
  const lead = projects.flatMap(runs => runs.threads.map(thread => ({ thread, runs }))).find(({ thread }) => thread.id === leadKey);
  const nodes = useMemo(() => childNodesOf(projects, places, leadKey), [projects, places, leadKey]);
  return <TreeRows lead={{ id: workspaceId, name }} tree={tree} leadThread={lead?.thread ?? null} leadPlace={lead === undefined ? "" : computerName(places, lead.runs)} nodes={nodes} className="mt-2" />;
});

const TURN_STATUS: Record<TurnSummary["state"], string> = {
  running: "running",
  completed: "completed",
  interrupted: "interrupted",
  error: "failed",
};

/** A turn that ended any way but completed says how, in one word: how long it worked and what it cost are not the
 * line's to say. */
function SettledFooter({ turn }: { turn: TurnSummary }) {
  const limited = (turn.limit ?? null) !== null;
  return (
    <Facts
      data-testid="settled-footer"
      parts={[limited ? USAGE_WORDS.reached : TURN_STATUS[turn.state]]}
      className={cn("w-full px-1 pb-2 font-mono text-[11px] tabular-nums", turn.state !== "completed" && !limited ? "text-destructive" : "text-muted-foreground")}
    />
  );
}
