// SPDX-License-Identifier: AGPL-3.0-only
// The overlay the switch chord holds up: one card per workspace in sidebar
// order, the highlight walking them while the chord's modifier is down. It
// takes no focus and traps none, since the person is mid-chord and the
// dispatcher owns the keys. Every card is the same box whatever it holds, so
// the highlight moving changes colour and nothing else. The paint waits out
// SWITCHER_PAINT_DELAY_MS while the state does not, so a tap switches without
// ever dimming the app.
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveSidebarProjects } from "../../adapt/index.js";
import { cn } from "../../lib/utils.js";
import { desktopBridge } from "../../lib/desktopShell.js";
import { useStore } from "../../protocol/store.js";
import { capturePagePreview, loadPagePreviews, useWorkspacePreviews } from "../../shell/workspacePreviews.js";
import { highlightedWorkspaceId, SWITCHER_PAINT_DELAY_MS, useWorkspaceSwitcher } from "../../shell/workspaceSwitcher.js";
import { buildSwitcherCards, type SwitcherCard } from "./switcherCards.js";

export function WorkspaceSwitcher() {
  const open = useWorkspaceSwitcher(s => s.open);
  const ids = useWorkspaceSwitcher(s => s.ids);
  const highlighted = useWorkspaceSwitcher(highlightedWorkspaceId);
  const from = useWorkspaceSwitcher(s => s.from);
  const workspaces = useStore(s => s.workspaces);
  const statuses = useStore(s => s.statuses);
  const sessions = useStore(s => s.sessions);
  const costs = useStore(s => s.costs);
  const selectedThreadId = useStore(s => s.selectedThreadId);
  const lines = useWorkspacePreviews(s => s.lines);
  const images = useWorkspacePreviews(s => s.images);
  const [painted, setPainted] = useState(false);

  // The picture is asked for from inside the store update that switches, before React draws the workspace arriving,
  // so what the shell photographs is the one being left. Every switch runs through here, whatever raised it.
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        const left = previous.selectedId;
        if (left === null || left === state.selectedId) return;
        // A creation row's key is not a workspace; photographing one would spend a slot nothing ever reads.
        if (previous.creations.some(creation => creation.key === left)) return;
        capturePagePreview(left);
      }),
    [],
  );

  useEffect(() => {
    if (open) void loadPagePreviews(ids);
  }, [open, ids]);

  // The hold, not the step, is what asks for the overlay: a chord let go inside the delay paints nothing. Stepping
  // again does not restart it, so the wait is from the first press however many workspaces a person walks.
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
    return buildSwitcherCards({
      projects: deriveSidebarProjects({ workspaces, statuses, sessions }),
      ids,
      costs,
      lines,
      images,
      currentId: from,
      pinnedThreadId: selectedThreadId,
    });
  }, [costs, from, ids, images, lines, open, painted, selectedThreadId, sessions, statuses, workspaces]);

  if (!open || !painted) return null;
  return (
    <div className="dialog-backdrop fixed inset-0 z-[140] flex items-center justify-center">
      <div
        aria-label="Workspace switcher"
        className="dropdown-glass popover-shadow grid max-h-[70vh] max-w-[calc(100vw-4rem)] grid-cols-[repeat(auto-fit,minmax(14rem,14rem))] gap-2 overflow-y-auto rounded-lg p-2"
        data-workspace-switcher
        role="listbox"
      >
        {cards.map(card => (
          <SwitcherCardView card={card} highlighted={card.workspaceId === highlighted} key={card.workspaceId} />
        ))}
      </div>
    </div>
  );
}

function SwitcherCardView({ card, highlighted }: { card: SwitcherCard; highlighted: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlighted]);
  return (
    <div
      aria-selected={highlighted}
      className={cn("flex w-56 flex-col gap-1 rounded-md p-2 text-left transition-colors duration-150", highlighted && "bg-foreground/[0.09]")}
      data-workspace-card={card.workspaceId}
      ref={ref}
      role="option"
    >
      {desktopBridge()?.workspacePreview !== undefined ? <CardPreview card={card} /> : null}
      <span className="truncate font-medium text-foreground text-sm" data-card-name>
        {card.name}
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground/70" data-card-meta>
        {[card.stateWord, ...(card.costToday !== null ? [card.costToday] : []), ...(card.current ? ["open"] : [])].join(" · ")}
      </span>
      <span className="truncate text-foreground/80 text-xs" data-card-thread>
        {card.threadTitle ?? "No threads yet"}
      </span>
      <span className="min-h-4 truncate text-[11px] text-muted-foreground/70" data-card-line>
        {card.lastLine ?? ""}
      </span>
    </div>
  );
}

/** The well keeps its box whether or not a picture has been taken, so a first capture does not move the card. */
function CardPreview({ card }: { card: SwitcherCard }) {
  return (
    <div className="mb-1 flex h-[5.5rem] items-center justify-center overflow-hidden rounded-sm bg-muted/40" data-card-preview>
      {card.image === null ? (
        <span className="font-mono text-[10px] text-muted-foreground/60">no capture yet</span>
      ) : (
        <img alt="" className="h-full w-full object-cover object-top" src={card.image} />
      )}
    </div>
  );
}
