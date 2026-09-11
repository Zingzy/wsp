// SPDX-License-Identifier: AGPL-3.0-only
// The build as stages, in the order the job runs them: a 2 px line along the
// card's top edge filled by the stages done, the count beside the title, each
// stage with the machine's latest lines under the one running in a block as
// tall as its lines up to eight (a done stage folds and opens on a click), the
// stages the provider says nothing during counting their own seconds in the
// slot, the sign-ins one stage whose sub-rows are the sign-ins with the keycap
// that opens each page and, where a page hands a code back, the field that
// takes it, then the first workspace and its project. While the sign-in stage
// runs the screen is a slide with room to act: its own title, the stage list
// folded to one line, one 48 px row per sign-in, and under a row the person
// has something to do on, one 40 px action line with the code in 20 px mono,
// the keycap and the protocol's sentence; the list comes back when the last
// sign-in settles. Closing the screen hides it and the build goes on; the one
// link stops the job after asking once.
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, SIGN_IN_STAGE_ID, initBuildRows, initElapsedLine, initJobBuilding, initJobOver, initRowFailed, initRowOver, initRowTimed, initRowUnrun, initSignInLine, initStageCount, initStageCountLine, type InitJob, type InitRow } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { ansiSpans, toolPrefix } from "./ansi.js";
import { Card, META, NAME, ROW, ROW_LINE, RowState, Slot } from "./rows.js";
import { SignInCode } from "./SignInCode.js";
import { RowMark, hasRowMark } from "./SignInMark.js";
import { SetupScreen, type ScreenAction } from "./SetupScreen.js";

/** The most lines the open stage's block shows at once: eight, six under a 700 px window; fewer lines make a shorter
 * block, never an empty band. */
export const STAGE_BLOCK_LINES = 8;
export const STAGE_BLOCK_LINES_SHORT = 6;
const LINE_HEIGHT = 20;
/** The block's height for its lines: 20 px each with 8 px above and below, so eight lines are 176 px. */
export const stageBlockHeight = (lines: number, most = STAGE_BLOCK_LINES): number => Math.max(1, Math.min(lines, most)) * LINE_HEIGHT + 16;
/** The height rides two variables the block sets from its lines, so the short window's cap is the stylesheet's. */
const STAGE_BLOCK = "h-[calc(var(--stage-lines)*20px+16px)] [@media(max-height:699px)]:h-[calc(var(--stage-lines-short)*20px+16px)]";
/** The action line under a sign-in the person has something to do on, and the inset that puts it under the name. */
const ACT_LINE = "flex h-10 items-center gap-3 pb-2 pl-[46px] pr-[10px]";

/** A stage the machine is on: working, or queueing behind the account's machine cap, which is the same row open on
 * the same block, saying so. */
const onIt = (state: string): boolean => state === INIT_ROW_STATES.running || state === INIT_ROW_STATES.slot;

