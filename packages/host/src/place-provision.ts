// SPDX-License-Identifier: AGPL-3.0-only
// What goes on a computer somebody owns, planned on this one. A computer's
// picks name the agents, servers, CLIs, skills, plugins and configs it takes;
// the rows are read off this computer as it is now, the agents' and the
// servers' by the same roads a copy of the image reads them, every sign-in
// left to the vault and no Keychain read at all. The skills and the configs
// are this computer's files, packed here with their cuts made and landed there
// through the list beside the job. What runs the plan is the engine's.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Manifest, ManifestEntry, Platform } from "@wsp/collect";
import { expand } from "@wsp/collect";
import { CATALOG_AGENTS, COMPILER_ROW, SHARED_SKILLS, TOOL_PREFIX, catalogIdOfRow, ownSkillFolder } from "@wsp/catalog";
import {
  agentStateFile,
  newSetupRun,
  parseMcpId,
  provisionPlanOf,
  provisionStep,
  tarOf,
  viaRoad,
  type BrewTable,
  type PackFiles,
  type ProvisionLanding,
  type ProvisionPlan,
  type TarEntry,
} from "@wsp/engine";
import { agentOfRow, probePath, toolRowId, type Recipe, type RecipeFile } from "@wsp/protocol";
import type { PlaceProvisioner } from "@wsp/runtime";
import { serverVault } from "./env-keys.js";
import { brewTableFor, copyRows, planImport } from "./image-recipe.js";
import { configTexts, type ConfigText } from "./recipe-configs.js";
import { loadRecipe, smallRecipePath } from "./recipe-file.js";

/** What the planner reads beside the picks: this computer's rungs and its Homebrew table, the same two readers wsp
 * init and a copy's build take. */
export interface ProvisionReaders {
  statePath: string;
  home: string;
  platform: Platform;
  collect(): Promise<Manifest>;
  brew(): Promise<BrewTable>;
}

/** The one PATH every script of the job exports on that computer, and the folder every manager installs under there:
 * its own system directories and wsp's own folder under /opt, with every directory under the home it shares with the
 * workspaces on it left out, since a process inside one of them writes there and the job runs as root outside them. */
const placePaths = (home: string): { path: string; prefix: string } => ({ path: probePath(home), prefix: TOOL_PREFIX });

/** The small recipe the picks come to, for the roads that read one: the agents and the CLIs ticked, nothing else. */
function smallOf(picks: RecipeFile): Recipe {
  const source = { kind: "installed" as const, paths: [], bin: true };
  return {
    version: 1,
    at: new Date().toISOString(),
    histories: [],
    rows: [
      ...Object.keys(picks.agents).map(id => ({ id, kind: "agent" as const, on: true, source })),
      ...Object.entries(picks.clis).map(([name, row]) => {
        const id = toolRowId(row.via, name);
        return { id: catalogIdOfRow({ id }) ?? id, kind: "tool" as const, on: true, source };
      }),
    ],
  };
}

/** The folders an agent's row on this computer carries that the picks name one by one or never send: its skills
 * folders, which travel skill by skill, and its plugins' folder, which never travels. */
function pickedApart(agentId: string): string[] {
  const a = CATALOG_AGENTS.find(entry => entry.id === agentId);
  if (a === undefined) return [];
  return [...a.skillRoots.user.map(r => r.dir), ...(a.pluginSkills === undefined ? [] : [posix.dirname(a.pluginSkills.index)])];
}

const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** This computer's rows with exactly the picks ticked: an agent with its own files less the folders picked apart, a
 * server for each agent it is picked for, a CLI by the manager it came from or the catalog's row for it. */
export function picksRows(manifest: Manifest, picks: RecipeFile, o: { home: string; brew: BrewTable }): ManifestEntry[] {
  const rows = copyRows(manifest, { recipe: smallOf(picks), pins: [] }, o);
  const tools = new Set(Object.entries(picks.clis).map(([name, row]) => toolRowId(row.via, name)));
  const catalog = new Set([...tools].flatMap(id => catalogIdOfRow({ id }) ?? []));
  return rows.map(e => {
    const agent = agentOfRow(e);
    if (agent !== undefined) {
      const apart = pickedApart(agent);
      return { ...e, bring: picks.agents[agent] !== undefined, paths: e.paths.filter(p => !apart.some(dir => under(p, dir))) };
    }
    const server = parseMcpId(e.id);
    if (server !== undefined) return { ...e, bring: picks.mcp[server.name]?.agents.includes(server.agent) === true };
    if (e.rung === "tools") return { ...e, bring: tools.has(e.id) || catalog.has(catalogIdOfRow(e) ?? "") };
    return { ...e, bring: false };
  });
}

/** Every file under a folder at its real path, folder-relative, in order; a link inside it is read where it points
 * when that is a file, and a checkout's own .git never travels. */
