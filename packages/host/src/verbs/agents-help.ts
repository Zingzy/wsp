// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { agentName } from "@wsp/catalog";
import {
  AgentSetupView,
  ThreadDefaults,
  configDirSignInLine,
  EnvName,
  AgentDefaults,
  type AgentDefaultsPatch,
  type AgentSetupSet,
  type ModelPicker,
  type ProjectOverridesPatch,
  AgentRow,
  AgentsReport,
  AgentsTarget,
  McpRow,
  McpScope,
  commandWords,
  unclosedQuoteRefusal,
  McpTool,
  ServerToolsAnswer,
  SkillAdded,
  SkillHit,
  SkillPreview,
  SkillRow,
  SKILL_PREVIEW_BYTES,
  agentSignInWord,
  FIRST_RUN_WORD,
  VERSION_UNREAD_WORD,
  usageRefusal,
  Preferences,
  ProjectView,
  HERE_PLACE_ID,
  SignInLine,
} from "@wsp/protocol";
import { relaySignIn, targetLink, type BoxSignedIn } from "../place-signin.js";
import { watchBlock, watchOn } from "../watch.js";
import { type HostClient, table, type VerbContext, placeNamed, absolutePath, accessWordOf, printable, cell } from "./client.js";
import { workspaceOf, projectOf } from "./workspaces-help.js";
import { preferencesOf, projectDefaultsOf } from "./turns-help.js";

/** A verb's rows, drawn once or redrawn where they stand until Ctrl-C. The rows come back from one call so a frame
 * is one reading of the host and never half of two, and the socket is handed to the frame rather than asked for
 * inside it, so a watch of any length is one dial however many frames it draws. The one road --watch takes, so the
 * lines that carry it cannot refresh by two different rules. The refusal is read before the dial, so a line with
 * nowhere to redraw never starts a host to say so. */
export async function drawRows(ctx: VerbContext, words: string, frame: (client: HostClient) => Promise<{ value: object; rows: string[] }>): Promise<number> {
  if (ctx.flags["watch"] !== true) {
    const { value, rows } = await frame(await ctx.client());
    ctx.out.emit(value, rows.join("\n"));
    return 0;
  }
  const on = watchOn(words, { json: ctx.flags["json"] === true, redraw: ctx.io.redraw });
  if ("refusal" in on) throw on.refusal;
  const client = await ctx.client();
  await watchBlock(async () => (await frame(client)).rows, { ...on.redraw, ...(ctx.signals !== undefined ? { signals: ctx.signals } : {}) });
  return 0;
}

export const aimedBothLine = "A workspace already names its computer; give the workspace or --on <computer>, not both.";

/** What a tool that takes a workspace or a computer answers after a refusal of what it was given. */
export const aimedUsage = (tool: string): string => `${tool} takes a workspace or on, not both`;

/** The computer or workspace a list of what stands there names: a workspace by its name, a computer by the name
 * wsp computers shows it under, and this computer where neither is given. Refused where both are, since a workspace
 * already names the computer it is on. */
export async function agentsTarget(client: HostClient, workspace: string | undefined, on: string | undefined, usage: string, project?: string): Promise<AgentsTarget> {
  if (workspace !== undefined && on !== undefined) throw usageRefusal(aimedBothLine, usage);
  if (workspace !== undefined) return { workspaceId: (await workspaceOf(client, workspace)).id };
  if (on !== undefined) return { placeId: (await placeNamed(client, on)).id, ...(project !== undefined ? { project } : {}) };
  return { placeId: HERE_PLACE_ID };
}

/** A line's --project, or a tool's project, as the act reads it: absent, not a project's; bare or true, the
 * workspace's own project; a name, with --on, that computer's project of the name. */
interface ProjectAsked {
  project: boolean;
  name?: string;
}

export const projectUnnamedLine = "--project with --on names the project: --project <name>, as wsp projects shows it.";
export const projectOffComputerLine = (value: string): string => `--project ${value} names a project on a computer, which --on names; a workspace's own project is --project alone.`;
export const toolsProjectBareLine = "--project on wsp servers tools names a project on --on <computer>; a workspace finds its own project's servers.";

/** Reads --project against the target the line names: a name needs --on, since a workspace names its own project,
 * and --on needs a name, since a computer holds several. */
