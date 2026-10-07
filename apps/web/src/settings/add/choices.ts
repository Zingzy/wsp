// SPDX-License-Identifier: AGPL-3.0-only
// The picks a person makes for a computer, as a recipe file: everything the
// computer running the host has, nothing, or one saved recipe; and one tick or
// one choice moved on them. The dialog and a recipe's own page both write picks
// through here, so the two cannot spell a pick two ways.
import { RecipeFile, type GitHubSignIn, type ProjectHue, type ProjectIcon, type ProjectView, type RecipeOptions, type RecipeSignIn } from "@wsp/protocol";

/** The kinds of row a step ticks, each a table of the recipe keyed by the row's name. */
export type TickKind = "agents" | "mcp" | "clis" | "skills" | "plugins" | "folders";

/** The name a computer's picks are filed under: its own, which is never read before a recipe is named. */
const fileName = (name: string): string => (name.trim() === "" ? "computer" : name);

/** Nothing ticked, and GitHub signing in on the computer, which is a choice and not a tick. */
export const noPicks = (name: string): RecipeFile => RecipeFile.parse({ name: fileName(name), configs: { github: { signin: "machine" } } });

/** The key a folder goes by in a recipe: the project's own name, lower case, every other run a dash. */
export const folderKey = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "folder";

/** A project of this computer as a recipe's folder row: its folder, its name, and the look it wears here. */
export const folderOf = (project: Pick<ProjectView, "id" | "name" | "path">, look: { icon?: ProjectIcon; hue?: ProjectHue } | undefined): RecipeFile["folders"][string] => ({
  from: project.path,
  name: project.name,
  ...(look?.icon === undefined ? {} : { icon: look.icon }),
  ...(look?.hue === undefined ? {} : { hue: look.hue }),
  keep: [],
});

/** GitHub's row where the host offers it: signing in on the computer where that is one of its ways, else its first. */
const githubOf = (signins: readonly GitHubSignIn[] | undefined): { signin?: GitHubSignIn } => {
  const signin = signins?.includes("machine") === true ? "machine" : signins?.[0];
  return signin === undefined ? {} : { signin };
};

/** Every row the options offer, each agent signing in the first way it can, GitHub signing in on the computer, and every
 * project here. No CLI: each one is a person's pick, made from how often their agents ran it. */
export function everything(name: string, options: RecipeOptions, projects: readonly Pick<ProjectView, "id" | "name" | "path">[], looks: Record<string, { icon?: ProjectIcon; hue?: ProjectHue }>): RecipeFile {
  return RecipeFile.parse({
    name: fileName(name),
    agents: Object.fromEntries(options.agents.map(a => [a.id, a.signins[0] === undefined ? {} : { signin: a.signins[0] }])),
    mcp: Object.fromEntries(options.mcp.map(s => [s.name, { agents: s.agents }])),
    skills: Object.fromEntries(options.skills.map(s => [s.name, { from: s.from }])),
    plugins: Object.fromEntries(options.plugins.map(p => [p.name, {}])),
    folders: Object.fromEntries(projects.map(p => [folderKey(p.name), folderOf(p, looks[p.id])])),
    configs: Object.fromEntries(options.configs.map(c => [c.id, c.id === "github" ? githubOf(c.signins) : {}])),
  });
}

/** A saved recipe as the picks for this computer: its rows as the host hands them out, wsp's own pieces left out
 * there, and every choice it saved, GitHub's included. */
export const fromRecipe = (file: RecipeFile, name: string): RecipeFile => ({ ...file, name });

/** One row ticked or not: ticked takes the row the options give for it, unticked takes it out. */
export function tick(picks: RecipeFile, kind: Exclude<TickKind, "folders">, name: string, on: boolean, options: RecipeOptions): RecipeFile {
  const table = { ...picks[kind] } as Record<string, unknown>;
  if (!on) delete table[name];
  else if (kind === "agents") {
    const signin = options.agents.find(a => a.id === name)?.signins[0];
    table[name] = signin === undefined ? {} : { signin };
  } else if (kind === "mcp") table[name] = { agents: options.mcp.find(s => s.name === name)?.agents ?? [] };
  else if (kind === "clis") {
    const cli = options.clis.find(c => c.name === name);
    table[name] = { via: cli?.via ?? "apt", ...(cli?.needs === undefined ? {} : { needs: cli.needs }) };
  } else if (kind === "skills") table[name] = { from: options.skills.find(s => s.name === name)?.from ?? "" };
  else table[name] = {};
  return { ...picks, [kind]: table };
}

/** Several rows ticked or not at once, each as one tick would move it. */
export const tickMany = (picks: RecipeFile, kind: Exclude<TickKind, "folders">, changes: readonly (readonly [string, boolean])[], options: RecipeOptions): RecipeFile =>
  changes.reduce((next, [name, on]) => tick(next, kind, name, on, options), picks);

/** Every CLI the agents ran at least once ticked, on top of what the picks hold. */
export const tickUsedClis = (picks: RecipeFile, options: RecipeOptions): RecipeFile =>
  tickMany(
    picks,
    "clis",
    options.clis.filter(cli => (cli.calls ?? 0) > 0).map(cli => [cli.name, true] as const),
    options,
  );

/** A folder ticked with its row, or taken out. */
export function tickFolder(picks: RecipeFile, key: string, row: RecipeFile["folders"][string] | undefined): RecipeFile {
  const folders = { ...picks.folders };
  if (row === undefined) delete folders[key];
  else folders[key] = row;
  return { ...picks, folders };
}

/** The picks with every sign-in moved onto one the options offer, the way a row ticked now would sign in: a saved
 * recipe may name a way this computer cannot serve, such as a sign-in to copy that it does not hold. Picks that need
 * no move come back as they were. */
export function servable(picks: RecipeFile, options: RecipeOptions): RecipeFile {
  let next = picks;
  for (const [agent, row] of Object.entries(picks.agents)) {
    const offered = options.agents.find(a => a.id === agent)?.signins;
    if (offered === undefined || row.signin === undefined || offered.includes(row.signin)) continue;
    next = { ...next, agents: { ...next.agents, [agent]: offered[0] === undefined ? {} : { signin: offered[0] } } };
  }
  const github = options.configs.find(c => c.id === "github")?.signins;
  if (picks.configs.github !== undefined && github !== undefined && !github.includes(githubPick(picks)) && github[0] !== undefined) next = setGitHub(next, github[0]);
  return next;
}

/** How one agent signs in. */
export const signIn = (picks: RecipeFile, agent: string, signin: RecipeSignIn): RecipeFile => ({ ...picks, agents: { ...picks.agents, [agent]: { signin } } });

/** The GitHub choice: the token, signing in there, or skipped. A skip is kept as one: picks with no GitHub row clone
 * with whatever the vault holds. */
export const githubPick = (picks: RecipeFile): GitHubSignIn => (picks.configs.github === undefined ? "skip" : (picks.configs.github.signin ?? "vault"));
export const setGitHub = (picks: RecipeFile, pick: GitHubSignIn): RecipeFile => ({ ...picks, configs: { ...picks.configs, github: { signin: pick } } });

/** Git or the shell ticked or not. */
export function tickConfig(picks: RecipeFile, id: "git" | "shell", on: boolean): RecipeFile {
  const { [id]: _gone, ...rest } = picks.configs;
  return { ...picks, configs: on ? { ...rest, [id]: {} } : rest };
}
