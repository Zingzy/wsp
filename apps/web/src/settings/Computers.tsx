// SPDX-License-Identifier: AGPL-3.0-only
// Computers: one table of every computer this wsp runs on, this one first, each
// row opening its own detail under it. The detail says what the host knows
// about that computer, lists the agents on it with what stands there and what
// the recipe put beside them, and holds the four things a person can do to it;
// the row menu holds the same list, for a hand that never opened the row.
//
// Which rows are drawn is a rule of its own (computerRows): this computer and
// every computer joined to it always, and a cloud account only once this host
// holds its key or a workspace stands on it. A table that listed an account
// nobody had bought, with an hourly price beside it, read as a bill.
//
// The list, the sheet's door and the events behind them are the store's, so the
// palette's row and this button take one road to the sheet.
//
// The detail opens on a row carrying aria-expanded rather than on the
// collapsible component: a collapsible panel animates its height and needs a
// block box, which a table row is not, and TableRow already dims itself on
// has-aria-expanded for exactly this.
import { ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { HERE_PLACE_ID, PLACES_TICKET_REFUSAL, PLACES_WORDS, PROVISION_KIND_WORDS, fmtBytes, fmtSize, isLocalWorkspace, offlineFor, placeSpendLine, placesSpendFoot, portsWord, workspaceStateOf, workspaceWord, type InitSetup, type PlaceSpend, type PlaceView, type SealedImageCopy, type WorkspaceLanding, type WorkspaceStatus, type WorkspaceView, absentRoad, awayMsOf, lastKnown } from "@wsp/protocol";
import { Button, WARN_BUTTON } from "../components/ui/button.js";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu.js";
import { TableCell, TableRow } from "../components/ui/table.js";
import { cn, errorText } from "../lib/utils.js";
import { useProtocolEvents, useStore } from "../protocol/store.js";
import { DialButton, useDialPlace } from "./AbsentRoad.js";
import { FACT, AGENTS_WORDS, WHERE_WORDS } from "./format.js";
import { copyOn } from "./image.js";
import { APP_PLATFORM, NOTHING_HELD, THIS_COMPUTER_WORD, absenceOf, computerRows, copiesWord, hereAgentLines, isProviderPlace, placeAgentLines, placeCpuWord, placeName, placeOf, placeWorkspaceCounts, recipeLines, threadWord, type AgentLine, type PlaceHolding } from "./places.js";
import { NARROW_ONLY, PlaceRow, PlaceTable } from "./PlaceTable.js";
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

export function Computers({ setup, now = Date.now() }: { /** What the host says about its own setup, read once by the page this section stands on: the keys it holds, which is what puts a cloud row on the table, and the agents on this computer, which are this computer's own block. Null until that read answers, and null on a host that answered nothing. */ setup: InitSetup | null; now?: number }) {
  const places = useStore(s => s.places);
  const workspaces = useStore(s => s.workspaces);
  const projects = useStore(s => s.projects);
  const landings = useStore(s => s.landings);
  const loadLanding = useStore(s => s.loadLanding);
  const sessions = useStore(s => s.sessions);
  const statuses = useStore(s => s.statuses);
  const api = useStore(s => s.api);
  const openAddComputer = useStore(s => s.openAddComputer);
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
  // What a copy on a computer has for a network is the landing's two flags, which the wire answers for a project
  // rather than for a computer: one project on each row is asked about, and a row with no project says nothing
  // about ports rather than a word this screen wrote.
  useEffect(() => {
    for (const project of projects) void loadLanding(project.id);
  }, [projects, loadLanding]);
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
  const rows = computerRows(places, setup, counts);
  /** What that computer's own copy of the image weighs, where the provider's listing gave a size for it. */
  const imageBytesOn = (place: PlaceView): number | undefined => copyOn(copies, place)?.sizeBytes;
  const holdingOf = (place: PlaceView): PlaceHolding => holdings[place.id] ?? NOTHING_HELD;
  /** Where a workspace of a project on this computer would land, for the row's Ports line: the first project the
   * host holds on it, since every workspace there reads the same two flags. */
  const landingOn = (place: PlaceView): WorkspaceLanding | null => {
    const project = projects.find(p => p.computer === place.id);
    return project === undefined ? null : landings[project.id] ?? null;
  };
  // The computer the host runs on reports no link of its own, so its state is its workspace's daemon: this row said
  // the Mac was fine while every pane on it said unreachable, which is the two rooms saying two things. Read
  // through the one door every surface reads an absent computer through, never by the kind here.
  const here = workspaces.find(w => isLocalWorkspace(w)) ?? null;
  const ownAbsence = absenceOf(places, here, here === null ? null : statuses[here.id] ?? null, now);
  const spendOn = (place: PlaceView): PlaceSpend | undefined => spend.find(row => row.place === place.id);
  /** The clouds that have taken something this month and what they took together: a person who runs their own
   * computers alone is charged by nobody, and the foot says nothing at all. A cloud whose workspaces have all
   * been asleep since last month is not one of them, so the count never says two charged where one did. */
  const paying = rows.filter(place => isProviderPlace(place) && (spendOn(place)?.monthUsd ?? 0) > 0);
  const monthUsd = paying.reduce((sum, place) => sum + (spendOn(place)?.monthUsd ?? 0), 0);

  return (
    <div className="flex flex-col gap-3">
      <PlaceTable>
        {rows.map(place => {
          // This computer is the one row nothing can be done to: it is the computer the host runs on, so there is
          // nothing to take it off and nothing to install on it. Its detail stands like every other row's, since
          // the agents on this computer are read there.
          const own = place.id === HERE_PLACE_ID;
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
                open={open === place.id}
                onToggle={() => setOpen(held => (held === place.id ? null : place.id))}
                trail={<ChevronRightIcon aria-hidden className={cn("size-3 shrink-0 text-muted-foreground transition-transform duration-150", open === place.id && "rotate-90")} />}
                menu={
                  own ? (
                    // The column is there and empty: a row short of a cell is a row shorter than the rest.
                    null
                  ) : (
                    <Menu>
                      <MenuTrigger render={<Button variant="ghost-muted" size="icon-xs" aria-label={WHERE_WORDS.more} />}>
                        <MoreHorizontalIcon />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <PlaceActions place={place} onRemove={() => setRemoving(place)} />
                      </MenuPopup>
                    </Menu>
                  )
                }
              />
              {open === place.id ? (
                <PlaceDetail
                  place={place}
                  here={own}
                  holding={holdingOf(place)}
                  landing={landingOn(place)}
                  agents={own ? hereAgentLines(setup) : placeAgentLines(place)}
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
      </div>
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

/** The four things a person can do to one computer, in the row menu and again in its open detail, so the same
 * words are in both and neither grows a road the other lacks. Update is the one with a road on the wire: it puts
 * this wsp's daemon on the computer and runs the recipe there again, and its answer lands in the row's own state
 * slot. Rename and Set as default carry no road yet, so each is held and says so on hover rather than being drawn
 * nowhere. */
function PlaceActions({ place, onRemove, inMenu = true }: { place: PlaceView; onRemove: () => void; inMenu?: boolean }) {
  const updatePlace = useStore(s => s.updatePlace);
  const noUpdate = useStore(s => s.api?.placesUpdate === undefined);
  const [updating, setUpdating] = useState(false);
  const update = (): void => {
    setUpdating(true);
    void updatePlace(place.id).finally(() => setUpdating(false));
  };
  const rows = [
    { k: "update", word: WHERE_WORDS.update, held: noUpdate || updating, run: update },
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

/** What the host knows about one computer, under its row: where it expects that computer, what it is, how it makes
 * a copy and what that copy has for a network, the workspaces standing on it, what a cloud charged, when it joined
 * and when it last answered, with how long the last dial of it took. Only facts the host carries are rows. Under
 * them the agents on that computer and what the recipe put there beside them, then the row of actions. */
function PlaceDetail({ place, here, holding, landing, agents, now, workspaces, spend, onRemove }: { place: PlaceView; here: boolean; holding: PlaceHolding; landing: WorkspaceLanding | null; agents: readonly AgentLine[]; now: number; workspaces: number; spend?: PlaceSpend; onRemove: () => void }) {
  const { dial, busy, line, held, heldWhy, road: dialRoad } = useDialPlace(place);
  // How long this host has not heard from it, and null while it is holding its link: a computer that is answering
  // reads its facts plain, since nothing about them is stale.
  const away = place.present === true ? null : awayMsOf(place, now);
  // A cloud is no computer this host reaches: its machines are at the other end of a key, so there is no address
  // to name, nothing that last answered and nothing to dial. The whole road reading is a computer's, and the rows,
  // the slot and the button that read it stand or go together. This computer is reached by being here.
  const road = place.kind === "computer" && !here ? absentRoad({ name: place.name, road: place.road, awayMs: awayMsOf(place, now), dialled: place.dialled }) : null;
  // How long the last frame that answered took, beside when it answered: the one figure that tells a road that is
  // slow from one that is down, and the reason the row keeps what the button got.
  const took = place.dialled?.answered === true && place.dialled.roundTripMs !== undefined ? ` · ${place.dialled.roundTripMs} ms` : "";
  const copies = copiesWord(place, here);
  const ports = landing === null ? "" : portsWord(landing.capabilities, undefined, APP_PLATFORM);
  /** One row of the detail: its label, what it says, and whether it is a row only a narrow window draws, where the
   * column it stands for has left the table. A row with more than one thing to say says them one to a line rather
   * than in a sentence cut from the right. */
  const rows: { k: string; label: string; value: string; lines?: readonly string[]; narrow?: boolean }[] = [
    ...(road === null || road.address === null ? [] : [{ k: "address", label: WHERE_WORDS.address, value: road.address }]),
    // The two columns a phone does not hold, said here instead, in the table's own words for them. Which columns
    // those are and where the breakpoint is are the table's to say: this row wears the class it hands back, so a
    // column that leaves and the row that stands in for it cannot part ways.
    ...(place.shape === undefined ? [] : [{ k: "size", label: PLACES_WORDS.columns[1]!, value: fmtSize(place.shape, placeCpuWord(place)), narrow: true }]),
    ...(place.diskFreeBytes === undefined ? [] : [{ k: "disk-free", label: PLACES_WORDS.columns[2]!, value: fmtBytes(place.diskFreeBytes), narrow: true }]),
    // Marked while the computer is not answering, the way the pane's OS row is: a person who cannot tell which of
    // two screens is stale is the whole of what this row was reported for.
    ...(place.os === undefined
      ? []
      : [{ k: "system", label: WHERE_WORDS.system, value: lastKnown(place.engine !== undefined && place.engine !== "none" ? `${place.os} · ${place.engine}` : place.os, away) }]),
    ...(copies === "" ? [] : [{ k: "copies", label: WHERE_WORDS.copies, value: copies }]),
    ...(ports === "" ? [] : [{ k: "ports", label: WHERE_WORDS.ports, value: ports }]),
    {
      k: "workspaces",
      label: PLACES_WORDS.columns[3]!,
      value: holding.workspaces.length === 0 ? WHERE_WORDS.none : holding.workspaces.map(w => `${w.name} · ${w.state} · ${threadWord(w.threads)}`).join(", "),
      // One line per workspace: the cell yields to the table, so three workspaces in one sentence read as two and
      // an ellipsis, and what a person opened the row for was the third.
      ...(holding.workspaces.length === 0 ? {} : { lines: holding.workspaces.map(w => `${w.name} · ${w.state} · ${threadWord(w.threads)}`) }),
    },
    // A computer of the person's own charges them nothing, so only a cloud has a Spend row at all.
    ...(spend === undefined || !isProviderPlace(place) ? [] : [{ k: "spend", label: WHERE_WORDS.spend, value: placeSpendLine(spend, workspaces) }]),
    ...(place.joinedAt === undefined ? [] : [{ k: "joined", label: WHERE_WORDS.joined, value: WHERE_WORDS.ago(offlineFor(now - Date.parse(place.joinedAt))) }]),
    // When it last answered is the road reading's, not a second span worked out here: the pane says the same thing
    // in its sentence and the two may not date one silence differently.
    ...(road === null ? [] : [{ k: "answered", label: WHERE_WORDS.answered, value: `${road.answered}${took}` }]),
  ];
  const recipe = recipeLines(place);
  return (
    <TableRow data-k="place-detail" data-place={place.id} className="hover:bg-transparent">
      {/* The detail gives way to the rows above it rather than setting the table's width: `max-w-0` is what makes
          a table cell yield, and without it one long value here (two workspaces on one computer) grew the table
          past the card it sits in and pushed the fact columns and the block's own buttons out of sight. */}
      <TableCell colSpan={5} className="max-w-0 py-3 pr-2 pl-4">
        <div className="flex flex-col gap-2 border-border border-l pl-4">
          {rows.map(row => (
            <div key={row.k} data-k={row.k} className={cn("flex items-baseline gap-4", row.narrow === true && NARROW_ONLY)}>
              <span className="w-24 shrink-0 text-[13px] text-muted-foreground">{row.label}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums text-foreground" title={row.value}>
                {row.lines === undefined ? row.value : row.lines.map(line => <span key={line} className="block truncate">{line}</span>)}
              </span>
            </div>
          ))}
          {/* A cloud account reports no agent: the agents there are in the image built there, so a block saying
              none would state a fact the host does not hold. It goes with the Address and Answered rows. */}
          {isProviderPlace(place) ? null : <AgentsBlock place={place} here={here} agents={agents} recipe={recipe} />}
          {/* Wrapped, not cut: the cell it sits in is nowrap for its fact columns, and a refusal inheriting that
              pushed the table past the card (640 against 622) and clipped the half that says what happened. */}
          {road === null || (line ?? road.refused ?? heldWhy) === null ? null : (
            <p className="whitespace-normal break-words text-[11px] leading-relaxed text-muted-foreground" data-k="dialled">
              {line ?? road.refused ?? heldWhy}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {road === null || dialRoad === undefined ? null : <DialButton busy={busy} held={held} road={dialRoad} onDial={dial} />}
            {here ? null : <PlaceActions place={place} onRemove={onRemove} inMenu={false} />}
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** The agents on one computer and what the recipe put there beside them: one line each, the name at the left and
 * the word for what stands there in the slot every other fact's word is in. On this computer the word is whether
 * that agent's own config names the wsp tools, and the one action is handing them over; on a computer somebody
 * joined it is what the recipe job came to for that agent, and the sign-in beside it is held with the command line
 * that runs one. */
/** The height every line of the block stands, whatever it holds: the height of the extra-small button one of them
 * carries, at both of that button's own sizes. */
const BLOCK_LINE = "min-h-7 sm:min-h-6";
/** The slot a line's own word stands in: two of its lines at a phone's width, where the column holds eighteen
 * characters and a reason runs to twenty, and one above 640 px, where the whole reason reads on one. Every line
 * carries the slot, so the block is one height at either width. */
const BLOCK_WORD = "min-h-[2lh] line-clamp-2 whitespace-normal sm:min-h-[1lh] sm:line-clamp-1";

function AgentsBlock({ place, here, agents, recipe }: { place: PlaceView; here: boolean; agents: readonly AgentLine[]; recipe: readonly { id: string; kind: keyof typeof PROVISION_KIND_WORDS; label: string; state: string }[] }) {
  return (
    <div data-k="agents-block" className="flex flex-col gap-2 pt-1">
      <span className={cn(FACT, "uppercase tracking-[0.12em]")}>{WHERE_WORDS.agents}</span>
      {agents.length === 0 ? (
        <span className="text-[13px] text-muted-foreground" data-k="no-agents">
          {AGENTS_WORDS.noneOn(here ? THIS_COMPUTER_WORD : placeName(place))}
        </span>
      ) : (
        agents.map(agent => (
          // Every line stands the button's own height whether it holds one or not: a block where a line with a
          // word was 43 px and a line with a button 50 read as three lists.
          <div key={agent.id} data-k="agent" data-agent={agent.id} className={cn("flex items-center gap-4", BLOCK_LINE)}>
            <span className="w-24 shrink-0 text-[13px] text-foreground">{agent.name}</span>
            <span className={cn(FACT, "min-w-0 flex-1", BLOCK_WORD)} data-k="agent-state" title={agent.state}>
              {agent.state}
            </span>
            {agent.held === undefined ? (
              agent.state === "" ? (
                <Button data-k="agent-add" size="xs" variant="outline" held title={WHERE_WORDS.notYet}>
                  {AGENTS_WORDS.add}
                </Button>
              ) : null
            ) : // An agent already signed in there has nothing to sign in: a held control for a finished thing is
            // one more thing to read past, so the line carries the word alone.
            agent.signedIn === true ? null : (
              <Button data-k="agent-sign-in" size="xs" variant="outline" held title={agent.held}>
                {AGENTS_WORDS.signIn}
              </Button>
            )}
          </div>
        ))
      )}
      {recipe.map(row => (
        <div key={row.id} data-k="recipe-row" data-kind={row.kind} className={cn("flex items-center gap-4", BLOCK_LINE)}>
          <span className="w-24 shrink-0 truncate text-[13px] text-foreground" title={row.label}>
            {row.label}
          </span>
          <span className={cn(FACT, "min-w-0 flex-1", BLOCK_WORD)} data-k="recipe-state" title={row.state}>
            {`${PROVISION_KIND_WORDS[row.kind]} · ${row.state}`}
          </span>
        </div>
      ))}
    </div>
  );
}
