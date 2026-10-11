// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CATALOG_AGENTS, THREAD_AGENTS } from "@wsp/catalog";
import { CLOUD_ON } from "../cloud.js";
import { cloudText } from "../cloud-text.js";
import {
  AFTER_CUT_LINE,
  HostFolderListing,
  InitSetup,
  FILES_MAX,
  FILE_MAX_WORDS,
  IMAGE_MAX_WORDS,
  IMAGE_TYPE_WORDS,
  NOTIFY_CALLER,
  ProjectExportResult,
  ProjectImportResult,
  ProjectPlan,
  SessionStartOutcome,
  TerminalScheme,
  ThreadView,
  TurnStatus,
  WorkspaceOut,
  WorkspaceView,
  canTravel,
  defaultAgents,
  defaultConsent,
  folderLevelLine,
  fmtBytes,
  plural,
  type NotifyLength,
  notifyLine,
  notifyTail,
  secretOffer,
  secretSignalsLine,
  stillWorkingLine,
  capWaitLine,
  ThreadCapWait,
  unknownAgentLine,
  usageRefusal,
  waitTimedOutLine,
  type ExecEvent,
  type ProjectExportEvent,
  type ProjectImportEvent,
  type ProjectImportRequest,
  HERE_PLACE_ID,
  jsonLine,
} from "@wsp/protocol";
import type { CliIO } from "../cli.js";
import { colourDepth, isTTY } from "../init-layout.js";
import { type HostClient, untilSettled, pushedFrames, type Out, table, type Flags, type VerbContext, type FlagTable, placeNamed, absolutePath, threadIdOf, openedThreadLine } from "./client.js";
import { type Turn, type Ended, type Waited, turnRefusal, turnView } from "./turns-help.js";

export type ExecExit = Extract<ExecEvent, { type: "exec.exit" }>;

/** `ranIn` is the folder the host answered with, which every caller prints rather than the one it asked for; absent
 * only where the workspace's kind names no folder, which leaves the machine's own home. */
export interface ExecRun {
  exit: ExecExit;
  ranIn?: string;
}

/** Runs argv on the workspace's machine, in cwd when given, and follows it to its exit; `on` sees each output line
 * and the exit. Fails when the host goes away first. */
export async function execOn(client: HostClient, workspaceId: string, argv: readonly string[], cwd: string | undefined, on: (e: ExecEvent) => void): Promise<ExecRun> {
  const pushed = pushedFrames(client);
  const { execId, cwd: ranIn } = await client.request<{ execId: string; cwd?: string }>("workspaces.exec", { workspaceId, argv, ...(cwd !== undefined ? { cwd } : {}) });
  const exited = new Promise<ExecExit>(done => {
    pushed.follow(
      f => (f.type === "exec.output" || f.type === "exec.exit") && f["execId"] === execId,
      f => {
        const e = f as unknown as ExecEvent;
        on(e);
        if (e.type === "exec.exit") done(e);
      },
    );
  });
  try {
    return { exit: await untilSettled(client, exited), ...(ranIn !== undefined ? { ranIn } : {}) };
  } finally {
    pushed.stop();
  }
}

/** What an export asks for: the folder on the machine, where it lands here, whether to replace what is there, and
 * which agents' sessions come home (every one with sessions for the folder when absent). */
export interface ExportRequest {
  source: string;
  dest: string;
  replace?: boolean;
  agents?: readonly string[];
}

/** Brings a project folder and the agent sessions keyed to it home from the workspace's machine: `on` sees each
 * stage of the export as the runtime says it, and the result is what landed. Fails when the host goes away first. */
export async function exportProject(client: HostClient, workspaceId: string, req: ExportRequest, on: (e: ProjectExportEvent) => void): Promise<ProjectExportResult> {
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "project.export" && f["workspaceId"] === workspaceId && f["dest"] === req.dest,
    f => on(f as unknown as ProjectExportEvent),
  );
  try {
    const { exported } = await untilSettled(
      client,
      client.request<{ exported: ProjectExportResult }>("project.export", {
        workspaceId,
        source: req.source,
        dest: req.dest,
        ...(req.replace !== undefined ? { replace: req.replace } : {}),
        ...(req.agents !== undefined ? { agents: req.agents } : {}),
      }),
    );
    return exported;
  } finally {
    pushed.stop();
  }
}

