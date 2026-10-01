// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: two lists on one column template, the computers this
// wsp runs on and the clouds that lend it machines, each row opening its own
// page; and that page, whose head says the state and the one act it invites,
// then the agents and MCP servers there, your image, the threads running
// there and Remove. Only facts the host carries are drawn; a fact not
// reported is left out rather than stood in for.
//
// The list draws every row the host's places list carries: the host lists a
// cloud only once it holds that cloud's key or a stand-in serves in its place,
// so nothing here filters again.
import { useEffect, useRef, useState } from "react";
import { HERE_PLACE_ID, PLACES_WORDS, absentRoad, awayMsOf, fmtMemGb, foldThreads, isLocalWorkspace, workspaceStateOf, workspaceWord, type AbsentComputer, type AgentsReport, type PlaceView, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { computerActions } from "../actions/computerActions.js";
import { openContextMenu } from "../actions/contextMenu.js";
import { resolveActions } from "../actions/registry.js";
import type { SidebarProjectSnapshot } from "../adapt/index.js";
import { ActButton, LeadMark } from "../components/agents/agentsParts.js";
import { imageAgentsReport, type FlowView, type RowAct, type RowsContext } from "../components/agents/agentsRows.js";
import { AGENTS_KIND } from "../components/agents/kinds/agents.js";
import type { KindModule, Lead } from "../components/agents/kinds/kind.js";
import { SERVERS_KIND } from "../components/agents/kinds/servers.js";
import { SignInFlowView } from "../components/agents/SignInFlowView.js";
import { NEEDS_YOU } from "../components/status/kinds/needs-you.js";
import { WORKING } from "../components/status/kinds/working.js";
import { threadStatusOf } from "../components/status/threadStatusOf.js";
import { ThreadRow } from "../components/threads/ThreadRows.js";
import { AddButton } from "../components/ui/add-button.js";
import { Button, DANGER_BUTTON } from "../components/ui/button.js";
import { useSidebarProjects, useStore } from "../protocol/store.js";
import { DialButton, useDialPlace } from "./AbsentRoad.js";
import { AddComputer } from "./AddComputer.js";
import { ComputerGlyph, useComputerIcon } from "./ComputerGlyph.js";
import { BehindRow, LimitsCard, SpawnCard } from "./computerSettings.js";
import { ADD_COMPUTER_WORDS, AGENTS_PAGE_WORDS, PLACE_STATE_WORDS, VALUE, WHERE_WORDS, capitalised } from "./format.js";
import { Chevron, GlyphFrame, Grid, GridHead, GridName, GridRow, LIST_COLUMNS, Num, PAGE_COLUMNS, StateCell, type HeadCell } from "./grid.js";
import { copyOn } from "./image.js";
import { ImageCard, useImageStanding } from "./ImageCard.js";
import { openImageRecipe } from "./openAt.js";
import { NOTHING_HELD, absenceOf, absentOf, hereName, isProviderPlace, placeName, placeOf, placeStateCell, type PlaceHolding, type PlaceStateCell } from "./places.js";
import { cloudsOffered, keyHeld } from "./providers.js";
import { RemoveComputerDialog } from "./RemoveComputerDialog.js";
import { CARD_SURFACE, Card, HeadRow, Row, type SettingsCardData, type SettingsRowData } from "./rows.js";
import { cn } from "../lib/utils.js";
import type { SettingsContext } from "./settingsContext.js";
import { useSettingsStore, type SettingsAt } from "./settingsStore.js";
import { RefusalSlot } from "./sheetParts.js";
import { CARD_INSET, ROW_FLOOR } from "./layout.js";

/** What stands on each computer, folded from the workspaces the store already has, each workspace going to
 * exactly one computer by placeOf, the one reading of which computer a workspace stands on. */
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

/** How many threads have a turn running on each row, by the id of the row, over the workspaces placeOf puts there. */
export function runningThreadsOn(ctx: Pick<SettingsContext, "places" | "workspaces" | "sessions">): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const workspace of ctx.workspaces) {
    const place = placeOf(ctx.places, workspace);
    if (place === undefined) continue;
    const running = foldThreads(ctx.sessions[workspace.id] ?? []).filter(thread => thread.status === "running").length;
    counts[place.id] = (counts[place.id] ?? 0) + running;
  }
  return counts;
}

