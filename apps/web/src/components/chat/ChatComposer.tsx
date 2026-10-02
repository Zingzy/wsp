// SPDX-License-Identifier: AGPL-3.0-only
// The composer under the chat thread: the transplanted prompt editor, slash
// menu, send and stop buttons over one draft per workspace. The send key the
// person picked (Enter, or the platform's mod with Enter, the other making a
// new line) starts one turn through sessions.start in the thread the view shows unless a new thread
// was requested; the runtime resumes that thread's latest session, or, after a
// launch that failed, runs the message as its first turn. A failed send puts
// the draft back. Stop
// sends one sessions.interrupt for the turn on screen and waits, disabled,
// for the turn's end; the runtime pushes the interrupted done before it
// answers, and the composer opens when the process exits. not-running means
// the turn beat the click and is no error; not-found, a refused request and a
// stop whose process outlives STOP_WAIT each raise a flyout. The composer has
// no line above its box. The editor is disabled with the reason while the
// runtime is not live or the agents here have not answered yet, and one
// reading of that reason serves the send button's name and hover and the
// Enter path alike: the button is held at the weight every held primary wears
// with the reason on its hover, and an Enter leaves the draft where it was
// typed and raises the reason as a flyout, so Enter never fails silently. A workspace whose machine is not
// answering keeps its editor open and holds the send alone, so the wait can be
// spent writing the message that goes when the machine answers. A running turn
// blocks nothing: with queue picked, Enter then queues the message under the thread's key in the
// draft store, a card stacks above the box with the files it goes with, and
// when the turn ends the head
// row starts the next turn; a fresh thread's rows wait under the workspace id
// until its own first start names it, then move under that id, whichever
// thread is on screen when that start lands. Every send holds the thread's
// rows until its start lands, so a start the runtime refuses or a harness
// that dies before init drains nothing behind it. Rows read back from storage
// are held too. Held rows go only after the person's next send here, never on
// their own, and a row typed during a turn goes ahead of the held ones it
// releases. With steer picked, a send during a turn whose harness's catalog says
// it steers and whose draft carries no file goes now: to the head, then into
// the running turn through sessions.steer, leaving the queue once the runtime
// took it (the thread shows it from the session.steer event), while
// not-running leaves it at the head for the turn's end. A harness that does
// not steer, or a draft with files, which a steer cannot carry, queues the
// message as queue does and its card says it waits: the pick never stops the
// running turn. A card's edit puts
// its words and files back in the box. A new thread owes nothing to the
// turn it left behind: the runtime runs a workspace's threads side by side
// and holds each to one turn, so the fresh composer opens at once. The slash
// menu offers what the session's harness announced less the commands the
// runtime catalog says run only in the CLI's own terminal; with nothing left
// to offer it does not open at all and the placeholder drops its half about
// commands, since a menu that answers a typed slash with an empty state
// promises what it cannot keep. What it offers is grouped by the source the
// announcement named, in the order it named them. Enter on a screen command
// sends nothing and raises a flyout naming the wsp control that serves it. A
// draft that is a slash alone, or a slash and a name nothing announced, is
// held the way every other held send is held, on the same button, with the box
// still open since the next keystroke is what lifts it: sent, it would reach
// the agent as a command it does not have, and come back as a question about
// a stray slash with a turn's price on it. A slash command nobody announced
// with words after it still goes as text, since the words may be meant.
// Typing @, # or $ opens the thread's folder's files, the repository's open
// pull requests and issues, or the person's skills the thread's agent loads,
// and a pick lands as a chip whose text is what the agent reads. The @ and #
// menus open the moment their token is typed, saying the list is on its way;
// the pull requests and issues are asked for when the thread opens, so the
// first # draws at once, and a list that failed, came back empty or matches
// nothing says so in the menu. A file the caps turn away stands as a refused
// chip beside the ones held, the sentence why on its hover.
// Where the agent takes a side question, /btw and a question goes to the host
// instead, starts no turn and opens the right panel on its answer.
// The checkout row under the composer picks the folder a fresh thread starts
// in; a resumed one is started where its harness last said it was. The
// model, effort, context window and access picks in the box's footer ride a
// start that opens a thread; a send into a thread that has run carries the
// model, its window and the effort, so a change mid-thread applies at the
// next turn, and never the agent or the access, which are that thread's own
// off its rows.
import { cn, isMacPlatform } from "../../lib/utils";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { PaperclipIcon } from "lucide-react";
import { composerHeldLine, HOST_ASLEEP_SEND, FILES_MAX, FILE_MAX_WORDS, IMAGE_MAX_WORDS, IMAGE_TYPE_WORDS, TURN_IN_FLIGHT, movesRunningAccess, noImagesLine, readsImages, screenCommandLine, screenCommandTyped, screenCommandsOf, sendRefusal, type SendRefusalKind, type WorkspaceState } from "@wsp/protocol";
import type { ConnStatus } from "../../protocol/client";
import { hostAsleep } from "../../boot";
import { projectHomeKey, useAbsentComputer, useHarnessCatalogs, useStore, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { useComputerName } from "../../sidebar/workspaceRows";
import { onComposerFocusRequest } from "../../shell/shellRequests";
import { useThreadFolder, useThreadStart } from "../../files/root";
import { useDaemonWire } from "../../files/wire";
import { DaemonOpError, fsFiles, gitPrList } from "../../terminal/daemon-fs";
import { useAgentsReport } from "../agents/useAgentsReport";
import { addNotice } from "../../notices/store";
import { useRightPanelStore, selectWorkspaceRightPanelState } from "../../rightPanelStore";
import { collapseExpandedComposerCursor, detectComposerTrigger, enterSends, expandCollapsedComposerCursor, insertComposerBlock, isCollapsedCursorAdjacentToInlineToken, replaceTextRange } from "../../composer-logic";
import { hostItemText, serializeComposerMention, splitPromptIntoComposerSegments } from "../../composer-editor-mentions";
import { ComposerPromptEditor, type ComposerCommandKey, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { asideQuestion, catalogFromHarness, composerPlaceholder, offersSlashCommands, slashHoldLine } from "./adapt";
import { useAsideStore } from "./asideStore";
import { opensThread, ComposerCheckoutRow, HomeCheckoutRow, ROW_ITEM_CLASS } from "./ComposerCheckoutRow";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import type { ComposerCommandGroup } from "./composerCommandGroups";
import { fileGroups, referenceGroups, skillGroups, slashGroups } from "./composerMenuItems";
import { prefetchComposerList, useComposerList } from "./useComposerList";
import { useComposerTriggerState } from "./useComposerTriggerState";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { ChatFileTile, ChatImageThumb, ChatRefusedFile } from "./ChatFiles";
import { attachmentOf, fileFromStash, recordOf, releaseFiles, stashedOf, useComposerFiles, useComposerFilesStore, useQueuedFiles, useRefusedFiles } from "./composerFiles";
import { COMPOSER_WORDS } from "./composerWords";
import { partitionStashFiles, usePromptStashStore, type PromptStashEntry } from "./promptStashStore";
import { ComposerStashMenu, stashedWord } from "./ComposerStashMenu";
import { usePublishContext } from "./ContextMeter";
import { useComposerModesStore } from "./composerModesStore";
import { nextPastedTextName, pastesAsFile } from "./pastedText";
import { buildComposerPromptHistoryEntries, stepComposerPromptHistory, type ComposerPromptHistoryPosition } from "./composerPromptHistory";
import { EMPTY_DRAFT, newId, useComposerDraft, useComposerDraftStore, useComposerQueue, useComposerQueueHeld, type QueuedMessage } from "./composerDraftStore";
import { BarRule, ComposerAccessPicker, ComposerOptionPickers, useAccessPick, useComposerPicks, type AccessTarget } from "./ComposerOptionPickers";
import { useComposerOptionsStore } from "./composerOptionsStore";
import type { ComposerStart } from "./composerPicks";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { ComposerModelChips } from "./ComposerModelChips";
import { useMultiPicks } from "./composerMultiPick";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerQueue } from "./ComposerQueue";
import { ComposerSurface } from "./ComposerSurface";
import { ACCESS_IN_BAR_PX, useAnimatedHeight, useFlip, useTallDraft, useWiderThan } from "./composerMotion";
import { Button } from "../ui/button";
import type { ChatThreadHandle } from "./useChatThread";
import { ComposerTasks } from "./ComposerTasks";
import { asksThePerson, composerTasks } from "./composerTasks.logic";

const noop = () => {};

/** A list read whose refusal is the computer's wsp not knowing the read yet reads as that, in the person's words. */
const inPersonsWords = <T,>(read: Promise<T>, computer: string): Promise<T> =>
  read.catch((e: unknown) => {
    throw e instanceof DaemonOpError && e.code === "unsupported" ? new Error(COMPOSER_WORDS.menuListUnserved(computer)) : e;
  });

/** How long a stop waits for the turn's process to end before saying it has not; a test shortens it. */
export const STOP_WAIT = { ms: 8_000 };

/** What a stop the runtime refused says: the computer by name when it is the one not answering, else the runtime's words. */
export function stopFailureWords({ error, unreachable, computer }: { error: string; unreachable: boolean; computer: string }): string {
  return unreachable ? COMPOSER_WORDS.stopUnreachable(computer) : COMPOSER_WORDS.stopRefused(error);
}

const flyout = (text: string): void => void addNotice({ kind: "error", text });

/** The draft as the height mirror measures it: a chip draws on one line whatever its text holds, so each one stands
 * as a short run of characters rather than the block it sends. */
function mirrorText(prompt: string): string {
  return splitPromptIntoComposerSegments(prompt)
    .map(segment => (segment.type === "text" ? segment.text : "\u2003".repeat(8)))
    .join("");
}

/** What blocks a send right now, or null; the refusal table gives its words. The socket comes first: with it down
 * every other reading is stale, and a state the app has no workspace for at all is one it cannot name. A paused machine
 * is named too, and the composer reads it not as a block but as the wake the send makes first. The agent catalog is
 * last and blocks as well: the model, effort, context window and access a start rides are resolved out of it, so a
 * turn started before it lands carries none of them. */
export function composerSendBlock(input: {
  conn: ConnStatus;
  hasApi: boolean;
  state: WorkspaceState | null;
  hydrated: boolean;
  agents: boolean;
  /** This workspace's computer is not answering, which is its state whatever a status that predates the silence
   * still says: the send is held on it in the same slot every other state is held in. */
  absent?: boolean;
  /** What is not answering is a daemon this host started, not the computer under it: the turn runs in this host's
   * own process, on this computer, and never went through that daemon, so neither the silence nor the state word
   * it folds into holds the box. The panes that do need the daemon say so where they are. */
  daemonOnly?: boolean;
}): SendRefusalKind | null {
  if (!input.hasApi || input.conn === "connecting") return "connecting";
  if (input.conn === "reconnecting") return "reconnecting";
  if (input.conn === "closed") return "closed";
  if (input.state === null) return "not-found";
  if (input.daemonOnly === true) return !input.hydrated ? "loading" : input.agents ? null : "no-agents";
  if (input.absent === true) return "unreachable";
  if (input.state !== "running") return input.state;
  if (!input.hydrated) return "loading";
  if (!input.agents) return "no-agents";
  return null;
}

/** What a send carries beyond its words and its files: the composer's picks where it opens a thread, and into a
 * thread that has already run the model and the effort alone, the window riding inside the model as it always
 * does. Changing the model in the middle of a thread is ordinary and the agent's own command line takes both per
 * turn. The agent and the access are not picks a message makes: the thread runs on the agent its rows carry, the
 * runtime refuses a send naming another, and sessions.access is the one road that changes what a thread may
 * touch. Pinned is the same reading the rail is pinned by, and the runtime reads a thread as existing by the same
 * rows. */
export function sendPicks(pinned: boolean, picks: ComposerStart): ComposerStart {
  if (!pinned) return picks;
  const kept: ComposerStart = { ...picks };
  delete kept.harness;
  delete kept.permissionMode;
  return kept;
}

/** A stop click still out for the turn it targeted; the turn id keeps it from leaking onto the next turn. */
interface StopAttempt {
  readonly turnId: string;
}

/** `onStart` takes the first send instead of the runtime: a project's home has no workspace yet, and its send is what
 * makes one. A sentence it answers is why nothing was made: the draft goes back and the sentence is raised as a flyout.
 * `waiting` is set while the workspace is still being made: a send joins the queue, whose cards say on their hover
 * why they wait, and nothing leaves it here, since the queue goes to the workspace once it is up; the folder row
 * names the copy's folder. */
export function ChatComposer({
  workspaceId,
  thread,
  onStart,
  waiting,
  where,
  sendLabel: sendGiven,
  beside,
  under,
}: {
  workspaceId: string;
  thread: ChatThreadHandle;
  onStart?: (prompt: string) => Promise<string | null>;
  waiting?: { line: string; folder: string };
  /** New thread's where it runs: the row's first item, the computer, a picker where several hold the repo. */
  where?: ReactNode;
  /** The send button's word where the send is something other than a message: Start on #12. */
  sendLabel?: string;
  /** One more button beside the send, for a second act on the same text: Review #12. */
  beside?: ReactNode;
  /** One line under the row, where what is typed is refused before any send: a link no project matches. */
  under?: ReactNode;
}) {
  const api = useStore(s => s.api);
  const waits = waiting !== undefined;
  const wake = useStore(s => s.wake);
  const conn = useStore(s => s.conn);
  const sessions = useStore(s => s.sessions[workspaceId]);
  const steers = useStore(s => s.preferences.midTurn === "steer");
  const sendWith = useStore(s => s.preferences.sendWith);
  const state = useWorkspaceState(workspaceId);
  const workspace = useWorkspace(workspaceId);
  const [stop, setStop] = useState<StopAttempt | null>(null);
  const stops = useRef(0);
  const multiPicks = useMultiPicks(workspaceId);
  // The message a send during a turn put at the head while its steer or its stop is out.
  const [next, setNext] = useState<string | null>(null);
  const draft = useComposerDraft(workspaceId);
  const { threadKey, named } = thread;
  const queue = useComposerQueue(threadKey);
  const held = useComposerQueueHeld(threadKey);
  const nextStart = useThreadStart(workspaceId);
  // A view locked to a turn resumes in that turn's folder, as its row says; only a view about to open a thread reads the pick.
  const viewCwd = thread.view.cwd;
  const opening = opensThread(thread);
  const folderStart = useMemo(() => (opening ? nextStart : viewCwd !== null ? { cwd: viewCwd } : {}), [nextStart, opening, viewCwd]);
  const { harness: harnessId, startOptions, pinned, latestRow, catalog: harnessCatalog, model: pickedModel, picks } = useComposerPicks(workspaceId, thread);
  const latestTurnId = thread.view.latestTurn?.turnId ?? null;
  const prompts = thread.view.entries.flatMap(e => (e.kind === "permission" && e.permission.turnId === latestTurnId ? [e.permission] : []));
  const tasks = composerTasks({ latestTurn: thread.view.latestTurn, running: thread.view.running, plan: thread.view.plan, asking: asksThePerson(prompts, latestRow?.waitingOn !== undefined) });
  const launching = useStore(s => s.launching);
  const launched = useStore(s => s.launched);
  const harnessCatalogs = useHarnessCatalogs(workspaceId);
  const setDraft = useComposerDraftStore(s => s.setDraft);
  const enqueue = useComposerDraftStore(s => s.enqueue);
  const removeQueued = useComposerDraftStore(s => s.removeQueued);
  const hold = useComposerDraftStore(s => s.hold);
  const requeue = useComposerDraftStore(s => s.requeue);
  const release = useComposerDraftStore(s => s.release);
  const rekeyQueue = useComposerDraftStore(s => s.rekeyQueue);
  const rekeyModes = useComposerModesStore(s => s.rekey);
  useEffect(() => {
    if (named === null) return;
    if (named.key !== named.thread) {
      rekeyQueue(named.key, named.thread);
      rekeyModes(named.key, named.thread);
    }
    release(named.thread);
  }, [named, rekeyModes, rekeyQueue, release]);
  const files = useComposerFiles(workspaceId);
  const refusedFiles = useRefusedFiles(workspaceId);
  const queuedFiles = useQueuedFiles();
  const addFiles = useComposerFilesStore(s => s.add);
  const removeFile = useComposerFilesStore(s => s.remove);
  const dismissRefused = useComposerFilesStore(s => s.dismiss);
  const sendFilesAs = useComposerFilesStore(s => s.sendAs);
  const restoreFiles = useComposerFilesStore(s => s.restore);
  const queueFiles = useComposerFilesStore(s => s.queue);
  const unqueueFiles = useComposerFilesStore(s => s.unqueue);
  const dropFiles = useComposerFilesStore(s => s.drop);
  const putFiles = useComposerFilesStore(s => s.put);
  const takeFiles = useComposerFilesStore(s => s.take);
  const stashed = usePromptStashStore(s => s.entries);
  const [stashOpen, setStashOpen] = useState(false);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);

  const absent = useAbsentComputer(workspaceId);
  const computer = useComputerName(workspaceId);
  const { harness } = thread.view;
  // A side question copies the thread's own session, so it is offered only on a thread that has a row to name it by.
  const asides = harnessCatalog?.asides === true && latestRow !== null && api?.askAside !== undefined;
  // A side question is about the thread it was asked from, so it goes when the composer leaves that thread.
  const fresh = thread.fresh;
  useEffect(() => () => useAsideStore.getState().close(workspaceId), [fresh, threadKey, workspaceId]);
  const catalog = useMemo(() => catalogFromHarness({ id: harnessId, harness, screen: screenCommandsOf(harnessCatalog), asides }), [asides, harness, harnessCatalog, harnessId]);
  // A daemon this host started is not the road a turn takes, so its absence leaves the box open on this computer.
  const daemonOnly = absent?.start !== undefined;
  const blocked = composerSendBlock({ conn, hasApi: api !== null, state, hydrated: thread.hydrated, agents: harnessCatalogs.length > 0, absent: absent !== null, daemonOnly });
  // A send wakes a paused machine by itself, so paused is not a refusal here: the box takes the words and the send
  // button says it wakes first.
  const wakesFirst = blocked === "paused";
  // A machine that is not answering is the one block a person can write through. The turn cannot go now, but what
  // they write while they wait is what goes the moment it answers, so the box takes it and the send alone is held,
  // named after the computer rather than after the wire's state word, since switching that computer on is the move.
  // Nothing leaves on its own when it comes back: the draft sits in the editor, which no effect here reads, and the
  // person's own send starts the turn. Every other block leaves the box shut, its sentence being about this app
  // rather than about a machine to wait for; a window on another computer whose wsp has gone quiet says which
  // computer is asleep rather than that wsp is not running, nothing there being broken.
  const heldForAnswer = blocked === "unreachable";
  // A home's composer has no workspace to be blocked by: its send is what makes one.
  const unavailable =
    onStart !== undefined || waits || blocked === null || wakesFirst
      ? null
      : heldForAnswer
        ? composerHeldLine(computer)
        : hostAsleep(conn)
          ? HOST_ASLEEP_SEND
          : sendRefusal(blocked);
  const shut = unavailable !== null && !heldForAnswer;
  // Everything that holds this send, in one reading: what blocks every send in this workspace, then what this draft
  // alone cannot be sent as. The slot, the send button and the Enter path all take it from here, so a person is told
  // once and told the same thing wherever they look.
  const sendHeld = unavailable ?? slashHoldLine({ prompt: draft.prompt, catalog, screen: screenCommandsOf(harnessCatalog) });
  const sendDisabledReason = sendHeld ?? (thread.busy ? TURN_IN_FLIGHT : null);
  const hasText = draft.prompt.trim().length > 0;
  // The catalog answers before the click; a row the runtime's table stood in for is no answer, so an image is taken
  // and the runtime refuses in the agent's name if that binary turns out to read none. Any other file lands in the
  // thread's folder, which every agent reads.
  const readsImage = readsImages(harnessCatalog);

  const runningTurn = thread.view.running ? thread.view.latestTurn : null;
  // The runtime keys sessions.interrupt by its own session id; the events carry the harness id, which differs after a
  // resume, so the row from sessions.list maps one to the other. Without a row the events' id goes, and the runtime answers.
  const stopTarget = useMemo(() => {
    if (runningTurn === null) return null;
    const row = sessions?.find(r => r.claudeSessionId === runningTurn.sessionId || r.id === runningTurn.sessionId);
    return row?.id ?? runningTurn.sessionId;
  }, [runningTurn, sessions]);
  // The same row sessions.interrupt is keyed by: a pick made while this turn runs goes to the runtime by that id.
  // Between turns, a thread that has run is named by its latest row, the one the pickers stand on, so the pick still
  // goes through the access verb and the thread's next turn runs at it; a thread that has not run names nothing,
  // its pick opens it.
  const pickTarget = useMemo<AccessTarget | null>(() => {
    if (stopTarget !== null && runningTurn !== null) return { sessionId: stopTarget, turnId: runningTurn.turnId };
    return latestRow !== null ? { sessionId: latestRow.id, turnId: null } : null;
  }, [latestRow, runningTurn, stopTarget]);
  // The harness's own row decides whether the pick moves the running turn, and it is the same row the menu reads
  // to say so before the pick.
  const accessPick = useAccessPick(workspaceId, pickTarget, thread.threadKey, movesRunningAccess(harnessCatalog));
  // Fast is the thread's own: a hand pick on this thread, else what its latest turn ran at. It rides only where the
  // model in front of the person offers it, which is also the only place the options menu offers it.
  const fastPicked = useComposerModesStore(s => s.fast[threadKey]);
  const setFast = useComposerModesStore(s => s.setFast);
  const fastOffered = pickedModel?.fast === true;
  const fastOn = fastOffered && (fastPicked ?? latestRow?.fast === true);
  const stopPending = stop !== null && runningTurn !== null && stop.turnId === runningTurn.turnId;
  const canStop = runningTurn !== null && api?.interruptSession !== undefined;
  // The catalog answers before the click: a harness that steers takes the row into the turn, any other queues it.
  const canSteer = canStop && harnessCatalog?.steers === true && api?.steerSession !== undefined;
  // The draft holds the collapsed caret, where a chip is one place; a trigger reads the text as sent. A caret beside a
  // chip opens nothing, so a chip's own text never reads as a token being typed.
  const candidate = useMemo(() => {
    if (isCollapsedCursorAdjacentToInlineToken(draft.prompt, draft.cursor, "left") || isCollapsedCursorAdjacentToInlineToken(draft.prompt, draft.cursor, "right")) return null;
    return detectComposerTrigger(draft.prompt, expandCollapsedComposerCursor(draft.prompt, draft.cursor));
  }, [draft]);
  const { trigger, setTrigger, dismissTrigger } = useComposerTriggerState(() => candidate);
  useLayoutEffect(() => setTrigger(candidate), [candidate, setTrigger]);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const wire = useDaemonWire(workspaceId);
  const startFolder = useThreadFolder(workspaceId);
  // The folder the thread runs in, which is where its @ paths are read from and the one the checkout row names.
  const folder = opening ? startFolder : (viewCwd ?? startFolder);
  const listed = onStart === undefined && unavailable === null && wire !== null && folder !== null;
  const session = trigger === null ? "" : `${trigger.kind}:${trigger.rangeStart}`;
  const itemsKey = listed ? `${workspaceId}\0items\0${folder}` : null;
  const readItems = useCallback(() => inPersonsWords(gitPrList(wire!, folder!), computer), [computer, folder, wire]);
  // The pull requests and issues are asked for as the thread opens, so the first # draws from an answer in hand.
  useEffect(() => {
    if (itemsKey !== null && wire !== null) prefetchComposerList(wire, itemsKey, readItems);
  }, [itemsKey, readItems, wire]);
  const checkout = useComposerList(wire, listed && trigger?.kind === "path" ? `${workspaceId}\0files\0${folder}` : null, session, () => inPersonsWords(fsFiles(wire!, folder!), computer));
  const references = useComposerList(wire, trigger?.kind === "pull-request" ? itemsKey : null, session, readItems);
  const skillsWanted = onStart === undefined && (trigger?.kind === "slash-command" || trigger?.kind === "skill");
  const skills = useAgentsReport(skillsWanted ? { workspaceId } : null).report?.skills;
  const groups = useMemo<ComposerCommandGroup[]>(() => {
    if (trigger === null || unavailable !== null) return [];
    switch (trigger.kind) {
      case "slash-command":
        if (trigger.rangeStart !== 0) return [];
        return slashGroups({ harness: catalog.harness, announced: catalog.slashCommands, skills: skills ?? [], query: trigger.query });
      case "skill":
        return skillGroups({ harness: catalog.harness, skills: skills ?? [], query: trigger.query });
      case "path":
        return checkout.data === null ? [] : fileGroups(checkout.data.files, trigger.query);
      case "pull-request":
        return references.data === null ? [] : referenceGroups(references.data.items, trigger.query);
    }
  }, [catalog, checkout.data, references.data, skills, trigger, unavailable]);
  // The @ and # menus say in their own last row what their list is doing: on its way, failed, cut at the cap, not
  // served by the host, or answered with nothing that matches.
  const list = trigger?.kind === "path" ? checkout : trigger?.kind === "pull-request" ? references : null;
  const listKind = trigger?.kind === "path" || trigger?.kind === "pull-request" ? trigger.kind : null;
  const unlisted = references.data?.noCliFor;
  const menuNote =
    list === null || listKind === null || unavailable !== null || onStart !== undefined || !listed
      ? null
      : list.error !== null
        ? list.error
        : list.data === null
          ? COMPOSER_WORDS.menuLoading[listKind]
          : listKind === "path" && checkout.data?.truncated === true
            ? COMPOSER_WORDS.filesCut
            : groups.length > 0
              ? null
              : listKind === "pull-request" && unlisted !== undefined
                ? COMPOSER_WORDS.noHostList(unlisted, computer)
                : listKind === "pull-request" && references.data?.note !== undefined
                  ? references.data.note
                  : COMPOSER_WORDS.menuNoMatch[listKind];
  // The keyboard walks the menu as it is drawn, so the groups decide the order the arrows take and not the other way round.
  const items = useMemo<ComposerCommandItem[]>(() => groups.flatMap(group => group.items), [groups]);
  const menuOpen = groups.length > 0 || menuNote !== null;
  const activeItemId = resolveComposerMenuActiveItemId({ items, highlightedItemId, currentSearchKey: searchKey, highlightedSearchKey });

  useEffect(() => {
    if (thread.fresh) editorRef.current?.focus();
  }, [thread.fresh]);

  useEffect(() => onComposerFocusRequest(workspaceId, () => editorRef.current?.focus()), [workspaceId]);

  const onChange = useCallback((value: string, cursor: number) => setDraft(workspaceId, { prompt: value, cursor }), [setDraft, workspaceId]);

  /** The one road every file takes into the composer: the paste, the drop and the picker all end here, so the caps
   * and the refusal words are said once. An image for an agent that reads none is turned away before it is read
   * whole. */
  const take = useCallback(
    (given: readonly File[]) => {
      // Paste and drop answer to the same state the picker button does: one door open and two shut would take a
      // file the send could not carry. A waiting card keeps only its words, so a composer that waits takes none.
      if (given.length === 0 || shut || waits) return;
      void addFiles(workspaceId, given, readsImage ? undefined : noImagesLine(harnessId));
    },
    [addFiles, harnessId, readsImage, shut, waits, workspaceId],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const pasted = [...(event.clipboardData?.files ?? [])];
      if (pasted.length === 0) return;
      event.preventDefault();
      take(pasted);
    },
    [take],
  );

  // Long text lands as a file the agent can read in parts, ahead of the editor, which would otherwise take it into
  // the box; so this listens as the paste goes down, not as it comes back up.
  const onPasteCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const data = event.clipboardData;
      if (data === null || data === undefined || (data.files?.length ?? 0) > 0) return;
      const text = data.getData("text/plain");
      if (!pastesAsFile(text)) return;
      event.preventDefault();
      event.stopPropagation();
      take([new File([text], nextPastedTextName(files.map(file => file.name)), { type: "text/plain" })]);
    },
    [files, take],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const dropped = [...(event.dataTransfer?.files ?? [])];
      if (dropped.length === 0) return;
      event.preventDefault();
      take(dropped);
    },
    [take],
  );

  const highlight = useCallback(
    (itemId: string | null) => {
      setHighlightedItemId(itemId);
      setHighlightedSearchKey(searchKey);
    },
    [searchKey],
  );

  const { setSending, appendUserTurn, appendLocalError, thread: into, busy, sending } = thread;
  /** Starts a turn with the box's files, or with a queued message's own when `rowId` names the card it came off. */
  const start = useCallback(
    (prompt: string, onRefused: () => void, rowId?: string) => {
      if (!api) return;
      const requestId = newId();
      const carried = rowId === undefined ? files : (useComposerFilesStore.getState().queued[rowId] ?? []);
      const attachments = carried.map(attachmentOf);
      setSending(true);
      hold(threadKey);
      appendUserTurn(prompt, requestId, carried.map(recordOf));
      // A send that names no thread opens one the runtime has written no row for, so the sidebar is handed the same
      // thread the transcript has until that row arrives.
      if (into === undefined) launching(workspaceId, { requestId, title: prompt, harness: harnessId });
      // The files leave the composer with the send and are kept under its request id, which is what the person's
      // row in the transcript is drawn from; a refused send hands them back rather than losing them.
      sendFilesAs(workspaceId, requestId, rowId);
      if (rowId === undefined) dismissRefused(workspaceId);
      // The wake settles or fails before the start is asked; a wake that failed leaves the runtime to refuse the
      // start in its own words, which land in the transcript like any other refusal.
      void (wakesFirst ? wake(workspaceId) : Promise.resolve())
        .then(() =>
          api.startSession({
            workspaceId,
            prompt,
            requestId,
            ...(into !== undefined ? { thread: into } : {}),
            ...folderStart,
            ...(attachments.length > 0 ? { attachments } : {}),
            // A send that opens a thread names the agent the box shows, so the thread runs on what the person read.
            ...(into === undefined ? { harness: harnessId } : {}),
            ...sendPicks(pinned, startOptions),
            ...(fastOn ? { fast: true } : {}),
          }),
        )
        .then(() => {
          if (into === undefined) useComposerOptionsStore.getState().drop(workspaceId, threadKey);
        })
        .catch((err: unknown) => {
          setSending(false);
          launched(workspaceId, requestId);
          onRefused();
          restoreFiles(workspaceId, requestId, rowId);
          appendLocalError(err instanceof Error ? err.message : String(err));
        });
    },
    [api, appendLocalError, appendUserTurn, dismissRefused, fastOn, files, folderStart, harnessId, hold, into, launched, launching, pinned, restoreFiles, sendFilesAs, setSending, startOptions, threadKey, wake, wakesFirst, workspaceId],
  );

  /** Asks the host beside the thread and opens the right panel on the answer, putting the panel back as it was once
   * the side question closes. */
  const askAside = useCallback(
    (question: string) => {
      const method = api?.askAside;
      if (method === undefined || latestRow === null) return;
      const panel = useRightPanelStore.getState();
      const wasOpen = selectWorkspaceRightPanelState(panel.byWorkspaceId, workspaceId).isOpen;
      const id = useAsideStore.getState().ask(workspaceId, question, wasOpen);
      if (!wasOpen) panel.show(workspaceId);
      void method(latestRow.id, question).then(
        result => useAsideStore.getState().answer(workspaceId, id, { answer: result.text }),
        (err: unknown) => useAsideStore.getState().answer(workspaceId, id, { error: err instanceof Error ? err.message : String(err) }),
      );
    },
    [api, latestRow, workspaceId],
  );

  const restoreDraft = useCallback(
    (prompt: string) => {
      const current = useComposerDraftStore.getState().drafts[workspaceId];
      if (current === undefined || current.prompt === "") setDraft(workspaceId, { prompt, cursor: prompt.length });
    },
    [setDraft, workspaceId],
  );

  /** Stops the running turn. A stop wsp no longer knows, one the runtime refused, and one whose process has not ended
   * by STOP_WAIT each raise a flyout and offer stop again; `onSettled` hears the stop settle either way, so a send-now's
   * card stops reading Next. */
  const interrupt = useCallback(
    (onSettled?: () => void) => {
      const method = api?.interruptSession;
      if (!method || runningTurn === null || stopTarget === null || stopPending) return;
      const { turnId } = runningTurn;
      const attempt = ++stops.current;
      const settle = (words: string | null) => {
        if (stops.current !== attempt) return;
        stops.current += 1;
        setStop(null);
        onSettled?.();
        if (words !== null) flyout(words);
      };
      setStop({ turnId });
      const waited = window.setTimeout(() => settle(COMPOSER_WORDS.stopDidNotEnd), STOP_WAIT.ms);
      void method(stopTarget).then(
        outcome => {
          window.clearTimeout(waited);
          settle(outcome === "not-found" ? COMPOSER_WORDS.stopUnknown : null);
        },
        (err: unknown) => {
          window.clearTimeout(waited);
          settle(stopFailureWords({ error: err instanceof Error ? err.message : String(err), unreachable: blocked === "unreachable" || absent !== null, computer }));
        },
      );
    },
    [absent, api, blocked, computer, runningTurn, stopPending, stopTarget],
  );

  /** A send during a turn with steer picked and a harness that steers: the message goes to the head, then into the
   * running turn. The caller has already queued anything a steer cannot carry. */
  const sendNow = useCallback(
    (row: QueuedMessage) => {
      release(threadKey);
      const method = api?.steerSession;
      if (!canSteer || runningTurn === null || stopTarget === null || method === undefined) return;
      const words = row.prompt.trim();
      setNext(row.id);
      void method(stopTarget, words, newId()).then(
        outcome => {
          setNext(null);
          if (outcome === "accepted") return removeQueued(threadKey, row.id);
          // not-running: the turn beat the message, so it stays at the head and the head effect starts it once the turn ends.
          if (outcome === "not-found") flyout(COMPOSER_WORDS.sendNowFailed(COMPOSER_WORDS.sendNowUnknown));
          if (outcome === "unsupported") flyout(COMPOSER_WORDS.sendNowFailed(COMPOSER_WORDS.sendNowUnsupported));
        },
        (err: unknown) => {
          setNext(null);
          flyout(COMPOSER_WORDS.sendNowFailed(err instanceof Error ? err.message : String(err)));
        },
      );
    },
    [api, canSteer, release, removeQueued, runningTurn, stopTarget, threadKey],
  );

  /** Sends the draft, or queues it behind a running turn; with steer picked it goes into that turn at once where the
   * harness steers and the draft carries words alone, and is queued like any other where not: a pick never stops a turn. */
  const send = useCallback(
    () => {
      const now = steers && canSteer && files.length === 0;
      // The same reading the send button's hover is already wearing: an Enter that lands here leaves the draft where
      // it was typed and says why.
      if (sendHeld !== null) {
        addNotice({ kind: "note", text: sendHeld });
        return;
      }
      const prompt = (editorRef.current?.readSnapshot().value ?? draft.prompt).trim();
      if (prompt === "") return;
      // A side question is the host's to answer and never a turn, so it goes whether or not the thread is working.
      const question = asides ? asideQuestion(prompt) : null;
      if (question !== null) {
        setDraft(workspaceId, EMPTY_DRAFT);
        askAside(question);
        return;
      }
      // A command the CLI runs only in its own terminal would come back as not available, so the draft stays for
      // editing and a flyout names the wsp control that serves it instead.
      const screen = screenCommandTyped(harnessCatalog, prompt);
      if (screen !== null && harnessCatalog !== null) {
        addNotice({ kind: "note", text: screenCommandLine(screen, harnessCatalog, workspace ?? {}) });
        dismissTrigger(trigger);
        return;
      }
      setDraft(workspaceId, EMPTY_DRAFT);
      if (waits) {
        enqueue(threadKey, prompt);
        return;
      }
      if (onStart !== undefined) {
        void onStart(prompt).then(refusal => {
          if (refusal === null) return;
          flyout(refusal);
          restoreDraft(prompt);
        });
        return;
      }
      if (!busy) {
        start(prompt, () => restoreDraft(prompt));
        return;
      }
      dismissRefused(workspaceId);
      // Behind a pending send the card waits with the rest, held since that send began; its start releases them.
      if (sending || runningTurn === null) {
        queueFiles(workspaceId, enqueue(threadKey, prompt, now && !sending ? "head" : "tail"));
        return;
      }
      const id = enqueue(threadKey, prompt, now || held ? "head" : "tail");
      queueFiles(workspaceId, id);
      if (now) sendNow({ id, prompt });
      else release(threadKey);
    },
    [askAside, asides, busy, canSteer, dismissRefused, dismissTrigger, draft, enqueue, files, harnessCatalog, held, onStart, queueFiles, release, restoreDraft, runningTurn, sendHeld, sendNow, sending, setDraft, start, steers, threadKey, trigger, waits, workspace, workspaceId],
  );

  // The head row goes as soon as nothing blocks a send; starting flips busy, so the rest wait for the next end.
  const head = queue[0];
  useEffect(() => {
    if (head === undefined || held || unavailable !== null || busy || waits) return;
    removeQueued(threadKey, head.id);
    const prompt = head.prompt.trim();
    if (prompt !== "") start(prompt, () => requeue(threadKey, head), head.id);
    else dropFiles(head.id);
  }, [busy, dropFiles, head, held, removeQueued, requeue, start, threadKey, unavailable, waits]);

  /** A card's edit: its words and files go back in the box, a draft already there kept in front of them. */
  const editCard = useCallback(
    (id: string) => {
      const row = queue.find(r => r.id === id);
      if (row === undefined) return;
      removeQueued(threadKey, id);
      putFiles(workspaceId, unqueueFiles(id));
      const typed = (editorRef.current?.readSnapshot().value ?? draft.prompt).trim();
      const prompt = typed === "" ? row.prompt : `${typed}\n${row.prompt}`;
      setDraft(workspaceId, { prompt, cursor: collapseExpandedComposerCursor(prompt, prompt.length) });
      window.requestAnimationFrame(() => editorRef.current?.focus());
    },
    [draft.prompt, putFiles, queue, removeQueued, setDraft, threadKey, unqueueFiles, workspaceId],
  );

  const removeCard = useCallback(
    (id: string) => {
      removeQueued(threadKey, id);
      dropFiles(id);
    },
    [dropFiles, removeQueued, threadKey],
  );

  const selectItem = useCallback(
    (item: ComposerCommandItem) => {
      const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, expandedCursor: expandCollapsedComposerCursor(draft.prompt, draft.cursor) };
      const active = detectComposerTrigger(snapshot.value, snapshot.expandedCursor);
      if (active === null) return;
      let next: { text: string; cursor: number };
      if (item.type === "reference") {
        // A pull request or issue goes as a block on lines of its own, which the # typed to find it gives way to.
        const cut = replaceTextRange(snapshot.value, active.rangeStart, active.rangeEnd, "");
        next = insertComposerBlock(cut.text, cut.cursor, hostItemText(item.item));
      } else {
        const replacement =
          item.type === "path" ? `${serializeComposerMention(item.path)} ` : item.type === "skill" && !item.announced ? `$${item.command.name} ` : `/${item.command.name} `;
        const rangeEnd = snapshot.value[active.rangeEnd] === " " ? active.rangeEnd + 1 : active.rangeEnd;
        next = replaceTextRange(snapshot.value, active.rangeStart, rangeEnd, replacement);
      }
      const cursor = collapseExpandedComposerCursor(next.text, next.cursor);
      setDraft(workspaceId, { prompt: next.text, cursor });
      setHighlightedItemId(null);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(cursor));
    },
    [draft, setDraft, workspaceId],
  );

  /** Puts the draft and its files on the stash and opens the composer empty; a stash that could not be written leaves
   * both where they were and says so. */
  const stashDraft = useCallback((): boolean => {
    const prompt = editorRef.current?.readSnapshot().value ?? draft.prompt;
    const held = takeFiles(workspaceId);
    const { kept, dropped } = partitionStashFiles(held.map(stashedOf));
    const written = usePromptStashStore.getState().stash({ id: newId(), createdAt: new Date().toISOString(), prompt, files: kept, dropped });
    if (!written) {
      putFiles(workspaceId, held);
      flyout(COMPOSER_WORDS.stashNotWritten);
      return false;
    }
    releaseFiles(held);
    setDraft(workspaceId, EMPTY_DRAFT);
    return true;
  }, [draft.prompt, putFiles, setDraft, takeFiles, workspaceId]);

  /** Brings a stashed prompt back with its files; a draft already in the box goes onto the stash, so a restore never
   * overwrites words. The entry comes off first, so a full stash never drops the very entry being restored, and it
   * goes back where it was when the draft cannot be stashed. */
  const restoreStashed = useCallback(
    (entry: PromptStashEntry) => {
      const prompt = editorRef.current?.readSnapshot().value ?? draft.prompt;
      const store = usePromptStashStore.getState();
      const at = store.entries.findIndex(candidate => candidate.id === entry.id);
      if (store.take(entry.id) === null) return;
      if ((prompt.trim() !== "" || files.length > 0) && !stashDraft()) {
        usePromptStashStore.getState().putBack(entry, at);
        return;
      }
      putFiles(workspaceId, entry.files.map(fileFromStash));
      setDraft(workspaceId, { prompt: entry.prompt, cursor: collapseExpandedComposerCursor(entry.prompt, entry.prompt.length) });
      setStashOpen(false);
    },
    [draft.prompt, files.length, putFiles, setDraft, stashDraft, workspaceId],
  );

  /** Cmd or Ctrl with S: a draft goes onto the stash; an empty box brings back the one stashed prompt, or opens the
   * list when there are several. */
  const onStashKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key.toLowerCase() !== "s" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const prompt = editorRef.current?.readSnapshot().value ?? draft.prompt;
      if (prompt.trim() !== "" || files.length > 0) stashDraft();
      else if (stashed.length === 1) restoreStashed(stashed[0]!);
      else if (stashed.length > 1) setStashOpen(true);
    },
    [draft.prompt, files.length, restoreStashed, stashDraft, stashed],
  );

  // Recall reads the thread's messages at the keypress, through a ref, so a streaming reply re-registers no key.
  const entriesRef = useRef(thread.view.entries);
  entriesRef.current = thread.view.entries;
  const recallRef = useRef<ComposerPromptHistoryPosition | null>(null);
  const recall = useCallback(
    (direction: "backward" | "forward"): boolean => {
      const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, expandedCursor: expandCollapsedComposerCursor(draft.prompt, draft.cursor) };
      const edge = direction === "backward" ? !snapshot.value.slice(0, snapshot.expandedCursor).includes("\n") : !snapshot.value.slice(snapshot.expandedCursor).includes("\n");
      if (snapshot.value.length > 0 && !edge) return false;
      const entries = buildComposerPromptHistoryEntries(entriesRef.current.flatMap(entry => (entry.kind === "message" ? [{ id: entry.message.id, role: entry.message.role, text: entry.message.text }] : [])));
      const step = stepComposerPromptHistory({ direction, entries, position: recallRef.current, currentPrompt: snapshot.value });
      if (step === null) return false;
      recallRef.current = step.position;
      // The caret lands on the edge the walk goes on from, so the next press keeps walking even through a prompt of
      // several lines.
      setDraft(workspaceId, { prompt: step.prompt, cursor: direction === "backward" ? 0 : collapseExpandedComposerCursor(step.prompt, step.prompt.length) });
      return true;
    },
    [draft, setDraft, workspaceId],
  );

  const onCommandKeyDown = useCallback(
    (key: ComposerCommandKey, event: KeyboardEvent): boolean => {
      if (key === "Escape") {
        if (menuOpen) {
          dismissTrigger(trigger);
          return true;
        }
        return false;
      }
      if (menuOpen && items.length > 0) {
        if (key === "ArrowDown" || key === "ArrowUp") {
          const index = items.findIndex(item => item.id === activeItemId);
          const offset = key === "ArrowDown" ? 1 : -1;
          const next = items[(index + offset + items.length) % items.length];
          highlight(next?.id ?? null);
          return true;
        }
        if (key === "Enter" || key === "Tab") {
          const item = items.find(candidate => candidate.id === activeItemId) ?? items[0];
          if (item) selectItem(item);
          return true;
        }
      }
      if ((key === "ArrowUp" || key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
        return recall(key === "ArrowUp" ? "backward" : "forward");
      }
      if (key === "Enter") {
        if (enterSends({ shiftKey: event.shiftKey, modKey: isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey, sendWith })) {
          send();
          return true;
        }
      }
      return false;
    },
    [activeItemId, dismissTrigger, highlight, items, menuOpen, recall, selectItem, send, sendWith, trigger],
  );

  // A home's thread carries a history-unavailable row and no message, so the count is of messages alone.
  const compact = thread.view.running || thread.view.entries.some(entry => entry.kind === "message");
  const access = <ComposerAccessPicker workspaceId={workspaceId} thread={thread} onPickAccess={accessPick.pick} refused={accessPick.line} />;
  const accessInBar = <ComposerAccessPicker workspaceId={workspaceId} thread={thread} onPickAccess={accessPick.pick} refused={accessPick.line} inBar />;
  const home = useStore(s => s.projects.find(p => projectHomeKey(p.id) === workspaceId));
  usePublishContext(workspaceId, thread.view.turns, harnessCatalog?.label ?? harnessId);
  const heightRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const tall = useTallDraft(mirrorRef, draft.prompt, compact);
  useAnimatedHeight(heightRef, surfaceRef);
  useFlip(surfaceRef, compact ? (tall ? "tall" : "line") : "full");
  // The full box's bar holds the access beside the model and the effort while it fits; narrower, it waits underneath.
  const wide = useWiderThan(surfaceRef, ACCESS_IN_BAR_PX);
  const accessIn = !compact && wide;
  const commandMenu = menuOpen ? (
    <ComposerCommandMenuLayer anchor={menuAnchor}>
      <ComposerCommandMenu groups={groups} note={menuNote} triggerKind={trigger?.kind ?? null} activeItemId={activeItemId} onHighlightedItemChange={highlight} onSelect={selectItem} />
    </ComposerCommandMenuLayer>
  ) : stashOpen && stashed.length > 0 ? (
    <ComposerCommandMenuLayer anchor={menuAnchor}>
      <ComposerStashMenu entries={stashed} onRestore={restoreStashed} onDelete={entry => void usePromptStashStore.getState().take(entry.id)} onClose={() => setStashOpen(false)} />
    </ComposerCommandMenuLayer>
  ) : null;
  const stashWord =
    stashed.length > 0 ? (
      <button
        type="button"
        data-composer-stash-word="true"
        aria-expanded={stashOpen}
        title="Stashed prompts: Cmd or Ctrl with S stashes a draft, and brings one back into an empty box"
        onClick={() => setStashOpen(open => !open)}
        className={cn(ROW_ITEM_CLASS, "cursor-pointer tabular-nums transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring")}
      >
        {stashedWord(stashed.length)}
      </button>
    ) : null;
  const actions = (
    <div data-flip="actions" className="flex shrink-0 flex-nowrap items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label="Attach"
        title={`Add a file: paste, drop or pick one, at most ${FILES_MAX}. An image (${IMAGE_TYPE_WORDS}) goes up to ${IMAGE_MAX_WORDS}, any other file up to ${FILE_MAX_WORDS}.`}
        disabled={shut || waits}
        onClick={() => pickerRef.current?.click()}
        data-composer-file-picker="true"
      >
        <PaperclipIcon />
      </Button>
      <input
        ref={pickerRef}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        data-composer-file-input="true"
        onChange={event => {
          take([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {beside}
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning={canStop}
        isInterruptPending={stopPending}
        showPlanFollowUpPrompt={false}
        promptHasText={hasText}
        isSendBusy={thread.busy}
        wakesFirst={wakesFirst}
        sendLabel={sendGiven ?? (onStart !== undefined && multiPicks.length > 0 ? `Send to ${multiPicks.length}` : undefined)}
        sendDisabledReason={sendDisabledReason}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={hasText}
        onPreviousPendingQuestion={noop}
        onInterrupt={() => interrupt()}
        onImplementPlanInNewThread={noop}
      />
    </div>
  );

  return (
    <div className="relative w-full px-3 pt-1.5 pb-4 sm:px-5 sm:pt-2 sm:pb-5" data-chat-composer>
      <ComposerQueue rows={queue} files={queuedFiles} next={next} waiting={waiting?.line ?? null} onEdit={editCard} onRemove={removeCard} />
      <ComposerSurface.Shell contextStrip>
        {tasks !== null ? <ComposerTasks tasks={tasks} /> : null}
        <ComposerSurface.Host>
          <form
            className="mx-auto w-full min-w-0 max-w-3xl"
            data-chat-composer-form="true"
            onSubmit={event => {
              event.preventDefault();
              send();
            }}
          >
            <div className="relative">
              <ComposerSurface.Main>
                <div
                  ref={heightRef}
                  className="overflow-hidden rounded-[20px] data-armed:transition-[height] data-armed:duration-180 data-armed:ease-out motion-reduce:transition-none!"
                >
                  <div
                    ref={surfaceRef}
                    data-chat-composer-surface="true"
                    data-compact={compact || undefined}
                    data-tall={tall || undefined}
                    className="rounded-[20px] transition-[background-color] duration-200"
                    onPaste={onPaste}
                    onPasteCapture={onPasteCapture}
                    onKeyDown={onStashKey}
                    onDrop={onDrop}
                    onDragOver={event => event.preventDefault()}
                  >
                    {onStart !== undefined ? <ComposerModelChips workspaceId={workspaceId} /> : null}
                    {files.length > 0 || refusedFiles.length > 0 ? (
                      <ul aria-label="Files to send" data-composer-files="true" className="flex flex-wrap gap-1.5 px-3 pt-3 sm:px-4">
                        {files.map((file, at) => {
                          const remove = () => removeFile(workspaceId, file.id);
                          return (
                            <li key={file.id}>
                              {file.url !== undefined ? <ChatImageThumb image={file} at={at + 1} onRemove={remove} /> : <ChatFileTile name={file.name} size={file.size} at={at + 1} onRemove={remove} />}
                            </li>
                          );
                        })}
                        {refusedFiles.map(file => (
                          <li key={file.id}>
                            <ChatRefusedFile name={file.name} why={file.why} onRemove={() => dismissRefused(workspaceId, file.id)} />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div
                      data-chat-composer-compact={compact || undefined}
                      className={cn(
                        "grid grid-cols-[minmax(0,1fr)_auto_auto] items-center",
                        compact ? "gap-x-1 ps-4 pe-2 sm:ps-5 [&_[data-composer-picker]]:h-7 [&_[data-composer-picker]]:gap-1.5 [&_[data-composer-picker]]:text-[13px]" : "gap-x-2 gap-y-2 px-3 pt-3.5 pb-3 sm:px-4 sm:pt-4 sm:pb-4",
                        compact && (tall ? "gap-y-1 pt-3.5 pb-2" : "py-2"),
                      )}
                    >
                      <div aria-hidden className="relative col-start-1 row-start-1 h-0 self-start">
                        <div
                          ref={mirrorRef}
                          className="invisible absolute inset-x-0 top-0 whitespace-pre-wrap wrap-break-word leading-relaxed [font-family:var(--font-composer,var(--font-sans))] [font-size:var(--font-size-prompt,0.875rem)]"
                        >
                          {compact ? `${mirrorText(draft.prompt)}\u200b` : null}
                        </div>
                      </div>
                      <div ref={setMenuAnchor} className={cn("relative col-start-1 row-start-1 min-w-0", (!compact || tall) && "col-end-4", !compact && "pb-1")}>
                        {commandMenu}
                        <ComposerPromptEditor
                          editorRef={editorRef}
                          value={draft.prompt}
                          cursor={draft.cursor}
                          disabled={shut}
                          placeholder={composerPlaceholder(catalog)}
                          onChange={onChange}
                          onCommandKeyDown={onCommandKeyDown}
                          {...(compact ? { className: "min-h-[1lh] max-h-[8lh]" } : {})}
                        />
                      </div>
                      <div
                        data-flip="pickers"
                        data-chat-composer-footer={compact ? undefined : "true"}
                        className={cn(
                          "flex min-w-0 items-center",
                          compact ? "col-start-2" : "-m-1 -ms-3.5 col-start-1 flex-wrap gap-1 p-1 ps-3.5",
                          compact && !tall ? "row-start-1" : "row-start-2",
                        )}
                      >
                        <ComposerOptionPickers
                          compact={compact}
                          workspaceId={workspaceId}
                          thread={thread}
                          fast={fastOffered ? { on: fastOn, set: on => setFast(threadKey, on), held: waits } : null}
                        />
                        {accessIn ? (
                          <>
                            <BarRule />
                            {accessInBar}
                          </>
                        ) : null}
                      </div>
                      <div
                        data-chat-composer-actions="right"
                        className={cn(
                          "col-start-3 flex shrink-0 items-center justify-self-end",
                          compact && !tall ? "row-start-1" : "row-start-2 self-end",
                          // A second button leaves the pickers no room on a phone, so the buttons take a row of their own.
                          beside !== undefined && !compact && "max-sm:col-span-full max-sm:col-start-1 max-sm:row-start-3 max-sm:mt-1",
                        )}
                      >
                        {actions}
                      </div>
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </div>
          </form>
        </ComposerSurface.Host>
        {home !== undefined ? (
          <HomeCheckoutRow path={home.path} branch={home.defaultBranch} where={where} access={accessIn ? null : access} />
        ) : waiting !== undefined ? (
          <HomeCheckoutRow path={waiting.folder} branch="" where={where} access={accessIn ? null : access} />
        ) : (
          <ComposerCheckoutRow
          workspaceId={workspaceId}
          thread={thread}
          access={accessIn ? null : access}
          stash={stashWord}
          />
        )}
        {under !== undefined ? <ComposerSurface.ContextStrip data-composer-under>{under}</ComposerSurface.ContextStrip> : null}
      </ComposerSurface.Shell>
    </div>
  );
}
