// SPDX-License-Identifier: AGPL-3.0-only
// The recipes this host keeps, one TOML file each under the state folder:
// read, written whole, listed, removed and resolved against this computer.
// wsp owns the files, so a save rewrites one and a hand edit is read at the
// next open. The writer refuses anything shaped like a secret: a recipe is
// facts, and a token reaches a box only in the environment of a run there.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CATALOG_AGENTS, MCP_AGENTS } from "@wsp/catalog";
import { DETECTORS, expand, isSecretName, nodeHost, type Manifest } from "@wsp/collect";
import { writeOwn } from "@wsp/own-file";
import { issuesLine, noSuchRecipeRefusal, RECIPE_NAME_REFUSAL, RecipeFile, recipeCanon, recipeSlug, toolRowId, type RecipeOptions, type ResolvedRecipe } from "@wsp/protocol";
import type { RecipeShelf } from "@wsp/runtime";
import { CONFIG_PATHS, configDigest, configTexts, type ConfigFiles } from "./recipe-configs.js";
import { historyCache } from "./recipe-file.js";
import { folderOptions, readRecipeOptions } from "./recipe-options.js";
import { folderFiles } from "./folder-files.js";
import { tokenShaped } from "./token-shapes.js";

/** Where a host keeps its recipes: beside its state file, one file per recipe. */
export const recipesDir = (statePath: string): string => join(dirname(statePath), "recipes");


const usage = (sentence: string): Error => Object.assign(new Error(sentence), { kind: "usage" });

/** Why a recipe may not be written, or nothing: a key whose name says it is a secret, or a value shaped like a
 * token, at any depth, named by where it sits. */
export function recipeSecretRefusal(file: unknown, at = ""): string | undefined {
  if (typeof file === "string") return tokenShaped(file) ? `${at || "the recipe"} holds a value shaped like a token; a recipe names things and never holds a secret` : undefined;
  if (Array.isArray(file)) {
    for (const [i, v] of file.entries()) {
      const said = recipeSecretRefusal(v, `${at}[${i}]`);
      if (said !== undefined) return said;
    }
    return undefined;
  }
  if (file === null || typeof file !== "object") return undefined;
  for (const [key, v] of Object.entries(file)) {
    const where = at === "" ? key : `${at}.${key}`;
    if (isSecretName(key)) return `${where} is named like a secret; a recipe names things and never holds a secret`;
    if (tokenShaped(key)) return `${where} is a name shaped like a token; a recipe names things and never holds a secret`;
    const said = recipeSecretRefusal(v, where);
    if (said !== undefined) return said;
  }
  return undefined;
}

/** The TOML reader, loaded the first time a recipe is read or written: a host that never opens one never holds it. */
const toml = (): Promise<typeof import("smol-toml")> => import("smol-toml");

/** A recipe's text read as a recipe, or the refusal naming the file and the field that does not fit. */
export async function readRecipeText(text: string, path: string): Promise<RecipeFile> {
  const { parse } = await toml();
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new Error(`${path}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`);
  }
  const parsed = RecipeFile.safeParse(data);
  if (!parsed.success) throw new Error(`${path}: ${issuesLine(parsed.error.issues)}`);
  return parsed.data;
}

/** One saved recipe: its slug and what is in it. */
export interface SavedRecipe {
  slug: string;
  file: RecipeFile;
}

/** Every recipe beside the state file, by slug; a file that will not read is passed over, since one bad hand edit
 * must not take the others with it, and is named when asked for by name. */
export async function readRecipes(statePath: string): Promise<SavedRecipe[]> {
  const dir = recipesDir(statePath);
  if (!existsSync(dir)) return [];
  const out: SavedRecipe[] = [];
  for (const name of readdirSync(dir).filter(n => n.endsWith(".toml")).sort()) {
    const file = await readRecipeText(readFileSync(join(dir, name), "utf8"), join(dir, name)).catch(() => undefined);
    if (file !== undefined) out.push({ slug: name.slice(0, -".toml".length), file });
  }
  return out;
}

/** The recipe a word names, by its slug or its name; refused naming the ones there are, and naming the file where
 * the one asked for is there and will not read. */
export async function readRecipe(statePath: string, word: string): Promise<SavedRecipe> {
  const slug = recipeSlug(word);
  const path = join(recipesDir(statePath), `${slug}.toml`);
  if (slug !== "" && existsSync(path)) return { slug, file: await readRecipeText(readFileSync(path, "utf8"), path) };
  const all = await readRecipes(statePath);
  const named = all.find(r => r.file.name === word);
  if (named !== undefined) return named;
  throw Object.assign(new Error(noSuchRecipeRefusal(word, all.map(r => r.file.name))), { kind: "not-found" });
}

/** Writes a recipe whole under the slug of its name, refusing a name that makes no file name and anything shaped
 * like a secret. Comments a person wrote in the file do not survive, since wsp owns it. */
