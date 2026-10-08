// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from "node:path";
import { z } from "zod";
import { nodeHost, readGhosttyConfig } from "@wsp/collect";
import {
  EMPTY_MESSAGE_LINE,
  EXIT_CODES,
  HostFolderListing,
  InitSetup,
  initSetupLines,
  NOTIFY_CALLER,
  NOTIFY_WORDS,
  ANOTHER_AGENT_WORDS,
  ProjectExportResult,
  SessionInterruptOutcome,
  SessionRenameOutcome,
  TURN_END_WORDS,
  TerminalConfig,
  TerminalScheme,
  ThreadMessage,
  ThreadHead,
  execFolderLine,
  terminalConfigLines,
  usageRefusal,
  WorktreeMade,
  worktreeRemovedLine,
  turnSpendWord,
} from "@wsp/protocol";
import { hostBack, type VerbDeps, type VerbContext, usageIs, tool, type CliVerb, type Verb, PICK_OPTIONS, SEND_OPTIONS, flag, flagList, absolutePath, absoluteFolder } from "./client.js";
import { workspaceOf, threadOf, SSH_PIPES_HERE_LINE, sshWorkspaceOf, pipeBytes, awake, napAfterDeadLaunch, withLine, stop, stopLine, forgetThread, threadForgotLine, rename, renameLine } from "./workspaces-help.js";
import { type Turn, pickFlags, checkedStart, runTarget, forkFor, worktreeFor, openingOf, notifyOf, messageTo, startDetached, follow, hostRestartedLine, restartHost, readThread, readLine, threadHead, headLine, type AnswerRoad, ANSWER_ROADS, answerOpenAsk, followVerb, beforeSending, detachVerb, turnView } from "./turns-help.js";
import { confirmed, execOn, type ExportRequest, exportProject, withReplaceHint, agentsFlag, QUIET_LINE, QUIET_TURN, SEND_MEETS, CAP_MEETS, TurnOut, Argv, asJson, asText, turnText, detachedOut, turnOut, WorkspaceIn, AgentIn, NotifyIn, RunProjectIn, BranchIn, RunCwdIn, CwdIn, DetachIn, TitleIn, FilesIn, FastIn, PICK_INPUTS, SEND_INPUTS, schemeFlag, hostFolders, initSetup, folderLines, REASON_FLAG } from "./io.js";
import { SLATE_VERBS } from "./slate.js";

/** The lines another terminal answers a thread's open prompt with, one per road that carries a verb: the same op the
 * app's buttons send, by thread id, so a person or an agent watching a thread from anywhere can unstick it. */
const ANSWER_VERBS: readonly CliVerb[] = ANSWER_ROADS.filter((road): road is AnswerRoad & { answer: NonNullable<AnswerRoad["answer"]> } => road.answer !== undefined).map(road => ({
  name: `thread ${road.answer.verb}`,
  usage: `wsp thread ${road.answer.verb} <thread>${road.answer.reasons === true ? ' [--reason "<words>"]' : ""}`,
  about: road.answer.about,
  page: "agent" as const,
  options: road.answer.reasons === true ? REASON_FLAG : {},
  run: async (ctx: VerbContext) => {
    const [ref] = ctx.args;
    if (ref === undefined || ctx.args.length !== 1) throw usageRefusal(`wsp thread ${road.answer.verb} takes one thread.`, usageIs(ctx));
    const answered = await answerOpenAsk(await ctx.client(), ref, road, flag(ctx.flags, "reason"));
    ctx.out.emit({ threadId: answered.threadId, askId: answered.askId, optionId: answered.optionId }, answered.line);
    return 0;
  },
  tool: tool({
    description: `${road.answer.about[0]!.toUpperCase()}${road.answer.about.slice(1)}, by thread id or a prefix of it. A thread stopped on a prompt reads Needs you in threads and runs nothing until somebody picks, so this is how a thread you did not open is unstuck; the prompt itself is on the thread's own rows, which thread_read prints. Refused in one line when the thread is waiting on no prompt and when the prompt it is stopped on carries no such answer, which is what a call that asks the person something rather than for consent does.`,
    input: {
      thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them"),
      ...(road.answer.reasons === true ? { reason: z.string().optional().describe("what the agent should do instead, in your words; the agent reads it with the refusal, as it reads the reason a person types in the app") } : {}),
    },
    output: { threadId: z.string(), askId: z.string(), optionId: z.string() },
    call: async ({ thread: ref, reason }: { thread: string; reason?: string }, deps: VerbDeps) => {
      const answered = await answerOpenAsk(await deps.client(), ref, road, reason);
      return asText(answered.line, { threadId: answered.threadId, askId: answered.askId, optionId: answered.optionId });
    },
  }),
}));