/** The plan for a folder on this computer, as the app's dialog reads it: nothing is packed or uploaded. */
export async function planProject(client: HostClient, source: string): Promise<ProjectPlan> {
  return (await client.request<{ plan: ProjectPlan }>("project.plan", { source })).plan;
}

/** Lands a folder on this computer at dest on the workspace's machine, the way the app's dialog does: `on` sees each
 * stage of the import as the runtime says it, and the result is what landed. Fails when the host goes away first. */
export async function importProject(client: HostClient, workspaceId: string, req: ProjectImportRequest, on: (e: ProjectImportEvent) => void): Promise<ProjectImportResult> {
  const pushed = pushedFrames(client);
  await client.events();
  pushed.follow(
    f => f.type === "project.import" && f["workspaceId"] === workspaceId && f["source"] === req.source && f["dest"] === req.dest,
    f => on(f as unknown as ProjectImportEvent),
  );
  try {
    const { imported } = await untilSettled(client, client.request<{ imported: ProjectImportResult }>("project.import", { workspaceId, ...req }));
    return imported;
  } finally {
    pushed.stop();
  }
}

/** The rows a person changed from the plan's defaults: keep ticks a secret-shaped row, cut unticks it; a path the
 * plan does not list as secret-shaped is refused, since nothing would change for it. */
export function secretsChosen(plan: ProjectPlan, keep: readonly string[], cut: readonly string[]): ReadonlySet<string> {
  const listed = new Set(plan.secrets.map(s => s.path));
  for (const path of [...keep, ...cut]) {
    if (!listed.has(path)) throw usageRefusal(`${path} is not a secret-shaped file in the plan${listed.size === 0 ? ", which lists none" : `; the plan lists ${[...listed].join(", ")}`}.`, "Name one the plan lists, or drop the flag.");
  }
  const ticked = new Set(defaultConsent(plan.secrets));
  for (const path of keep) ticked.add(path);
  for (const path of cut) ticked.delete(path);
  return ticked;
}

/** The agents whose sessions travel: the ones named, each with sessions in the plan, else the plan's default. */
export function agentsChosen(plan: ProjectPlan, named: readonly string[] | undefined): ReadonlySet<string> {
  if (named === undefined) return defaultAgents(plan.agents);
  const travelling = plan.agents.filter(canTravel);
  for (const id of named) {
    if (!travelling.some(a => a.agent === id)) throw usageRefusal(`${id} has no sessions for this folder${travelling.length === 0 ? "" : `; the plan lists ${travelling.map(a => a.agent).join(", ")}`}.`, "Name one the plan lists, or drop the flag and let every agent with sessions come.");
  }
  return new Set(named);
}

/** The plan as the dialog shows it, one fact per line: the repository, the files and their size, the caches left
 * behind, the paths not carried, where it lands, then each secret-shaped row with its signals, size and what its tick
 * means, and each agent with its sessions and whether they travel. */
export function planLines(plan: ProjectPlan, ticked: ReadonlySet<string>, agents: ReadonlySet<string>, workspace?: Pick<WorkspaceView, "kind" | "home">): string[] {
  const rows: string[][] = [
    ["Repository", plan.repo ? "git, .git travels whole" : "none"],
    ["Files", `${plural(plan.files, "file")}, ${fmtBytes(plan.bytes)}`],
    ["Caches left behind", plan.excluded.length === 0 ? "none" : plan.excluded.join(", ")],
    ["Not carried", plan.skipped.length === 0 ? "none" : plural(plan.skipped.length, "path")],
    ...plan.skipped.map(s => [`  ${s.path}`, s.note]),
    ["Lands at", plan.source],
    ["Secret-shaped", plan.secrets.length === 0 ? "none" : plural(plan.secrets.length, "file")],
    ...plan.secrets.map(s => [`  ${s.path}`, secretSignalsLine(s), secretOffer(s, ticked.has(s.path)).full]),
    ["Agents", plan.agents.length === 0 ? "none with sessions for the folder" : `${plural(plan.agents.length, "agent")} with sessions for the folder`],
    ...plan.agents.map(a => [`  ${a.name}`, a.error ?? plural(a.sessions, "session"), agents.has(a.agent) ? "sessions travel" : "stays"]),
  ];
  return table(rows);
}

