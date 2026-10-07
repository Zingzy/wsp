// SPDX-License-Identifier: AGPL-3.0-only
// The three pieces both Add a computer and Connect a provider are drawn from:
// a row holding one fact with the glyph that copies it, the running list of
// what a road has done so far, and the two-line slot a refusal lands in. The
// slot stands whether or not it holds a sentence, so a refusal arriving moves
// nothing on the screen under it.
import { CheckIcon, CopyIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { copyText } from "../actions/clipboard.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { Spinner } from "../components/ui/spinner.js";
import { GROUP_LABEL } from "../lib/microLabel.js";
import { cn } from "../lib/utils.js";
import { noticeFailure, notCopied } from "../notices/store.js";
import { failureOf } from "../protocol/failure.js";
import { SETTINGS_WORDS } from "./format.js";
import { STATE_WORD } from "./recipe/rows.js";

/** How long the copy glyph stands as a check before it is a copy glyph again. */
const COPIED_MS = 1_400;

/** The mask that fades a copy line's right edge while more of it waits past the box. */
const MORE_TO_SCROLL = "[mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]";

/** Whether a line runs past its box and is not scrolled to its end, read again on every scroll and resize. */
function useMoreToScroll(value: string): { ref: RefObject<HTMLSpanElement | null>; more: boolean; measure: () => void } {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = (): void => {
    const el = ref.current;
    if (el !== null) setMore(el.scrollWidth > el.clientWidth && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  useLayoutEffect(() => {
    const el = ref.current;
    measure();
    if (el === null || typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [value]);
  return { ref, more, measure };
}

/** How wide a copy row's label column stands, so the values under each other line up whatever their labels are:
 * wide enough for ADDRESS, the longest, at 11 px caps with the tracking the label wears. */
const LABEL_WIDTH = "w-14";

function useCopy(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void copyText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), COPIED_MS);
      },
      (e: unknown) => noticeFailure(e, notCopied),
    );
  };
  return { copied, copy };
}

/** A device code a person types on a sign-in page: the code in large mono and the button that copies it. The
 * button keeps its word and turns only its glyph, so nothing beside it moves. */
export function DeviceCode({ code }: { code: string }) {
  const { copied, copy } = useCopy(code);
  return (
    <>
      <span data-k="sign-in-code" className="font-mono text-xl text-foreground tabular-nums">
        {code}
      </span>
      <Button size="xs" variant="outline" data-k="copy-code" onClick={copy}>
        {copied ? <CheckIcon aria-hidden className="size-3.5" /> : <CopyIcon aria-hidden className="size-3.5" />}
        Copy
      </Button>
    </>
  );
}

/** A fact somebody has to type on another computer: its label in a fixed column, the fact in mono, and the glyph
 * that copies it. The fact is one run of text that scrolls sideways in its own box, since a line broken or cut is
 * not the line a person pastes. */
