// SPDX-License-Identifier: AGPL-3.0-only
// The person's approval before a slate's command first runs (07, "Consent"; 11, "The consent sheet"): the row under
// the header while a run is held, and the 440 px sheet that shows the whole command text, each environment name with
// the value it carries now (a secret as dots), the computer and the folder, the timeout and who wrote it, with
// Don't, Run once and Always in this thread. A run that names `confirm` asks in the destructive tier every time.
import { useState } from "react";
import type { SlateJson } from "@wsp/protocol";
import { isSlateBinding } from "@wsp/protocol";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { RUNS, type SlateEngine } from "./engine.js";
import { isRunRecord, isSecretHandle, type SlateApproval, type SlateAsk, type SlateRunDecl } from "./model.js";
import { ownPath } from "./paths.js";
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
  noCommand: "This run is no longer in the slate.",
} as const;

/** Where the window says a run goes when the host's ask did not: the thread's computer and folder. */
export interface ConsentWhere {
  computer?: string;
  folder?: string;
}

export interface ConsentRow {
  name: string;
  value: string;
  secret: boolean;
}

export interface ConsentContent {
  run: string;
  cmd: string;
  env: ConsentRow[];
  args: string[];
  stdin?: string;
  where: string;
  wrote: string;
  confirm?: string;
  key?: string;
}

const text = (value: SlateJson | undefined): string => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));
const dots = (len: number | undefined): string => `${"•".repeat(Math.min(24, Math.max(4, len ?? 8)))}${len === undefined ? "" : ` (${len} characters)`}`;

/** The handle an env binding names when it binds a secret whole, else undefined. */
function secretBound(engine: SlateEngine, value: unknown): SlateJson | undefined {
  if (!isSlateBinding(value)) return undefined;
  const path = value.bind.trim();
  if (ownPath(path) === undefined || !engine.isSecret(path)) return undefined;
  const handle = engine.reader()(path);
  return isSecretHandle(handle) ? handle : { secret: true, set: false };
}

/** What the sheet shows: the host's ask where a press brought one, the window's own reading of the document else.
 * A secret is dots with its length whoever filled the row. */
export function consentOf(engine: SlateEngine, run: string, ask: SlateAsk | undefined, here: ConsentWhere): ConsentContent | undefined {
  const decl: SlateRunDecl | undefined = engine.document?.runs?.[run];
  const cmd = ask?.cmd ?? decl?.cmd;
  if (cmd === undefined) return undefined;
  const names = [...new Set([...Object.keys(decl?.env ?? {}), ...Object.keys(ask?.env ?? {})])];
  const env = names.map(name => {
    const handle = secretBound(engine, decl?.env?.[name]);
    if (handle !== undefined) return { name, value: isSecretHandle(handle) && handle.set ? dots(handle.len) : "(empty)", secret: true };
    return { name, value: ask?.env?.[name] ?? text(engine.resolve(decl?.env?.[name])), secret: false };
  });
  const args = ask?.args ?? (Array.isArray(decl?.args) ? decl.args.map(arg => text(engine.resolve(arg))) : []);
  const stdinText = ask?.stdin ?? (decl?.stdin === undefined ? undefined : text(engine.resolve(decl.stdin)));
  const stdin = stdinText === undefined || stdinText === "" ? undefined : stdinText.split("\n")[0];
  const computer = ask?.on ?? here.computer ?? "this computer";
  const folder = ask?.cwd ?? (decl?.cwd === undefined ? here.folder : decl.cwd.startsWith("/") || here.folder === undefined ? decl.cwd : `${here.folder.replace(/\/$/, "")}/${decl.cwd}`);
  const timeout = ask?.timeout ?? decl?.timeout ?? 60;
  return {
    run,
    cmd,
    env,
    args,
    ...(stdin !== undefined ? { stdin } : {}),
    where: `on ${computer}${folder === undefined ? "" : `, in ${folder}`}, ${timeout} s at most`,
    wrote: `${CONSENT_WORDS.wrote}${ask?.turn === undefined ? "" : `, turn ${ask.turn}`}.`,
    ...(decl?.confirm !== undefined ? { confirm: decl.confirm } : {}),
    ...(ask?.key !== undefined ? { key: ask.key } : {}),
  };
}

/** The slate's held runs in document order, each with its command's first line. */
export function heldRuns(engine: SlateEngine): { run: string; cmd: string }[] {
  const runs = engine.document?.runs ?? {};
  return Object.entries(runs).flatMap(([run, decl]) => {
    const record = engine.values[run];
    return isRunRecord(record) && record.state === "held" ? [{ run, cmd: (decl.cmd ?? decl.tool ?? decl.uri ?? run).split("\n")[0] ?? run }] : [];
  });
}

/** One row per held run under the header: the command cut to one line in mono, Review and Don't. */
export function HeldRuns({ engine, review, refuse }: { engine: SlateEngine; review(run: string): void; refuse(run: string): void }) {
  usePieceVersion(engine, RUNS);
  const held = heldRuns(engine);
  if (held.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 pb-1">
      {held.map(({ run, cmd }) => (
        <div key={run} data-slate-held={run} className="flex h-7 min-w-0 items-center gap-2 text-[13px]">
          <span className="shrink-0 text-muted-foreground">{CONSENT_WORDS.wants}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-foreground" title={cmd}>
            {cmd}
          </code>
          <Button variant="outline" size="xs" onClick={() => review(run)}>
            {CONSENT_WORDS.review}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => refuse(run)}>
            {CONSENT_WORDS.dont}
          </Button>
        </div>
      ))}
    </div>
  );
}

export function ConsentSheet({ content, answer, onClose }: { content: ConsentContent; answer(scope: SlateApproval): Promise<unknown>; onClose(): void }) {
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
    <div data-slate-consent={content.run} className="flex min-w-0 flex-col gap-3 text-[13px] leading-5">
      <pre data-slate-consent-cmd className="max-h-[calc(12*1rem+1rem)] overflow-auto whitespace-pre-wrap break-all rounded-md bg-accent px-2.5 py-2 font-mono text-xs leading-4 tabular-nums text-foreground">
        {content.cmd}
      </pre>
      {content.env.length === 0 && content.args.length === 0 && content.stdin === undefined ? null : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs leading-4 tabular-nums">
          {content.env.map(row => (
            <div key={row.name} data-slate-consent-env={row.name} className="contents">
              <dt className="text-muted-foreground">{row.name}</dt>
              <dd className="min-w-0 break-all text-foreground">{row.value}</dd>
            </div>
          ))}
          {content.args.map((arg, at) => (
            <div key={`arg-${at}`} className="contents">
              <dt className="text-muted-foreground">${at + 1}</dt>
              <dd className="min-w-0 break-all text-foreground">{arg}</dd>
            </div>
          ))}
          {content.stdin === undefined ? null : (
            <div className="contents">
              <dt className="text-muted-foreground">stdin</dt>
              <dd className="min-w-0 truncate text-foreground">{content.stdin}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="text-muted-foreground">
        <span data-slate-consent-where className="text-foreground">{content.where}</span>
        <br />
        {content.wrote}
      </p>
      {refused === undefined ? null : <p className="text-error-foreground">{refused}</p>}
    </div>
  );
  if (content.confirm !== undefined) {
    return (
      <AlertDialog open onOpenChange={open => (open ? undefined : onClose())}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{CONSENT_WORDS.title}</AlertDialogTitle>
            <AlertDialogDescription>{content.confirm}</AlertDialogDescription>
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
