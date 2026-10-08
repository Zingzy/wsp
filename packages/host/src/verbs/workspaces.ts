// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from "node:path";
import { z } from "zod";
import {
  IMAGE_MOVE_CONFIRM,
  ProjectGolden,
  ProjectGoldenRemoved,
  SealedImage,
  SealedImageCopy,
  SealedProjectImage,
  sealedBuiltLine,
  sealedExportLine,
  projectImageRemoveNotice,
  projectImageRemovedLine,
  type SealedImageExport,
  WorkspaceOut,
  WorkspaceView,
  agentsLine,
  deleteNotice,
  goneRefusal,
  usageRefusal,
  workspaceKind,
  workspaceState,
  threadDeleteQuestion,
  threadDeletedLine,
  turnSpendWord,
  GitCommitReply,
  GitDiscardReply,
  committedLine,
  discardedLine,
  FIX_RESULT_FIELDS,
  FIX_CHECK_OR_CHILD,
  MergeInResult,
  mergeInLine,
  GitUpdateReply,
  MergeMethod,
  MergeResult,
  mergedLine,
  ReviewPostResult,
  START_WORDS,
  StartResult,
} from "@wsp/protocol";
import { hostBack, usageIs, tool, type Verb, PICK_FLAGS, PICK_OPTIONS, flag, flagList, absoluteFolder, openedThreadLine } from "./client.js";
import { workspaceOf, pauseModeOf, stateLine, wokeLine, nap, rebuild, rebuiltLine, imageView, buildImageAt, imageLines, HOST_SIDE_VAULT, imagePassphrase, moveImage, imageMovedLine, renameWorkspace, renamedWorkspaceLine, awake, committed, askedToFix, mergedIn, fixLine, startedFrom, reviewStarted, reviewPosted, startedLines, VERDICTS, mergedPr, updateLine, madeWorktree, dropping, deleting, forgetQuestion, forget, forgotLine, deleteQuestion, imageRemoveQuestion, deleteWorkspace, deletedLine, projectOf, createFor, agentsAsked, projectImageOf, removeProjectImage, setAgents, snapshot, projectGoldenLine } from "./workspaces-help.js";
import { pickFlags, checkedStart, threadHere, refuseMachineThread, threadDeleted, openingOf, notifyOf, follow, turnFailure, followVerb, beforeSending, turnView } from "./turns-help.js";
import { confirmed, QUIET, QUIET_LINE, QUIET_TURN, Created, TurnOut, asJson, asText, WorkspaceIn, AgentIn, NotifyIn, CwdIn, ConfirmIn, PICK_INPUTS, SizeIn, SpawnIn, MaxMachinesIn, MaxDepthIn, AGENTS_ASKED_NOTHING_LINE, agentsToolAskedNothing } from "./io.js";

