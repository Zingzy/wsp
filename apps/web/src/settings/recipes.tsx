// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Recipes: the named picks a machine follows. The page is drawn by
// the prototype's components until the recipes op lands on the wire.
import { RecipesListProto } from "../proto/onboarding/RecipesProto.js";
import type { SettingsCardData } from "./rows.js";
import type { SettingsContext } from "./settingsContext.js";

export const RECIPES_WORDS = { title: "Recipes" } as const;

export function recipesCards(ctx: SettingsContext): SettingsCardData[] {
  return [{ id: "recipes", items: [], body: <RecipesListProto open={() => {}} openAdd={() => ctx.askAdd(null)} /> }];
}
