// SPDX-License-Identifier: AGPL-3.0-only
// The composer's place while the agent waits on the person: a prompt the
// harness relayed, drawn as a menu where the box was, in the composer's own
// frame, so the one place a person types is the one place they answer. The
// menu is keyboard first, as the CLIs' own are: arrows move, digits pick, Enter
// answers, Space ticks where a question takes several, Esc closes an open
// field and then folds the dock to one line over the composer. The last row of
// a question is Other, which opens a field; Deny opens one too, for what to do
// instead. The field lives in the foot, where the key hints were, so opening
// it moves no row and grows nothing. A prompt with several questions takes
// them one at a time with the count in the head, the earlier answers standing
// as quiet lines above the current one, and sends every pick as one answer at
// the end, since one pick closes one prompt. A consent prompt leads with the
// protocol's own words for the call (the command in the mono face, an edit as
// its lines), then the options the harness offered, bare: the one sentence
// drawn under an option is the catalog's own for the access mode it moves the
// turn to. Once answered the dock goes and the composer comes back; the
// timeline keeps the record.
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { permissionPromptWords, pickedOptionId, type AskedQuestion } from "@wsp/protocol";
import { isPromptOpen, type PermissionPrompt } from "../../adapt";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { ComposerSurface } from "./ComposerSurface";
import { HarnessMark } from "./HarnessMark";

/** One row of the menu: a label, the one sentence it may carry, and the field it opens where it opens one. */
interface MenuRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly field?: string;
}

