// SPDX-License-Identifier: AGPL-3.0-only
// The composer's place while the agent waits on the person: a prompt the
// harness relayed, drawn as a menu where the box was, in the composer's own
// frame, so the one place a person types is the one place they answer. The
// menu is keyboard first, as the CLIs' own are: arrows move, digits pick, Enter
// answers, Space ticks where a question takes several, and the last row of a
// question is Other, which opens a field. A prompt with several questions
// takes them one at a time with the count in the head, the earlier answers
// standing as quiet lines above the current one, and sends every pick as one
// answer at the end, since one pick closes one prompt. A consent prompt leads
// with what the call does (the command in the mono face, an edit as its
// lines), then the options the harness offered, Deny opening a field for what
// to do instead. Once answered the dock goes and the composer comes back; the
// timeline keeps the record.
import { ArrowDownIcon, ArrowUpIcon, CornerDownLeftIcon, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { permissionPromptWords, pickedOptionId, type AskedQuestion, type PermissionOption } from "@wsp/protocol";
import { isPromptOpen, type PermissionPrompt } from "../../adapt";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerSurface } from "./ComposerSurface";
import { HarnessMark } from "./HarnessMark";

/** One row of the menu: a label, a sentence under it, and whether it is the row that opens a field. */
interface MenuRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly field?: { readonly placeholder: string };
}

/** The last row of every question, as the CLI draws it: a pick that is none of the above, typed. */
const OTHER: MenuRow = { id: "other", label: "Other", description: "", field: { placeholder: "Type your answer" } };

/** What Deny asks for once it is the row in hand: the agent reads the pick as its result, and a sentence beside it
 * is worth more than the refusal alone. */
const DENY_FIELD = { placeholder: "Tell the agent what to do instead (optional)" };

const CODE_CLASS = "font-mono text-xs leading-4 text-foreground/80";

/** A command wraps at its spaces and nowhere else, as the timeline's row does. */
function commandParts(command: string): ReactNode[] {
  return command.split(/(\s+)/).map((part, at) => (/^\s*$/.test(part) ? part : <span key={at} className="whitespace-pre">{part}</span>));
}

/** The head's quiet word for a consent prompt, the kind of call as the CLIs' own titles name it. */
function consentKind(toolName: string): string {
  switch (toolName) {
    case "Bash":
    case "command_execution":
      return "Command";
    case "Edit":
    case "MultiEdit":
      return "File edit";
    case "Write":
      return "File write";
    case "file_change":
      return "File changes";
    case "WebFetch":
      return "Web fetch";
    case "ExitPlanMode":
      return "Plan";
    case "Skill":
      return "Skill";
    default: {
      const parts = toolName.split("__");
      return parts.length >= 3 && parts[0] === "mcp" ? `${parts[1]} tool` : "Permission";
    }
  }
}

/** The one line a call is judged by in the head, for the kinds the protocol's table words and the ones it does
 * not yet: an edit is its file, a plan is a plan, a fetch is its address, a Codex command is its command. */
