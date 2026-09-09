// SPDX-License-Identifier: AGPL-3.0-only
// The build as rows: the image's stages, the sign-ins with the page each one
// waits on and the company's mark, the first workspace and its project. Each
// group folds under its caps label; the one line above them reads the phase
// and the count over a thin bar. Nothing here blocks: Hide shuts the modal and
// the sidebar's row carries the same line.
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { CLOUD_SETUP_WORDS, INIT_ROW_STATES, LOGIN_STATE_WORDS, initJobBuilding, initJobOver, initProgressLine, initProgressState, initRowOver, type InitJob, type InitRow } from "@wsp/protocol";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { CARD, MICRO_LABEL, ROW, ROW_LINE, STATE_WORD, SetupFrame } from "./grammar.js";
import { SignInMark } from "./SignInMark.js";

export function SetupBuild({ job, onHide, onCancel, onOpenWorkspace, onAgain, refusal }: { job: InitJob; onHide: () => void; onCancel: () => void; onOpenWorkspace: () => void; onAgain: () => void; refusal: string | null }) {
  const words = CLOUD_SETUP_WORDS.build;
  const stages = job.rows.filter(r => r.kind === "stage");
  const signIns = job.rows.filter(r => r.kind === "sign-in");
  const agents = job.rows.filter(r => r.kind === "agent");
  const rest = job.rows.filter(r => r.kind === "workspace" || r.kind === "project");
  const over = initJobOver(job.phase);
  const headline = job.phase === "done" ? words.done : over ? words.failed : words.headline;
  const { fraction } = initProgressState(job);
  return (
    <SetupFrame
      k="build"
      label={words.label}
      headline={headline}
      {...(job.phase === "done" && job.workspace !== undefined ? { primary: { word: words.keycap, onPress: onOpenWorkspace } } : {})}
      {...(job.phase === "failed" || job.phase === "cancelled" ? { primary: { word: words.again, onPress: onAgain } } : {})}
      secondary={{ word: words.hide, onPress: onHide }}
      refusal={refusal}
    >
      <div data-k="progress" className="flex flex-col gap-1.5 px-1 pb-3">
        <p role="status" data-k="progress-line" className={STATE_WORD}>
          {initProgressLine(job)}
        </p>
        <span role="progressbar" aria-label={initProgressLine(job)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)} className="block h-1 w-full overflow-hidden rounded-full bg-border">
          <span className="block h-full rounded-full bg-foreground/70 transition-[width] duration-300" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </span>
        {job.error !== undefined ? (
          <p data-k="error" className="break-words font-mono text-[11px] text-destructive-foreground">
            {job.error}
          </p>
        ) : null}
      </div>
      <div className={CARD}>
        <Section k="image" label={words.image} rows={stages} open={!over && signIns.every(r => r.state !== INIT_ROW_STATES.open)} />
        {signIns.length > 0 ? <Section k="sign-ins" label={words.signIns} rows={signIns} open /> : null}
        {agents.length > 0 ? <Section k="computer" label={words.computer} rows={agents} open /> : null}
        {rest.length > 0 ? <Section k="workspace" label={words.workspace} rows={rest} open /> : null}
      </div>
      {initJobBuilding(job.phase) ? (
        <div className="flex justify-center pt-3">
          <Button data-k="cancel" variant="link" size="sm" className="text-muted-foreground" onClick={onCancel}>
            {words.cancel}
          </Button>
        </div>
      ) : null}
    </SetupFrame>
  );
}

/** A group of rows under its caps label, folded or open. The fold follows the job as it moves (the image folds
 * when a sign-in's page arrives) and a click moves it until the job moves again. */
function Section({ k, label, rows, open: follow }: { k: string; label: string; rows: readonly InitRow[]; open: boolean }) {
  const [open, setOpen] = useState(follow);
  useEffect(() => setOpen(follow), [follow]);
  const done = rows.filter(r => initRowOver(r.state)).length;
  return (
    <section data-k={k} data-open={open} className={ROW_LINE}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className={cn(ROW, "h-8 w-full cursor-pointer text-left hover:bg-accent/30")}>
        <ChevronDownIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", !open && "-rotate-90")} />
        <span className={cn(MICRO_LABEL, "flex-1")}>{label}</span>
        <span className={STATE_WORD}>
          {done}/{rows.length}
        </span>
      </button>
      {open ? (
        <ul>
          {rows.map(row => (
            <BuildRow key={row.id} row={row} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function BuildRow({ row }: { row: InitRow }) {
  const open = row.kind === "sign-in" && row.state === INIT_ROW_STATES.open;
  return (
    <li data-k="row" data-row={row.id} data-state={row.state} className={cn(ROW, "border-t border-border/40")} title={row.detail}>
      <span aria-hidden className="flex size-4 shrink-0 items-center justify-center text-foreground">
        {row.tool !== undefined ? <SignInMark tool={row.tool} label={row.label} /> : <StateGlyph state={row.state} />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate text-sm", row.state === INIT_ROW_STATES.waiting ? "text-muted-foreground" : "text-foreground")}>{row.label}</span>
      {open && row.code !== undefined ? (
        <span data-k="code" className={cn(STATE_WORD, "text-foreground")}>
          {row.code}
        </span>
      ) : null}
      {open && row.page !== undefined ? (
        <Button data-k="open" size="xs" variant="outline" render={<a href={row.page} target="_blank" rel="noopener noreferrer" />}>
          {CLOUD_SETUP_WORDS.build.open}
          <span aria-hidden>↗</span>
        </Button>
      ) : (
        <span data-k="state" className={cn(STATE_WORD, row.state === INIT_ROW_STATES.failed && "text-destructive-foreground")}>
          {row.state}
        </span>
      )}
    </li>
  );
}

/** A stage's or a workspace row's glyph: a hollow ring while it waits, a filled dot while it runs, a tick once it
 * ended well, a cross when it failed. */
function StateGlyph({ state }: { state: string }): ReactNode {
  if (state === INIT_ROW_STATES.failed || state === LOGIN_STATE_WORDS["not-signed-in"]) {
    return (
      <svg viewBox="0 0 16 16" className="size-3.5 fill-none stroke-destructive" strokeWidth={1.75} strokeLinecap="round">
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
  if (state === INIT_ROW_STATES.waiting) return <span className="size-2 rounded-full border border-muted-foreground/60" />;
  return <span className="size-2 rounded-full bg-foreground" />;
}
