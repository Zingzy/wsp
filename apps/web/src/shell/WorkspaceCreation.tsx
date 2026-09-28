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
import { CREATE_ASKED, CREATE_STEP_WORDS, creationFolder, currentStep, stepTime, stepWords } from "./creationLog.js";

/** What the composer says over a message that waits for the machine. */
export const creationWaitLine = (name: string): string => `Sends once ${name} is up`;

const TIME_CLASS = "ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

/** One step row's height, which the list is cut to a whole number of. */
const STEP_ROW_PX = 24;

export function WorkspaceCreation({ creation }: { creation: Creation }) {
  const thread = useChatThread(creation.key, null, true);
  const [open, setOpen] = useState(false);
  const folder = useStore(s => {
    const project = s.projects.find(p => p.id === creation.project);
    return project === undefined ? "" : creationFolder(project, creation.name);
  });
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
    <div
      data-testid="workspace-creation"
      aria-busy={creation.failed === null}
      data-creation-refused={creation.failed === null ? undefined : ""}
      className="flex min-h-0 flex-1 flex-col"
      data-terminal-beside
    >
      <div ref={rootRef} className="relative isolate h-full min-h-0 text-foreground [--empty-lift:calc((100%-var(--chat-composer-inset,0px)-5.5rem)/2)]">
        <div className="absolute inset-0">
          <HeroAtmosphere {...project} />
          {/* The question gives the unfolded steps its room, and stands again when they fold. */}
          {open ? null : (
            <div className="absolute inset-x-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem)]">
              <EmptyThread workspaceName={creation.name} {...project} />
            </div>
          )}
          <SettingUp creation={creation} open={open} onToggle={() => setOpen(o => !o)} />
        </div>
        <div ref={composerRef} data-chat-composer-dock data-centred className="pointer-events-none absolute inset-x-0 bottom-(--empty-lift) z-10 *:pointer-events-auto">
          <ChatComposer key={creation.key} workspaceId={creation.key} thread={thread} waiting={{ line: creationWaitLine(creation.name), folder }} />
        </div>
      </div>
    </div>
  );
}

/** The create's steps folded into one row at the top of the column, in the transcript's fold grammar with no rule
 * under it: the crab, the step being waited on, and the time since the create was asked for. A refused create says
 * so in that row's place, gives the reason once under it with Retry and Dismiss, and marks the step it stopped on. */
function SettingUp({ creation, open, onToggle }: { creation: Creation; open: boolean; onToggle: () => void }) {
  const retry = useStore(s => s.retryCreation);
  const dismiss = useStore(s => s.dismissCreation);
  const { failed, lines } = creation;
  const step = currentStep(creation);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    // Folded, it ends above the question, which is two lines on a phone; unfolded, above the composer.
    <div
      className={cn(
        "absolute inset-x-0 top-0 flex flex-col px-3 pt-3 sm:px-5 sm:pt-4",
        open
          ? "bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+1rem)]"
          : "bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+11.5rem)] sm:bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+10.5rem)]",
      )}
    >
      <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col">
        <button
          type="button"
          data-k="setting-up"
          aria-expanded={open}
          onClick={onToggle}
          className="flex w-full min-w-0 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-1 text-sm leading-relaxed text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        >
          {failed === null ? (
            <>
              <Crab className="text-status-working" />
              <span className="shrink-0 text-foreground">Setting up</span>
              <span className="min-w-0 truncate">{step === undefined ? CREATE_ASKED : stepWords(step)}</span>
            </>
          ) : (
            <>
              <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-status-failed" />
              <span className="shrink-0 text-destructive-foreground">{CREATE_STEP_WORDS.failed}</span>
            </>
          )}
          <Chevron aria-hidden className="size-3.5 shrink-0" />
          <span data-step-time className={TIME_CLASS}>
            {failed === null ? <WorkingSince since={new Date(creation.askedAt).toISOString()} format={stepTime} /> : stepTime(lines.at(-1)?.elapsedMs ?? 0)}
          </span>
        </button>
        {failed !== null ? (
          <div className="mt-2 flex shrink-0 flex-col items-start gap-3 ps-7 pe-1 text-sm">
            <p>{failed.detail}</p>
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
        {open ? <StepList lines={lines} refused={failed !== null} /> : null}
      </div>
    </div>
  );
}

/** Every step from the first, cut to the whole rows its room holds, so no row stands half under an edge; more rows
 * than that scroll. The refusal is not a step: the step it stopped on is the red one. */
function StepList({ lines, refused }: { lines: ReadonlyArray<CreationLine>; refused: boolean }) {
  const room = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<number | null>(null);
  useLayoutEffect(() => {
    const at = room.current;
    if (at === null) return;
    const measure = () => setRows(Math.max(1, Math.floor(at.clientHeight / STEP_ROW_PX)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(at);
    return () => observer.disconnect();
  }, []);
  const taken = lines.filter(line => line.stage !== "failed");
  const last = taken.length - 1;
  return (
    <div ref={room} className="mt-1 min-h-0 flex-1">
      <ol aria-label="Setting up" aria-live="polite" className="flex flex-col overflow-y-auto" style={rows === null ? undefined : { maxHeight: rows * STEP_ROW_PX }}>
        {taken.length === 0 ? <StepRow words={CREATE_ASKED} tone={refused ? "failed" : "current"} /> : null}
        {taken.map((line, i) => (
          <StepRow key={i} words={stepWords(line)} time={stepTime(line.elapsedMs)} tone={i === last ? (refused ? "failed" : "current") : "done"} />
        ))}
      </ol>
    </div>
  );
}

/** One step: its words in sans and how long into the create it came, right-aligned in mono. */
function StepRow({ words, time, tone }: { words: string; time?: string; tone: "done" | "current" | "failed" }) {
  return (
    <li
      className={cn("flex h-6 min-w-0 shrink-0 items-center gap-3 ps-7 pe-1 text-[13px] leading-5", tone === "failed" ? "text-destructive-foreground" : tone === "current" ? "text-foreground" : "text-muted-foreground")}
    >
      <span data-step-words className="min-w-0 truncate">
        {words}
      </span>
      {time === undefined ? null : (
        <span data-step-time className={TIME_CLASS}>
          {time}
        </span>
      )}
    </li>
  );
}
