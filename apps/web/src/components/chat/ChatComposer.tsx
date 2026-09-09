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
// while the runtime or the workspace is not live, and the same line, one
// muted mono sentence in a slot that is laid out whether or not it holds one,
// names whatever blocks a send, so Enter never fails silently. A running turn
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
// and holds each to one turn, so the fresh composer opens at once. The
// checkout row under the composer picks the folder a fresh thread starts in;
// a resumed one is started where its harness last said it was. The model,
// effort, context window and access picks in the box's footer ride every
// start, so a change mid-thread applies at the next turn.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ClipboardEvent } from "react";
import { ImageIcon } from "lucide-react";
import { IMAGES_AFTER_TURN, IMAGES_MAX, IMAGE_ACCEPT, IMAGE_MAX_WORDS, IMAGE_TYPE_WORDS, TURN_IN_FLIGHT, noImagesLine, readsImages, sendNowFailedLine, sendRefusal, stillWorkingRefusal, stopFailedLine, type SendRefusalKind, type WorkspaceState } from "@wsp/protocol";
import type { ConnStatus } from "../../protocol/client";
import { useStore, useWorkspaceState } from "../../protocol/store";
import { onComposerFocusRequest } from "../../shell/shellRequests";
import { useThreadStart } from "../../files/root";
import { composerSubmissionIntentForEnter, detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerCommandKey, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { catalogFromHarness } from "./adapt";
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

const PLACEHOLDER = "Ask anything, or / for commands";
const noop = () => {};

/** What blocks a send right now, or null; the refusal table gives its words. The socket comes first: with it down
 * every other reading is stale, and a state the app has no workspace for at all is one it cannot name. */
export function composerSendBlock(input: {
  conn: ConnStatus;
  hasApi: boolean;
  state: WorkspaceState | null;
  hydrated: boolean;
}): SendRefusalKind | null {
  if (!input.hasApi || input.conn === "connecting") return "connecting";
  if (input.conn === "reconnecting") return "reconnecting";
  if (input.conn === "closed") return "closed";
  if (input.state === null) return "not-found";
  if (input.state !== "running") return input.state;
  if (!input.hydrated) return "loading";
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
  const conn = useStore(s => s.conn);
  const sessions = useStore(s => s.sessions[workspaceId]);
  const state = useWorkspaceState(workspaceId);
  const [stop, setStop] = useState<StopAttempt | null>(null);
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

  const blocked = composerSendBlock({ conn, hasApi: api !== null, state, hydrated: thread.hydrated });
  const unavailable = blocked === null ? null : sendRefusal(blocked);
  const sendDisabledReason = unavailable ?? (thread.busy ? TURN_IN_FLIGHT : null);
  const hasText = draft.prompt.trim().length > 0;
  // The catalog answers before the click; a row the runtime's table stood in for is no answer, so the picker is
  // offered and the runtime refuses in the agent's name if that binary turns out to read none.
  const canAttach = readsImages(harnessCatalog);

  const runningTurn = thread.view.running ? thread.view.latestTurn : null;
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
  const accessPick = useAccessPick(workspaceId, pickTarget);
  const stopAttempt = stop !== null && runningTurn !== null && stop.turnId === runningTurn.turnId ? stop : null;
  const steerAttempt = steered !== null && runningTurn !== null && steered.turnId === runningTurn.turnId ? steered : null;
  const canStop = runningTurn !== null && api?.interruptSession !== undefined;
  // The catalog answers before the click: a harness that steers takes the row into the turn, any other gets the turn stopped.
  const canSteer = canStop && harnessCatalog?.steers === true && api?.steerSession !== undefined;
  // One line in the slot above the box: the newest failure, else what blocks a send, else the turn that replied but
  // still runs, in the runtime's own words, since no new turn can start until its process exits, else an access pick
  // the running turn's harness would not take mid-turn.
  const line =
    imageRefusal !== null
      ? imageRefusal
      : stopAttempt !== null && stopAttempt.error !== null
      ? stopFailedLine(stopAttempt.error)
      : steerAttempt !== null && steerAttempt.error !== null
        ? sendNowFailedLine(steerAttempt.error)
        : unavailable !== null
          ? unavailable
          : runningTurn?.replied === true
            ? stillWorkingRefusal(threadKey)
            : accessPick.line;

  const trigger = useMemo(() => detectComposerTrigger(draft.prompt, draft.cursor), [draft]);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const menuOpen = trigger !== null && trigger.rangeStart === 0 && dismissedSearchKey !== searchKey && unavailable === null;
  const { harness } = thread.view;
  const catalog = useMemo(() => catalogFromHarness({ id: harnessId, harness }), [harnessId, harness]);
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

  const onChange = useCallback((value: string, cursor: number) => setDraft(workspaceId, { prompt: value, cursor }), [setDraft, workspaceId]);

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
      void api
        .startSession({
          workspaceId,
          prompt,
          requestId,
          ...(resume ? { resume } : {}),
          ...(into !== undefined ? { thread: into } : {}),
          ...folderStart,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...startOptions,
        })
        .catch((err: unknown) => {
          setSending(false);
          onRefused();
          restoreImages(workspaceId, requestId);
          appendLocalError(err instanceof Error ? err.message : String(err));
        });
    },
    [api, appendLocalError, appendUserTurn, folderStart, hold, images, into, restoreImages, resume, sendImagesAs, setSending, startOptions, threadKey, workspaceId],
  );

  const send = useCallback(() => {
    if (unavailable !== null) return;
    const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
    const prompt = snapshot.value.trim();
    if (prompt === "") return;
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
  }, [busy, draft, enqueue, held, images, release, sending, setDraft, start, threadKey, unavailable, workspaceId]);

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
                      placeholder={PLACEHOLDER}
                      onChange={onChange}
                      onCommandKeyDown={onCommandKeyDown}
                    />
                  </div>
                  <div
                    data-chat-composer-footer="true"
                    className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:gap-0 sm:px-4 sm:pb-4"
                  >
                    <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