/** The line under a plan nobody has consented to yet, off a terminal: nothing moved, and the two ways to say yes. */
export const PLAN_ONLY = "nothing imported; run again with --yes to take these defaults, or --keep <path> and --cut <path> per secret-shaped row";

/** The one question a person at the terminal is asked under the plan; no is the default and moves nothing. */
export const IMPORT_NOW = "Import now? y/N";

/** A destination the runtime refused as already there, with the flag that overwrites it named; any other failure as it came. */
export function withReplaceHint(e: unknown): unknown {
  if ((e as { kind?: unknown }).kind !== "exists") return e;
  return Object.assign(new Error(`${e instanceof Error ? e.message : String(e)}\nRun again with --replace to overwrite it.`), { kind: "exists" });
}

/** The agents a --agents flag names, comma-separated, each one the catalog knows; nothing when the flag is absent. */
export function agentsFlag(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",").map(s => s.trim()).filter(s => s !== "");
  if (ids.length === 0) throw usageRefusal("--agents was given no agent.", "Write it as --agents claude,codex, or drop the flag.");
  const known = CATALOG_AGENTS.map(a => a.id);
  const unknown = ids.find(id => !known.includes(id));
  if (unknown !== undefined) throw usageRefusal(unknownAgentLine(unknown, known), "Name one of those, or drop the flag.");
  return ids;
}

/** The one question a drop asks unless --yes, and the one line it prints when the answer is anything but yes. Off a
 * terminal nobody can answer, so the line without --yes is refused as written. */
export async function confirmed(ctx: VerbContext, question: string, name: string): Promise<boolean> {
  return confirmedAt(ctx.io, ctx.flags["yes"] === true, question, name);
}

/** The same question for a line of the shared parse, which reads --yes off its own flags. */
export async function confirmedAt(io: CliIO, yes: boolean, question: string, name: string): Promise<boolean> {
  if (yes) return true;
  if (io.isTTY !== true) throw usageRefusal(`${question.split("\n")[0]} There is no terminal to answer on.`, "Pass --yes to say yes.");
  if ((await io.ask(question)) === "yes") return true;
  io.error(`${name} kept`);
  return false;
}

/** Nothing printed on the tool door: a tool answers with values, and the stages a create streams have no reader there. */
export const QUIET: Out = { emit: () => {}, stream: () => {} };
/** The waking line has no reader on the tool door either: the result says which machine ran. */
export const QUIET_LINE = (): void => {};
export const QUIET_TURN = { event: () => {} };

export const Created = z.object({ workspace: WorkspaceOut, notice: z.string().optional() });

/** What a send meets on its thread, in the runtime's own words: the outcome it answers with on a free or a running
 * turn, and the line it says when the last turn replied but its agent process has not exited. */
const { started, steered, queued, held } = SessionStartOutcome.enum;
export const SEND_MEETS = `On a thread whose turn is not running the message starts a new turn (outcome \`${started}\`); when the turn is still running the message joins it (outcome \`${steered}\`) or waits for it and then runs (outcome \`${queued}\`), and the reply is that turn's. When the thread's turn has replied but its agent process is still running, the message waits for that process and runs as the thread's next turn (outcome \`${queued}\`), which the runtime says as \`${stillWorkingLine()}\`. A send is never refused for meeting a turn, and two sends keep the order they arrived in.`;

/** What a start meets on a full computer, in the runtime's own words, for run, send and fork alike. */
export const CAP_MEETS = `A start on a computer already running as many threads as its threads at once waits for a slot and starts on its own when one frees (outcome \`${held}\`), with capped beside it, the computer and what runs there against its number, which the thread's row in threads carries while it waits; a thread that follows a run or a send to its end, not detached, lends that thread's next turn its own slot, one turn at a time, a turn already held ahead of the message included, and every other start, a child started detached included, waits for a slot of its own`;