export function projectAsked(value: string | boolean | undefined, workspace: string | undefined, on: string | undefined, usage: string): ProjectAsked {
  if (value === undefined || value === false) return { project: false };
  if (value === true || value === "") {
    if (on !== undefined) throw usageRefusal(projectUnnamedLine, usage);
    return { project: true };
  }
  if (on === undefined) throw usageRefusal(projectOffComputerLine(value), usage);
  return { project: true, name: value };
}

/** The project a server's tools are asked in: only by name, with --on, since a workspace finds its own project's
 * servers by itself. */
export function toolsProject(value: string | undefined, workspace: string | undefined, on: string | undefined, usage: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") throw usageRefusal(toolsProjectBareLine, usage);
  return projectAsked(value, workspace, on, usage).name;
}


/** One read of what stands on a computer or workspace, which each of the three lists prints its own part of. */
export async function agentsReport(client: HostClient, workspace: string | undefined, on: string | undefined, usage: string): Promise<AgentsReport> {
  const target = await agentsTarget(client, workspace, on, usage);
  return AgentsReport.parse((await client.request<{ report: unknown }>("agents.read", { target })).report);
}

/** What every one of the three lists answers beside its own rows. */
export const AGENTS_FRAME = AgentsReport.omit({ agents: true, skills: true, servers: true }).shape;

/** The report's own facts, beside the rows one list prints. */
export function reportFacts(r: AgentsReport): Pick<AgentsReport, "target" | "home" | "user" | "readAt" | "stale" | "refused" | "projects"> {
  return { target: r.target, home: r.home, user: r.user, readAt: r.readAt, ...(r.stale !== undefined ? { stale: r.stale } : {}), refused: r.refused, ...(r.projects !== undefined ? { projects: r.projects } : {}) };
}

/** The lines under every list: a napping workspace's report is the one it last had, and each reader that could not
 * answer is named. */
function reportTail(r: AgentsReport): string[] {
  return [...(r.stale === "napping" ? ["napping: this is what stood there when it last ran"] : []), ...r.refused.map(line => `refused: ${cell(line)}`)];
}

export function agentRowLines(r: AgentsReport): string[] {
  const word = (a: AgentRow): string => (!a.installed ? "not found" : a.signIn === "unknown" ? "sign-in unknown" : agentSignInWord(a.signIn));
  const update = (a: AgentRow): string => (a.update === undefined ? "-" : `${a.update.to}: ${a.update.command}`);
  return [...table([["AGENT", "VERSION", "LATEST", "SIGN-IN", "WSP TOOLS", "UPDATE", "PATH"], ...r.agents.map(a => [a.name, a.version ?? (a.installsOnFirstRun === true ? FIRST_RUN_WORD : a.versionUnread === true ? VERSION_UNREAD_WORD : "-"), a.latest ?? "-", word(a), a.wspTools ? "yes" : "no", update(a), a.path ?? "-"])]), ...reportTail(r)];
}

/** Where a skill or a server stands, as both tables print it: its scope, or the project it is a project's of by name. */
const scopeWord = (row: { scope: string; project?: { name: string } }): string => (row.project !== undefined ? `project ${cell(row.project.name)}` : row.scope);

export function skillRowLines(r: AgentsReport): string[] {
  const where = (s: SkillRow): string => s.paths.map(p => (p.linkTo === undefined ? cell(p.path) : `${cell(p.path)} -> ${cell(p.linkTo)}`)).join(", ");
  return [...(r.skills.length === 0 ? ["no skills"] : table([["SKILL", "KIND", "WHERE"], ...r.skills.map(s => [cell(s.name), scopeWord(s), where(s)])])), ...reportTail(r)];
}

export function serverRowLines(r: AgentsReport): string[] {
  const reach = (s: McpRow): string => (s.transport.kind === "stdio" ? `stdio ${s.transport.line}` : `http ${s.transport.host}`);
  const state = (s: McpRow): string => (s.launch === true ? "on every thread" : [s.enabled ? s.auth : "disabled", ...(s.inRecipe === false ? ["not in recipe"] : [])].join(", "));
  return [...(r.servers.length === 0 ? ["no MCP servers"] : table([["SERVER", "AGENT", "SCOPE", "REACHED BY", "FILE", "STATE"], ...r.servers.map(s => [s.name, agentName(s.agent), scopeWord(s), reach(s), s.file ?? "every launch", state(s)])])), ...reportTail(r)];
}

