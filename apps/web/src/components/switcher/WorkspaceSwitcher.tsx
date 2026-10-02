// SPDX-License-Identifier: AGPL-3.0-only
// The overlay the switch chord holds up: one card per thread the sidebar
// lists, most recently opened first, in one row, the highlight walking them
// while the chord's modifier is down. It takes no focus and traps none, since
// the person is mid-chord and the dispatcher owns the keys. Every card is the
// same box whatever it holds, so the highlight moving changes colour and
// nothing else. The paint waits out SWITCHER_PAINT_DELAY_MS while the state
// does not, so a tap switches without ever dimming the app.
import { useEffect, useMemo, useState } from "react";
import { agentName } from "@wsp/catalog";
import { deriveSidebarProjects } from "../../adapt/index.js";
import { cn } from "../../lib/utils.js";
import { ProjectGlyph } from "../../projects/look.js";
import { useStore } from "../../protocol/store.js";
import { capturePagePreview, loadPagePreviews, useWorkspacePreviews } from "../../shell/workspacePreviews.js";
import { highlightedTarget, SWITCHER_PAINT_DELAY_MS, useWorkspaceSwitcher } from "../../shell/workspaceSwitcher.js";
import { HarnessMark } from "../chat/HarnessMark.js";
import { restingAge } from "../status/restingAge.js";
import { ThreadStatus } from "../status/ThreadStatus.js";
import { buildSwitcherCards, type SwitcherCard } from "./switcherCards.js";

export function WorkspaceSwitcher() {
  const open = useWorkspaceSwitcher(s => s.open);
  const targets = useWorkspaceSwitcher(s => s.targets);
  const highlighted = useWorkspaceSwitcher(s => highlightedTarget(s)?.threadId ?? null);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const places = useStore(s => s.places);
  const images = useWorkspacePreviews(s => s.images);
  const [painted, setPainted] = useState(false);

  // The picture is asked for from inside the store update that switches, before React draws the thread arriving, so
  // what the shell photographs is the one being left. Every switch runs through here, whatever raised it.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const left = previous.selectedThreadId;
        if (left === null || (left === state.selectedThreadId && previous.selectedId === state.selectedId)) return;
        capturePagePreview(left);
      }),
    [],
  );

  useEffect(() => {
    if (open) void loadPagePreviews(targets.map(target => target.threadId));
  }, [open, targets]);

  // The hold, not the step, is what asks for the overlay: a chord let go inside the delay paints nothing. Stepping
  // again does not restart it, so the wait is from the first press however many cards a person walks.
  useEffect(() => {
    if (!open) {
      setPainted(false);
      return;
    }
    const timer = setTimeout(() => setPainted(true), SWITCHER_PAINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const cards = useMemo(() => {
    if (!open || !painted) return [];
    return buildSwitcherCards({ projects: deriveSidebarProjects({ workspaces, statuses, sessions }), places, targets, images });
  }, [targets, images, open, painted, places, sessions, statuses, workspaces]);

  if (!open || !painted) return null;
  return (
    <div className="dialog-backdrop fixed inset-0 z-[140] flex items-center justify-center">
      <div aria-label="Task switcher" className="dropdown-glass popover-shadow flex max-w-[calc(100vw-4rem)] gap-2 rounded-lg p-2" data-workspace-switcher role="listbox">
        {cards.map(card => (
          <SwitcherCardView card={card} highlighted={card.threadId === highlighted} key={card.threadId} />
        ))}
      </div>
    </div>
  );
}

/** A card shrinks with the window rather than wrapping, all of them one row at any width the app opens at. */
function SwitcherCardView({ card, highlighted }: { card: SwitcherCard; highlighted: boolean }) {
  return (
    <div
      aria-selected={highlighted}
      className={cn("flex w-56 min-w-0 flex-col gap-1 rounded-md p-2 text-left transition-colors duration-150", highlighted && "bg-foreground/[0.09]")}
      data-thread-card={card.threadId}
      role="option"
    >
      <CardPreview card={card} />
      <span className="truncate text-foreground text-sm" data-card-name>
        {card.name}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs" data-card-thread>
        <HarnessMark harness={card.thread.harness} label={agentName(card.thread.harness)} className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{card.place}</span>
        <ThreadStatus thread={card.thread} age={restingAge(card.thread)} crab />
      </span>
    </div>
  );
}

/** The well keeps its box whether or not a picture has been taken, so a first capture does not move the card, and a
 * well with none holds the project's glyph. A picture draws its own edge; an empty well is a fill, and a fill cannot
 * hold an edge on a light card, where the muted tint lands two parts in 255 of the white under it. So the empty well
 * wears a hairline instead, which reads on both surfaces, and the ring is drawn inside the box so it moves nothing
 * when the picture lands. */
function CardPreview({ card }: { card: SwitcherCard }) {
  const empty = card.image === null;
  return (
    <div className={cn("mb-1 flex h-[5.5rem] items-center justify-center overflow-hidden rounded-sm bg-muted/40 text-muted-foreground", empty && "ring-1 ring-border ring-inset")} data-card-preview data-card-preview-empty={empty ? "" : undefined}>
      {empty ? <ProjectGlyph projectId={card.projectId} className="size-6" /> : <img alt="" className="h-full w-full object-cover object-top" src={card.image} />}
    </div>
  );
}
