// SPDX-License-Identifier: AGPL-3.0-only
// The composer's place while the agent waits on the person: a prompt the
// harness relayed, drawn in the composer's own frame as one step of a settings
// dialog, so the one place a person types is the one place they answer and it
// reads like every other screen that asks them something. A head (the agent's
// mark and the question, or what the call is, as the protocol words it; the
// step's count as a quiet figure; one line under it only where there is one),
// then the settings cards, then the dialog's foot. One of many is a card of
// Choice rows, many of many a card of ticked rows, as the Add a computer steps
// draw them; a form's earlier answers stand as lines in a card above the
// current question; a command, a path or an address is a copy row under the
// head; an edit is its file as a row with the lines that change under it in
// the step-log mono. Digits pick a row, arrows move the pick, Space ticks,
// Enter is the foot's primary button, Esc leaves the field and then folds the
// dock to one row over the composer. Other and Deny take their words in a
// field in the row's own right column, so no row moves. Once answered the dock
// goes and the composer comes back; the timeline keeps the record.
import { FileIcon, MessageCircleQuestionIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { otherOptionId, permissionPromptWords, pickedOptionId, type AskedQuestion } from "@wsp/protocol";
import { isPromptOpen, type PermissionPrompt } from "../../adapt";
import { ownsKeys } from "../../keyOwners";
import { cn } from "../../lib/utils";
import { Choice } from "../../settings/add/PickLists";
import { PickRow } from "../../settings/add/PickRow";
import { FACT } from "../../settings/format";
import { GlyphFrame, Grid } from "../../settings/grid";
import { CARD_INSET, LIST_TITLE, NOTE, ROW_FIELD, SETTING_TITLE } from "../../settings/layout";
import { Line } from "../../settings/rows";
import { CopyRow } from "../../settings/sheetParts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RadioGroup } from "../ui/radio-group";
import { ComposerSurface } from "./ComposerSurface";
import { HarnessMark } from "./HarnessMark";

/** One row of a card: a name, the one sentence it may carry, and the field it opens where it opens one. */
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
const WRITE_INSTEAD = "Write a message instead";
const FOLDED_TITLE = "Waiting for you";
const ANSWER_WORD = "Answer";
const NEXT_WORD = "Next";
const BACK_WORD = "Back";

/** The dialog's title, head, body and foot, in the classes Add a computer draws them with. */
const TITLE_CLASS = "text-base leading-6 font-semibold text-foreground";
const HEAD_CLASS = "flex flex-row items-start justify-between gap-6 px-5 pt-4 pb-3";
const BODY_CLASS = "flex flex-col gap-5 px-5 pt-2 pb-5";
const FOOT_CLASS = "flex flex-col-reverse gap-2 px-5 pb-5 sm:flex-row sm:items-center sm:justify-end";
/** The field a row opens, in its right column, wide enough for a sentence; under 640 px it takes the row's width. */
const FIELD_CLASS = cn(ROW_FIELD, "w-96 max-sm:w-full");
/** The step-log mono block the computer's page opens under a row, on the words' left edge past a glyph frame. */
const LOG_CLASS = "max-h-48 overflow-auto font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-muted-foreground tabular-nums";
const LOG_EDGE = "pl-[calc(var(--settings-inset,20px)+44px)] pr-(--settings-inset,20px) pb-4";
/** A changed line's ink, the Changes pane's own: it tints its rows from --success and --destructive. */
const LINE_INK = { "-": "text-destructive-foreground", "+": "text-success" } as const;
const GLYPH = "size-4 text-foreground/80";
/** The keys the dock takes while it has focus; every other key is the window's, a letter the start of a message. */
const DOCK_KEYS = ownsKeys(["1", "2", "3", "4", "5", "6", "7", "8", "9", "ArrowUp", "ArrowDown", " ", "Enter", "Escape"]);

/** What a row's hover says: the keys that pick it, since the foot carries no hint strip. */
const rowHover = (at: number, multi: boolean): string => (multi ? `${at + 1} or Space ticks this, Enter answers, Esc puts the question away` : `${at + 1} picks this, Enter answers, Esc puts the question away`);

/** The call's input as fields, or nothing while it is not an object. */
function fieldsOf(input: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** An edit as the step log draws a step's output, in the Changes pane's inks: the lines that go with their sign,
 * then the lines that come; the sign keeps a column of its own so a wrapped line hangs under its text. */
function EditLines({ edit }: { edit: { old: string; next: string } }) {
  const line = (sign: "-" | "+", text: string, at: number) => (
    <div key={`${sign}${at}`} data-edit-line={sign} className={cn("grid grid-cols-[1rem_minmax(0,1fr)]", LINE_INK[sign])}>
      <span className="select-none">{sign}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{text === "" ? " " : text}</span>
    </div>
  );
  return (
    <div data-prompt-edit className={cn(LOG_CLASS, LOG_EDGE)}>
      {edit.old.split("\n").map((text, at) => line("-", text, at))}
      {edit.next.split("\n").map((text, at) => line("+", text, at))}
    </div>
  );
}

/** A path as the thread reads it: inside the thread's folder, the part under that folder. */
const pathIn = (path: string, cwd: string | undefined): string => (cwd !== undefined && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);

/** The values the lead does not carry, as the protocol lists them, one `key: value` a line. */
const restLines = (rest: string): { key: string; value: string }[] =>
  rest
    .split("\n")
    .filter(line => line !== "")
    .map(line => {
      const at = line.indexOf(": ");
      return at < 0 ? { key: line, value: "" } : { key: line.slice(0, at), value: line.slice(at + 2) };
    });

const fileName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

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
  /** The pick, and on a deny the words typed into its field: what the agent should do instead. An answer typed in
   * Other rides the pick itself. */
  onAnswer: (sessionId: string, askId: string, optionId: string, reason?: string) => void;
  /** Hands the composer back with the prompt folded to one row above it, for a person who wants to write first. */
  onWriteInstead?: () => void;
}) {
  const words = useMemo(() => permissionPromptWords(permission.toolName, permission.input, permission.detail), [permission]);
  const fields = useMemo(() => fieldsOf(permission.input), [permission.input]);
  const edit = words.edit ?? null;
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
  // The first row is picked from the start, as the CLIs' own menus stand; a tick list starts bare.
  const [picked, setPicked] = useState<string>(() => rows[0]?.id ?? "");
  const [typedSome, setTypedSome] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const ticked = answers[step]?.ids ?? [];
  const pickedRow = rows.find(r => r.id === picked);
  const fieldOpen = textOnly || (multi ? ticked.includes(OTHER.id) : pickedRow?.field !== undefined);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [permission.askId]);
  useEffect(() => {
    if (fieldOpen) fieldRef.current?.focus();
  }, [fieldOpen]);

  const typedNow = (): string => fieldRef.current?.value.trim() ?? "";

  const answer = useCallback(
    (optionId: string, reason?: string) => onAnswer(permission.sessionId, permission.askId, optionId, reason === undefined || reason === "" ? undefined : reason),
    [onAnswer, permission.askId, permission.sessionId],
  );

  /** Every question's pick as the one id the prompt closes on; a typed answer travels as its words, named by the
   * question it answers. */
  const sendAll = useCallback(
    (settled: ReadonlyArray<Settled>) => answer(pickedOptionId(settled.flatMap((a, at) => [...a.ids, ...(a.typed === undefined ? [] : [otherOptionId(questions![at]!.index, a.typed)])]))),
    [answer, questions],
  );

  /** Onto a step as it was last left: its pick, its ticks and its typed words where it has them, else the first row. */
  const goTo = (at: number, coming: AskedQuestion): void => {
    const held = answers[at];
    const typed = held?.typed !== undefined;
    setStep(at);
    setPicked(held?.ids[0] ?? (typed || coming.options[0] === undefined ? OTHER.id : coming.options[0].id));
    if (coming.multiSelect && typed && !held!.ids.includes(OTHER.id)) setAnswers(all => all.map((a, i) => (i === at ? { ...a, ids: [...a.ids, OTHER.id] } : a)));
    setTypedSome(typed);
    rootRef.current?.focus({ preventScroll: true });
  };

  const settle = useCallback(
    (settledNow: Settled) => {
      if (questions === undefined) return;
      const next = answers.map((a, at) => (at === step ? settledNow : a));
      setAnswers(next);
      const coming = questions[step + 1];
      if (coming !== undefined) goTo(step + 1, coming);
      else sendAll(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [answers, questions, sendAll, step],
  );

  /** Whether the primary button can be pressed: a tick list needs a tick or words, a field row needs its words. */
  const held = multi ? ticked.filter(id => id !== OTHER.id).length === 0 && !(ticked.includes(OTHER.id) && typedSome) : fieldOpen && !consent && !typedSome;

  /** What Enter and the primary button do: the pick as it stands, with the field's words where a field is open. */
  const confirm = useCallback(() => {
    if (held) return;
    const typed = fieldOpen ? typedNow() : "";
    if (consent) {
      if (pickedRow !== undefined) answer(pickedRow.id, pickedRow.field === undefined ? undefined : typed);
      return;
    }
    if (multi) {
      settle({ ids: ticked.filter(id => id !== OTHER.id), ...(typed === "" ? {} : { typed }) });
      return;
    }
    if (picked === OTHER.id) settle({ ids: [], typed });
    else settle({ ids: [picked] });
  }, [answer, consent, fieldOpen, held, multi, picked, pickedRow, settle, ticked]);

  const tick = useCallback(
    (id: string, on: boolean) => {
      const ids = on ? [...ticked.filter(t => t !== id), id] : ticked.filter(t => t !== id);
      setAnswers(answers.map((a, i) => (i === step ? { ...a, ids } : a)));
    },
    [answers, step, ticked],
  );

  /** Focus the nth tick box, so Space and the arrows act on a real control. */
  const focusTick = (at: number): void => {
    const boxes = rootRef.current?.querySelectorAll<HTMLElement>("[data-pick-row] [data-slot=checkbox]") ?? [];
    boxes[((at % boxes.length) + boxes.length) % boxes.length]?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return;
    const { key } = event;
    if (key === "Escape") {
      event.preventDefault();
      onWriteInstead?.();
      return;
    }
    if (key === "Enter") {
      // A focused button keeps its own Enter: Write a message instead, Copy and Back must never give the consent.
      if (event.target !== event.currentTarget && !(event.target instanceof Element && event.target.closest("[role=radio], [role=checkbox]") !== null)) return;
      event.preventDefault();
      confirm();
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const at = Number(key) - 1;
      const row = rows[at];
      if (row === undefined) return;
      event.preventDefault();
      if (multi) {
        tick(row.id, !ticked.includes(row.id));
        focusTick(at);
      } else if (picked === row.id && row.field !== undefined) fieldRef.current?.focus();
      else setPicked(row.id);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      const move = key === "ArrowDown" ? 1 : -1;
      if (multi) {
        const boxes = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-pick-row] [data-slot=checkbox]") ?? [])];
        const at = boxes.findIndex(box => box === document.activeElement);
        event.preventDefault();
        focusTick(at < 0 ? (move > 0 ? 0 : -1) : at + move);
        return;
      }
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      const at = rows.findIndex(r => r.id === picked);
      setPicked(rows[(at + move + rows.length) % rows.length]!.id);
    }
  };

  /** Esc in the field: the pick goes back to the first row and the dock has the keys again; a tick list keeps its
   * ticks and only the focus moves. */
  const leaveField = (): void => {
    if (!multi && !textOnly) setPicked(rows[0]?.id ?? "");
    rootRef.current?.focus({ preventScroll: true });
  };

  const field = (row: MenuRow): ReactNode => (
    <Input
      key={`${step}:${row.id}`}
      ref={fieldRef}
      nativeInput
      data-prompt-field
      defaultValue={row.id === OTHER.id ? (answers[step]?.typed ?? "") : ""}
      placeholder={row.field}
      aria-label={row.field}
      className={FIELD_CLASS}
      onChange={event => setTypedSome(event.target.value.trim() !== "")}
      onKeyDown={event => {
        if (event.key === "Enter") {
          event.preventDefault();
          confirm();
        } else if (event.key === "Escape") {
          event.preventDefault();
          leaveField();
        }
        event.stopPropagation();
      }}
    />
  );

  if (!isPromptOpen(permission)) return null;
  const count = questions !== undefined && questions.length > 1 ? `${step + 1} of ${questions.length}` : null;
  // The lead's trailing colon joins it to the code on one line; here the code has a row of its own.
  const title = question === undefined ? words.says.replace(/:$/, "") : question.question;
  // A question's header word stands under it only where the question does not already say it.
  const note = question === undefined ? words.note : question.header === "" || question.question.toLowerCase().includes(question.header.toLowerCase()) ? undefined : question.header;
  const runsIn = typeof fields["cwd"] === "string" && fields["cwd"] !== cwd ? (fields["cwd"] as string) : null;
  const filePath = words.file ?? null;
  const primaryWord = consent ? (permission.options.find(o => o.id === picked)?.effect === "deny" ? "Deny" : "Allow") : questions !== undefined && step + 1 < questions.length ? NEXT_WORD : ANSWER_WORD;
  const earlier = questions === undefined ? [] : questions.slice(0, step);
  const rest = question === undefined && words.body === undefined && filePath === null ? restLines(words.rest) : [];

  return (
    <div className="px-3 pb-3 sm:px-4 sm:pb-4">
      <ComposerSurface.Shell data-prompt-dock={permission.askId}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div ref={rootRef} tabIndex={-1} data-prompt-root data-owns-keys={DOCK_KEYS} aria-label={title} className="flex min-w-0 flex-col outline-none" onKeyDown={onKeyDown}>
              <div data-slot="dialog-header" className={HEAD_CLASS}>
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 data-prompt-title className={cn(TITLE_CLASS, "flex min-w-0 items-center gap-2")}>
                    {agent === null ? null : <HarnessMark harness={agent} label={agentName(agent)} className={cn(GLYPH, "shrink-0")} />}
                    <span className="min-w-0 break-words">{title}</span>
                  </h2>
                  {note === undefined ? null : (
                    <p data-prompt-note className={cn(NOTE, "break-words")}>
                      {note}
                    </p>
                  )}
                  {earlier.map((q, at) => (
                    <p key={q.key} data-prompt-answered={q.key} title={`${q.question} ${[...(answers[at]?.ids ?? []).map(id => q.options.find(o => o.id === id)?.label ?? id), ...(answers[at]?.typed === undefined ? [] : [answers[at]!.typed!])].join(", ")}`} className={cn(NOTE, "truncate")}>
                      {q.header === "" ? q.question : q.header}: {[...(answers[at]?.ids ?? []).map(id => q.options.find(o => o.id === id)?.label ?? id), ...(answers[at]?.typed === undefined ? [] : [answers[at]!.typed!])].join(", ")}
                    </p>
                  ))}
                </div>
                {count === null ? null : (
                  <span data-prompt-count className={cn(FACT, "shrink-0")}>
                    {count}
                  </span>
                )}
              </div>
              <div data-slot="dialog-panel" className={BODY_CLASS}>
                {words.code === undefined || question !== undefined ? null : (
                  <div className="flex flex-col gap-2">
                    <CopyRow k="prompt-code" value={words.code} />
                    {runsIn === null ? null : <p className={cn(FACT, "truncate")}>in {runsIn}</p>}
                  </div>
                )}
                {filePath === null || question !== undefined ? null : (
                  <Grid id="prompt-file">
                    <div className="flex flex-col">
                      <div className={cn("flex items-center gap-3 py-3 min-h-15", CARD_INSET)}>
                        <GlyphFrame>
                          <FileIcon aria-hidden className={GLYPH} />
                        </GlyphFrame>
                        <span className="flex min-w-0 flex-col">
                          <span className={cn(LIST_TITLE, "truncate")}>{fileName(filePath)}</span>
                          <span className={cn(FACT, "truncate")} title={filePath}>
                            {pathIn(filePath, cwd)}
                          </span>
                        </span>
                      </div>
                      {edit !== null ? (
                        <EditLines edit={edit} />
                      ) : words.body === undefined ? null : (
                        <pre data-prompt-body className={cn(LOG_CLASS, LOG_EDGE)}>
                          {words.body.text}
                        </pre>
                      )}
                    </div>
                  </Grid>
                )}
                {rest.length === 0 ? null : (
                  <Grid id="prompt-fields">
                    {rest.map(line => (
                      <Line key={line.key} id={line.key} label={line.key} value={line.value} valueClass="fact" />
                    ))}
                  </Grid>
                )}
                {textOnly ? (
                  <Input key={step} ref={fieldRef} nativeInput data-prompt-field size="lg" autoComplete="off" defaultValue={answers[step]?.typed ?? ""} placeholder={OTHER.field} aria-label={OTHER.field} onChange={event => setTypedSome(event.target.value.trim() !== "")} onKeyDown={event => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      confirm();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      leaveField();
                    }
                    event.stopPropagation();
                  }} />
                ) : multi ? (
                  <Grid id="prompt-options">
                    {rows.map((row, at) => (
                      <PickRow key={row.id} id={row.id} checked={ticked.includes(row.id)} dim={false} title={SETTING_TITLE} onCheckedChange={on => tick(row.id, on)} name={row.label} {...(row.description === "" ? {} : { note: row.description })} hover={rowHover(at, true)} attrs={{ "data-prompt-option": row.id }} {...(row.field !== undefined && ticked.includes(row.id) ? { slot: field(row) } : {})} />
                    ))}
                  </Grid>
                ) : (
                  <RadioGroup value={picked} onValueChange={next => setPicked(String(next))} className="gap-0">
                    <Grid id="prompt-options">
                      {rows.map((row, at) => (
                        <Choice key={row.id} id={row.id} picked={picked === row.id} title={SETTING_TITLE} name={row.label} {...(row.description === "" ? {} : { note: row.description })} hover={rowHover(at, false)} attrs={{ "data-prompt-option": row.id }} {...(row.field !== undefined && picked === row.id ? { slot: field(row) } : {})} />
                      ))}
                    </Grid>
                  </RadioGroup>
                )}
              </div>
              <div data-slot="dialog-footer" data-prompt-foot className={FOOT_CLASS}>
                <span className="flex min-h-5 items-center max-sm:justify-center sm:me-auto">
                  {onWriteInstead === undefined ? null : (
                    <Button size="xs" variant="ghost" data-prompt-write className="px-0 [:hover,[data-pressed]]:bg-transparent" onClick={onWriteInstead}>
                      {WRITE_INSTEAD}
                    </Button>
                  )}
                </span>
                {step === 0 || questions === undefined ? null : (
                  <Button variant="outline" data-prompt-back onClick={() => goTo(step - 1, questions[step - 1]!)}>
                    {BACK_WORD}
                  </Button>
                )}
                <Button data-prompt-answer held={held} onClick={confirm}>
                  {primaryWord}
                </Button>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/** The prompt folded to one row over the composer, for the person who chose to write first: the question glyph in
 * its frame, the timeline's own words for the wait, what is asked, and the way back to the dock. */
export function PromptStrip({ permission, onOpen }: { permission: PermissionPrompt; onOpen: () => void }) {
  const words = permissionPromptWords(permission.toolName, permission.input, permission.detail);
  const line = words.questions !== undefined ? words.questions[0]!.question : words.lead;
  return (
    <div className="px-3 pb-2 sm:px-4">
      <ComposerSurface.Shell data-prompt-strip>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="flex min-h-15 items-center gap-3 px-5 py-3">
              <GlyphFrame>
                <MessageCircleQuestionIcon aria-hidden className={GLYPH} />
              </GlyphFrame>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={LIST_TITLE}>{FOLDED_TITLE}</span>
                <span className={cn(NOTE, "truncate")} title={line}>
                  {line}
                </span>
              </span>
              <Button size="xs" variant="outline" data-prompt-open onClick={onOpen}>
                {ANSWER_WORD}
              </Button>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}
