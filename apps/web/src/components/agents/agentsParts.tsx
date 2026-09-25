// SPDX-License-Identifier: AGPL-3.0-only
// The small pieces every level of the agents manager draws: an act as an xs
// outline button with its glyph, a row's or a head's lead, the agents' marks
// after a name, an MCP server's status as a dot and a word, and one pick of a
// few in a select.
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { agentName } from "@wsp/catalog";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../ui/alert-dialog.js";
import { Button, DANGER_BUTTON, NEUTRAL_RING } from "../ui/button.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select.js";
import { Spinner } from "../ui/spinner.js";
import { AGENTS_LIST_WORDS as W, agentNames, type RowAct, type PickOption } from "./agentsRows.js";
import { NARROW } from "./agentsWidths.js";
import { useServerIcon } from "./useServerIcon.js";
import type { Lead, ServerState, ServerStatus } from "./kinds/kind.js";

/** One act as an xs outline button with its glyph: held where it has no road. A held button takes no pointer, so it
 * stands in a box that does: the box carries the hover, and a press on it lands there rather than on the row under it.
 * An act that asks first opens its confirmation, whose own button is the one red at rest. */
export function ActButton({ act, className }: { act: RowAct; className?: string }) {
  const [asking, setAsking] = useState(false);
  const boxed = act.run === undefined || act.hover !== undefined;
  const Icon = act.icon;
  const run = act.run === undefined ? undefined : act.confirm === undefined ? act.run : () => setAsking(true);
  const button = (
    <Button data-k={`act-${act.id}`} size="xs" variant="outline" held={run === undefined} className={cn(act.destructive === true && DANGER_BUTTON, !boxed && className)} {...(run === undefined ? {} : { onClick: run })}>
      {act.busy === true ? <Spinner className="size-3.5" /> : Icon === undefined ? null : <Icon aria-hidden className="size-3.5" />}
      {act.label}
    </Button>
  );
  const confirm =
    act.confirm === undefined || act.run === undefined ? null : (
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup data-k={`confirm-${act.id}`}>
          <AlertDialogHeader>
            <AlertDialogTitle>{act.confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>{act.confirm.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{W.cancel}</AlertDialogClose>
            <Button
              data-k={`confirm-${act.id}-go`}
              variant="destructive"
              onClick={() => {
                setAsking(false);
                act.run!();
              }}
            >
              {Icon === undefined ? null : <Icon aria-hidden />}
              {act.label}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    );
  if (!boxed)
    return confirm === null ? (
      button
    ) : (
      <>
        {button}
        {confirm}
      </>
    );
  return (
    <span className={cn("inline-flex", className)} {...(act.hover === undefined ? {} : { title: act.hover, "data-act-hover": act.id })}>
      {button}
      {confirm}
    </span>
  );
}

const TILE = "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.04]";

/** A row's or a head's lead: the agent's own mark in its own colours in a tile, installed or not; a server's
 * glyph in its bordered box; the kind's glyph. */
export function LeadMark({ lead, label, big = false }: { lead: Lead; label: string; big?: boolean }) {
  if (lead.kind === "agent") {
    return (
      <span data-k="lead-tile" className={TILE}>
        <HarnessMark harness={lead.agent} label={label} className="size-5" />
      </span>
    );
  }
  const Icon = lead.icon;
  if (lead.kind === "box") return <BoxLead icon={Icon} host={lead.host} />;
  return <Icon aria-hidden className={cn("shrink-0 text-foreground/80", big ? "size-5" : "size-4")} />;
}

/** A server's box: its own icon as the host fetched it, or the glyph where it has none or icons are off. */
function BoxLead({ icon: Icon, host }: { icon: LucideIcon; host: string | undefined }) {
  const src = useServerIcon(host);
  return (
    <span data-k="lead-box" className={TILE}>
      {src === null ? <Icon aria-hidden className="size-4 text-foreground/80" /> : <img data-k="server-icon" src={src} alt="" draggable={false} className="size-5 rounded-sm object-contain" />}
    </span>
  );
}

/** The marks of the agents a skill or a server is set up for, after its name: four, or two in a narrow container,
 * then how many more; every name on the hover. */
export function AgentMarks({ agents }: { agents: readonly string[] }) {
  if (agents.length === 0) return null;
  const wide = agents.length - 4;
  const narrow = agents.length - 2;
  return (
    <span data-row-marks className="flex shrink-0 items-center gap-1" title={agentNames(agents)}>
      {agents.slice(0, 4).map((agent, at) => (
        <span key={agent} className={cn("inline-flex", at >= 2 && NARROW.hidden)}>
          <HarnessMark harness={agent} label={agentName(agent)} className="size-3.5" />
        </span>
      ))}
      {wide > 0 ? <span className={cn(FACT, NARROW.hidden)}>+{wide}</span> : null}
      {narrow > 0 ? <span className={cn(FACT, "hidden", NARROW.shown)}>+{narrow}</span> : null}
    </span>
  );
}

// The colour law's written exception: on this dot only, green is connected, amber needs sign-in, red failed.
const DOTS: Record<ServerState, string> = {
  connected: "bg-success",
  "signed-in": "bg-success",
  "needs-sign-in": "bg-warning",
  failed: "bg-destructive",
  open: "bg-foreground/30",
  "env-key": "bg-foreground/30",
  off: "bg-foreground/30",
  unknown: "bg-foreground/30",
};

export function ServerStatusView({ status, className }: { status: ServerStatus; className?: string }) {
  return (
    <span data-k="server-status" data-state={status.state} className={cn("inline-flex min-w-0 items-center gap-1.5", className)} {...(status.hover === undefined ? {} : { title: status.hover })}>
      <span data-status-dot aria-hidden className={cn("size-2 shrink-0 rounded-full", DOTS[status.state])} />
      <span data-status-word className="truncate font-mono text-[11px] text-muted-foreground">
        {status.words}
      </span>
    </span>
  );
}

function OptionView({ option }: { option: PickOption }) {
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="truncate">{option.label}</span>
      {option.fact === undefined ? null : <span className={cn(FACT, "truncate")}>{option.fact}</span>}
    </span>
  );
}

/** One pick of a few, each option by its name with a fact beside it where it has one, the trigger as its option
 * reads. A value no option carries draws an empty trigger, never the value, and `lost` says under it why. */
export function OneOf({ k, label, options, value, set, lost, className }: { k: string; label: string; options: readonly PickOption[]; value: string; set: (value: string) => void; lost?: string; className?: string }) {
  const optionOf = (v: string): PickOption | undefined => options.find(o => o.value === v);
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <Select value={value} onValueChange={v => typeof v === "string" && set(v)}>
        <SelectTrigger size="default" aria-label={label} data-k={k} className={cn("h-8 min-h-8 w-full", className)}>
          <SelectValue>
            {(v: string) => {
              const option = optionOf(v);
              return option === undefined ? null : <OptionView option={option} />;
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map(o => (
            <SelectItem key={o.value} value={o.value}>
              <OptionView option={o} />
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {lost === undefined ? null : (
        <span data-k={`${k}-lost`} className="text-xs text-muted-foreground">
          {lost}
        </span>
      )}
    </span>
  );
}
