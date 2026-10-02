// SPDX-License-Identifier: AGPL-3.0-only
// The small pieces the agents lists draw: an act as an xs outline button with
// its glyph, or the shared Add button where it is an add, a row's or a head's
// lead, and the agents' marks after a name.
import type { LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { agentName } from "@wsp/catalog";
import { FACT } from "../../settings/format.js";
import { GLYPH_FRAME } from "../../settings/grid.js";
import { HarnessMark, MarkSvg } from "../chat/HarnessMark.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../ui/alert-dialog.js";
import { AddButton } from "../ui/add-button.js";
import { Button, DANGER_BUTTON, NEUTRAL_RING } from "../ui/button.js";
import { Spinner } from "../ui/spinner.js";
import { AGENTS_LIST_WORDS as W, agentNames, type RowAct } from "./agentsRows.js";
import { useServerIcon } from "./useServerIcon.js";
import type { Lead } from "./kinds/kind.js";

/** One act as an xs outline button with its glyph: held where it has no road. A held button takes no pointer, so it
 * stands in a box that does: the box carries the hover, and a press on it lands there rather than on the row under it.
 * An act that asks first opens its confirmation, whose own button is the one red at rest. */
export function ActButton({ act, k }: { act: RowAct; k?: string }) {
  const [asking, setAsking] = useState(false);
  const boxed = act.run === undefined || act.hover !== undefined;
  const Icon = act.icon;
  const run = act.run === undefined ? undefined : act.confirm === undefined ? act.run : () => setAsking(true);
  const shared = {
    "data-k": k ?? `act-${act.id}`,
    size: "xs",
    held: run === undefined,
    ...(act.destructive === true ? { className: DANGER_BUTTON } : {}),
    ...(run === undefined ? {} : { onClick: run }),
  } as const;
  const button =
    act.add === true ? (
      <AddButton {...shared} busy={act.busy === true}>
        {act.label}
      </AddButton>
    ) : (
      <Button {...shared} variant="outline">
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
    <span className="inline-flex" {...(act.hover === undefined ? {} : { title: act.hover, "data-act-hover": act.id })}>
      {button}
      {confirm}
    </span>
  );
}

/** A row's or a head's lead: the agent's own mark in its own colours in a tile, installed or not; a server's
 * brand mark, icon or glyph in its bordered box; the kind's glyph. `bare` draws the mark alone, for a host that
 * stands it in a frame of its own. */
export function LeadMark({ lead, label, bare = false }: { lead: Lead; label: string; bare?: boolean }) {
  const frame = (k: string, inner: ReactNode) =>
    bare ? (
      inner
    ) : (
      <span data-k={k} className={GLYPH_FRAME}>
        {inner}
      </span>
    );
  if (lead.kind === "agent") return frame("lead-tile", <HarnessMark harness={lead.agent} label={label} className={bare ? "size-4" : "size-5"} />);
  const Icon = lead.icon;
  if (lead.kind === "box" && lead.mark !== undefined) return frame("lead-box", <MarkSvg mark={lead.mark} className="size-[18px]" data-brand-mark={lead.mark.id} />);
  if (lead.kind === "box") return frame("lead-box", <BoxIcon icon={Icon} host={lead.host} />);
  return <Icon aria-hidden className="size-4 shrink-0 text-foreground/80" />;
}

/** A server's own icon as the host fetched it, or the glyph where it has none or icons are off. */
function BoxIcon({ icon: Icon, host }: { icon: LucideIcon; host: string | undefined }) {
  const src = useServerIcon(host);
  return src === null ? <Icon aria-hidden className="size-4 text-foreground/80" /> : <img data-k="server-icon" src={src} alt="" draggable={false} className="size-5 rounded-sm object-contain" />;
}

/** The marks of the agents a skill or a server is set up for, after its name: four, then how many more; every name
 * on the hover. */
export function AgentMarks({ agents }: { agents: readonly string[] }) {
  if (agents.length === 0) return null;
  const more = agents.length - 4;
  return (
    <span data-row-marks className="flex shrink-0 items-center gap-1" title={agentNames(agents)}>
      {agents.slice(0, 4).map(agent => (
        <HarnessMark key={agent} harness={agent} label={agentName(agent)} className="size-3.5" />
      ))}
      {more > 0 ? <span className={FACT}>+{more}</span> : null}
    </span>
  );
}
