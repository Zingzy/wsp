// SPDX-License-Identifier: AGPL-3.0-only
// The levels under a row, each replacing the list inside its tab: the detail
// (a head with Back, the facts as a label column and a value column, the acts
// next step first, and a sign-in drawn under them), the level of rows a kind
// may add under it, and one of those rows. Escape goes back one level;
// ArrowDown from the head reaches the acts.
import { ArrowLeftIcon, CheckIcon, CopyIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { offlineFor } from "@wsp/protocol";
import { copyText } from "../../actions/clipboard.js";
import { cn } from "../../lib/utils.js";
import { FACT, VALUE } from "../../settings/format.js";
import { CopyRow, RefusalSlot } from "../../settings/sheetParts.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Button } from "../ui/button.js";
import { Spinner } from "../ui/spinner.js";
import { ActButton, AgentMarks, LeadMark, ServerStatusView } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W } from "./agentsRows.js";
import type { DetailView, Fact, Lead, UnderLevel, UnderRow } from "./kinds/kind.js";
import { rovingKeys } from "./roving.js";
import { SignInFlowView } from "./SignInFlowView.js";

const COPIED_MS = 1_400;

/** A level's head: Back, the lead, the name at 15 px, and the level's own glyph at the right. */
function LevelHead({ back, backLabel, lead, title, marks, right, headRef }: { back: () => void; backLabel: string; lead?: Lead; title: string; marks?: readonly string[]; right?: ReactNode; headRef: React.RefObject<HTMLButtonElement | null> }) {
  return (
    <div data-level-head className="flex h-10 items-center gap-2 px-4">
      <Button ref={headRef} data-k="agents-back" size="icon-xs" variant="ghost" className="-ml-1" aria-label={backLabel} onClick={back}>
        <ArrowLeftIcon />
      </Button>
      {lead === undefined ? null : <LeadMark lead={lead} label={title} big />}
      <h3 data-k="detail-title" className="min-w-0 truncate text-[15px] leading-5 font-medium text-foreground" title={title}>
        {title}
      </h3>
      {marks === undefined ? null : <AgentMarks agents={marks} />}
      {right === undefined ? null : <span className="ml-auto flex items-center">{right}</span>}
    </div>
  );
}

/** Focus lands on Back when a level opens; Escape leaves it, and ArrowDown from the head steps to the first act. */
function useLevelKeys(back: () => void) {
  const headRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => headRef.current?.focus({ preventScroll: true }), []);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (e.key === "Escape" && !typing) {
      e.preventDefault();
      e.stopPropagation();
      back();
      return;
    }
    if (e.key === "ArrowDown" && target === headRef.current) {
      const first = e.currentTarget.querySelector<HTMLElement>("[data-detail-acts] button:not(:disabled), [data-level-body] [data-row-trigger]");
      if (first !== null) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return { headRef, onKeyDown };
}

