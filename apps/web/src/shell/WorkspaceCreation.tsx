// SPDX-License-Identifier: AGPL-3.0-only
// The centre while a workspace is being made: the thread it becomes. Asked
// with a message, it is that thread already, the message first, the create's
// steps in the middle of the room under it and the composer docked; asked with
// none, it is the empty thread, drawn where ChatView draws one, with one
// folded "Setting up" row at the top and the composer under the question. A
// message sent now waits under the creation and goes to the workspace once it
// is up.
import { useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon } from "lucide-react";
import { ChatComposer } from "../components/chat/ChatComposer.js";
import { EmptyThread } from "../components/chat/ChatView.js";
import { PERSON_BUBBLE } from "../components/chat/MessagesTimeline.js";
import { HeroField } from "../components/chat/EmptyHero.js";
import { useChatThread } from "../components/chat/useChatThread.js";
import { Crab } from "../components/status/Crab.js";
import { WorkingSince } from "../components/status/WorkingSince.js";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { usePlaces, useStore, type Creation, type CreationLine } from "../protocol/store.js";
import { placeNames } from "../sidebar/workspaceRows.js";
import { RunsOn } from "./NewThreadPicks.js";
import { CREATE_ASKED, CREATE_STEP_WORDS, creationFolder, currentStep, stepTime, stepWords } from "./creationLog.js";

/** What the composer says over a message that waits for the machine. */
export const creationWaitLine = (name: string): string => `Sends once ${name} is up`;

const TIME_CLASS = "ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground";

/** One step row's height and the grid the room below the row is cut to, so it never shows part of a line. */
const STEP_ROW_PX = 24;

export function WorkspaceCreation({ creation }: { creation: Creation }) {
  const thread = useChatThread(creation.key, null, true);
  const [open, setOpen] = useState(false);
  const asked = creation.asked;
  const { folder, project: projectName, at } = useStore(
    useShallow(s => {
      const project = s.projects.find(p => p.id === creation.project);
      return project === undefined ? { folder: "", project: null, at: creation.where } : { folder: creationFolder(project, creation.name), project: project.name, at: creation.where ?? project.computer };
    }),
  );
  const places = usePlaces();
  const computer = at === undefined ? undefined : placeNames(places).get(at);
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  // ChatView's own measure, so the question stands over the composer at the height the thread will draw it at, and
  // the question's own, which is where the room for the steps ends.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    const question = questionRef.current;
    if (root === null || composer === null) return;
    const observer = new ResizeObserver(() => {
      root.style.setProperty("--chat-composer-inset", `${composer.offsetHeight}px`);
      if (question !== null) root.style.setProperty("--question-height", `${question.offsetHeight}px`);
    });
    observer.observe(composer);
    if (question !== null) observer.observe(question);
    return () => observer.disconnect();
  }, [asked]);
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
        {asked === undefined ? (
          <div className="absolute inset-0">
            <HeroField />
            <div ref={questionRef} className="absolute inset-x-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem)]">
              <EmptyThread name={projectName ?? creation.name} {...project} />
            </div>
            <div className="absolute inset-x-0 top-0 bottom-[calc(var(--empty-lift)+var(--chat-composer-inset)+2.5rem+var(--question-height,8.5rem)+0.75rem)] flex flex-col px-3 pt-3 sm:px-5 sm:pt-4">
              <SettingUp creation={creation} open={open} onToggle={() => setOpen(o => !o)} />
            </div>
          </div>
        ) : (
          <div data-k="creation-asked" className="absolute inset-x-0 top-0 bottom-(--chat-composer-inset,0px) flex flex-col gap-4 px-3 pt-3 sm:px-5 sm:pt-4">
            <div className="mx-auto flex w-full min-w-0 max-w-3xl shrink-0 flex-col items-end">
              <div className={cn(PERSON_BUBBLE, "whitespace-pre-wrap break-words text-sm leading-relaxed")}>{asked}</div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center pb-6">
              <SettingUpCentre creation={creation} />
            </div>
          </div>
        )}
        <div
          ref={composerRef}
          data-chat-composer-dock
          data-centred={asked === undefined || undefined}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 *:pointer-events-auto data-centred:bottom-(--empty-lift)"
        >
          <ChatComposer key={creation.key} workspaceId={creation.key} thread={thread} waiting={{ line: creationWaitLine(creation.name), folder }} where={at === undefined || computer === undefined ? undefined : <RunsOn at={at} name={computer} />} />
        </div>
      </div>
    </div>
  );
}

/** The create's steps folded into one row at the top of the column, in the transcript's fold grammar with no rule
 * under it: the crab, the step being waited on, and the time since the create was asked for. A refused create says
 * so in that row's place with Retry and Dismiss where the time stood, so they never scroll; under it the steps when
 * unfolded, the step it stopped on in red, then the reason once, in the room between the row and the question. */
