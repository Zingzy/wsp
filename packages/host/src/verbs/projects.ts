// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from "node:path";
import { z } from "zod";
import { THREAD_AGENTS } from "@wsp/catalog";
import { nodeHost } from "@wsp/collect";
import {
  ThreadDefaults,
  COORDINATOR_HANDOFF,
  LOGIN_CHOICES,
  NOTIFY_CALLER,
  RECIPE_TICKS,
  RecipeTick,
  usageRefusal,
  ProjectView,
  addedProjectLine,
  MEMORY_KEPT_CLAUSE,
} from "@wsp/protocol";
import { RecipeAnswer, RecipeScan, recipePrintout, scanPrintout } from "../recipe-answer.js";
import { isRecipeTick, runRecipe, runScan } from "../recipe-command.js";
import { historyCache, smallRecipePath } from "../recipe-file.js";
import { HOST_RESTARTING_LINE, hostPlatform, table, usageIs, tool, type Verb, flag, flagList, absolutePath } from "./client.js";
import { workspaces, threads, threadsOf, threadRows, THREAD_HEAD, threadLines, threadTree, placeNames, projectsOf, projectOf, projectLine, NO_PROJECT_YET } from "./workspaces-help.js";
import { projectDefaultsOf, waitThrough } from "./turns-help.js";
import { confirmed, WaitOut, ThreadRowOut, asJson, asText, waitAnswer, timeoutFlag, ACCESS_IN_WORDS, PROJECT_FOLDERS, WEIGH_BY_FOLDERS, projectFolders, projectsFlag, progress, printTable } from "./io.js";
import { drawRows, PROJECT_SET_RESETS, projectDefaultsSet, newThreadsHeadLine, threadDefaultsLines, defaultsCell, afterWorktreeLine } from "./agents-help.js";

/** What projects set answers in words: what a new thread there starts on, then the after-worktree command. */
const projectSetLines = (set: { project: ProjectView; defaults: ThreadDefaults; afterWorktree?: string }): string[] => [
  newThreadsHeadLine(set.project.name),
  ...threadDefaultsLines(set.defaults),
  ...(set.afterWorktree !== undefined ? [afterWorktreeLine(set.afterWorktree)] : []),
];

