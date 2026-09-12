// SPDX-License-Identifier: AGPL-3.0-only
// The center while a workspace is being created: its name, an indeterminate
// wavy bar and the runtime's stage log, one line per stage as it arrives.
// A failure keeps the log with the failing line and offers a retry; success
// is the store swapping this for the thread.
import { useEffect, useRef } from "react";
import { CREATION_ASKED } from "../actions/format.js";
import { Button } from "../components/ui/button.js";
import { ScrollArea } from "../components/ui/scroll-area.js";
import { cn } from "../lib/utils.js";
import { useStore, type Creation, type CreationLine } from "../protocol/store.js";

const WAVE_PERIOD = 24;

export function WorkspaceCreation({ creation }: { creation: Creation }) {
  const retry = useStore(s => s.retryCreation);
  const dismiss = useStore(s => s.dismissCreation);
  const failed = creation.failed !== null;
  const lastMessage = creation.lines.at(-1)?.message;
  const log = useRef<HTMLOListElement>(null);
  useEffect(() => {
    log.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [creation.lines.length]);
  return (
    <div data-testid="workspace-creation" aria-busy={!failed} className="flex h-full min-h-0 flex-col items-center overflow-y-auto bg-background px-6 py-12 text-foreground sm:py-16">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{failed ? "Creation failed" : "Creating workspace"}</p>
        <h1 className="mt-2 w-full truncate text-2xl font-normal tracking-tight">{creation.name}</h1>
        <Squiggle failed={failed} className="mt-6" />
        <div data-testid="creation-log" className="mt-6 h-32 w-full rounded-md border border-border/60 text-left">
          <ScrollArea scrollFade>
            <ol ref={log} aria-label="Creation log" aria-live="polite" className="flex flex-col gap-1.5 p-3 font-mono text-xs tabular-nums">
              {creation.lines.length === 0 ? <li className="text-muted-foreground">{CREATION_ASKED}</li> : null}
              {creation.lines.map((line, i) => (
                <LogLine key={i} line={line} current={i === creation.lines.length - 1} />
              ))}
            </ol>
          </ScrollArea>
        </div>
        {creation.failed ? (
          <div className="mt-6 flex flex-col items-center gap-3 text-sm">
            <p>
              <span className="text-destructive-foreground">{creation.failed.title}</span>
              {creation.failed.detail !== lastMessage ? <span className="text-muted-foreground"> {creation.failed.detail}</span> : null}
            </p>
            <div className="flex justify-center gap-2">
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
  );
}

function LogLine({ line, current }: { line: CreationLine; current: boolean }) {
  const failing = line.stage === "failed";
  return (
    <li className={cn("flex gap-3", failing ? "text-destructive-foreground" : current ? "text-foreground" : "text-muted-foreground")}>
      <time dateTime={line.at} className="shrink-0 text-muted-foreground/70">
        {clockLabel(line.at)}
      </time>
      <span className="min-w-0 flex-1 break-words">
        {line.message}
        {line.notice !== undefined ? <span className="block text-muted-foreground">{line.notice}</span> : null}
      </span>
      <span className="shrink-0 text-muted-foreground/70">{elapsedLabel(line.elapsedMs)}</span>
    </li>
  );
}

/** An indeterminate bar drawn as a wave that slides one period per loop; it stands still once the create failed. */
function Squiggle({ failed, className }: { failed: boolean; className?: string }) {
  return (
    <div role="progressbar" aria-label={failed ? "Creation stopped" : "Creating"} className={cn("h-3 w-full overflow-hidden", className)}>
      <svg
        aria-hidden
        className={cn("h-3 w-[calc(100%+24px)]", failed ? "text-destructive" : "text-foreground/70 motion-safe:animate-squiggle")}
        data-state={failed ? "stopped" : "moving"}
      >
        <defs>
          <pattern id="wsp-squiggle" width={WAVE_PERIOD} height="12" patternUnits="userSpaceOnUse">
            <path d="M0 6 Q6 0 12 6 T24 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wsp-squiggle)" />
      </svg>
    </div>
  );
}

function clockLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(undefined, { hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function elapsedLabel(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.floor((ms - minutes * 60_000) / 1000)}s`;
}
