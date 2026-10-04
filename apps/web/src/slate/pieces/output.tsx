// SPDX-License-Identifier: AGPL-3.0-only
// A run's output as it streams (05, "The output of a run"): a row of the card with its label and its state as one word,
// a quiet Cancel in the slot while it runs, then the tail of its lines as the next row in 12 px mono, `lines` rows
// tall, following the end while it runs, no box of its own; why under them when held or failed.
// A finished run keeps its last lines until it next starts; after the agent changed its command they read as stale.
import { useEffect, useRef } from "react";
import type { SlateJson } from "@wsp/protocol";
import { Crab } from "../../components/status/Crab.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";
import { isRunRecord, type SlateRunState } from "../model.js";
import { ResultByShape } from "../shape.js";
import type { PieceView } from "../SlateView.js";
import { CARD_SURFACE } from "../../settings/rows.js";
import { str } from "./look.js";
import { placeOf } from "./runs.js";
import { Quiet } from "./quiet.js";
import { Refreshing } from "./refreshing.js";

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
  fills: true,
  component: function OutputPiece({ id, piece, props, slate, raise, cancel, sender }) {
    const run = runName(piece.props?.["run"]);
    const record = run === undefined ? undefined : slate.values[run];
    const box = useRef<HTMLDivElement>(null);
    const rows = typeof props["lines"] === "number" ? Math.max(3, Math.min(40, Math.floor(props["lines"]))) : 8;
    const state: SlateRunState = isRunRecord(record) && record.state in RUN_WORDS ? record.state : "idle";
    const lines = run === undefined ? [] : (slate.lines(run) ?? (isRunRecord(record) ? recordLines(record) : []));
    // A refresh draws the last result with a quiet mark, never the running row's crab and Cancel.
    const refreshing = run !== undefined && slate.refreshing(run);
    const running = state === "running" && !refreshing;
    const stale = isRunRecord(record) && record.stale === true && !running;
    useEffect(() => {
      if (state === "running" && box.current !== null) box.current.scrollTop = box.current.scrollHeight;
    }, [state, lines.length]);
    if (run === undefined) return <Quiet>{RUN_WORDS.idle}</Quiet>;
    const why = isRunRecord(record) && (state === "held" || state === "failed") ? record.why : undefined;
    // A tool or resource run's result draws by its shape; its failure and a command's output stay lines.
    const kind = slate.document?.runs?.[run]?.kind;
    const result = kind !== undefined && kind !== "cmd" && isRunRecord(record) && state !== "failed" ? (record.json ?? record.out) : undefined;
    const label = str(props["label"]);
    const place = placeOf(slate, id);
    const inset = place === "inside" ? "" : "px-(--settings-inset,20px)";
    return (
      <div data-slate-output={run} className={cn("flex min-w-0 flex-col [&>*+*]:border-t [&>*+*]:border-border/50", place === "page" && CARD_SURFACE)}>
        <div className={cn("flex min-h-11 min-w-0 items-center gap-3 py-3", inset)}>
          {label === undefined ? null : <span className="min-w-0 truncate text-sm leading-5 text-foreground">{label}</span>}
          <span className="flex-1" />
          <span data-slate-run-state={state} className={cn("inline-flex shrink-0 items-center gap-1.5 text-[13px] leading-5 whitespace-nowrap", refreshing ? "text-muted-foreground" : RUN_INK[state], state === "failed" || state === "held" ? "font-medium" : "")}>
            {running ? <Crab className="text-status-working" /> : null}
            {refreshing ? <Refreshing /> : RUN_WORDS[state]}
          </span>
          {stale ? (
            <span data-slate-stale className="min-w-0 truncate text-[13px] text-muted-foreground">
              from before the command changed
            </span>
          ) : null}
          {running ? (
            <Button data-slate-cancel={run} variant="outline" size="xs" onClick={() => void cancel(run)}>
              Cancel
            </Button>
          ) : null}
        </div>
        {result !== undefined ? (
          <div data-slate-result={run} className={cn("min-w-0 py-3", inset)}>
            <ResultByShape value={result} shared={{ id, slate, raise, cancel, sender }} />
          </div>
        ) : lines.length === 0 && state === "idle" ? null : (
          <div
            ref={box}
            role="log"
            aria-live={running ? "polite" : "off"}
            className={cn("overflow-y-auto py-2.5 font-mono text-xs leading-4 tabular-nums", inset, stale ? "text-muted-foreground" : "text-foreground", props["wrap"] === true ? "whitespace-pre-wrap break-words" : "whitespace-pre")}
            style={{ maxHeight: `calc(${rows} * 1rem + 1.25rem)` }}
          >
            {lines.map((line, at) => (
              <div key={at}>{line === "" ? " " : line}</div>
            ))}
          </div>
        )}
        {why === undefined ? null : <Quiet data-slate-why className={cn("py-2.5", inset)}>{why}</Quiet>}
      </div>
    );
  },
};