export async function writeRecipe(statePath: string, given: unknown): Promise<SavedRecipe> {
  const refused = recipeSecretRefusal(given);
  if (refused !== undefined) throw usage(refused);
  const parsed = RecipeFile.safeParse(given);
  if (!parsed.success) throw usage(`that recipe does not fit: ${issuesLine(parsed.error.issues)}`);
  const file = parsed.data;
  const slug = recipeSlug(file.name);
  if (slug === "") throw usage(RECIPE_NAME_REFUSAL);
  const { stringify } = await toml();
  writeOwn(dirname(statePath), `recipes/${slug}.toml`, stringify(file));
  return { slug, file };
}

/** Takes a recipe's file away; refused for a word naming none. */
export async function deleteRecipe(statePath: string, word: string): Promise<SavedRecipe> {
  const held = await readRecipe(statePath, word);
  rmSync(join(recipesDir(statePath), `${held.slug}.toml`), { force: true });
  return held;
}

/** What resolving a recipe reads of this computer: its home, and the tools its managers list now. */
export interface RecipeReading {
  home: string;
  tools(): Promise<Manifest["entries"]>;
}

/** The digest of a folder's files at its real path, in order, by the rule everything a recipe ships is read by. */
function folderDigest(dir: string): string {
  const hash = createHash("sha256");
  for (const f of folderFiles(dir).files) hash.update(`${f.rel}\0`).update(readFileSync(f.path)).update("\0");
  return hash.digest("hex");
}

/** The entry one agent's config holds for a server, digested; empty where the file or the entry is not there. */
function serverDigest(home: string, agentId: string, name: string): string {
  const agent = MCP_AGENTS.find(a => a.id === agentId);
  if (agent === undefined) return "";
  for (const file of agent.mcp.files) {
    const path = expand({ home }, file);
    if (!existsSync(path)) continue;
    const entry = agent.mcp.format.entryOf(readFileSync(path, "utf8"), name);
    return entry === undefined ? "" : createHash("sha256").update(entry).digest("hex");
  }
  return "";
}

/** An agent's own files a recipe carries, home-relative: its config paths less what is read as its own row (the
 * skills folders, the MCP config file) and less what it rewrites as it runs, which lands once and is never synced. */
export function agentOwnPaths(id: string): string[] {
  const a = CATALOG_AGENTS.find(entry => entry.id === id);
  if (a === undefined) return [];
  const apart = new Set([...(a.volatile ?? []), ...(a.mcp?.files ?? []), ...a.skillRoots.user.map(r => r.dir)]);
  return a.configPaths.filter(p => !apart.has(p));
}

/** Where on this computer each row a change can reach a computer from is read, by item key, and what it reads as
 * now: a skill at its real path, a config's files after their cuts, an agent's own files, the entry a server has in
 * the file its agent keeps them in. The resolve reads these and the watcher watches them; a CLI's version comes off
 * its manager and has no path. */
export function itemSources(file: RecipeFile, home: string): { key: string; paths: string[]; digest(): string }[] {
  const at = (p: string): string => expand({ home }, p.startsWith("~/") ? p : `~/${p}`);
  const out: { key: string; paths: string[]; digest(): string }[] = [];
  for (const [name, row] of Object.entries(file.skills)) {
    let real: string | undefined;
    try {
      real = realpathSync(join(expand({ home }, row.from), name));
    } catch {
      real = undefined;
    }
    out.push({ key: `skills/${name}`, paths: real === undefined ? [] : [real], digest: () => (real === undefined ? "" : folderDigest(real)) });
  }
  for (const [name, row] of Object.entries(file.mcp)) {
    for (const agent of row.agents) out.push({ key: `mcp/${name}/${agent}`, paths: (MCP_AGENTS.find(a => a.id === agent)?.mcp.files ?? []).map(at), digest: () => serverDigest(home, agent, name) });
  }
  for (const id of ["git", "shell"] as const satisfies readonly ConfigFiles[]) {
    if (file.configs[id] !== undefined) out.push({ key: `configs/${id}`, paths: CONFIG_PATHS[id].map(at), digest: () => configDigest(configTexts(id, home)) });
  }
  for (const id of Object.keys(file.agents)) {
    const paths = agentOwnPaths(id).map(at);
    out.push({ key: `agents/${id}`, paths, digest: () => pathsDigest(paths) });
  }
  return out;
}

/** The digest of what stands at some paths: a folder by the rule everything a recipe ships is read by, a file by its
 * bytes, a path not there by nothing. Empty where none of them is there. */
function pathsDigest(paths: readonly string[]): string {
  const hash = createHash("sha256");
  let any = false;
  for (const path of paths) {
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    any = true;
    hash.update(`${path}\0`).update(st.isDirectory() ? folderDigest(path) : readFileSync(path)).update("\0");
  }
  return any ? hash.digest("hex") : "";
}

