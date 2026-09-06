// SPDX-License-Identifier: AGPL-3.0-only
// wsp recipe: the small recipe from this computer, written to a file and
// printed as one table, with the rule that decided the ticks named on the
// command line and single rows flipped by id. Names and counts only; the
// histories are read here and nothing of them leaves.
import { existsSync } from "node:fs";
import { agentName, catalogEntry, keysIdOf, loginRow } from "@wsp/catalog";
import { type AgentHistory, type Host, computeRecipe, unknownCommands } from "@wsp/collect";
import { RECIPE_SIGN_INS, RECIPE_TICKS, type Recipe, type RecipeHistory, type RecipeSignIn, type RecipeTick } from "@wsp/protocol";
import { THREAD_AGENTS } from "./thread-agents.js";
import { loadRecipe, saveSmallRecipe } from "./recipe-file.js";
import { recipeScan, recipeTable, type RecipeScan, type RecipeTable } from "./recipe-table.js";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line per agent: what its history here said. */
export function historyLine(h: RecipeHistory): string {
  const name = agentName(h.agent);
  switch (h.state) {
    case "read":
      return `${name}: ${plural(h.sessions, "session")}, ${plural(h.calls, "tool call")}`;
    case "empty":
      return `${name}: no history here`;
    case "unreadable":
      return `${name}: history is here but could not be read`;
    case "no-reader":
      return `${name}: no reader for its history yet`;
    default: {
      const _exhaustive: never = h.state;
      return _exhaustive;
    }
  }
}

/** What a `--set` word says: the catalog row and the tick it is to have. */
export function parseSet(word: string): { id: string; on: boolean } {
  const eq = word.indexOf("=");
  const id = eq < 0 ? word : word.slice(0, eq);
  const value = eq < 0 ? "" : word.slice(eq + 1);
  if (value !== "on" && value !== "off") throw new Error(`--set takes <id>=on or <id>=off, not ${JSON.stringify(word)}`);
  if (catalogEntry(id) === undefined) throw new Error(`--set ${word}: the catalog has no row called ${JSON.stringify(id)}`);
  return { id, on: value === "on" };
}

/** The ticks the `--set` words ask for, later words winning over earlier ones. */
export function parseSets(words: readonly string[]): Map<string, boolean> {
  return new Map(words.map(parseSet).map(({ id, on }) => [id, on]));
}

/** The recipe with the asked-for rows flipped; every other row keeps the rule's tick. */
export function applySets(recipe: Recipe, sets: ReadonlyMap<string, boolean>): Recipe {
  if (sets.size === 0) return recipe;
  return { ...recipe, rows: recipe.rows.map(r => (sets.has(r.id) ? { ...r, on: sets.get(r.id) === true } : r)) };
}

export function isRecipeTick(word: string): word is RecipeTick {
  return (RECIPE_TICKS as readonly string[]).includes(word);
}

/** The catalog row and the word a `--signin` says of it; `key` needs the entry to have key files beside its login,
 * since that is the row the answer lands on. */
export function parseSignIn(word: string): { id: string; choice: RecipeSignIn } {
  const eq = word.indexOf("=");
  const id = eq < 0 ? word : word.slice(0, eq);
  const choice = eq < 0 ? "" : word.slice(eq + 1);
  if (!(RECIPE_SIGN_INS as readonly string[]).includes(choice)) throw new Error(`--signin takes <id>=${RECIPE_SIGN_INS.join("|")}, not ${JSON.stringify(word)}`);
  if (catalogEntry(id) === undefined) throw new Error(`--signin ${word}: the catalog has no row called ${JSON.stringify(id)}`);
  if (choice === "key" && loginRow(keysIdOf(id)) === undefined) throw new Error(`--signin ${word}: ${agentName(id)} has no key files beside its login; copy or machine are its words`);
  return { id, choice: choice as RecipeSignIn };
}

/** The sign-in answers the `--signin` words ask for, later words winning over earlier ones. */
export function parseSignIns(words: readonly string[]): Map<string, RecipeSignIn> {
  return new Map(words.map(parseSignIn).map(({ id, choice }) => [id, choice]));
}

/** The recipe with the asked-for sign-in answers written on; every other row keeps the answer it had. */
export function applySignIns(recipe: Recipe, answers: ReadonlyMap<string, RecipeSignIn>): Recipe {
  if (answers.size === 0) return recipe;
  return { ...recipe, rows: recipe.rows.map(r => (answers.has(r.id) ? { ...r, signIn: answers.get(r.id)! } : r)) };
}

/** Why an `--add` cannot be answered yet: the install line comes from a scan row, and nothing here scans for tools
 * outside the catalog. A catalog id is a `--set`, and says so rather than reading as unknown. */
