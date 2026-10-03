// SPDX-License-Identifier: AGPL-3.0-only
// The one confirmation before a thread is rewound to an earlier reply or a
// rewind is undone. It says in the note slot what goes before the click, asks
// the host once, and shows the host's refusal in that same slot, so nothing
// moves when one arrives. Mounted once for the whole window: the reply's
// button and the thread's menu both ask for it through a shell request.
import { useEffect, useState } from "react";
import { UNDO_REWIND_LINE, rewindNote } from "@wsp/protocol";
import { errorText } from "../../lib/utils.js";
import { useStore } from "../../protocol/store.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { onRewindRequest, type RewindRequest } from "../../shell/shellRequests.js";
import { AlertDialog, AlertDialogClose, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../ui/alert-dialog.js";
import { Button, NEUTRAL_RING } from "../ui/button.js";
import { Radio, RadioGroup } from "../ui/radio-group.js";

/** What a client that cannot rewind says in the slot instead of asking. */
const CANNOT_REWIND = "This window cannot rewind a thread.";

/** The host's lines are lowercase for the terminal; in the app a refusal reads as a sentence. */
export const asSentence = (line: string): string => `${line.charAt(0).toUpperCase()}${line.slice(1)}${/[.!?]$/.test(line) ? "" : "."}`;

type Choice = "conversation" | "files";

export function RewindDialogHost() {
  const api = useStore(s => s.api);
  const [request, setRequest] = useState<RewindRequest | null>(null);
  // The conversation alone is where a rewind starts: the files stay as the person sees them unless they choose.
  const [choice, setChoice] = useState<Choice>("conversation");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(
    () =>
      onRewindRequest(next => {
        setRequest(next);
        setChoice("conversation");
        setRefusal(null);
      }),
    [],
  );

  const close = (): void => {
    setRequest(null);
    setRefusal(null);
  };

  if (request === null) return null;
  const rewinding = request.kind === "rewind" ? request : null;
  // An agent that keeps its own history is rewound in its files alone, so there is nothing to choose.
  const files = rewinding !== null && (!rewinding.cutsConversation || choice === "files");

  const go = async (): Promise<void> => {
    const ask = rewinding === null ? api?.undoRewind?.bind(api, request.threadId) : api?.rewindThread?.bind(api, request.threadId, rewinding.turnId, files);
    if (ask === undefined) {
      setRefusal(CANNOT_REWIND);
      return;
    }
    setBusy(true);
    setRefusal(null);
    try {
      await ask();
      close();
    } catch (e) {
      setRefusal(asSentence(errorText(e)));
    } finally {
      setBusy(false);
    }
  };

  const note = rewinding === null ? UNDO_REWIND_LINE : rewindNote({ turns: rewinding.turnsAfter, files, cutsConversation: rewinding.cutsConversation, agent: rewinding.agent, ...(rewinding.kept !== undefined ? { kept: rewinding.kept } : {}) });
  return (
    <AlertDialog open onOpenChange={next => (next ? undefined : close())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{rewinding === null ? "Undo rewind?" : "Rewind to here?"}</AlertDialogTitle>
        </AlertDialogHeader>
        {rewinding !== null && rewinding.cutsConversation ? (
          <RadioGroup value={choice} onValueChange={value => setChoice(value as Choice)} aria-label="What goes back" className="gap-0 px-5">
            <ChoiceLine value="conversation" label="Conversation only" />
            <ChoiceLine value="files" label="Conversation and files" disabled={!rewinding.files} />
          </RadioGroup>
        ) : null}
        <div className="px-5 pt-2">
          <RefusalSlot k="rewind-refusal" {...(refusal !== null ? { said: refusal } : { note })} />
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>Cancel</AlertDialogClose>
          <Button disabled={busy} onClick={() => void go()} data-k="rewind-confirm">
            {rewinding === null ? "Undo rewind" : "Rewind"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** One of the dialog's 44px lines: the radio and its words, the whole line a press target. */
function ChoiceLine({ value, label, disabled = false }: { value: Choice; label: string; disabled?: boolean }) {
  return (
    <label className="flex h-11 cursor-pointer items-center gap-3 text-sm text-foreground has-data-disabled:cursor-default has-data-disabled:opacity-64">
      <Radio value={value} disabled={disabled} />
      <span>{label}</span>
    </label>
  );
}

/** One reply Rewind to here stands on, and what the dialog for it says. */
export interface RewindableReply {
  readonly turnId: string;
  readonly turnsAfter: number;
  readonly files: boolean;
  /** Why the agent cannot cut this thread's conversation, where it said so: the reply offers its files alone. */
  readonly kept?: string;
}

/** The replies of a thread's earlier turns a rewind can go back to, by the message the button stands under: each such
 * turn's last reply, where the turn is over and kept something to rewind to (the files' checkpoint, or its anchor on
 * an agent that cuts its own history, or any reply on an agent the host cuts by count). A thread its agent said it
 * cannot cut offers the files alone. The latest turn has nothing after it to cut. */
export function rewindableReplies(
  turns: ReadonlyArray<{ readonly turnId: string; readonly state: string; readonly checkpoint: { readonly ref: string | null; readonly anchor: string | null; readonly kept?: string } | null }>,
  entries: ReadonlyArray<{ readonly kind: string; readonly message?: { readonly id: string; readonly role: string; readonly turnId: string | null } }>,
  cutsConversation: boolean,
  byCount = false,
): ReadonlyMap<string, RewindableReply> {
  const lastReply = new Map<string, string>();
  for (const entry of entries) if (entry.kind === "message" && entry.message?.role === "assistant" && entry.message.turnId !== null) lastReply.set(entry.message.turnId, entry.message.id);
  const kept = turns.find(t => t.checkpoint?.kept !== undefined)?.checkpoint?.kept;
  const out = new Map<string, RewindableReply>();
  turns.forEach((turn, at) => {
    if (at === turns.length - 1 || turn.state === "running") return;
    const files = (turn.checkpoint?.ref ?? null) !== null;
    const cuts = kept === undefined && cutsConversation && ((turn.checkpoint?.anchor ?? null) !== null || byCount);
    if (!files && !cuts) return;
    const reply = lastReply.get(turn.turnId);
    if (reply !== undefined) out.set(reply, { turnId: turn.turnId, turnsAfter: turns.length - 1 - at, files, ...(kept !== undefined ? { kept } : {}) });
  });
  return out;
}
