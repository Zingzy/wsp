// SPDX-License-Identifier: AGPL-3.0-only
// The composer under the chat thread: the transplanted prompt editor, slash
// menu and send button over one draft per workspace. Enter starts one turn
// through sessions.start, resumed with the workspace's Claude session unless
// a new thread was requested; a failed send puts the draft back. The editor is
// disabled with the reason while the runtime or the workspace is not live, and
// the banner names whatever blocks a send, a running turn included, so Enter
// never fails silently. It is also disabled while the turn a new thread left
// behind is still finishing: the web client speaks no interrupt yet, so a
// second session must not start until that turn ends. Stop, model and
// permission-mode controls wait for their client methods and start options.
import { CircleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MachineState, WorkspacePhase } from "@wsp/protocol";
import type { ConnStatus } from "../../protocol/client";
import { useStatus, useStore, useWorkspace } from "../../protocol/store";
import { composerSubmissionIntentForEnter, detectComposerTrigger, replaceTextRange } from "../../composer-logic";
import { ComposerPromptEditor, type ComposerCommandKey, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { catalogFromHarness } from "./adapt";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";
import { EMPTY_DRAFT, useComposerDraft, useComposerDraftStore } from "./composerDraftStore";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
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
  hydrated: boolean;
  finishing: boolean;
}): string | null {
  if (!input.hasApi || input.conn === "connecting") return "Connecting to wsp";
  if (input.conn === "reconnecting") return "wsp is not running, reconnecting";
  if (input.conn === "closed") return "wsp is not running";
  if (input.phase === null) return "Workspace not found";
  if (input.machineState === "gone") return "Workspace machine is gone";
  if (input.phase === "napping") return "Workspace is napping; wake it to send";
  if (input.phase === "waking") return "Workspace is waking";
  if (!input.hydrated) return "Loading transcript";
  if (input.finishing) return "Finishing the previous turn";
  return null;
}

export function ChatComposer({ workspaceId, thread }: { workspaceId: string; thread: ChatThreadHandle }) {
  const api = useStore(s => s.api);
  const conn = useStore(s => s.conn);
  const workspace = useWorkspace(workspaceId);
  const status = useStatus(workspaceId);
  const draft = useComposerDraft(workspaceId);
  const setDraft = useComposerDraftStore(s => s.setDraft);
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const [highlightedSearchKey, setHighlightedSearchKey] = useState<string | null>(null);
  const [dismissedSearchKey, setDismissedSearchKey] = useState<string | null>(null);

  const unavailable = composerUnavailableReason({
    conn,
    hasApi: api !== null,
    phase: workspace?.phase ?? null,
    machineState: status?.machineState ?? null,
    hydrated: thread.hydrated,
    finishing: thread.finishing,
  });
  const sendDisabledReason = unavailable ?? (thread.busy ? "Turn in flight" : null);
  const hasText = draft.prompt.trim().length > 0;

  const trigger = useMemo(() => detectComposerTrigger(draft.prompt, draft.cursor), [draft]);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const menuOpen = trigger !== null && trigger.rangeStart === 0 && dismissedSearchKey !== searchKey && unavailable === null;
  const { harness, model } = thread.view;
  const catalog = useMemo(() => catalogFromHarness({ harness, model }), [harness, model]);
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

  const send = useCallback(() => {
    if (!api || sendDisabledReason !== null) return;
    const snapshot = editorRef.current?.readSnapshot() ?? { value: draft.prompt, cursor: draft.cursor };
    const prompt = snapshot.value.trim();
    if (prompt === "") return;
    setDraft(workspaceId, EMPTY_DRAFT);
    thread.setSending(true);
    thread.appendUserTurn(prompt);
    const resume = thread.fresh ? undefined : workspace?.claudeSessionId;
    void api.startSession({ workspaceId, prompt, ...(resume ? { resume } : {}) }).catch((err: unknown) => {
      thread.setSending(false);
      const current = useComposerDraftStore.getState().drafts[workspaceId];
      if (current === undefined || current.prompt === "") setDraft(workspaceId, { prompt, cursor: prompt.length });
      thread.appendLocalError(err instanceof Error ? err.message : String(err));
    });
  }, [api, draft, sendDisabledReason, setDraft, thread, workspace?.claudeSessionId, workspaceId]);

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
      <ComposerSurface.Shell>
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
                {sendDisabledReason !== null ? (
                  <ComposerBanner.Attachment>
                    <ComposerBanner.Root variant="warning" role="status">
                      <ComposerBanner.Row>
                        <ComposerBanner.Icon>
                          <CircleAlertIcon />
                        </ComposerBanner.Icon>
                        <ComposerBanner.Content>
                          <span className="truncate">{sendDisabledReason}</span>
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
                    <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" />
                    <div data-chat-composer-actions="right" className="flex shrink-0 flex-nowrap items-center justify-end gap-2">
                      <ComposerPrimaryActions
                        compact={false}
                        pendingAction={null}
                        isRunning={false}
                        showPlanFollowUpPrompt={false}
                        promptHasText={hasText}
                        isSendBusy={thread.busy}
                        sendDisabledReason={sendDisabledReason}
                        isConnecting={false}
                        isEnvironmentUnavailable={false}
                        isPreparingWorktree={false}
                        hasSendableContent={hasText}
                        onPreviousPendingQuestion={noop}
                        onInterrupt={noop}
                        onImplementPlanInNewThread={noop}
                      />
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </div>
          </form>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