function CopyGlyph({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      data-k="fact-copy"
      size="icon-xs"
      variant="ghost-muted"
      aria-label={`${W.copy} ${label.toLowerCase()}`}
      className="opacity-0 transition-opacity duration-150 group-hover/fact:opacity-100 focus-visible:opacity-100"
      onClick={() =>
        void copyText(value).then(
          () => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), COPIED_MS);
          },
          () => {},
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/** A path or a command that wraps only after a slash or at a space, so a second line starts at a folder; a hyphen
 * is a break opportunity in Chromium, so each word between stands whole. */
const slashBreaks = (value: string): ReactNode =>
  value.split(/(\/|\s+)/).map((token, at) =>
    token === "/" ? (
      <Fragment key={at}>
        /<wbr />
      </Fragment>
    ) : token === "" || token.trim() === "" ? (
      token
    ) : (
      <span key={at} className="whitespace-nowrap">
        {token}
      </span>
    ),
  );

/** One fact: the label in its column, the value in the mono clamped at two lines with the whole on its hover, the
 * reason or state after it in the muted mono. */
function FactLine({ fact, labelFor }: { fact: Fact; labelFor: string }) {
  const copy = fact.copy === true && fact.value !== undefined ? <CopyGlyph value={fact.value} label={fact.label === "" ? labelFor : fact.label} /> : null;
  // With nothing after the value the glyph stays beside it, so a long value never wraps an empty line under it.
  const trailing = fact.fact !== undefined || fact.act !== undefined;
  return (
    <div data-fact={fact.id} className="group/fact flex min-h-7 items-start gap-3">
      <span data-fact-label className="flex min-h-7 w-24 shrink-0 items-center text-xs text-muted-foreground @min-[480px]:w-40">
        {fact.label}
      </span>
      <span className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-1">
        <span className="flex min-w-0 max-w-full items-center gap-2">
          {fact.agent === undefined ? null : <HarnessMark harness={fact.agent} label={agentName(fact.agent)} className="size-3.5" />}
          {fact.status === undefined ? null : <ServerStatusView status={fact.status} />}
          {fact.value === undefined ? null : fact.line === true ? (
            <CopyRow k={`fact-${fact.id}`} value={fact.value} whole />
          ) : fact.href !== undefined ? (
            <button type="button" data-fact-value title={fact.href} onClick={() => void window.open(fact.href, "_blank", "noopener,noreferrer")} className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 truncate font-mono text-xs text-foreground underline-offset-4 transition-colors duration-150 hover:underline">
              <span className="truncate">{fact.value}</span>
              <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </button>
          ) : (
            <span data-fact-value className={cn(fact.muted === true ? FACT : VALUE, "line-clamp-2 min-w-0 break-words")} title={fact.hover ?? fact.value}>
              {fact.muted === true ? fact.value : slashBreaks(fact.value)}
            </span>
          )}
          {trailing ? null : copy}
        </span>
        {trailing ? (
          <span className="flex flex-1 items-center gap-2">
            {fact.fact === undefined ? null : (
              <span data-fact-note className={cn(FACT, "whitespace-nowrap")} title={fact.fact}>
                {fact.fact}
              </span>
            )}
            {copy}
            {fact.act === undefined ? null : <ActButton act={fact.act} className="ml-auto" />}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function DetailLevel({ view, back, backLabel }: { view: DetailView; back: () => void; backLabel: string }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  let labelFor = "";
  return (
    <div data-agents-detail onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} lead={view.lead} title={view.title} {...(view.marks === undefined ? {} : { marks: view.marks })} headRef={headRef} />
      <div data-level-body className="flex flex-col gap-3 px-4 pt-2">
        {view.about === undefined ? null : (
          <p data-detail-about className="text-[13px] leading-5 text-foreground">
            {view.about}
          </p>
        )}
        <div data-facts className="flex flex-col gap-y-1">
          {view.facts.map(fact => {
            if (fact.label !== "") labelFor = fact.label;
            return <FactLine key={fact.id} fact={fact} labelFor={labelFor} />;
          })}
        </div>
        {view.acts.length === 0 ? null : (
          <div data-detail-acts className="flex flex-wrap gap-2">
            {view.acts.map(act => (
              <ActButton key={act.id} act={act} />
            ))}
          </div>
        )}
        {view.flow === undefined ? null : <SignInFlowView view={view.flow} label={view.title} />}
        {view.flow === undefined && view.refused !== undefined ? <RefusalSlot k="detail-refused" said={view.refused} /> : null}
      </div>
    </div>
  );
}

export function UnderLevelView({ level, back, backLabel, now, onRow }: { level: UnderLevel; back: () => void; backLabel: string; now: number; onRow: (row: UnderRow) => void }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  const readAgo = level.readAt === undefined ? undefined : W.readAgo(offlineFor(now - Date.parse(level.readAt)));
  const again = level.reading ? (
    <span className="flex size-6 items-center justify-center">
      <Spinner className="size-3.5 text-muted-foreground" />
    </span>
  ) : (
    <span className="inline-flex" {...(readAgo === undefined ? {} : { title: readAgo })}>
      <Button data-k="under-again" aria-label={W.readAgain} size="icon-xs" variant="ghost" held={level.refresh === undefined} {...(level.refresh === undefined ? {} : { onClick: level.refresh })}>
        <RefreshCwIcon className="size-3.5" />
      </Button>
    </span>
  );
  const rows = level.rows ?? [];
  return (
    <div data-agents-under onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={level.title} right={again} headRef={headRef} />
      <div data-level-body className="flex flex-col gap-0.5 pt-1" role="list" onKeyDown={rovingKeys}>
        {rows.map((row, at) => (
          <div key={row.key} role="listitem" data-under-row={row.key} className="relative isolate mx-2 flex h-12 items-center rounded-lg px-2">
            <button
              type="button"
              data-row-trigger
              tabIndex={at === 0 ? 0 : -1}
              onClick={() => onRow(row)}
              className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center text-left outline-none before:absolute before:inset-0 before:-z-10 before:rounded-lg before:transition-colors before:duration-150 hover:before:bg-accent focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
            >
              <span className="truncate font-mono text-xs leading-5 text-foreground">{row.title}</span>
              {row.subtext === undefined ? null : <span className="truncate text-xs leading-4 text-muted-foreground">{row.subtext}</span>}
            </button>
          </div>
        ))}
      </div>
      <div className="px-4">{level.refused === undefined ? null : <RefusalSlot k="under-refused" said={level.refused} />}</div>
    </div>
  );
}

export function UnderRowLevel({ row, back, backLabel }: { row: UnderRow; back: () => void; backLabel: string }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  return (
    <div data-agents-under-row onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={row.title} headRef={headRef} />
      <div data-level-body className="px-4 pt-2">
        {row.body === undefined ? null : <p className="whitespace-pre-line break-words text-[13px] leading-5 text-foreground">{row.body}</p>}
      </div>
    </div>
  );
}
