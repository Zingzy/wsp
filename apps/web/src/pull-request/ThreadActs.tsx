// SPDX-License-Identifier: AGPL-3.0-only
// What the person does on a thread from the pane, as themselves through the signed-in gh: a reply field under a
// thread or a comment (Send, Cancel, Cmd or Ctrl Enter), and reactions, GitHub's eight behind one add button with
// the used ones as chips under the body and the person's own marked.
import { SmilePlusIcon } from "lucide-react";
import { useState } from "react";
import { isCommentSubmitShortcut } from "../components/diffs/commentSubmitShortcut.js";
import { Button } from "../components/ui/button.js";
import { Kbd } from "../components/ui/kbd.js";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover.js";
import { Textarea } from "../components/ui/textarea.js";
import type { PullRequestReaction, ReactionContent } from "@wsp/protocol";
import { cn, isMacPlatform } from "../lib/utils.js";
import { failureOf } from "../protocol/failure.js";
import { PR_WORDS } from "./words.js";

/** GitHub's eight reactions, in the order its picker shows them, each with the emoji it draws and its name. */
export const REACTIONS: readonly { content: ReactionContent; emoji: string; label: string }[] = [
  { content: "+1", emoji: "👍", label: "Thumbs up" },
  { content: "-1", emoji: "👎", label: "Thumbs down" },
  { content: "laugh", emoji: "😄", label: "Laugh" },
  { content: "hooray", emoji: "🎉", label: "Hooray" },
  { content: "confused", emoji: "😕", label: "Confused" },
  { content: "heart", emoji: "❤️", label: "Heart" },
  { content: "rocket", emoji: "🚀", label: "Rocket" },
  { content: "eyes", emoji: "👀", label: "Eyes" },
];

const emojiOf = (content: ReactionContent): string => REACTIONS.find(r => r.content === content)?.emoji ?? content;
const labelOf = (content: ReactionContent): string => REACTIONS.find(r => r.content === content)?.label ?? content;

/** A 24 px pill a small act takes: the box's own button at the reply field's size. */
const XS = "h-6 gap-1 rounded-md px-2 text-xs font-medium";

/** The field a reply is written in, the text kept and the refusal said under it when a send is refused. */
export function ReplyField({ to, onSend, onCancel }: { to: string; onSend: (body: string) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const send = (): void => {
    const body = text.trim();
    if (body === "" || sending) return;
    setSending(true);
    setRefusal(null);
    onSend(body).then(
      () => setSending(false),
      (e: unknown) => {
        setSending(false);
        setRefusal(failureOf(e).said);
      },
    );
  };
  const mod = typeof navigator !== "undefined" && isMacPlatform(navigator.platform) ? "⌘" : "Ctrl";
  return (
    <div data-pr-reply className="flex flex-col gap-1.5">
      <div className="overflow-hidden rounded-lg border border-border bg-background">
        <Textarea
          unstyled
          autoFocus
          aria-label={PR_WORDS.replyTo(to)}
          placeholder={PR_WORDS.replyTo(to)}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
            if (isCommentSubmitShortcut(e, text, sending)) {
              e.preventDefault();
              send();
            }
          }}
          className="flex w-full [&_[data-slot=textarea]]:min-h-[52px] [&_[data-slot=textarea]]:resize-none [&_[data-slot=textarea]]:px-2.5 [&_[data-slot=textarea]]:py-2 [&_[data-slot=textarea]]:text-[13.5px] [&_[data-slot=textarea]]:leading-normal [&_[data-slot=textarea]]:text-foreground"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          <Kbd className="mr-auto h-auto rounded border border-border bg-transparent px-[5px] py-px text-[11px]">{`${mod} Enter`}</Kbd>
          <Button type="button" variant="ghost" className={XS} data-pr-reply-cancel onClick={onCancel}>
            {PR_WORDS.cancel}
          </Button>
          <Button type="button" className={XS} data-pr-reply-send disabled={text.trim() === "" || sending} onClick={send}>
            {PR_WORDS.send}
          </Button>
        </div>
      </div>
      {refusal === null ? null : (
        <p data-pr-reply-refusal className="text-[13px] text-error-foreground">
          {refusal}
        </p>
      )}
    </div>
  );
}

/** The add button and its eight: a 24 px icon in an item's head, shown on the item's hover beside the send. */
export function ReactAdd({ reactions, onToggle }: { reactions: readonly PullRequestReaction[]; onToggle: (content: ReactionContent) => void }) {
  const [open, setOpen] = useState(false);
  const mine = (content: ReactionContent): boolean => reactions.some(x => x.content === content && x.mine);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-pr-react-add
        aria-label={PR_WORDS.addReaction}
        className={cn(
          "ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center self-center rounded-md text-muted-foreground transition-[opacity,color,background-color] duration-150 hover:bg-accent hover:text-foreground focus-visible:opacity-100",
          open ? "opacity-100" : "opacity-0 group-hover/ev:opacity-100 group-hover/comment:opacity-100",
        )}
      >
        <SmilePlusIcon aria-hidden className="size-[13px]" />
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" viewportClassName="py-1 [--viewport-inline-padding:--spacing(1)]">
        <div data-pr-react-picker className="flex gap-0.5">
          {REACTIONS.map(r => (
            <button
              key={r.content}
              type="button"
              data-pr-react-pick={r.content}
              aria-label={r.label}
              aria-pressed={mine(r.content)}
              onClick={() => {
                setOpen(false);
                onToggle(r.content);
              }}
              className={cn("grid size-8 cursor-pointer place-items-center rounded-md text-base transition-colors duration-150 hover:bg-accent", mine(r.content) && "bg-primary/[0.08]")}
            >
              {r.emoji}
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** The used reactions as chips under an item's body, the person's own marked; a press toggles the person's own. An
 * item nobody reacted to draws no row. */
export function Reactions({ reactions, onToggle, k }: { reactions: readonly PullRequestReaction[]; onToggle?: ((content: ReactionContent) => void) | undefined; k: string }) {
  const used = reactions.filter(r => r.count > 0);
  if (used.length === 0) return null;
  return (
    <div data-pr-reactions={k} className="mt-2 flex flex-wrap items-center gap-1.5">
      {used.map(r => {
        const chip = cn("inline-flex h-[22px] items-center gap-[5px] rounded-[11px] border px-2 text-xs", r.mine ? "border-primary/45 bg-primary/[0.08] text-foreground" : "border-border text-muted-foreground");
        const face = (
          <>
            <span aria-hidden>{emojiOf(r.content)}</span>
            <b className="font-mono text-[11px] font-medium">{r.count}</b>
          </>
        );
        const name = `${labelOf(r.content)}, ${r.count}`;
        return onToggle === undefined ? (
          <span key={r.content} data-pr-reaction={r.content} data-mine={r.mine || undefined} aria-label={name} className={chip}>
            {face}
          </span>
        ) : (
          <button key={r.content} type="button" data-pr-reaction={r.content} data-mine={r.mine || undefined} aria-label={name} aria-pressed={r.mine} onClick={() => onToggle(r.content)} className={cn(chip, "cursor-pointer transition-colors duration-150", !r.mine && "hover:bg-accent")}>
            {face}
          </button>
        );
      })}
    </div>
  );
}