/** A recipe with what this computer has for each row now: a CLI's version off its manager, a skill's digest at its
 * real path (a symlinked skill is read where it lives), a config's digest after its cuts, a server's entry digest
 * per agent. A row this computer no longer has reads empty. The managers are asked only when a CLI is picked. */
export async function resolveRecipe(file: RecipeFile, reading: RecipeReading): Promise<ResolvedRecipe> {
  const items: Record<string, string> = {};
  const tools = Object.keys(file.clis).length === 0 ? [] : await reading.tools();
  const versions = new Map(tools.map(e => [e.id, e.version ?? ""]));
  for (const [name, row] of Object.entries(file.clis)) items[`clis/${name}`] = versions.get(toolRowId(row.via, name)) ?? "";
  for (const source of itemSources(file, reading.home)) items[source.key] = source.digest();
  return { file, items };
}

/** The hash a computer that applied a recipe is held against. */
export const recipeHash = (resolved: ResolvedRecipe): string => createHash("sha256").update(recipeCanon(resolved)).digest("hex");

/** The tools rows this computer's managers list now, by the collector's own reader. */
const toolsHere = (): Promise<Manifest["entries"]> => DETECTORS.tools(nodeHost(), []);

/** How long the managers' listing stands before a resolve reads it again: every manager asked is seconds of work,
 * the versions it gives move when the person upgrades, and the watcher reads them again at its own pace. */
export const TOOLS_KEPT_MS = 24 * 60 * 60_000;

/** The managers' listing read once and kept for TOOLS_KEPT_MS, read again at `refresh`. */
export function keptTools(read: () => Promise<Manifest["entries"]> = toolsHere, now: () => number = Date.now): { tools(): Promise<Manifest["entries"]>; refresh(): Promise<Manifest["entries"]> } {
  let held: { at: number; entries: Promise<Manifest["entries"]> } | undefined;
  const refresh = (): Promise<Manifest["entries"]> => {
    const entries = read();
    held = { at: now(), entries };
    entries.catch(() => (held = undefined));
    return entries;
  };
  return { tools: () => (held !== undefined && now() - held.at < TOOLS_KEPT_MS ? held.entries : refresh()), refresh };
}

type Folders = readonly { name: string; path: string }[] | undefined;

/** The options read kept and answered at once, with a fresh read started behind the answer for the next ask: the read
 * walks the collector, every skill folder and every project folder's size, half a minute on a full Mac. A read for
 * other folders, or the first one, is waited on; one already out is shared rather than started twice. */
export function keptOptions(read: (folders: Folders) => Promise<RecipeOptions>): (folders?: Folders) => Promise<RecipeOptions> {
  let held: { key: string; options: RecipeOptions } | undefined;
  let out: { key: string; options: Promise<RecipeOptions> } | undefined;
  const fresh = (key: string, folders: Folders): Promise<RecipeOptions> => {
    // The read starts on the next turn of the loop, so an answer already held goes out before its first sync walk.
    const options = new Promise(start => setImmediate(start)).then(() => read(folders));
    const mine = { key, options };
    out = mine;
    options.then(
      answer => {
        held = { key, options: answer };
      },
      () => undefined,
    ).finally(() => {
      if (out === mine) out = undefined;
    });
    return options;
  };
  return async folders => {
    const key = JSON.stringify(folders ?? []);
    if (held?.key === key) {
      if (out?.key !== key) fresh(key, folders).catch(() => undefined);
      return held.options;
    }
    return out?.key === key ? out.options : fresh(key, folders);
  };
}

/** The host's shelf of recipes, as the runtime serves it: the files beside the state, and the options read off this
 * computer when the modal or a recipe opens. */
export function recipeShelf(o: { statePath: string; home: string; options?: () => Promise<RecipeOptions>; tools?: () => Promise<Manifest["entries"]> }): RecipeShelf {
  const reading: RecipeReading = { home: o.home, tools: o.tools ?? toolsHere };
  return {
    list: () => readRecipes(o.statePath),
    read: word => readRecipe(o.statePath, word),
    get: async word => {
      const held = await readRecipe(o.statePath, word);
      return { ...held, hash: recipeHash(await resolveRecipe(held.file, reading)) };
    },
    save: file => writeRecipe(o.statePath, file),
    remove: word => deleteRecipe(o.statePath, word),
    options: keptOptions(async folders => {
      const read = await (o.options ?? (() => readRecipeOptions(nodeHost(), historyCache(o.statePath))))();
      return folders === undefined || folders.length === 0 ? read : { ...read, folders: await folderOptions(folders) };
    }),
    resolve: async slug => {
      const held = await readRecipe(o.statePath, slug);
      const resolved = await resolveRecipe(held.file, reading);
      return { file: held.file, items: resolved.items, hash: recipeHash(resolved) };
    },
  };
}

