// SPDX-License-Identifier: AGPL-3.0-only
// What a new thread starts from when its start names nothing: the agent, its
// model, effort and access, each answered with where it came from. The layers,
// highest first: what the start names, the project's override, the person's
// default for that agent (the default agent for the agent itself), the
// catalog's own mark. The host's start, the lists harnesses.list hands the
// composer, the command line and the app all read this one rule. Beside it,
// how each agent is set up to run on one computer, which carries the names of
// its environment variables and never a value.
import { z } from "zod";
import { effortsFor, everyModel, markedDefault, modelOf } from "./harness-picks.js";
import type { HarnessCatalog, HarnessModel, HarnessOption, Preferences } from "./index.js";

/** wsp's own words for how far a thread may go without asking, one vocabulary for every agent: each harness's catalog
 * row says which of its own modes each word is, and a word a row does not map is one that agent cannot take. */
export const ACCESS_CHOICES = ["ask", "auto-edit", "full", "plan"] as const;
export const AccessChoice = z.enum(ACCESS_CHOICES);
export type AccessChoice = z.infer<typeof AccessChoice>;

/** How one agent's models are listed in the model picker: models taken off it, the order the person dragged some
 * into, and ids the binary does not list that the person runs anyway. A start still takes a hidden model by name. */
export const ModelPicker = z.object({ hide: z.array(z.string()).optional(), order: z.array(z.string()).optional(), custom: z.array(z.string()).optional() }).strict();
export type ModelPicker = z.infer<typeof ModelPicker>;

/** The person's defaults for one agent, the same on every computer. */
export const AgentDefaults = z.object({ model: z.string().optional(), effort: z.string().optional(), access: AccessChoice.optional(), models: ModelPicker.optional() }).strict();
export type AgentDefaults = z.infer<typeof AgentDefaults>;
export const AgentDefaultsPatch = z.object({ model: z.string().nullable().optional(), effort: z.string().nullable().optional(), access: AccessChoice.nullable().optional(), models: ModelPicker.nullable().optional() }).strict();
export type AgentDefaultsPatch = z.infer<typeof AgentDefaultsPatch>;

/** What one project overrides for the threads opened on it. Strict and short on purpose: anything that is about a
 * computer (threads at once, the program, its folder, arguments, environment, on or off) stays the computer's, and a
 * field added here is a change to this shape. */
export const ProjectOverrides = z.object({ agent: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), access: AccessChoice.optional() }).strict();
export type ProjectOverrides = z.infer<typeof ProjectOverrides>;
export const ProjectOverridesPatch = z.object({ agent: z.string().nullable().optional(), model: z.string().nullable().optional(), effort: z.string().nullable().optional(), access: AccessChoice.nullable().optional() }).strict();
export type ProjectOverridesPatch = z.infer<typeof ProjectOverridesPatch>;

/** A record with a patch's fields over it: null takes a field away, absent keeps it. Nothing when no field is left,
 * so a record emptied field by field leaves no empty object behind. */
export function patchedFields<T extends object>(kept: T | undefined, patch: { [K in keyof T]?: T[K] | null }): T | undefined {
  const next: Record<string, unknown> = { ...kept };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return Object.keys(next).length === 0 ? undefined : (next as T);
}

/** A variable's name as a shell exports it. */
export const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a variable's name is letters, digits and _, not starting with a digit");

/** How one agent runs on one computer, as every reader sees it: whether it is offered there, the program run in its
 * place, the folder it keeps its config and sessions in, words added to every launch, and the names of the variables
 * every launch carries. A value is never in it. */
export const AgentSetupView = z.object({ on: z.boolean(), program: z.string().optional(), configDir: z.string().optional(), args: z.array(z.string()).optional(), envNames: z.array(z.string()) }).strict();
export type AgentSetupView = z.infer<typeof AgentSetupView>;

/** What agents.setup changes: a field left out keeps what stands, null puts it back on the agent's own, and env names
 * the variables it moves, a null value taking one away. A value crosses only from a socket holding the host's own
 * token. */
export const AgentSetupSet = z
  .object({
    on: z.boolean().optional(),
    program: z.string().min(1).nullable().optional(),
    configDir: z.string().min(1).nullable().optional(),
    args: z.array(z.string()).nullable().optional(),
    env: z.record(EnvName, z.string().nullable()).optional(),
  })
  .strict();
export type AgentSetupSet = z.infer<typeof AgentSetupSet>;

