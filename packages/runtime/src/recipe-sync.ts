// SPDX-License-Identifier: AGPL-3.0-only
// What moved between the recipe a computer last applied and the recipe it
// follows now, row by row, and which steps of the setup carry each move.
// Only the difference goes to the computer: a row nobody touched is never
// planned again.
import { RECIPE_KINDS, type PlaceSetupStep, type RecipeFile, type RecipeKind } from "@wsp/protocol";

/** One row that moved, keyed `<kind>/<row>` as a resolved recipe keys it: added to the recipe, changed in it (how an
 * agent signs in), edited on this computer (a skill's files, a CLI's version), or taken out. */
export interface RecipeChange {
  key: string;
  kind: RecipeKind;
  name: string;
  how: "added" | "changed" | "edited" | "removed";
}

/** The rows of one kind, by name, with what the file says beside each. */
function rowsOf(file: RecipeFile, kind: RecipeKind): Map<string, unknown> {
  const table: Record<string, unknown> = kind === "configs" ? file.configs : file[kind];
  return new Map(Object.entries(table).filter(([, row]) => row !== undefined));
}

/** What a computer had for one row, by every item key that row reads: `mcp/<name>/<agent>` for a server. */
function itemsOf(items: Readonly<Record<string, string>>, key: string): string {
  return JSON.stringify(
    Object.keys(items)
      .filter(k => k === key || k.startsWith(`${key}/`))
      .sort()
      .map(k => [k, items[k]]),
  );
}

/** Every row added, changed or taken out between what a computer applied and the recipe now. A computer that kept no
 * items (set up before the sync) reads every row that has one as changed, once. */
export function recipeChanges(before: RecipeFile | undefined, beforeItems: Readonly<Record<string, string>> | undefined, after: RecipeFile, afterItems: Readonly<Record<string, string>>): RecipeChange[] {
  const out: RecipeChange[] = [];
  for (const kind of RECIPE_KINDS) {
    const was = before === undefined ? new Map<string, unknown>() : rowsOf(before, kind);
    const now = rowsOf(after, kind);
    for (const [name, row] of now) {
      const key = `${kind}/${name}`;
      if (!was.has(name)) out.push({ key, kind, name, how: "added" });
      else if (JSON.stringify(was.get(name)) !== JSON.stringify(row)) out.push({ key, kind, name, how: "changed" });
      else if (beforeItems === undefined ? itemsOf(afterItems, key) !== "[]" : itemsOf(beforeItems, key) !== itemsOf(afterItems, key)) out.push({ key, kind, name, how: "edited" });
    }
    for (const name of was.keys()) if (!now.has(name)) out.push({ key: `${kind}/${name}`, kind, name, how: "removed" });
  }
  return out;
}

/** The steps that carry a set of changes. An agent added brings its files, servers and skills folder with it; a
 * server taken out leaves by the servers step, which takes out what wsp wrote and is no longer picked; the rest of a
 * removal is the undo's, not a step's. */
export function stepsFor(changes: readonly RecipeChange[], after: RecipeFile): Set<PlaceSetupStep> {
  const steps = new Set<PlaceSetupStep>();
  for (const c of changes) {
    if (c.how === "removed") {
      if (c.kind === "mcp") steps.add("mcp");
      if (c.kind === "agents" || c.kind === "clis") steps.add("context");
      continue;
    }
    switch (c.kind) {
      case "agents":
        // An agent's own files edited here land with the servers; a sign-in word changed is a sign-in again.
        if (c.how === "edited") steps.add("mcp");
        else if (c.how === "changed") steps.add("signins");
        else for (const s of ["agents", "signins", "mcp", "skills", "context"] as const) steps.add(s);
        break;
      case "clis":
        steps.add("clis").add("context");
        if (c.how === "added" && after.clis[c.name]?.needs !== undefined) steps.add("floor");
        break;
      case "configs":
        steps.add(c.name === "github" ? "github" : "configs");
        break;
      case "mcp":
      case "skills":
      case "plugins":
      case "folders":
        steps.add(c.kind);
    }
  }
  return steps;
}