export function SetupBuild({ job, onCancel, onRetry, onCode, onOpenWorkspace, onAgain, onChangeKey, refusal }: { job: InitJob; onCancel: () => void; onRetry: (tool: string) => void; onCode: (o: { tool: string; code: string }) => void; onOpenWorkspace: () => void; onAgain: () => void; onChangeKey: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.build;
  const [asking, setAsking] = useState(false);
  const over = initJobOver(job.phase);
  const building = initJobBuilding(job.phase);
  const headline = job.phase === "done" ? words.done : job.phase === "cancelled" ? words.stopped : over ? words.failed : words.headline;
  const { rows, signIns } = initBuildRows(job.rows);
  const count = initStageCount(rows);
  const fraction = count.total > 0 ? count.done / count.total : 0;
  const signInStage = rows.find(r => r.id === SIGN_IN_STAGE_ID);
  const slide = building && signInStage !== undefined && (signInStage.state === INIT_ROW_STATES.open || signInStage.state === INIT_ROW_STATES.running);
  // The one row the card keeps in view, as the screen appears and whenever it changes: a sign-in to retry first, else the stage that runs or failed, else a machine still being removed, which is the one row left on a stopped screen that is still costing money; on the slide, the first sign-in waiting on the person.
  const attention = building && signIns.some(s => s.login === "not-signed-in");
  const focusId = attention && signInStage !== undefined ? signInStage.id : (rows.find(r => onIt(r.state) || r.state === INIT_ROW_STATES.failed) ?? rows.find(r => r.state === INIT_ROW_STATES.retrying))?.id;
  const slideFocusId = (signIns.find(s => s.state === INIT_ROW_STATES.open) ?? signIns.find(s => s.login === "not-signed-in"))?.id;
  // A saved key the provider refused offers the step that fixes it, not another build off the same key.
  const primary: ScreenAction | undefined =
    job.phase === "done" && job.workspace !== undefined ? { word: words.keycap, onPress: onOpenWorkspace } : job.keyRefused === true ? { word: CLOUD_SETUP_WORDS.keys.changeKey, onPress: onChangeKey } : job.phase === "failed" || job.phase === "cancelled" ? { word: words.again, onPress: onAgain } : undefined;
  const secondary: ScreenAction | undefined = building
    ? asking
      ? { word: words.cancelSure, onPress: onCancel, destructive: true }
      : { word: words.cancel, onPress: () => setAsking(true), destructive: true, disabled: !job.stoppable, ...(job.stoppable ? {} : { title: words.cannotStop }) }
    : undefined;
  // The question is one block in the footer: the sentence above, Stop the build and Keep building side by side under it.
  const aside: ScreenAction | undefined = asking && building ? { word: words.cancelKeep, onPress: () => setAsking(false) } : undefined;
  const footer = { ...(secondary !== undefined ? { secondary } : {}), ...(aside !== undefined ? { aside } : {}) };
  if (slide) {
    return (
      <SetupScreen k="build" headline={words.slideHeadline} top={words.slideTop} refusal={refusal} {...footer} note={asking ? words.cancelWhy : words.keeps}>
        <p data-k="stages-folded" className={cn(META, "mb-2 w-full text-right")}>
          {words.headline} · {initStageCountLine(count)}
        </p>
        <Card label={words.slideHeadline} cap={false}>
          {signIns.map(s => (
            <SignInSlideRow key={s.id} row={s} marked={marked(signIns)} focus={s.id === slideFocusId} onRetry={s.login === "not-signed-in" ? () => onRetry(s.tool ?? s.id) : undefined} onCode={s.finish === "code" ? code => onCode({ tool: s.tool ?? s.id, code }) : undefined} />
          ))}
        </Card>
      </SetupScreen>
    );
  }
  return (
    <SetupScreen k="build" headline={headline} top={job.error ?? (job.phase === "done" ? words.doneTop : words.top)} refusal={refusal} {...(primary !== undefined ? { primary } : {})} {...footer} {...(building ? { note: asking ? words.cancelWhy : words.keeps } : {})}>
      <p data-k="count" className={cn(META, "mb-2 w-full text-right")}>
        {initStageCountLine(count)}
      </p>
      <Card
        label={words.headline}
        top={
          <span role="progressbar" aria-label={headline} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} data-k="progress" className="block h-0.5 w-full shrink-0 bg-muted-foreground/20">
            <span className="block h-full bg-foreground/70 transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </span>
        }
      >
        {rows.map(row => (
          <BuildRow
            key={row.id}
            row={row}
            focus={row.id === focusId}
            signIns={row.id === SIGN_IN_STAGE_ID ? signIns : undefined}
            onRetry={building ? tool => onRetry(tool) : undefined}
            onCode={(tool, code) => onCode({ tool, code })}
          />
        ))}
      </Card>
    </SetupScreen>
  );
}

/** Whether any sign-in in a card leads with a mark, in which case every row in it reserves the column so the names
 * start at one x; a tool without a mark leaves its slot empty. */
