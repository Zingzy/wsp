// SPDX-License-Identifier: AGPL-3.0-only
// A recipe: a named pick of what goes on a computer, chosen from what this
// computer has. Facts only, never a secret: the names of agents, servers,
// CLIs, skills, plugins, folders and configs, and how each signs in. What the
// computer has for each row right now (a version, a digest) is not in the
// file; it is read when the recipe is resolved, so a recipe never pins one.
import { z } from "zod";
import { plural } from "./format.js";
import { ProjectHue, ProjectIcon } from "./project-look.js";

/** How an agent or the GitHub row signs in on the computer: the token this computer's vault holds, set in the
 * environment of every run there, or the tool's own login run on that computer through the sign-in relay. */
export const RecipeSignIn = z.enum(["vault", "machine"]);
export type RecipeSignIn = z.infer<typeof RecipeSignIn>;

/** A row's name, and the facts a row says beside it, made once each: every schema made costs the host its methods
 * bound anew, held for good. */
const NAME = z.string().min(1);
const NAMES = z.array(NAME);
const SIGN_IN = RecipeSignIn.optional();
const row = <T extends z.ZodRawShape>(shape: T) => z.object(shape);

/** One recipe file, `<state dir>/recipes/<slug>.toml`. Every table is keyed by the name the row goes by here: an
 * agent's catalog id, a server's name, a CLI's package, a skill's folder name, a plugin's `name@marketplace`, a
 * folder's own key. `needs` is the one way a row asks for the C toolchain, which the floor carries only then. */
export const RecipeFile = z
  .object({
    name: z.string().trim().min(1).max(64),
    agents: z.record(NAME, row({ signin: SIGN_IN })).default({}),
    mcp: z.record(NAME, row({ agents: NAMES.min(1) })).default({}),
    clis: z.record(NAME, row({ via: NAME, needs: NAMES.optional() })).default({}),
    skills: z.record(NAME, row({ from: NAME })).default({}),
    plugins: z.record(NAME, row({})).default({}),
    folders: z
      .record(
        NAME,
        row({
          from: NAME,
          name: NAME.optional(),
          icon: ProjectIcon.optional(),
          hue: ProjectHue.optional(),
          keep: NAMES.default([]),
        }),
      )
      .default({}),
    configs: row({ git: row({}).optional(), shell: row({}).optional(), github: row({ signin: SIGN_IN }).optional() }).default({}),
  })
  .strict();
export type RecipeFile = z.infer<typeof RecipeFile>;

/** The kinds of row a recipe holds, in the order a person reads them. */
export const RECIPE_KINDS = ["agents", "mcp", "clis", "skills", "plugins", "folders", "configs"] as const;
export type RecipeKind = (typeof RECIPE_KINDS)[number];

const KIND_WORDS: Record<RecipeKind, string> = { agents: "agent", mcp: "MCP server", clis: "CLI", skills: "skill", plugins: "plugin", folders: "folder", configs: "config" };

/** The file name a recipe's name is kept under: lower case, every run of anything but a letter or a digit one dash.
 * Empty for a name with neither, which the writer refuses. */
export const recipeSlug = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** The word a computer that follows no saved recipe carries in place of one. */
export const NO_RECIPE = "none";

/** The rows of one recipe by kind, configs counted by the ones it ticks. */
export function recipeCounts(file: RecipeFile): Record<RecipeKind, number> {
  return {
    agents: Object.keys(file.agents).length,
    mcp: Object.keys(file.mcp).length,
    clis: Object.keys(file.clis).length,
    skills: Object.keys(file.skills).length,
    plugins: Object.keys(file.plugins).length,
    folders: Object.keys(file.folders).length,
    configs: Object.values(file.configs).filter(v => v !== undefined).length,
  };
}

/** One line of what a recipe holds: `2 agents, 3 CLIs, 20 skills, 1 folder, 2 configs`. */
export function recipeSummary(file: RecipeFile): string {
  const counts = recipeCounts(file);
  const said = RECIPE_KINDS.flatMap(kind => (counts[kind] > 0 ? [plural(counts[kind], KIND_WORDS[kind])] : []));
  return said.length === 0 ? "nothing picked" : said.join(", ");
}

/** A recipe with what this computer has for each of its rows right now, keyed `<kind>/<row>`: a CLI's version, a
 * skill folder's digest at its real path, a config's digest after its cuts, a server's entry digest. A row this
 * computer no longer has reads empty. The hash over this is what a computer that applied the recipe is compared
 * against. */
export interface ResolvedRecipe {
  file: RecipeFile;
  items: Record<string, string>;
}

/** The text a resolved recipe hashes to: every key in order at every depth, so two files that differ only in the
 * order their rows were written resolve to one hash. */
export function recipeCanon(resolved: ResolvedRecipe): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map(k => [k, sorted((v as Record<string, unknown>)[k])]),
    );
  };
  return JSON.stringify(sorted(resolved));
}

/** One recipe as the list and the show answer it: its file, its slug, the line of what it holds and the computers
 * that follow it, by name. */
export const RecipeView = z.object({ name: NAME, slug: NAME, summary: NAME, machines: NAMES, file: RecipeFile });
export type RecipeView = z.infer<typeof RecipeView>;

/** What a recipe can pick from on this computer: every row a computer of the person's can take, Mac-only things
 * left out. A CLI that builds from source names the C toolchain under `needs`. */
export interface RecipeOptions {
  agents: { id: string; name: string; signins: RecipeSignIn[] }[];
  mcp: { name: string; agents: string[] }[];
  clis: { name: string; via: string; version?: string; needs?: string[] }[];
  skills: { name: string; from: string; linked: boolean }[];
  plugins: { name: string }[];
  configs: { id: "git" | "shell" | "github"; label: string }[];
}

/** The refusal a recipe whose name makes no file name gets. */
export const RECIPE_NAME_REFUSAL = "a recipe's name needs a letter or a digit";

/** The refusal a word naming no saved recipe gets, naming the ones there are. */
export const noSuchRecipeRefusal = (word: string, held: readonly string[]): string =>
  held.length === 0 ? `no recipe named ${word}; none is saved yet` : `no recipe named ${word}; you have ${held.join(", ")}`;

/** The refusal the recipes ops get on a runtime the host wired no shelf for. */
export const NO_RECIPES = "this runtime keeps no recipes; the host that serves the app wires them";

/** The refusal a save from this computer, or from a cloud, gets: picks are what a computer of the person's was set
 * up with, and this one is where they are picked from. */
export const recipeFromHereRefusal = (word: string): string => `${word} is not a computer you added; a recipe is saved from one that was set up with picks`;

/** The refusal a save from a computer set up before picks were kept gets. */
export const noPicksRefusal = (name: string): string => `${name} was set up before recipes, so it carries no picks to save; a recipe is written from the app's Add a computer, or from a computer set up with one`;

/** The refusal the recipes ops get on a socket let in on a ticket, which reads nothing of the person's setup. */
export const RECIPES_TICKET_REFUSAL = "a socket let in on a ticket cannot see or change the recipes this host keeps; run wsp recipes on the computer the host runs on";