export function CopyRow({ label, value, k, children }: { label?: string; value: string; k: string; children?: ReactNode }) {
  const { copied, copy } = useCopy(value);
  const scroll = useMoreToScroll(value);
  return (
    <div data-copy-row={k} className="flex h-10 w-full items-center gap-3 rounded-md border border-border bg-(--input-fill) px-3">
      {label === undefined ? null : (
        <span className={cn(LABEL_WIDTH, GROUP_LABEL, "shrink-0 text-muted-foreground")}>{label}</span>
      )}
      {/* The name is on the value, not the row: a reader after the fact alone must not also get the label. */}
      <span
        ref={scroll.ref}
        data-k={k}
        onScroll={scroll.measure}
        className={cn("min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs tabular-nums text-foreground select-text [scrollbar-color:color-mix(in_srgb,var(--border)_78%,transparent)_transparent] [scrollbar-width:thin]", scroll.more && MORE_TO_SCROLL)}
        title={value}
      >
        {value}
      </span>
      {children}
      <Button variant="ghost" size="icon-xs" className="shrink-0" aria-label={`Copy the ${(label ?? "line").toLowerCase()}`} onClick={copy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}

/** One line of what a road has done: the words at the left, and at the right end the spinner while it runs, a check
 * once it is done, or a quiet word where the line carries one. */
export interface RoadLine {
  word: string;
  state: "running" | "done" | "waiting";
  /** The figure or the word at the right end: how long a stage took, or that a line is not required. */
  fact?: string;
}

/** The list of lines under a road, one 32 px line each, in the order they happened. A line longer than the sheet is
 * cut from the right and carries the whole of itself as its hover text. */
export function RoadLines({ lines, k = "lines" }: { lines: readonly RoadLine[]; k?: string }) {
  return (
    <ul data-k={k} className="flex flex-col">
      {lines.map(line => (
        <li key={line.word} data-k="line" data-state={line.state} className="flex h-8 items-center gap-3 border-border/60 border-b last:border-transparent">
          <span className={cn("min-w-0 flex-1 truncate font-mono text-xs", line.state === "waiting" ? "text-muted-foreground" : "text-foreground")} title={line.word}>
            {line.word}
          </span>
          {line.fact === undefined ? null : <span className={STATE_WORD}>{line.fact}</span>}
          {line.state === "running" ? <Spinner className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          {line.state === "done" ? <CheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        </li>
      ))}
    </ul>
  );
}

/** The slot under a field a refusal lands in: two lines at 13 px, standing at that height whether or not it holds
 * one. What happened is in the error ink; what to do about it follows in the foreground's. The same slot carries, in
 * the muted ink, why the keycap under it is held, so that reason is read before any click, and at rest the note that
 * says what the act will do; a refusal replaces either. Newlines in a refusal are kept: a computer that took the
 * agent and did not dial back reads its own log lines under the sentence, and HTML would otherwise run all eleven
 * together. */
export function RefusalSlot({ k, said, fix, waiting, note, children }: { k: string; said?: string; fix?: string; waiting?: string; note?: ReactNode; children?: ReactNode }) {
  const quiet = said === undefined ? (waiting === undefined ? note : <span data-k="waiting">{waiting}</span>) : undefined;
  return (
    <p data-k={k} className="min-h-9 whitespace-pre-line break-words text-[13px] leading-[18px] text-destructive-foreground">
      {said ?? ""}
      {fix === undefined ? null : <span className="text-foreground"> {fix}</span>}
      {quiet === undefined ? null : <span className="text-muted-foreground">{quiet}</span>}
      {children}
    </p>
  );
}

/** A refusal as the host said it: what happened, and what to do about it where it said that too. */
export type Refusal = { readonly said: string; readonly fix?: string };
/** What a write answered: nothing where the host took it, its refusal where it did not. */
export type Written = Refusal | null;

const refusalOf = (e: unknown): Refusal => {
  const failure = failureOf(e);
  return { said: failure.said, ...(failure.fix === undefined ? {} : { fix: failure.fix }) };
};

/** A write as a sheet waits on it: nothing where the host took it, its refusal where it did not. */
export const sheetWrite = (write: Promise<unknown>): Promise<Written> => write.then(() => null, refusalOf);

/** A sheet over the page: its title and why, what it holds, the host's refusal under that, and Cancel and Save.
 * While the host works the slot says what it waits on; Save is held where the sheet still waits on a field. */
export function Sheet({ k, title, line, open, onClose, onSave, saving, held = false, waiting, refusal, putBack, children }: { k: string; title: string; line: string; open: boolean; onClose: () => void; onSave: () => void; saving: boolean; held?: boolean; waiting?: string; refusal: Refusal | null; putBack?: ReactNode; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={next => (next ? undefined : onClose())}>
      <DialogPopup data-k={k}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={event => {
            event.preventDefault();
            if (!held && !saving) onSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{line}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3 pb-0">
            {children}
            <RefusalSlot k={`${k}-refusal`} {...(refusal ?? {})} {...(saving && waiting !== undefined ? { waiting } : {})} />
          </DialogPanel>
          <DialogFooter>
            {putBack}
            <Button type="button" variant="outline" onClick={onClose}>
              {SETTINGS_WORDS.cancel}
            </Button>
            <Button type="submit" data-k={`${k}-save`} disabled={saving} held={held}>
              {SETTINGS_WORDS.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** A field in a sheet: mono, for a path or a command a person types. */
export const FIELD = "h-10 w-full font-mono [&_input]:h-[38px] [&_input]:text-[13px] [&_input]:leading-[38px] sm:[&_input]:h-[38px] sm:[&_input]:text-[13px] sm:[&_input]:leading-[38px]";
/** A field in a sheet for words, a name: the input's own sans at its own size. */
const WORDS_FIELD = cn(FIELD, "font-sans [&_input]:font-sans [&_input]:text-base sm:[&_input]:text-sm");

/** One line a person types. Save hands the trimmed words to `save`, which answers a refusal or nothing; `putBack`
 * puts the thing's own back where one is set. A sheet that cannot save a blank line holds Save until there is one,
 * and a save the host takes a while over says what it checks in the slot while it runs. */
export function FieldSheet({ k, title, line, initial, placeholder, save, putBack, putBackWord, mono = true, required = false, checking, onClose }: { k: string; title: string; line: string; initial: string; placeholder: string; mono?: boolean; required?: boolean; checking?: (value: string) => string; save: (value: string) => Promise<Written>; putBack?: () => Promise<Written>; putBackWord?: string; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const run = (write: () => Promise<Written>): void => {
    setSaving(true);
    setRefusal(null);
    void write().then(answer => {
      setSaving(false);
      if (answer === null) onClose();
      else setRefusal(answer);
    });
  };
  return (
    <Sheet
      k={k}
      title={title}
      line={line}
      open
      onClose={onClose}
      onSave={() => run(() => save(value.trim()))}
      saving={saving}
      held={required && value.trim() === ""}
      {...(checking === undefined ? {} : { waiting: checking(value.trim()) })}
      refusal={refusal}
      {...(putBack === undefined
        ? {}
        : {
            putBack: (
              <Button type="button" variant="ghost" data-k={`${k}-put-back`} className="sm:me-auto" disabled={saving} onClick={() => run(putBack)}>
                {putBackWord}
              </Button>
            ),
          })}
    >
      <Input
        data-k={`${k}-field`}
        nativeInput
        autoFocus
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-label={title}
        {...(refusal === null ? {} : { "aria-invalid": true })}
        onChange={event => {
          setValue(event.target.value);
          setRefusal(null);
        }}
        className={mono ? FIELD : WORDS_FIELD}
      />
    </Sheet>
  );
}

/** The outline xs button at a row's end that opens its sheet. */
export function ChangeButton({ k, word, held, onClick }: { k: string; word: string; held: boolean; onClick: () => void }) {
  return (
    <Button size="xs" variant="outline" data-k={k} held={held} onClick={onClick}>
      {word}
    </Button>
  );
}
