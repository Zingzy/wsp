// SPDX-License-Identifier: AGPL-3.0-only
// A run's output as it streams (05, "The output of a run"): its state as one word, the tail of its lines in a box of
// `lines` rows that follows the end while it runs, a quiet Cancel while it runs, and why under it when held or failed.
// A finished run keeps its last lines until it next starts; after the agent changed its command they read as stale.
import { useEffect, useRef } from "react";
import type { SlateJson } from "@wsp/protocol";
import { Crab } from "../../components/status/Crab.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { isRunRecord, type SlateRunState } from "../model.js";
import type { PieceView } from "../SlateView.js";
import { str } from "./look.js";
import { Quiet } from "./quiet.js";

/** A run state as the status mark's grammar says it. */
export const RUN_WORDS: Record<SlateRunState, string> = {
  idle: "Not run yet",
  held: "Held",
  running: "Running",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_INK: Record<SlateRunState, string> = {
  idle: "text-muted-foreground",
  held: "text-status-input",
  running: "text-status-working",
  done: "text-muted-foreground",
  failed: "text-status-failed",
  cancelled: "text-muted-foreground",
};

const textOf = (value: SlateJson | undefined): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** The record's own lines, else the tail of out and err split at line ends. */
function recordLines(record: { lines?: string[]; out?: SlateJson; err?: string }): string[] {
  if (Array.isArray(record.lines)) return record.lines;
  const text = [textOf(record.out), record.err ?? ""].filter(part => part !== "").join("\n");
  return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

const runName = (value: unknown): string | undefined => (typeof value === "string" && /^\$[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) ? value.slice(1) : undefined);

export const output: PieceView = {
  type: "output",
  rowScoped: ["run"],
  component: function OutputPiece({ piece, props, slate, cancel }) {
    const run = runName(piece.props?.["run"]);
    const record = run === undefined ? undefined : slate.values[run];
    const box = useRef<HTMLDivElement>(null);
    const rows = typeof props["lines"] === "number" ? Math.max(3, Math.min(40, Math.floor(props["lines"]))) : 8;
    const state: SlateRunState = isRunRecord(record) && record.state in RUN_WORDS ? record.state : "idle";
    const lines = run === undefined ? [] : (slate.lines(run) ?? (isRunRecord(record) ? recordLines(record) : []));
    const running = state === "running";
    const stale = isRunRecord(record) && record.stale === true && !running;
    useEffect(() => {
      if (running && box.current !== null) box.current.scrollTop = box.current.scrollHeight;
    }, [running, lines.length]);
    if (run === undefined) return <Quiet>{RUN_WORDS.idle}</Quiet>;
    const why = isRunRecord(record) && (state === "held" || state === "failed") ? record.why : undefined;
    const label = str(props["label"]);
    return (
      <div data-slate-output={run} className="flex min-w-0 flex-col gap-1.5">
        <div className="flex h-6 min-w-0 items-center gap-2">
          {label === undefined ? null : <span className="min-w-0 truncate text-[13px] text-foreground">{label}</span>}
          <span data-slate-run-state={state} className={cn("inline-flex items-center gap-1.5 text-[13px]", RUN_INK[state])}>
            {running ? <Crab className="text-status-working" /> : null}
            {RUN_WORDS[state]}
          </span>
          {stale ? (
            <span data-slate-stale className="min-w-0 truncate text-[13px] text-muted-foreground">
              from before the command changed
            </span>
          ) : null}
          {running ? (
            <Button data-slate-cancel={run} variant="ghost" size="xs" className="ml-auto" onClick={() => void cancel(run)}>
              Cancel
            </Button>
          ) : null}
        </div>
        {lines.length === 0 && state === "idle" ? null : (
          <div
            ref={box}
            role="log"
            aria-live={running ? "polite" : "off"}
            className={cn("overflow-y-auto rounded-md bg-accent px-2 py-1.5 font-mono text-xs leading-4 tabular-nums", stale ? "text-muted-foreground" : "text-foreground", props["wrap"] === true ? "whitespace-pre-wrap break-words" : "whitespace-pre")}
            style={{ maxHeight: `calc(${rows} * 1rem + 0.75rem)` }}
          >
            {lines.map((line, at) => (
              <div key={at}>{line === "" ? " " : line}</div>
            ))}
          </div>
        )}
        {why === undefined ? null : <Quiet data-slate-why>{why}</Quiet>}
      </div>
    );
  },
};
