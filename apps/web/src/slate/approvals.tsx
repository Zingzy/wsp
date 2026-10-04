// SPDX-License-Identifier: AGPL-3.0-only
// Several commands and servers waiting at once ask in one sheet: each its own row with what the one-at-a-time sheet
// would show and a switch, and Allow all, Run once and Don't answer the rows switched on, each by its own key, so an
// approval reads exactly as if it had been given one sheet at a time. A command that names confirm, and a tool's
// confirm, still ask alone, since they ask on every start.
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../components/ui/dialog.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/utils.js";
import { CONSENT_WORDS } from "./consent.js";
import { ArgList, MCP_WORDS, ThenCommand } from "./mcp.js";
import type { SlateApproval, SlateAsk } from "./model.js";

export type BatchAsk = Extract<SlateAsk, { kind: "cmd" | "server" }>;

export const APPROVALS_WORDS = {
  title: (asks: readonly BatchAsk[]) =>
    asks.every(ask => ask.kind === "cmd") ? `Run these ${asks.length} commands?` : `Let this slate run these ${asks.length}?`,
  server: (server: string) => `Use ${server}`,
  allowAll: "Allow all",
  allow: (n: number) => `Allow ${n}`,
  once: CONSENT_WORDS.once,
  dont: CONSENT_WORDS.dont,
} as const;

/** The asks one sheet can answer together, one row per key: commands with no confirm, and servers. */
export function batchable(asks: readonly SlateAsk[]): BatchAsk[] {
  const rows = new Map<string, BatchAsk>();
  for (const ask of asks) if ((ask.kind === "cmd" && ask.confirm === undefined) || ask.kind === "server") if (!rows.has(ask.key)) rows.set(ask.key, ask);
  return [...rows.values()];
}

const dots = (value: string): boolean => /^•+/.test(value);

function CommandRow({ ask, cadence }: { ask: Extract<SlateAsk, { kind: "cmd" }>; cadence: string }) {
  const env = Object.entries(ask.env);
  return (
    <>
      <pre data-slate-consent-cmd className="max-h-[calc(4*1rem+1rem)] overflow-auto whitespace-pre-wrap break-all rounded-md bg-accent px-2.5 py-2 font-mono text-xs leading-4 tabular-nums text-foreground">
        {ask.cmd}
      </pre>
      <ThenCommand then={ask.then} />
      <p data-slate-consent-cadence className="text-muted-foreground">
        {cadence}
      </p>
      {env.length === 0 ? null : (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs leading-4 tabular-nums">
          {env.map(([name, value]) => (
            <div key={name} data-slate-consent-env={name} className="contents">
              <dt className="text-muted-foreground">{name}</dt>
              <dd className={cn("min-w-0 break-all", dots(value) ? "text-muted-foreground" : "text-foreground")}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

function ServerRow({ ask, cadence }: { ask: Extract<SlateAsk, { kind: "server" }>; cadence: string }) {
  const resource = ask.tool !== undefined && ask.tool.includes("://");
  return (
    <>
      <p className="text-foreground">
        {APPROVALS_WORDS.server(ask.server)}
        {ask.tool === undefined ? null : (
          <span className="text-muted-foreground">
            {" "}
            {resource ? MCP_WORDS.reads.toLowerCase() : MCP_WORDS.calls.toLowerCase()} <code data-slate-consent-tool className="font-mono text-xs tabular-nums text-foreground">{ask.tool}</code>
          </span>
        )}
      </p>
      <ArgList args={ask.args} />
      <ThenCommand then={ask.then} />
      <p data-slate-consent-cadence className="text-muted-foreground">
        {cadence}
      </p>
      <p className="text-muted-foreground">
        {ask.tools.length === 0 ? null : <>{MCP_WORDS.lists(ask.server, ask.tools.length)}. </>}
        {MCP_WORDS.covers(ask.server)}
      </p>
    </>
  );
}

export function ApprovalsSheet({ asks, cadence, answer, onClose }: { asks: readonly BatchAsk[]; cadence(run: string): string; answer(key: string, scope: SlateApproval): Promise<unknown>; onClose(): void }) {
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const chosen = asks.filter(ask => !off.has(ask.key));
  const decide = (scope: SlateApproval) => {
    setBusy(true);
    setRefused(undefined);
    void chosen
      .reduce<Promise<unknown>>((before, ask) => before.then(() => answer(ask.key, scope)), Promise.resolve())
      .then(
        () => onClose(),
        (error: unknown) => {
          setBusy(false);
          setRefused(error instanceof Error ? error.message : String(error));
        },
      );
  };
  const toggle = (key: string, on: boolean) =>
    setOff(was => {
      const next = new Set(was);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });
  const where = [...new Set(asks.map(ask => (ask.kind === "cmd" ? `on ${ask.computer}, in ${ask.folder}` : `on ${ask.computer}`)))];
  return (
    <Dialog open onOpenChange={open => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{APPROVALS_WORDS.title(asks)}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="pt-1 pb-0">
          <div data-slate-approvals className="flex min-w-0 flex-col gap-5 text-[13px] leading-5">
            {asks.map(ask => {
              const on = !off.has(ask.key);
              return (
                <div key={ask.key} data-slate-approval={ask.key} data-on={on} className={cn("flex min-w-0 gap-3", on ? undefined : "opacity-60")}>
                  <Switch checked={on} onCheckedChange={checked => toggle(ask.key, checked)} aria-label={ask.kind === "cmd" ? ask.cmd : APPROVALS_WORDS.server(ask.server)} className="mt-1.5" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">{ask.kind === "cmd" ? <CommandRow ask={ask} cadence={cadence(ask.run)} /> : <ServerRow ask={ask} cadence={cadence(ask.run)} />}</div>
                </div>
              );
            })}
            <p data-slate-consent-where className="text-muted-foreground">
              {where.join("; ")}. {CONSENT_WORDS.wrote}.
            </p>
            {refused === undefined ? null : <p className="text-error-foreground">{refused}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy || chosen.length === 0} onClick={() => decide("refuse")}>
            {APPROVALS_WORDS.dont}
          </Button>
          <Button variant="outline" disabled={busy || chosen.length === 0} onClick={() => decide("thread")}>
            {chosen.length === asks.length ? APPROVALS_WORDS.allowAll : APPROVALS_WORDS.allow(chosen.length)}
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => decide("once")}>
            {APPROVALS_WORDS.once}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