export const SERVER_TOOL_COLUMNS = ["TOOL", "DESCRIPTION"];

/** One server's tools as lines: its sign-in as the connect found it, then each tool, or why none came back. */
export function toolLines(name: string, a: ServerToolsAnswer): string[] {
  const head = `${name}: ${a.auth}${a.holder !== undefined ? `, ${agentName(a.holder)} holds the sign-in` : ""}`;
  if (a.refused !== undefined) return [head, `refused: ${a.refused}`];
  if (a.tools === undefined) return [head];
  return [head, ...(a.tools.length === 0 ? ["no tools"] : table([SERVER_TOOL_COLUMNS, ...a.tools.map((t: McpTool) => [t.name, (t.description ?? "-").split("\n")[0]!])]))];
}

export async function serverToolsOf(client: HostClient, name: string, agent: string, workspace: string | undefined, on: string | undefined, refresh: boolean, usage: string, project?: string): Promise<ServerToolsAnswer> {
  const target = await agentsTarget(client, workspace, on, usage, project);
  return ServerToolsAnswer.parse((await client.request<{ answer: unknown }>("servers.tools", { target, agent, name, ...(refresh ? { refresh } : {}) })).answer);
}

/** A server there added, removed or turned off or on; the answer names the file written. */
export async function serverChanged(client: HostClient, op: "servers.add" | "servers.remove" | "servers.toggle", body: Record<string, unknown>, workspace: string | undefined, on: string | undefined, usage: string, project?: string): Promise<{ file: string }> {
  const target = await agentsTarget(client, workspace, on, usage, project);
  return z.object({ file: z.string() }).parse(await client.request(op, { target, ...body }));
}

export const unsetVariableLine = (variable: string): string => `${variable} is not set in this environment, so there is no value to write.`;
export const notHeaderLine = (pair: string): string => `${pair} is not <header>=<variable>.`;

/** The values an add names, off this process's own environment: `NAME` reads $NAME for a variable, and `Name=VAR`
 * reads $VAR as that header's value. A variable this environment does not hold is refused rather than sent empty. */
export function serverValues(env: Readonly<Record<string, string | undefined>>, names: readonly string[], headers: readonly string[], usage: string): { env?: Record<string, string>; headers?: Record<string, string> } {
  const read = (variable: string): string => {
    const value = env[variable];
    if (value === undefined) throw usageRefusal(unsetVariableLine(variable), usage);
    return value;
  };
  const vars = Object.fromEntries(names.map(name => [name, read(name)]));
  const heads = Object.fromEntries(
    headers.map(pair => {
      const at = pair.indexOf("=");
      if (at <= 0 || at === pair.length - 1) throw usageRefusal(notHeaderLine(pair), usage);
      return [pair.slice(0, at), read(pair.slice(at + 1))];
    }),
  );
  return { ...(names.length > 0 ? { env: vars } : {}), ...(headers.length > 0 ? { headers: heads } : {}) };
}

/** A server's command line as its program and arguments, split as a shell splits it; nothing without one. */
export function serverCommand(line: string | undefined, usage: string): { command?: string; args?: string[] } {
  if (line === undefined) return {};
  const words = commandWords(line);
  if (words === undefined) throw usageRefusal(unclosedQuoteRefusal, usage);
  const [command = "", ...args] = words;
  return { command, args };
}

export const projectScopeLine = (word: string): string => `--project is the project scope, not ${word}; give one of the two.`;

/** The scope a line names, which the wire checks too, and --project, which is the project scope; nothing without
 * either. */
export function serverScope(word: string | undefined, usage: string, project: ProjectAsked = { project: false }): { scope?: McpScope } {
  if (word === undefined) return project.project ? { scope: "project" } : {};
  const scope = McpScope.safeParse(word);
  if (!scope.success) throw usageRefusal(`--scope is user, home or project, not ${word}.`, usage);
  if (project.project && scope.data !== "project") throw usageRefusal(projectScopeLine(word), usage);
  return { scope: scope.data };
}

