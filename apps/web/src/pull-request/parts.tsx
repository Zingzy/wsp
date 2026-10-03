// SPDX-License-Identifier: AGPL-3.0-only
// The small pieces every tab of the Pull request pane draws with: a face wherever a person or a bot is named (24 px on
// the timeline, 18 px in a row, 16 px in a sentence, GitHub's by login with the initial until it loads), the state word
// with its dot, a body under the 12-line clamp, a body in the pane's markdown, and the mark of the agent the pull
// request's thread runs on.
import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { capitalised } from "@wsp/protocol";
import ChatMarkdown from "../components/ChatMarkdown.js";
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { CLAMP_FADE_MASK } from "../components/chat/clamp.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip.js";
import { useStore } from "../protocol/store.js";
import { useAppDark } from "../settings/theme.js";
import { cn } from "../lib/utils.js";
import type { Tone } from "./conversation.logic.js";
import { PR_WORDS, TONE_INK, authorName } from "./words.js";

export type FaceSize = 16 | 18 | 20 | 24;
const FACE_BOX: Record<FaceSize, string> = { 16: "size-4 text-[8px]", 18: "size-[18px] text-[8px]", 20: "size-5 text-[9px]", 24: "size-6 text-[10px]" };

/** GitHub serves every login's face at this address, which answers with the avatar host. */
export const faceUrl = (login: string, size: FaceSize): string => `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}`;

/** A face: GitHub's for the login, or the one the host read for an app, which its login cannot give. */
export function Face({ login, size, stacked = false, src }: { login: string; size: FaceSize; stacked?: boolean; src?: string | undefined }) {
  const [shown, setShown] = useState(false);
  // A deleted account has no login to ask by, and an app's login answers with its owner's face or nothing.
  const face = src ?? (login.trim() === "" || login.endsWith("[bot]") ? undefined : faceUrl(login, size));
  return (
    <span
      data-pr-face={login}
      className={cn(
        "relative z-[1] grid shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-medium text-muted-foreground",
        stacked ? "border-[1.5px] border-card" : "border border-border",
        FACE_BOX[size],
      )}
    >
      {shown ? null : <span aria-hidden>{login.slice(0, 1).toUpperCase()}</span>}
      {face === undefined ? null : <img ref={img => void (img?.complete === true && img.naturalWidth > 0 && setShown(true))} src={face} alt="" onLoad={() => setShown(true)} className={cn("absolute inset-0 size-full object-cover", !shown && "opacity-0")} />}
    </span>
  );
}

/** A login in a sentence, its face before it. */
export function Who({ login, size = 16 }: { login: string; size?: FaceSize }) {
  return (
    <span data-pr-who className="inline-flex items-baseline gap-1.5">
      <span className="self-center">
        <Face login={login} size={size} />
      </span>
      {authorName(login)}
    </span>
  );
}

/** Words on a thing's hover, on the app's own tooltip. */
export function Hover({ words, children }: { words: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="top">{words}</TooltipPopup>
    </Tooltip>
  );
}

/** Several people in one row: at most three faces overlapped, then +N, each login on its hover. */
export function Faces({ logins }: { logins: readonly string[] }) {
  const shown = logins.slice(0, 3);
  return (
    <span data-pr-faces className="mr-2 inline-flex items-center align-[-5px] [&>*+*]:-ml-1.5">
      {shown.map(login => (
        <Hover key={login} words={authorName(login)}>
          <Face login={login} size={18} stacked />
        </Hover>
      ))}
      {logins.length > shown.length ? (
        <Hover words={logins.slice(3).map(authorName).join(", ")}>
          <span className="grid h-[18px] min-w-[18px] place-items-center rounded-[9px] border-[1.5px] border-card bg-muted px-[5px] font-mono text-[10px] font-medium text-muted-foreground">+{logins.length - shown.length}</span>
        </Hover>
      ) : null}
    </span>
  );
}

/** A state as the pane says it: the word in its tone's ink after a 7 px dot, hollow for a draft or an unread one,
 * pulsing while checks run. */
export function StateWord({ word, tone, hollow = false, k = "pr-word" }: { word: string; tone: Tone; hollow?: boolean; k?: string }) {
  return (
    <span data-k={k} data-tone={tone} className={cn("inline-flex items-center gap-[7px] whitespace-nowrap text-[13px] font-medium", TONE_INK[tone])}>
      <i aria-hidden className={cn("size-[7px] shrink-0 rounded-full", hollow ? "shadow-[inset_0_0_0_1.5px_currentColor]" : "bg-current", tone === "run" && "pr-word-pulse")} />
      {capitalised(word)}
    </span>
  );
}

/** What the host read only in part, said once where that list stands, in the quiet note. */
export function CutNote({ words }: { words: string }) {
  return (
    <p data-pr-cut className="text-xs text-muted-foreground">
      {words}
    </p>
  );
}

