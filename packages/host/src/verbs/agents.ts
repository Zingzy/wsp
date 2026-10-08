// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { THREAD_AGENTS, agentName, catalogEntry } from "@wsp/catalog";
import {
  agentEnvRefusal,
  ENV_REFUSED_FIX,
  AgentDefaults,
  AgentRow,
  McpRow,
  ServerToolsAnswer,
  SkillAdded,
  SkillHit,
  SkillPreview,
  SkillRow,
  SKILL_PREVIEW_BYTES,
  usageRefusal,
  addToolsHereRefusal,
  THIS_COMPUTER,
} from "@wsp/protocol";
import { usageIs, tool, type Verb, flag, flagList } from "./client.js";
import { HOST_SIDE_VAULT } from "./workspaces-help.js";
import { asText, ACCESS_IN_WORDS, confirmed } from "./io.js";
import { aimedUsage, agentsTarget, projectAsked, toolsProject, agentsReport, AGENTS_FRAME, reportFacts, agentRowLines, skillRowLines, serverRowLines, toolLines, serverToolsOf, serverChanged, serverValues, serverCommand, serverScope, ServerNameIn, ServerAgentIn, ServerScopeIn, ServerProjectIn, SERVER_CHANGE_WORDS, SERVER_TOOLS_WORDS, toolsAddedLine, addTools, signInHere, signedInLine, searchSkillsSh, skillHitLines, skillShown, shownText, skillAdded, isInLine, addedLine, goneFromLine, turnedInLine, removedLine, skillChanged, turnedLine, SkillNameIn, SkillProjectIn, SKILL_CHANGE_WORDS, AGENT_SET_RESETS, AGENT_SETUP_RESETS, agentDefaultsSet, agentDefaultsLine, defaultAgentSet, defaultAgentLine, envNameOf, agentSetupSet, agentSetupLines, AgentsWorkspaceIn, AgentsOnIn, AGENTS_READ_WORDS } from "./agents-help.js";