export function noAddLine(id: string): never {
  if (catalogEntry(id) !== undefined) throw new Error(`--add ${id}: ${agentName(id)} is a catalog row; wsp recipe --set ${id}=on ticks it`);
  throw new Error(`--add ${id}: no scan row for ${JSON.stringify(id)}; nothing here scans for tools outside the catalog yet`);
}

export interface RecipeInput {
  /** Where the recipe file lives; it is read for the ticks a `set` adds to, and rewritten. */
  out: string;
  /** Which rule decides every tick; the file's own rule, else `used`. */
  tick?: RecipeTick;
  /** `<id>=on` or `<id>=off`, repeatable: applied over the rule, on top of the ticks already in the file. */
  set?: readonly string[];
  /** `<id>=copy|machine|key|skip`, repeatable: what happens to that row's sign-in. */
  signin?: readonly string[];
  /** Catalog ids to add from a scan row's install line; none can be answered until something scans for them. */
  add?: readonly string[];
  /** Folders to weigh the histories against, absolute: only sessions that ran in one of them count. */
  projects?: readonly string[];
}

export interface RecipeIo {
  /** The table and the file's path: what a caller reads as the answer. */
  log(line: string): void;
  /** Progress while this computer is read; never part of the answer. */
  note(line: string): void;
}

const QUIET: RecipeIo = { log: () => {}, note: () => {} };

/** This computer's recipe with the answers the file already carries written back on, row by row: a row the file
 * names keeps the tick and the sign-in answer it was left with, and a row it does not name (the catalog grew since
 * it was written) keeps the rule's own. Unlike the wizard's rule, the file is not the authority on rows it lacks. */
export function withSavedAnswers(computed: Recipe, saved: Recipe): Recipe {
  const rows = new Map(saved.rows.map(r => [r.id, r]));
  return {
    ...computed,
    rows: computed.rows.map(r => {
      const was = rows.get(r.id);
      if (was === undefined) return r;
      return { ...r, on: was.on, ...(was.signIn === undefined ? {} : { signIn: was.signIn }) };
    }),
  };
}

/** Whether the run named something the rule reads, so the rule decides every row again rather than the file standing. */
const namesRule = (input: RecipeInput): boolean => input.tick !== undefined || (input.projects ?? []).length > 0;

/** What the scan reads; it writes nothing, so it names no file. */
export interface ScanInput {
  /** Folders to weigh the histories by, absolute. */
  projects?: readonly string[];
}

/** Reads this computer once and answers with every option it offers and what to do about each. Nothing is written,
 * so a caller can run it before the person has decided anything. The rule is `used`: the recommendation is what
 * the person's own agents reach for, and every other row is there to be turned on knowingly. */
export async function runScan(host: Host, input: ScanInput = {}, io: RecipeIo = QUIET, now?: () => Date): Promise<RecipeScan> {
  io.note("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const histories: AgentHistory[] = [];
  const recipe = await computeRecipe(host, {
    tick: "used",
    threadAgents: THREAD_AGENTS,
    ...(input.projects !== undefined && input.projects.length > 0 ? { folders: input.projects } : {}),
    ...(now !== undefined ? { now } : {}),
    onHistory: h => {
      histories.push(h);
      io.note(historyLine(h));
    },
  });
  return recipeScan(recipe, unknownCommands(histories));
}

/** Reads this computer, writes the recipe and answers with the table. The file is the state: a run that names a rule
 * input (`tick` or `projects`) lets the rule decide every row again, and any other run keeps what the file already
 * says and puts this run's flips on top. A row the file never carried always takes the rule's answer. */
export async function runRecipe(host: Host, input: RecipeInput, io: RecipeIo = QUIET, now?: () => Date): Promise<RecipeTable> {
  const sets = parseSets(input.set ?? []);
  const signIns = parseSignIns(input.signin ?? []);
  const saved = existsSync(input.out) ? loadRecipe(input.out) : undefined;
  const tick = input.tick ?? saved?.tick ?? "used";
  io.note("Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.");
  const histories: AgentHistory[] = [];
  const computed = await computeRecipe(host, {
    tick,
    threadAgents: THREAD_AGENTS,
    ...(input.projects !== undefined && input.projects.length > 0 ? { folders: input.projects } : {}),
    ...(now !== undefined ? { now } : {}),
    onHistory: h => {
      histories.push(h);
      io.note(historyLine(h));
    },
  });
  for (const id of input.add ?? []) noAddLine(id);
  const base = saved !== undefined && !namesRule(input) ? withSavedAnswers(computed, saved) : computed;
  const recipe = applySignIns(applySets(base, sets), signIns);
  saveSmallRecipe(input.out, recipe);
  return recipeTable(recipe, input.out, unknownCommands(histories));
}
