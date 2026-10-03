// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Computers as the setup job changes it: the list's state column is
// a mark in its ink with the sentence on hover, or the one act (Update), and
// nothing at all for a computer that is simply ready; a Pending list under it
// holds the machines added and not yet set up. A computer's own page keeps its
// head and the agents link, gains its setup as a list of steps with Retry on
// the rows that did not land and the recipe it follows, and drops Projects
// here and Threads running here.
import { fmtMemGb, type PlaceView } from "@wsp/protocol";
import { AddButton } from "../../components/ui/add-button.js";
import { Button, DANGER_BUTTON } from "../../components/ui/button.js";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { cn } from "../../lib/utils.js";
import { PROJECT_GLYPHS } from "../../projects/look.js";
import { ComputerGlyph } from "../../settings/ComputerGlyph.js";
import { FACT } from "../../settings/format.js";
import { Chevron, GlyphFrame, Grid, GridHead, GridName, GridRow, Num, StateCell } from "../../settings/grid.js";
import { CARD_INSET, NOTE, ROW_FLOOR, SELECT_WIDTH } from "../../settings/layout.js";
import { placeName } from "../../settings/places.js";
import { CARD_SURFACE, Card, HeadRow, Row } from "../../settings/rows.js";
import { BOAT, DISHAPC, HERE, PLACES, RECIPES, RUNNING_FAILED, SPOO, SPOO_MONGO, STUDIO } from "./fixtures.js";
import { MARK_WORDS, StateMark, type MarkState } from "./StateMark.js";
import { RetryActs, StepRow } from "./StepRow.js";

/** Each fixture computer's state and the sentence its mark says on hover. */
const STATES: Record<string, { state: MarkState; why: string; running: string }> = {
  [HERE.id]: { state: "ready", why: "Ready", running: "5/8" },
  [SPOO.id]: { state: "ready", why: "Runs daemon 57; this wsp deploys 61.", running: "1/2" },
  [STUDIO.id]: { state: "working", why: "Setting up: copying 78 skills, 7 of 12", running: "0/16" },
  [SPOO_MONGO.id]: { state: "needs-you", why: "Needs you: Codex is waiting for its sign-in", running: "0/1" },
  [DISHAPC.id]: { state: "failed", why: "Setup failed: base packages did not install", running: "0/4" },
  [BOAT.id]: { state: "offline", why: "Offline since Thursday", running: "0/3" },
};

/** The Computers template with the state column at the width a mark or Update needs, 72 px, down from the 100 px
 * a word took; below 768 px the name keeps the room that frees. */
const LIST_COLUMNS = "grid-cols-[minmax(0,1fr)_56px_72px_64px_72px_14px] max-md:grid-cols-[minmax(0,1fr)_auto_72px_14px]";

const placeGlyph = (place: PlaceView) => (
  <GlyphFrame>
    <ComputerGlyph place={place} className="size-4 text-foreground/80" />
  </GlyphFrame>
);

const HEAD = [{ word: "Computer" }, { word: "Cores", num: true, wideOnly: true }, { word: "Memory", num: true, wideOnly: true }, { word: "Threads", num: true }] as const;

function ComputerRow({ place, open }: { place: PlaceView; open: () => void }) {
  const at = STATES[place.id]!;
  return (
    <GridRow columns={LIST_COLUMNS} open={open} title={at.why} attrs={{ "data-place-row": place.id }}>
      <GridName glyph={placeGlyph(place)} name={placeName(place)} {...(place.default ? { tag: "default" } : {})} />
      <Num k="cores" wideOnly>
        {place.shape?.cpu}
      </Num>
      <Num k="memory" wideOnly>
        {place.shape === undefined ? undefined : fmtMemGb(place.shape.memMb)}
      </Num>
      <Num k="threads">{at.running}</Num>
      <StateCell why={at.why}>
        {place.behind !== undefined ? (
          <Button data-k="update" size="xs" variant="outline">
            Update
          </Button>
        ) : (
          <StateMark state={at.state} why={at.why} />
        )}
      </StateCell>
      <Chevron />
    </GridRow>
  );
}