function SettingUp({ creation, open, onToggle }: { creation: Creation; open: boolean; onToggle: () => void }) {
  const retry = useStore(s => s.retryCreation);
  const dismiss = useStore(s => s.dismissCreation);
  const { failed } = creation;
  const step = currentStep(creation);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex min-h-0 w-full min-w-0 max-w-3xl flex-1 flex-col">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <button
            type="button"
            data-k="setting-up"
            aria-expanded={open}
            onClick={onToggle}
            className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-md px-1 text-sm leading-relaxed text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          >
            {failed === null ? (
              <>
                <Crab className="text-status-working" />
                <span className="shrink-0 text-foreground">Setting up</span>
                <span className="min-w-0 truncate">{step === undefined ? CREATE_ASKED : stepWords(step)}</span>
                <Chevron aria-hidden className="size-3.5 shrink-0" />
                <span data-step-time className={TIME_CLASS}>
                  <WorkingSince since={new Date(creation.askedAt).toISOString()} format={stepTime} />
                </span>
              </>
            ) : (
              <>
                <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-status-failed" />
                <span className="shrink-0 font-medium text-status-failed">{CREATE_STEP_WORDS.failed}</span>
                <Chevron aria-hidden className="size-3.5 shrink-0" />
              </>
            )}
          </button>
          {failed !== null ? (
            <div data-creation-refusal className="flex shrink-0 items-center gap-2 pe-1">
              <Button variant="outline" size="xs" className="h-6" onClick={() => void retry(creation.key)}>
                Retry
              </Button>
              <Button variant="ghost" size="xs" onClick={() => dismiss(creation.key)}>
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
        {open || failed !== null ? <Below creation={creation} open={open} /> : null}
      </div>
    </div>
  );
}

/** Under the row: the steps when unfolded, then a refusal's reason, in a room cut to whole rows of the grid everything
 * here stands on, so no line shows in part; more than fits scrolls from the first step. */
function Below({ creation, open }: { creation: Creation; open: boolean }) {
  const { failed, lines } = creation;
  const room = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
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
  useLayoutEffect(() => {
    const at = scroller.current;
    if (at !== null) at.scrollTop = 0;
  }, [failed, open, rows, lines.length]);
  const taken = lines.filter(line => line.stage !== "failed");
  const last = taken.length - 1;
  return (
    <div ref={room} className="mt-1 flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="shrink-0 overflow-y-auto" style={rows === null ? undefined : { maxHeight: rows * STEP_ROW_PX }}>
        {open ? (
          <ol aria-label="Setting up" aria-live="polite" className="flex flex-col">
            {taken.length === 0 ? <StepRow words={CREATE_ASKED} tone={failed === null ? "current" : "failed"} /> : null}
            {taken.map((line, i) => (
              <StepRow key={i} words={stepWords(line)} time={stepTime(line.elapsedMs)} tone={i === last ? (failed === null ? "current" : "failed") : "done"} />
            ))}
          </ol>
        ) : null}
        {failed !== null ? (
          <p
            data-creation-reason
            title={failed.detail}
            className={cn("ps-7 pe-1 text-sm leading-6", !open && "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical]")}
            // Folded, the reason keeps to the room's rows so it stands from its first word; unfolded it is whole.
            style={open ? undefined : { WebkitLineClamp: rows ?? 2 }}
          >
            {failed.detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The steps the newest last, as many as fit a glance. */
const CENTRE_STEPS = 5;

/** The create's steps for a page that already shows the message that asked for it, standing in the middle of the room
 * the reply will take: the crab, the words and the time since the ask, then the latest steps, done ones quiet. A refused
 * create says so in the same place, its reason once, with Retry and Dismiss under it; a kept row wsp has said nothing
 * about for a while says so, with Dismiss alone, since its create may still be running. */
function SettingUpCentre({ creation }: { creation: Creation }) {
  const retry = useStore(s => s.retryCreation);
  const dismiss = useStore(s => s.dismissCreation);
  const { failed, lines } = creation;
  const taken = lines.filter(line => line.stage !== "failed");
  const shown = taken.slice(-CENTRE_STEPS);
  const last = shown.length - 1;
  return (
    <div data-k="setting-up" className="flex w-full max-w-md flex-col items-center gap-4 text-center">
      <div className="flex items-center gap-2 text-sm">
        {failed === null ? (
          <>
            <Crab className="text-status-working" />
            <span className="text-foreground">Setting up</span>
            <span data-step-time className="font-mono text-xs tabular-nums text-muted-foreground">
              <WorkingSince since={new Date(creation.askedAt).toISOString()} format={stepTime} />
            </span>
          </>
        ) : (
          <>
            <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-status-failed" />
            <span className="font-medium text-status-failed">{CREATE_STEP_WORDS.failed}</span>
          </>
        )}
      </div>
      <ol aria-label="Setting up" aria-live="polite" className="flex flex-col items-center gap-1">
        {shown.length === 0 ? <li className={cn("text-[13px] leading-5", failed === null ? "text-foreground" : "text-status-failed")}>{CREATE_ASKED}</li> : null}
        {shown.map((line, i) => (
          <li
            key={taken.length - shown.length + i}
            className={cn("flex items-baseline gap-2 text-[13px] leading-5", i === last ? (failed === null ? "text-foreground" : "text-status-failed") : "text-muted-foreground")}
          >
            <span data-step-words>{stepWords(line)}</span>
            <span data-step-time className="font-mono text-xs tabular-nums text-muted-foreground">
              {stepTime(line.elapsedMs)}
            </span>
          </li>
        ))}
      </ol>
      {failed !== null ? (
        <>
          <p data-creation-reason className="text-sm leading-6 text-muted-foreground">
            {failed.detail}
          </p>
          <div data-creation-refusal className="flex items-center gap-2">
            <Button variant="outline" size="xs" className="h-6" onClick={() => void retry(creation.key)}>
              Retry
            </Button>
            <Button variant="ghost" size="xs" onClick={() => dismiss(creation.key)}>
              Dismiss
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** One step: its words in sans and how long into the create it came, right-aligned in mono. */
function StepRow({ words, time, tone }: { words: string; time?: string; tone: "done" | "current" | "failed" }) {
  return (
    <li
      className={cn("flex h-6 min-w-0 shrink-0 items-center gap-3 ps-7 pe-1 text-[13px] leading-5", tone === "failed" ? "text-status-failed" : tone === "current" ? "text-foreground" : "text-muted-foreground")}
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
