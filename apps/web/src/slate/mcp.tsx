// SPDX-License-Identifier: AGPL-3.0-only
// The person's approval before a slate reaches an MCP server (07, "Consent"; 11, "The consent sheet"): once per
// server per thread, a sheet naming the server, the call that asked and every tool the server lists, with Once,
// Always in this thread and Don't; and on every start of a tool that changes things, the destructive dialog with the
// tool and its arguments as they will be sent.
import { useState } from "react";
import { AlertDialog, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { cn } from "../lib/utils.js";
import type { SlateApproval, SlateAsk } from "./model.js";

export type SlateServerAsk = Extract<SlateAsk, { kind: "server" }>;
export type SlateToolAsk = Extract<SlateAsk, { kind: "tool" }>;

export const MCP_WORDS = {
  serverTitle: (server: string) => `Let this slate use ${server}?`,
  toolTitle: (tool: string) => `Call ${tool}?`,
  calls: "Calls",
  reads: "Reads",
  covers: (server: string) => `Covers reading from ${server} and calling its tools in this thread.`,
  lists: (server: string, n: number) => (n === 1 ? `${server} lists 1 tool` : `${server} lists ${n} tools`),
  asksEach: "asks each time",
  readOnly: "read only",
  toolBody: (server: string, computer: string) => `${server} on ${computer}`,
  once: "Once",
  always: "Always in this thread",
  dont: "Don't",
  call: "Call",
  then: "Then its result goes on stdin to",
} as const;

const dots = (value: unknown): boolean => typeof value === "string" && /^•+/.test(value);
const shown = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

/** Each argument by name with the value it carries, a secret as dots, in mono. */
export function ArgList({ args }: { args: Record<string, unknown> | undefined }) {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs leading-4 tabular-nums">
      {entries.map(([name, value]) => (
        <div key={name} data-slate-arg={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className={cn("min-w-0 break-all", dots(value) ? "text-muted-foreground" : "text-foreground")}>{shown(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A run's reshape: the literal command its raw result is piped to, as it will run. */
export function ThenCommand({ then }: { then: string | undefined }) {
  if (then === undefined) return null;
  return (
    <div data-slate-consent-then className="flex min-w-0 flex-col gap-1">
      <p className="text-muted-foreground">{MCP_WORDS.then}</p>
      <pre className="max-h-[calc(6*1rem+1rem)] overflow-auto whitespace-pre-wrap break-all rounded-md bg-accent px-2.5 py-2 font-mono text-xs leading-4 tabular-nums text-foreground">{then}</pre>
    </div>
  );
}

/** Calls answer and closes, or keeps the sheet open with the host's refusal under it. */
function useAnswer(answer: (scope: SlateApproval) => Promise<unknown>, onClose: () => void) {
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
  return { busy, refused, decide };
}

export function ServerConsentSheet({ ask, cadence, answer, onClose }: { ask: SlateServerAsk; cadence: string; answer(scope: SlateApproval): Promise<unknown>; onClose(): void }) {
  const { busy, refused, decide } = useAnswer(answer, onClose);
  const resource = ask.tool !== undefined && ask.tool.includes("://");
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{MCP_WORDS.serverTitle(ask.server)}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="pt-1 pb-0">
          <div data-slate-consent={ask.run} data-slate-consent-server={ask.server} className="flex min-w-0 flex-col gap-3 text-[13px] leading-5">
            {ask.tool === undefined ? null : (
              <div className="flex min-w-0 flex-col gap-1.5">
                <p className="text-foreground">
                  {resource ? MCP_WORDS.reads : MCP_WORDS.calls} <code data-slate-consent-tool className="font-mono text-xs tabular-nums">{ask.tool}</code>
                </p>
                <ArgList args={ask.args} />
                <ThenCommand then={ask.then} />
                <p data-slate-consent-cadence className="text-muted-foreground">
                  {cadence}
                </p>
              </div>
            )}
            {ask.tools.length === 0 ? null : (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-muted-foreground">{MCP_WORDS.lists(ask.server, ask.tools.length)}</p>
                <ul className="flex max-h-48 min-w-0 flex-col gap-1 overflow-y-auto">
                  {ask.tools.map(tool => (
                    <li key={tool.name} data-slate-consent-lists={tool.name} className="flex min-w-0 items-baseline gap-2">
                      <code className="shrink-0 font-mono text-xs tabular-nums text-foreground">{tool.name}</code>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={tool.description}>
                        {tool.title ?? tool.description ?? ""}
                      </span>
                      {tool.destructive === true ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{MCP_WORDS.asksEach}</span>
                      ) : tool.readOnly === true ? (
                        <span className="shrink-0 text-xs text-muted-foreground">{MCP_WORDS.readOnly}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-muted-foreground">
              <span data-slate-consent-where className="text-foreground">
                on {ask.computer}
              </span>
              <br />
              {MCP_WORDS.covers(ask.server)}
            </p>
            {refused === undefined ? null : <p className="text-error-foreground">{refused}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => decide("refuse")}>
            {MCP_WORDS.dont}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => decide("thread")}>
            {MCP_WORDS.always}
          </Button>
          <Button disabled={busy} onClick={() => decide("once")}>
            {MCP_WORDS.once}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ToolConfirmSheet({ ask, answer, onClose }: { ask: SlateToolAsk; answer(scope: SlateApproval): Promise<unknown>; onClose(): void }) {
  const { busy, refused, decide } = useAnswer(answer, onClose);
  return (
    <AlertDialog open onOpenChange={open => (open ? undefined : onClose())}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{MCP_WORDS.toolTitle(ask.tool)}</AlertDialogTitle>
          <AlertDialogDescription>{ask.confirm ?? MCP_WORDS.toolBody(ask.server, ask.computer)}</AlertDialogDescription>
        </AlertDialogHeader>
        <div data-slate-consent={ask.run} data-slate-confirm-tool={ask.tool} className="flex min-w-0 flex-col gap-3 px-5 pt-2 text-[13px] leading-5">
          <ArgList args={ask.args} />
          <ThenCommand then={ask.then} />
          {refused === undefined ? null : <p className="text-error-foreground">{refused}</p>}
        </div>
        <AlertDialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => decide("refuse")}>
            {MCP_WORDS.dont}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => decide("once")}>
            {MCP_WORDS.call}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