/** The setup as stored: the view's fields with the values the view leaves out. */
export interface AgentSetup {
  on?: false;
  program?: string;
  configDir?: string;
  args?: string[];
  env?: Record<string, string>;
}

/** The view of a stored setup: the names of its variables, sorted, and never one value. */
export function setupView(setup: AgentSetup | undefined): AgentSetupView {
  return {
    on: setup?.on !== false,
    ...(setup?.program !== undefined ? { program: setup.program } : {}),
    ...(setup?.configDir !== undefined ? { configDir: setup.configDir } : {}),
    ...(setup?.args !== undefined ? { args: [...setup.args] } : {}),
    envNames: Object.keys(setup?.env ?? {}).sort(),
  };
}

/** A stored setup with a change over it; nothing where every field is back on the agent's own. */
export function setupPatched(kept: AgentSetup | undefined, set: AgentSetupSet): AgentSetup | undefined {
  const env = { ...kept?.env };
  for (const [name, value] of Object.entries(set.env ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  const on = set.on === undefined ? kept?.on : set.on ? undefined : false;
  const pick = <K extends "program" | "configDir" | "args">(key: K): AgentSetup[K] => (set[key] === undefined ? kept?.[key] : (set[key] ?? undefined)) as AgentSetup[K];
  const next: AgentSetup = {
    ...(on === false ? { on } : {}),
    ...(pick("program") !== undefined ? { program: pick("program")! } : {}),
    ...(pick("configDir") !== undefined ? { configDir: pick("configDir")! } : {}),
    ...(pick("args") !== undefined ? { args: [...pick("args")!] } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Where one resolved value came from: named on the start, the project's override, the person's default (the default
 * agent, or that agent's own defaults), or the catalog's own mark. */
export const DefaultFrom = z.enum(["named", "project", "default", "catalog"]);
export type DefaultFrom = z.infer<typeof DefaultFrom>;
export const ResolvedPick = z.object({ value: z.string(), from: DefaultFrom });
export type ResolvedPick = z.infer<typeof ResolvedPick>;
/** The access resolved: wsp's word and the harness's own mode it stands for. */
export const ResolvedAccess = z.object({ value: AccessChoice, mode: z.string(), from: DefaultFrom });
export type ResolvedAccess = z.infer<typeof ResolvedAccess>;
/** What a new thread starts on, each value with where it came from; a value the agent's catalog marks none of is
 * absent, and the CLI's own runs. */
export const ThreadDefaults = z.object({ agent: ResolvedPick, model: ResolvedPick.optional(), effort: ResolvedPick.optional(), access: ResolvedAccess.optional() });
export type ThreadDefaults = z.infer<typeof ThreadDefaults>;

export interface DefaultsAsk {
  /** The agent a thread runs when nothing names one and no default stands. */
  firstAgent: string;
  /** Each agent's lists, its custom models in; nothing for an agent with no catalog row. */
  catalogOf: (agent: string) => HarnessCatalog | undefined;
  /** Whether an agent can run a thread here, which a layer naming one that cannot drops past; absent, the ones with
   * lists. */
  runs?: (agent: string) => boolean;
  /** The agent the start names, or the one the thread already runs on. */
  named?: string;
  project?: ProjectOverrides;
  prefs: Pick<Preferences, "defaultAgent" | "agentDefaults">;
}

/** The harness's own mode a wsp word stands for, where its row maps the word to a mode it lists. */
export function accessMode(catalog: Pick<HarnessCatalog, "access" | "permissionModes">, word: AccessChoice): string | undefined {
  const mode = catalog.access?.[word];
  return mode !== undefined && catalog.permissionModes.some(o => o.value === mode) ? mode : undefined;
}

/** The wsp word for one of a harness's own modes, where its row maps one to it. */
export function accessWord(catalog: Pick<HarnessCatalog, "access">, mode: string): AccessChoice | undefined {
  return ACCESS_CHOICES.find(word => catalog.access?.[word] === mode);
}

/** Whether a value kept for later applies to a list: listed there, or the list is open (the CLI takes any value) and
 * the value was kept for this very agent. A value that does not apply drops to the next layer, never refuses a start. */
const applies = (list: { options: readonly HarnessOption[]; open: boolean }, value: string | undefined, forThisAgent: boolean): value is string =>
  value !== undefined && (list.open ? forThisAgent : list.options.some(o => o.value === value));

/**
 * The agent, model, effort and access a new thread starts on, each with where it came from. A layer that names what
 * the agent here does not take (another agent's model kept on the project, a word the row maps to no mode) drops to
 * the next one, so a stale override never refuses a start; startPicks refuses only what a start names.
 */
export function resolveThreadDefaults(ask: DefaultsAsk): ThreadDefaults {
  const runs = (id: string | undefined): id is string => id !== undefined && (ask.runs?.(id) ?? ask.catalogOf(id) !== undefined);
  const agent: ResolvedPick =
    ask.named !== undefined
      ? { value: ask.named, from: "named" }
      : runs(ask.project?.agent)
        ? { value: ask.project.agent, from: "project" }
        : runs(ask.prefs.defaultAgent)
          ? { value: ask.prefs.defaultAgent, from: "default" }
          : { value: ask.firstAgent, from: "catalog" };
  const catalog = ask.catalogOf(agent.value);
  if (catalog === undefined) return { agent };
  const project = ask.project ?? {};
  // A project that names its agent keeps its model and effort for that agent alone; one that names none keeps them
  // for whichever agent lists them.
  const projectAgent = project.agent === undefined || project.agent === agent.value;
  const own = ask.prefs.agentDefaults[agent.value] ?? {};
  const models = everyModel(catalog);
  const pickFrom = (list: { options: readonly HarnessOption[]; open: boolean }, fromProject: string | undefined, fromDefault: string | undefined): ResolvedPick | undefined => {
    if (projectAgent && applies(list, fromProject, project.agent === agent.value)) return { value: fromProject, from: "project" };
    if (applies(list, fromDefault, true)) return { value: fromDefault, from: "default" };
    const marked = markedDefault(list.options);
    return marked === undefined ? undefined : { value: marked.value, from: "catalog" };
  };
  const model = pickFrom({ options: models, open: models.length === 0 }, project.model, own.model);
  // An empty catalog list is open; a model's own empty list is a model that takes no effort.
  const effort = pickFrom({ options: effortsFor(catalog, modelOf(catalog, model?.value)), open: catalog.efforts.length === 0 }, project.effort, own.effort);
  const word = (from: DefaultFrom, value: AccessChoice | undefined): ResolvedAccess | undefined => {
    const mode = value === undefined ? undefined : accessMode(catalog, value);
    return mode === undefined ? undefined : { value: value!, mode, from };
  };
  const marked = markedDefault(catalog.permissionModes)?.value;
  const access = word("project", project.access) ?? word("default", own.access) ?? word("catalog", marked === undefined ? undefined : accessWord(catalog, marked));
  return { agent, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}) };
}

/** The list with its default mark on one value, where the list carries it. */
function marked<T extends HarnessOption>(options: readonly T[], value: string): T[] {
  return options.map(({ isDefault: _was, ...o }) => (o.value === value ? { ...o, isDefault: true } : o) as T);
}

/**
 * The catalog with its marks moved onto what a new thread here starts on, so the composer's pickers show it and
 * startPicks fills it in: the one road from the defaults to every door. Only a value the person's layers picked moves
 * a mark; the catalog's own stand. An effort picked moves each model's own default first, which effortsFor reads
 * ahead of the catalog's mark, on every model that takes it.
 */
export function markedFor(catalog: HarnessCatalog, defaults: Omit<ThreadDefaults, "agent">): HarnessCatalog {
  const moved = (pick: { from: DefaultFrom } | undefined): boolean => pick !== undefined && pick.from !== "catalog" && pick.from !== "named";
  let next = catalog;
  if (moved(defaults.model)) {
    const value = defaults.model!.value;
    const inModels = catalog.models.some(m => m.value === value);
    next = {
      ...next,
      models: inModels ? marked(next.models, value) : next.models.map(({ isDefault: _was, ...m }) => m),
      ...(next.legacyModels !== undefined ? { legacyModels: inModels ? next.legacyModels : marked(next.legacyModels, value) } : {}),
    };
  }
  if (moved(defaults.effort)) {
    const value = defaults.effort!.value;
    const takes = (m: HarnessModel): boolean => m.efforts === undefined || m.efforts.includes(value);
    const reMark = (m: HarnessModel): HarnessModel => (takes(m) && m.defaultEffort !== undefined ? { ...m, defaultEffort: value } : m);
    next = { ...next, efforts: marked(next.efforts, value), models: next.models.map(reMark), ...(next.legacyModels !== undefined ? { legacyModels: next.legacyModels.map(reMark) } : {}) };
  }
  if (moved(defaults.access)) next = { ...next, permissionModes: marked(next.permissionModes, defaults.access!.mode) };
  return next;
}

/** The model and effort a new thread starts on where the agent's list is open (its CLI takes any value), which no mark
 * can carry on a list with nothing in it: the value the person set, for a start to run where it names none. */
export function openDefaults(catalog: HarnessCatalog, defaults: Omit<ThreadDefaults, "agent">): { model?: string; effort?: string } {
  const set = (pick: ResolvedPick | undefined, open: boolean): string | undefined => (open && pick !== undefined && (pick.from === "project" || pick.from === "default") ? pick.value : undefined);
  const model = set(defaults.model, everyModel(catalog).length === 0);
  const effort = set(defaults.effort, catalog.efforts.length === 0);
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/** Every character a model id is spelled with across the agents: a provider's path, a tag, a date, a window suffix
 * (claude-opus-4-5[1m], provider/model:tag, claude-3-5-sonnet@20240620). */
const MODEL_ID_CHAR = /[A-Za-z0-9._\-:/@+[\]]/;

/** Why an id typed by hand is no model id, or null: the page asks it under the field and the host where it keeps one. */
export function modelIdRefusal(id: string): string | null {
  if (id === "") return "A model id cannot be empty";
  if (/\s/.test(id)) return "No model id has a space in it";
  if (id.startsWith("-")) return 'No model id starts with "-"';
  const odd = [...id].find(c => !MODEL_ID_CHAR.test(c));
  return odd === undefined ? null : `No model id has ${JSON.stringify(odd)} in it`;
}

/** The catalog with the person's own model ids added after the binary's, so a start and a default may name one. */
export function withCustomModels(catalog: HarnessCatalog, picker: ModelPicker | undefined): HarnessCatalog {
  const known = new Set(everyModel(catalog).map(m => m.value));
  const added = (picker?.custom ?? []).filter(id => !known.has(id)).map(id => ({ value: id, label: id, added: true as const }));
  return added.length === 0 ? catalog : { ...catalog, models: [...catalog.models, ...added] };
}

/** The model picker's list: hidden models off it and kept apart, the person's order first, the rest in the catalog's.
 * Hiding the marked model moves the mark to the first one shown; a start still takes a hidden model by name. */
export function shapeModels(catalog: HarnessCatalog, picker: ModelPicker | undefined): HarnessCatalog {
  if (picker === undefined) return catalog;
  const hide = new Set(picker.hide ?? []);
  const order = picker.order ?? [];
  const rank = (m: HarnessModel): number => (order.includes(m.value) ? order.indexOf(m.value) : order.length);
  const shown = (list: readonly HarnessModel[]): HarnessModel[] => list.filter(m => !hide.has(m.value)).sort((a, b) => rank(a) - rank(b));
  const models = shown(catalog.models);
  const legacyModels = catalog.legacyModels === undefined ? undefined : shown(catalog.legacyModels);
  const hiddenModels = [...catalog.models, ...(catalog.legacyModels ?? [])].filter(m => hide.has(m.value)).map(({ isDefault: _was, ...m }) => m);
  const lostMark = markedDefault(everyModel(catalog)) !== undefined && markedDefault([...models, ...(legacyModels ?? [])]) === undefined;
  return {
    ...catalog,
    models: lostMark && models.length > 0 ? marked(models, models[0]!.value) : models,
    ...(legacyModels !== undefined ? { legacyModels } : {}),
    ...(hiddenModels.length > 0 ? { hiddenModels } : {}),
  };
}

/** Why a word was refused: the agent maps it to none of its own modes, and these are the words it takes. */
export const accessNotTakenLine = (label: string, word: string, takes: string): string => `${label} takes no ${word} access; it takes ${takes}`;
/** Why a word was refused by an agent that maps none of wsp's words. */
export const noAccessWordsLine = (label: string): string => `${label} takes no access of wsp's words`;

/** Why a word was refused at a set or a start: the agent maps it to none of its own modes. */
export function accessRefusal(catalog: Pick<HarnessCatalog, "label" | "access" | "permissionModes">, word: AccessChoice): string | null {
  if (accessMode(catalog, word) !== undefined) return null;
  const takes = ACCESS_CHOICES.filter(w => accessMode(catalog, w) !== undefined);
  return takes.length === 0 ? noAccessWordsLine(catalog.label) : accessNotTakenLine(catalog.label, word, takes.join(", "));
}

/** Why --access was refused before anything was asked: a harness's own spelling, or no word at all. */
export const accessWordsLine = (given: string): string => `--access takes ask, auto-edit, full or plan, and got ${given}`;

/** Why a start named an agent that is off on the computer its workspace stands on. */
export const agentOffLine = (agent: string, computer: string): string => `${agent} is off on ${computer}, so no thread there runs it`;

/** Why a config folder was refused: it is the home itself, which the agent would then fill with its own files. */
export const configDirIsHomeLine = (agent: string): string => `${agent}'s config folder cannot be the home folder itself; name a folder under it`;

/** Why a config folder was refused for an agent wsp has no variable to point at one. */
export const noConfigDirLine = (agent: string): string => `${agent} takes no config folder of its own, so there is nothing to point at one`;

/** Why a variable was refused: the agent's own launch drops it, so it would never reach the agent. */
export const droppedEnvLine = (agent: string, name: string): string => `${name} never reaches ${agent}: its launch drops every variable of that kind`;

/** The variables that decide how a process starts or what it loads: the program search, the shell and its startup
 * files, the dynamic loader, and each language runtime's preload and search paths. A setup naming one would hand that
 * computer's agent a different program than the one its launch names. */
const PROCESS_ENV = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "IFS", "TMPDIR", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH"]);
const PROCESS_ENV_PREFIXES = ["LD_", "DYLD_"];

export const processEnvLine = (name: string, agent: string): string => `${name} decides how ${agent} starts or what it loads, so an agent's setup does not set it`;
export const wspEnvLine = (name: string): string => `${name} is wsp's own, so an agent's setup does not set it`;
/** The fix under a refused variable, on the command line. */
export const ENV_REFUSED_FIX = "Name another variable; this one is the computer's to say.";

/**
 * Why a variable cannot be part of an agent's setup, or null where it may: one that decides how the process starts
 * or what it loads, any of wsp's own, and one the agent's own launch drops (`dropped`, its adapter's patterns). The one
 * home of the rule: the command line asks it before a value is typed, the host before anything is kept, and every
 * launch again, so a variable kept before the rule stood is left off.
 */
export function agentEnvRefusal(name: string, agent: string, dropped: readonly RegExp[] = []): string | null {
  const upper = name.toUpperCase();
  if (upper.startsWith("WSP_")) return wspEnvLine(name);
  if (PROCESS_ENV.has(upper) || PROCESS_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) return processEnvLine(name, agent);
  return dropped.some(pattern => pattern.test(name)) ? droppedEnvLine(agent, name) : null;
}

/** A config folder as the computer it is on resolved it: the folder with every link on its way followed, that
 * computer's home the same way, and the folders wsp keeps its own state in there. */
export interface ResolvedFolder {
  folder: string;
  home: string;
  kept: readonly string[];
}

const within = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder.replace(/\/+$/, "")}/`);

/** Why a config folder cannot stand: it is the home itself, outside the home once its links are followed, or inside
 * one of wsp's own folders. `given` is the path as the person named it, which the sentence names back. */
export function configDirRefusal(agent: string, given: string, real: ResolvedFolder): string | null {
  const home = real.home.replace(/\/+$/, "");
  const folder = real.folder.replace(/\/+$/, "");
  if (folder === home) return configDirIsHomeLine(agent);
  if (!within(folder, home)) return `${agent}'s config folder has to be under the home folder ${home}, and ${given} is not`;
  if (real.kept.some(kept => within(folder, kept.replace(/\/+$/, "")))) return `${given} is inside wsp's own folder, so it is no agent's config folder`;
  return null;
}

/** Why a launch did not start: the config folder kept at setup now leads somewhere `why` refuses, read again on that
 * computer just before the launch. */
export const configDirLaunchRefusal = (agent: string, agentId: string, folder: string, why: string): string =>
  `${agent} does not start with its config folder ${folder}: ${why}. Set another with wsp agents setup ${agentId} --config, or put its own back with --reset config.`;

/** What a config folder change asks of the person: a login kept under the old folder does not follow it. */
export const configDirSignInLine = (agent: string): string => `${agent} keeps its sign-in under its config folder, so sign it in again there before its next thread`;

/** Why a variable's value was refused on a socket that does not hold the host's own token. */
export const ENV_VALUE_REFUSAL = "only a socket holding this host's own token may set a variable's value; use wsp agents setup at the computer the host runs on";