/** outcome says how the message landed: its own turn, steered into the thread's running one, or queued behind it;
 * afterCut is set when the thread's previous turn ended without a result, so the reply may be missing context. */
export const TurnOut = z.object({
  threadId: z.string(),
  workspaceId: z.string(),
  harness: z.string(),
  text: z.string().optional().describe("the reply, complete; absent under detach, where the turn is still running and its end reaches whoever the start's notify named"),
  outcome: SessionStartOutcome,
  capped: ThreadCapWait.optional().describe("what holds the start back while outcome is held: the computer and what runs there against its threads at once"),
  afterCut: z.literal(true).optional(),
});
/** What a wait answers with for the thread that left running: the turn's outcome and the facts the harness reported,
 * the reply cut to the notify line's tail. */
const ThreadEndOut = z.object({
  threadId: z.string(),
  status: TurnStatus,
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  reply: z.string().optional().describe("the last non-empty line of the reply, or the error when there is no reply"),
});
export const WaitOut = z.object({
  finished: ThreadEndOut.optional().describe("the thread that left running; absent when the timeout passed first"),
  timedOut: z.literal(true).optional().describe("set when the timeout passed with every named thread still running"),
});
export const ThreadRowOut = ThreadView.extend({ projectName: z.string(), folder: z.string(), branch: z.string(), computerName: z.string() });
export const Argv = z.array(z.string()).min(1);

type Structured = Record<string, unknown>;

/** A result the agent reads as text and a client with a schema reads as the same value. */
export const asJson = (structured: Structured): CallToolResult => ({ content: [{ type: "text", text: jsonLine(structured, 2) }], structuredContent: structured });
export const asText = (text: string, structured: Structured): CallToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });

/** The reply as the tool's text, with the cut line first when the thread's previous turn did not finish. */
export const turnText = (out: z.infer<typeof TurnOut>): string => (out.afterCut === true ? `${AFTER_CUT_LINE}\n${out.text ?? ""}` : out.text ?? "");

/** A detached start's answer on the tool door: the thread's id, as the command line's first line prints it. */
export const detachedOut = (turn: Turn, opened?: (threadId: string, folder?: string) => string): CallToolResult => {
  const line = openedThreadLine(turn.threadId, opened, turn.session.cwd);
  return asText(turn.outcome === "held" && turn.session.capped !== undefined ? `${line}\n${capWaitLine(turn.session.capped)}` : line, turnView(turn));
};

const endView = (ended: Ended): z.infer<typeof ThreadEndOut> => {
  const reply = notifyTail(ended.result);
  return {
    threadId: ended.threadId,
    status: ended.result.status,
    ...(ended.result.durationMs !== undefined ? { durationMs: ended.result.durationMs } : {}),
    ...(ended.result.costUsd !== undefined ? { costUsd: ended.result.costUsd } : {}),
    ...(reply !== undefined ? { reply } : {}),
  };
};

/** A wait's answer on both doors: the finished thread's end under the notify line, or timedOut under the line that
 * says who is still running. `length` is how much of the reply the line carries; the end's own reply field is the
 * tail whatever the line says, since that is the field a sidebar row and a notify read. */
export function waitAnswer(named: readonly ThreadView[], waited: Waited, length: NotifyLength = "tail"): { value: z.infer<typeof WaitOut>; line: string } {
  if ("ended" in waited) return { value: { finished: endView(waited.ended) }, line: notifyLine(waited.ended.threadId, waited.ended.result, length) };
  return { value: { timedOut: true }, line: waitTimedOutLine(named.map(threadIdOf), waited.timedOutMs) };
}

/** The seconds a --timeout names, as milliseconds; a word that is not a number above zero is refused. */
export function timeoutFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) throw usageRefusal(`--timeout takes seconds, a number above zero, and got ${JSON.stringify(value)}.`, "Write it as --timeout <seconds>.");
  return seconds * 1_000;
}

