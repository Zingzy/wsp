// SPDX-License-Identifier: AGPL-3.0-only
// The build as rows, in the order the job runs them: the agents here given the
// tools, each stage of the image with the machine's latest lines under the one
// running (a done stage folds to its row and opens on a click), each sign-in
// where it happens with the keycap that opens its page, the first workspace and
// its project. The bar at the top moves to the count. Closing the screen hides
// it and the build goes on; the one link stops the job after asking once.
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, INIT_SIGN_IN_WORDS, initJobBuilding, initJobOver, initProgressState, initRowOver, type InitJob, type InitRow } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { CARD, META, NAME, ROW, ROW_LINE, RowState, Slot } from "./rows.js";
import { RowMark } from "./SignInMark.js";
import { SetupScreen, type ScreenAction } from "./SetupScreen.js";

export function SetupBuild({ job, onCancel, onRetry, onOpenWorkspace, onAgain, refusal }: { job: InitJob; onCancel: () => void; onRetry: (tool: string) => void; onOpenWorkspace: () => void; onAgain: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.build;
  const [asking, setAsking] = useState(false);
  const over = initJobOver(job.phase);
  const building = initJobBuilding(job.phase);
  const headline = job.phase === "done" ? words.done : over ? words.failed : words.headline;
  const { fraction } = initProgressState(job);
  const primary: ScreenAction | undefined = job.phase === "done" && job.workspace !== undefined ? { word: words.keycap, onPress: onOpenWorkspace } : job.phase === "failed" || job.phase === "cancelled" ? { word: words.again, onPress: onAgain } : undefined;
  const secondary: ScreenAction | undefined = building
    ? asking
      ? { word: words.cancelSure, onPress: onCancel, destructive: true }
      : { word: words.cancel, onPress: () => setAsking(true), destructive: true, disabled: !job.stoppable, ...(job.stoppable ? {} : { title: words.cannotStop }) }
    : undefined;
  return (
    <SetupScreen k="build" label={words.label} headline={headline} top={job.error ?? words.top} refusal={refusal} {...(primary !== undefined ? { primary } : {})} {...(secondary !== undefined ? { secondary } : {})} {...(building ? { note: asking ? words.cancelWhy : words.keeps } : {})}>
      <span role="progressbar" aria-label={headline} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} data-k="progress" className="mb-3 block h-1 w-full overflow-hidden rounded-full bg-border">
        <span className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
      <ul className={CARD} aria-label={words.headline}>
        {job.rows.map(row => (
          <BuildRow key={row.id} row={row} onRetry={building && row.kind === "sign-in" && row.state === INIT_SIGN_IN_WORDS["not-signed-in"] ? () => onRetry(row.tool ?? row.id) : undefined} />
        ))}
      </ul>
      {asking && building ? (
        <div className="mt-3 flex justify-center">
          <Button data-k="keep" variant="link" className="h-auto p-0 text-[13px] text-muted-foreground hover:text-foreground sm:text-[13px]" onClick={() => setAsking(false)}>
            {words.cancelKeep}
          </Button>
        </div>
      ) : null}
    </SetupScreen>
  );
}

/** A stage's lines open under the running row on their own; a done row's open on a click and fold on the next. */
function BuildRow({ row, onRetry }: { row: InitRow; onRetry?: () => void }) {
  const [opened, setOpened] = useState<boolean | undefined>(undefined);
  const running = row.state === INIT_ROW_STATES.running;
  const lines = row.lines ?? [];
  const canOpen = row.kind === "stage" && lines.length > 0 && !running;
  const open = running ? lines.length > 0 : canOpen && opened === true;
  const waiting = row.kind === "sign-in" && row.state === INIT_ROW_STATES.open;
  return (
    <li data-k="row" data-row={row.id} data-state={row.state} data-open={open} className={ROW_LINE}>
      <div className={cn(ROW, canOpen && "cursor-pointer hover:bg-accent/30")} title={row.detail} onClick={canOpen ? () => setOpened(o => !(o === true)) : undefined} role={canOpen ? "button" : undefined} aria-expanded={canOpen ? open : undefined}>
        <span aria-hidden className="flex size-[18px] shrink-0 items-center justify-center text-foreground">
          {row.tool !== undefined ? <RowMark id={row.tool} label={row.label} /> : <StageGlyph state={row.state} />}
        </span>
        <span className={cn(NAME, row.state === INIT_ROW_STATES.waiting && "text-muted-foreground")}>{row.label}</span>
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
          {canOpen ? <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", !open && "-rotate-90")} /> : null}
        </Slot>
      </div>
      {open ? (
        <pre data-k="lines" className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-t border-border bg-background/40 py-2 pl-[46px] pr-[10px] font-mono text-[11px] leading-[1.6] text-muted-foreground">
          {lines.join("\n")}
        </pre>
      ) : null}
    </li>
  );
}

/** A stage's or a workspace row's glyph: a hollow ring while it waits, nothing while it runs (the slot's spinner says
 * so), a check once it ended well, a cross when it failed. */
function StageGlyph({ state }: { state: string }) {
  if (state === INIT_ROW_STATES.failed) {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 fill-none stroke-destructive-foreground" strokeWidth={1.75} strokeLinecap="round">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
      </svg>
    );
  }
  if (initRowOver(state)) {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 fill-none stroke-current" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 8.5 6.5 11.5 12.5 5" />
      </svg>
    );
  }
  if (state === INIT_ROW_STATES.running) return <span className="size-2 rounded-full bg-foreground" />;
  return <span className="size-2 rounded-full border border-muted-foreground/60" />;
}