export const ServerNameIn = z.string().describe("the server's name, as servers lists it");
export const ServerAgentIn = z.string().describe("the catalog id of the agent whose config names it, as servers lists it");
export const ServerScopeIn = McpScope.optional().describe("the scope servers lists it under: user, home or project; user without it");
export const ServerProjectIn = z
  .union([z.boolean(), z.string()])
  .optional()
  .describe("the project's server of that name: true from a workspace, or the project's name, as projects lists it, with on");
export const SERVER_CHANGE_WORDS =
  "Written as the login the computer was added with, into that agent's own file, which keeps its mode; a file that is a link out of the home, or out of the project for a project's file, is not written through, and a file the agent wrote meanwhile is left as it was. A napping workspace is not woken. The report there reads again at once.";

export const SERVER_TOOLS_WORDS =
  "Starts that one server once on that computer or workspace, as the login it was added with and with the command and variables its agent's config gives it, or asks its address once from there, and stops it within 20 seconds; the answer is the server's state, the one the app shows, and stands three minutes unless refreshed or a sign-in there ends; an edited entry is asked again. A server behind a sign-in its agent holds brings no list, since no login file is read: Claude Code is asked for its word on it, and for any other agent it answers unknown, naming that agent as the one holding the sign-in. A napping workspace is not woken.";

export const toolsAddedLine = (agent: string, file: string): string => `${agent} now has the wsp tools: ${file}`;

/** The wsp tools into one agent's config on this computer. */
export async function addTools(client: HostClient, agent: string): Promise<{ file: string }> {
  return z.object({ file: z.string() }).parse(await client.request("agents.addTools", { target: { placeId: HERE_PLACE_ID }, agent }));
}

/** Runs a sign-in the host plans for a target on that target's own terminal, shown in this one. */
export async function signInHere(ctx: VerbContext, target: AgentsTarget, ask: { agent: string; name?: string }, where: string): Promise<BoxSignedIn> {
  const client = await ctx.client();
  const { line } = await client.request<{ line: unknown }>("agents.signInLine", { target, agent: ask.agent, ...(ask.name !== undefined ? { name: ask.name } : {}) });
  const road = await targetLink(client, target);
  try {
    return await relaySignIn({
      where,
      link: road.link,
      ...(ask.name === undefined ? { agent: ask.agent } : {}),
      line: SignInLine.parse(line),
      terminal: ctx.terminal ?? { input: process.stdin, output: process.stdout },
      open: ctx.open ?? (async () => false),
    });
  } finally {
    await road.close();
  }
}

/** The line a sign-in comes to: signed in where it was named, or not, with what the tool said. */
export function signedInLine(what: string, where: string, answer: BoxSignedIn): string {
  if (answer.signedIn) return `${what} is signed in on ${where}${answer.detail === undefined ? "" : ` (${answer.detail})`}.`;
  return `${what} is not signed in on ${where}${answer.said === undefined ? "" : `: ${answer.said}`}.`;
}

/** skills.sh's search, asked by the host. */
export async function searchSkillsSh(client: HostClient, q: string, limit: number | undefined): Promise<SkillHit[]> {
  return z.array(SkillHit).parse((await client.request<{ skills: unknown }>("skills.search", { q, ...(limit !== undefined ? { limit } : {}) })).skills);
}

export const noSkillHitsLine = "no skills on skills.sh match";
export const SKILL_HIT_COLUMNS = ["SKILL", "INSTALLS", "ADD WITH"];

export function skillHitLines(hits: readonly SkillHit[]): string[] {
  return hits.length === 0 ? [noSkillHitsLine] : table([SKILL_HIT_COLUMNS, ...hits.map(h => [cell(h.name), String(h.installs), cell(h.id)])]);
}

/** A skill named `<owner>/<repo>/<skill>` is one on skills.sh; any other name is one already on the target. */
const onSkillsSh = (skill: string): boolean => skill.split("/").length === 3;

export const skillsShPlacelessLine = (skill: string): string => `${skill} is read off skills.sh, which names no computer or project.`;

/** A skill's SKILL.md: off skills.sh by its id, else off the target by its name. */
export async function skillShown(client: HostClient, skill: string, workspace: string | undefined, on: string | undefined, project: ProjectAsked, usage: string): Promise<SkillPreview> {
  if (onSkillsSh(skill)) {
    if (workspace !== undefined || on !== undefined || project.project) throw usageRefusal(skillsShPlacelessLine(skill), usage);
    return SkillPreview.parse((await client.request<{ preview: unknown }>("skills.get", { skill })).preview);
  }
  const target = await agentsTarget(client, workspace, on, usage, project.name);
  return SkillPreview.parse((await client.request<{ preview: unknown }>("skills.preview", { target, name: skill, ...(project.project ? { project: true } : {}) })).preview);
}