function dockLead(permission: PermissionPrompt): { says: string; code?: string; rest: string; body?: { label: string; text: string } } {
  const words = permissionPromptWords(permission.toolName, permission.input, permission.detail);
  const input = ((): Record<string, unknown> => {
    try {
      const parsed: unknown = JSON.parse(permission.input);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  const str = (key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  const file = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;
  const folder = (path: string): string => path.split("/").filter(Boolean).at(-2) ?? "";
  const path = str("file_path");
  switch (permission.toolName) {
    case "Edit":
    case "MultiEdit":
      return path === undefined ? words : { says: `Edit ${file(path)}${folder(path) === "" ? "" : ` in ${folder(path)}`}`, rest: "" };
    case "ExitPlanMode":
      return { says: "Approve the plan", rest: "" };
    case "WebFetch":
      return { says: "Fetch", ...(str("url") === undefined ? {} : { code: str("url")! }), rest: str("prompt") === undefined ? "" : str("prompt")! };
    case "command_execution":
      return { says: "Run:", ...(str("command") === undefined ? {} : { code: str("command")! }), rest: str("cwd") === undefined ? "" : `in ${str("cwd")!}` };
    default:
      return { says: words.says, ...(words.code === undefined ? {} : { code: words.code }), rest: words.rest, ...(words.body === undefined ? {} : { body: words.body }) };
  }
}

/** An edit's two strings as the lines a person reads: what goes, what comes, in the diff's two inks. */
function EditLines({ input }: { input: string }) {
  const parsed = ((): { old: string; next: string } | null => {
    try {
      const fields = JSON.parse(input) as Record<string, unknown>;
      const edits = Array.isArray(fields["edits"]) ? (fields["edits"] as Record<string, unknown>[]) : undefined;
      const first = edits?.[0] ?? fields;
      return typeof first["old_string"] === "string" && typeof first["new_string"] === "string" ? { old: first["old_string"], next: first["new_string"] } : null;
    } catch {
      return null;
    }
  })();
  if (parsed === null) return null;
  const line = (text: string, sign: "-" | "+", at: number) => (
    <div
      key={`${sign}${at}`}
      data-edit-line={sign}
      className={cn("flex min-w-0 gap-3 px-3 py-px", sign === "-" ? "bg-[color-mix(in_srgb,var(--error-foreground)_9%,transparent)]" : "bg-[color-mix(in_srgb,var(--success)_9%,transparent)]")}
    >
      <span className={cn("w-2 shrink-0 select-none", sign === "-" ? "text-error-foreground" : "text-success")}>{sign}</span>
      <span className="min-w-0 whitespace-pre-wrap break-all text-foreground/80">{text === "" ? " " : text}</span>
    </div>
  );
  return (
    <div data-edit-lines className={cn("max-h-56 overflow-y-auto rounded-lg border border-border/60 py-1.5", CODE_CLASS)}>
      {parsed.old.split("\n").map((text, at) => line(text, "-", at))}
      {parsed.next.split("\n").map((text, at) => line(text, "+", at))}
    </div>
  );
}

/** The plan a turn asks to leave planning with, in the thread's own markdown, bounded so the options stay in reach. */
function PlanBody({ input, cwd, theme }: { input: string; cwd: string | undefined; theme: "light" | "dark" }) {
  const plan = ((): string | null => {
    try {
      const fields = JSON.parse(input) as Record<string, unknown>;
      return typeof fields["plan"] === "string" ? fields["plan"] : null;
    } catch {
      return null;
    }
  })();
  if (plan === null) return null;
  return (
    <div data-plan-body className="max-h-64 overflow-y-auto rounded-lg border border-border/60 px-4 py-3 text-sm">
      <ChatMarkdown text={plan} cwd={cwd} resolvedTheme={theme} />
    </div>
  );
}

function Hint({ glyph: Glyph, word, keys }: { glyph?: LucideIcon; word: string; keys?: readonly string[] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      {Glyph === undefined ? null : (
        <Kbd aria-hidden>
          <Glyph className="size-3" />
        </Kbd>
      )}
      {keys?.map(key => (
        <Kbd key={key} aria-hidden>
          {key}
        </Kbd>
      ))}
      {word}
    </span>
  );
}

function ArrowsHint() {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
      <Kbd aria-hidden>
        <ArrowUpIcon className="size-3" />
      </Kbd>
      <Kbd aria-hidden>
        <ArrowDownIcon className="size-3" />
      </Kbd>
      move
    </span>
  );
}

/** One row: its number as a key, the label, the sentence under it; a tick box at the end where the question takes
 * several; the field under it while it is the open row with one. */
function OptionRow({
  row,
  at,
  active,
  ticked,
  multi,
  field,
  onHover,
  onPick,
  onField,
}: {
  row: MenuRow;
  at: number;
  active: boolean;
  ticked: boolean;
  multi: boolean;
  field: { value: string; onChange: (value: string) => void; onSubmit: () => void } | null;
  onHover: () => void;
  onPick: () => void;
  onField: (el: HTMLInputElement | null) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      data-prompt-option={row.id}
      data-active={active || undefined}
      data-ticked={ticked || undefined}
      className={cn("flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg px-3 py-2 transition-colors duration-150", active && "bg-accent")}
      onMouseMove={onHover}
      onClick={onPick}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Kbd className={cn("mt-px shrink-0", active && "bg-background/60 text-foreground")}>{at + 1}</Kbd>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("text-sm leading-5", active || ticked ? "text-foreground" : "text-foreground/85")}>{row.label}</span>
          {row.description === "" ? null : <span className="text-xs leading-4 text-muted-foreground">{row.description}</span>}
        </span>
        {multi ? <Checkbox checked={ticked} tone="neutral" tabIndex={-1} className="mt-0.5" onCheckedChange={onPick} /> : null}
      </div>
      {field === null ? null : (
        <div className="ps-8" onClick={event => event.stopPropagation()}>
          <Input
            ref={onField}
            nativeInput
            size="sm"
            data-prompt-field
            value={field.value}
            placeholder={row.field?.placeholder}
            className="rounded-lg border border-input bg-(--input-fill) text-sm"
            onChange={event => field.onChange((event.target as HTMLInputElement).value)}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                field.onSubmit();
              }
              event.stopPropagation();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** A question answered earlier in the same prompt, as one quiet line a person can go back to. */
function AnsweredLine({ question, answer, onBack }: { question: AskedQuestion; answer: string; onBack: () => void }) {
  return (
    <button type="button" data-prompt-answered className="flex h-7 min-w-0 items-center gap-3 rounded-lg px-3 text-left transition-colors duration-150 hover:bg-accent" onClick={onBack}>
      <span className="w-28 shrink-0 truncate text-xs leading-4 text-muted-foreground">{question.header === "" ? question.question : question.header}</span>
      <span className="min-w-0 truncate text-sm leading-5 text-foreground/85">{answer}</span>
    </button>
  );
}

export function PromptDock({
  permission,
  agent,
  cwd,
  theme,
  onAnswer,
  onWriteInstead,
}: {
  permission: PermissionPrompt;
  /** The agent asking, whose mark heads the dock. */
  agent: string | null;
  cwd?: string;
  theme: "light" | "dark";
  onAnswer: (sessionId: string, askId: string, optionId: string) => void;
  /** Hands the composer back with the prompt folded to one line above it, for a person who wants to write first. */
  onWriteInstead?: () => void;
}) {
  const words = useMemo(() => permissionPromptWords(permission.toolName, permission.input, permission.detail), [permission]);
  const questions = words.questions;
  const consent = questions === undefined;
  // Which question is in hand, and the pick (or typed answer) each settled question holds.
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<ReadonlyArray<{ ids: string[]; typed?: string }>>(() => (questions ?? []).map(() => ({ ids: [] })));
  const question = questions?.[step];
  const multi = question?.multiSelect === true;
  const rows = useMemo<MenuRow[]>(
    () => (question !== undefined ? [...question.options.map(o => ({ id: o.id, label: o.label, description: o.description })), OTHER] : permission.options.map(o => ({ id: o.id, label: o.label, description: consentDescription(o), ...(o.effect === "deny" ? { field: DENY_FIELD } : {}) }))),
    [permission.options, question],
  );
  const [active, setActive] = useState(0);
  const [fieldOpen, setFieldOpen] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  const ticked = answers[step]?.ids ?? [];

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, [permission.askId]);
  useEffect(() => {
    if (fieldOpen !== null) fieldRef.current?.focus();
  }, [fieldOpen]);

  const answer = useCallback((optionId: string) => onAnswer(permission.sessionId, permission.askId, optionId), [onAnswer, permission.askId, permission.sessionId]);

  /** Every question's pick as the one id the prompt closes on; Other travels as the typed words. */
  const sendAll = useCallback(
    (settled: ReadonlyArray<{ ids: string[]; typed?: string }>) => {
      const ids = settled.flatMap(a => (a.typed !== undefined ? [`other:${a.typed}`] : a.ids));
      answer(pickedOptionId(ids));
    },
    [answer],
  );

  const settle = useCallback(
    (picked: { ids: string[]; typed?: string }) => {
      if (questions === undefined) return;
      const next = answers.map((a, at) => (at === step ? picked : a));
      setAnswers(next);
      setFieldOpen(null);
      setTyped("");
      if (step + 1 < questions.length) {
        setStep(step + 1);
        setActive(0);
      } else sendAll(next);
    },
    [answers, questions, sendAll, step],
  );

  const pick = useCallback(
    (at: number) => {
      const row = rows[at];
      if (row === undefined) return;
      setActive(at);
      if (consent) {
        if (row.field !== undefined && fieldOpen !== row.id) {
          setFieldOpen(row.id);
          return;
        }
        answer(row.id);
        return;
      }
      if (row.id === OTHER.id) {
        if (fieldOpen !== row.id) {
          setFieldOpen(row.id);
          return;
        }
        if (typed.trim() !== "") settle({ ids: [], typed: typed.trim() });
        return;
      }
      if (multi) {
        const ids = ticked.includes(row.id) ? ticked.filter(id => id !== row.id) : [...ticked, row.id];
        setAnswers(answers.map((a, i) => (i === step ? { ids } : a)));
        return;
      }
      settle({ ids: [row.id] });
    },
    [answer, answers, consent, fieldOpen, multi, rows, settle, step, ticked, typed],
  );

  const submitField = useCallback(() => {
    const row = rows.find(r => r.id === fieldOpen);
    if (row === undefined) return;
    if (consent) answer(row.id);
    else if (typed.trim() !== "") settle({ ids: [], typed: typed.trim() });
  }, [answer, consent, fieldOpen, rows, settle, typed]);

  const answerMulti = useCallback(() => {
    if (ticked.length > 0) settle({ ids: ticked });
  }, [settle, ticked]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLInputElement) return;
    const { key } = event;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      setActive(a => (a + (key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
      if (fieldOpen !== null) setFieldOpen(null);
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

  const lead = useMemo(() => dockLead(permission), [permission]);
  const open = isPromptOpen(permission);
  if (!open) return null;
  const count = questions !== undefined && questions.length > 1 ? `${step + 1} of ${questions.length}` : null;

  return (
    <div className="px-3 pb-3 sm:px-4 sm:pb-4">
      <ComposerSurface.Shell data-prompt-dock={permission.askId}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div
              ref={rootRef}
              tabIndex={-1}
              role="listbox"
              aria-label={question === undefined ? lead.says : question.question}
              className="flex min-w-0 flex-col gap-3 px-3 pt-3.5 pb-3 outline-none sm:px-4 sm:pt-4 sm:pb-3.5"
              onKeyDown={onKeyDown}
            >
              {/* The head: who asks, the header the harness gave, the count where there are several questions. */}
              <div className="flex min-w-0 flex-col gap-1 px-3">
                <div className="flex min-w-0 items-center gap-2">
                  {agent === null ? null : (
                    <span className="inline-flex shrink-0 text-muted-foreground">
                      <HarnessMark harness={agent} label={agentName(agent)} className="size-3" />
                    </span>
                  )}
                  <span data-prompt-header className="min-w-0 flex-1 truncate text-[11px] leading-4 text-muted-foreground">
                    {question !== undefined ? (question.header === "" ? "Question" : question.header) : consentKind(permission.toolName)}
                  </span>
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
                ) : lead.code === undefined ? (
                  <span data-prompt-says className="break-words text-sm leading-5 text-foreground">
                    {lead.says}
                  </span>
                ) : (
                  <div className="flex min-w-0 items-start gap-1.5">
                    <span data-prompt-says className="shrink-0 text-sm leading-5 text-foreground">
                      {lead.says}
                    </span>
                    <code data-prompt-code className={cn("min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-normal py-0.5", CODE_CLASS)}>
                      {commandParts(lead.code)}
                    </code>
                  </div>
                )}
                {lead.rest === "" ? null : <span className={cn("break-words whitespace-pre-wrap text-muted-foreground", CODE_CLASS)}>{lead.rest}</span>}
              </div>
              {permission.toolName === "Edit" || permission.toolName === "MultiEdit" ? (
                <div className="px-3">
                  <EditLines input={permission.input} />
                </div>
              ) : null}
              {permission.toolName === "ExitPlanMode" ? (
                <div className="px-3">
                  <PlanBody input={permission.input} cwd={cwd} theme={theme} />
                </div>
              ) : null}
              {lead.body === undefined ? null : (
                <div className="px-3">
                  <details className="group">
                    <summary className="cursor-pointer list-none text-xs leading-4 text-muted-foreground hover:text-foreground">{lead.body.label}</summary>
                    <pre className={cn("mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground", CODE_CLASS)}>{lead.body.text}</pre>
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
                      answer={answers[at]?.typed ?? (answers[at]?.ids ?? []).map(id => q.options.find(o => o.id === id)?.label ?? id).join(", ")}
                      onBack={() => {
                        setStep(at);
                        setActive(0);
                      }}
                    />
                  ))}
                </div>
              ) : null}
              <div className="flex flex-col" data-prompt-options>
                {rows.map((row, at) => (
                  <OptionRow
                    key={row.id}
                    row={row}
                    at={at}
                    active={at === active}
                    ticked={ticked.includes(row.id)}
                    multi={multi && row.id !== OTHER.id}
                    field={fieldOpen === row.id ? { value: typed, onChange: setTyped, onSubmit: submitField } : null}
                    onHover={() => setActive(at)}
                    onPick={() => pick(at)}
                    onField={el => {
                      fieldRef.current = el;
                    }}
                  />
                ))}
              </div>
              {/* The foot: the keys, and the one button a pick alone cannot stand for. */}
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-3">
                <ArrowsHint />
                {multi ? <Hint keys={["space"]} word="tick" /> : null}
                <Hint glyph={CornerDownLeftIcon} word={multi ? "answer" : fieldOpen !== null ? "send" : "pick"} />
                <span className="ms-auto flex items-center gap-2">
                  {onWriteInstead === undefined ? null : (
                    <Button size="xs" variant="ghost" data-prompt-write onClick={onWriteInstead}>
                      Write a message instead
                    </Button>
                  )}
                  {multi ? (
                    <Button size="xs" variant="default" data-prompt-answer held={ticked.length === 0} onClick={answerMulti}>
                      {questions !== undefined && step + 1 < questions.length ? "Next" : "Answer"}
                    </Button>
                  ) : null}
                </span>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </div>
  );
}

/** The sentence under a consent option, since the harness sends a label alone. */
function consentDescription(option: PermissionOption): string {
  switch (option.effect) {
    case "allow":
      return "Runs this call now and asks again next time.";
    case "deny":
      return "Refuses the call; the agent reads that you did.";
    case "mode":
      return `Runs it and stops asking: the rest of the turn runs with ${option.mode === "acceptEdits" ? "edits accepted" : option.mode ?? "that access"}.`;
    case "answer":
      return "";
    default: {
      const _exhaustive: never = option.effect;
      return "";
    }
  }
}

/** The prompt folded to one line over the composer, for the person who chose to write first: what is asked and the
 * way back to the menu. */
export function PromptStrip({ permission, onOpen }: { permission: PermissionPrompt; onOpen: () => void }) {
  const words = permissionPromptWords(permission.toolName, permission.input, permission.detail);
  const line = words.questions !== undefined ? words.questions[0]!.question : words.lead;
  return (
    <div className="mx-auto flex h-8 w-full max-w-3xl min-w-0 items-center gap-3 px-6 text-xs leading-4 text-muted-foreground sm:px-7" data-prompt-strip>
      <span className="shrink-0">Waiting on you</span>
      <span className="min-w-0 flex-1 truncate text-foreground/85">{line}</span>
      <Button size="xs" variant="outline" onClick={onOpen}>
        Answer
      </Button>
    </div>
  );
}