function filesIn(dir: string, rel = ""): { rel: string; path: string }[] {
  return readdirSync(join(dir, rel))
    .filter(name => name !== ".git")
    .sort()
    .flatMap(name => {
      const at = rel === "" ? name : `${rel}/${name}`;
      const st = statSync(join(dir, at), { throwIfNoEntry: false });
      if (st === undefined) return [];
      return st.isDirectory() ? filesIn(dir, at) : st.isFile() ? [{ rel: at, path: join(dir, at) }] : [];
    });
}

/** An archive of files read here: each staged with its digest, those the computer already has at the same bytes
 * left out when the road asks, the rest packed. */
export function packOf(files: () => readonly { dest: string; bytes: Buffer; mode: number }[]): PackFiles {
  return async leaveOut => {
    const staged = files().map(f => ({ ...f, digest: createHash("sha256").update(f.bytes).digest("hex") }));
    const stood = new Set(leaveOut === undefined ? [] : await leaveOut(staged.map(f => ({ dest: f.dest, digest: f.digest }))));
    const entries: TarEntry[] = staged.filter(f => !stood.has(f.dest)).map(f => ({ path: f.dest, mode: f.mode, content: f.bytes }));
    const tar = tarOf(entries);
    return {
      tar,
      bytes: tar.length,
      unpacked: entries.reduce((n, e) => n + ("content" in e ? e.content.length : 0), 0),
      skipped: [],
      cut: [],
      silenced: [],
      macPaths: [],
      files: entries.length,
      stood: [...stood],
    };
  };
}

/** Where a skill lands for the picked agents: each agent's own skills folder, or the shared one for an agent that
 * reads it, once each; the shared one alone when no agent is picked. */
function skillRootsFor(picks: RecipeFile): string[] {
  const agents = CATALOG_AGENTS.filter(a => picks.agents[a.id] !== undefined);
  const roots = agents.map(a => ownSkillFolder(a, false)?.dir ?? SHARED_SKILLS);
  return [...new Set(roots.length === 0 ? [SHARED_SKILLS] : roots)].map(dir => dir.slice(2));
}

/** The picked skills, each read at its real path here, so a skill this computer keeps as a link travels as the files
 * it points at. A skill that is no longer here is set aside with that reason, and so is a name that is not one
 * folder or a folder with no SKILL.md in it: only a skill leaves this computer by this road. */
function skillsOf(picks: RecipeFile, home: string): { plan?: { lands: ProvisionLanding[]; pack: PackFiles }; skipped: { id: string; label: string; note: string }[] } {
  const roots = skillRootsFor(picks);
  const found: { name: string; dir: string }[] = [];
  const skipped: { id: string; label: string; note: string }[] = [];
  for (const [name, row] of Object.entries(picks.skills)) {
    const at = join(expand({ home }, row.from), name);
    if (name.includes("/") || name === "." || name === ".." || !existsSync(join(at, "SKILL.md"))) {
      skipped.push({ id: `skills/${name}`, label: name, note: `no skill at ${row.from}/${name} on this computer` });
      continue;
    }
    found.push({ name, dir: realpathSync(at) });
  }
  if (found.length === 0) return { skipped };
  const lands = found.flatMap(s => roots.map(root => ({ id: `skills/${s.name}`, label: s.name, dest: `${root}/${s.name}` })));
  const pack = packOf(() => found.flatMap(s => filesIn(s.dir).flatMap(f => roots.map(root => ({ dest: `${root}/${s.name}/${f.rel}`, bytes: readFileSync(f.path), mode: statSync(f.path).mode & 0o777 })))));
  return { plan: { lands, pack }, skipped };
}

const CONFIG_LABELS = { git: "git config", shell: "shell config" } as const;

/** The picked configs as the files that land: the git files with what never travels cut, the shell's with every
 * exported secret cut, each at its own path under the home there. */
function configsOf(picks: RecipeFile, home: string): { lands: ProvisionLanding[]; pack: PackFiles } | undefined {
  const texts: (ConfigText & { id: "git" | "shell" })[] = (["git", "shell"] as const).flatMap(id => (picks.configs[id] === undefined ? [] : configTexts(id, home).map(t => ({ ...t, id }))));
  if (texts.length === 0) return undefined;
  return {
    lands: texts.map(t => ({ id: `configs/${t.id}`, label: CONFIG_LABELS[t.id], dest: t.rel })),
    pack: packOf(() => texts.map(t => ({ dest: t.rel, bytes: Buffer.from(t.text), mode: 0o644 }))),
  };
}

/** The login shell's own package where the shell row is picked and this computer logs into zsh or fish: the files
 * that travel are that shell's, and root's passwd shell stays bash. */
