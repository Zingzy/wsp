// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs as MCP tools for an agent on this computer, over stdio: the
// same socket client and verb functions the command line uses, one dial kept
// across calls and dialled again after the host went away. A thread opened
// here is the local agent's. Nothing here reads a key or imports the runtime.
import type { Readable, Writable } from "node:stream";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { nodeHost } from "@wsp/collect";
import { AFTER_CUT_LINE, LOGIN_CHOICES, ProjectExportResult, ProjectGolden, ProjectImportResult, ProjectPlan, RECIPE_TICKS, RecipeTick, SessionInterruptOutcome, SessionStartOutcome, ThreadView, WorkspaceView, actionRefusal, deleteNotice, importConsented, importRequest, workspaceState } from "@wsp/protocol";
import { historyCache, smallRecipePath } from "./recipe-file.js";
import { runRecipe, runScan, type ScanInput } from "./recipe-command.js";
import { RecipeAnswer, RecipeScan, recipePrintout, scanPrintout } from "./recipe-answer.js";
import { INSTRUCTIONS } from "./skill.js";
import { THREAD_AGENTS } from "./thread-agents.js";
import { VERSION } from "./version.js";
import { absoluteFolder, absolutePath, agentsChosen, awake, checkedPicks, create, createFromHead, deleteWorkspace, deletedLine, dialHost, dropping, execOn, exportProject, follow, forget, forgotLine, importProject, nap, notifyOf, openingOf, planLines, planProject, projectGoldenOf, resumeOf, secretsChosen, snapshot, stop, stopLine, threadOf, threadRows, turnFailure, workspaceOf, workspaces, type ExportRequest, type HostClient, type Out, type Turn } from "./verbs.js";

/** Nothing printed: the tools answer with values, and the stages a create streams have no reader here. */
const QUIET: Out = { emit: () => {}, stream: () => {} };
/** The waking line has no reader here either: the tool's result says which machine ran. */
const QUIET_LINE = (): void => {};

export interface Dialer {
  (): Promise<HostClient>;
  close(): Promise<void>;
}

/** One socket to the host across tool calls, dropped when it closes so the next call dials again. */
export function dialer(statePath: string): Dialer {
  let client: Promise<HostClient> | undefined;
  const dial = (): Promise<HostClient> =>
    (client ??= dialHost(statePath).then(
      c => {
        void c.closed.then(() => {
          client = undefined;
        });
        return c;
      },
      (e: unknown) => {
        client = undefined;
        throw e;
      },
    ));
  return Object.assign(dial, {
    close: async () => {
      const open = client;
      client = undefined;
      if (open !== undefined) await open.then(c => c.close(), () => undefined);
    },
  });
}

const Created = z.object({ workspace: WorkspaceView, notice: z.string().optional() });
/** outcome says how the message landed: its own turn, steered into the thread's running one, or queued behind it;
 * afterCut is set when the thread's previous turn ended without a result, so the reply may be missing context. */
const TurnOut = z.object({ threadId: z.string(), workspaceId: z.string(), harness: z.string(), text: z.string(), outcome: SessionStartOutcome, afterCut: z.literal(true).optional() });
const ThreadRowOut = ThreadView.extend({ workspaceName: z.string() });
const Argv = z.array(z.string()).min(1);

type Structured = Record<string, unknown>;

/** A result the agent reads as text and a client with a schema reads as the same value. */
const asJson = (structured: Structured) => ({ content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }], structuredContent: structured });
const asText = (text: string, structured: Structured) => ({ content: [{ type: "text" as const, text }], structuredContent: structured });

const turnView = (turn: Turn): z.infer<typeof TurnOut> => ({
  threadId: turn.threadId,
  workspaceId: turn.session.workspaceId,
  harness: turn.session.harness,
  text: turn.result?.text ?? "",
  outcome: turn.outcome,
  ...(turn.afterCut === true ? { afterCut: true as const } : {}),
});

/** The reply as the tool's text, with the cut line first when the thread's previous turn did not finish. */
const turnText = (out: z.infer<typeof TurnOut>): string => (out.afterCut === true ? `${AFTER_CUT_LINE}\n${out.text}` : out.text);