/** Why a row is not answering, or null while it is. The computer the host runs on is read off its own workspace's
 * daemon rather than off a link it never reports: this row said the Mac was fine while every pane on it said
 * unreachable. */
function absenceAt(ctx: SettingsContext, place: PlaceView): AbsentComputer | null {
  if (place.id !== HERE_PLACE_ID) return absentOf(place, ctx.now);
  const here = ctx.workspaces.find(w => isLocalWorkspace(w)) ?? null;
  return absenceOf(ctx.places, here, here === null ? null : (ctx.statuses[here.id] ?? null), ctx.now);
}

const stateCellAt = (ctx: SettingsContext, place: PlaceView): PlaceStateCell =>
  placeStateCell(place, absenceAt(ctx, place), { canUpdate: place.id !== HERE_PLACE_ID && ctx.api?.placesUpdate !== undefined });

const stateWords = (cell: PlaceStateCell): string => (cell.kind === "word" ? cell.word : cell.why);

/** The pages under Computers in the sidebar: one per computer the list draws, this one first, off the same list so a
 * row and its sidebar row cannot disagree about which computers there are. */
export function computerSubPages(ctx: SettingsContext): { at: SettingsAt; name: string }[] {
  return ctx.places.map(place => ({ at: { kind: "computer", id: place.id }, name: placeName(place) }));
}

/** The computers list's header row: the section's name, then the columns a computer's row fills. */
const COMPUTER_HEAD: readonly HeadCell[] = [
  { word: WHERE_WORDS.heads.computer },
  { word: WHERE_WORDS.heads.cores, num: true, wideOnly: true },
  { word: WHERE_WORDS.heads.memory, num: true, wideOnly: true },
  { word: WHERE_WORDS.heads.threads, num: true },
];

/** A row as the search reads and draws it: the name a person types to find a computer, over its state. */
const searchRow = (ctx: SettingsContext, place: PlaceView): SettingsRowData => ({
  kind: "row",
  id: place.id,
  title: placeName(place),
  description: stateWords(stateCellAt(ctx, place)),
  open: () => ctx.go({ kind: "computer", id: place.id }),
  attrs: { "data-place-row": place.id },
});

export function computersCards(ctx: SettingsContext): SettingsCardData[] {
  const computers = ctx.places.filter(place => !isProviderPlace(place));
  const clouds = ctx.places.filter(isProviderPlace);
  const running = runningThreadsOn(ctx);
  const go = (place: PlaceView) => () => ctx.go({ kind: "computer", id: place.id });
  const refused =
    ctx.placesRefused === null ? null : <RefusalSlot k="places-refused" said={WHERE_WORDS.notRead(ctx.placesRefused.said)} {...(ctx.placesRefused.fix === undefined ? {} : { fix: ctx.placesRefused.fix })} />;
  const H = WHERE_WORDS.heads;
  const offered = cloudsOffered(ctx.reads.setup).length > 0;
  const computersBody = (
    <div className="flex flex-col gap-2">
      {computers.length === 0 ? null : (
        <Grid id="computers" head={<GridHead columns={LIST_COLUMNS} cells={COMPUTER_HEAD} />}>
          {computers.map(place => (
            <ComputerListRow key={place.id} place={place} running={running[place.id] ?? 0} cell={stateCellAt(ctx, place)} open={go(place)} ctx={ctx} />
          ))}
        </Grid>
      )}
      {refused}
      <div className="flex">
        <AddButton data-k="add-computer-button" onClick={() => ctx.askAdd(null)}>
          {ADD_COMPUTER_WORDS.title}
        </AddButton>
      </div>
    </div>
  );
  const cloudsBody = (
    <div className="flex flex-col gap-2">
      {clouds.length === 0 ? null : (
        <Grid id="clouds" head={<GridHead columns={LIST_COLUMNS} cells={[{ word: H.cloud }, { word: "", wideOnly: true }, { word: "", wideOnly: true }, { word: H.threads, num: true }]} />}>
          {clouds.map(place => (
            <CloudListRow key={place.id} place={place} running={running[place.id] ?? 0} cell={stateCellAt(ctx, place)} open={go(place)} ctx={ctx} />
          ))}
        </Grid>
      )}
      {offered ? (
        <div className="flex">
          <AddButton data-k="add-cloud-button" onClick={() => ctx.askAdd("cloud")}>
            {ADD_COMPUTER_WORDS.addCloud}
          </AddButton>
        </div>
      ) : null}
    </div>
  );
  return [
    { id: "computers", items: [], search: computers.map(place => searchRow(ctx, place)), body: computersBody },
    ...(clouds.length === 0 && !offered ? [] : [{ id: "clouds", items: [], search: clouds.map(place => searchRow(ctx, place)), body: cloudsBody }]),
    ...(ctx.addAsked === null ? [] : [{ id: "add-computer", head: ADD_COMPUTER_WORDS.title, items: [], body: <AddComputer key={ctx.addAsked.n} setup={ctx.reads.setup} road={ctx.addAsked.road} /> }]),
  ];
}