/** An access mode as the catalog lists it: what the Access picker shows, so a mode option's sentence is the same. */
export interface ModeWords {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** The last row of every question, as the CLI draws it: a pick that is none of the above, typed. */
const OTHER: MenuRow = { id: "other", label: "Other", description: "", field: "Type your answer" };
const DENY_FIELD = "What to do instead";
const STRIP_LEAD = "Waiting for you";

const CODE_CLASS = "font-mono text-xs leading-4 text-foreground/80";

/** A command wraps at its spaces and nowhere else, as the timeline's row does. */
function commandParts(command: string): ReactNode[] {
  return command.split(/(\s+)/).map((part, at) => (/^\s*$/.test(part) ? part : <span key={at} className="whitespace-pre">{part}</span>));
}

/** The call's input as fields, or nothing while it is not an object. */
function fieldsOf(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The strings an edit swaps, off any call that carries them: the first edit of several, else the call's own. */
function editOf(fields: Record<string, unknown>): { old: string; next: string } | null {
  const edits = Array.isArray(fields["edits"]) ? (fields["edits"] as Record<string, unknown>[]) : undefined;
  const first = edits?.[0] ?? fields;
  return typeof first["old_string"] === "string" && typeof first["new_string"] === "string" ? { old: first["old_string"], next: first["new_string"] } : null;
}

/** The lines that go and the lines that come, in the diff's two inks: the sign in its own column and the text
 * wrapping under itself at its spaces, two tinted bands and no box around them. */
function EditLines({ edit }: { edit: { old: string; next: string } }) {
  const line = (text: string, sign: "-" | "+", at: number) => (
    <div
      key={`${sign}${at}`}
      data-edit-line={sign}
      className={cn("grid grid-cols-[1rem_minmax(0,1fr)] gap-2 px-3 py-px", sign === "-" ? "bg-[color-mix(in_srgb,var(--error-foreground)_9%,transparent)]" : "bg-[color-mix(in_srgb,var(--success)_9%,transparent)]")}
    >
      <span className={cn("select-none", sign === "-" ? "text-error-foreground" : "text-success")}>{sign}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/80">{text === "" ? " " : text}</span>
    </div>
  );
  return (
    <div data-edit-lines className={cn("max-h-56 overflow-y-auto rounded-lg py-1", CODE_CLASS)}>
      {edit.old.split("\n").map((text, at) => line(text, "-", at))}
      {edit.next.split("\n").map((text, at) => line(text, "+", at))}
    </div>
  );
}

function Hint({ word, children }: { word: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      {children}
      {word}
    </span>
  );
}

/** One row: its number as a key, the label, the one sentence it may carry; a tick box at the end where the
 * question takes several. The row never changes height: a field it opens lives in the foot. */
const OptionRow = memo(function OptionRow({
  row,
  at,
  active,
  ticked,
  multi,
  onHover,
  onPick,
}: {
  row: MenuRow;
  at: number;
  active: boolean;
  ticked: boolean;
  multi: boolean;
  onHover: (at: number) => void;
  onPick: (at: number) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-prompt-option={row.id}
      data-active={active || undefined}
      data-ticked={ticked || undefined}
      className={cn("flex min-w-0 cursor-pointer items-start gap-3 rounded-lg px-3 py-2 transition-colors duration-150", active && "bg-accent")}
      onMouseMove={() => onHover(at)}
      onClick={() => onPick(at)}
    >
      <Kbd className={cn("mt-px shrink-0", active && "bg-background/60 text-foreground")}>{at + 1}</Kbd>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("text-sm leading-5", active || ticked ? "text-foreground" : "text-foreground/85")}>{row.label}</span>
        {row.description === "" ? null : <span className="text-xs leading-4 text-muted-foreground">{row.description}</span>}
      </span>
      {multi ? <Checkbox checked={ticked} tone="neutral" tabIndex={-1} className="mt-0.5" onCheckedChange={() => onPick(at)} /> : null}
    </div>
  );
});

/** A question answered earlier in the same prompt, as one quiet line a person can go back to. */
function AnsweredLine({ question, answer, onBack }: { question: AskedQuestion; answer: string; onBack: () => void }) {
  return (
    <button type="button" data-prompt-answered className="flex h-7 min-w-0 items-center gap-3 rounded-lg px-3 text-left transition-colors duration-150 hover:bg-accent" onClick={onBack}>
      <span className="w-28 shrink-0 truncate text-xs leading-4 text-muted-foreground">{question.header === "" ? question.question : question.header}</span>
      <span className="min-w-0 truncate text-sm leading-5 text-foreground/85">{answer}</span>
    </button>
  );
}

interface Settled {
  readonly ids: string[];
  readonly typed?: string;
}

export function PromptDock({
  permission,
  agent,
  cwd,
  modes = [],
  onAnswer,
  onWriteInstead,
}: {
  permission: PermissionPrompt;
  /** The agent asking, whose mark heads the dock. */
  agent: string | null;
  /** The folder the thread runs in: a command's own folder is shown only where it differs. */
  cwd?: string;
  /** The access modes the agent's catalog lists, for the sentence under an option that moves the turn to one. */
  modes?: ReadonlyArray<ModeWords>;
  /** The pick, and the words typed into the open field where one was: what to do instead on a deny, the answer
   * itself on Other. */
  onAnswer: (sessionId: string, askId: string, optionId: string, text?: string) => void;
  /** Hands the composer back with the prompt folded to one line above it, for a person who wants to write first. */
  onWriteInstead?: () => void;
}) {
  const words = useMemo(() => permissionPromptWords(permission.toolName, permission.input, permission.detail), [permission]);
  const fields = useMemo(() => fieldsOf(permission.input), [permission.input]);
  const edit = useMemo(() => editOf(fields), [fields]);
  const questions = words.questions;
  const consent = questions === undefined;
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyArray<Settled>>(() => (questions ?? []).map(() => ({ ids: [] })));
  const question = questions?.[step];
  const multi = question?.multiSelect === true;
  const rows = useMemo<MenuRow[]>(
    () =>
      question !== undefined
        ? [...question.options.map(o => ({ id: o.id, label: o.label, description: o.description })), OTHER]
        : permission.options.map(o => ({
            id: o.id,
            label: o.label,
            description: o.effect === "mode" ? (modes.find(m => m.value === o.mode)?.description ?? "") : "",
            ...(o.effect === "deny" ? { field: DENY_FIELD } : {}),
          })),
    [modes, permission.options, question],
  );
  // A question with nothing to pick from is the field alone, open from the start.
  const textOnly = question !== undefined && question.options.length === 0;
  const [active, setActive] = useState(0);
  const [fieldOpen, setFieldOpen] = useState<string | null>(textOnly ? OTHER.id : null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const ticked = answers[step]?.ids ?? [];

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [permission.askId]);
  useEffect(() => {
    if (fieldOpen !== null) fieldRef.current?.focus();
  }, [fieldOpen]);

  const typedNow = (): string => fieldRef.current?.value.trim() ?? "";
  const closeField = useCallback(() => {
    setFieldOpen(null);
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const answer = useCallback(
    (optionId: string, text?: string) => onAnswer(permission.sessionId, permission.askId, optionId, text === undefined || text === "" ? undefined : text),
    [onAnswer, permission.askId, permission.sessionId],
  );

  /** Every question's pick as the one id the prompt closes on; a typed answer travels as its words. */
  const sendAll = useCallback(
    (settled: ReadonlyArray<Settled>) => answer(pickedOptionId(settled.flatMap(a => [...a.ids, ...(a.typed === undefined ? [] : [`other:${a.typed}`])]))),
    [answer],
  );

  const settle = useCallback(
    (picked: Settled) => {
      if (questions === undefined) return;
      const next = answers.map((a, at) => (at === step ? picked : a));
      setAnswers(next);
      if (step + 1 < questions.length) {
        const coming = questions[step + 1]!;
        setStep(step + 1);
        setActive(0);
        setFieldOpen(coming.options.length === 0 ? OTHER.id : null);
      } else sendAll(next);
    },
    [answers, questions, sendAll, step],
  );

  /** What a multi-select sends: the ticks, and the typed words beside them where the Other field holds any. */
  const answerMulti = useCallback(() => {
    const typed = fieldOpen === OTHER.id ? typedNow() : "";
    if (ticked.length === 0 && typed === "") return;
    settle({ ids: ticked, ...(typed === "" ? {} : { typed }) });
  }, [fieldOpen, settle, ticked]);

  const submitField = useCallback(() => {
    const row = rows.find(r => r.id === fieldOpen);
    if (row === undefined) return;
    if (consent) {
      answer(row.id, typedNow());
      return;
    }
    if (multi) {
      answerMulti();
      return;
    }
    const typed = typedNow();
    if (typed !== "") settle({ ids: [], typed });
  }, [answer, answerMulti, consent, fieldOpen, multi, rows, settle]);

  const pick = useCallback(
    (at: number) => {
      const row = rows[at];
      if (row === undefined) return;
      setActive(at);
      if (row.field !== undefined) {
        if (fieldOpen !== row.id) setFieldOpen(row.id);
        else submitField();
        return;
      }
      if (consent) {
        answer(row.id);
        return;
      }
      if (multi) {
        const ids = ticked.includes(row.id) ? ticked.filter(id => id !== row.id) : [...ticked, row.id];
        setAnswers(answers.map((a, i) => (i === step ? { ...a, ids } : a)));
        return;
      }
      settle({ ids: [row.id] });
    },
    [answer, answers, consent, fieldOpen, multi, rows, settle, step, submitField, ticked],
  );
  const hover = useCallback((at: number) => setActive(at), []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return;
    const { key } = event;
    if (key === "Escape") {
      event.preventDefault();
      if (fieldOpen !== null) closeField();
      else onWriteInstead?.();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setActive(a => (a + (key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const at = Number(key) - 1;
      if (at < rows.length) {
        event.preventDefault();
        pick(at);
      }
      return;
    }
    if (key === " " && multi) {
      event.preventDefault();
      pick(active);
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      if (multi && rows[active]?.id !== OTHER.id) answerMulti();
      else pick(active);
    }
  };

  const open = isPromptOpen(permission);
  if (!open) return null;
  const count = questions !== undefined && questions.length > 1 ? `${step + 1} of ${questions.length}` : null;
  // The lead's trailing colon joins it to the code on one line; here the code has a line of its own.
  const lead = words.says.replace(/:$/, "");
  const runsIn = typeof fields["cwd"] === "string" && fields["cwd"] !== cwd ? (fields["cwd"] as string) : null;
  // Enter's one word, and the button's: the same word wherever both are drawn.
  const nextWord = questions !== undefined && step + 1 < questions.length ? "Next" : "Answer";
  const enterWord = multi ? nextWord : fieldOpen !== null ? "Send" : "pick";
  const button = multi ? nextWord : fieldOpen !== null ? "Send" : null;
  const fieldRow = rows.find(r => r.id === fieldOpen);

  return (
    <div className="px-3 pb-3 sm:px-4 sm:pb-4">
      <ComposerSurface.Shell data-prompt-dock={permission.askId}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div
              ref={rootRef}
              tabIndex={-1}
              role="listbox"
              aria-label={question === undefined ? words.lead : question.question}
              className="flex min-w-0 flex-col gap-3 px-3 pt-3.5 pb-3 outline-none sm:px-4 sm:pt-4 sm:pb-3.5"
              onKeyDown={onKeyDown}
            >
              {/* The head: who asks, and what. A question keeps the header the harness gave it over the question
                  itself; a consent is the protocol's sentence for the call, then the call. */}
              <div className="flex min-w-0 flex-col gap-1 px-3">
                <div className="flex min-w-0 items-center gap-2">
                  {agent === null ? null : (
                    <span className="inline-flex shrink-0 text-muted-foreground">
                      <HarnessMark harness={agent} label={agentName(agent)} className="size-3" />
                    </span>
                  )}
                  {question !== undefined ? (
                    <span data-prompt-header className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted-foreground">
                      {question.header === "" ? "Question" : question.header}
                    </span>
                  ) : (
                    <span data-prompt-says className="min-w-0 flex-1 truncate text-sm leading-5 text-foreground">
                      {lead}
                    </span>
                  )}
                  {count === null ? null : (
                    <span data-prompt-count className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">
                      {count}
                    </span>
                  )}
                </div>
                {question !== undefined ? (
                  <span data-prompt-question className="break-words whitespace-pre-wrap text-sm leading-5 text-foreground">
                    {question.question}
                  </span>
                ) : null}
                {words.note === undefined ? null : (
                  <span data-prompt-note className="break-words text-[13px] leading-5 text-foreground/80">
                    {words.note}
                  </span>
                )}
                {words.code === undefined ? null : (
                  <code data-prompt-code className={cn("min-w-0 overflow-x-auto whitespace-pre-wrap break-normal py-0.5", CODE_CLASS)}>
                    {commandParts(words.code)}
                  </code>
                )}
                {runsIn === null ? null : <span className={cn("truncate text-muted-foreground", CODE_CLASS)}>in {runsIn}</span>}
                {words.rest === "" ? null : <span className={cn("break-words whitespace-pre-wrap text-muted-foreground", CODE_CLASS)}>{words.rest}</span>}
              </div>
              {edit === null ? null : (
                <div className="px-3">
                  <EditLines edit={edit} />
                </div>
              )}
              {words.body === undefined ? null : (
                <div className="px-3">
                  <details className="group">
                    <summary className="cursor-pointer list-none text-xs leading-4 text-muted-foreground hover:text-foreground">{words.body.label}</summary>
                    <pre className={cn("mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground", CODE_CLASS)}>{words.body.text}</pre>
                  </details>
                </div>
              )}
              {/* Earlier questions of the same prompt, settled, each one line. */}
              {questions !== undefined && step > 0 ? (
                <div className="flex flex-col">
                  {questions.slice(0, step).map((q, at) => (
                    <AnsweredLine
                      key={q.key}
                      question={q}
                      answer={[...(answers[at]?.ids ?? []).map(id => q.options.find(o => o.id === id)?.label ?? id), ...(answers[at]?.typed === undefined ? [] : [answers[at]!.typed!])].join(", ")}
                      onBack={() => {
                        setStep(at);
                        setActive(0);
                        setFieldOpen(null);
                      }}
                    />
                  ))}
                </div>
              ) : null}
              {textOnly ? null : (
                <div className="flex flex-col" data-prompt-options>
                  {rows.map((row, at) => (
                    <OptionRow key={row.id} row={row} at={at} active={at === active} ticked={ticked.includes(row.id)} multi={multi && row.id !== OTHER.id} onHover={hover} onPick={pick} />
                  ))}
                </div>
              )}
              {/* The foot, one fixed row: the keys, or the field they give way to, and the one button Enter stands for. */}
              <div data-prompt-foot className="flex h-8 min-w-0 items-center gap-3 px-3">
                {fieldRow !== undefined ? (
                  <Input
                    key={fieldRow.id}
                    ref={fieldRef}
                    nativeInput
                    size="sm"
                    data-prompt-field
                    defaultValue=""
                    placeholder={fieldRow.field}
                    aria-label={fieldRow.field}
                    className="min-w-0 flex-1 rounded-lg border border-input bg-(--input-fill) text-sm"
                    onKeyDown={event => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        submitField();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        closeField();
                      }
                      event.stopPropagation();
                    }}
                  />
                ) : (
                  <span className="hidden min-w-0 flex-1 items-center gap-4 sm:flex" data-prompt-hints>
                    <Hint word="move">
                      <Kbd aria-hidden>
                        <ArrowUpIcon className="size-3" />
                      </Kbd>
                      <Kbd aria-hidden>
                        <ArrowDownIcon className="size-3" />
                      </Kbd>
                    </Hint>
                    {multi ? (
                      <Hint word="tick">
                        <Kbd aria-hidden>space</Kbd>
                      </Hint>
                    ) : null}
                    <Hint word={enterWord}>
                      <Kbd aria-hidden>
                        <CornerDownLeftIcon className="size-3" />
                      </Kbd>
                    </Hint>
                  </span>
                )}
                <span className="ms-auto flex shrink-0 items-center gap-2">
                  {onWriteInstead === undefined ? null : (
                    // A phone's foot has room for the field or this, not both; Esc still folds the dock there.
                    <Button size="xs" variant="ghost" data-prompt-write className={cn(fieldRow !== undefined && "max-sm:hidden")} onClick={onWriteInstead}>
                      Write a message instead
                    </Button>
                  )}
                  {button === null ? null : (
                    <Button size="xs" variant="default" data-prompt-answer held={multi && ticked.length === 0 && fieldOpen === null} onClick={() => (multi ? answerMulti() : submitField())}>
                      {button}
                    </Button>
                  )}
                </span>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/** The prompt folded to one line over the composer, for the person who chose to write first: the timeline's own
 * words for the wait, what is asked, and the way back to the menu. */
export function PromptStrip({ permission, onOpen }: { permission: PermissionPrompt; onOpen: () => void }) {
  const words = permissionPromptWords(permission.toolName, permission.input, permission.detail);
  const line = words.questions !== undefined ? words.questions[0]!.question : words.lead;
  return (
    <div className="mx-auto flex h-8 w-full max-w-3xl min-w-0 items-center gap-3 px-6 text-xs leading-4 text-muted-foreground sm:px-7" data-prompt-strip>
      <span className="shrink-0">{STRIP_LEAD}</span>
      <span className="min-w-0 flex-1 truncate text-foreground/85">{line}</span>
      <Button size="xs" variant="outline" onClick={onOpen}>
        Answer
      </Button>
    </div>
  );
}
