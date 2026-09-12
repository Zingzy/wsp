// SPDX-License-Identifier: AGPL-3.0-only
// The composer under the chat thread: the transplanted prompt editor, slash
// menu, send and stop buttons over one draft per workspace. Enter starts one
// turn through sessions.start, resumed with the workspace's Claude session
// unless a new thread was requested; a thread with no session to resume, its
// launch having failed, is named instead, and the runtime runs the message as
// its first turn. A failed send puts the draft back. Stop
// sends one sessions.interrupt for the turn on screen and waits, disabled,
// for the turn's end; the runtime pushes the interrupted done before it
// answers, and the composer opens when the process exits. not-running means
// the turn beat the click and is no error; not-found and a refused request
// show in the line above the box. The editor is disabled with the reason
// while the runtime or the workspace is not live or the agents here have not
// answered yet, and one reading of that reason serves the slot above the box,
// the send button's name and tooltip and the Enter path alike: the block heads
// the slot as one muted mono sentence, the button is held at the weight every
// held primary wears, and an Enter leaves the draft where it was typed with
// that line still standing, so Enter never fails silently. A running turn
// blocks nothing: Enter then queues the message under the thread's key in the
// draft store, the rows stack above the box, and when the turn ends the head
// row starts the next turn; a fresh thread's rows wait under the workspace id
// until its own first start names it, then move under that id, whichever
// thread is on screen when that start lands. Every send holds the thread's
// rows until its start lands, so a start the runtime refuses or a harness
// that dies before init drains nothing behind it. Rows read back from storage
// are held too. Held rows go only after the person's next Enter or send-now
// here, never on their own, and a row typed during a turn goes ahead of the
// held ones it releases. Send-now on a row puts it at the head; when the
// harness's catalog says it steers, the row goes into the running turn
// through sessions.steer and leaves the queue once the runtime took it (the
// thread shows it from the session.steer event), while not-running leaves it
// at the head for the turn's end. A harness that does not steer gets the turn
// stopped first, with the one-line notice. A new thread owes nothing to the
// turn it left behind: the runtime runs a workspace's threads side by side
// and holds each to one turn, so the fresh composer opens at once. The slash
// menu offers what the session's harness announced less the commands the
// runtime catalog says run only in the CLI's own terminal; with nothing left
// to offer it does not open at all and the placeholder drops its half about
// commands, since a menu that answers a typed slash with an empty state
// promises what it cannot keep. Enter on a screen command sends nothing: the
// line names the wsp control that serves it and goes with the next edit, and
// a block on the send outranks it. A slash command nobody announced still
// goes as text, since the words may be meant.
// The checkout row under the composer picks the folder a fresh thread starts
// in; a resumed one is started where its harness last said it was. The
// model, effort, context window and access picks in the box's footer ride
// every start, so a change mid-thread applies at the next turn.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ClipboardEvent } from "react";
import { ImageIcon } from "lucide-react";
import { foldThreads, HOST_ASLEEP_SEND, IMAGES_AFTER_TURN, IMAGES_MAX, IMAGE_ACCEPT, IMAGE_MAX_WORDS, IMAGE_TYPE_WORDS, TURN_IN_FLIGHT, noImagesLine, readsImages, screenCommandLine, screenCommandTyped, screenCommandsOf, sendNowFailedLine, sendRefusal, stillWorkingLine, stopFailedLine, type SendRefusalKind, type WorkspaceState } from "@wsp/protocol";
import type { ConnStatus } from "../../protocol/client";
import { hostAsleep } from "../../boot";
import { useHarnessCatalogs, useStore, useWorkspace, useWorkspaceState } from "../../protocol/store";
import { onComposerFocusRequest } from "../../shell/shellRequests";
import { useThreadStart } from "../../files/root";
import { useLinkDownLine } from "../../terminal/paneWords";
import { composerSubmissionIntentForEnter, detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerCommandKey, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { catalogFromHarness, composerPlaceholder, offersSlashCommands } from "./adapt";
import { canPickFolder, ComposerCheckoutRow } from "./ComposerCheckoutRow";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { ChatImageThumb } from "./ChatImages";
import { attachmentOf, recordOf, useComposerImages, useComposerImagesStore } from "./composerImages";
import { EMPTY_DRAFT, newId, useComposerDraft, useComposerDraftStore, useComposerQueue, useComposerQueueHeld } from "./composerDraftStore";
import { ComposerOptionPickers, useAccessPick, useComposerPicks } from "./ComposerOptionPickers";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerQueue } from "./ComposerQueue";
import { searchSlashCommandItems, slashCommandItemsForPromptPosition } from "./composerSlashCommandSearch";
import { ComposerSurface } from "./ComposerSurface";
import { Button } from "../ui/button";
import type { ChatThreadHandle } from "./useChatThread";