export const previewCutLine = (kb: number): string => `(the first ${SKILL_PREVIEW_BYTES / 1024} KB of ${kb} KB)`;

export const shownText = (p: SkillPreview): string => {
  const text = printable(p.text);
  return p.size > SKILL_PREVIEW_BYTES ? `${text}\n\n${previewCutLine(Math.ceil(p.size / 1024))}` : text;
};

export async function skillAdded(client: HostClient, skill: string, workspace: string | undefined, on: string | undefined, agents: readonly string[] | undefined, project: ProjectAsked, usage: string): Promise<SkillAdded> {
  const target = await agentsTarget(client, workspace, on, usage, project.name);
  return SkillAdded.parse((await client.request<{ added: unknown }>("skills.add", { target, skill, ...(agents !== undefined && agents.length > 0 ? { agents } : {}), ...(project.project ? { project: true } : {}) })).added);
}

export const isInLine = (name: string, path: string): string => `${name} is in ${path}.`;
export const isInAlsoLine = (name: string, path: string, copies: string): string => `${name} is in ${path}, and in ${copies}.`;
export const agentCopyWords = (agent: string, path: string): string => `${agent}'s ${path}`;

export function addedLine(skill: string, a: SkillAdded): string {
  const name = cell(skill.split("/").at(-1) ?? skill);
  return a.agents.length === 0 ? isInLine(name, cell(a.path)) : isInAlsoLine(name, cell(a.path), a.agents.map(x => agentCopyWords(agentName(x.agent), cell(x.path))).join(", "));
}

export const goneFromLine = (name: string, from: string): string => `${name} is gone from ${from}.`;
export const turnedInLine = (name: string, on: boolean, file: string): string => `${name} is ${on ? "on" : "off"} in ${file}.`;

export const removedLine = (name: string, removed: readonly string[]): string => goneFromLine(cell(name), removed.map(cell).join(", "));

/** A skill there turned off, on, or removed, by its name. */
export async function skillChanged(client: HostClient, op: "skills.remove" | "skills.toggle", name: string, workspace: string | undefined, on: string | undefined, project: ProjectAsked, turn: boolean | undefined, usage: string): Promise<string[]> {
  const target = await agentsTarget(client, workspace, on, usage, project.name);
  const said = await client.request<{ removed?: unknown; paths?: unknown }>(op, { target, name, ...(project.project ? { project: true } : {}), ...(turn !== undefined ? { on: turn } : {}) });
  return z.array(z.string()).parse(op === "skills.remove" ? said.removed : said.paths);
}

export const turnedLine = (name: string, on: boolean): string => `${name} is ${on ? "on" : "off"}.`;

export const SkillNameIn = z.string().describe("the skill's name, as skills lists it");
export const SkillProjectIn = z
  .union([z.boolean(), z.string()])
  .optional()
  .describe("the project's skill of that name rather than the one that is not a project's: true from a workspace, or the project's name, as projects lists it, with on");
export const SKILL_CHANGE_WORDS =
  "The skill wsp writes and a plugin's are always on and are refused; a napping workspace is not woken. The report there reads again at once.";

/** Each field a --reset puts back on the layer below, by the verb that takes it. */
export const AGENT_SET_RESETS = ["model", "effort", "access", "models"] as const;
export const PROJECT_SET_RESETS = ["agent", "model", "effort", "access", "after-worktree"] as const;
export const AGENT_SETUP_RESETS = ["program", "config", "args"] as const;

/** The fields a --reset names, each one of the verb's own; a word outside them is refused naming them. */
function resetsOf<T extends string>(fields: readonly T[], given: readonly string[]): T[] {
  for (const word of given) if (!(fields as readonly string[]).includes(word)) throw usageRefusal(`--reset takes ${fields.join(", ")}, and got ${JSON.stringify(word)}.`, "Name one of those for each --reset.");
  return given as T[];
}