export const PROJECT_VERBS: readonly Verb[] = [
  {
    name: "projects",
    usage: "wsp projects",
    about: "your projects, each on its computer: where its code comes from, where its folder sits, the branch a machine of it starts on and how many threads it has",
    page: "front",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp projects takes no positional arguments.", usageIs(ctx));
      const client = await ctx.client();
      const projects = await projectsOf(client);
      const held = projects.length === 0 ? [] : await workspaces(client);
      const running = projects.length === 0 ? [] : await threads(client);
      // The computer's own name, off the one places reading every other table takes; a thread's token is refused
      // that list, and its rows then read the id, which is what it can name a computer by anyway.
      const named = projects.length === 0 ? new Map<string, string>() : await placeNames(client).catch(() => new Map<string, string>());
      const defaults = projects.length === 0 ? {} : await projectDefaultsOf(client);
      ctx.out.emit({ projects, defaults }, projects.length === 0 ? NO_PROJECT_YET : table([["PROJECT", "ID", "COMPUTER", "SOURCE", "PATH", "BASE", "THREADS", "NEW THREADS"], ...projects.map(p => [...projectLine(p, held, running, named), defaultsCell(defaults[p.id])])]).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every project this host holds: its name, the computer it lives on, where its code comes from (a folder on the computer the app runs on, or a repo a computer clones), where its folder sits, the branch a machine of it starts on, and its repo's top folder where it is a folder here inside a git repo. The name is what run takes. A project is recorded with add and is one source on one computer; on the computer the app runs on its threads run in its folder, or in a worktree of its repo for another branch. defaults holds, by project id, the agent, model, effort and access a new thread there starts on when its start names none, each with where it came from: the project's own (projects_set), the person's default (agents_set, agents_default) or the agent's own.",
      input: {},
      output: { projects: z.array(ProjectView), defaults: z.record(z.string(), ThreadDefaults) },
      call: async (_args, deps) => {
        const client = await deps.client();
        return asJson({ projects: await projectsOf(client), defaults: await projectDefaultsOf(client) });
      },
    }),
  },
  {
    name: "projects add",
    toolOnly:
      "the command line records a project with wsp add, the same word that joins a computer and takes a provider's key; those two belong at the terminal the host runs at, so the tool door carries the project half alone",
    tool: tool({
      description:
        "Records a project: one source on one computer. A folder on the computer the app runs on is the project as it stands, a git repo or not, a folder inside a repo being a project of that repo; its threads run in it. A repo is cloned into the empty folder named with into on the computer the app runs on, which is then a folder project there, or by the computer named with on, whose machines then hold a checkout of it. A repo with neither into nor on, a folder to clone into that holds something, and a source already recorded on that computer are each refused in one line, and a clone that fails says git's own last line. The answer is the project, whose name is what run takes.",
      input: {
        source: z.string().describe("a folder on the computer the app runs on, or a repo's url"),
        on: z.string().optional().describe("the computer that clones the repo, by the name computers lists; a folder, and a repo cloned with into, take none"),
        into: z.string().optional().describe("an absolute path on the computer the app runs on, absent or an empty folder, to clone the repo into; the project is then that folder"),
        name: z.string().optional().describe("what to call the project here; the folder's or the repo's own last word without it"),
        base: z.string().optional().describe("the branch a machine of the project starts on; the remote's own default branch at the clone without it"),
      },
      output: { project: ProjectView, notice: z.string().optional() },
      call: async (args, deps) => {
        const client = await deps.client();
        const { project, notice } = await client.request<{ project: ProjectView; notice?: string }>("projects.add", {
          source: args.source,
          ...(args.on !== undefined ? { on: args.on } : {}),
          ...(args.name !== undefined ? { name: args.name } : {}),
          ...(args.base !== undefined ? { base: args.base } : {}),
          ...(args.into !== undefined ? { into: args.into } : {}),
        });
        const named = await placeNames(client).catch(() => new Map<string, string>());
        // What landed and is not what was asked for rides the answer: an add that stands with the commits left
        // behind reads as an add that stands, and the caller has to be told which.
        const said = addedProjectLine(project, named, hostPlatform());
        return asText(notice === undefined ? said : `${said}\n${notice}`, { project, ...(notice !== undefined ? { notice } : {}) });
      },
    }),
  },
  {
    name: "projects remove",
    usage: "wsp projects remove <project> [--yes] [--force]",
    about: "takes a project out of this wsp; its folder is left where it is, on this computer or on a computer you joined, a project with a machine standing on it is refused naming them, and one whose checkout on a computer of yours holds work no remote has is stopped naming it",
    page: "agent",
    options: { yes: { type: "boolean" }, force: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp projects remove takes one project.", usageIs(ctx));
      const client = await ctx.client();
      const project = await projectOf(client, ref);
      const force = ctx.flags["force"] === true ? { force: true } : {};
      // The host's own refusals first, so the one question is asked only of a remove that would go.
      const { unsaved } = await client.request<{ unsaved?: string }>("projects.remove", { projectId: project.id, check: true, ...force });
      const losing = unsaved === undefined ? "" : `\nWith it goes work no remote has: ${unsaved}.`;
      if (!(await confirmed(ctx, `Remove ${project.name}?\nIts record leaves this wsp, with the folder wsp made for it on the computer holding it; a folder of yours stays where it is.${losing}`, project.name))) return 1;
      // The sentence comes off the wire: what a remove took is true differently on a computer of the person's, at
      // a provider and on this computer, and the runtime's own road for that computer is what says which.
      const { said } = await client.request<{ said: string }>("projects.remove", { projectId: project.id, ...force });
      ctx.out.emit({ project, said }, said);
      return 0;
    },
    tool: tool({
      description: `Takes a project's record out of this wsp. Its folder stays exactly where it is, on this computer or on a computer you joined, ${MEMORY_KEPT_CLAUSE}, and no repo is ever asked for anything. Refused in one line while a machine of it stands, naming them; delete those first. Refused in one line too while its checkout on a computer of yours holds work no remote has, naming it by its path there, unless force.`,
      input: {
        project: z.string().describe("the project's name, or its id when two share a name"),
        force: z.boolean().optional().describe("remove it even where its checkout on a computer of yours holds work no remote has"),
      },
      output: { project: ProjectView, said: z.string() },
      call: async ({ project: ref, force }, deps) => {
        const client = await deps.client();
        const project = await projectOf(client, ref);
        const { said } = await client.request<{ said: string }>("projects.remove", { projectId: project.id, ...(force === true ? { force: true } : {}) });
        return asText(said, { project, said });
      },
    }),
  },
  {
    name: "projects set",
    usage: "wsp projects set <project> [--agent <id>] [--model <slug>] [--effort <word>] [--access <word>] [--after-worktree <command>] [--reset <field>]...",
    about: "what a new thread on one project starts on, over the agent's own defaults: its agent, model, effort and access; and the shell line a new worktree of it runs once, after each ecosystem's own install, for what none of them knows",
    page: "agent",
    options: { agent: { type: "string" }, model: { type: "string" }, effort: { type: "string" }, access: { type: "string" }, "after-worktree": { type: "string" }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [ref, ...rest] = ctx.args;
      if (ref === undefined || rest.length > 0) throw usageRefusal("wsp projects set takes one project.", usageIs(ctx));
      const set = await projectDefaultsSet(await ctx.client(), ref, {
        ...(flag(ctx.flags, "agent") !== undefined ? { agent: flag(ctx.flags, "agent")! } : {}),
        ...(flag(ctx.flags, "model") !== undefined ? { model: flag(ctx.flags, "model")! } : {}),
        ...(flag(ctx.flags, "effort") !== undefined ? { effort: flag(ctx.flags, "effort")! } : {}),
        ...(flag(ctx.flags, "access") !== undefined ? { access: flag(ctx.flags, "access")! } : {}),
        ...(flag(ctx.flags, "after-worktree") !== undefined ? { afterWorktree: flag(ctx.flags, "after-worktree")! } : {}),
        reset: flagList(ctx.flags, "reset"),
      });
      ctx.out.emit(set, projectSetLines(set).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Sets what a new thread on one project starts on, over each agent's own defaults and under what a start names: its agent, model, effort and access. Nothing about a computer is a project's to set (threads at once, an agent's program, config folder, launch words, variables, or whether it is on); agents_setup sets those per computer. A model or effort kept for the project's agent drops to the agent's own on a thread that runs another agent, and an access word the project's agent maps to none of its modes is refused naming the ones it takes. after_worktree is a shell line a new worktree of the project runs once at its top, after the locked install of each ecosystem whose lockfile it holds, each run in the folder holding that lockfile (uv sync --locked, cargo fetch --locked, go list -mod=readonly -deps -test ./..., npm install --no-save, pnpm install --frozen-lockfile where the node_modules carried in were installed from another lockfile, and the like), for what none of them knows. Answers what a new thread there now starts on, each value with where it came from, and the after-worktree command. reset puts a field back on the layer below: agent, model, effort or access, and after-worktree takes the command away.",
      input: {
        project: z.string().describe("the project's name, or its id when two share a name"),
        agent: z.string().optional().describe(`the agent a new thread on it runs, one of ${THREAD_AGENTS.join(", ")}`),
        model: z.string().optional().describe("the model a new thread on it starts on, by the agent's own slug"),
        effort: z.string().optional().describe("the effort a new thread on it starts at, by the agent's own word"),
        access: z.string().optional().describe(ACCESS_IN_WORDS),
        after_worktree: z.string().optional().describe("a shell line a new worktree of the project runs once at its top, after each ecosystem's own install"),
        reset: z.array(z.enum(PROJECT_SET_RESETS)).optional().describe("fields to put back on the layer below: agent, model, effort, access, or after-worktree to take the command away"),
      },
      output: { project: ProjectView, defaults: ThreadDefaults, afterWorktree: z.string().optional() },
      call: async ({ project, agent, model, effort, access, after_worktree, reset }, deps) => {
        const set = await projectDefaultsSet(await deps.client(), project, { ...(agent !== undefined ? { agent } : {}), ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}), ...(access !== undefined ? { access } : {}), ...(after_worktree !== undefined ? { afterWorktree: after_worktree } : {}), ...(reset !== undefined ? { reset } : {}) });
        return asText(projectSetLines(set).join("\n"), set);
      },
    }),
  },
  {
    name: "threads",
    usage: "wsp threads [<project>] [--tree] [--watch]",
    about: "who is working, where and on which computer: every thread as the sidebar lists it, with its project, the folder it works in, that folder's branch, the agent, the state and who opened it, and under each thread the agent's own subagents with their SUBAGENT id; --tree indents the threads an agent spawned under the one that spawned them, and --watch draws the same table again every second where it stands",
    page: "front",
    options: { tree: { type: "boolean" }, watch: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal("wsp threads takes at most one project; wsp threads wait is its one subcommand, and wsp thread read <thread> prints what one said.", usageIs(ctx));
      return drawRows(ctx, "wsp threads", async client => {
        const rows = await threadRows(client, ctx.args[0]);
        const lines = ctx.flags["tree"] === true ? threadTree(rows).flatMap(t => threadLines(t.row, "  ".repeat(t.depth))) : rows.flatMap(t => threadLines(t));
        return { value: { threads: rows }, rows: table([THREAD_HEAD, ...lines]) };
      });
    },
    tool: tool({
      description:
        "Every thread as the sidebar lists it: its project, the folder it works in (the project folder, or a worktree of the project's repo), that folder's branch as git reads it now, the computer it runs on, the agent inside, its state, who opened it (person, cli or agent) and its title. claudeSessionId is the agent's own id for the thread's session, absent until the agent announced one; for a Claude Code thread on this computer, cd into folder and run claude --resume with it to go on with the thread in a terminal, once the thread is not running; a thread on another computer goes on in a terminal there, its line also setting the CLAUDE_CONFIG_DIR its turns run with, as the app's Continue in terminal copies it. capped is on a thread waiting for a slot on its computer: the computer and what runs there against its threads at once; it starts on its own when one frees. Optionally within one project. A thread an agent inside another thread opened carries parentThreadId and rootThreadId, which is the tree stop ends as one. lastLine is the last line of the latest turn's reply and failure why that turn failed. subagents lists the agent's own subagents of every turn (id, title, state running, done, failed or stopped, model, asked: the start of what it was asked, lastLine or failure once it ends); stop takes one of them alone by its id.",
      input: { project: z.string().optional().describe("one project's threads, by the name or the id projects lists") },
      output: { threads: z.array(ThreadRowOut) },
      call: async ({ project: within }, deps) => asJson({ threads: await threadRows(await deps.client(), within) }),
    }),
  },
  {
    name: "threads wait",
    usage: "wsp threads wait <thread>... [--timeout <s>] [--tail]",
    about:
      "blocks until one of the threads leaves running and prints its finished line, with the reply whole under it; --tail prints the reply's last line alone, which is what a notify sends, and --timeout gives up after so many seconds and says so on stderr",
    page: "agent",
    options: { timeout: { type: "string" }, tail: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length === 0) throw usageRefusal("wsp threads wait takes one thread or more.", usageIs(ctx));
      const timeoutMs = timeoutFlag(flag(ctx.flags, "timeout"));
      const named = await threadsOf(await ctx.client(), ctx.args);
      // The whole reply unless the tail was asked for: a last line is a paragraph's end or a code fence, and a
      // person waiting on a thread is waiting for its answer, not for the shape of its final line.
      const waited = await waitThrough(ctx, named, timeoutMs, () => ctx.io.error(HOST_RESTARTING_LINE));
      const { value, line } = waitAnswer(named, waited, ctx.flags["tail"] === true ? "tail" : "whole");
      if (value.timedOut === true) {
        ctx.out.emit(value);
        ctx.io.error(line);
      } else ctx.out.emit(value, line);
      return 0;
    },
    tool: tool({
      description: `Blocks until one of the named threads leaves running and answers with that thread's end: its id, status (completed, interrupted or failed), how long it worked, what it cost and the last line of its reply, the text being the one line a notify sends. One thread per call: a caller that started three builders calls this three times, dropping each returned id from the list, since a thread already over comes back at once and would come back again. With timeout, the seconds to wait before answering with nothing and timedOut true, so other work fits between calls; keep it under your own tool call limit and call again. This blocks, so it is for a shell script and not for your own conversation. ${NOTIFY_CALLER}. ${COORDINATOR_HANDOFF}. Never poll threads for a state change.`,
      input: {
        threads: z.array(z.string()).min(1).describe("thread ids, or prefixes that each pick one"),
        timeout: z.number().positive().optional().describe("seconds to wait; absent waits until one of the threads finishes"),
      },
      output: WaitOut.shape,
      call: async ({ threads: refs, timeout }, deps) => {
        const named = await threadsOf(await deps.client(), refs);
        const { value, line } = waitAnswer(named, await waitThrough(deps, named, timeout === undefined ? undefined : timeout * 1_000));
        return asText(line, value);
      },
    }),
  },
  {
    name: "recipe scan",
    readsHere: "the agents, package managers and history it reads are this computer's own",
    usage: "wsp recipe scan [--project <folder>]",
    about:
      "read this computer and print every option, writing nothing: the agents, the tools with why and size, what else a package manager here has that the image could take, the commands your agents ran, and the sign-ins, each with what to do about it and one line of why; --project weighs the histories by a folder and --json prints it as one object",
    page: "agent",
    options: { project: { type: "string", multiple: true } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe scan takes no positional arguments.", usageIs(ctx));
      const host = nodeHost();
      const scan = await runScan(host, { ...projectsFlag(ctx.flags), cache: historyCache(ctx.statePath), ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}) }, progress(ctx.io));
      printTable(ctx, scan, depth => scanPrintout(scan, host.platform, depth), `Nothing was written. Take the do column with wsp recipe --set <id>=on and --signin <id>=machine, then run wsp init --recipe ${resolve(smallRecipePath(ctx.statePath))}.`);
      return 0;
    },
    tool: tool({
      description:
        "Every option this computer offers for a machine, read once and written nowhere: the person's agents and the catalog's tools with the tick their own use reaches and what each adds to the machine, what else a package manager on this computer has that the image could take (alsoHere, by manager, with the line that installs each on the machine, each row's id being the one to hand recipe's set, which ticks that package as a row of its own), whose scanned says whether anything looked, the commands their agents ran that the catalog does not carry, and the sign-in each ticked row brings. Every row carries a recommended value and a one-line reason, so apply those and put only the rows whose reason says worth a question. Run this before recipe, and before asking the person anything. Only names and counts are read.",
      input: { project: PROJECT_FOLDERS },
      output: RecipeScan.shape,
      call: async ({ project }, deps) => {
        const host = nodeHost();
        const scan = await runScan(host, {
          cache: historyCache(deps.statePath),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(scanPrintout(scan, host.platform).join("\n"), scan);
      },
    }),
  },
  {
    name: "recipe",
    readsHere: "the agents, package managers and history it reads are this computer's own",
    usage: `wsp recipe [--tick ${RECIPE_TICKS.join("|")}] [--set <id>=on|off] [--signin <id>=${LOGIN_CHOICES.join("|")}] [--add <id>=<command>] [--add-check <id>=<command>] [--why <words>] [--engine] [--project <folder>] [--out <path>]`,
    about:
      `write the recipe and print it as a table: every catalog agent and tool with its tick, why it has it and what it costs on the machine, then the commands your agents ran that no catalog row carries. --tick used|installed|default names the rule that decides every tick (used, the default, ticks what your agents actually ran here); --set <id>=on|off flips a row by its catalog id, or a package this computer's own package managers have by the id wsp recipe scan gives it, which the build installs by that package's own road; --signin <id>=${LOGIN_CHOICES.join("|")} answers a sign-in by catalog id, later leaving it to the first time the tool is needed on the machine and key bringing the key files beside a login and nothing else of it; --add <id>=<command> carries a tool neither the catalog nor this computer has, installed by that command on the machine, with --add-check <id>=<command> saying it is there and --why <words> what the rows it adds are for; --engine marks the recipe so every machine from its image gets the place's Docker or podman through a socket of its own (a project whose compose file needs one), and stays in the file until you edit it out; --project reads a folder's own manifests for what it takes to build and weighs the histories by it, --out says where the file goes and --json prints the table as one object. Naming --tick or --project decides every tick again; without either, what the file says stands and the flags flip rows on top of it. A sign-in answer stands either way: no rule decides one. All of them repeat. Review it, then wsp init --recipe`,
    page: "agent",
    options: {
      out: { type: "string" },
      tick: { type: "string" },
      set: { type: "string", multiple: true },
      signin: { type: "string", multiple: true },
      add: { type: "string", multiple: true },
      "add-check": { type: "string", multiple: true },
      why: { type: "string" },
      engine: { type: "boolean" },
      project: { type: "string", multiple: true },
    },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipe takes no positional arguments; wsp recipe scan is its one subcommand.", usageIs(ctx));
      const why = flag(ctx.flags, "why");
      const tick = flag(ctx.flags, "tick");
      if (tick !== undefined && !isRecipeTick(tick)) throw usageRefusal(`--tick takes one of ${RECIPE_TICKS.join(", ")}, and got ${JSON.stringify(tick)}.`, "Name one of those.");
      const out = resolve(flag(ctx.flags, "out") ?? smallRecipePath(ctx.statePath));
      const table = await runRecipe(
        nodeHost(),
        {
          out,
          cache: historyCache(ctx.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(ctx.flags["engine"] === true ? { engine: true } : {}),
          set: flagList(ctx.flags, "set"),
          signin: flagList(ctx.flags, "signin"),
          add: flagList(ctx.flags, "add"),
          addCheck: flagList(ctx.flags, "add-check"),
          ...(why !== undefined ? { why } : {}),
          ...projectsFlag(ctx.flags),
          ...(ctx.alsoHere !== undefined ? { alsoHere: ctx.alsoHere } : {}),
        },
        progress(ctx.io),
      );
      printTable(ctx, table, depth => recipePrintout(table, depth), `Recipe written to ${out}. Review it, flip a row with wsp recipe --set <id>=on, then run wsp init --recipe ${out}.`);
      return 0;
    },
    tool: tool({
      description: `The recipe for a machine, read off this computer and written to a file: every catalog agent and tool with its tick, why it has that tick, and what it adds to the machine, plus the commands the person's agents ran that no catalog row carries. tick names the rule: used ticks what their agents actually ran here, installed ticks what is on this computer, default ticks what the catalog ships on; an agent wsp cannot open a thread on is off unless installed. The file is the state, so a second call is not a fresh start: naming tick or project lets the rule decide every tick again and throws away the flips a call before it made, and a call that names neither keeps what the file says and puts its own flips on top. Sign-in answers stand through every call whatever the rule, since nothing but the person decides one. Put the heavy rows to the person with their sizes before anything is built, then flip rows with set and run \`wsp init --recipe <out> --non-interactive --json\` from a shell, handing the person each sign-in line it prints, since the sign-ins finish in their browser. Only names and counts are read; nothing a session held is returned.`,
      input: {
        tick: RecipeTick.optional().describe(`which rule decides every tick: ${RECIPE_TICKS.join(", ")}. Naming it re-decides every row from the rule, so any flip an earlier call made goes; absent, the file's own rule and its ticks stand, and used decides a first call and any row the file does not carry`),
        set: z.array(z.string()).optional().describe('rows to flip, "<id>=on" or "<id>=off", applied over whatever decided the row: a catalog id, or the id recipe_scan gives a package one of this computer\'s own package managers has (alsoHere), which ticks that package as a row of its own and installs it by its own road. On a call that names tick or project they sit over the rule\'s fresh answer; on any other call they sit over the ticks already in the file'),
        signin: z.array(z.string()).optional().describe(`what happens to a row's sign-in, "<id>=${LOGIN_CHOICES.join("|")}"; key brings the key files beside its login and the login still runs on the machine. An answer already in the file stands until a later call names that row again, whatever tick or project do to the ticks`),
        add: z.array(z.string()).optional().describe('tools neither the catalog carries nor this computer has, "<id>=<install command>"; the line runs on the machine as given after every catalog install, and such a row is never offered a sign-in. A package recipe_scan already lists under alsoHere is refused here and ticked with set instead, since it is a row of its own. Rows an earlier call added stand, whatever tick or project do to the ticks'),
        add_check: z.array(z.string()).optional().describe('what proves an added tool landed, "<id>=<command that exits 0>"; without one the id on PATH is the check'),
        why: z.string().optional().describe("what the rows this call adds are for, in your own words; absent, they say an agent added them"),
        engine: z.boolean().optional().describe("mark the recipe so every machine from its image gets the place's container engine (Docker or podman) through a socket of its own, for a project whose compose file needs one; it stays in the file until edited out"),
        project: WEIGH_BY_FOLDERS,
        out: z.string().optional().describe("where the recipe file goes, absolute; absent means the host's own recipe.json beside its state"),
      },
      output: RecipeAnswer.shape,
      call: async ({ tick, set, signin, add, add_check: addCheck, why, engine, project, out }, deps) => {
        const table = await runRecipe(nodeHost(), {
          out: out === undefined ? smallRecipePath(deps.statePath) : absolutePath("out is a path on this computer", out),
          cache: historyCache(deps.statePath),
          ...(tick !== undefined ? { tick } : {}),
          ...(set !== undefined ? { set } : {}),
          ...(signin !== undefined ? { signin } : {}),
          ...(add !== undefined ? { add } : {}),
          ...(addCheck !== undefined ? { addCheck } : {}),
          ...(why !== undefined ? { why } : {}),
          ...(engine === true ? { engine: true } : {}),
          ...(project !== undefined ? { projects: projectFolders(project) } : {}),
          ...(deps.alsoHere !== undefined ? { alsoHere: deps.alsoHere } : {}),
        });
        return asText(recipePrintout(table).join("\n"), table);
      },
    }),
  },
];