export const AGENT_VERBS: readonly Verb[] = [
  {
    name: "agents",
    usage: "wsp agents [<workspace>] [--on <computer>]",
    about: "the coding agents on this computer, a box you added or a workspace: each one's version and the newest out, whether it is signed in there, and whether it carries the wsp tools",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp agents takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), agents: report.agents }, agentRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `The coding agents the catalog knows, as they stand on one computer or workspace: whether each is on that login's PATH and where, the version its command answers, the newest its vendor publishes as this host last read it (asked of npm, GitHub or the vendor from this host alone, kept a day, never with Newest agent versions off in Settings > Privacy or WSP_UPDATE_CHECK=0) and the version wsp's install pins, its sign-in there (signed in, your key from this host's vault, not signed in, or unknown) and how it stands in the status command's own words (signInDetail), the kind of that login (signInKind: api-key, subscription or oauth) and the plan it names (signInPlan), how a person signs it in, whether its threads there get the wsp tools (one of its MCP config files names the wsp server, or on any computer but the one the app runs on, its launch hands the server over), the vendor's own command that brings it up to the newest where it is older (update, which wsp shows and never runs), and on a computer how the person set it to run there (setup: on or off, the program, the config folder, the launch words and the names of its variables, never a value). ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, agents: z.array(AgentRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "agents takes a workspace or on, not both");
        return asText(agentRowLines(report).join("\n"), { ...reportFacts(report), agents: report.agents });
      },
    }),
  },
  {
    name: "skills",
    usage: "wsp skills [<workspace>] [--on <computer>]",
    about: "the skills on this computer, a box you added or a workspace, each by name with every folder it lives in and which agent loads it from there",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp skills takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), skills: report.skills }, skillRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Every skill on one computer or workspace, one row per folder name: its description off its SKILL.md, every folder it lives in with the agent whose own folder that is (none for the shared ~/.agents/skills) and where a folder links to, and whether it is the person's own, a project's inside a workspace, or a plugin's. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, skills: z.array(SkillRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "skills takes a workspace or on, not both");
        return asText(skillRowLines(report).join("\n"), { ...reportFacts(report), skills: report.skills });
      },
    }),
  },
  {
    name: "skills search",
    usage: "wsp skills search <query> [--limit <n>]",
    about: "searches skills.sh for skills by their words, each with how often it was installed and the id wsp skills add takes",
    page: "agent",
    options: { limit: { type: "string" } },
    run: async ctx => {
      const q = ctx.args.join(" ");
      const raw = flag(ctx.flags, "limit");
      const limit = raw === undefined ? undefined : Number(raw);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw usageRefusal("--limit takes a whole number from 1 to 50.", usageIs(ctx));
      const hits = await searchSkillsSh(await ctx.client(), q, limit);
      ctx.out.emit({ skills: hits }, skillHitLines(hits).join("\n"));
      return 0;
    },
    tool: tool({
      description: "Skills on skills.sh whose words match the query, most installed first as skills.sh ranks them: each one's name, the repo it comes from, how many times it was installed, and the id skills_add takes. The host asks skills.sh; an empty query is refused.",
      input: { query: z.string().describe("the words to search skills.sh for"), limit: z.number().int().min(1).max(50).optional().describe("how many to answer, 20 without it") },
      output: { skills: z.array(SkillHit) },
      call: async ({ query, limit }, deps) => {
        const hits = await searchSkillsSh(await deps.client(), query, limit);
        return asText(skillHitLines(hits).join("\n"), { skills: hits });
      },
    }),
  },
  {
    name: "skills show",
    usage: "wsp skills show <skill> [<workspace>] [--on <computer>] [--project [<name>]]",
    about: "prints a skill's SKILL.md: one on skills.sh by its <owner>/<repo>/<skill> before it is installed, or one already on this computer, a box you added or a workspace by its name",
    page: "agent",
    options: { on: { type: "string" }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [skill, workspace, ...rest] = ctx.args;
      if (skill === undefined || rest.length > 0) throw usageRefusal("wsp skills show takes one skill and one workspace at most.", usageIs(ctx));
      const shown = await skillShown(await ctx.client(), skill, workspace, flag(ctx.flags, "on"), projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), usageIs(ctx));
      ctx.out.emit(shown, shownText(shown));
      return 0;
    },
    tool: tool({
      description: `A skill's SKILL.md as text, its first ${SKILL_PREVIEW_BYTES / 1024} KB and the whole file's size: a skill on skills.sh by its <owner>/<repo>/<skill>, read by the host with nothing installed, or a skill already on one computer or workspace by its name. Nothing in it runs.`,
      input: { skill: z.string().describe("an <owner>/<repo>/<skill> off skills_search, or the name of a skill skills lists"), workspace: AgentsWorkspaceIn, on: AgentsOnIn, project: SkillProjectIn },
      output: SkillPreview.shape,
      call: async ({ skill, workspace, on, project }, deps) => {
        const shown = await skillShown(await deps.client(), skill, workspace, on, projectAsked(project, workspace, on, "skills_show"), aimedUsage("skills_show"));
        return asText(shownText(shown), shown);
      },
    }),
  },
  {
    name: "skills add",
    usage: "wsp skills add <skill> [<workspace>] [--on <computer>] [--agent <id>]... [--project [<name>]]",
    about: "installs a skill off skills.sh by its <owner>/<repo>/<skill> into the shared skills folder, with a link or a copy for each agent named that does not read that folder; every file is checked first and lands as a plain file that runs nothing",
    page: "agent",
    options: { on: { type: "string" }, agent: { type: "string", multiple: true }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [skill, workspace, ...rest] = ctx.args;
      if (skill === undefined || rest.length > 0) throw usageRefusal("wsp skills add takes one skill and one workspace at most.", usageIs(ctx));
      const agents = flagList(ctx.flags, "agent");
      const added = await skillAdded(await ctx.client(), skill, workspace, flag(ctx.flags, "on"), agents.length > 0 ? agents : undefined, projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx)), usageIs(ctx));
      ctx.out.emit(added, addedLine(skill, added));
      return 0;
    },
    tool: tool({
      description:
        "Installs one skill off skills.sh on one computer or workspace, as the login it was added with: its files land once in ~/.agents/skills/<name> (the project's .agents/skills with project, from a workspace), and each agent named that does not read that folder gets a link to it or a copy in its own skills folder; with no agent named, every agent whose own folder's home is there gets it. The download is checked whole before anything lands: every path plain and inside the skill, at most 200 files, 1 MB each and 5 MB in all, a SKILL.md at its root; every file lands 0644 and nothing in the skill runs. A skill already there is refused rather than written over.",
      input: {
        skill: z.string().describe("the skill's <owner>/<repo>/<skill>, as skills_search answers it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        agent: z.array(z.string()).optional().describe("the catalog ids of the agents to put it in; every agent whose folder is there without it"),
        project: z.union([z.boolean(), z.string()]).optional().describe("put it in a project rather than the home: true for the workspace's own, or the project's name, as projects lists it, with on"),
      },
      output: SkillAdded.shape,
      call: async ({ skill, workspace, on, agent, project }, deps) => {
        const added = await skillAdded(await deps.client(), skill, workspace, on, agent, projectAsked(project, workspace, on, "skills_add"), aimedUsage("skills_add"));
        return asText(addedLine(skill, added), added);
      },
    }),
  },
  {
    name: "skills remove",
    usage: "wsp skills remove <name> [<workspace>] [--on <computer>] [--project [<name>]] [--yes]",
    about: "removes a skill by its name: every folder it lives in and every link to it, where a link's own folder elsewhere stays",
    page: "agent",
    options: { on: { type: "string" }, project: { type: "string", valueWith: "on" }, yes: { type: "boolean" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp skills remove takes one skill's name and one workspace at most.", usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      if (!(await confirmed(ctx, `Remove the skill ${name}?\nEvery folder it lives in and every link to it go.`, name))) return 1;
      const removed = await skillChanged(await ctx.client(), "skills.remove", name, workspace, flag(ctx.flags, "on"), project, undefined, usageIs(ctx));
      ctx.out.emit({ removed }, removedLine(name, removed));
      return 0;
    },
    tool: tool({
      description: `Removes one skill on one computer or workspace by its name, as the login it was added with: every folder skills lists for it and every link to it; a folder a link points to outside the skills folders stays. ${SKILL_CHANGE_WORDS}`,
      input: { name: SkillNameIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, project: SkillProjectIn },
      output: { removed: z.array(z.string()) },
      call: async ({ name, workspace, on, project }, deps) => {
        const removed = await skillChanged(await deps.client(), "skills.remove", name, workspace, on, projectAsked(project, workspace, on, "skills_remove"), undefined, aimedUsage("skills_remove"));
        return asText(removedLine(name, removed), { removed });
      },
    }),
  },
  ...(["disable", "enable"] as const).map(
    (word): Verb => ({
      name: `skills ${word}`,
      usage: `wsp skills ${word} <name> [<workspace>] [--on <computer>]`,
      about: word === "disable" ? "turns a skill off by its name, its SKILL.md renamed SKILL.md.off where it lives, so no agent loads it until it is turned on" : "turns a skill that was turned off on again, its SKILL.md.off renamed back",
      page: "agent",
      options: { on: { type: "string" } },
      run: async ctx => {
        const [name, workspace, ...rest] = ctx.args;
        if (name === undefined || rest.length > 0) throw usageRefusal(`wsp skills ${word} takes one skill's name and one workspace at most.`, usageIs(ctx));
        const paths = await skillChanged(await ctx.client(), "skills.toggle", name, workspace, flag(ctx.flags, "on"), { project: false }, word === "enable", usageIs(ctx));
        ctx.out.emit({ paths }, turnedLine(name, word === "enable"));
        return 0;
      },
      tool: tool({
        description: `Turns one skill ${word === "enable" ? "on again" : "off"} on one computer or workspace by its name, as the login it was added with: its SKILL.md is renamed ${word === "enable" ? "back from SKILL.md.off" : "SKILL.md.off"} in each folder it really lives in, which every link to it follows, and no agent config is edited. A project's skill lives in the repo and is refused. ${SKILL_CHANGE_WORDS}`,
        input: { name: SkillNameIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn },
        output: { paths: z.array(z.string()) },
        call: async ({ name, workspace, on }, deps) => {
          const paths = await skillChanged(await deps.client(), "skills.toggle", name, workspace, on, { project: false }, word === "enable", aimedUsage(`skills_${word}`));
          return asText(turnedLine(name, word === "enable"), { paths });
        },
      }),
    }),
  ),
  {
    name: "servers",
    usage: "wsp servers [<workspace>] [--on <computer>]",
    about: "the MCP servers the agents on this computer, a box you added or a workspace are set up with: how each is reached, the file it is defined in and its sign-in as its config says it",
    page: "agent",
    options: { on: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp servers takes one workspace at most.", usageIs(ctx));
      const report = await agentsReport(await ctx.client(), ctx.args[0], flag(ctx.flags, "on"), usageIs(ctx));
      ctx.out.emit({ ...reportFacts(report), servers: report.servers }, serverRowLines(report).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Every MCP server each agent's own config file defines on one computer or workspace, and a workspace's project files: the agent, the file, how it is reached (its command with every value hidden, or its url's host), the names of the variables it sets or reads and never their values, whether the file switches it off, whether wsp's recipe put it there on a box, and its sign-in as the config alone says it: open for a command or a fixed header, unknown for a remote server until something connects. On any computer but the one the app runs on it also lists the wsp server each thread's launch there hands an agent that takes servers on its launch, marked launch, with no file, and never turned off or removed. ${AGENTS_READ_WORDS}`,
      input: { workspace: AgentsWorkspaceIn, on: AgentsOnIn },
      output: { ...AGENTS_FRAME, servers: z.array(McpRow) },
      call: async ({ workspace, on }, deps) => {
        const report = await agentsReport(await deps.client(), workspace, on, "servers takes a workspace or on, not both");
        return asText(serverRowLines(report).join("\n"), { ...reportFacts(report), servers: report.servers });
      },
    }),
  },
  {
    name: "agents signin",
    usage: "wsp agents signin <agent> [<workspace>]",
    about: "signs an agent in on this computer or in a workspace, its own sign-in run there and shown in this terminal; a box you added takes wsp add <computer> --sign-in <agent>",
    page: "agent",
    options: {},
    cliOnly: "runs the agent's own sign-in in a terminal a person types into, which is where the ones that ask them to pick a provider are answered",
    run: async ctx => {
      const [agent, workspace, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents signin takes one agent and one workspace at most.", usageIs(ctx));
      const target = await agentsTarget(await ctx.client(), workspace, undefined, usageIs(ctx));
      const where = workspace ?? THIS_COMPUTER;
      const answer = await signInHere(ctx, target, { agent }, where);
      ctx.io.log(signedInLine(agentName(agent), where, answer));
      return answer.signedIn ? 0 : 1;
    },
  },
  {
    name: "agents key",
    usage: "wsp agents key <agent>",
    about: "puts an agent's token or API key into this host's vault, typed where nothing echoes it; Claude Code's token is the one claude setup-token prints",
    page: "agent",
    options: {},
    cliOnly: "takes a token typed at the host's own terminal into its vault, which is the person's to hand over",
    hostSide: HOST_SIDE_VAULT,
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents key takes one agent.", usageIs(ctx));
      if (ctx.io.isTTY !== true) throw usageRefusal("nobody is at this terminal to paste a token.", "Run it in a terminal on the computer the host runs on.");
      const mint = catalogEntry(agent)?.signIn;
      const ask = mint !== undefined && "mint" in mint ? `Run ${mint.mint} in another terminal, then paste the token it prints` : `Paste ${agentName(agent)}'s API key`;
      const key = await ctx.io.askSecret(ask);
      await (await ctx.client()).request("agents.key", { agent, key });
      ctx.io.log(`${agentName(agent)}'s key is in this host's vault; every turn reads it from there.`);
      return 0;
    },
  },
  {
    name: "agents addtools",
    usage: "wsp agents addtools <agent>",
    about: "writes the wsp server into an agent's own config on this computer, the entry wsp mcp install writes, with the wsp skill beside it",
    page: "agent",
    options: {},
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents addtools takes one agent.", usageIs(ctx));
      const added = await addTools(await ctx.client(), agent);
      ctx.out.emit(added, toolsAddedLine(agentName(agent), added.file));
      return 0;
    },
    tool: tool({
      description: `Writes the wsp server into one agent's own MCP config on the computer the app runs on, the same entry wsp mcp install writes, with the wsp skill beside it, and answers the file. ${addToolsHereRefusal}`,
      input: { agent: z.string().describe("the catalog id of the agent, as agents lists it") },
      output: { file: z.string() },
      call: async ({ agent }, deps) => {
        const added = await addTools(await deps.client(), agent);
        return asText(toolsAddedLine(agentName(agent), added.file), added);
      },
    }),
  },
  {
    name: "agents default",
    usage: "wsp agents default <agent>",
    about: "the agent a new thread runs when neither the line nor its project names one; the catalog's first without it",
    page: "agent",
    options: {},
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents default takes one agent.", usageIs(ctx));
      const set = await defaultAgentSet(await ctx.client(), agent);
      ctx.out.emit(set, defaultAgentLine(agent));
      return 0;
    },
    tool: tool({
      description: "Sets the agent a new thread runs when neither its start nor its project names one, on every computer and in the app alike; the catalog's first agent without it. A project's own agent, set with projects_set, wins over it, and an agent turned off on a computer is passed over there. An agent this host runs no thread of is refused naming the ones it runs.",
      input: { agent: z.string().describe(`the catalog id of the agent, one of ${THREAD_AGENTS.join(", ")}`) },
      output: { defaultAgent: z.string() },
      call: async ({ agent }, deps) => asText(defaultAgentLine(agent), await defaultAgentSet(await deps.client(), agent)),
    }),
  },
  {
    name: "agents set",
    usage: "wsp agents set <agent> [--model <slug>] [--effort <word>] [--access <word>] [--hide <model>]... [--show <model>]... [--order <model,model>] [--add-model <id>]... [--drop-model <id>]... [--reset <field>]...",
    about: "an agent's defaults on every computer: the model, effort and access a new thread on it starts on, and which models its picker lists",
    page: "agent",
    options: { model: { type: "string" }, effort: { type: "string" }, access: { type: "string" }, hide: { type: "string", multiple: true }, show: { type: "string", multiple: true }, order: { type: "string" }, "add-model": { type: "string", multiple: true }, "drop-model": { type: "string", multiple: true }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents set takes one agent.", usageIs(ctx));
      const order = flag(ctx.flags, "order");
      const set = await agentDefaultsSet(await ctx.client(), agent, {
        ...(flag(ctx.flags, "model") !== undefined ? { model: flag(ctx.flags, "model")! } : {}),
        ...(flag(ctx.flags, "effort") !== undefined ? { effort: flag(ctx.flags, "effort")! } : {}),
        ...(flag(ctx.flags, "access") !== undefined ? { access: flag(ctx.flags, "access")! } : {}),
        hide: flagList(ctx.flags, "hide"),
        show: flagList(ctx.flags, "show"),
        ...(order !== undefined ? { order: order.split(",").map(m => m.trim()).filter(m => m !== "") } : {}),
        addModel: flagList(ctx.flags, "add-model"),
        dropModel: flagList(ctx.flags, "drop-model"),
        reset: flagList(ctx.flags, "reset"),
      });
      ctx.out.emit({ agent, defaults: set }, agentDefaultsLine(agent, set));
      return 0;
    },
    tool: tool({
      description: `Sets one agent's defaults, the same on every computer and in the app: the model and effort a new thread on it starts on, its access, and its model picker: models hidden from it (a start still takes one by name), the order it lists models in, and model ids the binary does not list that the person runs anyway, which a start then takes. A project's own model, effort and access, set with projects_set, win over these, and what a start names wins over both. An access word the agent maps to none of its modes is refused naming the ones it takes. reset puts a field back on the agent's own: model, effort, access or models.`,
      input: {
        agent: z.string().describe("the catalog id of the agent, as agents lists it"),
        model: z.string().optional().describe("the model a new thread on it starts on, by the agent's own slug"),
        effort: z.string().optional().describe("the effort a new thread on it starts at, by the agent's own word, where its model takes that one"),
        access: z.string().optional().describe(ACCESS_IN_WORDS),
        hide: z.array(z.string()).optional().describe("models to take off its picker, by slug"),
        show: z.array(z.string()).optional().describe("hidden models to put back on its picker, by slug"),
        order: z.array(z.string()).optional().describe("the models its picker lists first, in this order, by slug; the rest follow in the agent's own order"),
        add_model: z.array(z.string()).optional().describe("model ids the binary does not list that a start may name and the picker shows"),
        drop_model: z.array(z.string()).optional().describe("model ids added before, taken back off"),
        reset: z.array(z.enum(AGENT_SET_RESETS)).optional().describe("fields to put back on the agent's own: model, effort, access, models"),
      },
      output: { agent: z.string(), defaults: AgentDefaults },
      call: async ({ agent, model, effort, access, hide, show, order, add_model, drop_model, reset }, deps) => {
        const set = await agentDefaultsSet(await deps.client(), agent, {
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
          ...(access !== undefined ? { access } : {}),
          ...(hide !== undefined ? { hide } : {}),
          ...(show !== undefined ? { show } : {}),
          ...(order !== undefined ? { order } : {}),
          ...(add_model !== undefined ? { addModel: add_model } : {}),
          ...(drop_model !== undefined ? { dropModel: drop_model } : {}),
          ...(reset !== undefined ? { reset } : {}),
        });
        return asText(agentDefaultsLine(agent, set), { agent, defaults: set });
      },
    }),
  },
  {
    name: "agents setup",
    usage: "wsp agents setup <agent> [--on <computer>] [--enable | --disable] [--program <path>] [--config <folder>] [--arg <word>]... [--env <NAME>]... [--unset-env <NAME>]... [--reset <field>]...",
    about: "how an agent runs on one computer: on or off there, the program run in its place, its config folder, words added to every launch and variables every launch carries, each value typed where nothing echoes it",
    page: "agent",
    options: { on: { type: "string" }, enable: { type: "boolean" }, disable: { type: "boolean" }, program: { type: "string" }, config: { type: "string" }, arg: { type: "string", multiple: true }, env: { type: "string", multiple: true }, "unset-env": { type: "string", multiple: true }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [agent, ...rest] = ctx.args;
      if (agent === undefined || rest.length > 0) throw usageRefusal("wsp agents setup takes one agent.", usageIs(ctx));
      if (ctx.flags["enable"] === true && ctx.flags["disable"] === true) throw usageRefusal("--enable and --disable say two things.", "Name one.");
      const names = flagList(ctx.flags, "env").map(name => envNameOf(name, "--env"));
      for (const name of names) {
        const refused = agentEnvRefusal(name, agentName(agent));
        if (refused !== null) throw usageRefusal(`${refused}.`, ENV_REFUSED_FIX);
      }
      if (names.length > 0 && ctx.io.isTTY !== true) throw usageRefusal("nobody is at this terminal to type a variable's value.", "Run it in a terminal on the computer the host runs on.");
      const values: Record<string, string> = {};
      for (const name of names) values[name] = await ctx.io.askSecret(`${name} for ${agentName(agent)}`);
      const config = flag(ctx.flags, "config");
      const row = await agentSetupSet(
        await ctx.client(),
        agent,
        {
          ...(flag(ctx.flags, "on") !== undefined ? { on: flag(ctx.flags, "on")! } : {}),
          ...(ctx.flags["enable"] === true ? { enabled: true } : ctx.flags["disable"] === true ? { enabled: false } : {}),
          ...(flag(ctx.flags, "program") !== undefined ? { program: flag(ctx.flags, "program")! } : {}),
          ...(config !== undefined ? { config } : {}),
          args: flagList(ctx.flags, "arg"),
          unsetEnv: flagList(ctx.flags, "unset-env"),
          reset: flagList(ctx.flags, "reset"),
        },
        values,
        usageIs(ctx),
      );
      ctx.out.emit({ agent: row }, agentSetupLines(row, config !== undefined).join("\n"));
      return 0;
    },
    tool: tool({
      description: `Sets how one agent runs on one computer, this computer without on: whether it is offered there at all (off, the app's lists drop it there and a start naming it is refused naming the computer), the program run in its place, the folder it keeps its config, sessions and sign-in in (an agent with no variable for one is refused, and a folder that is not under that computer's home once its links are followed, the home itself, or wsp's own folder; a login kept under the old folder does not follow, so sign it in again there), words added to every turn's launch, and variables taken off its launch. A variable that decides how the process starts or what it loads (PATH, HOME, LD_ and DYLD_ ones, NODE_OPTIONS and the like) is never set, nor one of wsp's own. A variable's value is never taken here: the person types it at wsp agents setup --env, where nothing echoes it. Answers the agent's row as that computer's read now gives it, its variables by name alone. reset puts back the agent's own program, config or args.`,
      input: {
        agent: z.string().describe("the catalog id of the agent, as agents lists it"),
        on: z.string().optional().describe("the computer it runs on, by the name computers lists; absent is the computer the app runs on"),
        enabled: z.boolean().optional().describe("false turns the agent off on that computer, true back on"),
        program: z.string().optional().describe("the program run in the agent's place there, a path or a word on that computer's PATH"),
        config: z.string().optional().describe("the folder on that computer the agent keeps its config, sessions and sign-in in, absolute"),
        args: z.array(z.string()).optional().describe("words added to every turn's launch there, each passed as one word; they replace any set before"),
        unset_env: z.array(z.string()).optional().describe("variables to take off its launch there, by name"),
        reset: z.array(z.enum(AGENT_SETUP_RESETS)).optional().describe("fields to put back on the agent's own: program, config, args"),
      },
      output: { agent: AgentRow },
      call: async ({ agent, on, enabled, program, config, args, unset_env, reset }, deps) => {
        const row = await agentSetupSet(
          await deps.client(),
          agent,
          { ...(on !== undefined ? { on } : {}), ...(enabled !== undefined ? { enabled } : {}), ...(program !== undefined ? { program } : {}), ...(config !== undefined ? { config } : {}), ...(args !== undefined ? { args } : {}), ...(unset_env !== undefined ? { unsetEnv: unset_env } : {}), ...(reset !== undefined ? { reset } : {}) },
          {},
          "agents_setup takes on, a computer by name",
        );
        return asText(agentSetupLines(row, config !== undefined).join("\n"), { agent: row });
      },
    }),
  },
  {
    name: "servers signin",
    usage: "wsp servers signin <name> --agent <id> [<workspace>] [--on <computer>]",
    about: "signs one MCP server in by its agent's own command for it, run where the server is set up and shown in this terminal",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" } },
    cliOnly: "runs the harness's own sign-in for the server in a terminal a person types into, where the page's answer is pasted",
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers signin takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers signin needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const on = flag(ctx.flags, "on");
      const target = await agentsTarget(await ctx.client(), workspace, on, usageIs(ctx));
      const where = workspace ?? on ?? THIS_COMPUTER;
      const answer = await signInHere(ctx, target, { agent, name }, where);
      ctx.io.log(signedInLine(name, where, answer));
      return answer.signedIn ? 0 : 1;
    },
  },
  {
    name: "servers tools",
    usage: "wsp servers tools <name> --agent <id> [<workspace>] [--on <computer>] [--project <name>] [--refresh]",
    about: "starts one MCP server once where it is set up and lists its tools with their descriptions, and says whether it needs a sign-in",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, project: { type: "string", valueWith: "on" }, refresh: { type: "boolean" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers tools takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers tools needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const project = toolsProject(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const answer = await serverToolsOf(await ctx.client(), name, agent, workspace, flag(ctx.flags, "on"), ctx.flags["refresh"] === true, usageIs(ctx), project);
      ctx.out.emit(answer, toolLines(name, answer).join("\n"));
      return 0;
    },
    tool: tool({
      description: `One MCP server's tools with their descriptions, and its sign-in as that one connect found it (open, signed in, needs a sign-in, failed, or unknown), with why nothing came back where nothing did. ${SERVER_TOOLS_WORDS}`,
      input: {
        name: z.string().describe("the server's name, as servers lists it"),
        agent: z.string().describe("the catalog id of the agent whose config names it, as servers lists it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        project: z.string().optional().describe("the project on that computer whose server it is, by the name projects lists, with on; a workspace finds its own project's servers"),
        refresh: z.boolean().optional().describe("start it again even where an answer from the last three minutes stands"),
      },
      output: ServerToolsAnswer.shape,
      call: async ({ name, agent, workspace, on, project, refresh }, deps) => {
        const usage = aimedUsage("servers_tools");
        const answer = await serverToolsOf(await deps.client(), name, agent, workspace, on, refresh === true, usage, toolsProject(project, workspace, on, usage));
        return asText(toolLines(name, answer).join("\n"), answer);
      },
    }),
  },
  {
    name: "servers add",
    usage: "wsp servers add <name> [<workspace>] [--on <computer>] --agent <id> (--command \"<line>\" | --url <address> [--header <name>=<VARIABLE>]...) [--env <NAME>]... [--project [<name>]]",
    about: "writes one MCP server into an agent's own config: a command with its arguments and variables, or an address with its headers, each value read off this terminal's environment and written into that file on this computer, a variable's value kept in the vault as well; on any other the file names a variable and the value goes to the vault, an argument or the address naming a variable as ${NAME} keeps that name there, and an agent that reads no variable there refuses it",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, command: { type: "string" }, env: { type: "string", multiple: true }, url: { type: "string" }, header: { type: "string", multiple: true }, project: { type: "string", valueWith: "on" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers add takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers add needs --agent, the agent whose config takes the server.", usageIs(ctx));
      const command = flag(ctx.flags, "command");
      const url = flag(ctx.flags, "url");
      const values = serverValues(ctx.env, flagList(ctx.flags, "env"), flagList(ctx.flags, "header"), usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const body = { agent, name, ...serverCommand(command, usageIs(ctx)), ...(url !== undefined ? { url } : {}), ...values, ...(project.project ? { project: true } : {}) };
      const added = await serverChanged(await ctx.client(), "servers.add", body, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
      ctx.out.emit(added, isInLine(name, added.file));
      return 0;
    },
    tool: tool({
      description: `Writes one MCP server into one agent's own config on one computer or workspace, the project's file with project from a workspace: a command with its arguments and the variables it is given, or an address with its headers. Every value is read by name off the environment the wsp tools run with and never goes into an answer: on this computer it goes into that file, a variable's value into the vault as well, and on any other the file names a variable and the value goes to the vault, which hands it to each turn there: on a computer the person added only to Claude Code and Codex, in that turn's launch and never its environment, and not to a Codex server that reads its token through its bearer variable; elsewhere in the turn's environment. An argument or the address may name one of those variables as \${NAME}, an address's variables being only the ones it names: on this computer the value is put in place, on any other the name stays in the agent's own syntax, and an agent that reads no variable there is refused. A name already in the file is refused rather than written over. ${SERVER_CHANGE_WORDS}`,
      input: {
        name: z.string().describe("what to call the server in the agent's config"),
        agent: z.string().describe("the catalog id of the agent whose config takes it"),
        workspace: AgentsWorkspaceIn,
        on: AgentsOnIn,
        command: z.string().optional().describe("the line the server runs, the program and its arguments as a shell would split them, nothing expanded; or url"),
        env: z.array(z.string()).optional().describe("variables the server is given, or the address names as ${NAME}, each by its name, its value read off the same name in the environment the wsp tools run with; an argument or the address may name one as ${NAME}"),
        url: z.string().optional().describe("the server's https address; or command"),
        header: z.array(z.string()).optional().describe("headers sent to the address, each <name>=<VARIABLE>, its value read off that variable in the environment the wsp tools run with"),
        project: z.union([z.boolean(), z.string()]).optional().describe("put it in a project's file rather than the agent's own: true for the workspace's own project, or the project's name, as projects lists it, with on"),
      },
      output: { file: z.string() },
      call: async ({ name, agent, workspace, on, command, env, url, header, project }, deps) => {
        const usage = aimedUsage("servers_add");
        const values = serverValues(deps.env, env ?? [], header ?? [], usage);
        const asked = projectAsked(project, workspace, on, usage);
        const body = { agent, name, ...serverCommand(command, usage), ...(url !== undefined ? { url } : {}), ...values, ...(asked.project ? { project: true } : {}) };
        const added = await serverChanged(await deps.client(), "servers.add", body, workspace, on, usage, asked.name);
        return asText(isInLine(name, added.file), added);
      },
    }),
  },
  {
    name: "servers remove",
    usage: "wsp servers remove <name> [<workspace>] [--on <computer>] --agent <id> [--scope <user|home|project>] [--project [<name>]] [--yes]",
    about: "takes one MCP server's entry out of an agent's own config, every other line of the file as it was, and, once no agent's config on this computer lists that server, frees the vault's values kept for it that no other server holds",
    page: "agent",
    options: { agent: { type: "string" }, on: { type: "string" }, scope: { type: "string" }, project: { type: "string", valueWith: "on" }, yes: { type: "boolean" } },
    run: async ctx => {
      const [name, workspace, ...rest] = ctx.args;
      const agent = flag(ctx.flags, "agent");
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp servers remove takes one server's name and one workspace at most.", usageIs(ctx));
      if (agent === undefined) throw usageRefusal("wsp servers remove needs --agent, the agent whose config names the server, as wsp servers shows it.", usageIs(ctx));
      const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
      const scope = serverScope(flag(ctx.flags, "scope"), usageIs(ctx), project);
      if (!(await confirmed(ctx, `Remove ${name} from the ${agent} config?\nEvery other line of the file stays.`, name))) return 1;
      const removed = await serverChanged(await ctx.client(), "servers.remove", { agent, name, ...scope }, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
      ctx.out.emit(removed, goneFromLine(name, removed.file));
      return 0;
    },
    tool: tool({
      description: `Takes one MCP server's entry out of one agent's own config on one computer or workspace, in the scope servers lists it under, every other server and line of the file as it was, and, once no agent's config on this computer lists that server, frees the vault's values kept for it that no other server holds. ${SERVER_CHANGE_WORDS}`,
      input: { name: ServerNameIn, agent: ServerAgentIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, scope: ServerScopeIn, project: ServerProjectIn },
      output: { file: z.string() },
      call: async ({ name, agent, workspace, on, scope, project }, deps) => {
        const usage = aimedUsage("servers_remove");
        const asked = projectAsked(project, workspace, on, usage);
        const removed = await serverChanged(await deps.client(), "servers.remove", { agent, name, ...serverScope(scope, usage, asked) }, workspace, on, usage, asked.name);
        return asText(goneFromLine(name, removed.file), removed);
      },
    }),
  },
  ...(["disable", "enable"] as const).map(
    (word): Verb => ({
      name: `servers ${word}`,
      usage: `wsp servers ${word} <name> [<workspace>] [--on <computer>] --agent <id> [--scope <user|home|project>] [--project [<name>]]`,
      about: word === "disable" ? "turns one MCP server off by the switch its agent reads, so the agent leaves it out until it is turned on" : "turns an MCP server that was turned off on again",
      page: "agent",
      options: { agent: { type: "string" }, on: { type: "string" }, scope: { type: "string" }, project: { type: "string", valueWith: "on" } },
      run: async ctx => {
        const [name, workspace, ...rest] = ctx.args;
        const agent = flag(ctx.flags, "agent");
        if (name === undefined || rest.length > 0) throw usageRefusal(`wsp servers ${word} takes one server's name and one workspace at most.`, usageIs(ctx));
        if (agent === undefined) throw usageRefusal(`wsp servers ${word} needs --agent, the agent whose config names the server, as wsp servers shows it.`, usageIs(ctx));
        const project = projectAsked(ctx.flags["project"] as string | undefined, workspace, flag(ctx.flags, "on"), usageIs(ctx));
        const scope = serverScope(flag(ctx.flags, "scope"), usageIs(ctx), project);
        const changed = await serverChanged(await ctx.client(), "servers.toggle", { agent, name, ...scope, on: word === "enable" }, workspace, flag(ctx.flags, "on"), usageIs(ctx), project.name);
        ctx.out.emit(changed, turnedInLine(name, word === "enable", changed.file));
        return 0;
      },
      tool: tool({
        description: `Turns one MCP server ${word === "enable" ? "on again" : "off"} in one agent's own config on one computer or workspace, by the switch that agent reads (Codex's enabled line, OpenCode's enabled field, Gemini CLI's mcp.excluded); Claude Code keeps no such switch per server and is refused. ${SERVER_CHANGE_WORDS}`,
        input: { name: ServerNameIn, agent: ServerAgentIn, workspace: AgentsWorkspaceIn, on: AgentsOnIn, scope: ServerScopeIn, project: ServerProjectIn },
        output: { file: z.string() },
        call: async ({ name, agent, workspace, on, scope, project }, deps) => {
          const usage = aimedUsage(`servers_${word}`);
          const asked = projectAsked(project, workspace, on, usage);
          const changed = await serverChanged(await deps.client(), "servers.toggle", { agent, name, ...serverScope(scope, usage, asked), on: word === "enable" }, workspace, on, usage, asked.name);
          return asText(turnedInLine(name, word === "enable", changed.file), changed);
        },
      }),
    }),
  ),
];