const marked = (signIns: readonly InitRow[]): boolean => signIns.some(s => s.tool !== undefined && hasRowMark(s.tool));

/** The mark's column on a sign-in row: the tool's mark where it has one, the same 18 px of nothing where it does not. */
function MarkColumn({ tool }: { tool: string | undefined }) {
  return (
    <span aria-hidden data-k="mark-column" className="flex size-[18px] shrink-0 items-center justify-center">
      {tool !== undefined ? <RowMark id={tool} /> : null}
    </span>
  );
}

/** One sign-in on the slide: a 48 px line with the mark's column, the name and the state word at its right, and only
 * where the person has something to do, one 40 px action line under it, left under the name: the one-time code in
 * 20 px mono, the keycap that opens the page or retries, the field for a page that hands a code back, and the
 * protocol's sentence for what the machine waits on. Nothing else changes a row's height, and nothing the machine
 * ran reaches the row. */
function SignInSlideRow({ row, marked, focus, onRetry, onCode }: { row: InitRow; marked: boolean; focus: boolean; onRetry?: () => void; onCode?: (code: string) => void }) {
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focus) item.current?.scrollIntoView({ block: "start" });
  }, [focus]);
  const waiting = row.state === INIT_ROW_STATES.open;
  const acts = (waiting && (row.code !== undefined || row.page !== undefined || onCode !== undefined)) || onRetry !== undefined;
  const line = initSignInLine(row);
  return (
    <li ref={item} data-k="signin" data-row={row.id} data-state={row.state} data-acts={acts} className={ROW_LINE}>
      <div className={ROW}>
        {marked ? <MarkColumn tool={row.tool} /> : null}
        <span className={NAME}>{row.label}</span>
        <Slot>
          <RowState state={row.state} />
        </Slot>
      </div>
      {acts ? (
        <div data-k="act" className={cn(ACT_LINE, !marked && "pl-4")}>
          {waiting && row.code !== undefined ? (
            <span data-k="code" className="shrink-0 whitespace-nowrap font-mono text-[20px] leading-7 tabular-nums tracking-[0.04em] text-foreground">
              {row.code}
            </span>
          ) : null}
          {waiting && row.page !== undefined ? (
            <Button data-k="open" size="sm" variant="outline" className="h-7 shrink-0 font-mono text-xs sm:h-7 sm:text-xs" render={<a href={row.page} target="_blank" rel="noopener noreferrer" />}>
              {CLOUD_SETUP_WORDS.build.open}
              <span aria-hidden>↗</span>
            </Button>
          ) : null}
          {onRetry !== undefined ? (
            <Button data-k="retry" size="sm" variant="outline" className="h-7 shrink-0 font-mono text-xs sm:h-7 sm:text-xs" onClick={onRetry}>
              {CLOUD_SETUP_WORDS.build.retry}
            </Button>
          ) : null}
          {waiting && onCode !== undefined ? (
            <SignInCode label={row.label} onCode={onCode} />
          ) : line !== undefined ? (
            <span data-k="why" className={cn(META, "min-w-0 truncate")}>
              {line}
            </span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The seconds a stage has run, ticking once a second, for the stages the provider says nothing during. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, []);
  return (
    <span data-k="elapsed" className={META}>
      {initElapsedLine(Math.max(0, now - since))}
    </span>
  );
}

/** A stage's lines open under the running row on their own; a done row's open on a click and fold on the next. The
 * sign-in stage opens on its sub-rows the same way, on its own while the person is waited on. */
function BuildRow({ row, focus, signIns, onRetry, onCode }: { row: InitRow; focus: boolean; signIns?: InitRow[]; onRetry?: (tool: string) => void; onCode: (tool: string, code: string) => void }) {
  const [opened, setOpened] = useState<boolean | undefined>(undefined);
  const item = useRef<HTMLLIElement>(null);
  const running = onIt(row.state);
  const waitedOn = row.state === INIT_ROW_STATES.open;
  const failed = row.state === INIT_ROW_STATES.failed;
  const lines = row.lines ?? [];
  const has = signIns !== undefined ? signIns.length > 0 : lines.length > 0;
  const live = running || waitedOn;
  // A sign-in that ran out while the build goes on has a Retry to show, so its stage opens on its own too.
  const attention = onRetry !== undefined && signIns?.some(s => s.login === "not-signed-in") === true;
  // A running stage and the sign-ins being waited on are open and stay so; a failed one, or one with a sign-in to retry, opens on its own and folds on a click; a done one opens on a click.
  const canOpen = row.kind === "stage" && has && !live;
  const open = has && (live || (opened ?? (failed || attention)));
  // The row to act on or watch heads the card's view as the screen appears.
  useEffect(() => {
    if (focus) item.current?.scrollIntoView({ block: "start" });
  }, [focus]);
  return (
    <li ref={item} data-k="row" data-row={row.id} data-state={row.state} data-open={open} className={ROW_LINE}>
      <div className={cn(ROW, canOpen && "cursor-pointer hover:bg-accent/30")} title={row.detail} onClick={canOpen ? () => setOpened(!open) : undefined} role={canOpen ? "button" : undefined} aria-expanded={canOpen ? open : undefined}>
        <span data-k="glyph" aria-hidden className="flex size-[18px] shrink-0 items-center justify-center text-foreground">
          <StageGlyph row={row} />
        </span>
        <span className={cn(NAME, row.state === INIT_ROW_STATES.waiting && "text-muted-foreground")}>{row.label}</span>
        <Slot>
          {running && row.since !== undefined && initRowTimed(row) ? <Elapsed since={row.since} /> : null}
          <RowState state={row.state} />
          {canOpen ? <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", !open && "-rotate-90")} /> : null}
        </Slot>
      </div>
      {open && signIns !== undefined ? (
        <ul data-k="sign-ins" className="border-t border-border">
          {signIns.map(s => (
            <SignInRow key={s.id} row={s} marked={marked(signIns)} onRetry={onRetry !== undefined && s.login === "not-signed-in" ? () => onRetry(s.tool ?? s.id) : undefined} onCode={s.finish === "code" ? code => onCode(s.tool ?? s.id, code) : undefined} />
          ))}
        </ul>
      ) : null}
      {open && signIns === undefined ? <StageLines lines={lines} running={running} failed={failed} /> : null}
    </li>
  );
}

/** One sign-in under its stage, indented a step: the mark's column, the name, the code the page asks for, and in the
 * slot the keycap that opens the page or retries, then the state word. What the machine ran stays off the row. */
function SignInRow({ row, marked, onRetry, onCode }: { row: InitRow; marked: boolean; onRetry?: () => void; onCode?: (code: string) => void }) {
  const waiting = row.state === INIT_ROW_STATES.open;
  return (
    <li data-k="row" data-row={row.id} data-state={row.state} className={cn(ROW_LINE, "first:border-t-0")}>
      <div className={cn(ROW, "pl-10")}>
        {marked ? <MarkColumn tool={row.tool} /> : null}
        <span className={NAME}>{row.label}</span>
        {waiting && row.code !== undefined ? (
          <span data-k="code" className={cn(META, "text-foreground")}>
            {row.code}
          </span>
        ) : null}
        <Slot>
          {waiting && row.page !== undefined ? (
            <Button data-k="open" size="sm" variant="outline" className="h-7 font-mono text-xs sm:h-7 sm:text-xs" render={<a href={row.page} target="_blank" rel="noopener noreferrer" />}>
              {CLOUD_SETUP_WORDS.build.open}
              <span aria-hidden>↗</span>
            </Button>
          ) : null}
          {onRetry !== undefined ? (
            <Button data-k="retry" size="sm" variant="outline" className="h-7 font-mono text-xs sm:h-7 sm:text-xs" onClick={onRetry}>
              {CLOUD_SETUP_WORDS.build.retry}
            </Button>
          ) : null}
          <RowState state={row.state} />
        </Slot>
      </div>
      {waiting && onCode !== undefined ? <SignInCode label={row.label} onCode={onCode} className={cn(ROW, "border-t border-border pl-10")} /> : null}
    </li>
  );
}

/** The open stage's block: as tall as its lines, one to eight (six under a 700 px window), scrolling inside itself
 * and pinned to the newest line while the stage runs. Terminal output, coloured as such: a tool's prefix dimmed, the
 * machine's own colours kept, a failed stage's last line in the danger tone, the rest the muted foreground. */
function StageLines({ lines, running, failed }: { lines: string[]; running: boolean; failed: boolean }) {
  const block = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (running && block.current !== null) block.current.scrollTop = block.current.scrollHeight;
  }, [lines.length, running]);
  const shown = { "--stage-lines": Math.max(1, Math.min(lines.length, STAGE_BLOCK_LINES)), "--stage-lines-short": Math.max(1, Math.min(lines.length, STAGE_BLOCK_LINES_SHORT)) } as CSSProperties;
  // The padding sits outside the scrolling part (7 px over it under the hairline, 8 under), so the scroller is exactly the lines' height and a block pinned to its newest line shows whole lines, no sliver of the one before.
  return (
    <div data-k="lines" data-lines={lines.length} style={shown} className={cn("border-t border-border bg-background/40 pt-[7px] pb-2", STAGE_BLOCK)}>
      <pre ref={block} data-k="lines-scroll" className="h-full overflow-y-auto whitespace-pre-wrap break-words pl-[46px] pr-[10px] font-mono text-xs leading-[20px] text-muted-foreground">
        {lines.map((line, i) => (
          <TerminalLine key={i} line={line} danger={failed && i === lines.length - 1} />
        ))}
      </pre>
    </div>
  );
}

function TerminalLine({ line, danger }: { line: string; danger: boolean }) {
  const prefixed = toolPrefix(line);
  const spans = ansiSpans(prefixed?.rest ?? line);
  return (
    <span data-k="line" data-tone={danger ? "danger" : undefined} className={cn("block", danger && "text-destructive-foreground")}>
      {prefixed !== undefined ? <span className="opacity-60">{prefixed.prefix}</span> : null}
      {spans.map((s, i) => (
        <span key={i} className={s.className}>
          {s.text}
        </span>
      ))}
    </span>
  );
}

/** A stage's, a workspace's or a machine's glyph: a hollow ring while it waits, nothing while it runs (the slot's
 * spinner says so), a filled dot while a machine is still being removed, a check once it ended well, a cross when
 * it failed, the sign-in stage with a run-out included. A row that ended without running keeps the ring it waited
 * with: it is over, but a check beside it would read as work that happened. */
function StageGlyph({ row }: { row: Pick<InitRow, "state" | "login"> }) {
  if (initRowUnrun(row.state)) return <span data-glyph="ring" className="size-2 rounded-full border border-muted-foreground/60" />;
  if (row.state === INIT_ROW_STATES.retrying) return <span data-glyph="dot" className="size-2 rounded-full bg-foreground" />;
  if (initRowFailed(row)) {
    return (
      <svg data-glyph="failed" viewBox="0 0 16 16" className="size-3.5 fill-none stroke-destructive-foreground" strokeWidth={1.75} strokeLinecap="round">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    );
  }
  if (initRowOver(row)) {
    return (
      <svg data-glyph="done" viewBox="0 0 16 16" className="size-3.5 fill-none stroke-current" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 8.5 6.5 11.5 12.5 5" />
      </svg>
    );
  }
  if (onIt(row.state) || row.state === INIT_ROW_STATES.open) return <span data-glyph="dot" className="size-2 rounded-full bg-foreground" />;
  return <span data-glyph="ring" className="size-2 rounded-full border border-muted-foreground/60" />;
}
