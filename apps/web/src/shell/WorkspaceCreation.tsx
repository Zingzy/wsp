// SPDX-License-Identifier: AGPL-3.0-only
// The centre while a workspace is being made: the thread it becomes, empty,
// drawn where ChatView draws an empty thread so nothing moves when the
// workspace takes the page, with one folded "Setting up" row at the top for
// the create's steps and the composer ready under the question. A message sent
// now waits under the creation and goes to the workspace once it is up.
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { EmptyThread } from "../components/chat/ChatView.js";
import { HeroAtmosphere } from "../components/chat/EmptyHero.js";
import { useChatThread } from "../components/chat/useChatThread.js";
import { Crab } from "../components/status/Crab.js";
import { WorkingSince } from "../components/status/WorkingSince.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { useStore, type Creation, type CreationLine } from "../protocol/store.js";
import { formatWorkingDurationLabel } from "../sidebar/Sidebar.logic.js";
import { CREATE_ASKED, currentStep, stepWords } from "./creationLog.js";

/** What the composer says over a message that waits for the machine. */
export const creationWaitLine = (name: string): string => `Sends once ${name} is up`;

const TIME_CLASS = "ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

export function WorkspaceCreation({ creation }: { creation: Creation }) {
  const thread = useChatThread(creation.key, null, true);
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  // ChatView's own measure, so the question stands over the composer at the height the thread will draw it at.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    if (root === null || composer === null) return;
    const observer = new ResizeObserver(() => root.style.setProperty("--chat-composer-inset", `${composer.offsetHeight}px`));
    observer.observe(composer);
    return () => observer.disconnect();
  }, []);
  const project = creation.project === undefined ? {} : { projectId: creation.project };
  return (
    <div data-testid="workspace-creation" aria-busy={creation.failed === null} className="flex min-h-0 flex-1 flex-col" data-terminal-beside>
      <div ref={rootRef} className="relative isolate h-full min-h-0 text-foreground [--empty-lift:calc((100%-var(--chat-composer-inset,0px)-5.5rem)/2)]">
        <div className="absolute inset-0">
          <HeroAtmosphere {...project} />
          <div className="absolute inset-x-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem)]">
            <EmptyThread workspaceName={creation.name} {...project} />
          </div>
          <SettingUp creation={creation} />
        </div>
        <div ref={composerRef} data-chat-composer-dock data-centred className="pointer-events-none absolute inset-x-0 bottom-(--empty-lift) z-10 *:pointer-events-auto">
          <ChatComposer key={creation.key} workspaceId={creation.key} thread={thread} waitLine={creationWaitLine(creation.name)} />
        </div>
      </div>
    </div>
  );
}

/** The create's steps folded into one row at the top of the column, in the transcript's fold grammar with no rule
 * under it: the crab, the step being waited on, and the time since the create was asked for. A refusal says why
 * under it, with Retry and Dismiss. */
function SettingUp({ creation }: { creation: Creation }) {
  const retry = useStore(s => s.retryCreation);
  const dismiss = useStore(s => s.dismissCreation);
  const [open, setOpen] = useState(false);
  const { failed, lines } = creation;
  // The newest step and a refusal's buttons are what a clipped region must still show.
  const below = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (below.current !== null) below.current.scrollTop = below.current.scrollHeight;
  }, [open, lines.length, failed]);
  const step = currentStep(creation);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    // Ends above the question, measured the way ChatView places it: the question is two lines on a phone.
    <div className="absolute inset-x-0 top-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+11.5rem)] flex flex-col px-3 pt-3 sm:bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+10.5rem)] sm:px-5 sm:pt-4">
      <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-col">
        <button
          type="button"
          data-k="setting-up"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className="flex w-full min-w-0 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-1 text-sm leading-relaxed text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          {failed === null ? <Crab className="text-status-working" /> : <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-status-failed" />}
          <span className="shrink-0 text-foreground">Setting up</span>
          <span className={cn("min-w-0 truncate", failed !== null && "text-destructive-foreground")}>{step === undefined ? CREATE_ASKED : stepWords(step)}</span>
          <Chevron aria-hidden className="size-3.5 shrink-0" />
          <span data-step-time className={TIME_CLASS}>
            {failed === null ? <WorkingSince since={new Date(creation.askedAt).toISOString()} /> : formatWorkingDurationLabel(lines.at(-1)?.elapsedMs ?? 0)}
          </span>
        </button>
        <div ref={below} className="min-h-0 overflow-y-auto pb-1">
          {open ? (
            <ol aria-label="Setting up" aria-live="polite" className="mt-1 flex flex-col">
              {lines.length === 0 ? <StepRow words={CREATE_ASKED} tone="current" /> : null}
              {lines.map((line, i) => (
                <StepRow key={i} words={stepWords(line)} line={line} tone={line.stage === "failed" ? "failed" : i === lines.length - 1 ? "current" : "done"} />
              ))}
            </ol>
          ) : null}
          {failed !== null ? (
            <div className="mt-3 flex flex-col items-start gap-3 px-1 text-sm">
              <p>
                <span className="text-destructive-foreground">{failed.title}</span>
                {failed.detail !== failed.title ? <span className="text-muted-foreground"> {failed.detail}</span> : null}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void retry(creation.key)}>
                  Retry
                </Button>
                <Button variant="ghost-muted" size="sm" onClick={() => dismiss(creation.key)}>
                  Dismiss
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One step: its words in sans and the time since the create began right-aligned in mono. The runtime's sentence,
 * a guest's refusal and a step's notice ride the hover, never a line a person reads as the step. */
function StepRow({ words, line, tone }: { words: string; line?: CreationLine; tone: "done" | "current" | "failed" }) {
  const title = line === undefined ? undefined : [line.message, line.detail, line.notice].filter(part => part !== undefined).join("\n");
  return (
    <li
      title={title}
      className={cn("flex min-w-0 items-baseline gap-3 py-0.5 ps-7 pe-1 text-[13px] leading-5", tone === "failed" ? "text-destructive-foreground" : tone === "current" ? "text-foreground" : "text-muted-foreground")}
    >
      <span data-step-words className="min-w-0 truncate">
        {words}
      </span>
      {line === undefined ? null : (
        <span data-step-time className={TIME_CLASS}>
          {formatWorkingDurationLabel(line.elapsedMs)}
        </span>
      )}
    </li>
  );
}