/** A field as a patch carries it: the value named, null where a --reset puts it back, absent where neither was said. */
function patched<K extends string, V>(key: K, value: V | undefined, reset: boolean): { [P in K]?: V | null } {
  return (value !== undefined ? { [key]: value } : reset ? { [key]: null } : {}) as { [P in K]?: V | null };
}

/** What wsp agents set and its tool take. */
interface AgentSetAsk {
  model?: string;
  effort?: string;
  access?: string;
  hide?: readonly string[];
  show?: readonly string[];
  order?: readonly string[];
  addModel?: readonly string[];
  dropModel?: readonly string[];
  reset?: readonly string[];
}

export const agentSetNothingLine = "wsp agents set takes --model, --effort, --access, a model to --hide, --show, --add-model or --drop-model, --order or --reset.";
/** The fix under a set that names nothing to change. */
export const NOTHING_TO_SET_FIX = "Name at least one; with none of them there is nothing to change.";

/** One agent's defaults moved, on the person's record the app reads too; answers them as they now stand. The host
 * refuses an agent it runs no thread of and an access word that agent's row maps to none of its modes. */
export async function agentDefaultsSet(client: HostClient, agent: string, ask: AgentSetAsk): Promise<AgentDefaults> {
  const resets = resetsOf(AGENT_SET_RESETS, ask.reset ?? []);
  const lists = [ask.hide, ask.show, ask.order, ask.addModel, ask.dropModel].some(l => l !== undefined && l.length > 0);
  let models: ModelPicker | null | undefined = resets.includes("models") ? null : undefined;
  if (models === undefined && lists) {
    const kept = (await preferencesOf(client)).agentDefaults[agent]?.models ?? {};
    const hide = [...new Set([...(kept.hide ?? []).filter(m => !(ask.show ?? []).includes(m)), ...(ask.hide ?? [])])];
    const custom = [...new Set([...(kept.custom ?? []).filter(m => !(ask.dropModel ?? []).includes(m)), ...(ask.addModel ?? [])])];
    const order = ask.order !== undefined && ask.order.length > 0 ? [...ask.order] : kept.order;
    models = { ...(hide.length > 0 ? { hide } : {}), ...(order !== undefined && order.length > 0 ? { order } : {}), ...(custom.length > 0 ? { custom } : {}) };
  }
  const patch: AgentDefaultsPatch = {
    ...patched("model", ask.model, resets.includes("model")),
    ...patched("effort", ask.effort, resets.includes("effort")),
    ...patched("access", ask.access === undefined ? undefined : accessWordOf(ask.access), resets.includes("access")),
    ...(models !== undefined ? { models } : {}),
  };
  if (Object.keys(patch).length === 0) throw usageRefusal(agentSetNothingLine, NOTHING_TO_SET_FIX);
  const { preferences } = await client.request<{ preferences: unknown }>("preferences.set", { patch: { agentDefaults: { [agent]: patch } } });
  return Preferences.parse(preferences).agentDefaults[agent] ?? {};
}

/** The parts of an agent's defaults line that say how its model picker lists models, each given the models it names. */
export const PICKER_WORDS = { hide: (models: string): string => `hides ${models}`, order: (models: string): string => `lists ${models} first`, custom: (models: string): string => `adds ${models}` };
export const startsOnOwnLine = (agent: string): string => `${agent} starts on its own defaults.`;
export const startsOnLine = (agent: string, said: string): string => `${agent} starts on ${said}.`;

/** What one agent's defaults now read as, in one line. */
export function agentDefaultsLine(agent: string, d: AgentDefaults): string {
  const listed = (models: readonly string[] | undefined, words: (models: string) => string): string | undefined => (models === undefined || models.length === 0 ? undefined : words(models.join(" ")));
  const picker = [listed(d.models?.hide, PICKER_WORDS.hide), listed(d.models?.order, PICKER_WORDS.order), listed(d.models?.custom, PICKER_WORDS.custom)];
  const said = [d.model, d.effort, d.access, ...picker].filter((w): w is string => w !== undefined);
  return said.length === 0 ? startsOnOwnLine(agentName(agent)) : startsOnLine(agentName(agent), said.join("; "));
}

/** The agent a new thread runs where neither its start nor its project names one. */
export async function defaultAgentSet(client: HostClient, agent: string): Promise<{ defaultAgent: string }> {
  await client.request("preferences.set", { patch: { defaultAgent: agent } });
  return { defaultAgent: agent };
}

