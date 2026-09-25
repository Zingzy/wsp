// SPDX-License-Identifier: AGPL-3.0-only
// The small pieces every level of the agents manager draws: an act as an xs
// outline button with its glyph, a row's or a head's lead, the agents' marks
// after a name, and an MCP server's status as a dot and a word.
import type { LucideIcon } from "lucide-react";
import { agentName } from "@wsp/catalog";
import { cn } from "../../lib/utils.js";
import { FACT } from "../../settings/format.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { Button, DANGER_BUTTON } from "../ui/button.js";
import { Spinner } from "../ui/spinner.js";
import { agentNames, type RowAct } from "./agentsRows.js";
import { NARROW } from "./agentsWidths.js";
import type { Lead, ServerState, ServerStatus } from "./kinds/kind.js";

/** One act as an xs outline button with its glyph: held where it has no road. A held button takes no pointer, so it
 * stands in a box that does: the box carries the hover, and a press on it lands there rather than on the row under it. */
export function ActButton({ act, className }: { act: RowAct; className?: string }) {
  const boxed = act.run === undefined || act.hover !== undefined;
  const Icon = act.icon;
  const button = (
    <Button data-k={`act-${act.id}`} size="xs" variant="outline" held={act.run === undefined} className={cn(act.destructive === true && DANGER_BUTTON, !boxed && className)} {...(act.run === undefined ? {} : { onClick: act.run })}>
      {act.busy === true ? <Spinner className="size-3.5" /> : Icon === undefined ? null : <Icon aria-hidden className="size-3.5" />}
      {act.label}
    </Button>
  );
  if (!boxed) return button;
  return (
    <span className={cn("inline-flex", className)} {...(act.hover === undefined ? {} : { title: act.hover, "data-act-hover": act.id })}>
      {button}
    </span>
  );
}

const TILE = "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-foreground/[0.04]";

/** A row's or a head's lead: the agent's own mark in its hue in a tile, faded where it is not installed; a server's
 * glyph in its bordered box; the kind's glyph. */
export function LeadMark({ lead, label, big = false }: { lead: Lead; label: string; big?: boolean }) {
  if (lead.kind === "agent") {
    return (
      <span data-k="lead-tile" className={TILE}>
        <HarnessMark harness={lead.agent} label={label} className={cn("size-5", lead.faded === true && "text-foreground/40 grayscale")} />
      </span>
    );
  }
  const Icon = lead.icon;
  if (lead.kind === "box") {
    return (
      <span data-k="lead-box" className={TILE}>
        <Icon aria-hidden className="size-4 text-foreground/80" />
      </span>
    );
  }
  return <Icon aria-hidden className={cn("shrink-0 text-foreground/80", big ? "size-5" : "size-4")} />;
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
