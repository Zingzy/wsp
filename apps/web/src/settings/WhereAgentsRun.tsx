// SPDX-License-Identifier: AGPL-3.0-only
// Where agents run: one table of every computer and provider this wsp holds,
// this computer first. A row opens its own detail under it, where what the host
// knows about that computer is listed and the three things a person can do to
// it stand; the row menu holds the same three, for a hand that never opened the
// row. Under the table the two roads to another one.
//
// The list, the doors and the events behind them are the store's (places,
// openAddComputer, openConnectProvider): both sheets are opened from the store,
// so the palette's rows and these buttons take one road to each.
//
// The detail opens on a row carrying aria-expanded rather than on the
// collapsible component: a collapsible panel animates its height and needs a
// block box, which a table row is not, and TableRow already dims itself on
// has-aria-expanded for exactly this.
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { PLACES_TICKET_REFUSAL, PLACES_WORDS, isLocalWorkspace, offlineFor, placeSpendLine, placesSpendFoot, workspaceStateOf, workspaceWord, type PlaceSpend, type PlaceView, type SealedImageCopy, type WorkspaceStatus, type WorkspaceView, absentRoad, awayMsOf, lastKnown } from "@wsp/protocol";
import { Button, WARN_BUTTON } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { TableCell, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { TryNowButton, useDialPlace } from "./AbsentRoad.js";
import { ConnectProviderSheet } from "./ConnectProviderSheet.js";
import { WHERE_WORDS } from "./format.js";
import { copyOn } from "./image.js";
import { NOTHING_HELD, absenceOf, isProviderPlace, placeOf, placeWorkspaceCounts, threadWord, type PlaceHolding } from "./places.js";
import { PlaceRow, PlaceTable } from "./PlaceTable.js";
import { RemoveComputerDialog } from "./RemoveComputerDialog.js";

/** What each row holds, folded from the workspaces the store already has, each workspace going to exactly one row
 * by placeOf, the one reading of which computer a workspace stands on. The table's own cell reads the protocol's
 * `placeWorkspacesCell` off the row instead; the two answer different questions, since a sentence naming what
 * leaves this Mac needs each workspace's name and its threads and a cell needs neither. */
export function holdingsFor(
  places: readonly PlaceView[],
  workspaces: readonly WorkspaceView[],
  threadsOf: (workspaceId: string) => number,
  statusOf: (workspaceId: string) => WorkspaceStatus | null = () => null,
): Record<string, PlaceHolding> {
  const held: Record<string, PlaceHolding> = {};
  places.forEach(place => {
    const mine = workspaces.filter(w => placeOf(places, w)?.id === place.id);
    held[place.id] = { workspaces: mine.map(w => ({ name: w.name, state: workspaceWord(workspaceStateOf(w, statusOf(w.id))), threads: threadsOf(w.id) })) };
  });
  return held;
}

export function WhereAgentsRun({ now = Date.now() }: { now?: number }) {
  const places = useStore(s => s.places);
  const workspaces = useStore(s => s.workspaces);
  const sessions = useStore(s => s.sessions);
  const statuses = useStore(s => s.statuses);
  const api = useStore(s => s.api);
  const openAddComputer = useStore(s => s.openAddComputer);
  const openConnectProvider = useStore(s => s.openConnectProvider);
  const connecting = useStore(s => s.connectProviderOpen);
  const closeConnectProvider = useStore(s => s.closeConnectProvider);
  /** Every built copy of this host's image by the computer it sits on, so Remove can say what comes off that one. */
  const [copies, setCopies] = useState<readonly SealedImageCopy[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PlaceView | null>(null);
  /** What each place has taken this month and burns now, as the host totals it over every workspace metered on it,
   * the deleted ones with the rest. A row the host said nothing about has no figure rather than a zero. */
  const [spend, setSpend] = useState<readonly PlaceSpend[]>([]);
  const asking = useRef(false);
  /** Set when this window may not read the money at all, so it stops asking at every tick. Only that refusal sets
   * it: a read dropped while the socket reconnects is asked again at the next tick, where giving up on any failure
   * left the figures blank until the page was opened again. */
  const refused = useRef(false);

  const readSpend = useCallback((): void => {
    if (api?.spend === undefined || asking.current || refused.current) return;
    asking.current = true;
    void api
      .spend()
      .then(
        rows => setSpend(rows),
        (e: unknown) => {
          if (e instanceof Error && e.message.includes(PLACES_TICKET_REFUSAL)) refused.current = true;
        },
      )
      .finally(() => {
        asking.current = false;
      });
  }, [api]);

  const readCopies = useCallback((): void => {
    void api?.image?.().then(view => setCopies(view.copies), () => setCopies([]));
  }, [api]);
  useEffect(readCopies, [readCopies]);
  useEffect(readSpend, [readSpend]);
  // Every cost tick moves what a place has taken, so the figures follow the meter rather than the page being
  // reopened; the read in flight is what keeps a tick a workspace and a tick a second from asking twice at once.
  useProtocolEvents(
    useCallback(
      e => {
        if (e.type === "workspace.cost") readSpend();
      },
      [readSpend],
    ),
  );

  const threadsOf = (workspaceId: string): number => sessions[workspaceId]?.length ?? 0;
  const holdings = holdingsFor(places, workspaces, threadsOf, id => statuses[id] ?? null);
  const counts = placeWorkspaceCounts(places, workspaces);
  /** What that computer's own copy of the image weighs, where the provider's listing gave a size for it. */
  const imageBytesOn = (place: PlaceView): number | undefined => copyOn(copies, place)?.sizeBytes;
  const holdingOf = (place: PlaceView): PlaceHolding => holdings[place.id] ?? NOTHING_HELD;
  // The computer the host runs on reports no link of its own, so its state is its workspace's daemon: this row said
  // the Mac was fine while every pane on it said unreachable, which is the two rooms saying two things. Read
  // through the one door every surface reads an absent computer through, never by the kind here.
  const here = workspaces.find(w => isLocalWorkspace(w)) ?? null;
  const ownAbsence = absenceOf(places, here, here === null ? null : statuses[here.id] ?? null, now);
  const spendOn = (place: PlaceView): PlaceSpend | undefined => spend.find(row => row.place === place.id);
  /** The providers that have taken something this month and what they took together: a person who runs their own
   * computers alone is charged by nobody, and the foot says nothing at all. A provider whose workspaces have all
   * been asleep since last month is not one of them, so the count never says two charged where one did. */
  const paying = places.filter(place => isProviderPlace(place) && (spendOn(place)?.monthUsd ?? 0) > 0);
  const monthUsd = paying.reduce((sum, place) => sum + (spendOn(place)?.monthUsd ?? 0), 0);

  return (
    <div className="flex flex-col gap-3">
      <PlaceTable>
        {places.map((place, at) => {
          // The list puts this computer first, which the protocol's own order guarantees, and it is the one row
          // nothing can be done to: it is the computer the host runs on, so there is nothing to take it off.
          const own = at === 0;
          const took = spendOn(place);
          return (
            <Fragment key={place.id}>
              <PlaceRow
                place={place}
                now={now}
                workspaces={counts[place.id] ?? 0}
                here={own}
                {...(own ? { absent: ownAbsence } : {})}
                {...(took === undefined ? {} : { monthUsd: took.monthUsd })}
                {...(own
                  ? // The column is there and empty: a row short of a cell is a row shorter than the rest.
                    { menu: null }
                  : {
                      open: open === place.id,
                      onToggle: () => setOpen(held => (held === place.id ? null : place.id)),
                      trail: <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150", open === place.id && "rotate-90")} />,
                      menu: (
                        <Menu>
                          <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={WHERE_WORDS.more} />}>
                            <MoreHorizontalIcon />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <PlaceActions place={place} onRemove={() => setRemoving(place)} />
                          </MenuPopup>
                        </Menu>
                      ),
                    })}
              />
              {open === place.id ? (
                <PlaceDetail
                  place={place}
                  holding={holdingOf(place)}
                  now={now}
                  workspaces={counts[place.id] ?? 0}
                  {...(took === undefined ? {} : { spend: took })}
                  onRemove={() => setRemoving(place)}
                />
              ) : null}
            </Fragment>
          );
        })}
      </PlaceTable>
      {paying.length === 0 ? null : (
        <p className="text-right font-mono text-[11px] tabular-nums text-muted-foreground" data-k="places-spend">
          {placesSpendFoot(monthUsd, paying.length)}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="xs" variant="outline" data-k="add-computer-button" onClick={openAddComputer}>
          {PLACES_WORDS.addComputer}
        </Button>
        <Button size="xs" variant="outline" data-k="connect-provider" onClick={openConnectProvider}>
          {PLACES_WORDS.connectProvider}
        </Button>
      </div>
      <ConnectProviderSheet open={connecting} onOpenChange={next => (next ? openConnectProvider() : closeConnectProvider())} />
      {removing === null ? null : (
        <RemoveComputerDialog
          place={removing}
          holding={holdingOf(removing)}
          {...(imageBytesOn(removing) === undefined ? {} : { imageBytes: imageBytesOn(removing)! })}
          open
          onOpenChange={next => {
            if (!next) setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

/** The three things a person can do to one computer, in the row menu and again in its open detail, so the same
 * words are in both and neither grows a road the other lacks. Rename and Set as default carry no road on the wire
 * yet, so each is held and says so on hover rather than being drawn nowhere. */
function PlaceActions({ place, onRemove, inMenu = true }: { place: PlaceView; onRemove: () => void; inMenu?: boolean }) {
  const rows = [
    { k: "rename", word: WHERE_WORDS.rename, held: true, run: () => {} },
    ...(place.default ? [] : [{ k: "set-default", word: WHERE_WORDS.setDefault, held: true, run: () => {} }]),
    { k: "remove", word: WHERE_WORDS.remove, held: false, run: onRemove },
  ];
  if (inMenu) {
    return (
      <>
        {rows.map(row => (
          <MenuItem key={row.k} data-k={row.k} disabled={row.held} title={row.held ? WHERE_WORDS.notYet : undefined} onClick={row.run} {...(row.k === "remove" ? { className: "text-warning-foreground" } : {})}>
            {row.word}
          </MenuItem>
        ))}
      </>
    );
  }
  return (
    <>
      {rows.map(row => (
        <Button key={row.k} data-k={row.k} variant="outline" size="xs" disabled={row.held} title={row.held ? WHERE_WORDS.notYet : undefined} className={cn(row.k === "remove" && WARN_BUTTON)} onClick={row.run}>
          {row.word}
        </Button>
      ))}
    </>
  );
}

/** What the host knows about one computer, under its row: where it expects that computer, what it is, the
 * workspaces standing on it, what a provider charged, when it joined and when it last answered, with how long the
 * last dial of it took. Only facts the host carries are rows; the image copy this computer holds is drawn nowhere
 * here, since nothing on the wire says it yet. */
function PlaceDetail({ place, holding, now, workspaces, spend, onRemove }: { place: PlaceView; holding: PlaceHolding; now: number; workspaces: number; spend?: PlaceSpend; onRemove: () => void }) {
  const { dial, busy, line, held, heldWhy } = useDialPlace(place.id);
  // How long this host has not heard from it, and null while it is holding its link: a computer that is answering
  // reads its facts plain, since nothing about them is stale.
  const away = place.present === true ? null : awayMsOf(place, now);
  // A provider is no computer this host reaches: its machines are at the other end of a key, so there is no
  // address to name, nothing that last answered and nothing to dial. The whole road reading is a computer's, and
  // the rows, the slot and the button that read it stand or go together.
  const road = place.kind === "computer" ? absentRoad({ name: place.name, road: place.road, awayMs: awayMsOf(place, now), dialled: place.dialled }) : null;
  // How long the last frame that answered took, beside when it answered: the one figure that tells a road that is
  // slow from one that is down, and the reason the row keeps what the button got.
  const took = place.dialled?.answered === true && place.dialled.roundTripMs !== undefined ? ` · ${place.dialled.roundTripMs} ms` : "";
  const rows: { k: string; label: string; value: string }[] = [
    ...(road === null || road.address === null ? [] : [{ k: "address", label: WHERE_WORDS.address, value: road.address }]),
    // Marked while the computer is not answering, the way the pane's OS row is: a person who cannot tell which of
    // two screens is stale is the whole of what this row was reported for.
    ...(place.os === undefined
      ? []
      : [{ k: "system", label: WHERE_WORDS.system, value: lastKnown(place.docker === true ? `${place.os} · docker` : place.os, away) }]),
    ...(place.agents === undefined || place.agents.length === 0 ? [] : [{ k: "agents", label: WHERE_WORDS.agents, value: place.agents.join(", ") }]),
    { k: "workspaces", label: PLACES_WORDS.columns[3]!, value: holding.workspaces.length === 0 ? WHERE_WORDS.none : holding.workspaces.map(w => `${w.name} · ${w.state} · ${threadWord(w.threads)}`).join(", ") },
    // A computer of the person's own charges them nothing, so only a provider has a Spend row at all.
    ...(spend === undefined || !isProviderPlace(place) ? [] : [{ k: "spend", label: WHERE_WORDS.spend, value: placeSpendLine(spend, workspaces) }]),
    ...(place.joinedAt === undefined ? [] : [{ k: "joined", label: WHERE_WORDS.joined, value: WHERE_WORDS.ago(offlineFor(now - Date.parse(place.joinedAt))) }]),
    // When it last answered is the road reading's, not a second span worked out here: the pane says the same thing
    // in its sentence and the two may not date one silence differently.
    ...(road === null ? [] : [{ k: "answered", label: WHERE_WORDS.answered, value: `${road.answered}${took}` }]),
  ];
  return (
    <TableRow data-k="place-detail" data-place={place.id} className="hover:bg-transparent">
      <TableCell colSpan={5} className="py-3 pr-2 pl-4">
        <div className="flex flex-col gap-2 border-border border-l pl-4">
          {rows.map(row => (
            <div key={row.k} data-k={row.k} className="flex items-baseline gap-4">
              <span className="w-24 shrink-0 text-[13px] text-muted-foreground">{row.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-foreground" title={row.value}>
                {row.value}
              </span>
            </div>
          ))}
          {/* Wrapped, not cut: the cell it sits in is nowrap for its fact columns, and a refusal inheriting that
              pushed the table past the card (640 against 622) and clipped the half that says what happened. */}
          {road === null || (line ?? road.refused ?? heldWhy) === null ? null : (
            <p className="whitespace-normal break-words text-[11px] leading-relaxed text-muted-foreground" data-k="dialled">
              {line ?? road.refused ?? heldWhy}
            </p>
          )}
          <div className="flex gap-2 pt-1">
            {road === null ? null : <TryNowButton busy={busy} held={held} onDial={dial} />}
            <PlaceActions place={place} onRemove={onRemove} inMenu={false} />
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}
