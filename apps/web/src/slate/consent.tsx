// SPDX-License-Identifier: AGPL-3.0-only
// The person's approval before a slate's command first runs (07, "Consent"; 11, "The consent sheet"): the row under
// the header while a run is held, and the 440 px sheet that shows the host's ask: the whole command text, each
// environment name with the value it carries now (a secret as dots), the computer and the folder, the timeout and who
// wrote it, with Don't, Run once and Always in this thread. A run that names `confirm` asks in the destructive tier.
import { useState } from "react";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { RUNS, type SlateEngine } from "./engine.js";
import { cn } from "../lib/utils.js";
import { isRunRecord, type SlateApproval, type SlateAsk, type SlateDoc } from "./model.js";
import { ThenCommand } from "./mcp.js";
import { usePieceVersion } from "./SlateView.js";

export const CONSENT_WORDS = {
  title: "Run this command?",
  wants: "This slate wants to run",
  review: "Review",
  dont: "Don't",
  once: "Run once",
  always: "Always in this thread",
  run: "Run",
  wrote: "Written by the agent in this thread",
  reach: "If a script it names changes, it asks again. The command can read anything you can.",
  more: (n: number) => (n === 1 ? "1 more command waits after this one" : `${n} more commands wait after this one`),
} as const;

const seconds = (s: number): string => (s < 120 || s % 60 !== 0 ? `${s} s` : s < 7200 || s % 3600 !== 0 ? `${s / 60} min` : `${s / 3600} h`);

/** How often the run starts and whether it starts while the slate is off screen, as the sheet says it (07,
 * "Consent"): its timer, else the reactions that start it, else a press. */
export function cadenceOf(doc: SlateDoc | null, run: string): string {
  const decl = doc?.runs?.[run];
  if (decl?.every !== undefined) {
    const every = `Runs every ${seconds(decl.every)}`;
    return decl.always === true ? `${every}, also while this slate is not on screen` : `${every}, only while this slate is on screen`;
  }
  const when = (doc?.reactions ?? []).flatMap(reaction =>
    reaction.do.some(step => step.do === "start" && step.run.replace(/^\$/, "") === run) ? ["change" in reaction.on ? `${reaction.on.change.join(" or ")} changes` : `$${reaction.on.done.replace(/^\$/, "")} finishes`] : [],
  );
  return when.length > 0 ? `Runs each time ${when.join(" or ")}` : "Runs when you press it";
}

/** The slate's held runs in document order, each with the host's sheet where the record carries one. */
export function heldRuns(engine: SlateEngine, asks: readonly SlateAsk[]): { run: string; cmd: string; ask: SlateAsk | undefined }[] {
  return Object.entries(engine.document?.runs ?? {}).flatMap(([run, decl]) => {
    const record = engine.values[run];
    if (!isRunRecord(record) || record.state !== "held") return [];
    const ask = asks.find(a => a.run === run);
    const cmd = ask?.kind === "cmd" ? ask.cmd : decl.kind === "cmd" ? decl.cmd : decl.kind === "tool" ? `${decl.server}.${decl.tool}` : `${decl.server}:${decl.uri}`;
    return [{ run, cmd: cmd.split("\n")[0] ?? cmd, ask }];
  });
}

/** One row per held run under the header: the command cut to one line in mono, Review and Don't. */
export function HeldRuns({ engine, asks, review, refuse }: { engine: SlateEngine; asks: readonly SlateAsk[]; review(run: string): void; refuse(ask: SlateAsk): void }) {
  usePieceVersion(engine, RUNS);
  const held = heldRuns(engine, asks);
  if (held.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 pb-1">
      {held.map(({ run, cmd, ask }) => (
        <div key={run} data-slate-held={run} className="flex h-7 min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 text-muted-foreground">{CONSENT_WORDS.wants}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-foreground" title={cmd}>
            {cmd}
          </code>
          <Button variant="outline" size="xs" onClick={() => review(run)}>
            {CONSENT_WORDS.review}
          </Button>
          <Button variant="ghost" size="xs" disabled={ask === undefined} onClick={() => (ask === undefined ? undefined : refuse(ask))}>
            {CONSENT_WORDS.dont}
          </Button>
        </div>
      ))}
    </div>
  );
}

const dots = (value: string): boolean => /^•+/.test(value);

export function ConsentSheet({ ask, cadence, more = 0, answer, onClose }: { ask: Extract<SlateAsk, { kind: "cmd" }>; cadence: string; more?: number; answer(scope: SlateApproval): Promise<unknown>; onClose(): void }) {
  const env = Object.entries(ask.env);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const decide = (scope: SlateApproval) => {
    setBusy(true);
    setRefused(undefined);
    void answer(scope).then(
      () => onClose(),
      (error: unknown) => {
        setBusy(false);
        setRefused(error instanceof Error ? error.message : String(error));
      },
    );
  };
  const body = (
    <div data-slate-consent={ask.run} className="flex min-w-0 flex-col gap-3 text-[13px] leading-5">
      <pre data-slate-consent-cmd className="max-h-[calc(12*1rem+1rem)] overflow-auto whitespace-pre-wrap break-all rounded-md bg-accent px-2.5 py-2 font-mono text-xs leading-4 tabular-nums text-foreground">
        {ask.cmd}
      </pre>
      <ThenCommand then={ask.then} />
      <p data-slate-consent-cadence className="text-foreground">
        {cadence}
      </p>
      {env.length === 0 && ask.args.length === 0 && ask.stdin === undefined ? null : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs leading-4 tabular-nums">
          {env.map(([name, value]) => (
            <div key={name} data-slate-consent-env={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className={cn("min-w-0 break-all", dots(value) ? "text-muted-foreground" : "text-foreground")}>{value}</dd>
            </div>
          ))}
          {ask.args.map((arg, at) => (
            <div key={`arg-${at}`} className="contents">
              <dt className="text-muted-foreground">${at + 1}</dt>
              <dd className="min-w-0 break-all text-foreground">{arg}</dd>
            </div>
          ))}
          {ask.stdin === undefined ? null : (
            <div className="contents">
              <dt className="text-muted-foreground">stdin</dt>
              <dd className="min-w-0 truncate text-foreground">{ask.stdin}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="text-muted-foreground">
        <span data-slate-consent-where className="text-foreground">
          on {ask.computer}, in {ask.folder}, {ask.timeoutS} s at most
        </span>
        <br />
        {CONSENT_WORDS.wrote}.
      </p>
      <p data-slate-consent-reach className="text-muted-foreground">{CONSENT_WORDS.reach}</p>
      {more > 0 ? <p data-slate-consent-more className="text-muted-foreground">{CONSENT_WORDS.more(more)}</p> : null}
      {refused === undefined ? null : <p className="text-error-foreground">{refused}</p>}
    </div>
  );
  if (ask.confirm !== undefined) {
    return (
      <AlertDialog open onOpenChange={open => (open ? undefined : onClose())}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{CONSENT_WORDS.title}</AlertDialogTitle>
            <AlertDialogDescription>{ask.confirm}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-5 pt-2">{body}</div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{CONSENT_WORDS.dont}</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => decide("once")}>
              {CONSENT_WORDS.run}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  }
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{CONSENT_WORDS.title}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="pt-1 pb-0">{body}</DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => decide("refuse")}>
            {CONSENT_WORDS.dont}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => decide("thread")}>
            {CONSENT_WORDS.always}
          </Button>
          <Button disabled={busy} onClick={() => decide("once")}>
            {CONSENT_WORDS.once}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
