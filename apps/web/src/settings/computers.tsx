// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers: one row per computer this wsp runs on, this one
// first, each opening the computer's own page; and that page, which says what
// the host knows about the computer as lines, its connection and what a
// workspace there is made of as rows, the agents on it with what stands there,
// what the recipe put beside them, the workspaces standing on it, and the two
// things a person can do to it. Only facts the host carries are drawn; a fact
// not reported is left out rather than stood in for.
//
// Which rows the list draws is a rule of its own (computerRows): this computer
// and every computer joined to it always, and a cloud account only once this
// host holds its key or a workspace stands on it. A list that named an
// account nobody had bought, with an hourly price beside it, read as a bill.
import { HarnessMark } from "../components/chat/HarnessMark.js";
import { CloudIcon, CpuIcon, GaugeIcon, HardDriveIcon, LayersIcon, MemoryStickIcon, ReceiptIcon } from "lucide-react";
import type { ChipItem } from "../components/ui/chips.js";
import { useState } from "react";
import { HERE_PLACE_ID, PLACES_WORDS, fmtMemGb, PROVISION_KIND_WORDS, absentRoad, awayMsOf, copyStanding, fmtBytes, fmtRate, fmtSize, isLocalWorkspace, lastKnown, offlineFor, plural, portsWord, spentThisMonth, workspaceStateOf, workspaceWord, type PlaceSpend, type PlaceView, type SealedImageView, type WorkspaceLanding, type WorkspaceStatus, type WorkspaceView } from "@wsp/protocol";
import { Button, DANGER_BUTTON } from "../components/ui/button.js";
import { useStore } from "../protocol/store.js";
import { DialButton, useDialPlace } from "./AbsentRoad.js";
import { ADD_COMPUTER_WORDS, AGENTS_WORDS, WHERE_WORDS } from "./format.js";
import { AddComputer } from "./AddComputer.js";
import { ComputerGlyph, ComputerIconSelect } from "./ComputerGlyph.js";
import { builtFact, builtWhen, copyOn, IMAGE_WORDS, imageFacts } from "./image.js";
import { APP_PLATFORM, NOTHING_HELD, THIS_COMPUTER_WORD, absenceOf, absentOf, computerRows, copiesWord, hereAgentLines, isProviderPlace, placeAgentLines, placeCpuWord, placeName, placeOf, placeStateWord, placeWorkspaceCounts, recipeLines, threadWord, type AgentLine, type PlaceHolding } from "./places.js";
import { keyHeld } from "./providers.js";
import { RemoveComputerDialog } from "./RemoveComputerDialog.js";
import { Card, Cards, Row, type SettingsCardData, type SettingsItem, type SettingsRowData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import type { SettingsAt } from "./settingsStore.js";

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

/** The facts a computer's list row says under its name, dots between, none of them where none has arrived. */
export function computerFacts(place: PlaceView, count: number, spend: PlaceSpend | undefined): string {
  if (isProviderPlace(place)) {
    return [WHERE_WORDS.cloud, place.rateUsdPerHour === undefined ? undefined : fmtRate(place.rateUsdPerHour), count === 0 ? undefined : plural(count, "workspace"), spend === undefined ? undefined : spentThisMonth(spend.monthUsd)].filter((word): word is string => word !== undefined).join(" · ");
  }
  return [place.shape === undefined ? undefined : fmtSize(place.shape, placeCpuWord(place)), place.diskFreeBytes === undefined ? undefined : fmtBytes(place.diskFreeBytes), count === 0 ? undefined : plural(count, "workspace")].filter((word): word is string => word !== undefined).join(" · ");
}

/** The same facts as chips, each with its glyph. */
export function computerChips(place: PlaceView, count: number, spend: PlaceSpend | undefined): ChipItem[] {
  const workspaces: ChipItem | null = count === 0 ? null : { text: plural(count, "workspace"), icon: LayersIcon };
  if (isProviderPlace(place)) {
    const cloud: (ChipItem | null)[] = [
      { text: WHERE_WORDS.cloud, icon: CloudIcon },
      place.rateUsdPerHour === undefined ? null : { text: fmtRate(place.rateUsdPerHour), icon: GaugeIcon },
      workspaces,
      spend === undefined ? null : { text: spentThisMonth(spend.monthUsd), icon: ReceiptIcon },
    ];
    return cloud.filter((c): c is ChipItem => c !== null);
  }
  const own: (ChipItem | null)[] = [
    place.shape === undefined ? null : { text: `${place.shape.cpu} ${placeCpuWord(place)}`, icon: CpuIcon },
    place.shape === undefined ? null : { text: fmtMemGb(place.shape.memMb), icon: MemoryStickIcon },
    place.diskFreeBytes === undefined ? null : { text: `${fmtBytes(place.diskFreeBytes)} free`, icon: HardDriveIcon },
    workspaces,
  ];
  return own.filter((c): c is ChipItem => c !== null);
}

/** One computer's row: the name a person reads it as with the default mark, the facts it has reported, and the
 * state word while there is one, then the chevron where the row opens a page. */
export function computerRowData(place: PlaceView, o: { here: boolean; count: number; spend?: PlaceSpend | undefined; now: number; state?: string | undefined; open?: (() => void) | undefined }): SettingsRowData {
  const state = o.state ?? placeStateWord(place, absentOf(place, o.now, o.here));
  return {
    kind: "row",
    id: place.id,
    title: placeName(place, o.here),
    lead: (
      <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-foreground/[0.04]">
        <ComputerGlyph place={place} className="size-5 text-foreground/80" />
      </span>
    ),
    ...(place.default ? { mark: WHERE_WORDS.default } : {}),
    description: computerFacts(place, o.count, o.spend),
    chips: computerChips(place, o.count, o.spend),
    mono: true,
    ...(state === "" ? {} : { word: state, wordClass: "fact" }),
    ...(o.open === undefined ? {} : { open: o.open }),
    attrs: { "data-place-row": place.id },
  };
}

/** The state of the computer the host runs on, read off its own workspace's daemon rather than off a link it
 * never reports: this row said the Mac was fine while every pane on it said unreachable. */
function ownStateWord(ctx: SettingsContext): string {
  const here = ctx.workspaces.find(w => isLocalWorkspace(w)) ?? null;
  const absent = absenceOf(ctx.places, here, here === null ? null : (ctx.statuses[here.id] ?? null), ctx.now);
  const own = ctx.places.find(place => place.id === HERE_PLACE_ID);
  return own === undefined ? "" : placeStateWord(own, absent);
}

/** The pages under Computers in the sidebar: one per computer the list draws, this one first, read off the same
 * rule the list reads so a row and its sidebar row cannot disagree about which computers there are. */
export function computerSubPages(ctx: SettingsContext): { at: SettingsAt; name: string }[] {
  return computerRows(ctx.places, ctx.reads.setup, placeWorkspaceCounts(ctx.places, ctx.workspaces)).map(place => ({ at: { kind: "computer", id: place.id }, name: placeName(place, place.id === HERE_PLACE_ID) }));
}

export function computersCards(ctx: SettingsContext): SettingsCardData[] {
  const counts = placeWorkspaceCounts(ctx.places, ctx.workspaces);
  const rows = computerRows(ctx.places, ctx.reads.setup, counts);
  return [
    {
      id: "computers",
      items: rows.map(place => {
        const here = place.id === HERE_PLACE_ID;
        return computerRowData(place, {
          here,
          count: counts[place.id] ?? 0,
          spend: ctx.reads.spend.find(row => row.place === place.id),
          now: ctx.now,
          ...(here ? { state: ownStateWord(ctx) } : {}),
          open: () => ctx.go({ kind: "computer", id: place.id }),
        });
      }),
    },
    { id: "add-computer", head: ADD_COMPUTER_WORDS.title, items: [], body: <AddComputer setup={ctx.reads.setup} /> },
  ];
}

/** The one computer row on its own, for the Add a computer sheet's joined screen. */
export function ComputerRow({ place, now }: { place: PlaceView; now: number }) {
  const { kind: _row, ...row } = computerRowData(place, { here: false, count: 0, now });
  return (
    <Card id="joined">
      <Row {...row} />
    </Card>
  );
}

/** Update: puts this wsp's daemon on the computer and runs the recipe there again. One word in both states, held
 * and dimmed while it runs; held with no title where the client has no such request, since the row's description
 * says why. */
function UpdateControl({ place, held }: { place: PlaceView; held: boolean }) {
  const updatePlace = useStore(s => s.updatePlace);
  const [updating, setUpdating] = useState(false);
  return (
    <Button
      data-k="update"
      size="xs"
      variant="outline"
      held={held}
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

/** The agents' rows: the catalog name over the version and the sign-in word, Sign in held where none stands there,
 * with why in the description's last clause and no title. On this computer the word is whether the agent's own
 * config names the wsp tools, and the one action is handing them over, held the same way. */
function agentRows(agents: readonly AgentLine[], here: boolean, computer: string): SettingsItem[] {
  if (agents.length === 0) return [{ kind: "line", id: "no-agents", label: AGENTS_WORDS.noneOn(computer), attrs: { "data-k": "no-agents" } }];
  return agents.map(agent => {
    const heldAdd = here && agent.state === "" && agent.takesTools === true;
    const heldSignIn = !here && agent.signedIn !== true;
    const state = heldAdd ? AGENTS_WORDS.notAdded : agent.state;
    const description = [state, heldAdd || heldSignIn ? WHERE_WORDS.notFromApp : undefined].filter((word): word is string => word !== undefined && word !== "").join(" · ");
    return {
      kind: "row" as const,
      id: `agent-${agent.id}`,
      title: agent.name,
      lead: <HarnessMark harness={agent.id} label={agent.name} className="size-4" />,
      description,
      mono: true,
      attrs: { "data-k": "agent", "data-agent": agent.id },
      ...(heldAdd
        ? {
            control: (
              <Button data-k="agent-add" size="xs" variant="outline" held>
                {AGENTS_WORDS.add}
              </Button>
            ),
          }
        : heldSignIn
          ? {
              control: (
                <Button data-k="agent-sign-in" size="xs" variant="outline" held>
                  {AGENTS_WORDS.signIn}
                </Button>
              ),
            }
          : {}),
    };
  });
}

/** What a computer has cost, as its own line: the month's figure and the hourly rate, both the protocol's. The
 * count of workspaces the rate is spread over is not said, since the rate already is what is running there and a
 * line that ends "now across 0 workspaces" wraps at a phone's width to say nothing. */
const spendLine = (spend: PlaceSpend): string => `${spentThisMonth(spend.monthUsd)} · ${fmtRate(spend.rateUsdPerHour)}`;

/** Where a workspace of a project on this computer would land, for the Ports row: the first project the host holds
 * on it, since every workspace there reads the same two flags. */
function landingOn(ctx: SettingsContext, place: PlaceView): WorkspaceLanding | null {
  const project = ctx.projects.find(p => p.computer === place.id);
  return project === undefined ? null : (ctx.landings[project.id] ?? null);
}

/** The cloud's page: what it has taken, the image this host sealed and its copies, since the image exists only
 * behind the cloud's row, then Remove, whose dialog says the key is forgotten.
 *
 * The image is what this host builds with the cloud's key, so every word about it stands under the same rule the
 * list row's own cloud stands under: the key is held here. A cloud row drawn for a workspace alone is a machine
 * somebody else's key made, and this host has nothing to say about its image and nothing to edit. */
function cloudCards(ctx: SettingsContext, place: PlaceView, view: SealedImageView | null, holding: PlaceHolding, onRemoved: () => void): SettingsCardData[] {
  const held = keyHeld(place.name, ctx.reads.setup);
  const image = held ? (view?.image ?? null) : null;
  const spend = ctx.reads.spend.find(row => row.place === place.id);
  const facts: SettingsItem[] = [
    ...(spend === undefined ? [] : [{ kind: "line" as const, id: "spend", label: WHERE_WORDS.spend, value: spendLine(spend), attrs: { "data-k": "spend" } }]),
    // Until the host has answered there is no fact to say; not built yet is drawn only once the read came back empty.
    ...(!held || view === null
      ? []
      : image === null
        ? [{ kind: "line" as const, id: "image", label: IMAGE_WORDS.image, value: IMAGE_WORDS.notBuilt, valueClass: "fact" as const, hover: IMAGE_WORDS.firstBuild, attrs: { "data-k": "image-facts" } }]
        : [{ kind: "line" as const, id: "image", label: IMAGE_WORDS.image, value: imageFacts(image), attrs: { "data-k": "image-facts" } }]),
    ...(image === null ? [] : [{ kind: "line" as const, id: "built", label: IMAGE_WORDS.built, value: builtFact(image, ctx.now), attrs: { "data-k": "image-built" } }]),
  ];
  const copies: SettingsItem[] =
    image === null || view === null
      ? []
      : view.copies.map(copy => ({
          kind: "line" as const,
          id: `copy-${copy.place}`,
          label: copy.place,
          value: [`v${copy.version}`, copyStanding(image, copy), copy.sizeBytes === undefined ? undefined : fmtBytes(copy.sizeBytes), builtWhen(copy.builtAt, ctx.now)].filter((word): word is string => word !== undefined).join(" · "),
          attrs: { "data-k": "image-copy", "data-place": copy.place },
        }));
  const edit = !held ? undefined : (
    <Button data-k="edit-image" variant="outline" size="xs" onClick={ctx.openSetup}>
      {IMAGE_WORDS.edit}
    </Button>
  );
  return [
    // No card is drawn with nothing in it: before the host has answered, a cloud's page is its one act.
    ...(facts.length === 0 ? [] : [{ id: "cloud", items: facts, ...(edit === undefined ? {} : { under: edit }) }]),
    ...(copies.length === 0 ? [] : [{ id: "copies", head: IMAGE_WORDS.copies, items: copies }]),
    {
      id: "acts",
      items: [
        {
          kind: "row" as const,
          id: "remove",
          title: WHERE_WORDS.removeTitle(placeName(place)),
          description: WHERE_WORDS.removeCloudDescription,
          control: <RemoveControl place={place} holding={holding} imageBytes={undefined} onRemoved={onRemoved} />,
        },
      ],
    },
  ];
}

/** One computer's own page. */
export function ComputerPage({ place, ctx }: { place: PlaceView; ctx: SettingsContext }) {
  const here = place.id === HERE_PLACE_ID;
  const noUpdate = ctx.api?.placesUpdate === undefined;
  const { dial, busy, line, held, heldWhy, road: dialRoad } = useDialPlace(place);
  const threadsOf = (workspaceId: string): number => ctx.sessions[workspaceId]?.length ?? 0;
  const holding = holdingsFor(ctx.places, ctx.workspaces, threadsOf, id => ctx.statuses[id] ?? null)[place.id] ?? NOTHING_HELD;
  // After the dialog has closed: the page under it goes with the computer, and a portal torn down with its page
  // in one frame is a node React cannot find.
  const onRemoved = (): void => void setTimeout(() => ctx.go({ kind: "group", group: "computers" }), 0);
  if (isProviderPlace(place)) return <Cards cards={cloudCards(ctx, place, ctx.reads.image, holding, onRemoved)} />;

  // How long this host has not heard from it, and null while it is holding its link: a computer that is answering
  // reads its facts plain, since nothing about them is stale.
  const away = place.present === true ? null : awayMsOf(place, ctx.now);
  // A cloud is no computer this host reaches, and this computer is reached by being here: the road reading is a
  // joined computer's alone, and the Connection card stands or goes with it.
  const road = here ? null : absentRoad({ name: place.name, road: place.road, awayMs: awayMsOf(place, ctx.now), dialled: place.dialled });
  const took = place.dialled?.answered === true && place.dialled.roundTripMs !== undefined ? ` · ${place.dialled.roundTripMs} ms` : "";
  const copies = copiesWord(place, here);
  const landing = landingOn(ctx, place);
  const ports = landing === null ? "" : portsWord(landing.capabilities, undefined, APP_PLATFORM);
  const spend = ctx.reads.spend.find(row => row.place === place.id);

  const facts: SettingsItem[] = [
    // Marked while the computer is not answering, the way the pane's OS row is: a person who cannot tell which of
    // two screens is stale is the whole of what this line was reported for.
    ...(place.os === undefined ? [] : [{ kind: "line" as const, id: "system", label: WHERE_WORDS.system, value: lastKnown(place.engine !== undefined && place.engine !== "none" ? `${place.os} · ${place.engine}` : place.os, away), hover: WHERE_WORDS.systemHover, attrs: { "data-k": "system" } }]),
    ...(place.shape === undefined ? [] : [{ kind: "line" as const, id: "size", label: WHERE_WORDS.size, value: fmtSize(place.shape, placeCpuWord(place)), attrs: { "data-k": "size" } }]),
    ...(place.diskFreeBytes === undefined ? [] : [{ kind: "line" as const, id: "disk-free", label: WHERE_WORDS.diskFree, value: fmtBytes(place.diskFreeBytes), attrs: { "data-k": "disk-free" } }]),
    ...(here || place.joinedAt === undefined ? [] : [{ kind: "line" as const, id: "joined", label: WHERE_WORDS.joined, value: WHERE_WORDS.ago(offlineFor(ctx.now - Date.parse(place.joinedAt))), attrs: { "data-k": "joined" } }]),
    ...(spend === undefined ? [] : [{ kind: "line" as const, id: "spend", label: WHERE_WORDS.spend, value: spendLine(spend), attrs: { "data-k": "spend" } }]),
  ];
  // The dial's answer replaces the description while it stands, one line with the whole on hover; a wsp that
  // cannot dial says so there and draws no button.
  const answered = line ?? road?.refused ?? heldWhy ?? WHERE_WORDS.answeredDescription;
  const connection: SettingsItem[] =
    road === null
      ? []
      : [
          ...(road.address === null ? [] : [{ kind: "row" as const, id: "address", title: WHERE_WORDS.address, description: WHERE_WORDS.addressDescription, word: road.address, attrs: { "data-k": "address" } }]),
          {
            kind: "row" as const,
            id: "answered",
            title: WHERE_WORDS.answered,
            description: answered,
            word: `${road.answered}${took}`,
            attrs: { "data-k": "answered" },
            ...(dialRoad === undefined || heldWhy !== null ? {} : { control: <DialButton busy={busy} held={held} road={dialRoad} onDial={dial} /> }),
          },
        ];
  const workspaceThere: SettingsItem[] = [
    ...(copies === "" ? [] : [{ kind: "row" as const, id: "copies", title: WHERE_WORDS.copies, description: WHERE_WORDS.copiesDescription, word: copies, attrs: { "data-k": "copies" } }]),
    ...(ports === "" ? [] : [{ kind: "row" as const, id: "ports", title: WHERE_WORDS.ports, description: WHERE_WORDS.portsDescription, word: ports, attrs: { "data-k": "ports" } }]),
  ];
  const recipe = recipeLines(place).map(row => ({ kind: "line" as const, id: `recipe-${row.id}`, label: row.label, value: `${PROVISION_KIND_WORDS[row.kind]} · ${row.state}`, valueClass: "fact" as const, attrs: { "data-k": "recipe-row", "data-kind": row.kind } }));
  const workspaces = holding.workspaces.map((w, at) => ({ kind: "line" as const, id: `workspace-${at}`, label: w.name, value: `${w.state} · ${threadWord(w.threads)}`, valueClass: "fact" as const, attrs: { "data-k": "workspace-line" } }));
  const imageBytes = ctx.reads.image === null ? undefined : copyOn(ctx.reads.image.copies, place)?.sizeBytes;
  const cards: SettingsCardData[] = [
    { id: "look", items: [{ kind: "row", id: "icon", title: WHERE_WORDS.icon, description: WHERE_WORDS.iconDescription, control: <ComputerIconSelect place={place} onChange={icon => ctx.setPreferences({ computerLook: { [place.id]: { icon } } })} /> }] },
    ...(facts.length === 0 ? [] : [{ id: "facts", items: facts }]),
    ...(connection.length === 0 ? [] : [{ id: "connection", head: WHERE_WORDS.connection, items: connection }]),
    ...(workspaceThere.length === 0 ? [] : [{ id: "workspace-there", head: WHERE_WORDS.workspaceThere, items: workspaceThere }]),
    { id: "agents", head: WHERE_WORDS.agents, items: agentRows(here ? hereAgentLines(ctx.reads.setup) : placeAgentLines(place), here, here ? THIS_COMPUTER_WORD : placeName(place)) },
    // The card stands only on a computer with a provision, one muted line where it has no such rows.
    ...(place.provision === undefined ? [] : [{ id: "recipe", head: WHERE_WORDS.recipe, items: recipe.length === 0 ? [{ kind: "line" as const, id: "no-recipe", label: WHERE_WORDS.recipeNone, attrs: { "data-k": "no-recipe" } }] : recipe }]),
    ...(workspaces.length === 0 ? [] : [{ id: "workspaces", head: WHERE_WORDS.workspaces, items: workspaces }]),
    // This computer is the one nothing can be done to: it is the computer the host runs on.
    ...(here
      ? []
      : [
          {
            id: "acts",
            items: [
              {
                kind: "row" as const,
                id: "update",
                title: WHERE_WORDS.updateTitle(placeName(place)),
                description: noUpdate ? `${WHERE_WORDS.updateDescription} ${WHERE_WORDS.updateHeld}` : WHERE_WORDS.updateDescription,
                control: <UpdateControl place={place} held={noUpdate} />,
              },
              {
                kind: "row" as const,
                id: "remove",
                title: WHERE_WORDS.removeTitle(placeName(place)),
                description: WHERE_WORDS.removeDescription(placeName(place)),
                control: <RemoveControl place={place} holding={holding} imageBytes={imageBytes} onRemoved={onRemoved} />,
              },
            ],
          },
        ]),
  ];
  return <Cards cards={cards} />;
}