export function ComputersProto({ openComputer, openAdd }: { openComputer: (id: string) => void; openAdd: () => void }) {
  const computers = PLACES;
  const pending: PlaceView[] = [{ id: "p_jump", kind: "computer", name: "jumpbox", default: false, present: true, os: "Ubuntu 22.04", shape: { cpu: 4, memMb: 8192 } }];
  return (
    <>
      <section data-settings-card="computers" className="flex flex-col gap-2">
        <Grid id="computers" head={<GridHead columns={LIST_COLUMNS} cells={HEAD} />}>
          {computers.map(place => (
            <ComputerRow key={place.id} place={place} open={() => openComputer(place.id)} />
          ))}
        </Grid>
        <div className="flex">
          <AddButton data-k="add-computer-button" onClick={openAdd}>
            Add a computer
          </AddButton>
        </div>
      </section>
      <section data-settings-card="pending" className="flex flex-col gap-2">
        <Grid id="pending" head={<GridHead columns={LIST_COLUMNS} cells={[{ word: "Pending" }, { word: "", wideOnly: true }, { word: "", wideOnly: true }, { word: "" }]} />}>
          {pending.map(place => (
            <GridRow key={place.id} columns={LIST_COLUMNS} open={openAdd} title="Pending: chosen up to Skills. Open to carry on." attrs={{ "data-place-row": place.id }}>
              <GridName glyph={placeGlyph(place)} name={place.name} note="Chosen up to Skills" />
              <span className="col-span-3 max-md:col-span-1" />
              <StateCell why="Pending: chosen up to Skills. Open to carry on.">
                <StateMark state="pending" why="Pending: chosen up to Skills. Open to carry on." />
              </StateCell>
              <Chevron />
            </GridRow>
          ))}
        </Grid>
      </section>
    </>
  );
}

const shapeLine = (place: PlaceView): string => [place.os, place.shape === undefined ? undefined : `${place.shape.cpu} cores`, place.shape === undefined ? undefined : fmtMemGb(place.shape.memMb)].filter((part): part is string => part !== undefined).join(", ");

function RecipeSelect() {
  return (
    <Select value="builders">
      <SelectTrigger size="sm" aria-label="Recipe" className={SELECT_WIDTH}>
        <SelectValue>
          {(value: string) => {
            const recipe = RECIPES.find(r => r.id === value);
            if (recipe === undefined) return "None";
            const Glyph = PROJECT_GLYPHS[recipe.icon];
            return (
              <span className="flex items-center gap-2">
                <Glyph aria-hidden className="size-4 text-muted-foreground" />
                {recipe.name}
              </span>
            );
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {RECIPES.map(recipe => {
          const Glyph = PROJECT_GLYPHS[recipe.icon];
          return (
            <SelectItem key={recipe.id} value={recipe.id}>
              <span className="flex items-center gap-2">
                <Glyph aria-hidden className="size-4" />
                {recipe.name}
              </span>
            </SelectItem>
          );
        })}
        <SelectItem value="none">None</SelectItem>
      </SelectPopup>
    </Select>
  );
}

export function ComputerPageProto() {
  const place = STUDIO;
  const name = placeName(place);
  const rows = RUNNING_FAILED;
  return (
    <>
      <section data-settings-card="computer" className="flex flex-col gap-3">
        <div className={CARD_SURFACE}>
          <HeadRow glyph={<ComputerGlyph place={place} className="size-4 text-foreground/80" />} title={name} line={shapeLine(place)} slot={<span className={cn(FACT)}>daemon 61</span>} attrs={{ "data-k": "computer-head" }} />
        </div>
        <div data-k="place-state" className="flex min-w-0 items-center gap-2.5 text-[13px] leading-5">
          <StateMark state="needs-you" why="Needs you" />
          <span className="min-w-0 truncate text-muted-foreground">One project and one skill did not land. Everything else is done.</span>
        </div>
      </section>
      <Card id="recipe">
        <Row id="follows" title="Follows a recipe" description="A change to the recipe, or to anything it holds on this Mac, reaches studio on its own." control={<RecipeSelect />} />
      </Card>
      <Grid id="setup" head={<GridHead cells={[{ word: "Setup" }]} />}>
        {rows.map(row => (
          <StepRow key={row.id} row={row} {...(row.state === "failed" ? { acts: <RetryActs /> } : {})} />
        ))}
      </Grid>
      <Grid id="sign-ins" head={<GridHead cells={[{ word: `Sign-ins on ${name}` }]} />}>
        <StepRow row={{ id: "si-claude", name: "Claude Code", state: "done", note: "Key copied from this Mac." }} />
        <StepRow row={{ id: "si-codex", name: "Codex", state: "failed", note: "Sign in on studio.", said: "The sign-in page ran out before anyone finished it.", fix: "Retry opens a fresh page and code here." }} acts={<RetryActs skip={false} />} />
      </Grid>
      <Card id="computer-agents">
        <Row id="agents-on" title={`Agents on ${name}`} description="The agents, tool servers and skills there, and what each is set up with." open={() => {}} attrs={{ "data-k": "agents-on" }} />
      </Card>
      <div data-k="remove-line" className={cn(CARD_SURFACE, CARD_INSET, ROW_FLOOR, "flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8")}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm leading-5 font-medium text-foreground">Remove {name}</span>
          <span className={cn(NOTE, "max-w-xl leading-[1.45]")}>wsp, the agents it installed, the copied skills and config and the projects' records come off {name}. Your folders there stay.</span>
        </span>
        <Button data-k="remove" size="xs" variant="outline" className={DANGER_BUTTON}>
          Remove
        </Button>
      </div>
    </>
  );
}

export { MARK_WORDS };
