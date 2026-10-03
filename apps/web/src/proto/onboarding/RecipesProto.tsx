// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Recipes: the list, one row per recipe with the icon the person
// picked from the projects' set, one line of what it holds and the machines
// following it; a recipe open as its head row with the icon picker and the
// same ticked rows the dialog's steps draw, so a tick here reaches every
// machine on it; and the empty page in the one voice every empty settings
// card speaks in, with the act under it.
import { PlugIcon, ScrollTextIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import type { ProjectIcon } from "@wsp/protocol";
import { AgentMarks } from "../../components/agents/agentsParts.js";
import { HarnessMark } from "../../components/chat/HarnessMark.js";
import { AddButton } from "../../components/ui/add-button.js";
import { Button, DANGER_BUTTON } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { cn } from "../../lib/utils.js";
import { PROJECT_GLYPHS } from "../../projects/look.js";
import { IconSelect } from "../../projects/LookPicker.js";
import { FACT } from "../../settings/format.js";
import { Chevron, GlyphFrame, Grid, GridHead, GridName, GridRow } from "../../settings/grid.js";
import { CARD_INSET, NOTE, ROW_FIELD, ROW_FLOOR } from "../../settings/layout.js";
import { CARD_SURFACE, Card, HeadRow, Line } from "../../settings/rows.js";
import { AGENTS, CLIS, RECIPES, SERVERS, SKILLS, SKILL_COUNT, type Recipe } from "./fixtures.js";
import { PickRow } from "./PickRow.js";

const RECIPE_COLUMNS = "grid-cols-[minmax(0,1fr)_140px_14px] max-md:grid-cols-[minmax(0,1fr)_auto_14px]";

export function RecipesListProto({ open, openAdd }: { open: (id: string) => void; openAdd: () => void }) {
  return (
    <section data-settings-card="recipes" className="flex flex-col gap-2">
      <Grid id="recipes" head={<GridHead columns={RECIPE_COLUMNS} cells={[{ word: "Recipe" }, { word: "Machines" }]} />}>
        {RECIPES.map(recipe => {
          const Glyph = PROJECT_GLYPHS[recipe.icon];
          return (
            <GridRow key={recipe.id} columns={RECIPE_COLUMNS} open={() => open(recipe.id)} attrs={{ "data-recipe-row": recipe.id }}>
              <GridName
                glyph={
                  <GlyphFrame>
                    <Glyph aria-hidden className="size-4 text-foreground/80" />
                  </GlyphFrame>
                }
                name={recipe.name}
                note={recipe.holds}
              />
              <span className={cn(FACT, "min-w-0 truncate")}>{recipe.machines.join(", ")}</span>
              <Chevron />
            </GridRow>
          );
        })}
      </Grid>
      <p className={NOTE}>A recipe is saved at the end of Add a computer. A machine that follows one takes every change to it.</p>
      <div className="flex">
        <AddButton data-k="add-computer-button" onClick={openAdd}>
          Add a computer
        </AddButton>
      </div>
    </section>
  );
}

export function RecipesEmptyProto({ openAdd }: { openAdd: () => void }) {
  return (
    <Card
      id="recipes"
      under={
        <AddButton data-k="add-computer-button" onClick={openAdd}>
          Add a computer
        </AddButton>
      }
    >
      <Line id="none" label="No recipes yet. The picks you make in Add a computer can be saved as one at its end." empty attrs={{ "data-k": "recipes-none" }} />
    </Card>
  );
}

export function RecipePageProto({ recipe = RECIPES[0]! }: { recipe?: Recipe }) {
  const [icon, setIcon] = useState<ProjectIcon>(recipe.icon);
  const Glyph = PROJECT_GLYPHS[icon];
  const on = recipe.machines.length === 0 ? "No machine follows it yet." : `Followed by ${recipe.machines.join(" and ")}.`;
  return (
    <>
      <section data-settings-card="recipe" className="flex flex-col gap-3">
        <div className={CARD_SURFACE}>
          <HeadRow glyph={<Glyph aria-hidden className="size-4 text-foreground/80" />} title={recipe.name} line={on} slot={<IconSelect icon={icon} hue="neutral" onChange={setIcon} />} attrs={{ "data-k": "recipe-head" }} />
        </div>
        <p className={NOTE}>A tick changed here reaches every machine following the recipe. Sign-ins stay each machine's own.</p>
      </section>
      <Grid id="agents" head={<GridHead cells={[{ word: "Agents" }]} />}>
        {AGENTS.map(agent => (
          <PickRow key={agent.id} id={agent.id} checked={agent.ticked} glyph={<HarnessMark harness={agent.id} label={agent.name} className="size-5" />} name={agent.name} note={agent.ticked ? agent.signIn : "Not on this recipe."} />
        ))}
      </Grid>
      <Grid id="servers" head={<GridHead cells={[{ word: "MCP servers" }]} />}>
        {SERVERS.filter(s => s.ticked).map(server => (
          <PickRow key={server.id} id={server.id} checked glyph={<PlugIcon aria-hidden className="size-4 text-foreground/80" />} name={server.name} marks={<AgentMarks agents={server.agents} />} note={server.note} />
        ))}
      </Grid>
      <Grid id="clis" head={<GridHead cells={[{ word: "CLIs" }]} />}>
        {CLIS.filter(c => c.ticked).map(cli => (
          <PickRow key={cli.id} id={cli.id} checked glyph={<TerminalIcon aria-hidden className="size-4 text-foreground/80" />} name={cli.name} note={`By ${cli.via}. Versions follow this Mac.`} slot={<span className={FACT}>{cli.size}</span>} />
        ))}
      </Grid>
      <Grid id="skills" head={<GridHead cells={[{ word: "Skills" }]} />}>
        {SKILLS.slice(0, 5).map(item => (
          <PickRow key={item.id} id={item.id} checked glyph={<ScrollTextIcon aria-hidden className="size-4 text-foreground/80" />} name={item.name} marks={<AgentMarks agents={item.agents} />} slot={<span className={FACT}>{item.from}</span>} />
        ))}
        <Line id="more-skills" label={`${SKILL_COUNT - 5} more skills on this recipe.`} empty />
      </Grid>
      <Card id="rename">
        <div className={cn("flex flex-col justify-center gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5", CARD_INSET, ROW_FLOOR)}>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm leading-5 font-medium text-foreground">Name</span>
            <span className={NOTE}>Shown in Start from and on each machine's page.</span>
          </span>
          <Input aria-label="Recipe name" defaultValue={recipe.name} className={cn(ROW_FIELD, "w-44 max-sm:w-36")} />
        </div>
      </Card>
      <div data-k="delete-line" className={cn(CARD_SURFACE, CARD_INSET, ROW_FLOOR, "flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8")}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm leading-5 font-medium text-foreground">Delete {recipe.name}</span>
          <span className={cn(NOTE, "max-w-xl leading-[1.45]")}>{recipe.machines.length === 0 ? "Nothing follows it." : `${recipe.machines.join(" and ")} keep what they have and follow nothing.`}</span>
        </span>
        <Button data-k="delete" size="xs" variant="outline" className={DANGER_BUTTON}>
          Delete
        </Button>
      </div>
    </>
  );
}