/** Taller than this a body folds: twelve lines of the pane's 14 px text and the band its fade takes. */
export const CLAMP_PX = 300;

/** A body under the clamp: past twelve lines the last ones fade out and Show more stands in the clear bottom. Read
 * off the drawn height, so a short body with long lines and a long one with short lines fold alike. */
export function Clamped({ children }: { children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = body.current;
    if (el === null) return;
    const measure = (): void => setTall(el.scrollHeight > CLAMP_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    for (const child of el.children) watch.observe(child);
    return () => watch.disconnect();
  }, []);
  const folded = tall && !open;
  return (
    <div data-pr-clamp className="relative">
      <div ref={body} data-pr-clamp-fade={folded || undefined} className={cn(folded && "max-h-[300px] overflow-hidden")} style={folded ? { WebkitMaskImage: CLAMP_FADE_MASK, maskImage: CLAMP_FADE_MASK } : undefined}>
        {children}
      </div>
      {tall ? (
        <div className={cn("flex justify-end", folded ? "absolute right-0 bottom-0" : "mt-1.5")}>
          <Button type="button" size="xs" variant="ghost" data-pr-show-more onClick={() => setOpen(o => !o)}>
            {open ? PR_WORDS.showLess : PR_WORDS.showMore}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Markdown a person or a bot wrote on GitHub, in the restricted reading: a comment's headings held at body size, a
 * line comment a step smaller. */
export function PrMarkdown({ text, said = false, line = false }: { text: string; said?: boolean; line?: boolean }) {
  const dark = useAppDark();
  return <ChatMarkdown text={text} cwd="" resolvedTheme={dark ? "dark" : "light"} restricted className={cn("pr-md", said && "pr-md-said", line && "pr-md-line")} />;
}

/** The agent on the pull request's thread, which every send to the agent reaches: the workspace's first thread, the
 * one the work was opened in, else the agent a new thread would start on. */
export function usePrAgent(workspaceId: string): { id: string; name: string } {
  const first = useStore(s => {
    const rows = (s.sessions[workspaceId] ?? []).filter(v => v.threadId !== undefined);
    return rows.reduce<(typeof rows)[number] | undefined>((a, b) => (a === undefined || (b.startedAt ?? 0) < (a.startedAt ?? 0) ? b : a), undefined)?.harness;
  });
  const fallback = useStore(s => s.preferences.defaultAgent);
  const id = first ?? fallback ?? "claude";
  return { id, name: agentName(id) };
}

export function AgentMark({ agent }: { agent: { id: string; name: string } }) {
  return <HarnessMark harness={agent.id} label={agent.name} className="size-3.5" />;
}

/** The timeline's shape while the page is read: the rail, a face and the lines each entry will hold. */
export function TimelineSkeleton() {
  return (
    <ol data-pr-skeleton="timeline" aria-busy="true" className="relative flex flex-col gap-[22px] pt-0.5 before:absolute before:top-3.5 before:bottom-3.5 before:left-[11.5px] before:w-px before:bg-border before:content-['']">
      {[0.72, 0.9, 0.56].map((w, i) => (
        <li key={i} className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-3">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex min-w-0 flex-col gap-2 pt-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3" style={{ width: `${w * 100}%` }} />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The commits' shape while the page is read: the rail, its dots, a face, the subject and the SHA. */
export function CommitsSkeleton() {
  return (
    <ol data-pr-skeleton="commits" aria-busy="true" className="relative flex flex-col gap-0.5 before:absolute before:top-2 before:bottom-2 before:left-[19.5px] before:w-px before:bg-border before:content-['']">
      {[0.8, 0.62, 0.74, 0.5, 0.68].map((w, i) => (
        <li key={i} className="grid min-h-9 grid-cols-[28px_18px_minmax(0,1fr)_84px_56px] items-center gap-2.5 px-1.5">
          <span className="relative z-[1] grid h-9 w-7 place-items-center">
            <i className="block size-1.5 rounded-full bg-border" />
          </span>
          <Skeleton className="size-[18px] rounded-full" />
          <Skeleton className="h-3" style={{ width: `${w * 100}%` }} />
          <span />
          <Skeleton className="h-3 w-12 justify-self-end" />
        </li>
      ))}
    </ol>
  );
}

/** The files' shape while the page is read: the count line, then a row per file. */
export function FilesSkeleton() {
  return (
    <div data-pr-skeleton="files" aria-busy="true" className="flex flex-col gap-3">
      <Skeleton className="h-3 w-36" />
      <div className="flex flex-col">
        {[0.5, 0.64, 0.44, 0.58, 0.38, 0.52].map((w, i) => (
          <div key={i} className="flex h-8 items-center justify-between gap-3 px-1.5">
            <Skeleton className="h-3" style={{ width: `${w * 100}%` }} />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}
