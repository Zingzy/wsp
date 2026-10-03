// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Recipes: the list, one row per recipe with the icon the person
// picked from the projects' set, one line of what it holds and the computers
// following it; a recipe open as its head row with the icon picker and the
// same ticked rows Add a computer draws, so a tick here is written into the
// recipe its computers follow; and the empty page in the one voice every
// empty settings card speaks in, with the act under it.
import { useEffect, useState } from "react";
import type { ProjectIcon, RecipeFile, RecipeOptions, RecipeView } from "@wsp/protocol";
import { AddButton } from "../components/ui/add-button.js";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "../components/ui/alert-dialog.js";
import { Button, DANGER_BUTTON, NEUTRAL_RING } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { cn } from "../lib/utils.js";
import { useStore } from "../protocol/store.js";
import { failureOf, type Failure } from "../protocol/failure.js";
import { PROJECT_GLYPHS } from "../projects/look.js";
import { IconSelect } from "../projects/LookPicker.js";
import { openAdd } from "./add/addFlow.js";
import { AgentsPicks, ClisPicks, ServersPicks, SkillsPicks } from "./add/PickLists.js";
import { FACT, WHERE_WORDS } from "./format.js";
import { Chevron, GlyphFrame, Grid, GridHead, GridName, GridRow } from "./grid.js";
import { CARD_INSET, NOTE, PAGE_GAP, ROW_FIELD, ROW_FLOOR, SECTION_HEAD } from "./layout.js";
import { readRecipes, useRecipes } from "./recipesStore.js";
import { CARD_SURFACE, Card, HeadRow, Line, type SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";
import { RefusalSlot } from "./sheetParts.js";

export const RECIPES_WORDS = { title: "Recipes" } as const;

const RECIPE_COLUMNS = "grid-cols-[minmax(0,1fr)_140px_14px] max-md:grid-cols-[minmax(0,1fr)_auto_14px]";
const GLYPH = "size-4 text-foreground/80";

/** The icon a recipe wears: the person's pick, else the folder every project starts with. */
const iconOf = (looks: Record<string, { icon: ProjectIcon }> | undefined, slug: string): ProjectIcon => looks?.[slug]?.icon ?? "folder";

function RecipesList({ recipes, open }: { recipes: readonly RecipeView[]; open: (slug: string) => void }) {
  const looks = useStore(s => s.preferences.recipeLook);
  return (
    <section data-settings-card="recipes" className="flex flex-col gap-2">
      <Grid id="recipes" head={<GridHead columns={RECIPE_COLUMNS} cells={[{ word: "Recipe" }, { word: "Computers" }]} />}>
        {recipes.map(recipe => {
          const Glyph = PROJECT_GLYPHS[iconOf(looks, recipe.slug)];
          return (
            <GridRow key={recipe.slug} columns={RECIPE_COLUMNS} open={() => open(recipe.slug)} attrs={{ "data-recipe-row": recipe.slug }}>
              <GridName
                glyph={
                  <GlyphFrame>
                    <Glyph aria-hidden className={GLYPH} />
                  </GlyphFrame>
                }
                name={recipe.name}
                note={recipe.summary}
              />
              <span className={cn(FACT, "min-w-0 truncate")}>{recipe.machines.join(", ")}</span>
              <Chevron />
            </GridRow>
          );
        })}
      </Grid>
      <div className="flex">
        <AddButton data-k="add-computer-button" onClick={openAdd}>
          Add a computer
        </AddButton>
      </div>
    </section>
  );
}

function RecipesEmpty() {
  return (
    <Card
      id="recipes"
      under={
        <AddButton data-k="add-computer-button" onClick={openAdd}>
          Add a computer
        </AddButton>
      }
    >
      <Line id="none" label="No recipes yet. Save one at the end of Add a computer." empty attrs={{ "data-k": "recipes-none" }} />
    </Card>
  );
}

/** One section of a recipe's page: its head and the list under it. */
function Section({ id, head, children }: { id: string; head: string; children: React.ReactNode }) {
  return (
    <section data-settings-card={id} className="flex flex-col gap-3">
      <h2 data-settings-head className={SECTION_HEAD}>
        {head}
      </h2>
      {children}
    </section>
  );
}

function RecipePage({ recipe, options, onGone }: { recipe: RecipeView; options: RecipeOptions | null; onGone: () => void }) {
  const api = useStore(s => s.api);
  const looks = useStore(s => s.preferences.recipeLook);
  const setPreferences = useStore(s => s.setPreferences);
  const [refused, setRefused] = useState<Failure | null>(null);
  const [name, setName] = useState(recipe.name);
  const [asking, setAsking] = useState(false);
  const icon = iconOf(looks, recipe.slug);
  const Glyph = PROJECT_GLYPHS[icon];
  const on = recipe.machines.join(" and ");
  const followed = recipe.machines.length > 0;
  const save = (file: RecipeFile, as = recipe.name): void => {
    if (api?.recipesSave === undefined) return;
    void api.recipesSave(as, { file: { ...file, name: as } }).then(
      () => {
        setRefused(null);
        readRecipes(api);
      },
      (e: unknown) => setRefused(failureOf(e)),
    );
  };
  // A name moves the recipe's file, which only a recipe no computer follows may do: the computers name the file.
  const rename = (): void => {
    const to = name.trim();
    if (to === "" || to === recipe.name || followed || api?.recipesRemove === undefined) return;
    const drop = api.recipesRemove;
    void api.recipesSave?.(to, { file: { ...recipe.file, name: to } })
      .then(async saved => {
        await drop(recipe.slug);
        if (looks?.[recipe.slug] !== undefined) void setPreferences({ recipeLook: { [saved.slug]: looks[recipe.slug]!, [recipe.slug]: null } });
        readRecipes(api);
      })
      .catch((e: unknown) => setRefused(failureOf(e)));
  };
  const remove = (): void => {
    if (api?.recipesRemove === undefined) return;
    void api.recipesRemove(recipe.slug).then(
      () => {
        setAsking(false);
        if (looks?.[recipe.slug] !== undefined) void setPreferences({ recipeLook: { [recipe.slug]: null } });
        readRecipes(api);
        onGone();
      },
      (e: unknown) => {
        setAsking(false);
        setRefused(failureOf(e));
      },
    );
  };
  const box = followed ? on : "";
  const props = options === null ? null : { picks: recipe.file, options, onChange: (next: RecipeFile) => save(next), box, onlyTicked: true };
  const leaving = followed ? `${on} keep what they have and follow nothing.` : "Nothing follows it.";
  return (
    <div className={cn("flex flex-col", PAGE_GAP)}>
      <section data-settings-card="recipe" className="flex flex-col gap-3">
        <div className={CARD_SURFACE}>
          <HeadRow glyph={<Glyph aria-hidden className={GLYPH} />} title={recipe.name} line={followed ? `Followed by ${on}.` : "No computer follows it yet."} slot={<IconSelect icon={icon} hue="neutral" onChange={next => void setPreferences({ recipeLook: { [recipe.slug]: { icon: next } } })} />} attrs={{ "data-k": "recipe-head" }} />
        </div>
        <p className={NOTE}>Ticks here reach {followed ? on : "every computer that follows it"}.</p>
      </section>
      {refused === null ? null : <RefusalSlot k="recipe-refused" said={refused.said} {...(refused.fix === undefined ? {} : { fix: refused.fix })} />}
      {props === null ? null : (
        <>
          <Section id="recipe-agents" head="Agents">
            <AgentsPicks {...props} onlyTicked={false} wayAsNote />
          </Section>
          {Object.keys(recipe.file.mcp).length === 0 ? null : (
            <Section id="recipe-servers" head="MCP servers">
              <ServersPicks {...props} />
            </Section>
          )}
          {Object.keys(recipe.file.clis).length === 0 ? null : (
            <Section id="recipe-clis" head="CLIs">
              <ClisPicks {...props} />
            </Section>
          )}
          {Object.keys(recipe.file.skills).length === 0 ? null : (
            <Section id="recipe-skills" head="Skills">
              <SkillsPicks {...props} first={5} />
            </Section>
          )}
        </>
      )}
      <Card id="rename">
        <div className={cn("flex flex-col justify-center gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-5", CARD_INSET, ROW_FLOOR)}>
          <span className="text-sm leading-5 font-medium text-foreground">Name</span>
          <Input data-k="recipe-name" aria-label="Recipe name" value={name} readOnly={followed} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => e.key === "Enter" && rename()} className={cn(ROW_FIELD, "w-44 max-sm:w-36")} />
        </div>
      </Card>
      <div data-k="delete-line" className={cn(CARD_SURFACE, CARD_INSET, ROW_FLOOR, "flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8")}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm leading-5 font-medium text-foreground">Delete {recipe.name}</span>
          <span className={cn(NOTE, "max-w-xl leading-[1.45]")}>{leaving}</span>
        </span>
        <Button data-k="delete" size="xs" variant="outline" className={DANGER_BUTTON} onClick={() => setAsking(true)}>
          Delete
        </Button>
      </div>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup data-delete-recipe-dialog>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {recipe.name}?</AlertDialogTitle>
            <AlertDialogDescription>{leaving}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" className={NEUTRAL_RING} />}>{WHERE_WORDS.cancel}</AlertDialogClose>
            <Button data-k="delete-confirm" variant="destructive" onClick={remove}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** The group's page: the list, the empty page, or one recipe open; reads the recipes and what they pick from. */
function RecipesPage() {
  const api = useStore(s => s.api);
  const recipes = useRecipes(s => s.recipes);
  const refused = useRecipes(s => s.refused);
  const [open, setOpen] = useState<string | null>(null);
  const [options, setOptions] = useState<RecipeOptions | null>(null);
  useEffect(() => readRecipes(api), [api]);
  useEffect(() => {
    if (open === null || options !== null || api?.recipesOptions === undefined) return;
    void api.recipesOptions().then(setOptions, () => undefined);
  }, [open, options, api]);
  if (recipes === null) return null;
  const shown = open === null ? undefined : recipes.find(r => r.slug === open);
  if (shown !== undefined) return <RecipePage key={shown.slug} recipe={shown} options={options} onGone={() => setOpen(null)} />;
  return (
    <>
      {refused === null ? null : <RefusalSlot k="recipes-refused" said={refused.said} {...(refused.fix === undefined ? {} : { fix: refused.fix })} />}
      {recipes.length === 0 ? <RecipesEmpty /> : <RecipesList recipes={recipes} open={setOpen} />}
    </>
  );
}

export function recipesCards(_ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "recipes", items: [], body: <RecipesPage /> }];
}