/** The turn's reply as the tool result; a turn that did not complete is a tool error with the harness's reason. */
export function turnOut(turn: Turn): z.infer<typeof TurnOut> {
  const failure = turnRefusal(turn);
  if (failure !== undefined) throw failure;
  return turnView(turn);
}

/** The line under a plan the tool returned without importing: the call that says yes, and the two per-row answers. */
const PLAN_ONLY_TOOL = "nothing imported; call import again with yes true to take these defaults, or keep and cut per secret-shaped row";

export const WorkspaceIn = z.string().describe("the workspace's name, or its id when two share a name");
export const ThreadIn = z.string().describe("the thread, by its id or a prefix of it that names one, as threads lists them");
export const AgentIn = z.string().optional().describe(`the agent to run in the thread, one of ${THREAD_AGENTS.join(", ")}; absent means the host's default`);
export const NotifyIn = z
  .array(z.string())
  .min(1)
  .optional()
  .describe(
    `who is told each time a turn of the new thread ends, each one a thread (by id, or a prefix of it) the line goes into as a message carrying that turn's whole reply, or me, which is the thread this call came out of when it came out of one and otherwise the person's app, where the line is its last reply line alone. Several targets each get the line once, which is how a builder's end reaches its orchestrator and a reviewer together; a target whose thread is gone by then falls back to the person, and the new thread's own id is refused. ${NOTIFY_CALLER}.`,
  );
export const RunProjectIn = z
  .string()
  .optional()
  .describe(
    cloudText(
      "the project the thread works on, by the name or the id projects lists<!-- cloud -->; one on a cloud gets a new machine forked from the image for the thread, and a machine named in its place runs it there as before<!-- /cloud -->. Absent from a thread, the thread runs beside the one asking, in its folder",
      CLOUD_ON,
    ),
  );
export const BesideIn = z.string().optional().describe("a thread, by its id or a prefix of it, beside which the new thread runs: in the folder that thread works in, on the computer it runs on; never with project or branch");
export const BranchIn = z.string().optional().describe("a branch other than the one the project's folder has checked out: the thread runs in the worktree holding it, made under wsp's folder from the project folder's current commit for a new branch");
export const RunCwdIn = z.string().optional().describe("a folder inside the project or one of its worktrees, absolute, which the thread starts in");
/** The threads an act on a shared folder took in too, on the answers of commit, discard and update. */
export const SHARED_WITH = { sharedWith: z.array(z.string()).optional().describe("the other threads working in the same folder, by id, whose changes the act took in too; absent where none do") };
export const ExecCwdIn = z.string().optional().describe("the folder the command runs in, absolute; absent means the folder the thread works in");
export const CwdIn = z.string().optional().describe("the folder on the machine the thread works in or the command runs in, absolute. Absent means the workspace's own project, which is where a thread there starts unless it says otherwise");
export const DetachIn = z.boolean().optional().describe(`true answers with the thread id the moment the turn is started, without the reply, and the turn's end reaches whoever notify named; for a turn that runs for minutes or an hour, so this call does not block for it. ${NOTIFY_CALLER}.`);
export const ResumeIn = z
  .string()
  .optional()
  .describe("a conversation the agent kept in the project's folder outside wsp, by the id conversations lists: the new thread opens on it, in the folder it ran in, under its own name, with its newest messages written above the message, and nothing of wsp's is written into the agent's own store until the thread is renamed here. Refused with beside, branch or cwd, since the conversation names its folder, where the agent holds no such conversation, where it is a wsp thread already, and where another app holds it open, unless copy");