/** The turn's reply as the tool result; a turn that did not complete is a tool error with the harness's reason. */
function turnOut(turn: Turn): z.infer<typeof TurnOut> {
  const failure = turnFailure(turn);
  if (failure !== undefined) throw new Error(failure);
  return turnView(turn);
}

const QUIET_TURN = { event: () => {} };

/** The line under a plan the tool returned without importing: the call that says yes, and the two per-row answers. */
const PLAN_ONLY_TOOL = "nothing imported; call import again with yes true to take these defaults, or keep and cut per secret-shaped row";

export function mcpServer(statePath: string, opts: { dial?: Dialer; alsoHere?: ScanInput["alsoHere"] } = {}): McpServer {
  const dial = opts.dial ?? dialer(statePath);
  const server = new McpServer({ name: "wsp", version: VERSION }, { instructions: INSTRUCTIONS });
  const workspace = z.string().describe("the workspace's name, or its id when two share a name");
  const agent = z.string().optional().describe(`the agent to run in the thread, one of ${THREAD_AGENTS.join(", ")}; absent means the host's default`);
  const notify = z.string().optional().describe("a thread (by id, or a prefix of it) told in one line each time a turn of the new thread ends, as a message into it; or me, for the person's app");
  const cwd = z.string().optional().describe("the folder on the machine the thread works in, absolute; absent means the workspace's project folder, else the home folder");
  const confirmDelete = z.boolean().optional().describe("true deletes the machine; absent or false answers with what would go and deletes nothing, so a person can be asked first");
  /** The same three words the app's composer uses; the runtime refuses a value the agent's catalog does not list, naming the list. */
  const picks = {
    model: z.string().optional().describe("the model the turn runs on, by the agent's own slug (claude-sonnet-5); absent on a new thread means the catalog's default, on send the thread's own"),
    effort: z.string().optional().describe("the reasoning effort, by the agent's own word (low, medium, high); absent means the agent's default"),
    access: z.string().optional().describe("the access mode, by the agent's own word (plan, acceptEdits, bypassPermissions); absent means the agent's default"),
  };

  const PROJECT_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count");
  /** The same folders on the write verb, where naming them is also naming a rule input, so it re-decides the ticks. */
  const WEIGH_BY_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count. Naming one re-decides every tick from the rule, as tick does, so any flip an earlier call made goes");
  /** Absolute, since this server's own folder is wherever the agent launched it and a prefix test on a relative
   * path silently matches nothing. */
  const projectFolders = (folders: readonly string[]): string[] => folders.map(f => absolutePath("project is a folder on this computer", f));

  server.registerTool(
    "recipe_scan",
    {
      description:
        "Every option this computer offers for a machine, read once and written nowhere: the person's agents and the catalog's tools with the tick their own use reaches and what each adds to the machine, what else a package manager on this computer has that the image could take (alsoHere, by manager, with the line that installs each on the machine, which is the line to hand recipe's add), whose scanned says whether anything looked, the commands their agents ran that the catalog does not carry, and the sign-in each ticked row brings. Every row carries a recommended value and a one-line reason, so apply those and put only the rows whose reason says worth a question. Run this before recipe, and before asking the person anything. Only names and counts are read.",
      inputSchema: { project: PROJECT_FOLDERS },
      outputSchema: RecipeScan.shape,
    },
    async ({ project }) => {
      const scan = await runScan(nodeHost(), {
        cache: historyCache(statePath),
        ...(project !== undefined ? { projects: projectFolders(project) } : {}),
        ...(opts.alsoHere !== undefined ? { alsoHere: opts.alsoHere } : {}),
      });
      return asText(scanPrintout(scan).join("\n"), scan);
    },
  );
  server.registerTool(
    "recipe",
    {
      description:
        `The recipe for a machine, read off this computer and written to a file: every catalog agent and tool with its tick, why it has that tick, and what it adds to the machine, plus the commands the person's agents ran that no catalog row carries. tick names the rule: used ticks what their agents actually ran here, installed ticks what is on this computer, default ticks what the catalog ships on; an agent wsp cannot open a thread on is off unless installed. The file is the state, so a second call is not a fresh start: naming tick or project lets the rule decide every tick again and throws away the flips a call before it made, and a call that names neither keeps what the file says and puts its own flips on top. Sign-in answers stand through every call whatever the rule, since nothing but the person decides one. Put the heavy rows to the person with their sizes before anything is built, then flip rows with set and run \`wsp init --recipe <out> --non-interactive --json\` from a shell, handing the person each sign-in line it prints, since the sign-ins finish in their browser. Only names and counts are read; nothing a session held is returned.`,
      inputSchema: {
        tick: RecipeTick.optional().describe(`which rule decides every tick: ${RECIPE_TICKS.join(", ")}. Naming it re-decides every row from the rule, so any flip an earlier call made goes; absent, the file's own rule and its ticks stand, and used decides a first call and any row the file does not carry`),
        set: z.array(z.string()).optional().describe('rows to flip by catalog id, "<id>=on" or "<id>=off", applied over whatever decided the row. On a call that names tick or project they sit over the rule\'s fresh answer; on any other call they sit over the ticks already in the file'),
        signin: z.array(z.string()).optional().describe(`what happens to a row's sign-in, "<id>=${LOGIN_CHOICES.join("|")}"; key brings the key files beside its login and the login still runs on the machine. An answer already in the file stands until a later call names that row again, whatever tick or project do to the ticks`),
        add: z.array(z.string()).optional().describe('tools the catalog does not carry, "<id>=<install command>"; the line runs on the machine as given after every catalog install, and such a row is never offered a sign-in. Rows an earlier call added stand, whatever tick or project do to the ticks'),
        add_check: z.array(z.string()).optional().describe('what proves an added tool landed, "<id>=<command that exits 0>"; without one the id on PATH is the check'),
        why: z.string().optional().describe("what the rows this call adds are for, in your own words; absent, they say an agent added them"),
        project: WEIGH_BY_FOLDERS,
        out: z.string().optional().describe("where the recipe file goes, absolute; absent means the host's own recipe.json beside its state"),
      },
      outputSchema: RecipeAnswer.shape,
    },
    async ({ tick, set, signin, add, add_check: addCheck, why, project, out }) => {
      const table = await runRecipe(nodeHost(), {
        out: out === undefined ? smallRecipePath(statePath) : absolutePath("out is a path on this computer", out),
        cache: historyCache(statePath),
        ...(tick !== undefined ? { tick } : {}),
        ...(set !== undefined ? { set } : {}),
        ...(signin !== undefined ? { signin } : {}),
        ...(add !== undefined ? { add } : {}),
        ...(addCheck !== undefined ? { addCheck } : {}),
        ...(why !== undefined ? { why } : {}),
        ...(project !== undefined ? { projects: projectFolders(project) } : {}),
      });
      return asText(recipePrintout(table).join("\n"), table);
    },
  );
  server.registerTool(
    "workspaces",
    { description: "Every workspace this host runs, as the app lists them: id, name, phase (running or napping) and the golden it forked from.", outputSchema: { workspaces: z.array(WorkspaceView) } },
    async () => asJson({ workspaces: await workspaces(await dial()) }),
  );
  server.registerTool(
    "threads",
    {
      description: "Every thread as the sidebar lists it: the workspace, the agent inside, its state, who opened it (person, cli or agent), the folder it works in and its title. Optionally within one workspace.",
      inputSchema: { workspace: workspace.optional() },
      outputSchema: { threads: z.array(ThreadRowOut) },
    },
    async ({ workspace: within }) => asJson({ threads: await threadRows(await dial(), within) }),
  );
  server.registerTool(
    "new",
    {
      description: "A new workspace forked from the golden image's head, or with from, from a project golden (the project already in place), booted and reachable when this returns.",
      inputSchema: { name: z.string(), from: z.string().optional().describe("a project golden: its project's name (the newest taken of it) or its snapshot id, as snapshot returns them") },
      outputSchema: Created.shape,
    },
    async ({ name, from }) => {
      const client = await dial();
      if (from === undefined) return asJson(await createFromHead(client, QUIET, name));
      return asJson(await create(client, QUIET, (await projectGoldenOf(client, from)).snapshotId, name));
    },
  );
  server.registerTool(
    "snapshot",
    {
      description: "A project golden of the workspace: its golden version plus the project loaded on it as it stands now, ready for new with from. Only a running first-life machine with a project imported can be snapshotted; anything else is refused in one line and nothing is taken.",
      inputSchema: { workspace },
      outputSchema: { projectGolden: ProjectGolden },
    },
    async ({ workspace: ref }) => asJson({ projectGolden: await snapshot(await dial(), ref) }),
  );
  server.registerTool(
    "fork",
    {
      description: "A sibling workspace from the source's golden version (a new machine, not a copy of its live disk); with a task, its first thread is opened and the reply returned. When that first turn fails, the error still names the workspace, which exists: continue with thread_new on it rather than forking again.",
      inputSchema: { workspace, name: z.string().optional().describe("defaults to <source>-fork"), task: z.string().optional(), agent, ...picks, cwd, notify },
      outputSchema: Created.extend({ turn: TurnOut.optional(), failure: z.string().optional() }).shape,
    },
    async ({ workspace: ref, name, task, agent: harness, cwd: folder, notify: tell, ...input }) => {
      absoluteFolder(folder);
      const client = await dial();
      const source = await workspaceOf(client, ref);
      if (task !== undefined) await checkedPicks(client, harness, input);
      const created = await create(client, QUIET, source.golden, name ?? `${source.name}-fork`);
      if (task === undefined) return asJson(created);
      let failure: string;
      try {
        const turn = await follow(client, openingOf(created.workspace, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell) }), "agent", QUIET_TURN);
        const ended = turnFailure(turn);
        if (ended === undefined) return asJson({ ...created, turn: turnView(turn) });
        failure = ended;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      // The machine was minted before the turn failed; an error that hid it would have the agent fork a second one.
      return { ...asText(`created ${created.workspace.name} ${created.workspace.id}; first turn failed: ${failure}`, { ...created, failure }), isError: true };
    },
  );
  server.registerTool(
    "pause",
    { description: "Naps the workspace's machine; it wakes on the next thread or command.", inputSchema: { workspace }, outputSchema: { workspace: WorkspaceView } },
    async ({ workspace: ref }) => asJson({ workspace: await nap(await dial(), ref) }),
  );
  server.registerTool(
    "wake",
    { description: "Wakes the workspace's machine and returns its view once the runtime has answered; one already running comes back unchanged. thread_new, send and exec do this themselves, so it is only needed to wake a machine ahead of them.", inputSchema: { workspace }, outputSchema: { workspace: WorkspaceView } },
    async ({ workspace: ref }) => {
      const client = await dial();
      return asJson({ workspace: await awake(client, await workspaceOf(client, ref), "wake", QUIET_LINE) });
    },
  );
  server.registerTool(
    "forget",
    {
      description:
        "Drops a workspace whose machine the provider no longer has: its record and its threads leave this computer and the person's sidebar, and nothing is asked of the provider. Refused in one line while the machine still exists (pause it, or delete it at the provider, first).",
      inputSchema: { workspace },
      outputSchema: { workspaceId: z.string(), name: z.string(), threads: z.number().int() },
    },
    async ({ workspace: ref }) => {
      const client = await dial();
      const f = await dropping(client, ref);
      await forget(client, f);
      return asText(forgotLine(f), { workspaceId: f.workspace.id, name: f.workspace.name, threads: f.threads });
    },
  );
  server.registerTool(
    "delete",
    {
      description:
        "Deletes the workspace's machine at the provider and drops its record and its threads from this computer and the person's sidebar. Everything on that machine's disk that was not exported or pushed goes with it and no wake brings it back; a workspace whose machine is already gone takes forget instead. Called without confirm it deletes nothing and answers with what would go, which is the line to put to the person.",
      inputSchema: { workspace, confirm: confirmDelete },
      outputSchema: { workspaceId: z.string(), name: z.string(), machineId: z.string(), threads: z.number().int() },
    },
    async ({ workspace: ref, confirm }) => {
      const client = await dial();
      const d = await dropping(client, ref);
      const going = { workspaceId: d.workspace.id, name: d.workspace.name, machineId: d.workspace.machineId, threads: d.threads };
      // The command line asks a person before this and the app will; over MCP the second call is that step, so a
      // machine is never killed by one tool call the caller made on its own.
      if (confirm !== true) {
        return { ...asText(`${d.workspace.name} kept. ${deleteNotice(d.threads)} Ask the person, then call delete again with confirm true.`, going), isError: true };
      }
      await deleteWorkspace(client, d);
      return asText(deletedLine(d), going);
    },
  );
  server.registerTool(
    "thread_new",
    {
      description: "Opens a thread in the workspace under the named agent, on the model, effort and access mode named or the catalog's defaults (a cheaper model for a review, say), in the folder cwd names or the workspace's project folder, and follows its first turn; returns the reply text when the turn ends, with the thread id for send. With notify, every turn of the thread that ends later sends one line (outcome, duration, cost, last line of the reply) into the named thread, so a caller need not wait here or poll.",
      inputSchema: { workspace, task: z.string(), agent, ...picks, cwd, notify },
      outputSchema: TurnOut.shape,
    },
    async ({ workspace: ref, task, agent: harness, cwd: folder, notify: tell, ...input }) => {
      const client = await dial();
      const target = await awake(client, await workspaceOf(client, ref), "send", QUIET_LINE);
      const out = turnOut(await follow(client, openingOf(target, task, { harness, ...input, cwd: folder, notify: await notifyOf(client, tell) }), "agent", QUIET_TURN));
      return asText(turnText(out), out);
    },
  );
  server.registerTool(
    "send",
    {
      description: "Sends a message to an existing thread (by id, or a prefix of it) and returns the reply when the turn ends; a person's message on the same thread lands in order with yours. A model, effort or access named here is the turn's; a turn that joins a running one keeps that one's. When the thread's turn is still running the message joins it (outcome steered) or waits for it and then runs (outcome queued); the reply is that turn's.",
      inputSchema: { thread: z.string(), message: z.string(), ...picks },
      outputSchema: TurnOut.shape,
    },
    async ({ thread: ref, message, ...input }) => {
      const client = await dial();
      const thread = await threadOf(client, ref);
      await awake(client, await workspaceOf(client, thread.workspaceId), "send", QUIET_LINE);
      const out = turnOut(await follow(client, resumeOf(thread, message, input), "agent", QUIET_TURN));
      return asText(turnText(out), out);
    },
  );
  server.registerTool(
    "stop",
    {
      description: "Stops the thread's running turn (by id, or a prefix of it), as the app's stop button does; the machine stays up and the thread takes the next send. outcome accepted means the turn ended interrupted; not-running means it had already ended, which is an answer, not an error.",
      inputSchema: { thread: z.string() },
      outputSchema: { threadId: z.string(), outcome: SessionInterruptOutcome },
    },
    async ({ thread: ref }) => {
      const stopped = await stop(await dial(), ref);
      return asText(stopLine(stopped), { ...stopped });
    },
  );
  server.registerTool(
    "exec",
    {
      description: "Runs a command on the workspace's machine as argv (each word as given; use sh -c for a shell line) and returns its output lines and exit code. A non-zero exit is a result; the machine going away is an error.",
      inputSchema: { workspace, argv: Argv },
      outputSchema: { exitCode: z.number().int().nullable(), output: z.array(z.string()) },
    },
    async ({ workspace: ref, argv }) => {
      const client = await dial();
      const target = await awake(client, await workspaceOf(client, ref), "exec", QUIET_LINE);
      const output: string[] = [];
      const exit = await execOn(client, target.id, argv, e => {
        if (e.type === "exec.output") output.push(e.text);
      });
      if (exit.error !== undefined) throw new Error(exit.error);
      return asText(output.join("\n"), { exitCode: exit.exitCode, output });
    },
  );
  server.registerTool(
    "import",
    {
      description:
        "Lands a project folder from this computer on the workspace's machine at the same path, as the app's import dialog does, with the sessions of the agents named keyed to it there. Called without yes, keep or cut it uploads nothing and answers with the plan: the repository, files and size, the caches left behind, each secret-shaped file with its default (cut, unless a rewrite that removes the credential is offered) and each agent with sessions for the folder; put those rows to the person, then call again with yes true for the defaults or keep and cut per row. Refused in one line while the workspace is not running.",
      inputSchema: {
        workspace,
        folder: z.string().describe("the folder on this computer, absolute; it lands at this path on the machine"),
        yes: z.boolean().optional().describe("true imports with the plan's defaults; absent or false answers with the plan and imports nothing unless keep or cut is given"),
        keep: z.array(z.string()).optional().describe("secret-shaped paths from the plan, relative to the folder, that travel (as they are, or rewritten when the plan offers it)"),
        cut: z.array(z.string()).optional().describe("secret-shaped paths from the plan that stay behind, for rows the plan would carry rewritten"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions travel, each with sessions in the plan; absent means every agent the plan lists with readable sessions"),
        replace: z.boolean().optional().describe("remove what is at the path on the machine first; without it an existing folder there is refused"),
      },
      outputSchema: { plan: ProjectPlan, imported: ProjectImportResult.optional() },
    },
    async ({ workspace: ref, folder, yes, keep = [], cut = [], agents, replace }) => {
      const client = await dial();
      const target = await workspaceOf(client, ref);
      const refusal = actionRefusal(workspaceState({ phase: target.phase }), "import", target.gone);
      if (refusal !== null) throw new Error(refusal);
      const plan = await planProject(client, folder);
      const ticked = secretsChosen(plan, keep, cut);
      const chosen = agentsChosen(plan, agents);
      const lines = planLines(plan, ticked, chosen).join("\n");
      if (!importConsented({ yes, keep, cut })) return asText(`${lines}\n${PLAN_ONLY_TOOL}`, { plan });
      let done = "";
      const imported = await importProject(client, target.id, importRequest(plan, folder, ticked, chosen, replace), e => {
        if (e.stage === "done") done = e.message;
      });
      return asText(done, { plan, imported });
    },
  );
  server.registerTool(
    "export",
    {
      description:
        "Brings a project folder and the agent sessions keyed to it home from the workspace's machine to this computer: the folder lands at `folder` (absolute, must not exist unless replace), the sessions in the agents' homes here keyed to it. `from` is the folder's path on the machine, the same path as `folder` when absent. The result says per agent what moved, what landed as transcripts only, and how many indexed rollouts were skipped.",
      inputSchema: {
        workspace,
        folder: z.string().describe("where the folder lands on this computer, absolute"),
        from: z.string().optional().describe("the folder's path on the machine; defaults to folder"),
        replace: z.boolean().optional().describe("remove what is at folder first; without it an existing folder is refused"),
        agents: z.array(z.string()).optional().describe("catalog ids of the agents whose sessions come home; absent means every agent with sessions for the folder"),
      },
      outputSchema: ProjectExportResult.shape,
    },
    async ({ workspace: ref, folder, from, replace, agents }) => {
      const client = await dial();
      const target = await workspaceOf(client, ref);
      const req: ExportRequest = { source: from ?? folder, dest: folder, ...(replace !== undefined ? { replace } : {}), ...(agents !== undefined ? { agents } : {}) };
      let done = "";
      const exported = await exportProject(client, target.id, req, e => {
        if (e.stage === "done") done = e.message;
      });
      return asText(done, exported);
    },
  );
  return server;
}

/** The server on stdio until the agent is done with it: its stdin ending closes the transport, and the host socket with it. */
export async function serveMcp(statePath: string, opts: { alsoHere?: ScanInput["alsoHere"] } = {}, streams: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout }): Promise<void> {
  const dial = dialer(statePath);
  const server = mcpServer(statePath, { dial, ...(opts.alsoHere !== undefined ? { alsoHere: opts.alsoHere } : {}) });
  const transport = new StdioServerTransport(streams.input, streams.output);
  const closed = new Promise<void>(done => {
    server.server.onclose = () => done();
  });
  streams.input.once("end", () => void transport.close());
  await server.connect(transport);
  await closed;
  await dial.close();
}
