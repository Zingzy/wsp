// SPDX-License-Identifier: AGPL-3.0-only
// The saved recipes as the host lists them, read when a screen that draws them
// opens and again after this window changes one. One list for Add a computer
// and Settings, Recipes, so the two never read the host twice for one page.
import { create } from "zustand";
import type { RecipeView } from "@wsp/protocol";
import type { Api } from "../protocol/client.js";
import { failureOf, type Failure } from "../protocol/failure.js";

interface RecipesState {
  /** Null until the host answered. */
  recipes: RecipeView[] | null;
  refused: Failure | null;
}

export const useRecipes = create<RecipesState>(() => ({ recipes: null, refused: null }));

export function readRecipes(api: Api | null): void {
  if (api?.recipesList === undefined) {
    useRecipes.setState({ recipes: [] });
    return;
  }
  void api.recipesList().then(
    recipes => useRecipes.setState({ recipes, refused: null }),
    (e: unknown) => useRecipes.setState({ recipes: [], refused: failureOf(e) }),
  );
}
