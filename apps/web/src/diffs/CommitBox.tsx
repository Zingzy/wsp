// SPDX-License-Identifier: AGPL-3.0-only
// The box a commit is written in, under the Changes pane's header: the message, filled from the workspace's own
// agent's draft or left empty with the line saying why, the one line said while that agent still works in the copy,
// and the commit itself, held until there is a message and a file ticked. The files are ticked in the tree above it.
import { Button } from "../components/ui/button.js";
import { Spinner } from "../components/ui/spinner.js";
import { Textarea } from "../components/ui/textarea.js";
import { COMMIT_WORDS } from "./words.js";

export interface CommitDraftState {
  readonly message: string;
  readonly drafting: boolean;
  readonly note: string | null;
  readonly ticked: ReadonlySet<string>;
  readonly busy: boolean;
  readonly error: string | null;
}

export function CommitBox({ state, working, onMessage, onCommit, onCancel }: { state: CommitDraftState; working: boolean; onMessage: (message: string) => void; onCommit: () => void; onCancel: () => void }) {
  const held = state.busy || state.drafting || state.message.trim() === "" || state.ticked.size === 0;
  const said = state.drafting || state.error !== null || state.note !== null || working;
  return (
    <div data-commit-box className="flex shrink-0 flex-col gap-2 border-b border-border/60 px-3 py-2.5">
      <Textarea
        aria-label={COMMIT_WORDS.field}
        placeholder={COMMIT_WORDS.field}
        value={state.message}
        disabled={state.busy}
        onChange={event => onMessage(event.target.value)}
        className="min-h-24 font-mono text-[12px]"
      />
      {said ? (
        <div className="flex min-h-5 items-center gap-3 text-[12px] leading-4 text-muted-foreground">
          {state.drafting ? (
            <span className="flex items-center gap-1.5" role="status">
              <Spinner className="size-3.5" />
              {COMMIT_WORDS.drafting}
            </span>
          ) : state.error !== null ? (
            <span className="text-destructive-foreground" role="alert">
              {state.error}
            </span>
          ) : state.note !== null ? (
            <span>{state.note}</span>
          ) : null}
          {working ? <span data-commit-working>{COMMIT_WORDS.agentWorking}</span> : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onCancel} disabled={state.busy}>
          {COMMIT_WORDS.cancel}
        </Button>
        <Button type="button" size="xs" onClick={onCommit} disabled={held}>
          {COMMIT_WORDS.button}
        </Button>
      </div>
    </div>
  );
}