function shellPackage(picks: RecipeFile, manifest: Manifest, path: string, prefix: string): ProvisionPlan["configTools"] {
  if (picks.configs.shell === undefined) return undefined;
  const login = manifest.entries.find(e => e.rung === "shell" && e.login !== undefined)?.login;
  if (login !== "zsh" && login !== "fish") return undefined;
  const step = viaRoad({ road: "apt", packages: [login] }, login, path, prefix);
  return "cmd" in step ? [{ id: `configs/shell/${login}`, label: login, manager: "apt", ...step, bin: login }] : undefined;
}

/** The picked plugins as the lines that put each on, by the agent's own commands there, each from the marketplace
 * this computer's index names for it. One whose marketplace this computer cannot name is set aside. */
function pluginsOf(picks: RecipeFile, home: string): { plugins: { id: string; label: string; cmd: string }[]; skipped: { id: string; label: string; note: string }[] } {
  const road = CATALOG_AGENTS.find(a => a.plugins !== undefined && picks.agents[a.id] !== undefined)?.plugins;
  const plugins: { id: string; label: string; cmd: string }[] = [];
  const skipped: { id: string; label: string; note: string }[] = [];
  const index = road === undefined || !existsSync(expand({ home }, road.marketplaces)) ? undefined : readFileSync(expand({ home }, road.marketplaces), "utf8");
  for (const name of Object.keys(picks.plugins)) {
    const marketplace = name.split("@")[1];
    const source = road === undefined || index === undefined || marketplace === undefined ? undefined : road.sourceOf(index, marketplace);
    if (road === undefined || source === undefined) skipped.push({ id: `plugins/${name}`, label: name, note: road === undefined ? "no picked agent takes plugins" : "this computer names no marketplace for it" });
    else plugins.push({ id: `plugins/${name}`, label: name, cmd: road.install(name, source) });
  }
  return { plugins, skipped };
}

/** The host's side of the setup job: the plan off a computer's picks, the floor alone for a computer that joined
 * before anything was picked, and each step the engine runs on the computer itself. `plan` is the recipe beside the
 * state, which the doctor's road reads for a computer set up before picks were kept. */
export function placeProvisioner(o: ProvisionReaders): PlaceProvisioner {
  return {
    async plan(on) {
      const recipePath = smallRecipePath(o.statePath);
      if (!existsSync(recipePath)) return { noRecipe: recipePath };
      const recipe = loadRecipe(recipePath);
      const manifest = await o.collect();
      const brew = await brewTableFor(manifest, o.brew);
      const rows = copyRows(manifest, { recipe, pins: [] }, { home: o.home, brew });
      const { path, prefix } = placePaths(on.home);
      const imp = planImport(
        rows.filter(e => e.bring === true),
        { rows, small: recipe, home: o.home, platform: o.platform, brew, secrets: new Map(), vault: serverVault(o.statePath), keepFile: agentStateFile, path, prefix },
      );
      return provisionPlanOf(imp, recipe.at, path, prefix);
    },
    async setup(picks, on) {
      const manifest = await o.collect();
      const brew = await brewTableFor(manifest, o.brew);
      const rows = picksRows(manifest, picks, { home: o.home, brew });
      const { path, prefix } = placePaths(on.home);
      const imp = planImport(
        rows.filter(e => e.bring === true),
        // The files that travel with an agent are its own: its settings, its standing instructions and its configs.
        // A dotfile, a login's store and a shell's rc go only as the configs the person picked.
        { rows, small: smallOf(picks), home: o.home, platform: o.platform, brew, secrets: new Map(), vault: serverVault(o.statePath), keepFile: agentStateFile, path, prefix },
      );
      const skills = skillsOf(picks, o.home);
      const configs = configsOf(picks, o.home);
      const configTools = shellPackage(picks, manifest, path, prefix);
      const plugins = pluginsOf(picks, o.home);
      const plan = provisionPlanOf(imp, picks.name, path, prefix, {
        compiler: Object.values(picks.clis).some(row => row.needs?.includes(COMPILER_ROW) === true),
        ...(skills.plan !== undefined ? { skills: skills.plan } : {}),
        ...(configs !== undefined ? { configs } : {}),
        ...(configTools !== undefined ? { configTools } : {}),
        ...(plugins.plugins.length > 0 ? { plugins: plugins.plugins } : {}),
      });
      return { ...plan, skipped: [...plan.skipped, ...skills.skipped, ...plugins.skipped] };
    },
    floor: (machine, on, stage) => provisionStep(machine, { ...placePaths(on.home), recipeAt: "floor", steps: [], agents: 0, compiler: false, skipped: [] }, "floor", newSetupRun(), stage, on),
    step: (machine, plan, step, run, stage, on) => provisionStep(machine, plan, step, run, stage, on),
  };
}

