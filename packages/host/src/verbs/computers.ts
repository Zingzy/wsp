// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import {
  PlaceView,
  NAP_AFTER_MAX_MS,
  napMsOf,
  TURN_LIMIT_MAX_MS,
  turnLimitMsOf,
  usageRefusal,
  PlaceSpend,
  RecipeView,
  PendingComputer,
  AddLine,
  PlaceWait,
  AccountRow,
  UsageRange,
  UsageSplit,
  UsedAnswer,
  USAGE_RANGES,
  USAGE_SPLITS,
  ResetAnswer,
  resetQuestion,
} from "@wsp/protocol";
import { addComputer } from "../setup-follow.js";
import { hostPlatform, computerLines, computerSetLines, recipeLines, recipeShownLines, recipeSavedLine, recipeRemovedLine, oneOf, readUsage, accountNamed, usageTableLines, readComputers, SETTING_RESETS, setComputer, napAsked, turnLimitAsked, dollarsAsked, usageIs, tool, type Verb, flag, flagList } from "./client.js";
import { agentsAsked, countAsked } from "./workspaces-help.js";
import { confirmed, asJson } from "./io.js";

export const COMPUTER_VERBS: readonly Verb[] = [
  {
    name: "computers",
    usage: "wsp computers",
    about: "your computers: this Mac, each box you added<!-- cloud --> and each cloud account<!-- /cloud -->, with what each has, whether it is connected, how many machines it holds and what runs there against its cap<!-- cloud -->, and what each cloud spent today<!-- /cloud -->",
    page: "front",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp computers takes no positional arguments.", usageIs(ctx));
      const read = await readComputers(await ctx.client());
      ctx.out.emit(read, computerLines(read.computers, hostPlatform(), read.spend, read.pending).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every computer this host holds, which is the whole of where work can run: the computer the app runs on<!-- cloud -->, each box joined to it and each cloud account<!-- /cloud --><!-- no cloud --> and each box joined to it<!-- /no cloud -->. A row carries what that computer last reported (cores, memory, free disk, the engine it has for a project's own containers) and whether it is connected right now<!-- cloud -->; a cloud row carries its hourly rate<!-- /cloud -->. Every row carries its cap, threads at once on a computer<!-- cloud --> and machines at once and spend per day on a cloud<!-- /cloud --> (the number the person set, else one thread per 2 GB of memory up to twice its cores<!-- cloud -->, and 3 machines and $10 a day<!-- /cloud -->), and running, every thread running there now on a computer<!-- cloud --> or the machines holding a slot on a cloud<!-- /cloud -->; a row whose running meets its cap is full.<!-- cloud --> spend holds one row per cloud, what it has spent today (since midnight where the host runs) and this month and what it burns an hour now; a cloud whose spend today reaches its spend per day is at its limit and starts no new machine until midnight, while the machines already running there go on.<!-- /cloud --> A row whose copy of the image is building says which stage it is at, and one whose last build stopped says why. A project lives on a computer: on the computer the app runs on its threads run in the project's folder, and on a box<!-- cloud --> or a cloud<!-- /cloud --> they run on a machine forked from the image with the project inside. pending holds every add that has not reached Set up: how far it got, what was chosen for it, and why it stopped where one did.",
      input: {},
      output: { computers: z.array(PlaceView), spend: z.array(PlaceSpend), pending: z.array(PendingComputer) },
      call: async (_args, deps) => asJson(await readComputers(await deps.client())),
    }),
  },
  {
    name: "computers set",
    cloudFlags: ["machines", "spend"],
    usage: "wsp computers set <computer> [--name <new>] [--ssh <login>] [--threads <n>] [--machines <n>] [--spend <usd>] [--nap <minutes>|off] [--turn-limit <hours>|off] [--spawn on|off] [--max-machines <n>] [--max-depth <n>] [--recipe <name>|none] [--reset <setting>]...",
    about: "what you set on one of your computers: its name, the ssh login it is reached by, how many threads run there at once, how long a quiet machine there runs before it naps, how long one turn there may run, whether agents there may start agents, the recipe it follows<!-- cloud -->, and on a cloud how many machines at once and how much it spends a day<!-- /cloud -->; --reset takes a setting back to its default",
    page: "agent",
    options: { name: { type: "string" }, ssh: { type: "string" }, threads: { type: "string" }, machines: { type: "string" }, spend: { type: "string" }, nap: { type: "string" }, "turn-limit": { type: "string" }, spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" }, recipe: { type: "string" }, reset: { type: "string", multiple: true } },
    run: async ctx => {
      const [ref, ...rest] = ctx.args;
      if (ref === undefined || rest.length > 0) throw usageRefusal("wsp computers set takes one computer.", usageIs(ctx));
      const recipe = flag(ctx.flags, "recipe");
      const also = { name: flag(ctx.flags, "name"), ssh: flag(ctx.flags, "ssh"), recipe };
      const threads = flag(ctx.flags, "threads");
      const machines = flag(ctx.flags, "machines");
      const spend = flag(ctx.flags, "spend");
      const nap = flag(ctx.flags, "nap");
      const turnLimit = flag(ctx.flags, "turn-limit");
      const spawn = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"), ref);
      const set = {
        ...(threads !== undefined ? { threads: countAsked("--threads", threads, 1, ref) } : {}),
        ...(machines !== undefined ? { machines: countAsked("--machines", machines, 1, ref) } : {}),
        ...(spend !== undefined ? { spendPerDayUsd: dollarsAsked(spend, ref) } : {}),
        ...(nap !== undefined ? { napMs: napMsOf(napAsked(nap, ref)) } : {}),
        ...(turnLimit !== undefined ? { turnLimitMs: turnLimitMsOf(turnLimitAsked(turnLimit, ref)) } : {}),
        ...(spawn !== undefined ? { spawn } : {}),
      };
      const reset = flagList(ctx.flags, "reset").map(word => oneOf("reset", SETTING_RESETS, word, ref)!);
      const { computer, was } = await setComputer(await ctx.client(), ref, set, reset, also);
      ctx.out.emit({ computer }, computerSetLines(computer, was, also, Object.keys(set).length > 0 || reset.length > 0).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Sets what the person may set on one computer and answers its row as it now reads, the same row computers lists: name, what a computer the person added is called from now, in every listing and wherever a computer is named, its id, its projects and its machines staying as they are, refused for the computer the app runs on<!-- cloud -->, for a cloud<!-- /cloud --> and for a name another computer answers to; ssh, the login user@host the host reaches it by over ssh from now, for an update or a remove while its link is down and for the forward it dials back through, saved only once the computer that login reaches reads as this same one, its place file naming this computer and this host; threads, how many threads may run there at once, a new one waiting past it, except a turn a thread there follows to its end, not detached, which runs in that thread's slot (one per 2 GB of that computer's memory up to twice its cores until it is set); nap, the minutes a machine there with no window of its own runs with no turn and no work before it naps and stops costing anything, waking on the next message (20 until it is set, 0 never naps it), which every machine there counts again from now and which the computer the app runs on does not take, since its threads run in folders; turn_limit, the hours one turn there may run before it is stopped, a send carrying it on from where it stopped (none on a computer the person owns<!-- cloud --> and 6 on a cloud<!-- /cloud --> until it is set, 0 is none), read at each turn's start; spawn, max_machines and max_depth, what the agents there may ask of this host where the folder or the machine they run in holds no switch of its own, as workspaces_agents names it for one (on, up to 3 machines and 2 levels deep, until it is set), read at every ask so one made before the change follows it<!-- cloud -->; machines and spend on a cloud, how many machines may run there at once and the dollars a day it may spend before it starts no new machine (3 and $10 until they are set)<!-- /cloud -->. A setting left out keeps what stands, and each word under reset takes that setting back to its default. The row carries cap, what runs there now, capDefault, what it reads by default, and settings, what the person set. A setting the computer's kind does not take, and a call that sets nothing, are refused in one line.",
      input: {
        computer: z.string().describe("the computer, by the name computers lists or its id"),
        name: z.string().optional().describe("what to call a computer the person added from now"),
        ssh: z.string().optional().describe("the login user@host the host reaches that computer by over ssh from now, saved once it reads as the same computer"),
        threads: z.number().int().min(1).optional().describe("how many threads may run on that computer at once"),
        machines: z.number().int().min(1).optional().describe("how many machines may run on that cloud at once"),
        spend: z.number().min(0).optional().describe("the dollars a day that cloud may spend before it starts no new machine"),
        nap: z.number().int().min(0).max(NAP_AFTER_MAX_MS / 60_000).optional().describe("the minutes a quiet machine there runs before it naps; 0 never naps it"),
        turn_limit: z.number().int().min(0).max(TURN_LIMIT_MAX_MS / 3_600_000).optional().describe("the hours one turn there may run before it is stopped; 0 never stops one"),
        spawn: z.enum(["on", "off"]).optional().describe("whether agents there may open threads and fork machines under the thread they run in, capped, where the folder or the machine they run in holds no switch of its own"),
        max_machines: z.number().int().min(0).optional().describe("how many machines may stand at once under one root thread there while spawn is on"),
        max_depth: z.number().int().min(1).optional().describe("how many levels deep the tree under a root thread there may go while spawn is on"),
        recipe: z.string().optional().describe("the saved recipe it follows from now, as recipes lists it, or none: one it follows syncs to it, a change to the recipe reaching it with no step, and none keeps what it has"),
        reset: z.array(z.enum(SETTING_RESETS)).optional().describe("the settings to take back to their defaults, by the same words"),
      },
      output: { computer: PlaceView },
      call: async ({ computer: ref, name, ssh, threads, machines, spend, nap, turn_limit: turnLimit, spawn: on, max_machines: maxMachines, max_depth: maxDepth, recipe, reset }, deps) => {
        const spawn = agentsAsked(on, maxMachines, maxDepth);
        const { computer } = await setComputer(await deps.client(), ref, {
          ...(threads !== undefined ? { threads } : {}),
          ...(machines !== undefined ? { machines } : {}),
          ...(spend !== undefined ? { spendPerDayUsd: spend } : {}),
          ...(nap !== undefined ? { napMs: napMsOf(nap) } : {}),
          ...(turnLimit !== undefined ? { turnLimitMs: turnLimitMsOf(turnLimit) } : {}),
          ...(spawn !== undefined ? { spawn } : {}),
        }, reset ?? [], { name, ssh, recipe });
        return asJson({ computer });
      },
    }),
  },
  {
    name: "add",
    command: true,
    tool: tool({
      description:
        "Adds a computer of the person's over ssh and sets it up from a saved recipe, as `wsp add <user@host> --recipe <name>` does: address is user@host or an alias from the ssh config, and the host logs in, checks it can run wsp there (root, or a login whose sudo runs it as root, systemd with cgroup v2, room on the disk), installs wsp, waits for it to dial back, then puts on the base tools and everything the recipe picks. With resume, address names a computer already added, or one that joined and waits on its picks, and sets it up again: from recipe where one is named, else from what it holds, running only what is missing, a sign-in that waited or ran out among it. This tool never waits on the person: it answers at the first sign-in waiting on them (the page and the code are in waiting, to hand over), at the end, or after ten minutes, and is called again with resume for the next of those; with later it does not stop at a sign-in and leaves it waiting. setup is the setup's steps as the computer's row holds them, each with its state and what it took; an install that fails is refused with the step it failed at. A login whose sudo asks for a password is refused with the line that says where the person types it, at a terminal or in the app, since no password travels through this tool. A computer this host has never dialled needs host_key, as the person read it off that computer, or the add is refused with the key it answered with. A project, a provider's key and the join code are not added here: projects_add records a project, and the other two belong at the host's own terminal.",
      input: {
        address: z.string().describe("user@host, an alias from the ssh config, or with resume a computer already added"),
        recipe: z.string().optional().describe("the saved recipe to set it up from, as recipes lists it"),
        later: z.boolean().optional().describe("go on past a sign-in that waits on the person and leave it waiting"),
        resume: z.boolean().optional().describe("set up a computer already added, or one that joined and waits on its picks"),
        name: z.string().optional().describe("what to call the computer here; what its address calls it without one"),
        ssh_port: z.number().int().min(1).max(65535).optional().describe("the port ssh dials it on (default 22)"),
        ssh_key: z.string().optional().describe("the key file ssh logs in with"),
        host_key: z.string().optional().describe("the host key of a computer this one has never dialled, as read off that computer"),
      },
      output: { computer: PlaceView, setup: z.array(AddLine), waiting: z.array(PlaceWait) },
      stream: ["setup", "waiting"],
      call: async ({ address, recipe, later, resume, name, ssh_port: sshPort, ssh_key: keyPath, host_key: hostKey }, deps) =>
        asJson(
          await addComputer(await deps.client(), {
            address,
            ...(recipe !== undefined ? { recipe } : {}),
            ...(later !== undefined ? { later } : {}),
            ...(resume !== undefined ? { resume } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(sshPort !== undefined ? { sshPort } : {}),
            ...(keyPath !== undefined ? { keyPath } : {}),
            ...(hostKey !== undefined ? { hostKey } : {}),
          }),
        ),
    }),
  },
  {
    name: "recipes",
    usage: "wsp recipes",
    about: "your saved recipes: what each puts on a computer in one line, and the computers that follow it",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp recipes takes no positional arguments.", usageIs(ctx));
      const { recipes } = await (await ctx.client()).request<{ recipes: RecipeView[] }>("recipes.list");
      ctx.out.emit({ recipes }, recipeLines(recipes).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Every recipe this host keeps: a named pick of what goes on a computer of the person's (agents and how each signs in, MCP servers per agent, CLIs by the manager they came from, skills, plugins, folders to move over as projects, and the git, shell and GitHub configs), chosen from what the computer the app runs on has. Each carries summary, one line of what it holds, machines, the computers that follow it, since a recipe edit reaches them, and savedAt, when its file was last written. A recipe holds names and never a secret; a token reaches a computer only in the environment of a run there.",
      input: {},
      output: { recipes: z.array(RecipeView) },
      call: async (_args, deps) => {
        const { recipes } = await (await deps.client()).request<{ recipes: RecipeView[] }>("recipes.list");
        return asJson({ recipes });
      },
    }),
  },
  {
    name: "recipes show",
    usage: "wsp recipes show <name>",
    about: "one recipe whole: every row it holds by kind, the computers that follow it, and the hash it resolves to on this computer now",
    page: "agent",
    options: {},
    run: async ctx => {
      const [name, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp recipes show takes one recipe.", usageIs(ctx));
      const shown = await (await ctx.client()).request<{ recipe: RecipeView; hash: string }>("recipes.get", { name });
      ctx.out.emit({ recipe: shown.recipe, hash: shown.hash }, recipeShownLines(shown.recipe, shown.hash).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "One recipe by its name: file is the recipe as saved, every row by kind (agents with signin vault or machine, mcp with the agents each server goes to, clis with via, the manager it came from, and needs where it builds with the C toolchain, skills with from, the folder it is read from here, plugins, folders with from, name, icon, hue and keep, configs git, shell and github, github with signin vault, machine or skip), machines the computers that follow it, and hash what it resolves to on the computer the app runs on now: the versions, the skill folders and the configs read there, which a computer that applied it is held against.",
      input: { name: z.string().describe("the recipe's name, as recipes lists it") },
      output: { recipe: RecipeView, hash: z.string() },
      call: async ({ name }, deps) => {
        const shown = await (await deps.client()).request<{ recipe: RecipeView; hash: string }>("recipes.get", { name });
        return asJson({ recipe: shown.recipe, hash: shown.hash });
      },
    }),
  },
  {
    name: "recipes save",
    usage: "wsp recipes save <name> --from <computer>",
    about: "saves what one of your computers was set up with as a recipe under that name, and that computer follows it from then on",
    page: "agent",
    options: { from: { type: "string" } },
    run: async ctx => {
      const [name, ...rest] = ctx.args;
      const from = flag(ctx.flags, "from");
      if (name === undefined || rest.length > 0 || from === undefined) throw usageRefusal("wsp recipes save takes one name and the computer to save it from.", usageIs(ctx));
      const { recipe } = await (await ctx.client()).request<{ recipe: RecipeView }>("recipes.save", { name, from });
      ctx.out.emit({ recipe }, recipeSavedLine(recipe));
      return 0;
    },
    tool: tool({
      description:
        "Saves the picks one of the person's computers was set up with as a recipe under name, rewriting a recipe of that name whole, and that computer follows it from then on, so an edit to the recipe reaches it. Refused for a name with no letter or digit in it, for the computer the app runs on, and for a computer set up before picks were kept. The answer is the recipe as saved.",
      input: { name: z.string().describe("what to call the recipe"), from: z.string().describe("the computer whose picks to save, by the name computers lists") },
      output: { recipe: RecipeView },
      call: async ({ name, from }, deps) => {
        const { recipe } = await (await deps.client()).request<{ recipe: RecipeView }>("recipes.save", { name, from });
        return asJson({ recipe });
      },
    }),
  },
  {
    name: "recipes remove",
    usage: "wsp recipes remove <name>",
    about: "takes a recipe away; the computers that followed it keep what they have and follow none",
    page: "agent",
    options: {},
    run: async ctx => {
      const [name, ...rest] = ctx.args;
      if (name === undefined || rest.length > 0) throw usageRefusal("wsp recipes remove takes one recipe.", usageIs(ctx));
      const { recipe } = await (await ctx.client()).request<{ recipe: RecipeView }>("recipes.remove", { name });
      ctx.out.emit({ recipe }, recipeRemovedLine(recipe));
      return 0;
    },
    tool: tool({
      description: "Takes a recipe's file away. The computers that followed it keep everything it put there and follow none from then on, so nothing reaches them from it again. The answer is the recipe as it stood, machines naming the computers it was taken off.",
      input: { name: z.string().describe("the recipe's name, as recipes lists it") },
      output: { recipe: RecipeView },
      call: async ({ name }, deps) => {
        const { recipe } = await (await deps.client()).request<{ recipe: RecipeView }>("recipes.remove", { name });
        return asJson({ recipe });
      },
    }),
  },
  {
    name: "usage",
    usage: "wsp usage [--range day|week|month] [--by agent|account|computer|project|model|source]",
    about: "what each agent account signed in on any of your computers may still use, and what was used over a day, a week or a month split one way; two answers, never added together",
    page: "agent",
    options: { range: { type: "string" }, by: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp usage takes no positional arguments.", usageIs(ctx));
      const range = oneOf("range", USAGE_RANGES, flag(ctx.flags, "range")) ?? "day";
      const by = oneOf("by", USAGE_SPLITS, flag(ctx.flags, "by")) ?? "agent";
      const read = await readUsage(await ctx.client(), range, by);
      ctx.out.emit(read, usageTableLines({ accounts: z.array(AccountRow).parse(read.accounts), used: UsedAnswer.parse(read.used) }, Date.now()).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "Two answers that are never added together. accounts: every agent account signed in on any computer, the same one on three computers once, each with how much of its plan's windows is used and when each starts again, as that agent printed them in the last turn wsp ran on it; an agent that prints none reports no plan limit, a sign-in by API key pays per token with no plan window, and an account no turn has run on yet has no reading. used: the tokens the turns used over the range (today, the last seven days or the last thirty), split by agent, account, computer, project, model or source (a model once for each agent that ran it, and a row by agent, account or model naming its agent; by source, the turns wsp's threads ran beside the work the agents on this computer and on each joined one logged outside wsp, as each computer's own daemon read it, which only that split counts), each row with the cost its agent reported, a list price off one table for every token and what the cache saved, input counting the cached and the written tokens, the turns wsp ran, and a series over the range with one line per row.",
      input: { range: UsageRange.optional().describe("day (the default), week or month"), by: UsageSplit.optional().describe("agent (the default), account, computer, project, model or source") },
      output: { accounts: z.array(AccountRow), used: UsedAnswer },
      call: async ({ range, by }, deps) => asJson(await readUsage(await deps.client(), range ?? "day", by ?? "agent")),
    }),
  },
  {
    name: "usage reset",
    usage: "wsp usage reset <account> [--credit <id>] [--on <computer>] [--yes]",
    about: "spends one of the resets a Codex account has banked, on a computer of yours that holds its login, after reading the account there: its five-hour and weekly windows start again now; asks first unless --yes",
    page: "agent",
    options: { credit: { type: "string" }, on: { type: "string" }, yes: { type: "boolean" } },
    cliOnly: "spends a reset the person owns; the skill already says an agent does not read the person's accounts, and a thread's socket is refused every usage op",
    run: async ctx => {
      const [word, ...rest] = ctx.args;
      if (word === undefined || rest.length > 0) throw usageRefusal("wsp usage reset takes one account.", usageIs(ctx));
      const client = await ctx.client();
      const { accounts } = await client.request<{ accounts: unknown }>("usage.accounts");
      const row = accountNamed(z.array(AccountRow).parse(accounts), word);
      if (!(await confirmed(ctx, resetQuestion(row.label, row.credits?.count), `Every reset banked on ${row.label}`))) return 1;
      const credit = flag(ctx.flags, "credit");
      const on = flag(ctx.flags, "on");
      const answer = ResetAnswer.parse(await client.request("usage.reset", { account: row.key, ...(credit !== undefined ? { creditId: credit } : {}), ...(on !== undefined ? { on } : {}) }));
      ctx.out.emit(answer, answer.said);
      return 0;
    },
  },
];
