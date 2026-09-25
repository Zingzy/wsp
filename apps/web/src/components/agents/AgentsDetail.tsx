// SPDX-License-Identifier: AGPL-3.0-only
// The levels under a row, each replacing the list inside its tab: the detail
// (a head with Back, the facts as a label column and a value column, the acts
// next step first, and a sign-in drawn under them), a server's tools, and one
// tool. Escape goes back one level; ArrowDown from the head reaches the acts.
import { ArrowLeftIcon, CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { offlineFor, type McpTool } from "@wsp/protocol";
import { copyText } from "../../actions/clipboard.js";
import { cn } from "../../lib/utils.js";
import { FACT, VALUE } from "../../settings/format.js";
import { RefusalSlot } from "../../settings/sheetParts.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Button } from "../ui/button.js";
import { Spinner } from "../ui/spinner.js";
import { ActButton, AgentMarks, LeadMark, ServerBadge } from "./agentsParts.js";
import { AGENTS_LIST_WORDS as W } from "./agentsRows.js";
import type { DetailView, Fact, Lead, ToolsLevel } from "./kinds/kind.js";
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
            setTimeout(() => setCopied(false), COPIED_MS);
          },
          () => {},
        )
      }
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/** One fact: the label in its column, the value in the mono clamped at two lines with the whole on its hover, the
 * reason or state after it in the muted mono. */
function FactLine({ fact, labelFor }: { fact: Fact; labelFor: string }) {
  return (
    <div data-fact={fact.id} className="group/fact flex min-h-7 items-start gap-3">
      <span data-fact-label className="flex min-h-7 w-24 shrink-0 items-center text-xs text-muted-foreground @min-[480px]:w-40">
        {fact.label}
      </span>
      <span className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 py-1">
        <span className="flex min-w-0 max-w-full items-center gap-2">
          {fact.agent === undefined ? null : <HarnessMark harness={fact.agent} label={agentName(fact.agent)} className="size-3.5" />}
          {fact.badge === undefined ? null : <ServerBadge badge={fact.badge} />}
          {fact.value === undefined ? null : (
            <span data-fact-value className={cn(fact.muted === true ? FACT : VALUE, "line-clamp-2 min-w-0 break-words")} title={fact.hover ?? fact.value}>
              {fact.value}
            </span>
          )}
        </span>
        {fact.fact === undefined && fact.act === undefined && fact.copy !== true ? null : (
          <span className="flex flex-1 items-center gap-2">
            {fact.fact === undefined ? null : (
              <span data-fact-note className={cn(FACT, "whitespace-nowrap")} title={fact.fact}>
                {fact.fact}
              </span>
            )}
            {fact.copy === true && fact.value !== undefined ? <CopyGlyph value={fact.value} label={fact.label === "" ? labelFor : fact.label} /> : null}
            {fact.act === undefined ? null : <ActButton act={fact.act} className="ml-auto" />}
          </span>
        )}
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

export function ToolsLevelView({ level, back, backLabel, now, onTool }: { level: ToolsLevel; back: () => void; backLabel: string; now: number; onTool: (tool: McpTool) => void }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  const readAgo = level.readAt === undefined ? undefined : W.readAgo(offlineFor(now - Date.parse(level.readAt)));
  const again = level.listing ? (
    <span className="flex size-6 items-center justify-center">
      <Spinner className="size-3.5 text-muted-foreground" />
    </span>
  ) : (
    <span className="inline-flex" {...(readAgo === undefined ? {} : { title: readAgo })}>
      <Button data-k="tools-again" aria-label={W.readAgain} size="icon-xs" variant="ghost" held={level.refresh === undefined} {...(level.refresh === undefined ? {} : { onClick: level.refresh })}>
        <RefreshCwIcon className="size-3.5" />
      </Button>
    </span>
  );
  const tools = level.tools ?? [];
  return (
    <div data-agents-tools onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={level.title} right={again} headRef={headRef} />
      <div data-level-body className="flex flex-col gap-0.5 pt-1" role="list" onKeyDown={rovingKeys}>
        {tools.map((tool, at) => (
          <div key={tool.name} role="listitem" data-tool={tool.name} className="relative isolate mx-2 flex h-12 items-center rounded-lg px-2">
            <button
              type="button"
              data-row-trigger
              tabIndex={at === 0 ? 0 : -1}
              onClick={() => onTool(tool)}
              className="flex min-w-0 flex-1 cursor-pointer flex-col justify-center text-left outline-none before:absolute before:inset-0 before:-z-10 before:rounded-lg before:transition-colors before:duration-150 hover:before:bg-accent focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
            >
              <span className="truncate font-mono text-xs leading-5 text-foreground">{tool.name}</span>
              {tool.description === undefined ? null : <span className="truncate text-xs leading-4 text-muted-foreground">{tool.description}</span>}
            </button>
          </div>
        ))}
      </div>
      <div className="px-4">{level.refused === undefined ? null : <RefusalSlot k="tools-refused" said={level.refused} />}</div>
    </div>
  );
}

export function ToolLevel({ tool, back, backLabel }: { tool: McpTool; back: () => void; backLabel: string }) {
  const { headRef, onKeyDown } = useLevelKeys(back);
  return (
    <div data-agents-tool onKeyDown={onKeyDown} className="flex flex-col pb-4">
      <LevelHead back={back} backLabel={backLabel} title={tool.name} headRef={headRef} />
      <div data-level-body className="px-4 pt-2">
        {tool.description === undefined ? null : <p className="whitespace-pre-line break-words text-[13px] leading-5 text-foreground">{tool.description}</p>}
      </div>
    </div>
  );
}