export const CopyIn = z.boolean().optional().describe("with resume, true runs the thread on a copy of the conversation the agent makes (Claude Code's --fork-session, Codex's thread/fork), the original left byte for byte as it was: the answer to one open in another app");
export const TitleIn = z.string().optional().describe("the thread's name, as a person's: it shows in the sidebar and in the agent's own list from the first second, and the title the host asks the agent for as the turn starts never replaces it; absent lets the thread be titled by its opening words until, seconds in, the agent names it");
export const ForkIn = z.string().optional().describe("a thread to fork, by id or a prefix of it, as threads lists them: the new thread runs on that thread's agent, at its model and effort unless named, with its conversation through one finished turn and nothing after, in that thread's folder, or with branch in a new worktree on that branch whose files are that turn's checkpoint; never with project, beside, cwd or replaces, and an agent other than the thread's is refused");
export const AtIn = z.number().int().positive().optional().describe("with fork, the finished turn the fork carries the conversation through, counted from 1 in the order thread_read lists them; absent, the thread's latest finished turn");
export const ReplacesIn = z.string().optional().describe("a stopped or failed thread this new thread restarts, by id or a prefix of it, as threads lists them: the new thread's row names it, and once the new one starts the host settles it, so the person sees one row for the job; a restart the person starts of a child stands under that child's lead. Refused while that thread or one under it is working, for a thread that already has a restart (name that restart instead), and from a thread for one that is not under it, each before a machine is forked or woken");
export const FilesIn = z
  .array(z.string())
  .optional()
  .describe(
    `paths on this computer, absolute or relative to the folder wsp runs in, of files to send with the message, at most ${FILES_MAX}. An image (${IMAGE_TYPE_WORDS}, up to ${IMAGE_MAX_WORDS}) goes to the agent as an image; any other file, up to ${FILE_MAX_WORDS}, lands in the folder the thread works in, under .wsp-files where git lists none of it, and the message names its path. The host reads each file and sends its bytes, so the machine never reaches back for this computer\u2019s files; an image to an agent that reads none is refused naming that agent.`,
  );
export const FastIn = z.boolean().optional().describe("true runs the turn in the agent's fast mode, on a model that offers one, and is refused naming the model otherwise; absent runs at the agent's usual speed");
export const ConfirmIn = z.boolean().optional().describe("true deletes it; absent or false answers with what would go and deletes nothing, so a person can be asked first");
/** What a thread may do without asking, in wsp's four words, on every door that opens one or sets a default. */
export const ACCESS_IN_WORDS =
  "how far the agent may go without asking, in wsp's words: ask (asks about each action that needs permission), auto-edit (edits files without asking), full (every action without asking) or plan (reads and proposes, changes nothing); each is mapped to the agent's own mode and refused where the agent has none, and a harness's own spelling is refused. Absent means the project's access, else the one set for that agent, else full";
/** The same three words the app's composer uses; the runtime refuses a value the agent's catalog does not list, naming the list. */
export const PICK_INPUTS = {
  model: z.string().optional().describe("the model the turn runs on, by the agent's own slug (claude-sonnet-5); absent on a new thread means the project's, else the one set for that agent, else the catalog's default, on send the thread's own"),
  effort: z.string().optional().describe("the reasoning effort, by the agent's own word (low, medium, high, xhigh, max); absent on a new thread means the agent's default, high for claude; on send, the thread's own"),
  access: z.string().optional().describe(ACCESS_IN_WORDS),
};
/** The same two on send, for the reason SEND_FLAGS gives. */
export const SEND_INPUTS = { model: PICK_INPUTS.model, effort: PICK_INPUTS.effort };
/** The same word on new and fork; the refusal for a size the provider does not offer names the ones it does. */
export const SizeIn = z.string().optional().describe("the machine size as <cpu>x<memGb>, like 2x4; absent takes the image's size. A size the provider does not offer is refused with the list it does, so read that list rather than guessing twice; a build wants the largest memory offered");
export const SpawnIn = z.enum(["on", "off"]).optional().describe("whether the agents on this workspace may drive this host: open threads and fork machines under the thread they run in, capped. Absent is on under the default caps, which is what every workspace made without it reads as");
export const MaxMachinesIn = z.number().int().min(0).optional().describe("how many machines may stand at once under one root thread while spawn is on; defaults to 3");
export const MaxDepthIn = z.number().int().min(1).optional().describe("how many levels deep the tree under a root thread may go while spawn is on, 2 by default; 1 stops at the root's own children");

