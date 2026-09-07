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
// show in the status row. The editor is disabled with the reason while the
// runtime or the workspace is not live, and the banner names whatever blocks
// a send, so Enter never fails silently. A running turn blocks nothing: Enter
// then queues the message under the thread's key in the draft store, the rows
// stack above the box, and when the turn ends the head row starts the next
// turn; a fresh thread's rows wait under the workspace id until its own first
// start names it, then move under that id, whichever thread is on screen when
// that start lands. Every send holds the thread's rows
// until its start lands, so a start the runtime refuses or a harness that
// dies before init drains nothing behind it. Rows read back from storage are
// held too. Held rows go only after the person's next Enter or send-now here,
// never on their own, and a row typed during a turn goes ahead of the held
// ones it releases. Send-now on a row puts it at the head; when the harness's
// catalog says it steers, the row goes into the running turn through
// sessions.steer and leaves the queue once the runtime took it (the thread
// shows it from the session.steer event), while not-running leaves it at the
// head for the turn's end. A harness that does not steer gets the turn stopped
// first, with the one-line notice. The editor is also
// disabled while the turn a new thread left behind is still finishing: stop
// reaches only the visible turn, so a second session must not start until
// that one ends. The checkout row under the composer picks the folder a fresh
// thread starts in; a resumed one is started where its harness last said it
// was. The model, effort, context window and access picks in the box's
// footer ride every start, so a change mid-thread applies at the next turn.
import { CircleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sendRefusal, stillWorkingRefusal, workspaceState, type MachineState, type ReachState, type WorkspacePhase } from "@wsp/protocol";
import type { ConnStatus } from "../../protocol/client";
import { useStatus, useStore, useWorkspace } from "../../protocol/store";
import { useThreadFolder } from "../../files/root";
import { composerSubmissionIntentForEnter, detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerCommandKey, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { catalogFromHarness } from "./adapt";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerCheckoutRow } from "./ComposerCheckoutRow";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { EMPTY_DRAFT, newId, useComposerDraft, useComposerDraftStore, useComposerQueue, useComposerQueueHeld } from "./composerDraftStore";
import { ComposerOptionPickers, useComposerPicks } from "./ComposerOptionPickers";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerQueue } from "./ComposerQueue";
import { searchSlashCommandItems, slashCommandItemsForPromptPosition } from "./composerSlashCommandSearch";
import { ComposerSurface } from "./ComposerSurface";
import type { ChatThreadHandle } from "./useChatThread";

const PLACEHOLDER = "Ask anything, or / for commands";
const noop = () => {};