export const THREAD_VERBS: readonly Verb[] = [
  {
    name: "run",
    usage: 'wsp run [<project>] [--branch <branch>] [--cwd <path>] [--agent <id>] [--model, --effort, --access <word>] [--fast] [--notify <thread|me>] [--title <title>] [--file <path>] [--detach] "<message>"',
    about:
      "an agent works in the project's folder and you read its reply: a thread with the agent, model, effort and access the app offers; a project on a box runs in its folder there as the login the box was added with, and a project anywhere else gets a new machine forked from the image, named off the message as the app's New thread names one; --branch runs it in a worktree of the project's repo on that branch, made under wsp's folder unless one already holds it, and --cwd in a folder inside the project or one of its worktrees; with no project, run from inside one of your project folders, or from a thread, beside it; follows its first turn, or with --detach prints the id and returns",
    page: "front",
    options: { branch: { type: "string" }, cwd: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, fast: { type: "boolean" }, notify: { type: "string", multiple: true }, title: { type: "string" }, file: { type: "string", multiple: true }, detach: { type: "boolean" } },
    run: async ctx => {
      if (ctx.args.length === 0) throw usageRefusal(EMPTY_MESSAGE_LINE, 'Put the message in quotes: wsp run <project> "say hi".');
      if (ctx.args.length > 2) throw usageRefusal(`wsp run takes a project and a message; ${ctx.args[2]!} reads as a third word.`, usageIs(ctx));
      const client = await ctx.client();
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      const [ref, message] = ctx.args.length === 2 ? [ctx.args[0], ctx.args[1]!] : [undefined, ctx.args[0]!];
      const where = { branch: flag(ctx.flags, "branch"), cwd: flag(ctx.flags, "cwd") };
      const { opened, woken, opening } = await beforeSending(client, async () => {
        const named = await runTarget(client, ref, ctx.cwd, ctx.env, ctx.elsewhere, where);
        await checkedStart(client, message, harness, picks, "workspace" in named ? named.workspace.id : undefined, "fork" in named ? named.fork.id : undefined);
        const read = openingOf(ctx.env, "workspace" in named ? named.workspace : named, message, { harness, ...picks, notify: await notifyOf(client, flagList(ctx.flags, "notify")), title: flag(ctx.flags, "title"), files: flagList(ctx.flags, "file"), elsewhere: ctx.elsewhere, ...("here" in named ? {} : { cwd: where.cwd }) });
        const target = "fork" in named ? { workspace: await forkFor(client, named.fork, message, line => ctx.io.error(line)) } : named;
        const woken = "workspace" in target ? await awake(client, target.workspace, "send", line => ctx.io.error(line)) : undefined;
        return { opened: target.opened, woken, opening: woken === undefined ? read : { ...read, workspaceId: woken.workspace.id } };
      });
      let started: Turn | undefined;
      try {
        if (ctx.flags["detach"] === true) await detachVerb(ctx, client, opening, {}, opened);
        else ctx.out.emit(turnView(await followVerb(ctx, client, opening, true, {}, { opened, spend: turnSpendWord(woken?.workspace ?? { kind: "local" }) }, t => (started = t))));
      } catch (e) {
        throw woken === undefined ? e : withLine(e, await napAfterDeadLaunch(client, woken, started));
      }
      return 0;
    },
    tool: tool({
      description: `Opens a thread under the named agent, on the model, effort and access mode named or the catalog's defaults (a cheaper model for a review, say), and follows its first turn; returns the reply text as soon as it is complete, with the thread id for send. It runs in the project's folder, on a box in its folder there as the login the box was added with, and on a project anywhere else in a new machine forked from the image, named off the message as the app's New thread names one; with branch, in a worktree of the project's repo on that branch (one that already holds the branch, wherever it is, else one wsp makes under its own folder with the dependencies carried in); with cwd, in that folder, which must be inside the project or one of its worktrees. With no project, from a thread, it runs beside that thread in its folder. With detach true it returns the thread id the moment the turn is started, without the reply: the road for a turn that runs for minutes or an hour. ${TURN_END_WORDS}. With notify, each turn of the thread sends one line (outcome, duration, cost, and the reply whole into a thread or its last line to the person) to every target named, so a caller need not wait here or poll. ${NOTIFY_WORDS}. ${NOTIFY_CALLER}. ${CAP_MEETS}. ${ANOTHER_AGENT_WORDS}.`,
      input: { project: RunProjectIn, branch: BranchIn, cwd: RunCwdIn, message: z.string(), agent: AgentIn, ...PICK_INPUTS, fast: FastIn, notify: NotifyIn, title: TitleIn, files: FilesIn, detach: DetachIn },
      output: TurnOut.shape,
      call: async ({ project: ref, branch, cwd, message, agent: harness, notify: tell, title, files, detach, ...input }, deps) => {
        const client = await deps.client();
        const { opened, woken, opening } = await beforeSending(client, async () => {
          const named = await runTarget(client, ref, deps.cwd, deps.env, deps.elsewhere, { branch, cwd });
          await checkedStart(client, message, harness, input, "workspace" in named ? named.workspace.id : undefined, "fork" in named ? named.fork.id : undefined);
          const read = openingOf(deps.env, "workspace" in named ? named.workspace : named, message, { harness, ...input, notify: await notifyOf(client, tell ?? []), title, files, elsewhere: deps.elsewhere, ...("here" in named ? {} : { cwd }) });
          const target = "fork" in named ? { workspace: await forkFor(client, named.fork, message, QUIET_LINE) } : named;
          const woken = "workspace" in target ? await awake(client, target.workspace, "send", QUIET_LINE) : undefined;
          return { opened: target.opened, woken, opening: woken === undefined ? read : { ...read, workspaceId: woken.workspace.id } };
        });
        let started: Turn | undefined;
        try {
          if (detach === true) return detachedOut(await startDetached(client, opening, "agent", undefined, () => hostBack(deps)), opened);
          const turn = await follow(client, opening, "agent", { ...QUIET_TURN, started: t => (started = t) }, () => hostBack(deps));
          const out = turnOut(turn);
          return asText(opened === undefined ? turnText(out) : `${opened(out.threadId, turn.session.cwd)}\n${turnText(out)}`, out);
        } catch (e) {
          throw woken === undefined ? e : withLine(e, await napAfterDeadLaunch(client, woken, started));
        }
      },
    }),
  },
  {
    name: "worktree",
    usage: "wsp worktree <project> <branch>",
    about:
      "a worktree of the project's repo on the branch, for an agent to work in by path or to start a thread in: the one git already has the branch checked out in, wherever it is, else one wsp makes under its own folder, from the project folder's current commit for a new branch, with the folder's .env files and installed dependencies carried in; prints its path",
    page: "agent",
    options: {},
    run: async ctx => {
      const [project, branch] = ctx.args;
      if (project === undefined || branch === undefined || ctx.args.length !== 2) throw usageRefusal("wsp worktree takes a project and a branch.", usageIs(ctx));
      const made = await worktreeFor(await ctx.client(), project, branch);
      ctx.out.emit({ ...made }, made.path);
      return 0;
    },
    tool: tool({
      description:
        "A worktree of the project's repo on the branch, answered with its path: the one git already has the branch checked out in, the project folder or a worktree the person or an agent made included, else one wsp makes under its own folder, a new branch starting from the project folder's current commit, with .env files and installed dependencies carried in from the project folder and build folders tied to their path left to rebuild. made says whether wsp made it, which is the only kind it ever removes. A running session cannot move into it: work there by path, or start a thread in it with run and cwd. git worktree add works too, without the carried files and the cleanup.",
      input: { project: z.string().describe("the project, by the name or the id projects lists"), branch: z.string().describe("the branch, existing or new") },
      output: WorktreeMade.shape,
      call: async ({ project, branch }, deps) => {
        const made = await worktreeFor(await deps.client(), project, branch);
        return asText(made.path, { ...made });
      },
    }),
  },
  {
    name: "worktree remove",
    usage: "wsp worktree remove <project> <branch> [--force] [--yes]",
    about: "takes away a worktree wsp made for the branch, with git: refused while a thread is working in it, and over files no commit holds unless --force; the branch stays, and a worktree wsp did not make is never removed",
    page: "agent",
    options: { force: { type: "boolean" }, yes: { type: "boolean" } },
    run: async ctx => {
      const [project, branch] = ctx.args;
      if (project === undefined || branch === undefined || ctx.args.length !== 2) throw usageRefusal("wsp worktree remove takes a project and a branch.", usageIs(ctx));
      const client = await ctx.client();
      const asked = { project, branch, ...(ctx.flags["force"] === true ? { force: true } : {}) };
      // The host's own refusals first, so the one question is asked only of a removal that would go.
      await client.request("worktree.remove", { ...asked, check: true });
      if (!(await confirmed(ctx, `Remove the worktree for ${branch} in ${project}?\nThe branch stays${ctx.flags["force"] === true ? ", and the files no commit holds there go" : ""}.`, branch))) return 1;
      await client.request("worktree.remove", asked);
      ctx.out.emit({ project, branch, removed: true }, worktreeRemovedLine(branch));
      return 0;
    },
    tool: tool({
      description:
        "Takes away the worktree wsp made for the branch, with git: refused while a thread is working in it, and over files no commit holds unless force, which loses them. The branch itself stays, and a detached worktree's commit is kept under refs/rescue. A worktree the person or an agent made is never removed; threads that ran in a removed worktree go on in the project folder.",
      input: { project: z.string().describe("the project, by the name or the id projects lists"), branch: z.string().describe("the branch the worktree holds"), force: z.boolean().optional().describe("remove it over files no commit holds, which go with it") },
      output: { project: z.string(), branch: z.string(), removed: z.literal(true) },
      call: async ({ project, branch, force }, deps) => {
        await (await deps.client()).request("worktree.remove", { project, branch, ...(force === true ? { force: true } : {}) });
        return asText(worktreeRemovedLine(branch), { project, branch, removed: true as const });
      },
    }),
  },
  {
    name: "thread read",
    usage: "wsp thread read <thread> [--last]",
    about:
      "the thread's messages as the app lists them, oldest first: who each one is, when the runtime recorded it and the text, with every tool call folded to the one line the app's row reads; --last prints the final reply alone, the whole message its finished line carries. A tool's output and the agent's reasoning are no rows of it. Reading marks the thread read, so it stops reading Done here and in the app",
    page: "agent",
    options: { last: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread read takes one thread.", usageIs(ctx));
      const last = ctx.flags["last"] === true;
      const client = await ctx.client();
      const read = await readThread(client, await threadOf(client, ref), last);
      ctx.out.emit(read, readLine(read, last));
      return 0;
    },
    tool: tool({
      description:
        "The thread's messages as the app lists them, oldest first: each one's who (person for the message that opened or steered a turn, agent for the agent's own words, tool for one call of its folded to a line, turn for the outcome, duration and cost the turn ended with), at, the ms epoch the runtime recorded it, and its text. With last true, the final reply alone, the whole message the thread's finished line carries, and a row under it saying so when the thread has started another turn since, so a report is never read as the one being written. This is how you read a thread you did not open, and how you read the report behind a line that reached you; the transcript is the host's, so nothing on a machine is touched and a paused machine's thread reads the same as a running one's. A thread of many turns answers with all of them, so read one with last true when the report is what you are after. A call's output and the agent's reasoning are no rows of it. A thread whose rows the transcript's cap has dropped answers with none, which is an answer and not an error. Reading marks the thread read, as the app showing it does, so a finished thread stops reading Done in threads and in the app.",
      input: {
        thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them"),
        last: z.boolean().optional().describe("true answers with the final reply alone, the whole message the thread's finished line carries, with a row under it where the thread has started another turn since; absent answers with every message"),
      },
      output: { threadId: z.string(), messages: z.array(ThreadMessage) },
      call: async ({ thread: ref, last }, deps) => {
        const client = await deps.client();
        const read = await readThread(client, await threadOf(client, ref), last === true);
        return asText(readLine(read, last === true), read);
      },
    }),
  },
  {
    name: "thread head",
    usage: "wsp thread head <thread>",
    about:
      "the thread's facts and its newest events, what the app draws first on opening it: the title, the agent, model and access it runs on, where it stands and its folder, then as many of its newest events as fit in 64 KB, each tool result past 2 KB cut and marked with its whole length. Reading a head marks nothing",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread head takes one thread.", usageIs(ctx));
      const client = await ctx.client();
      const head = await threadHead(client, await threadOf(client, ref));
      ctx.out.emit(head, headLine(head));
      return 0;
    },
    tool: tool({
      description:
        "The thread's head (by id, or a prefix of it): facts, the thread as threads lists it with the model, effort and context window its latest turn runs on and turnId while a turn runs; events, as many of the thread's newest transcript events as fit in 64 KB, oldest first, each tool result past 2 KB cut with cut set to its whole length; pos, the newest position the transcript has issued, which every event carries as its own pos; and total, how many events of the thread the transcript holds. It is the cheap look at a thread: read the whole conversation with thread_read. Nothing on a machine is touched and the thread is not marked read.",
      input: { thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them") },
      output: ThreadHead.shape,
      call: async ({ thread: ref }, deps) => {
        const client = await deps.client();
        const head = await threadHead(client, await threadOf(client, ref));
        return asText(headLine(head), head);
      },
    }),
  },
  {
    name: "thread rename",
    usage: 'wsp thread rename <thread> "<title>"',
    about: "names the thread inside the agent's own store, so the agent shows the same name",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref, title] = ctx.args;
      if (ref === undefined || title === undefined || ctx.args.length !== 2) throw usageRefusal("wsp thread rename takes a thread and one name.", usageIs(ctx));
      const client = await ctx.client();
      const thread = await threadOf(client, ref);
      await awake(client, await workspaceOf(client, thread.workspaceId), "rename", line => ctx.io.error(line));
      const renamed = await rename(client, thread, title);
      ctx.out.emit(renamed, renameLine(renamed));
      return 0;
    },
    tool: tool({
      description:
        "Names the thread (by id, or a prefix of it) in the agent's own store on the machine, the field the agent writes when a person renames the session inside it, so the thread reads by that name in wsp and in the agent. outcome renamed means the store took it; unsupported means the thread's agent keeps no name of a person's, which is an answer, not an error; no-session means the agent's store on the machine has no such session; failed means the store refused the write and error carries the machine's own line for it. Whether an agent keeps a name is on its row in harnesses.list, from the adapter on the machine.",
      input: { thread: z.string(), title: z.string() },
      output: { threadId: z.string(), title: z.string(), harness: z.string(), outcome: SessionRenameOutcome, error: z.string().optional() },
      call: async ({ thread: ref, title }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await awake(client, await workspaceOf(client, thread.workspaceId), "rename", QUIET_LINE);
        const renamed = await rename(client, thread, title);
        return asText(renameLine(renamed), { ...renamed });
      },
    }),
  },
  {
    name: "thread forget",
    usage: "wsp thread forget <thread> [--yes]",
    about: "drops a thread no turn ever ran on, the row a launch that never got going leaves behind; refused once a turn of it did work",
    page: "agent",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp thread forget takes one thread.", usageIs(ctx));
      const client = await ctx.client();
      const thread = await threadOf(client, ref);
      await forgetThread(client, thread, { check: true });
      if (!(await confirmed(ctx, `Forget thread ${thread.id}?\nIts row leaves this computer and the sidebar.`, thread.id))) return 1;
      await forgetThread(client, thread);
      ctx.out.emit({ threadId: thread.id, workspaceId: thread.workspaceId }, threadForgotLine(thread));
      return 0;
    },
    tool: tool({
      description:
        "Drops a thread (by id, or a prefix of it) no turn ever ran on: the row a launch that never got going leaves in threads and in the person's sidebar goes, and nothing is asked of the machine. A launch the agent refused outright, for want of a sign-in, counts as one that ran nothing and goes the same way. Refused in one line once a turn of the thread did work, since that work is written down on it and nowhere else; delete takes a thread that ran, with its turns.",
      input: { thread: z.string().describe("the thread's id, or a prefix of it that names one, as threads lists them") },
      output: { threadId: z.string(), workspaceId: z.string() },
      call: async ({ thread: ref }, deps) => {
        const client = await deps.client();
        const thread = await threadOf(client, ref);
        await forgetThread(client, thread);
        return asText(threadForgotLine(thread), { threadId: thread.id, workspaceId: thread.workspaceId });
      },
    }),
  },
  ...ANSWER_VERBS,
  ...SLATE_VERBS,
  {
    name: "send",
    usage: 'wsp send <thread> [--model, --effort <value>] [--fast] [--file <path>] [--detach] "<message>"',
    about: "a message to the thread, on a named model or effort, fast or not, with files; the thread keeps its own access and a running turn its own picks; --detach prints the id and returns",
    page: "front",
    options: { ...SEND_OPTIONS, fast: { type: "boolean" }, file: { type: "string", multiple: true }, detach: { type: "boolean" } },
    run: async ctx => {
      const [ref, message] = ctx.args;
      if (ref === undefined || message === undefined || ctx.args.length !== 2) throw usageRefusal("wsp send takes a thread and one message.", usageIs(ctx));
      const client = await ctx.client();
      const picks = pickFlags(ctx.flags);
      const { thread, workspace } = await beforeSending(client, async () => {
        const thread = await threadOf(client, ref);
        await checkedStart(client, message, thread.harness, picks, thread.workspaceId);
        return { thread, ...(await awake(client, await workspaceOf(client, thread.workspaceId), "send", line => ctx.io.error(line))) };
      });
      const files = flagList(ctx.flags, "file");
      if (ctx.flags["detach"] === true) await detachVerb(ctx, client, messageTo(thread, message, picks, files, ctx.elsewhere), picks);
      else ctx.out.emit(turnView(await followVerb(ctx, client, messageTo(thread, message, picks, files, ctx.elsewhere), false, picks, { spend: turnSpendWord(workspace) })));
      return 0;
    },
    tool: tool({
      description: `Sends a message to an existing thread (by id, or a prefix of it) and returns the reply when it is complete; a person's message on the same thread lands in order with yours. With detach true it returns the thread id the moment the turn is started, without the reply, and the turn's end reaches whoever the thread's start named. A model or effort named here is the turn's; the thread runs on the agent and at the access its own turns ran at, which a message does not change; a turn that joins a running one keeps that one's. ${SEND_MEETS} ${CAP_MEETS}.`,
      input: { thread: z.string(), message: z.string(), ...SEND_INPUTS, fast: FastIn, files: FilesIn, detach: DetachIn },
      output: TurnOut.shape,
      call: async ({ thread: ref, message, files, detach, ...input }, deps) => {
        const client = await deps.client();
        const thread = await beforeSending(client, async () => {
          const thread = await threadOf(client, ref);
          await checkedStart(client, message, thread.harness, input, thread.workspaceId);
          await awake(client, await workspaceOf(client, thread.workspaceId), "send", QUIET_LINE);
          return thread;
        });
        if (detach === true) return detachedOut(await startDetached(client, messageTo(thread, message, input, files, deps.elsewhere), "agent", undefined, () => hostBack(deps)));
        const out = turnOut(await follow(client, messageTo(thread, message, input, files, deps.elsewhere), "agent", QUIET_TURN, () => hostBack(deps)));
        return asText(turnText(out), out);
      },
    }),
  },
  {
    name: "restart",
    usage: "wsp restart",
    anyRelease: "the restart is the fix the release refusal names for an older host here, which comes back on the release installed",
    about: "stops the host and brings it back on the road it came up on, its service, the verb that started it or the app; running turns go on and the host that comes back re-opens them. A host wsp up holds in a terminal refuses",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp restart takes no arguments.", usageIs(ctx));
      const back = await restartHost(ctx);
      ctx.out.emit(back, hostRestartedLine(back.running));
      return 0;
    },
    tool: tool({
      description:
        "Stops the host and brings it back on the road it came up on: its service's manager, the verb that started it, or the app. Running turns go on across it and the host that comes back re-opens them, your own turn included, so a coordinator thread lands a host change with this and keeps working. Answers once that host serves, with running the ids of the threads running on it then. A run, send or wait this cut dials the host again and carries on. Refused for a host wsp up holds in a terminal, which only that terminal brings back.",
      input: {},
      output: { running: z.array(z.string()) },
      call: async (_, deps) => {
        const back = await restartHost(deps);
        return asText(hostRestartedLine(back.running), back);
      },
    }),
  },
  {
    name: "stop",
    usage: "wsp stop <thread> [--task <id>]",
    about: "stops the thread's running turn, as the app's stop does, or with --task one of its agent's own subagents alone; the machine stays up",
    page: "front",
    options: { task: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp stop takes one thread.", usageIs(ctx));
      const stopped = await stop(await ctx.client(), ref, flag(ctx.flags, "task"));
      ctx.out.emit(stopped, stopLine(stopped));
      return 0;
    },
    tool: tool({
      description: "Stops the thread's running turn (by id, or a prefix of it), as the app's stop button does; the machine stays up and the thread takes the next send. outcome accepted means the turn ended interrupted; not-running means it had already ended, which is an answer, not an error. A thread whose agents spawned threads of their own stops as one: under names each of those that was running and was stopped with it. Given the id of one of the agent's own subagents (off threads' subagents), that one is stopped alone and the turn runs on: accepted means the agent took the stop, refused and unsupported carry the reason in error. On a computer the person added, left says what the thread started there that the stop could not end.",
      input: { thread: z.string(), task: z.string().optional() },
      output: { threadId: z.string(), task: z.string().optional(), outcome: SessionInterruptOutcome, under: z.array(z.string()).optional(), error: z.string().optional(), left: z.string().optional() },
      call: async ({ thread: ref, task }, deps) => {
        const stopped = await stop(await deps.client(), ref, task);
        return asText(stopLine(stopped), { ...stopped });
      },
    }),
  },
  {
    name: "ssh",
    usage: "wsp ssh <workspace>",
    about: "carries one ssh connection to the workspace's own ssh server, starting it there, over this computer's stdin and stdout: the ProxyCommand wsp's ssh config gives every wsp- alias, so `ssh wsp-<name>` and an editor's remote window land inside the workspace",
    page: "agent",
    options: {},
    cliOnly: "a proxy for an ssh client on the computer the host runs on, piping raw bytes; an agent has no ssh client there to hand it to",
    startsNoHost: "a proxy for one connection to a host already up: a host it started would serve a state no config named, find no such workspace and stay up after ssh gave up",
    run: async ctx => {
      const [ref, ...rest] = ctx.args;
      if (ref === undefined || rest.length > 0) throw usageRefusal("wsp ssh takes one workspace.", usageIs(ctx));
      const bytes = ctx.io.bytes;
      if (bytes === undefined || ctx.elsewhere === true) throw usageRefusal(SSH_PIPES_HERE_LINE, "Run it from an ssh client on that computer, as wsp's ssh config does.");
      const client = await ctx.client();
      const workspace = await sshWorkspaceOf(client, ref);
      const { port } = await client.request<{ port: number }>("ssh.port", { workspaceId: workspace.id });
      await pipeBytes(port, bytes);
      return 0;
    },
  },
  {
    name: "exec",
    usage: "wsp exec <workspace> [--cwd <dir>] -- <command...>",
    about: "runs the command on the machine, each word as given, in --cwd or the folder a thread would start in",
    page: "agent",
    options: { cwd: { type: "string" } },
    run: async ctx => {
      const [ref, ...words] = ctx.args;
      if (ref === undefined || words.length === 0) throw usageRefusal("wsp exec takes a workspace, then -- and the command.", usageIs(ctx));
      const client = await ctx.client();
      const { workspace } = await awake(client, await workspaceOf(client, ref, "exec"), "exec", line => ctx.io.error(line));
      const folder = absoluteFolder(flag(ctx.flags, "cwd"));
      const { exit, ranIn } = await execOn(client, workspace.id, words, folder, e => {
        if (e.type === "exec.output") ctx.out.emit(e, e.text);
      });
      if (exit.error !== undefined) throw new Error(exit.error);
      ctx.out.emit({ exitCode: exit.exitCode, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      if (exit.exitCode !== null && exit.exitCode !== 0) ctx.io.error(execFolderLine(ranIn));
      return exit.exitCode ?? EXIT_CODES.provider;
    },
    tool: tool({
      description: "Runs a command on the workspace's machine as argv (each word as given; use sh -c for a shell line), in the folder cwd names or the one a thread would start in (the workspace's last used or only project, else its own folder), and returns its output lines, exit code and the folder it ran in. A non-zero exit is a result; the machine going away is an error.",
      input: { workspace: WorkspaceIn, argv: Argv, cwd: CwdIn },
      output: { exitCode: z.number().int().nullable(), output: z.array(z.string()), cwd: z.string().optional().describe("the folder the command ran in, as the host resolved it; absent only on a machine whose kind names no folder, where its own home is where the command ran") },
      stream: ["output"],
      call: async ({ workspace: ref, argv, cwd: folder }, deps) => {
        const asked = absoluteFolder(folder);
        const client = await deps.client();
        const { workspace: target } = await awake(client, await workspaceOf(client, ref, "exec"), "exec", QUIET_LINE);
        const output: string[] = [];
        const { exit, ranIn } = await execOn(client, target.id, argv, asked, e => {
          if (e.type === "exec.output") output.push(e.text);
        });
        if (exit.error !== undefined) throw new Error(exit.error);
        return asText(output.join("\n"), { exitCode: exit.exitCode, output, ...(ranIn !== undefined ? { cwd: ranIn } : {}) });
      },
    }),
  },
  {
    name: "folders",
    usage: "wsp folders [<folder>] [--hidden] [--repos] [--on <computer>]",
    about: "the folders inside one folder on this computer or on a box you added with --on, or with --repos every git repo under the home folder, most recently used first, for naming one to record",
    page: "app",
    options: { hidden: { type: "boolean" }, repos: { type: "boolean" }, on: { type: "string" } },
    run: async ctx => {
      const [folder] = ctx.args;
      if (ctx.args.length > 1) throw usageRefusal("wsp folders takes one folder on this computer at most.", usageIs(ctx));
      const on = typeof ctx.flags["on"] === "string" ? ctx.flags["on"] : undefined;
      const listing = await hostFolders(await ctx.client(), { folder, hidden: ctx.flags["hidden"] === true, repos: ctx.flags["repos"] === true, on }, f => resolve(f));
      ctx.out.emit(listing, folderLines(listing).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The folders directly inside one folder on the person's own computer, or on a box they added, one level at a time, as the app's import dialog browses them: each folder's absolute path, whether git tracks it, and how many hidden ones the level holds. Browse this to name a folder for import instead of guessing a path. The roots are that computer's home folder and the folder of every project on it; a path outside those is refused, and folder absent lists the home folder.<!-- cloud --> A cloud account keeps no computer to browse and is refused.<!-- /cloud --> Folders only: no file is named and nothing is read.",
      input: {
        folder: z.string().optional().describe("the folder to list, absolute and inside the roots; absent lists the home folder"),
        hidden: z.boolean().optional().describe("true lists the hidden folders too, which are otherwise only counted"),
        repos: z.boolean().optional().describe("true answers every git repo under the home folder and the recorded projects instead of one level, each with its branch and when git last wrote to it, most recent first; folder is ignored"),
        on: z.string().optional().describe("the computer whose folders to list, by the name computers lists; absent is the computer the app runs on"),
      },
      output: HostFolderListing.shape,
      call: async ({ folder, hidden, repos, on }, deps) => {
        const listing = await hostFolders(await deps.client(), { folder, hidden, repos, on }, f => absolutePath("folder is a path on this computer", f));
        return asText(folderLines(listing).join("\n"), listing);
      },
    }),
  },
  {
    name: "setup",
    usage: "wsp setup",
    about: "the setup on this host as the app's Settings reads it: which keys are held (never their values), the agents here<!-- cloud -->, what a machine costs<!-- /cloud -->, and the init job's phase, rows and progress when one runs or ran",
    page: "app",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp setup takes no positional arguments.", usageIs(ctx));
      const setup = await initSetup(await ctx.client());
      ctx.out.emit({ setup }, initSetupLines(setup).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The setup on this host, as the app's Settings reads it: which keys the host holds (their presence, never a value), the agents on this computer and whether each carries the wsp tools<!-- cloud -->, what a machine costs<!-- /cloud -->, and the init job when one runs or ran: its road, phase, screens, rows and progress. The rows are the image's stages, each sign-in with the page the person opens on this computer and the code it asks for while it waits, then its state, and the first machine once forked. Read it to tell the person where the build is and which sign-in waits for them; the build is started from the app's Settings, and wsp init --recipe from a shell is the same run.",
      input: {},
      output: { setup: InitSetup },
      call: async (_args, deps) => asJson({ setup: await initSetup(await deps.client()) }),
    }),
  },
  {
    name: "terminal config",
    readsHere: "the Ghostty config it reads is the person's own, in their home on this computer",
    usage: `wsp terminal config [--scheme ${TerminalScheme.options.join("|")}]`,
    about:
      "the Ghostty config on this computer as the app's terminal pane applies it, read from ~/.config/ghostty and Application Support with its includes and theme resolved: the font and its fallbacks, the size, the colors, the cursor, the padding, the background opacity, and the blur, which is read but not applied; --scheme picks the side of a light:...,dark:... theme",
    page: "app",
    options: { scheme: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp terminal config takes no positional arguments.", usageIs(ctx));
      const config = await readGhosttyConfig(nodeHost(), schemeFlag(flag(ctx.flags, "scheme")));
      ctx.out.emit(config, terminalConfigLines(config).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The person's Ghostty config on this computer as the app's terminal pane applies it: every config file Ghostty would load and the theme it names, read now, with only the keys the pane honours. files is empty when they have no Ghostty config, and each other key is absent when no file sets it, so the pane keeps its default there. backgroundBlur is read and not applied: the desktop window's own material is the blur, and a browser tab has none. Read this to say how their terminal looks or to check what a config change did; nothing is written.",
      input: { scheme: TerminalScheme.optional().describe("which side of a light:...,dark:... theme to resolve; dark when absent") },
      output: TerminalConfig.shape,
      call: async ({ scheme }, _deps) => {
        const config = await readGhosttyConfig(nodeHost(), scheme);
        return asText(terminalConfigLines(config).join("\n"), config);
      },
    }),
  },
  {
    name: "export",
    usage: "wsp export <workspace> <folder> [--from <path on the machine>] [--replace] [--agents <ids>]",
    about: "brings a project folder and the agent sessions keyed to it home from the machine",
    page: "agent",
    options: { from: { type: "string" }, replace: { type: "boolean" }, agents: { type: "string" } },
    run: async ctx => {
      const [ref, folder] = ctx.args;
      if (ref === undefined || folder === undefined || ctx.args.length !== 2) throw usageRefusal("wsp export takes a workspace and a folder on this computer.", usageIs(ctx));
      const dest = resolve(folder);
      const agents = agentsFlag(flag(ctx.flags, "agents"));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const req: ExportRequest = { source: flag(ctx.flags, "from") ?? dest, dest, ...(ctx.flags["replace"] === true ? { replace: true } : {}), ...(agents !== undefined ? { agents } : {}) };
      let done = "";
      try {
        const exported = await exportProject(client, workspace.id, req, e => {
          if (e.stage === "done") done = e.message;
          else if (e.stage !== "failed") ctx.out.stream(`${e.message}\n`);
        });
        ctx.out.emit(exported, done);
        return 0;
      } catch (e) {
        throw withReplaceHint(e);
      }
    },
    tool: tool({
      description:
        "Brings a project folder and the agent sessions keyed to it home from the workspace's machine to this computer: the folder lands at `folder` (absolute, must not exist unless replace), the sessions in the agents' homes here keyed to it. `from` is the folder's path on the machine, the same path as `folder` when absent. The result says per agent what moved, what landed as transcripts only, and how many indexed rollouts were skipped.",
      input: {
        workspace: WorkspaceIn,
        folder: z.string().describe("where the folder lands on this computer, absolute"),
        from: z.string().optional().describe("the folder's path on the machine; defaults to folder"),
        replace: z.boolean().optional().describe("remove what is at folder first; without it an existing folder is refused"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions come home; absent means every agent with sessions for the folder"),
      },
      output: ProjectExportResult.shape,
      call: async ({ workspace: ref, folder, from, replace, agents }, deps) => {
        const client = await deps.client();
        const target = await workspaceOf(client, ref);
        const req: ExportRequest = { source: from ?? folder, dest: folder, ...(replace !== undefined ? { replace } : {}), ...(agents !== undefined ? { agents } : {}) };
        let done = "";
        const exported = await exportProject(client, target.id, req, e => {
          if (e.stage === "done") done = e.message;
        });
        return asText(done, exported);
      },
    }),
  },
];