export const PROJECT_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count");
/** The same folders on the write verb, where naming them is also naming a rule input, so it re-decides the ticks. */
export const WEIGH_BY_FOLDERS = z.array(z.string()).optional().describe("folders on this computer, absolute, to weigh the histories by: only sessions that ran in one of them or under it count. Naming one re-decides every tick from the rule, as tick does, so any flip an earlier call made goes");
/** Absolute, since the tool server's own folder is wherever the agent launched it and a prefix test on a relative
 * path silently matches nothing. */
export const projectFolders = (folders: readonly string[]): string[] => folders.map(f => absolutePath("project is a folder on this computer", f));

/** The scheme a --scheme flag names; a word outside the pair is refused before anything is read. */
export function schemeFlag(value: string | undefined): TerminalScheme | undefined {
  if (value === undefined) return undefined;
  const parsed = TerminalScheme.safeParse(value);
  if (!parsed.success) throw usageRefusal(`--scheme takes one of ${TerminalScheme.options.join(", ")}, and got ${JSON.stringify(value)}.`, "Name one of those.");
  return parsed.data;
}

/** The --project folders a recipe line names, resolved from where the person stands; nothing when it names none. */
export const projectsFlag = (flags: Flags): { projects?: string[] } => (Array.isArray(flags["project"]) ? { projects: (flags["project"] as string[]).map(p => resolve(p)) } : {});

/** The reading is progress, not the answer: it goes to stderr so what is on stdout is the whole answer. */
export const progress = (io: CliIO): { log(line: string): void; note(line: string): void } => ({ log: line => io.log(line), note: line => io.error(line) });

/** The recipe verbs' answer on the command line: one JSON object under --json, else the table's lines in the
 * terminal's colours and the line that says what to do next. */
export function printTable(ctx: VerbContext, value: unknown, lines: (depth: number) => string[], next: string): void {
  ctx.out.emit(value);
  if (ctx.flags["json"] === true) return;
  for (const line of lines(colourDepth(isTTY(process.stdout)))) ctx.io.log(line);
  ctx.io.log(next);
}

/** One level of one computer's folders over the protocol, or every repo under its roots: the folder picker a browser
 * tab has, and the same answer here, so a line or an agent can look before it names a folder to import. `on` is a
 * computer by the name or id the places list carries, absent for this one; a folder on this computer is read by
 * `here`, and one on another computer is taken as given, absolute, since only that computer can resolve it. */
export async function hostFolders(client: HostClient, asked: { folder?: string | undefined; hidden?: boolean | undefined; repos?: boolean | undefined; on?: string | undefined }, here: (folder: string) => string): Promise<HostFolderListing> {
  const { folder, hidden, repos, on } = asked;
  const place = on === undefined ? undefined : await placeNamed(client, on);
  const elsewhere = place !== undefined && place.id !== HERE_PLACE_ID ? place : undefined;
  const dir = folder === undefined ? undefined : elsewhere === undefined ? here(folder) : absolutePath(`folder is a path on ${elsewhere.name}`, folder);
  const { listing } = await client.request<{ listing: HostFolderListing }>("host.folders", {
    ...(dir !== undefined ? { dir } : {}),
    ...(hidden === true ? { hidden } : {}),
    ...(repos === true ? { repos } : {}),
    ...(elsewhere !== undefined ? { on: elsewhere.id } : {}),
  });
  return listing;
}

/** The cloud setup as the host serves it to the app, parsed and not trusted. */
export async function initSetup(client: HostClient): Promise<InitSetup> {
  const { setup } = await client.request<{ setup: unknown }>("init.get", {});
  return InitSetup.parse(setup);
}

/** The level as a table, then the level in words with the folders that are browsable at all beside them, since a path
 * outside those is refused. The app's own browser draws the roots as crumbs instead. */
export function folderLines(listing: HostFolderListing): string[] {
  return [
    ...table([["FOLDER", "GIT"], ...listing.folders.map(f => [f.path, f.repo ? (f.branch ?? "git") : ""])]),
    `${folderLevelLine(listing)} Browsable: ${listing.roots.join(", ")}.`,
  ];
}

export const REASON_FLAG: FlagTable = { reason: { type: "string" } };