export const defaultAgentLine = (agent: string): string => `A new thread that names no agent runs ${agentName(agent)}, where its project names none.`;

export const envNameLine = (named: string, quoted: string): string => `${named} takes a variable's name, and got ${quoted}.`;
export const ENV_NAME_FIX = "Name the variable alone; its value is asked for where nothing echoes it.";

/** A variable's name off a line or a tool, refused where a shell would not read it as one. */
export function envNameOf(name: string, named: string): string {
  if (!EnvName.safeParse(name).success) throw usageRefusal(envNameLine(named, JSON.stringify(name)), ENV_NAME_FIX);
  return name;
}

/** What wsp agents setup and its tool take; a variable's value rides `values`, which only the command line fills. */
interface AgentSetupAsk {
  on?: string;
  enabled?: boolean;
  program?: string;
  config?: string;
  args?: readonly string[];
  unsetEnv?: readonly string[];
  reset?: readonly string[];
}

export const agentSetupNothingLine = "wsp agents setup takes --enable or --disable, --program, --config, --arg, --env, --unset-env or --reset.";

/** How one agent runs on one computer changed there, and its row as that computer's read now gives it, names only. */
export async function agentSetupSet(client: HostClient, agent: string, ask: AgentSetupAsk, values: Readonly<Record<string, string>>, usage: string): Promise<AgentRow> {
  const resets = resetsOf(AGENT_SETUP_RESETS, ask.reset ?? []);
  const target = await agentsTarget(client, undefined, ask.on, usage);
  const unset = (ask.unsetEnv ?? []).map(name => envNameOf(name, "--unset-env"));
  const env = { ...values, ...Object.fromEntries(unset.map(name => [name, null])) };
  const change: AgentSetupSet = {
    ...(ask.enabled !== undefined ? { on: ask.enabled } : {}),
    ...patched("program", ask.program, resets.includes("program")),
    ...patched("configDir", ask.config === undefined ? undefined : absolutePath("--config is a folder on that computer", ask.config), resets.includes("config")),
    ...patched("args", ask.args === undefined || ask.args.length === 0 ? undefined : [...ask.args], resets.includes("args")),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  if (Object.keys(change).length === 0) throw usageRefusal(agentSetupNothingLine, NOTHING_TO_SET_FIX);
  const placeId = "placeId" in target ? target.placeId : HERE_PLACE_ID;
  return AgentRow.parse((await client.request<{ agent: unknown }>("agents.setup", { placeId, agent, ...change })).agent);
}

export const setupOnLine = (name: string, on: boolean): string => `${name} is ${on ? "on" : "off"} there.`;
/** The label each fact of a setup is printed under. */
export const SETUP_WORDS = { program: "program", configDir: "config folder", args: "launch words", envNames: "variables" };

/** How an agent now runs there, one fact a line, with the sign-in a moved config folder asks for. */
export function agentSetupLines(row: AgentRow, configMoved: boolean): string[] {
  const setup = row.setup ?? AgentSetupView.parse({ on: true, envNames: [] });
  return [
    setupOnLine(row.name, setup.on),
    ...(setup.program !== undefined ? [`${SETUP_WORDS.program}: ${cell(setup.program)}`] : []),
    ...(setup.configDir !== undefined ? [`${SETUP_WORDS.configDir}: ${cell(setup.configDir)}`] : []),
    ...(setup.args !== undefined ? [`${SETUP_WORDS.args}: ${setup.args.map(cell).join(" ")}`] : []),
    ...(setup.envNames.length > 0 ? [`${SETUP_WORDS.envNames}: ${setup.envNames.join(" ")}`] : []),
    ...(configMoved && setup.configDir !== undefined ? [`${configDirSignInLine(row.name)}.`] : []),
  ];
}

/** What wsp projects set and its tool take. */
interface ProjectSetAsk {
  agent?: string;
  model?: string;
  effort?: string;
  access?: string;
  afterWorktree?: string;
  reset?: readonly string[];
}

export const projectSetNothingLine = "wsp projects set takes --agent, --model, --effort, --access, --after-worktree or --reset.";
export const afterWorktreeBlankLine = "--after-worktree was given a blank command, which a new worktree cannot run.";
export const AFTER_WORKTREE_BLANK_FIX = "Name the shell line a new worktree runs, or take the command away with --reset after-worktree.";
/** The project's own after-worktree command, as a line under what a new thread there starts on. */
export const afterWorktreeLine = (command: string): string => `after a new worktree: ${command}`;
export const noDefaultsAnsweredLine = (project: string): string => `the host answered no defaults for ${project}`;

/** One project's overrides moved, and what a new thread on it now starts on. */
export async function projectDefaultsSet(client: HostClient, ref: string, ask: ProjectSetAsk): Promise<{ project: ProjectView; defaults: ThreadDefaults; afterWorktree?: string }> {
  if (ask.afterWorktree !== undefined && ask.afterWorktree.trim() === "") throw usageRefusal(afterWorktreeBlankLine, AFTER_WORKTREE_BLANK_FIX);
  const resets = resetsOf(PROJECT_SET_RESETS, ask.reset ?? []);
  const patch: ProjectOverridesPatch = {
    ...patched("agent", ask.agent, resets.includes("agent")),
    ...patched("model", ask.model, resets.includes("model")),
    ...patched("effort", ask.effort, resets.includes("effort")),
    ...patched("access", ask.access === undefined ? undefined : accessWordOf(ask.access), resets.includes("access")),
    ...patched("afterWorktree", ask.afterWorktree, resets.includes("after-worktree")),
  };
  if (Object.keys(patch).length === 0) throw usageRefusal(projectSetNothingLine, NOTHING_TO_SET_FIX);
  const project = await projectOf(client, ref);
  const { preferences } = await client.request<{ preferences: unknown }>("preferences.set", { patch: { projectDefaults: { [project.id]: patch } } });
  const defaults = (await projectDefaultsOf(client))[project.id];
  if (defaults === undefined) throw new Error(noDefaultsAnsweredLine(project.name));
  const afterWorktree = Preferences.parse(preferences).projectDefaults[project.id]?.afterWorktree;
  return { project, defaults, ...(afterWorktree !== undefined ? { afterWorktree } : {}) };
}

/** Where a resolved value came from, as a person reads it. */
export const FROM_WORDS: Readonly<Record<ThreadDefaults["agent"]["from"], string>> = { named: "named on the start", project: "this project's", default: "your default", catalog: "the catalog's" };
export const newThreadsHeadLine = (project: string): string => `A new thread on ${project} starts on:`;

/** The word each resolved value is printed under, and the line it is printed in. */
export const DEFAULTS_LABELS = { agent: "agent", model: "model", effort: "effort", access: "access" };
export const defaultsValueLine = (label: string, value: string, from: string): string => `${label} ${value}: ${from}`;

/** What a new thread on a project starts on, one value a line, each with where it came from. */
export function threadDefaultsLines(d: ThreadDefaults): string[] {
  const line = (label: string, pick: { value: string; from: ThreadDefaults["agent"]["from"] } | undefined, shown = pick?.value): string[] => (pick === undefined ? [] : [defaultsValueLine(label, shown!, FROM_WORDS[pick.from])]);
  return [...line(DEFAULTS_LABELS.agent, d.agent, agentName(d.agent.value)), ...line(DEFAULTS_LABELS.model, d.model), ...line(DEFAULTS_LABELS.effort, d.effort), ...line(DEFAULTS_LABELS.access, d.access)];
}

/** A project's row cell: the agent, model and access a new thread there starts on, a value the project set marked. */
export const defaultsCell = (d: ThreadDefaults | undefined): string =>
  d === undefined ? "-" : [d.agent, d.model, d.access].flatMap(pick => (pick === undefined ? [] : [pick.from === "project" ? `${pick.value} (project)` : pick.value])).join(" ");


export const AgentsWorkspaceIn = z.string().optional().describe("the workspace to read, by its name, or its id when two share a name; absent reads a computer");
export const AgentsOnIn = z.string().optional().describe("the computer to read, by the name computers lists; absent with no workspace is the computer the app runs on");
export const AGENTS_ON_WORDS = "the computer to read, by the name wsp computers shows; this computer without it, and a workspace names its own";
export const AGENTS_READ_WORDS = "Read as the login the computer was added with, off each agent's config and whether its files are there: no MCP server is started and no login file is opened. A napping workspace answers what stood there when it last ran, marked stale, and is not woken.";