/** The row's own context menu: the icon it shows as. */
function useRowMenu(place: PlaceView, ctx: Pick<SettingsContext, "setPreferences">) {
  const icon = useComputerIcon(place);
  return (event: React.MouseEvent<HTMLDivElement>): void =>
    void openContextMenu(event, resolveActions(computerActions, { id: place.id, icon }, { setIcon: (id, next) => ctx.setPreferences({ computerLook: { [id]: { icon: next } } }) }));
}

const placeGlyph = (place: PlaceView) => (
  <GlyphFrame>
    <ComputerGlyph place={place} className="size-4 text-foreground/80" />
  </GlyphFrame>
);

/** One computer on the list: its cores, its memory, the threads running there as a count until a cap gives the
 * count a track, and its state. */
export function ComputerListRow({ place, running, cell, open, ctx }: { place: PlaceView; running: number; cell: PlaceStateCell; open?: () => void; ctx: Pick<SettingsContext, "setPreferences"> }) {
  const menu = useRowMenu(place, ctx);
  return (
    <GridRow columns={LIST_COLUMNS} {...(open === undefined ? {} : { open })} onContextMenu={menu} {...(cell.why === undefined ? {} : { title: cell.why })} attrs={{ "data-place-row": place.id }}>
      <GridName glyph={placeGlyph(place)} name={placeName(place)} {...(place.default ? { tag: WHERE_WORDS.default } : {})} />
      <Num k="cores" wideOnly>
        {place.shape?.cpu}
      </Num>
      <Num k="memory" wideOnly>
        {place.shape === undefined ? undefined : fmtMemGb(place.shape.memMb)}
      </Num>
      <Num k="threads">{running}</Num>
      <PlaceState place={place} cell={cell} {...(open === undefined ? {} : { onSignIn: open })} />
      {open === undefined ? <span /> : <Chevron />}
    </GridRow>
  );
}

/** One cloud on the list: its name, the threads running on its machines and its state. */
function CloudListRow({ place, running, cell, open, ctx }: { place: PlaceView; running: number; cell: PlaceStateCell; open: () => void; ctx: SettingsContext }) {
  const menu = useRowMenu(place, ctx);
  return (
    <GridRow columns={LIST_COLUMNS} open={open} onContextMenu={menu} {...(cell.why === undefined ? {} : { title: cell.why })} attrs={{ "data-place-row": place.id }}>
      <GridName glyph={placeGlyph(place)} name={placeName(place)} />
      <span className="col-span-2 max-md:hidden" />
      <Num k="threads">{running}</Num>
      <PlaceState place={place} cell={cell} onSignIn={open} />
      <Chevron />
    </GridRow>
  );
}

/** A state cell off its reading: the word, or the act itself. Sign in goes to the computer's page, whose agent rows
 * each carry their own. */
function PlaceState({ place, cell, onSignIn, className }: { place: PlaceView; cell: PlaceStateCell; onSignIn?: () => void; className?: string }) {
  const why = cell.why === undefined ? {} : { why: cell.why };
  if (cell.kind === "update") {
    return (
      <StateCell {...why} {...(className === undefined ? {} : { className })}>
        <UpdateControl place={place} />
      </StateCell>
    );
  }
  if (cell.kind === "sign-in") {
    return (
      <StateCell {...why} {...(className === undefined ? {} : { className })}>
        <Button data-k="sign-in" size="xs" variant="outline" held={onSignIn === undefined} onClick={onSignIn}>
          {PLACE_STATE_WORDS.signIn}
        </Button>
      </StateCell>
    );
  }
  return <StateCell word={cell.word} {...why} {...(className === undefined ? {} : { className })} />;
}

