// SPDX-License-Identifier: AGPL-3.0-only
// Where agents run: one table of every computer and provider this wsp holds,
// this computer first. A row opens its own detail under it, where what the
// host knows about that computer is listed and the three things a person can
// do to it stand; the row menu holds the same three, for a hand that never
// opened the row. Under the table the two roads to another one.
//
// The detail opens on a button carrying aria-expanded rather than on the
// collapsible component: a collapsible panel animates its height and needs a
// block box, which a table row is not, and TableRow already dims itself on
// has-aria-expanded for exactly this.
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import type { PlaceView, WorkspaceView } from "@wsp/protocol";
import { Button, WARN_BUTTON } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { TableCell, TableRow } from "../components/ui/table.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { AddComputerSheet } from "./AddComputerSheet.js";
import { ConnectProviderSheet } from "./ConnectProviderSheet.js";
import { WHERE_WORDS } from "./format.js";
import { NOTHING_HELD, quietFor, threadWord, type PlaceHolding } from "./places.js";
import { PlaceRow, PlaceTable } from "./PlaceTable.js";
import { RemoveComputerDialog } from "./RemoveComputerDialog.js";

/** The machine id every workspace standing on a joined computer carries (engine's `placeMachineId`). The one rule
 * that reads it: which workspaces a row counts, and which the remove sentence names. */
const placeMachineId = (placeId: string): string => `place:${placeId}`;

/** What each row holds, folded from the workspaces the store already has: a joined computer's by its machine id,
 * this computer's and a provider's by the kind their workspaces carry. */
export function holdingsFor(places: readonly PlaceView[], workspaces: readonly WorkspaceView[], threadsOf: (workspaceId: string) => number): Record<string, PlaceHolding> {
  const held: Record<string, PlaceHolding> = {};
  for (const place of places) {
    const mine = workspaces.filter(w => (place.kind === "provider" ? w.kind === "cloud" : place.joinedAt === undefined ? w.kind === "local" : w.machineId === placeMachineId(place.id)));
    held[place.id] = { workspaces: mine.map(w => ({ name: w.name, threads: threadsOf(w.id) })) };
  }
  return held;
}

export function WhereAgentsRun() {
  const api = useStore(s => s.api);
  const workspaces = useStore(s => s.workspaces);
  const sessions = useStore(s => s.sessions);
  const select = useStore(s => s.select);
  const [places, setPlaces] = useState<PlaceView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<PlaceView | null>(null);
  const now = Date.now();

  const read = useCallback((): void => {
    void api?.places?.().then(setPlaces, () => setPlaces([]));
  }, [api]);
  useEffect(read, [read]);

  const threadsOf = (workspaceId: string): number => sessions[workspaceId]?.length ?? 0;
  const holdings = holdingsFor(places, workspaces, threadsOf);
  const holdingOf = (place: PlaceView): PlaceHolding => holdings[place.id] ?? NOTHING_HELD;

  const openPlace = (place: PlaceView): void => {
    if (place.workspaceId !== undefined) select(place.workspaceId);
    setAdding(false);
  };

  return (
    <section aria-labelledby="settings-where" className="flex flex-col gap-2">
      <h2 id="settings-where" className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {WHERE_WORDS.title}
      </h2>
      <PlaceTable>
        {places.map(place => {
          // This computer is the first row and the one row nothing can be done to: it is the computer the host
          // runs on, so there is nothing to remove it from.
          const own = place.joinedAt === undefined && place.kind === "computer";
          const actions = own ? null : <PlaceActions place={place} onRemove={() => setRemoving(place)} />;
          return (
            <Fragment key={place.id}>
              <PlaceRow
                place={place}
                holding={holdingOf(place)}
                now={now}
                {...(own ? {} : { open: open === place.id, onToggle: () => setOpen(held => (held === place.id ? null : place.id)) })}
                {...(own
                  ? {}
                  : {
                      trail: <ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150", open === place.id && "rotate-90")} />,
                      menu: (
                        <Menu>
                          <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={WHERE_WORDS.more} />}>
                            <MoreHorizontalIcon />
                          </MenuTrigger>
                          <MenuPopup align="end">{actions}</MenuPopup>
                        </Menu>
                      ),
                    })}
              />
              {open === place.id ? <PlaceDetail place={place} holding={holdingOf(place)} now={now} onRemove={() => setRemoving(place)} /> : null}
            </Fragment>
          );
        })}
      </PlaceTable>
      <div className="flex gap-2 pt-1">
        <Button data-k="add-computer" variant="outline" size="xs" onClick={() => setAdding(true)}>
          {WHERE_WORDS.addComputer}
        </Button>
        <Button data-k="connect-provider" variant="outline" size="xs" onClick={() => setConnecting(true)}>
          {WHERE_WORDS.connectProvider}
        </Button>
      </div>
      <AddComputerSheet
        open={adding}
        onOpenChange={next => {
          setAdding(next);
          if (!next) read();
        }}
        onOpenPlace={openPlace}
      />
      <ConnectProviderSheet
        open={connecting}
        onOpenChange={next => {
          setConnecting(next);
          if (!next) read();
        }}
      />
      {removing === null ? null : (
        <RemoveComputerDialog
          place={removing}
          holding={holdingOf(removing)}
          open
          onOpenChange={next => {
            if (!next) setRemoving(null);
          }}
          onRemoved={read}
        />
      )}
    </section>
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

/** What the host knows about one computer, under its row: what it is, the workspaces standing on it, when it
 * joined and when it last answered. Only facts the host carries are rows; the ssh login and the image copy this
 * computer holds are drawn nowhere here, since nothing on the wire says either yet. */
function PlaceDetail({ place, holding, now, onRemove }: { place: PlaceView; holding: PlaceHolding; now: number; onRemove: () => void }) {
  const rows: { k: string; label: string; value: string }[] = [
    ...(place.os === undefined ? [] : [{ k: "system", label: WHERE_WORDS.system, value: place.docker === true ? `${place.os} · docker` : place.os }]),
    { k: "workspaces", label: WHERE_WORDS.workspaces, value: holding.workspaces.length === 0 ? WHERE_WORDS.none : holding.workspaces.map(w => `${w.name} · ${threadWord(w.threads)}`).join(", ") },
    ...(place.joinedAt === undefined ? [] : [{ k: "joined", label: WHERE_WORDS.joined, value: `${quietFor(now - Date.parse(place.joinedAt))} ago` }]),
    ...(place.lastSeenAt === undefined ? [] : [{ k: "answered", label: WHERE_WORDS.answered, value: `${quietFor(now - Date.parse(place.lastSeenAt))} ago` }]),
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
          <div className="flex gap-2 pt-1">
            <PlaceActions place={place} onRemove={onRemove} inMenu={false} />
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}