/** Why nothing can be sent right now, or null. The socket comes first: with it down every other reading is stale. */
export function composerUnavailableReason(input: {
  conn: ConnStatus;
  hasApi: boolean;
  phase: WorkspacePhase | null;
  machineState: MachineState | null;
  reach: ReachState | null;
  hydrated: boolean;
  finishing: boolean;
}): string | null {
  if (!input.hasApi || input.conn === "connecting") return "Connecting to wsp";
  if (input.conn === "reconnecting") return "wsp is not running, reconnecting";
  if (input.conn === "closed") return "wsp is not running";
  if (input.phase === null) return "Workspace not found";
  const refusal = sendRefusal(workspaceState({ phase: input.phase, machineState: input.machineState, reach: input.reach }));
  if (refusal !== null) return refusal;
  if (!input.hydrated) return "Loading transcript";
  if (input.finishing) return "Finishing the previous turn";
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
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  const [stop, setStop] = useState<StopAttempt | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const [steered, setSteered] = useState<SteerAttempt | null>(null);
  const draft = useComposerDraft(workspaceId);
  const { threadKey, named } = thread;
  const queue = useComposerQueue(threadKey);
  const held = useComposerQueueHeld(threadKey);
  const cwd = useThreadFolder(workspaceId);
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
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);
  const [dismissedSearchKey, setDismissedSearchKey] = useState<string | null>(null);

  const unavailable = composerUnavailableReason({
    conn,
    hasApi: api !== null,
    phase: status?.phase ?? workspace?.phase ?? null,
    machineState: status?.machineState ?? null,
    reach: status?.reach.state ?? null,
    hydrated: thread.hydrated,
    finishing: thread.finishing,
  });
  const sendDisabledReason = unavailable ?? (thread.busy ? "Turn in flight" : null);
  const hasText = draft.prompt.trim().length > 0;

  const runningTurn = thread.view.running ? thread.view.latestTurn : null;
  // The reply is in but the process still runs: no new turn can start until it exits, and the note says so in the
  // runtime's own words, the sentence its refusal of a send would carry.
  const stillWorking = runningTurn?.replied === true ? stillWorkingRefusal(threadKey) : null;
  // The runtime keys sessions.interrupt by its own session id; the events carry the harness id, which differs after a
  // resume, so the row from sessions.list maps one to the other. Without a row the events' id goes, and the runtime answers.
  const stopTarget = useMemo(() => {
    if (runningTurn === null) return null;
    const row = sessions?.find(r => r.claudeSessionId === runningTurn.sessionId || r.id === runningTurn.sessionId);
    return row?.id ?? runningTurn.sessionId;
  }, [runningTurn, sessions]);
  const stopAttempt = stop !== null && runningTurn !== null && stop.turnId === runningTurn.turnId ? stop : null;
  const steerAttempt = steered !== null && runningTurn !== null && steered.turnId === runningTurn.turnId ? steered : null;
  const canStop = runningTurn !== null && api?.interruptSession !== undefined;
  // The catalog answers before the click: a harness that steers takes the row into the turn, any other gets the turn stopped.
  const canSteer = canStop && harnessCatalog?.steers === true && api?.steerSession !== undefined;
  const banner =
    stopAttempt !== null && stopAttempt.error !== null
      ? { text: `Could not stop: ${stopAttempt.error}`, variant: "error" as const }
      : steerAttempt !== null && steerAttempt.error !== null
        ? { text: `Could not send now: ${steerAttempt.error}`, variant: "error" as const }
        : unavailable !== null
          ? { text: unavailable, variant: "warning" as const }
          : null;

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
    if (thread.fresh && !thread.finishing) editorRef.current?.focus();
  }, [thread.fresh, thread.finishing]);

  const onChange = useCallback((value: string, cursor: number) => setDraft(workspaceId, { prompt: value, cursor }), [setDraft, workspaceId]);

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
      setSending(true);
      hold(threadKey);
      appendUserTurn(prompt, requestId);
      void api
        .startSession({ workspaceId, prompt, requestId, ...(resume ? { resume } : {}), ...(into !== undefined ? { thread: into } : {}), ...(cwd !== null ? { cwd } : {}), ...startOptions })
        .catch((err: unknown) => {
          setSending(false);
          onRefused();
          appendLocalError(err instanceof Error ? err.message : String(err));
        });
    },
    [api, appendLocalError, appendUserTurn, cwd, hold, into, resume, setSending, startOptions, threadKey, workspaceId],
  );

  const send = useCallback(() => {
    if (unavailable !== null) return;
    const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
    const prompt = snapshot.value.trim();
    if (prompt === "") return;
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
  }, [busy, draft, enqueue, held, release, sending, setDraft, start, threadKey, unavailable, workspaceId]);

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
    <div className="w-full px-3 pt-1.5 pb-4 sm:px-5 sm:pt-2 sm:pb-5">
      {thread.view.running ? (
        <div className="mx-auto flex h-5 w-full max-w-3xl items-center px-3" aria-live="polite" data-composer-turn-note>
          {stillWorking !== null ? <span className="min-w-0 truncate font-mono text-[11px] leading-5 text-muted-foreground">{stillWorking}</span> : null}
        </div>
      ) : null}
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
            <ComposerBanner.Dock>
              <ComposerBanner.Column>
                {banner !== null ? (
                  <ComposerBanner.Attachment>
                    <ComposerBanner.Root variant={banner.variant} role="status">
                      <ComposerBanner.Row>
                        <ComposerBanner.Icon>
                          <CircleAlertIcon />
                        </ComposerBanner.Icon>
                        <ComposerBanner.Content>
                          <span className="truncate">{banner.text}</span>
                        </ComposerBanner.Content>
                      </ComposerBanner.Row>
                    </ComposerBanner.Root>
                  </ComposerBanner.Attachment>
                ) : null}
              </ComposerBanner.Column>
            </ComposerBanner.Dock>
            <div className="relative">
              <ComposerSurface.Main>
                <div data-chat-composer-surface="true" className="rounded-[20px] transition-[background-color] duration-200">
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
                      <ComposerOptionPickers workspaceId={workspaceId} thread={thread} />
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
        <ComposerCheckoutRow workspaceId={workspaceId} thread={thread} />
      </ComposerSurface.Shell>
    </div>
  );
}