/** The one computer row on its own, for the Add a computer sheet's joined screen. */
export function ComputerRow({ place, now }: { place: PlaceView; now: number }) {
  const setPreferences = useStore(s => s.setPreferences);
  return (
    <Grid id="joined" head={<GridHead columns={LIST_COLUMNS} cells={COMPUTER_HEAD} />}>
      <ComputerListRow place={place} running={0} cell={placeStateCell(place, absentOf(place, now), { canUpdate: false })} ctx={{ setPreferences: patch => void setPreferences(patch) }} />
    </Grid>
  );
}

/** Update: puts this wsp's daemon on the computer and runs the recipe there again. One word in both states, held
 * and dimmed while it runs. */
function UpdateControl({ place }: { place: PlaceView }) {
  const updatePlace = useStore(s => s.updatePlace);
  const [updating, setUpdating] = useState(false);
  return (
    <Button
      data-k="update"
      size="xs"
      variant="outline"
      disabled={updating}
      onClick={() => {
        setUpdating(true);
        void updatePlace(place.id).finally(() => setUpdating(false));
      }}
    >
      {WHERE_WORDS.update}
    </Button>
  );
}

/** Remove: the confirmation whose sentence is computed from what the computer holds, then the host's own road. */
function RemoveControl({ place, holding, imageBytes, onRemoved }: { place: PlaceView; holding: PlaceHolding; imageBytes: number | undefined; onRemoved: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button data-k="remove" size="xs" variant="outline" className={DANGER_BUTTON} onClick={() => setAsking(true)}>
        {WHERE_WORDS.remove}
      </Button>
      {asking ? (
        <RemoveComputerDialog
          place={place}
          holding={holding}
          {...(imageBytes === undefined ? {} : { imageBytes })}
          open
          onOpenChange={next => {
            if (!next) setAsking(false);
          }}
          onRemoved={onRemoved}
        />
      ) : null}
    </>
  );
}

/** The line under a page's title: the state as its word or its act, the sentence beside it, and while the computer is
 * not answering the dial beside that, whose answer takes the sentence's place and whose refusal stands under it. */