export const WORKSPACE_VERBS: readonly Verb[] = [
  {
    name: "workspaces agents",
    usage: "wsp workspaces agents <workspace> [--spawn on|off] [--max-machines <n>] [--max-depth <n>]",
    about: "what the agents inside the workspace may ask of this host: threads and machines under the thread they run in, capped, which is the default, or off",
    page: "agent",
    options: { spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp workspaces agents takes one workspace.", usageIs(ctx));
      const asked = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      if (asked === undefined) throw usageRefusal(AGENTS_ASKED_NOTHING_LINE, usageIs(ctx));
      const workspace = await setAgents(await ctx.client(), ref, asked);
      ctx.out.emit({ workspace }, `${workspace.name}: ${agentsLine(workspace.agents)}`);
      return 0;
    },
    tool: tool({
      description:
        "Turns the workspace's agents switch on or off, names its caps, or both; a cap named alone tightens the switch as it stands. Every turn on a workspace is launched with a token into this host scoped to its own thread. With the switch on, which is what every workspace reads as until it is turned off, that thread may open threads and fork machines under itself, up to maxMachines machines at once under one root thread and maxDepth levels deep, and may touch no other workspace, delete nothing, pause nothing and pair no computer. On this Mac the token is identity, not confinement: a thread there runs as the person and can read the host's own token file. Off, each of those acts is refused in one line. A caller that is itself a thread on a machine is refused: what agents may do is the person's to decide.",
      input: { workspace: WorkspaceIn, spawn: SpawnIn, max_machines: MaxMachinesIn, max_depth: MaxDepthIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref, spawn, max_machines: maxMachines, max_depth: maxDepth }, deps) => {
        const asked = agentsAsked(spawn, maxMachines, maxDepth);
        if (asked === undefined) throw agentsToolAskedNothing();
        const workspace = await setAgents(await deps.client(), ref, asked);
        return asText(`${workspace.name}: ${agentsLine(workspace.agents)}`, { workspace });
      },
    }),
  },
  {
    name: "rename",
    usage: 'wsp rename <workspace> "<name>"',
    about: "names the workspace on this computer; the name is unique here, so one another workspace holds is refused",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref, name] = ctx.args;
      if (ref === undefined || name === undefined || ctx.args.length !== 2) throw usageRefusal("wsp rename takes a workspace and one name.", usageIs(ctx));
      const renamed = await renameWorkspace(await ctx.client(), ref, name);
      ctx.out.emit(renamed, renamedWorkspaceLine(renamed));
      return 0;
    },
    tool: tool({
      description:
        "Names the workspace on this computer, the name the sidebar and every listing show and the one workspace takes. A name is unique here, since that is how a workspace is addressed, so a name another workspace holds and a blank one are refused in one line and nothing is renamed. Threads on the machine are addressed by id and run on through it, and the machine at the provider keeps the metadata name it was forked under until it is next forked or rebuilt.",
      input: { workspace: WorkspaceIn, name: z.string() },
      output: { was: z.string(), workspace: WorkspaceOut },
      call: async ({ workspace: ref, name }, deps) => {
        const renamed = await renameWorkspace(await deps.client(), ref, name);
        return asText(renamedWorkspaceLine(renamed), { ...renamed });
      },
    }),
  },
  {
    name: "snapshot",
    cloud: true,
    usage: "wsp snapshot <workspace>",
    about: "a project image of the workspace: your image plus the project as it is now, ready to fork",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp snapshot takes one workspace.", usageIs(ctx));
      const projectGolden = await snapshot(await ctx.client(), ref);
      ctx.out.emit({ projectGolden }, projectGoldenLine(projectGolden));
      return 0;
    },
    tool: tool({
      description: "A project image of the workspace: its image version plus the project loaded on it as its disk stands now, synced first so a file written just before is whole on the image, ready for new with from. Only a running machine with a project imported, on a provider that copies a machine's disk, can be snapshotted, and which life the copy may come from is that provider's rule: a machine that was never resumed on the cloud, any life on a container fork. Anything else, and a disk whose sync fails, is refused in one line and nothing is taken.",
      input: { workspace: WorkspaceIn },
      output: { projectGolden: ProjectGolden },
      call: async ({ workspace: ref }, deps) => asJson({ projectGolden: await snapshot(await deps.client(), ref) }),
    }),
  },
  {
    name: "fork",
    cloud: true,
    usage: 'wsp fork <workspace> [--name <n>] [--size <cpu>x<memGb>] [--send "<task>" [run\'s flags]]',
    about: "a new machine from the source's image version, not a copy of its live disk; --size as new's",
    page: "agent",
    options: { name: { type: "string" }, size: { type: "string" }, send: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS, cwd: { type: "string" }, notify: { type: "string", multiple: true }, spawn: { type: "string" }, "max-machines": { type: "string" }, "max-depth": { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp fork takes one workspace.", usageIs(ctx));
      const task = flag(ctx.flags, "send");
      for (const dependent of ["agent", ...PICK_FLAGS, "cwd", "notify"]) if (task === undefined && flag(ctx.flags, dependent) !== undefined) throw usageRefusal(`--${dependent} says how a thread opens, and this line opens none.`, `Add --send "<task>", or drop --${dependent}.`);
      const client = await ctx.client();
      const harness = flag(ctx.flags, "agent");
      const picks = pickFlags(ctx.flags);
      // Resolved and checked before the machine is minted, so a bad reference or pick costs nothing. The picks are
      // checked against the source's machine, since the fork's own comes from the golden that machine runs.
      const reads = async (): Promise<{ source: WorkspaceView; notify: string[] | undefined }> => {
        const source = await workspaceOf(client, ref);
        if (workspaceState({ phase: source.phase }) === "gone") throw new Error(goneRefusal(source.name, "fork", source.gone));
        const notify = await notifyOf(client, flagList(ctx.flags, "notify"));
        if (task !== undefined) await checkedStart(client, task, harness, picks, source.id);
        return { source, notify };
      };
      const { source, notify } = task === undefined ? await reads() : await beforeSending(client, reads);
      const asked = agentsAsked(flag(ctx.flags, "spawn"), flag(ctx.flags, "max-machines"), flag(ctx.flags, "max-depth"));
      const created = await createFor(client, ctx.out, await projectOf(client, source.project.id), flag(ctx.flags, "name") ?? `${source.name}-fork`, { parent: source.id, ...(flag(ctx.flags, "size") !== undefined ? { size: flag(ctx.flags, "size")! } : {}), ...(asked !== undefined ? { agents: asked } : {}) });
      if (task === undefined) return 0;
      ctx.out.emit({ turn: turnView(await followVerb(ctx, client, openingOf(ctx.env, created.workspace, task, { harness, ...picks, cwd: flag(ctx.flags, "cwd"), notify, elsewhere: ctx.elsewhere }), true, {}, { spend: turnSpendWord(created.workspace) })) });
      return 0;
    },
    tool: tool({
      description: "A sibling workspace from the source's image version (a new machine, not a copy of its live disk); with a task, its first thread is opened and the reply returned. When that first turn fails, the error still names the workspace, which exists: continue with run on it rather than forking again.",
      input: { workspace: WorkspaceIn, name: z.string().optional().describe("defaults to <source>-fork"), size: SizeIn, task: z.string().optional(), agent: AgentIn, ...PICK_INPUTS, cwd: CwdIn, notify: NotifyIn, spawn: SpawnIn, max_machines: MaxMachinesIn, max_depth: MaxDepthIn },
      output: Created.extend({ turn: TurnOut.optional(), failure: z.string().optional() }).shape,
      stream: ["workspace", "notice"],
      call: async ({ workspace: ref, name, size: word, task, agent: harness, cwd: folder, notify: tell, spawn, max_machines: maxMachines, max_depth: maxDepth, ...input }, deps) => {
        absoluteFolder(folder);
        const client = await deps.client();
        const reads = async (): Promise<WorkspaceView> => {
          const source = await workspaceOf(client, ref);
          if (task !== undefined) await checkedStart(client, task, harness, input, source.id);
          return source;
        };
        const source = task === undefined ? await reads() : await beforeSending(client, reads);
        const asked = agentsAsked(spawn, maxMachines, maxDepth);
        const created = await createFor(client, QUIET, await projectOf(client, source.project.id), name ?? `${source.name}-fork`, { parent: source.id, ...(word !== undefined ? { size: word } : {}), ...(asked !== undefined ? { agents: asked } : {}) });
        if (task === undefined) return asJson(created);
        let failure: string;
        try {
          const turn = await follow(client, openingOf(deps.env, created.workspace, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell ?? []), elsewhere: deps.elsewhere }), "agent", QUIET_TURN, () => hostBack(deps));
          const ended = turnFailure(turn);
          if (ended === undefined) return asJson({ ...created, turn: turnView(turn) });
          failure = ended;
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
        }
        // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
        return { ...asText(`created ${created.workspace.name} ${created.workspace.id}; first turn failed: ${failure}`, { ...created, failure }), isError: true };
      },
    }),
  },
  {
    name: "commit",
    usage: 'wsp commit <workspace> [--message "<message>"] [--file <path>]...',
    about: "commits the files the workspace's copy changed, or the ones named; without a message its agent drafts one",
    page: "agent",
    options: { message: { type: "string", short: "m" }, file: { type: "string", multiple: true } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp commit takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "commit", line => ctx.io.error(line));
      const made = await committed(client, awoken.id, flag(ctx.flags, "message"), flagList(ctx.flags, "file"), line => ctx.io.error(line));
      ctx.out.emit({ ...made }, committedLine(awoken.name, made));
      return 0;
    },
    tool: tool({
      description:
        "Commits the files the workspace's copy changed against its last commit, untracked ones added, with the message given, running the copy's hooks as git does; files names some of them by path from the checkout's top and leaves the rest uncommitted. Without a message the workspace's own agent drafts one from the diff and the task its newest thread was opened with, on its own command line with no thread and no tool, and the commit is made with that. Refused in one line when a file named has no change, when git knows no author in the copy (with the command that sets one), when a hook said no (with its last line), and when another git in the copy holds the index after one wait. Nothing reaches a remote: the app's Push is what pushes.",
      input: {
        workspace: WorkspaceIn,
        message: z.string().optional().describe("the commit message, a subject line then a blank line and the body; without one the workspace's agent drafts it"),
        files: z.array(z.string()).optional().describe("the files to commit, by path from the checkout's top as git status names them; without it every changed file"),
      },
      output: GitCommitReply.shape,
      call: async ({ workspace: ref, message, files }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "commit", QUIET_LINE);
        const made = await committed(client, awoken.id, message, files ?? [], () => {});
        return asText(committedLine(awoken.name, made), { ...made });
      },
    }),
  },
  {
    name: "discard",
    usage: "wsp discard <workspace> <path> [--yes]",
    about: "puts one changed file of the workspace's copy back as its last commit has it, or removes it where that has none",
    page: "agent",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref, path] = ctx.args;
      if (ref === undefined || path === undefined || ctx.args.length !== 2) throw usageRefusal("wsp discard takes one workspace and one file.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "discard", line => ctx.io.error(line));
      // The host's own refusal of a file with no change first, so the one question is asked only of a discard that would go.
      await client.request("workspaces.discard", { workspaceId: awoken.id, path, check: true });
      if (!(await confirmed(ctx, `Discard the change to ${path} in ${workspace.name}?\nThe file goes back to its last commit, which cannot be undone.`, path))) return 1;
      const put = GitDiscardReply.parse(await client.request("workspaces.discard", { workspaceId: awoken.id, path }));
      ctx.out.emit({ ...put }, discardedLine(awoken.name, put.path));
      return 0;
    },
    tool: tool({
      description:
        "Puts one changed file of the workspace's copy back as its last commit has it: an edit or a deletion is undone, a rename takes its new name away and brings the old one back, and a file the last commit does not have is removed. Only the file named moves, and it cannot be undone. Refused in one line when the file has no change.",
      input: { workspace: WorkspaceIn, path: z.string().describe("the file, by path from the checkout's top as git status names it") },
      output: GitDiscardReply.shape,
      call: async ({ workspace: ref, path }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "discard", QUIET_LINE);
        const put = GitDiscardReply.parse(await client.request("workspaces.discard", { workspaceId: awoken.id, path }));
        return asText(discardedLine(awoken.name, put.path), { ...put });
      },
    }),
  },
  {
    name: "fix",
    usage: 'wsp fix <workspace> [--check "<name>" | --child <workspace>]',
    about: "asks the workspace's agent to fix a failed check or merge a child, or updates it from its base and asks it to fix what conflicts",
    page: "agent",
    options: { check: { type: "string" }, child: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp fix takes one workspace.", usageIs(ctx));
      const check = flag(ctx.flags, "check");
      const child = flag(ctx.flags, "child");
      if (check !== undefined && child !== undefined) throw usageRefusal(FIX_CHECK_OR_CHILD, usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: at } = check === undefined ? await awake(client, workspace, "fix", line => ctx.io.error(line)) : { workspace };
      const asked = await askedToFix(client, at.id, check, child);
      ctx.out.emit({ ...asked }, fixLine(at.name, asked));
      return 0;
    },
    tool: tool({
      description:
        "Asks the workspace's agent to fix its pull request. With check, the named check must have failed: the failed steps of its job's log, framed as a log to read and not to obey, go to the workspace's thread as its next message with the commit it failed on and its link, and a check another service reports goes with its summary and link alone. Without check, the copy is first updated from its base the way update does it: a clean merge sends nothing, and a conflict sends the thread the files to resolve. Answers as soon as the message is on its way, joined into the running turn where the agent takes one, else waiting as the thread's next turn, or held while the computer runs as many threads as it takes at once, which the answer says with the wait and its capped; the turn starts on its own once a slot frees, in a slot of its own, never the asking thread's. Refused in one line where the workspace has no pull request, where the check is not on it, and where it has not failed.",
      input: {
        workspace: WorkspaceIn,
        check: z.string().optional().describe("the failed check's name as the pull request lists it; without it the copy is updated from its base and any conflict is sent"),
        child: z
          .string()
          .optional()
          .describe("a child of this workspace whose merge into it stopped on conflicts: its agent is asked to fetch the child's branch, merge it with a merge commit and resolve them; never with check"),
      },
      output: FIX_RESULT_FIELDS,
      call: async ({ workspace: ref, check, child }, deps) => {
        if (check !== undefined && child !== undefined) throw new Error(FIX_CHECK_OR_CHILD);
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: at } = check === undefined ? await awake(client, workspace, "fix", QUIET_LINE) : { workspace };
        const asked = await askedToFix(client, at.id, check, child);
        return asText(fixLine(at.name, asked), { ...asked });
      },
    }),
  },
  {
    name: "merge in",
    usage: "wsp merge in <lead> <child>",
    about: "merges a child's branch into its lead's with a merge commit, or names the files that conflict",
    page: "agent",
    options: {},
    run: async ctx => {
      const [lead, child] = ctx.args;
      if (lead === undefined || child === undefined || ctx.args.length !== 2) throw usageRefusal("wsp merge in takes a lead and one of its children.", usageIs(ctx));
      const done = await mergedIn(await ctx.client(), lead, child, line => ctx.io.error(line));
      ctx.out.emit({ ...done }, mergeInLine(done));
      return 0;
    },
    tool: tool({
      description:
        "Merges a child workspace's branch into its lead's copy with a merge commit, so the lead's history shows each child landing: fetched from the project's remote, or from the child's own folder where the project has none and both copies sit on this computer. The lead is woken first where it sleeps. A lead with changes no commit holds is refused first with the files named, and a merge that conflicts is taken back at once and answered with the files, the lead's copy left exactly as it was; fix with child hands those to the lead's agent. Refused, naming the thread, while a turn runs on the lead in any thread but the asking one (a lead's thread merges from inside its own turn), for a workspace that is not the lead's child, and for a thread merging into any workspace but its own. Nothing is pushed.",
      input: {
        lead: WorkspaceIn,
        child: z.string().describe("the child workspace whose branch is merged in, by name or id"),
      },
      output: MergeInResult.shape,
      call: async ({ lead, child }, deps) => {
        const done = await mergedIn(await deps.client(), lead, child, QUIET_LINE);
        return asText(mergeInLine(done), { ...done });
      },
    }),
  },
  {
    name: "merge",
    usage: "wsp merge <workspace> [--method merge|squash|rebase] [--when-checks-pass]",
    about: "merges the workspace's pull request, or merges it once its checks pass",
    page: "agent",
    options: { method: { type: "string" }, "when-checks-pass": { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp merge takes one workspace.", usageIs(ctx));
      const named = flag(ctx.flags, "method");
      const method = named === undefined ? undefined : MergeMethod.safeParse(named);
      if (method !== undefined && !method.success) throw usageRefusal(`--method takes merge, squash or rebase, and got ${named}.`, usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const merged = await mergedPr(client, workspace.id, method?.data, ctx.flags["when-checks-pass"] === true);
      ctx.out.emit({ ...merged }, mergedLine(workspace.name, merged));
      return 0;
    },
    tool: tool({
      description:
        "Merges the workspace's pull request as the person, by the method named or the repository's own default, and only while its head is still the commit the host last read, so a push since then fails it in the git host's own words. when_checks_pass arms it to merge once its checks pass instead, where the repository allows that. Answers with the number, the method, and whether it merged now or waits on its checks. Refused in one line where the workspace has no open pull request, where the repository does not allow the method or does not merge by itself, and with the git host's own reason where it refused, branch protection included. A thread's own token is refused: merging is the person's act.",
      input: {
        workspace: WorkspaceIn,
        method: MergeMethod.optional().describe("merge, squash or rebase; without it the repository's default"),
        when_checks_pass: z.boolean().optional().describe("merge once the checks pass rather than now, where the repository allows it"),
      },
      output: MergeResult.shape,
      call: async ({ workspace: ref, method, when_checks_pass }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const merged = await mergedPr(client, workspace.id, method, when_checks_pass === true);
        return asText(mergedLine(workspace.name, merged), { ...merged });
      },
    }),
  },
  {
    name: "start",
    usage: "wsp start <link> [--project <name>] [--agent <id>] [--model, --effort, --access <word>]",
    about: "a thread off a GitHub issue or pull request link, the issue or the pull request its first message; an issue's thread runs in the project folder, a pull request's in a worktree on its branch",
    page: "agent",
    options: { project: { type: "string" }, agent: { type: "string" }, ...PICK_OPTIONS },
    run: async ctx => {
      const [url] = ctx.args;
      if (url === undefined || ctx.args.length !== 1) throw usageRefusal("wsp start takes one link.", usageIs(ctx));
      const client = await ctx.client();
      const started = await startedFrom(client, { url, project: flag(ctx.flags, "project"), agent: flag(ctx.flags, "agent"), model: flag(ctx.flags, "model"), effort: flag(ctx.flags, "effort"), access: flag(ctx.flags, "access") });
      ctx.out.emit({ ...started }, startedLines(started));
      return 0;
    },
    tool: tool({
      description:
        "Opens a thread off a GitHub issue or pull request link, returning as soon as the thread is started. The link names the repository, and the project here whose remote is that repository is the one used (project names one where two computers hold it); a link no project matches is refused naming the repository and the add line. The issue's or pull request's title, description, comments and link are the thread's first message, and an issue's thread is asked to have its pull request close the issue. On the computer the app runs on an issue's thread runs in the project folder, and a pull request's head is fetched into the project's repo as a branch and its thread runs in a worktree on it, so the project folder's checkout never moves. A thread's own token is refused: starting work from a link is the person's act.",
      input: {
        link: z.string().describe("a GitHub issue or pull request link, https://github.com/<owner>/<repo>/issues/<n> or /pull/<n>"),
        project: z.string().optional().describe("the project by name or id where two projects hold the repository; absent is this computer's"),
        agent: AgentIn,
        ...PICK_INPUTS,
      },
      output: StartResult.shape,
      call: async ({ link, project, agent, model, effort, access }, deps) => {
        const started = await startedFrom(await deps.client(), { url: link, project, agent, model, effort, access });
        return asText(startedLines(started, id => openedThreadLine(id, undefined)), { ...started });
      },
    }),
  },
  {
    name: "review",
    usage: "wsp review <link|workspace> [--agent <id>] [--model, --effort <word>]",
    about: "a reviewer thread on a pull request, read-only, whose review waits in wsp until you post it",
    page: "agent",
    options: { agent: { type: "string" }, model: { type: "string" }, effort: { type: "string" } },
    run: async ctx => {
      const [target] = ctx.args;
      if (target === undefined || ctx.args.length !== 1) throw usageRefusal("wsp review takes one pull request link or workspace.", usageIs(ctx));
      const client = await ctx.client();
      const on = /^https?:\/\//.test(target) ? { url: target } : { workspaceId: (await workspaceOf(client, target)).id };
      const started = await reviewStarted(client, { ...on, agent: flag(ctx.flags, "agent"), model: flag(ctx.flags, "model"), effort: flag(ctx.flags, "effort") });
      ctx.out.emit({ ...started }, startedLines(started));
      return 0;
    },
    tool: tool({
      description:
        "Starts a reviewer thread on a pull request, off its link or off a workspace's own pull request, and returns as soon as the thread is started. The reviewer works in a fresh copy at the pull request's head, at its agent's read-only access (Codex unless another is named; an agent with no read-only access is refused naming the ones that have one), with the description, the diff against the base and the repository's own review rules in its task. Its reply ends in a review the host keeps as the workspace's draft; nothing reaches the git host until review_post. A thread's own token is refused.",
      input: {
        target: z.string().describe("a GitHub pull request link, or the workspace whose pull request to review"),
        agent: z.string().optional().describe("the reviewing agent, codex or claude; absent is codex"),
        model: PICK_INPUTS.model,
        effort: PICK_INPUTS.effort,
      },
      output: StartResult.shape,
      call: async ({ target, agent, model, effort }, deps) => {
        const client = await deps.client();
        const on = /^https?:\/\//.test(target) ? { url: target } : { workspaceId: (await workspaceOf(client, target)).id };
        const started = await reviewStarted(client, { ...on, agent, model, effort });
        return asText(startedLines(started, id => openedThreadLine(id, undefined)), { ...started });
      },
    }),
  },
  {
    name: "review post",
    usage: 'wsp review post <workspace> [--verdict comment|approve|request-changes] [--summary "<text>"]',
    about: "posts a review workspace's review on its pull request as you, its ticked comments on their lines",
    page: "agent",
    options: { verdict: { type: "string" }, summary: { type: "string" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp review post takes one workspace.", usageIs(ctx));
      const named = flag(ctx.flags, "verdict");
      const verdict = named === undefined ? undefined : VERDICTS[named];
      if (named !== undefined && verdict === undefined) throw usageRefusal(`--verdict takes comment, approve or request-changes, and got ${named}.`, usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const posted = await reviewPosted(client, workspace.id, { ...(verdict !== undefined ? { verdict } : {}), ...(flag(ctx.flags, "summary") !== undefined ? { summary: flag(ctx.flags, "summary")! } : {}) });
      ctx.out.emit({ ...posted }, START_WORDS.posted(workspace.name, posted.number, posted.comments, posted.folded));
      return 0;
    },
    tool: tool({
      description:
        "Posts a review workspace's review on its pull request as the person, in one call: the verdict, the summary and every ticked comment on its line, pinned to the head the review was written against. verdict and summary edit the draft first. A comment on a line outside the diff goes into the summary, since the git host takes none there. Refused in one line where the workspace has no review yet, and with the git host's own reason where it refused, approving one's own pull request included. A thread's own token is refused: posting under the person's name is the person's act.",
      input: {
        workspace: WorkspaceIn,
        verdict: z.enum(["comment", "approve", "request_changes"]).optional().describe("comment, approve or request_changes; absent is the draft's"),
        summary: z.string().optional().describe("the review's summary; absent is the draft's"),
      },
      output: ReviewPostResult.shape,
      call: async ({ workspace: ref, verdict, summary }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const posted = await reviewPosted(client, workspace.id, { ...(verdict !== undefined ? { verdict } : {}), ...(summary !== undefined ? { summary } : {}) });
        return asText(START_WORDS.posted(workspace.name, posted.number, posted.comments, posted.folded), { ...posted });
      },
    }),
  },
  {
    name: "update",
    usage: "wsp update <workspace>",
    about: "merges the latest commits of the workspace's base into its branch, or names the files that conflict",
    page: "agent",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp update takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await workspaceOf(client, ref);
      const { workspace: awoken } = await awake(client, workspace, "update", line => ctx.io.error(line));
      const done = GitUpdateReply.parse(await client.request("workspaces.update", { workspaceId: awoken.id }));
      ctx.out.emit({ ...done }, updateLine(awoken.name, done));
      return 0;
    },
    tool: tool({
      description:
        "Merges the latest commits of the workspace's base from the remote into the branch its copy is on, with a merge commit, so a branch already pushed is never rewritten. A copy with changes no commit holds is refused first with the files named. A merge that conflicts is taken back at once and answered with the files that conflict, the copy left exactly as it was; fix sends those to the agent. Nothing is pushed.",
      input: { workspace: WorkspaceIn },
      output: GitUpdateReply.shape,
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const workspace = await workspaceOf(client, ref);
        const { workspace: awoken } = await awake(client, workspace, "update", QUIET_LINE);
        const done = GitUpdateReply.parse(await client.request("workspaces.update", { workspaceId: awoken.id }));
        return asText(updateLine(awoken.name, done), { ...done });
      },
    }),
  },
  {
    name: "pause",
    usage: "wsp pause <workspace>",
    about: "naps the workspace's machine",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp pause takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const workspace = await nap(client, ref);
      ctx.out.emit({ workspace }, stateLine(workspace, await pauseModeOf(client, workspace.project.id)));
      return 0;
    },
    tool: tool({
      description: "Naps the workspace's machine; it wakes on the next thread or command.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => asJson({ workspace: await nap(await deps.client(), ref) }),
    }),
  },
  {
    name: "wake",
    usage: "wsp wake <workspace>",
    about: "wakes the workspace's machine and prints the state the next wsp workspaces will show for it",
    page: "front",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp wake takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const { workspace } = await awake(client, await workspaceOf(client, ref), "wake", line => ctx.io.error(line));
      ctx.out.emit({ workspace }, await wokeLine(client, workspace));
      return 0;
    },
    tool: tool({
      description: "Wakes the workspace's machine and returns its view once the runtime has answered; one already running comes back unchanged. run, send and exec do this themselves, so it is only needed to wake a machine ahead of them.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        return asJson({ workspace: (await awake(client, await workspaceOf(client, ref), "wake", QUIET_LINE)).workspace });
      },
    }),
  },
  {
    name: "rebuild",
    cloud: true,
    usage: "wsp rebuild <workspace>",
    about: "replaces a gone workspace's machine from its image and prints the state of the new one",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp rebuild takes one workspace.", usageIs(ctx));
      const workspace = await rebuild(await ctx.client(), ref);
      ctx.out.emit({ workspace }, rebuiltLine(workspace));
      return 0;
    },
    tool: tool({
      description:
        "Replaces the machine of a workspace the provider no longer has, forking it afresh from the image the workspace was made on and importing the vault its last nap left; the workspace keeps its id, its name and its threads, and the new machine's id and state come back once the runtime has them. Anything written on the old machine's disk since that nap is not there. This is the road out of the refusal every other verb gives a gone workspace, and it is refused in one line on a machine that still answers.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut },
      call: async ({ workspace: ref }, deps) => {
        const workspace = await rebuild(await deps.client(), ref);
        return asText(rebuiltLine(workspace), { workspace });
      },
    }),
  },
  {
    name: "image",
    usage: "wsp image",
    about: "the image this host owns: its version, its hash, whether it holds your sign-ins, and the copy each place has built of it",
    page: "agent",
    options: {},
    run: async ctx => {
      if (ctx.args.length !== 0) throw usageRefusal("wsp image takes no positional arguments.", usageIs(ctx));
      const view = await imageView(await ctx.client());
      ctx.out.emit(view, imageLines(view).join("\n"));
      return 0;
    },
    tool: tool({
      description:
        "The image this host owns and the copy each place has built of it. The record is the recipe the seal was planned from, the sign-ins it holds and a hash over both; a copy built at that hash is current and any other is stale, whatever version the place's own manifest gave it. A record with no vault was read back off its own copy rather than written at a seal, so it judges none of them and every copy of it asks for the sign-ins again: cutting the next version holds them. The project images taken off workspaces are listed under it, each with its snapshot id, the workspace it was taken off, its size where the provider lists one and its date.",
      input: {},
      output: { image: SealedImage.nullable(), copies: z.array(SealedImageCopy), projects: z.array(SealedProjectImage) },
      call: async (_args, deps) => {
        const view = await imageView(await deps.client());
        return asText(imageLines(view).join("\n"), view);
      },
    }),
  },
  {
    name: "image build",
    cloud: true,
    usage: "wsp image build <place> [--force]",
    about: "builds this host's image at a place from the record, its sign-ins coming from the vault and no sign-in run again",
    page: "agent",
    options: { force: { type: "boolean" } },
    run: async ctx => {
      const [place] = ctx.args;
      if (place === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image build takes one place.", usageIs(ctx));
      const { image, built } = await buildImageAt(await ctx.client(), ctx.out, place, ctx.flags["force"] === true);
      ctx.out.emit(built, sealedBuiltLine(image, built));
      return 0;
    },
    tool: tool({
      description:
        "Builds this host's image at a place from the record alone: a builder is forked there with the recipe the image was sealed from and every sign-in set to skip, the sign-ins the seal held are landed on it out of the vault, and the copy is sealed and recorded under that place at the record's hash. Nothing signs in again and no Keychain is read. A place that already holds a copy built from this record is answered with that copy and `built` false, so asking twice costs nothing; a place whose copy is building is answered with that build, never a second one. A joined computer builds its copy at the end of its setup; every other copy, and every copy a newer version left behind, is built only when this line asks or when a fork there finds no current copy, and that fork says so before the build starts, since a build bills where it runs. Refused in one line for a place this host does not hold, for a place that takes no copy at all, and for a record sealed without the recipe it was built from. A record holding no sign-ins is refused too, since every copy of it would ask for them again; `force` builds it anyway.",
      input: { place: z.string().describe("the place to build the copy at, by the name wsp places lists"), force: z.boolean().optional().describe("build even where the record holds no sign-ins, so the copy asks for every one of them again") },
      output: { copy: SealedImageCopy, built: z.boolean() },
      call: async ({ place, force }, deps) => {
        const { image, built } = await buildImageAt(await deps.client(), QUIET, place, force);
        return asText(sealedBuiltLine(image, built), built);
      },
    }),
  },
  {
    name: "image export",
    cloud: true,
    usage: "wsp image export <file>",
    about: "writes the image record and your sign-ins to one encrypted file, sealed to a passphrase you type",
    page: "agent",
    options: {},
    cliOnly: "the vault leaves the host only at a person's hand, with a passphrase they type",
    hostSide: HOST_SIDE_VAULT,
    run: async ctx => {
      const [dest] = ctx.args;
      if (dest === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image export takes one file on this computer.", usageIs(ctx));
      const passphrase = await imagePassphrase(ctx);
      const { exported } = await (await ctx.client()).request<{ exported: SealedImageExport }>("image.export", { dest: resolve(dest), passphrase });
      ctx.out.emit({ exported }, sealedExportLine(exported));
      return 0;
    },
  },
  {
    name: "image move",
    cloud: true,
    usage: "wsp image move <workspace>",
    about: "moves the workspace onto the newest version of its image and prints what of the image's own files it kept",
    page: "app",
    options: {},
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image move takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const source = await workspaceOf(client, ref);
      ctx.io.error(IMAGE_MOVE_CONFIRM);
      const moved = await moveImage(client, source.id);
      ctx.out.emit(moved, imageMovedLine(moved));
      return 0;
    },
    tool: tool({
      description:
        "Moves the workspace onto the newest version of the image it was forked from: a fresh machine of that image replaces the old one and the workspace's home folder comes across, less the files the image itself wrote and nobody changed here, whose newer copies come with the image. `kept` names the files of the image's own this workspace had changed, which travelled instead. An archive carries no deletion, so a file taken out of a folder the image writes into comes back with the new image. Anything installed outside the home folder comes from the new image, and everything running on the old machine stops with it. Refused in one line on a workspace that is not running, one forked from a project image, and one whose image this host no longer holds; one already on the newest version comes back untouched and says so.",
      input: { workspace: WorkspaceIn },
      output: { workspace: WorkspaceOut, moved: z.boolean(), kept: z.array(z.string()), fallback: z.boolean().optional() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const source = await workspaceOf(client, ref);
        const moved = await moveImage(client, source.id);
        return asText(imageMovedLine(moved), moved);
      },
    }),
  },
  {
    name: "image remove",
    cloud: true,
    usage: "wsp image remove <snapshot id> [--yes]",
    about: "deletes a project image's snapshot at the provider and drops its record; refused while a workspace stands on it",
    page: "app",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [id] = ctx.args;
      if (id === undefined || ctx.args.length !== 1) throw usageRefusal("wsp image remove takes one project image, by the id wsp image lists it under.", usageIs(ctx));
      const client = await ctx.client();
      const golden = await projectImageOf(client, id);
      if (!(await confirmed(ctx, imageRemoveQuestion(golden), id))) return 1;
      const removed = await removeProjectImage(client, id);
      ctx.out.emit(removed, projectImageRemovedLine(id, removed.alreadyGone));
      return 0;
    },
    tool: tool({
      description:
        "Deletes a project image's snapshot at the provider its place names and then drops its record, so no later fork starts from it; the id is the one the image tool lists each project image under, never a project's name. The provider's listing is read back until the id has left it: a snapshot the provider had already lost drops its record and answers `alreadyGone` true, a listing that still holds the id after the wait keeps the record and says to ask again, and any other refusal of the provider's keeps the record and carries the provider's own words. Refused in one line while any workspace stands on the image, whatever its state, naming them: delete those first, or forget one whose machine is gone. Called without confirm it removes nothing and answers with what would go, which is the line to put to the person.",
      input: {
        image: z.string().describe("the project image's snapshot id, as the image tool lists it"),
        confirm: z.boolean().optional().describe("true deletes the snapshot; absent or false answers with what would go and deletes nothing, so a person can be asked first"),
      },
      output: ProjectGoldenRemoved.shape,
      call: async ({ image: id, confirm }, deps) => {
        const client = await deps.client();
        const golden = await projectImageOf(client, id);
        if (confirm !== true) {
          return { ...asText(`${id} kept. ${projectImageRemoveNotice(golden)} Ask the person, then call image_remove again with confirm true.`, { projectGolden: golden, alreadyGone: false }), isError: true };
        }
        const removed = await removeProjectImage(client, id);
        return asText(projectImageRemovedLine(id, removed.alreadyGone), removed);
      },
    }),
  },
  {
    name: "forget",
    usage: "wsp forget <workspace> [--yes]",
    about: "drops a gone workspace and its threads from this computer; refused while its machine exists",
    page: "agent",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp forget takes one workspace.", usageIs(ctx));
      const client = await ctx.client();
      const f = await dropping(client, ref);
      if (!(await confirmed(ctx, forgetQuestion(f), f.workspace.name))) return 1;
      await forget(client, f);
      ctx.out.emit({ workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads }, forgotLine(f));
      return 0;
    },
    tool: tool({
      description:
        "Drops a workspace whose machine the provider no longer has: its record and its threads leave this computer and the person's sidebar. The provider is read until twelve reads in a row agree the machine is gone, and nothing is asked of the machine. Refused in one line while the machine still exists (pause it, or delete it at the provider, first).",
      input: { workspace: WorkspaceIn },
      output: { workspaceId: z.string(), name: z.string(), threads: z.number().int() },
      call: async ({ workspace: ref }, deps) => {
        const client = await deps.client();
        const f = await dropping(client, ref);
        await forget(client, f);
        return asText(forgotLine(f), { workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads });
      },
    }),
  },
  {
    name: "delete",
    usage: "wsp delete <thread>|<workspace> [--yes]",
    about:
      "takes a thread on this computer away, its turns and checkpoints with it, and the worktree wsp made for it with every thread in it, never the project folder; a workspace on a box goes as before, its machine deleted at the provider and its record and threads dropped from this computer",
    page: "front",
    options: { yes: { type: "boolean" } },
    run: async ctx => {
      const [ref] = ctx.args;
      if (ref === undefined || ctx.args.length !== 1) throw usageRefusal("wsp delete takes one thread, or one workspace on a box.", usageIs(ctx));
      const client = await ctx.client();
      const here = await threadHere(client, ref);
      if (here !== undefined) {
        if (!(await confirmed(ctx, threadDeleteQuestion(here.id, here.worktree), here.id))) return 1;
        const gone = await threadDeleted(client, here.id);
        ctx.out.emit({ threadId: here.id, ...gone }, threadDeletedLine(here.id, gone));
        return 0;
      }
      // A workspace by that name comes first; a ref that names none but is a thread on a box's machine says how that
      // thread goes, rather than that no workspace has its id.
      const d = await deleting(client, ref).catch(async (e: unknown) => {
        await refuseMachineThread(client, ref);
        throw e;
      });
      if (!(await confirmed(ctx, deleteQuestion(d), d.workspace.name))) return 1;
      await deleteWorkspace(client, d);
      ctx.out.emit({ workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads }, deletedLine(d));
      return 0;
    },
    tool: tool({
      description:
        "Takes a thread on this computer away, named by thread: its turns and checkpoints go, and where it ran in a worktree wsp made, that worktree goes with every thread in it, refused over files no commit holds; the project folder is never touched. Named by workspace, a workspace on a box goes as before: its machine is deleted at the provider and its record and threads dropped from this computer and the person's sidebar, and everything on that machine's disk that was not exported or pushed goes with it. Called without confirm it deletes nothing and answers with what would go, which is the line to put to the person.",
      input: { thread: z.string().optional().describe("a thread on this computer, by its id or a prefix that names one"), workspace: WorkspaceIn.optional(), confirm: ConfirmIn },
      output: { threadId: z.string().optional(), workspaceId: z.string(), worktree: z.string().optional(), name: z.string().optional(), machineId: z.string().optional(), threads: z.number().int() },
      call: async ({ thread: threadRef, workspace: ref, confirm }, deps) => {
        const client = await deps.client();
        if (threadRef !== undefined) {
          const here = await threadHere(client, threadRef);
          if (here === undefined) {
            await refuseMachineThread(client, threadRef);
            throw usageRefusal(`no thread ${threadRef} on this computer`, "Name a thread wsp threads lists.");
          }
          if (confirm !== true) return { ...asText(`thread ${here.id} kept. ${threadDeleteQuestion(here.id, here.worktree).split("\n")[1]} Ask the person, then call delete again with confirm true.`, { threadId: here.id, workspaceId: here.workspaceId, threads: 1 }), isError: true };
          const gone = await threadDeleted(client, here.id);
          return asText(threadDeletedLine(here.id, gone), { threadId: here.id, ...gone });
        }
        if (ref === undefined) throw usageRefusal("delete takes a thread, or a workspace on a box.", "Name one.");
        const d = await deleting(client, ref);
        const going = { workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads };
        // The command line asks a person before this and the app will; over MCP the second call is that step, so a
        // machine is never killed by one tool call the caller made on its own.
        if (confirm !== true) {
          return { ...asText(`${d.workspace.name} kept. ${deleteNotice(d.threads, workspaceKind(d.workspace), madeWorktree(d.workspace), d.workspace.machineId, d.on)} Ask the person, then call delete again with confirm true.`, going), isError: true };
        }
        await deleteWorkspace(client, d);
        return asText(deletedLine(d), going);
      },
    }),
  },
];