const noop = () => {};

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
}): SendRefusalKind | null {
  if (!input.hasApi || input.conn === "connecting") return "connecting";
  if (input.conn === "reconnecting") return "reconnecting";
  if (input.conn === "closed") return "closed";
  if (input.state === null) return "not-found";
  if (input.state !== "running") return input.state;
  if (!input.hydrated) return "loading";
  if (!input.agents) return "no-agents";
  return null;
}

/** What one stop click left behind for the turn it targeted; the turn id keeps it from leaking onto the next turn. */
interface StopAttempt {
  readonly turnId: string;
  readonly pending: boolean;
  readonly error: string | null;
}

/** What the last send-now into a running turn left behind: the row while it is in flight, the runtime's refusal after. */
interface SteerAttempt {
  readonly turnId: string;
  readonly rowId: string | null;
  readonly error: string | null;
}

export function ChatComposer({ workspaceId, thread }: { workspaceId: string; thread: ChatThreadHandle }) {
  const api = useStore(s => s.api);
  const wake = useStore(s => s.wake);
  const conn = useStore(s => s.conn);
  const sessions = useStore(s => s.sessions[workspaceId]);
  const state = useWorkspaceState(workspaceId);
  const workspace = useWorkspace(workspaceId);
  const [stop, setStop] = useState<StopAttempt | null>(null);
  const [screenLine, setScreenLine] = useState<string | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const [steered, setSteered] = useState<SteerAttempt | null>(null);
  const draft = useComposerDraft(workspaceId);
  const { threadKey, named } = thread;
  const queue = useComposerQueue(threadKey);
  const held = useComposerQueueHeld(threadKey);
  const nextStart = useThreadStart(workspaceId);
  // A view locked to a turn resumes in that turn's folder, as its row says; only a view about to open a thread reads the pick.
  const viewCwd = thread.view.cwd;
  const pickable = canPickFolder(thread);
  const folderStart = useMemo(() => (pickable ? nextStart : viewCwd !== null ? { cwd: viewCwd } : {}), [nextStart, pickable, viewCwd]);
  // The folder picker under the box is up: opened from its own trigger, from new thread here, or from the project
  // menu's other folder row in the footer; it goes with the pick once the view is locked to a turn.
  const [folderPicker, setFolderPicker] = useState(false);
  const openFolderPicker = useCallback(() => setFolderPicker(true), []);
  const { harness: harnessId, startOptions, catalog: harnessCatalog } = useComposerPicks(workspaceId, thread);
  const harnessCatalogs = useHarnessCatalogs(workspaceId);
  const setDraft = useComposerDraftStore(s => s.setDraft);
  const enqueue = useComposerDraftStore(s => s.enqueue);
  const editQueued = useComposerDraftStore(s => s.editQueued);
  const removeQueued = useComposerDraftStore(s => s.removeQueued);
  const promoteQueued = useComposerDraftStore(s => s.promoteQueued);
  const hold = useComposerDraftStore(s => s.hold);
  const requeue = useComposerDraftStore(s => s.requeue);
  const release = useComposerDraftStore(s => s.release);
  const rekeyQueue = useComposerDraftStore(s => s.rekeyQueue);
  useEffect(() => {
    if (named === null) return;
    if (named.key !== named.thread) rekeyQueue(named.key, named.thread);
    release(named.thread);
  }, [named, rekeyQueue, release]);
  const images = useComposerImages(workspaceId);
  const addImages = useComposerImagesStore(s => s.add);
  const removeImage = useComposerImagesStore(s => s.remove);
  const sendImagesAs = useComposerImagesStore(s => s.sendAs);
  const restoreImages = useComposerImagesStore(s => s.restore);
  const [imageRefusal, setImageRefusal] = useState<string | null>(null);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);
  const [dismissedSearchKey, setDismissedSearchKey] = useState<string | null>(null);

  const linkDown = useLinkDownLine(workspaceId);
  const blocked = composerSendBlock({ conn, hasApi: api !== null, state, hydrated: thread.hydrated, agents: harnessCatalogs.length > 0 });
  // A send wakes a paused machine by itself, so paused is not a refusal here: the box takes the words and the send
  // button says it wakes first.
  const wakesFirst = blocked === "paused";
  // A window on another computer whose wsp has gone quiet says which computer is asleep, not that wsp is not
  // running: nothing here is broken, and the turn starts when that computer wakes.
  const unavailable = blocked === null || wakesFirst ? null : hostAsleep(conn) ? HOST_ASLEEP_SEND : sendRefusal(blocked);
  const sendDisabledReason = unavailable ?? (thread.busy ? TURN_IN_FLIGHT : null);
  const hasText = draft.prompt.trim().length > 0;
  // The catalog answers before the click; a row the runtime's table stood in for is no answer, so the picker is
  // offered and the runtime refuses in the agent's name if that binary turns out to read none.
  const canAttach = readsImages(harnessCatalog);

  const runningTurn = thread.view.running ? thread.view.latestTurn : null;
  // What the still-working line calls the thread: its own title, never the key wsp holds it under.
  const workingTitle = useMemo(() => foldThreads(sessions ?? []).find(row => row.id === threadKey)?.title, [sessions, threadKey]);
  // The runtime keys sessions.interrupt by its own session id; the events carry the harness id, which differs after a
  // resume, so the row from sessions.list maps one to the other. Without a row the events' id goes, and the runtime answers.
  const stopTarget = useMemo(() => {
    if (runningTurn === null) return null;
    const row = sessions?.find(r => r.claudeSessionId === runningTurn.sessionId || r.id === runningTurn.sessionId);
    return row?.id ?? runningTurn.sessionId;
  }, [runningTurn, sessions]);
  // The same row sessions.interrupt is keyed by: a pick made while this turn runs goes to the runtime by that id.
  const pickTarget = useMemo(
    () => (stopTarget !== null && runningTurn !== null ? { sessionId: stopTarget, turnId: runningTurn.turnId } : null),
    [runningTurn, stopTarget],
  );
  const accessPick = useAccessPick(workspaceId, pickTarget, thread.threadKey);
  const stopAttempt = stop !== null && runningTurn !== null && stop.turnId === runningTurn.turnId ? stop : null;
  const steerAttempt = steered !== null && runningTurn !== null && steered.turnId === runningTurn.turnId ? steered : null;
  const canStop = runningTurn !== null && api?.interruptSession !== undefined;
  // The catalog answers before the click: a harness that steers takes the row into the turn, any other gets the turn stopped.
  const canSteer = canStop && harnessCatalog?.steers === true && api?.steerSession !== undefined;
  // One line in the slot above the box, and what blocks a send heads it: every other line here is about a send this
  // composer could make, so while it can make none the block is the one true thing to say and the slot, the button's
  // name and an Enter all read it. Under it: the newest failure, then the screen command Enter refused, then the turn
  // that replied but still runs, in the runtime's own words, since a message sent now waits for that process and runs
  // as the next turn, then an access pick the running turn's harness would not take mid-turn, then the workspace's
  // link being down, which blocks no send and so comes after everything a person is being stopped by.
  const line =
    unavailable !== null
      ? unavailable
      : imageRefusal !== null
        ? imageRefusal
        : stopAttempt !== null && stopAttempt.error !== null
          ? stopFailedLine(stopAttempt.error)
          : steerAttempt !== null && steerAttempt.error !== null
            ? sendNowFailedLine(steerAttempt.error)
            : screenLine !== null
              ? screenLine
              : runningTurn?.replied === true
                ? stillWorkingLine(workingTitle)
                : (accessPick.line ?? linkDown);

  const trigger = useMemo(() => detectComposerTrigger(draft.prompt, draft.cursor), [draft]);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const { harness } = thread.view;
  const catalog = useMemo(() => catalogFromHarness({ id: harnessId, harness, screen: screenCommandsOf(harnessCatalog) }), [harness, harnessCatalog, harnessId]);
  const menuOpen = offersSlashCommands(catalog) && trigger !== null && trigger.rangeStart === 0 && dismissedSearchKey !== searchKey && unavailable === null;
  const items = useMemo<ComposerCommandItem[]>(() => {
    if (!menuOpen || trigger === null) return [];
    const all = catalog.slashCommands.map(command => ({
      id: `provider-slash-command:${catalog.harness}:${command.name}`,
      type: "provider-slash-command" as const,
      harness: catalog.harness,
      command,
      label: `/${command.name}`,
      description: command.description ?? command.input?.hint ?? "",
    }));
    return searchSlashCommandItems(slashCommandItemsForPromptPosition(all, trigger.rangeStart === 0), trigger.query);
  }, [catalog, menuOpen, trigger]);
  const activeItemId = resolveComposerMenuActiveItemId({ items, highlightedItemId, currentSearchKey: searchKey, highlightedSearchKey });

  useEffect(() => {
    if (thread.fresh) editorRef.current?.focus();
  }, [thread.fresh]);

  useEffect(() => onComposerFocusRequest(workspaceId, () => editorRef.current?.focus()), [workspaceId]);

  const onChange = useCallback(
    (value: string, cursor: number) => {
      setScreenLine(null);
      setDraft(workspaceId, { prompt: value, cursor });
    },
    [setDraft, workspaceId],
  );

  /** The one road every image takes into the composer: the paste, the drop and the picker all end here, so the caps
   * and the refusal words are said once. An agent that reads no image is turned away before a file is even read. */
  const take = useCallback(
    (files: readonly File[]) => {
      // Paste and drop answer to the same state the picker button does: one door open and two shut would take an
      // image the send could not carry.
      if (files.length === 0 || unavailable !== null) return;
      if (!canAttach) {
        setImageRefusal(noImagesLine(harnessId));
        return;
      }
      void addImages(workspaceId, files).then(setImageRefusal);
    },
    [addImages, canAttach, harnessId, unavailable, workspaceId],
  );

  const onPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      take(files);
    },
    [take],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      take(files);
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

  const { setSending, appendUserTurn, appendLocalError, resume, thread: into, busy, sending } = thread;
  const start = useCallback(
    (prompt: string, onRefused: () => void) => {
      if (!api) return;
      const requestId = newId();
      const attachments = images.map(attachmentOf);
      setSending(true);
      hold(threadKey);
      appendUserTurn(prompt, requestId, images.map(recordOf));
      // The images leave the composer with the send and are kept under its request id, which is what the person's
      // row in the transcript is drawn from; a refused send hands them back rather than losing them.
      sendImagesAs(workspaceId, requestId);
      setImageRefusal(null);
      // The wake settles or fails before the start is asked; a wake that failed leaves the runtime to refuse the
      // start in its own words, which land in the transcript like any other refusal.
      void (wakesFirst ? wake(workspaceId) : Promise.resolve())
        .then(() =>
          api.startSession({
            workspaceId,
            prompt,
            requestId,
            ...(resume ? { resume } : {}),
            ...(into !== undefined ? { thread: into } : {}),
            ...folderStart,
            ...(attachments.length > 0 ? { attachments } : {}),
            ...startOptions,
          }),
        )
        .catch((err: unknown) => {
          setSending(false);
          onRefused();
          restoreImages(workspaceId, requestId);
          appendLocalError(err instanceof Error ? err.message : String(err));
        });
    },
    [api, appendLocalError, appendUserTurn, folderStart, hold, images, into, restoreImages, resume, sendImagesAs, setSending, startOptions, threadKey, wake, wakesFirst, workspaceId],
  );

  const send = useCallback(() => {
    // The same reading the slot and the send button are already wearing: an Enter that lands here leaves the draft
    // where it was typed and that line standing.
    if (unavailable !== null) return;
    const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
    const prompt = snapshot.value.trim();
    if (prompt === "") return;
    // A command the CLI runs only in its own terminal would come back as not available; the draft stays for editing,
    // and the menu's empty state goes so the line alone speaks.
    const screen = screenCommandTyped(harnessCatalog, prompt);
    if (screen !== null && harnessCatalog !== null) {
      setScreenLine(screenCommandLine(screen, harnessCatalog, workspace ?? {}));
      setImageRefusal(null);
      setDismissedSearchKey(searchKey);
      return;
    }
    // A queued row keeps only its words, so a message with images waits for the turn rather than losing them.
    if (busy && images.length > 0) {
      setImageRefusal(IMAGES_AFTER_TURN);
      return;
    }
    setDraft(workspaceId, EMPTY_DRAFT);
    if (!busy) {
      start(prompt, () => {
        const current = useComposerDraftStore.getState().drafts[workspaceId];
        if (current === undefined || current.prompt === "") setDraft(workspaceId, { prompt, cursor: prompt.length });
      });
      return;
    }
    // Behind a pending send the row waits with the rest, held since that send began; its start releases them.
    if (sending) {
      enqueue(threadKey, prompt);
      return;
    }
    enqueue(threadKey, prompt, held ? "head" : "tail");
    release(threadKey);
  }, [busy, draft, enqueue, harnessCatalog, held, images, release, searchKey, sending, setDraft, start, threadKey, unavailable, workspace, workspaceId]);

  // The head row goes as soon as nothing blocks a send; starting flips busy, so the rest wait for the next end.
  const head = queue[0];
  useEffect(() => {
    if (head === undefined || held || unavailable !== null || busy) return;
    removeQueued(threadKey, head.id);
    const prompt = head.prompt.trim();
    if (prompt !== "") start(prompt, () => requeue(threadKey, head));
  }, [busy, head, held, removeQueued, requeue, start, threadKey, unavailable]);

  const interrupt = useCallback(() => {
    const method = api?.interruptSession;
    if (!method || runningTurn === null || stopTarget === null || stopAttempt?.pending) return;
    const { turnId } = runningTurn;
    setStop({ turnId, pending: true, error: null });
    void method(stopTarget).then(
      outcome => setStop({ turnId, pending: false, error: outcome === "not-found" ? "the runtime does not know this session" : null }),
      (err: unknown) => setStop({ turnId, pending: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }, [api, runningTurn, stopAttempt?.pending, stopTarget]);

  const steer = useCallback(
    (id: string) => {
      release(threadKey);
      promoteQueued(threadKey, id);
      if (!canStop) return;
      if (!canSteer) {
        setSteering(id);
        interrupt();
        return;
      }
      const method = api?.steerSession;
      const row = queue.find(r => r.id === id);
      if (method === undefined || runningTurn === null || stopTarget === null || row === undefined || steerAttempt?.rowId != null) return;
      const { turnId } = runningTurn;
      setSteering(id);
      setSteered({ turnId, rowId: id, error: null });
      void method(stopTarget, row.prompt.trim(), newId()).then(
        outcome => {
          setSteering(null);
          if (outcome === "accepted") removeQueued(threadKey, id);
          // not-running: the turn beat the message, so the row stays at the head and the head effect starts it once the turn ends.
          const error = outcome === "not-found" ? "the runtime does not know this session" : outcome === "unsupported" ? "this harness takes no message mid-turn" : null;
          setSteered(error === null ? null : { turnId, rowId: null, error });
        },
        (err: unknown) => {
          setSteering(null);
          setSteered({ turnId, rowId: null, error: err instanceof Error ? err.message : String(err) });
        },
      );
    },
    [api, canSteer, canStop, interrupt, promoteQueued, queue, release, removeQueued, runningTurn, steerAttempt, stopTarget, threadKey],
  );

  const selectItem = useCallback(
    (item: ComposerCommandItem) => {
      const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
      const active = detectComposerTrigger(snapshot.value, snapshot.cursor);
      if (active === null) return;
      const replacement = `/${item.command.name} `;
      const rangeEnd = snapshot.value[active.rangeEnd] === " " ? active.rangeEnd + 1 : active.rangeEnd;
      const next = replaceTextRange(snapshot.value, active.rangeStart, rangeEnd, replacement);
      setDraft(workspaceId, { prompt: next.text, cursor: next.cursor });
      setHighlightedItemId(null);
      window.requestAnimationFrame(() => editorRef.current?.focusAt(next.cursor));
    },
    [draft, setDraft, workspaceId],
  );

  const onCommandKeyDown = useCallback(
    (key: ComposerCommandKey, event: KeyboardEvent): boolean => {
      if (key === "Escape") {
        if (menuOpen) {
          setDismissedSearchKey(searchKey);
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
      if (key === "Enter") {
        const intent = composerSubmissionIntentForEnter({
          isMobileViewport: false,
          shiftKey: event.shiftKey,
          modifierKey: event.metaKey || event.ctrlKey,
          isDraftThread: false,
        });
        if (intent !== null) {
          send();
          return true;
        }
      }
      return false;
    },
    [activeItemId, highlight, items, menuOpen, searchKey, selectItem, send],
  );

  return (
    <div className="w-full px-3 pt-1.5 pb-4 sm:px-5 sm:pt-2 sm:pb-5" data-chat-composer>
      <div className="mx-auto flex h-5 w-full max-w-3xl items-center px-3" aria-live="polite" data-composer-refusal>
        {line !== null ? (
          <span role="status" className="min-w-0 truncate font-mono text-[11px] leading-5 text-muted-foreground" title={line}>
            {line}
          </span>
        ) : null}
      </div>
      <ComposerQueue
        rows={queue}
        steering={stopAttempt?.error ? null : steering}
        steer={unavailable !== null ? null : canSteer ? "now" : canStop ? "stop" : busy ? null : "now"}
        onEdit={(id, prompt) => editQueued(threadKey, id, prompt)}
        onRemove={id => removeQueued(threadKey, id)}
        onSteer={steer}
      />
      <ComposerSurface.Shell contextStrip>
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
                  data-chat-composer-surface="true"
                  className="rounded-[20px] transition-[background-color] duration-200"
                  onPaste={onPaste}
                  onDrop={onDrop}
                  onDragOver={event => event.preventDefault()}
                >
                  {images.length > 0 ? (
                    <ul aria-label="Images to send" data-composer-images="true" className="flex flex-wrap gap-1.5 px-3 pt-3 sm:px-4">
                      {images.map((image, at) => (
                        <li key={image.id}>
                          <ChatImageThumb
                            image={image}
                            at={at + 1}
                            onRemove={() => {
                              removeImage(workspaceId, image.id);
                              setImageRefusal(null);
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div ref={setMenuAnchor} className="relative px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
                    {menuOpen ? (
                      <ComposerCommandMenuLayer anchor={menuAnchor}>
                        <ComposerCommandMenu
                          items={items}
                          triggerKind={trigger?.kind ?? null}
                          activeItemId={activeItemId}
                          onHighlightedItemChange={highlight}
                          onSelect={selectItem}
                        />
                      </ComposerCommandMenuLayer>
                    ) : null}
                    <ComposerPromptEditor
                      editorRef={editorRef}
                      value={draft.prompt}
                      cursor={draft.cursor}
                      disabled={unavailable !== null}
                      placeholder={composerPlaceholder(catalog)}
                      onChange={onChange}
                      onCommandKeyDown={onCommandKeyDown}
                    />
                  </div>
                  <div
                    data-chat-composer-footer="true"
                    className="flex min-w-0 flex-nowrap items-end justify-between gap-2 overflow-visible px-3 pb-3 sm:gap-0 sm:px-4 sm:pb-4"
                  >
                    <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 flex-wrap items-center gap-1 p-1 ps-3.5">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost-muted"
                        aria-label="Add an image"
                        title={`Add an image: paste, drop or pick one. ${IMAGE_TYPE_WORDS}, at most ${IMAGES_MAX} and ${IMAGE_MAX_WORDS} each.`}
                        disabled={unavailable !== null}
                        onClick={() => pickerRef.current?.click()}
                        data-composer-image-picker="true"
                      >
                        <ImageIcon />
                      </Button>
                      <input
                        ref={pickerRef}
                        type="file"
                        accept={IMAGE_ACCEPT}
                        multiple
                        hidden
                        aria-hidden="true"
                        data-composer-image-input="true"
                        onChange={event => {
                          take([...(event.target.files ?? [])]);
                          event.target.value = "";
                        }}
                      />
                      <ComposerOptionPickers workspaceId={workspaceId} thread={thread} onPickAccess={accessPick.pick} onOtherFolder={openFolderPicker} />
                    </div>
                    <div data-chat-composer-actions="right" className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                      <ComposerPrimaryActions
                        compact={false}
                        pendingAction={null}
                        isRunning={canStop}
                        isInterruptPending={stopAttempt?.pending ?? false}
                        showPlanFollowUpPrompt={false}
                        promptHasText={hasText}
                        isSendBusy={thread.busy}
                        wakesFirst={wakesFirst}
                        sendDisabledReason={sendDisabledReason}
                        isConnecting={false}
                        isEnvironmentUnavailable={false}
                        isPreparingWorktree={false}
                        hasSendableContent={hasText}
                        onPreviousPendingQuestion={noop}
                        onInterrupt={interrupt}
                        onImplementPlanInNewThread={noop}
                      />
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </div>
          </form>
        </ComposerSurface.Host>
        <ComposerCheckoutRow workspaceId={workspaceId} thread={thread} pickerOpen={folderPicker && pickable} onPickerOpenChange={setFolderPicker} />
      </ComposerSurface.Shell>
    </div>
  );
}