function PlaceStateLine({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const here = place.id === HERE_PLACE_ID;
  const absent = absenceAt(ctx, place);
  const cell = stateCellAt(ctx, place);
  const { dial, busy, line, refused, held, heldWhy, road } = useDialPlace(place);
  const away = !here && absent !== null;
  const kept = away ? absentRoad({ name: place.name, road: place.road, awayMs: awayMsOf(place, ctx.now), dialled: place.dialled }).refused : null;
  const sentence = away ? (line ?? kept ?? heldWhy ?? cell.why) : cell.why;
  // An older daemon is said by the row under the computer's head, with its update; the line says only what outranks it.
  if (place.behind !== undefined && !isProviderPlace(place) && (cell.kind === "update" || (cell.kind === "word" && cell.word === PLACE_STATE_WORDS.behind))) return null;
  return (
    <div className="flex flex-col gap-2">
      <div data-k="place-state" className="flex min-w-0 items-center gap-2.5 text-[13px] leading-5">
        <PlaceState place={place} cell={cell} className="shrink-0" />
        {sentence === undefined || sentence === null || sentence === "" ? null : (
          <span data-k="place-sentence" className="min-w-0 truncate text-muted-foreground" title={sentence}>
            {sentence}
          </span>
        )}
        {away && road !== undefined && heldWhy === null ? <DialButton busy={busy} held={held} road={road} onDial={dial} /> : null}
      </div>
      {refused === null ? null : <RefusalSlot k="dial-refusal" said={refused.said} {...(refused.fix === undefined ? {} : { fix: refused.fix })} />}
    </div>
  );
}

/** One row of the AGENTS or MCP SERVERS list, off the kind's own row. */
interface KindLine {
  readonly key: string;
  readonly title: string;
  readonly lead: Lead;
  readonly note?: string;
  readonly version?: string;
  readonly act?: RowAct;
  readonly flow?: FlowView;
}

const NO_NAV = { openUnder: () => {} };

/** An act as its word alone, as every act on the settings grid is: the plus is Add's and no other button wears a glyph. */
const wordOnly = ({ icon: _icon, ...act }: RowAct): RowAct => act;

/** A kind's rows as lines: the row's lead, name and state word as the note, and its step only where it has a road,
 * since a held button beside every row is furniture. A state nothing has read yet is no state, and says nothing. */
function kindLines<T>(kind: KindModule<T>, items: readonly T[], ctx: RowsContext, version: (item: T) => string | undefined): KindLine[] {
  return items.map(item => {
    const row = kind.row(item, ctx);
    const flow = kind.detail(item, ctx, NO_NAV).flow;
    const v = version(item);
    const act = row.quick !== undefined && (row.quick.run !== undefined || row.quick.busy === true) ? wordOnly(row.quick) : undefined;
    return { key: row.key, title: row.title, lead: row.lead, ...(row.status === undefined || row.status.state === "unknown" ? {} : { note: capitalised(row.status.words) }), ...(v === undefined ? {} : { version: v }), ...(act === undefined ? {} : { act }), ...(flow === undefined ? {} : { flow }) };
  });
}

function KindGrid({ id, head, lines }: { id: string; head: string; lines: readonly KindLine[] }) {
  const versioned = lines.some(line => line.version !== undefined);
  return (
    <Grid id={id} head={<GridHead columns={PAGE_COLUMNS} cells={[{ word: head }, ...(versioned ? [{ word: WHERE_WORDS.heads.version, num: true, wideOnly: true }] : [])]} />}>
      {lines.map(line => (
        <div key={line.key} className="flex flex-col">
          <GridRow columns={PAGE_COLUMNS} tight attrs={{ "data-kind-row": line.key }}>
            <GridName glyph={<LeadMark lead={line.lead} label={line.title} />} name={line.title} {...(line.note === undefined ? {} : { note: line.note })} />
            <Num wideOnly>{line.version}</Num>
            <span className="flex min-w-0 items-center justify-self-end gap-2">{line.act === undefined ? null : <ActButton act={line.act} />}</span>
          </GridRow>
          {line.flow === undefined ? null : (
            <div className="pr-2 pb-3 pl-[52px]">
              <SignInFlowView view={line.flow} label={line.title} />
            </div>
          )}
        </div>
      ))}
    </Grid>
  );
}


/** The agents installed there and the MCP servers set up there, off one report. */
function ReportLists({ report, ctx }: { report: AgentsReport; ctx: RowsContext }) {
  const agents = AGENTS_KIND.items(report, ctx).filter(item => item.row.installed);
  const servers = SERVERS_KIND.items(report, ctx);
  // Each time a report stands, the servers kind asks what it checks there, as the manager's tab does.
  const shown = useRef<() => void>(() => {});
  shown.current = () => SERVERS_KIND.shown?.(servers, ctx);
  useEffect(() => shown.current(), [report]);
  const H = WHERE_WORDS.heads;
  return (
    <>
      {agents.length === 0 ? null : <KindGrid id="agents" head={H.agents} lines={kindLines(AGENTS_KIND, agents, ctx, item => item.row.version)} />}
      {servers.length === 0 ? null : <KindGrid id="servers" head={H.servers} lines={kindLines(SERVERS_KIND, servers, ctx, () => undefined)} />}
    </>
  );
}


const RUNNING_HERE = new Set([WORKING.id, NEEDS_YOU.id]);

/** The threads running or asking on the workspaces this row holds, newest first: running here is what the head says,
 * so a finished thread leaves it. */
export function threadsHere(projects: ReadonlyArray<SidebarProjectSnapshot>, places: readonly PlaceView[], place: PlaceView) {
  return projects
    .filter(runs => placeOf(places, runs.workspace)?.id === place.id)
    .flatMap(runs => runs.threads.filter(thread => RUNNING_HERE.has(threadStatusOf(thread).id)).map(thread => ({ thread, place: runs.workspace.project.name })))
    .sort((a, b) => Date.parse(b.thread.startedAt ?? "") - Date.parse(a.thread.startedAt ?? "") || 0);
}

function ThreadsHere({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const rows = threadsHere(useSidebarProjects(), ctx.places, place);
  if (rows.length === 0) return null;
  return (
    <Grid id="threads-here" head={<GridHead cells={[{ word: WHERE_WORDS.heads.threadsHere }]} />}>
      {rows.map(row => (
        <ThreadRow key={row.thread.id} {...row} />
      ))}
    </Grid>
  );
}

/** Remove at the foot, a tall line with what it takes: wsp comes off a computer, and a cloud's machines go with its key. */
function RemoveLine({ place, ctx, onRemoved }: { place: PlaceView; ctx: SettingsContext; onRemoved: () => void }) {
  const threadsOf = (workspaceId: string): number => ctx.sessions[workspaceId]?.length ?? 0;
  const holding = holdingsFor(ctx.places, ctx.workspaces, threadsOf, id => ctx.statuses[id] ?? null)[place.id] ?? NOTHING_HELD;
  const cloud = isProviderPlace(place);
  const imageBytes = cloud || ctx.reads.image === null ? undefined : copyOn(ctx.reads.image.copies, place)?.sizeBytes;
  const name = placeName(place);
  const note = cloud ? WHERE_WORDS.removeCloudDescription : WHERE_WORDS.removeDescription(name, hereName(ctx.places));
  return (
    <div data-k="remove-line" className={cn(CARD_SURFACE, CARD_INSET, ROW_FLOOR, "flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8")}>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-sm leading-5 font-medium text-foreground">{WHERE_WORDS.removeTitle(name)}</span>
        {note === "" ? null : (
          <span data-k="remove-note" className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground">
            {note}
          </span>
        )}
      </span>
      <RemoveControl place={place} holding={holding} imageBytes={imageBytes} onRemoved={onRemoved} />
    </div>
  );
}

/** One computer's or cloud's own page. A cloud keeps no computer to read: its agents are the image's, and every word
 * about the image stands under the rule the cloud's key does, since a cloud row drawn for a workspace alone is a
 * machine somebody else's key made. */
/** A computer's facts of one kind on one line: its system, cores and memory, as it last reported them. */
const shapeLine = (place: PlaceView): string => [place.os, place.shape === undefined ? undefined : `${place.shape.cpu} cores`, place.shape === undefined ? undefined : fmtMemGb(place.shape.memMb)].filter((part): part is string => part !== undefined && part !== "").join(", ");

/** How many threads run on a computer now, off the sidebar's snapshots like its Threads here list. */
function RunningHere({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const running = threadsHere(useSidebarProjects(), ctx.places, place).length;
  return (
    <span data-k="running-here" className={VALUE}>
      {WHERE_WORDS.runningHere(running)}
    </span>
  );
}

/** A computer's agents, tool servers and skills live on the Agents page; its own page links there with it picked. */
function AgentsLink({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const name = placeName(place);
  return (
    <Card id="computer-agents">
      <Row
        id="agents-on"
        title={AGENTS_PAGE_WORDS.onComputer(name)}
        description={AGENTS_PAGE_WORDS.onComputerDescription}
        open={() => {
          useSettingsStore.getState().pickAgentsPlace(place.id);
          ctx.go({ kind: "group", group: "agents" });
        }}
        attrs={{ "data-k": "agents-on" }}
      />
    </Card>
  );
}

export function ComputerPage({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const here = place.id === HERE_PLACE_ID;
  const cloud = isProviderPlace(place);
  const name = placeName(place);
  const held = !cloud || keyHeld(place.name, ctx.reads.setup);
  const standing = useImageStanding(place, ctx);
  const image = cloud && held ? (ctx.reads.image?.image ?? null) : null;
  // After the dialog has closed: the page under it goes with the computer, and a portal torn down with its page
  // in one frame is a node React cannot find.
  const onRemoved = (): void => void setTimeout(() => ctx.go({ kind: "group", group: "computers" }), 0);
  return (
    <>
      <section data-settings-card="computer" className="flex flex-col gap-3">
        <div className={CARD_SURFACE}>
          <HeadRow glyph={<ComputerGlyph place={place} className="size-4 text-foreground/80" />} title={name} {...(shapeLine(place) === "" ? {} : { line: <span className="font-mono">{shapeLine(place)}</span> })} slot={<RunningHere place={place} ctx={ctx} />} attrs={{ "data-k": "computer-head" }} />
          {cloud ? null : <BehindRow place={place} ctx={ctx} />}
        </div>
        <PlaceStateLine place={place} ctx={ctx} />
      </section>
      {cloud ? null : <LimitsCard place={place} />}
      {cloud ? null : <SpawnCard place={place} />}
      {cloud ? image === null ? null : <ReportLists report={imageAgentsReport(image, place.id)} ctx={{ where: "provider", on: name, editImage: () => openImageRecipe(place.id) }} /> : <AgentsLink place={place} ctx={ctx} />}
      {standing === undefined || !held ? null : <ImageCard place={place} name={standing.name} state={standing.state} view={standing.view} ctx={ctx} row />}
      <ThreadsHere place={place} ctx={ctx} />
      {here ? null : <RemoveLine place={place} ctx={ctx} onRemoved={onRemoved} />}
    </>
  );
}

