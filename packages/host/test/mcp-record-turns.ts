// SPDX-License-Identifier: AGPL-3.0-only
// The sentences the thread and turn tools of the daemon binary's tool server
// say, recorded off the functions that say them here: each with `{name}` where
// the Rust side fills a value. A sentence whose words hang on a count is read
// through a stand-in list whose length is the placeholder, and one built out of
// a figure is read with the figure swapped for its placeholder, so no word of
// any of them is written twice.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { floorApplies, type CommandCount } from "@wsp/collect";
import {
  AFTER_CUT_LINE,
  alsoTitle,
  fmtDuration,
  goneRefusal,
  HOST_CLOSED_LINE,
  FILE_MAX_BYTES,
  FILES_MAX,
  filesRefusal,
  IMAGE_MAX_BYTES,
  INSTALLS_LATEST,
  jsonLine,
  noWorkspaceForFolderLine,
  threadResult,
  notifyLine,
  NOTIFY_ME,
  permissionAskLine,
  pinWords,
  startPicks,
  threadOpenedLine,
  threadWithoutIdRefusal,
  usageRefusal,
  verbFailure,
  TURN_TOKEN_ENV,
  UNKNOWN_SIZE,
  UNTYPED_FILE,
  waitTimedOutLine,
  workspaceAsleepAgainLine,
  workspaceStaysAwakeLine,
  type HarnessCatalog,
  type Recipe,
  type ThreadView,
  type TurnResult,
} from "@wsp/protocol";
import { BASE_GROUP, FLOOR_LINE, GROUP_LABEL, tableLines, totalsLine, type TableRow } from "../src/init-table.js";
import { GUTTER } from "../src/init-layout.js";
import { COMMANDS_SHOWN, COMMANDS_TITLE, commandTableLines, NOT_SCANNED, recipeAnswer, recipePrintout, recipeScan, scanPrintout, SIGN_INS_TITLE, signInTableLines } from "../src/recipe-answer.js";
import type { ScanRow } from "../src/scan.js";
import {
  absoluteFolder,
  ANSWER_ROADS,
  ANSWER_WORDS,
  answeredLine,
  BUILT_IN_LIST_CLAUSE,
  BUILT_IN_TABLE_CLAUSE,
  checkedStart,
  hostDidNotStopLine,
  hostRestartedLine,
  filesFrom,
  noOpenAskLine,
  noSuchAnswerLine,
  openedThreadLine,
  renameLine,
  startDetached,
  stopLine,
  threadForgotLine,
  threadOf,
  threadTarget,
  toolFailure,
  turnFailure,
  VERBS,
  workspaceOf,
  type HostClient,
  type Turn,
  type VerbDeps,
} from "../src/verbs.js";
import { SERVICE_WAIT_MS } from "../src/host-lock.js";

/** The message a piece of work is refused with; a record that expected a refusal and got none is a broken record. */
async function refused(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("nothing was refused");
}

/** A host that answers each op with one body, for the functions that ask one before they refuse. */
function answering(bodies: Record<string, unknown>): HostClient {
  return {
    request: async <T extends Record<string, unknown>>(op: string): Promise<T> => {
      if (!(op in bodies)) throw new Error(`${op} is not asked in this record`);
      return bodies[op] as T;
    },
    events: async () => {},
    onFrame: () => () => {},
    closed: new Promise(() => {}),
    closeWords: () => HOST_CLOSED_LINE,
    close: () => {},
    terminate: () => {},
  };
}

/** A list whose length reads as the placeholder and whose items join to another: the count's words, never the count. */
const standIn = (count: string, joined: string): string[] => ({ length: count, map: () => ({ join: () => joined }) }) as unknown as string[];

const catalog = (fields: Partial<HarnessCatalog>): HarnessCatalog =>
  ({ harness: "{subject}", label: "L", source: "harness", version: null, models: [], efforts: [], contextWindows: [], permissionModes: [], steers: false, renames: false, images: false, isDefault: true, ...fields }) as HarnessCatalog;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function pickWords(): Promise<Record<string, unknown>> {
  const option = [{ value: "V", label: "L" }];
  const said = (c: HarnessCatalog, picks: Parameters<typeof startPicks>[1]): Promise<string> => refused(() => startPicks(c, picks, true));
  const notOne = async (c: HarnessCatalog, picks: Parameters<typeof startPicks>[1]): Promise<string> => (await said(c, picks)).replace("L (V)", "{options}");
  const legacy = (await said(catalog({ models: option, legacyModels: [{ value: "LV", label: "LL" }] }), { model: "{value}" })).replace("LL (LV)", "{legacy}").replace("L (V)", "{options}");
  const fixed = catalog({ models: option });
  const refusedStart = await refused(() => checkedStart(answering({ "harnesses.list": { harnesses: [fixed] } }), "t", undefined, { model: "{value}" }));
  return {
    notOne: {
      model: await notOne(catalog({ models: option }), { model: "{value}" }),
      effort: await notOne(catalog({ efforts: option }), { effort: "{value}" }),
      access: await notOne(catalog({ permissionModes: option }), { permissionMode: "{value}" }),
    },
    legacy: legacy.slice(legacy.indexOf("{options}") + "{options}".length),
    takesNoEffort: await said(catalog({ models: [{ value: "M", label: "{subject}", efforts: [] }], efforts: option }), { model: "M", effort: "{value}" }),
    noFast: await said(catalog({ models: [{ value: "M", label: "{model}" }] }), { model: "M", fast: true }),
    refused: refusedStart.replace(await said(fixed, { model: "{value}" }), "{said}"),
    builtInList: BUILT_IN_LIST_CLAUSE,
    builtInTable: BUILT_IN_TABLE_CLAUSE,
  };
}

async function fileWords(): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "wsp-mcp-record-files-"));
  const pngs = Array.from({ length: FILES_MAX + 1 }, (_, i) => {
    const path = join(dir, `shot-${i}.png`);
    writeFileSync(path, PNG);
    return path;
  });
  const tooMany = filesRefusal(pngs.map(() => ({ mediaType: "image/png", bytes: PNG.length })))!;
  const many = Array.from({ length: FILES_MAX + 2 }, () => ({ mediaType: "image/png", bytes: 1 }));
  const big = 2 * FILE_MAX_BYTES;
  const size = `is ${(big / 1024 / 1024).toString()} MB`;
  return {
    notAFile: await refused(() => filesFrom(["{path}"])),
    refused: (await refused(() => filesFrom(pngs))).replace(tooMany, "{refusal}"),
    tooMany: filesRefusal(many)!.replace(`carries ${many.length}`, "carries {count}"),
    empty: filesRefusal([{ mediaType: "image/png", bytes: 0, name: "{name}" }])!,
    imageTooBig: filesRefusal([{ mediaType: "image/png", bytes: big, name: "{name}" }])!.replace(size, "is {size}"),
    fileTooBig: filesRefusal([{ mediaType: UNTYPED_FILE, bytes: big, name: "{name}" }])!.replace(size, "is {size}"),
    untyped: UNTYPED_FILE,
    imageMaxBytes: IMAGE_MAX_BYTES,
    fileMaxBytes: FILE_MAX_BYTES,
    max: FILES_MAX,
  };
}

/** The recipe tools' own refusals, read off the tools, which refuse a relative path before anything is scanned. */
async function recipeRefusals(): Promise<Record<string, string>> {
  const deps: VerbDeps = { statePath: "/nonexistent/state.json", env: {}, client: async () => answering({}) };
  const call = (name: string, args: Record<string, unknown>): Promise<string> =>
    refused(async () => {
      const verb = VERBS.find(v => v.name === name && "tool" in v && v.tool !== undefined)! as unknown as { tool: { call(args: Record<string, unknown>, deps: VerbDeps): Promise<unknown> } };
      await verb.tool.call(args, deps);
    });
  return { outNotAbsolute: await call("recipe", { out: "{path}" }), projectNotAbsolute: await call("recipe scan", { project: ["{path}"] }) };
}

/** What the recipe's two tables are drawn out of on a terminal with no colour: the marks, the columns' words and the
 * lines around them. */
function recipeTableWords(): Record<string, unknown> {
  const row = (on: boolean): TableRow => ({ id: "i", kind: "tool", name: "n", on, base: on, group: BASE_GROUP, why: "w", heavy: false });
  const mark = (on: boolean): string => tableLines([row(on)], 1)[0]!.split(GUTTER)[0]!;
  const unknown = totalsLine([{ ...row(true), base: false }], "tools");
  const counted = totalsLine([{ ...row(true), size: 0 }], "tools");
  const head = (line: string): string[] => line.trim().split(/ {2,}/);
  const empty = recipePrintout({ at: "", out: "", agents: [], tools: [], totalBytes: 0, heavy: [], commands: [], custom: [] });
  const more = commandTableLines(Array.from({ length: COMMANDS_SHOWN + 1 }, (_, i) => ({ name: `c${i}`, calls: 1, sessions: 1 })));
  return {
    agentsTitle: empty[0],
    toolsTitle: empty[empty.indexOf("") + 1],
    tickOn: mark(true),
    tickOff: mark(false),
    gutter: GUTTER,
    groupLabels: GROUP_LABEL,
    floorLine: FLOOR_LINE,
    floorApplies: { used: floorApplies("used"), installed: floorApplies("installed"), default: floorApplies("default"), none: floorApplies(undefined) },
    unknownSize: UNKNOWN_SIZE,
    totals: counted.replace("1 tool", "{on}").replace("0 B", "{bytes}"),
    totalsUnknown: unknown.slice(unknown.indexOf(", 1 of")).replace("1", "{unknown}"),
    pinLatest: pinWords({ tag: "{tag}", latest: true }),
    installsLatest: INSTALLS_LATEST,
    commandsTitle: COMMANDS_TITLE,
    commandsShown: COMMANDS_SHOWN,
    commandsHead: head(commandTableLines([{ name: "n", calls: 1, sessions: 1 }])[1]!),
    none: commandTableLines([])[1],
    more: more.at(-1)!.replace("1", "{count}"),
    notScanned: NOT_SCANNED,
    signInsTitle: SIGN_INS_TITLE,
    signInsHead: head(signInTableLines([{ id: "i", name: "n", signIn: "s", recommended: { value: "v", why: "w" } }])[1]!),
    alsoTitle: { darwin: alsoTitle("darwin"), linux: alsoTitle("linux") },
  };
}

export async function turnWords(): Promise<Record<string, unknown>> {
  const session = (id: string) => ({ id, workspaceId: "w", harness: "claude", status: "completed" });
  const several = await refused(() => threadOf(answering({ "sessions.list": { sessions: [session("{ref}a"), session("{ref}b")] } }), "{ref}"));
  const otherVersion = await refused(() => workspaceOf(answering({ "workspaces.resolve": { workspace: {} } }), "w"));
  const stopped = (outcome: "accepted" | "not-running" | "not-found"): string => stopLine({ threadId: "{thread}", outcome });
  const outcomes = ["renamed", "unsupported", "no-session", "failed", "not-found"] as const;
  const unstamped = (await refused(() => startDetached(answering({ "sessions.start": { session: session("s"), outcome: "started", turnId: "t" } }), {}, "agent"))).trim();
  const napping = workspaceStaysAwakeLine("{name}", 60_000);
  const write = permissionAskLine("Write", JSON.stringify({ file_path: "{name}" }));
  return {
    severalThreads: several.replace(/^2 /, "{count} "),
    noThread: await refused(() => threadOf(answering({ "sessions.list": { sessions: [] } }), "{ref}")),
    otherVersion: otherVersion.replace("workspaces.resolve", "{op}"),
    gone: goneRefusal("{name}", "{action}"),
    goneWith: goneRefusal("{name}", "{action}", "{words}"),
    stopped: { accepted: stopped("accepted"), "not-running": stopped("not-running"), "not-found": stopped("not-found") },
    stopUnderOne: stopLine({ threadId: "{thread}", outcome: "accepted", under: ["{under}"] }).slice(stopped("accepted").length),
    stopUnderSome: stopLine({ threadId: "{thread}", outcome: "accepted", under: standIn("{count}", "{under}") }).slice(stopped("accepted").length),
    renamed: Object.fromEntries(outcomes.map(outcome => [outcome, renameLine({ threadId: "{thread}", title: "{title}", harness: "{agent}", outcome, error: "{error}" })])),
    renameFailedSilent: renameLine({ threadId: "{thread}", title: "{title}", harness: "{agent}", outcome: "failed" }),
    agents: Object.fromEntries(CATALOG_AGENTS.map(e => [e.id, e.name])),
    threadWithoutId: threadWithoutIdRefusal("{row}"),
    threadForgot: threadForgotLine({ id: "{thread}" } as ThreadView),
    noOpenAsk: noOpenAskLine("{thread}"),
    answerRoads: ANSWER_ROADS.flatMap(road => (road.answer === undefined ? [] : [{ verb: road.answer.verb, effect: road.effect, said: road.answer.said, noSuchAnswer: noSuchAnswerLine("{thread}", road.answer.verb) }])),
    answered: answeredLine("{thread}", { toolName: "{tool}", input: "" }, "{said}").replace(permissionAskLine("{tool}", ""), "{ask}"),
    answerWords: ANSWER_WORDS,
    asks: {
      command: permissionAskLine("Bash", JSON.stringify({ command: "{command}" })),
      skill: permissionAskLine("Skill", JSON.stringify({ skill: "{skill}" })),
      server: permissionAskLine("mcp__{server}__{tool}", "{}"),
      plain: permissionAskLine("{tool}", ""),
      plainDetail: permissionAskLine("{tool}", "", "{detail}"),
      write,
      writeIn: permissionAskLine("Write", JSON.stringify({ file_path: "{folder}/{name}" })).slice(write.length),
      writeSize: permissionAskLine("Write", JSON.stringify({ file_path: "{name}", content: "x" })).slice(write.length).replace("1 B", "{size}"),
    },
    finished: notifyLine("{thread}", { status: "{facts}", text: "{body}" } as unknown as TurnResult),
    finishedBare: notifyLine("{thread}", { status: "{facts}" } as unknown as TurnResult),
    timedOutOne: waitTimedOutLine(["{thread}"], 1_000).replace(fmtDuration(1_000), "{after}"),
    timedOutSome: waitTimedOutLine(standIn("{count}", ""), 1_000).replace(fmtDuration(1_000), "{after}"),
    restarted: { none: hostRestartedLine([]), one: hostRestartedLine(["{ids}"]), some: hostRestartedLine(standIn("{count}", "{ids}")) },
    hostDidNotStop: hostDidNotStopLine(SERVICE_WAIT_MS),
    cwdNotAbsolute: await refused(() => absoluteFolder("{path}")),
    emptyTask: await refused(() => checkedStart(answering({}), " ", undefined, {})),
    noAdapter: await refused(() => checkedStart(answering({ "harnesses.list": { harnesses: [catalog({ harness: "{agents}" })] } }), "t", "{agent}", {})),
    noAdapterNone: await refused(() => checkedStart(answering({ "harnesses.list": { harnesses: [] } }), "t", "{agent}", {})),
    picks: await pickWords(),
    noThreadTarget: await refused(() => threadTarget(answering({}), undefined, "/", "workspace")),
    noWorkspaceForFolder: noWorkspaceForFolderLine("{folder}", "workspace"),
    threadOpened: threadOpenedLine("{thread}", "{workspace}", "{folder}"),
    openedThread: openedThreadLine("{thread}", undefined),
    noResult: threadResult([{ type: "session.end", workspaceId: "w", sessionId: "s", threadId: "t", exitCode: null, sawResult: false }], "t")?.error,
    noThreadStamped: unstamped,
    turnFailed: turnFailure({ result: { status: "{status}" } } as unknown as Turn),
    turnNoResult: turnFailure({} as Turn),
    afterCut: AFTER_CUT_LINE,
    asleepAgain: workspaceAsleepAgainLine("{name}"),
    staysAwake: workspaceStaysAwakeLine("{name}"),
    staysAwakeNaps: napping.replace(/1m$/, "{naps}"),
    files: await fileWords(),
    turnTokenEnv: TURN_TOKEN_ENV,
    notifyMe: NOTIFY_ME,
    recipe: { ...(await recipeRefusals()), ...recipeTableWords() },
  };
}

/** One call recorded against a host: the arguments, the frame each op is answered with, the frames the host pushes
 * right behind the reply to an op, the op after whose reply the host lets the socket go as it stops, and the
 * environment the server runs in where the tool reads it. */
export interface TurnCase {
  case: string;
  arguments: Record<string, unknown>;
  replies: Record<string, string>;
  pushed?: Record<string, string[]>;
  closes?: string;
  env?: Record<string, string>;
}

const ok = (body: Record<string, unknown>): string => JSON.stringify({ id: 1, ok: true, ...body });
const no = (error: string, kind?: string): string => JSON.stringify({ id: 1, ok: false, error, ...(kind !== undefined ? { kind } : {}) });
const frame = (body: Record<string, unknown>): string => JSON.stringify(body);

const THREAD = "thread-7f3a9c21e4b5";
const OTHER = "thread-b0b0b0b0c1c1";
const STARTED = "thread-9d8c7b6a5f4e";
const WORKSPACE = { id: "ws-1", name: "attic-work", machineId: "m-1", phase: "running", kind: "cloud", golden: "default", createdAt: "2026-09-27T00:00:00.000Z", project: { id: "p-1", name: "wsp", path: "/root/wsp", computer: "here" }, home: "/root" };
const NAPPING = { ...WORKSPACE, phase: "napping" };
const GONE = { ...WORKSPACE, phase: "gone", gone: "deleted at the provider \u0085" };
const sessionRow = (fields: Record<string, unknown>) => ({ workspaceId: "ws-1", harness: "claude", status: "completed", ...fields });
const SESSIONS = [
  sessionRow({ id: "sess-1", threadId: THREAD, status: "completed", claudeSessionId: "cs-1", prompt: "fix the \u0085 build", costUsd: 0.1 }),
  sessionRow({ id: "sess-2", threadId: THREAD, status: "running", claudeSessionId: "cs-1", costUsd: 0.2 }),
  sessionRow({ id: "sess-3", threadId: OTHER, harness: "codex", status: "completed" }),
];
const listed = (rows: readonly unknown[] = SESSIONS): string => ok({ sessions: rows });
const resolved = (workspace: unknown = WORKSPACE): string => ok({ workspace });
const CLAUDE = {
  harness: "claude",
  label: "Claude Code",
  source: "harness",
  version: "2.1.0",
  models: [
    { value: "claude-sonnet-5", label: "Sonnet 5", isDefault: true },
    { value: "claude-opus-5-5", label: "Opus 5.5", efforts: ["high", "max"] },
    { value: "claude-haiku", label: "Haiku", efforts: [] },
  ],
  legacyModels: [{ value: "claude-3", label: "Claude 3" }],
  efforts: [
    { value: "low", label: "Low" },
    { value: "high", label: "High", isDefault: true },
    { value: "max", label: "Max" },
  ],
  contextWindows: [],
  permissionModes: [
    { value: "plan", label: "Plan" },
    { value: "bypassPermissions", label: "Bypass \u0085", isDefault: true },
  ],
  steers: true,
  renames: true,
  images: true,
  isDefault: true,
};
const CODEX = { ...CLAUDE, harness: "codex", label: "Codex", source: "table", models: [{ value: "gpt-5", label: "GPT-5", isDefault: true }], legacyModels: undefined, isDefault: false };
const HARNESSES = ok({ harnesses: [CLAUDE, CODEX] });

const scope = { workspaceId: "ws-1", sessionId: "sess-9", threadId: STARTED };
const START = ok({ session: sessionRow({ id: "sess-9", threadId: STARTED, status: "running", startedBy: "agent" }), outcome: "started", turnId: "turn-9" });
const done = (result: Record<string, unknown>, turnId = "turn-9"): string => frame({ type: "session.done", ...scope, turnId, result });
const REPLY = { status: "completed", durationMs: 83_456, waitedMs: 2_000, costUsd: 0.1 + 0.2, text: "Fixed \"it\" \u0085 é\n\nlast   line of the reply  \n" };
const TURN = [
  frame({ type: "session.start", ...scope, turnId: "turn-9", afterCut: true }),
  done({ status: "failed", error: "an older turn's end" }, "turn-8"),
  frame({ type: "session.delta", ...scope, turnId: "turn-9", kind: "text", text: "Fixed" }),
  done(REPLY),
];

const ask = (toolName: string, input: unknown, options: { id: string; label: string; effect: string }[], detail?: string) =>
  frame({ type: "session.permission", workspaceId: "ws-1", sessionId: "sess-2", threadId: THREAD, turnId: "turn-2", askId: "ask-1", toolName, input: typeof input === "string" ? input : JSON.stringify(input), options, ...(detail !== undefined ? { detail } : {}) });
const CONSENT = [
  { id: "opt-allow", label: "Allow", effect: "allow" },
  { id: "opt-mode", label: "Allow all edits", effect: "mode" },
  { id: "opt-deny", label: "Deny", effect: "deny" },
];
const history = (...events: string[]): string => `{"id":1,"ok":true,"events":[${events.join(",")}]}`;
const answer = (outcome: string): string => ok({ outcome });

const asked = (events: string[], extra: Record<string, string> = {}): Record<string, string> => ({ "sessions.list": listed(), "sessions.history": history(...events), "sessions.answer": answer("answered"), ...extra });

export const TURN_ANSWERED: Record<string, TurnCase[]> = {
  stop: [
    { case: "stopped with the tree", arguments: { thread: "thread-7f" }, replies: { "sessions.list": listed(), "sessions.interrupt": ok({ outcome: "accepted", under: ["thread-1111aaaa2222", "thread-3333bbbb4444"] }) } },
    { case: "stopped with one under", arguments: { thread: THREAD }, replies: { "sessions.list": listed(), "sessions.interrupt": ok({ outcome: "accepted", under: ["thread-1111aaaa2222"] }) } },
    { case: "not running", arguments: { thread: THREAD }, replies: { "sessions.list": listed(), "sessions.interrupt": ok({ outcome: "not-running", under: [] }) } },
    { case: "not found by the host", arguments: { thread: OTHER }, replies: { "sessions.list": listed(), "sessions.interrupt": ok({ outcome: "not-found" }) } },
    { case: "a prefix of two", arguments: { thread: "thread-" }, replies: { "sessions.list": listed() } },
    { case: "no such thread", arguments: { thread: "nope" }, replies: { "sessions.list": listed() } },
  ],
  thread_rename: [
    { case: "renamed", arguments: { thread: "thread-7f", title: "fix the \u0085 \"build\"" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "renamed" }) } },
    { case: "a title that names a placeholder", arguments: { thread: THREAD, title: "{agent} for {thread}" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "renamed" }) } },
    { case: "failed with the machine's line", arguments: { thread: THREAD, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "failed", error: "EACCES: the store is read-only" }) } },
    { case: "failed without a line", arguments: { thread: THREAD, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "failed" }) } },
    { case: "an agent the catalog does not name", arguments: { thread: OTHER, title: "t" }, replies: { "sessions.list": listed([sessionRow({ id: "sess-7", threadId: OTHER, harness: "mystery" })]), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "unsupported" }) } },
    { case: "no session", arguments: { thread: OTHER, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "no-session" }) } },
    { case: "not found", arguments: { thread: OTHER, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "not-found" }) } },
    { case: "gone", arguments: { thread: THREAD, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(GONE) } },
    { case: "napping wakes first", arguments: { thread: THREAD, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(NAPPING), "workspaces.wake": resolved(), "sessions.rename": ok({ outcome: "renamed" }) } },
    { case: "another version", arguments: { thread: THREAD, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": ok({ workspace: { id: "ws-1" } }) } },
    { case: "the wake refused", arguments: { thread: THREAD, title: "t" }, replies: { "sessions.list": listed(), "workspaces.resolve": resolved(), "workspaces.wake": no("the provider has no capacity", "unreachable") } },
  ],
  thread_forget: [
    { case: "forgot", arguments: { thread: "thread-b0" }, replies: { "sessions.list": listed(), "sessions.forget": ok({}) } },
    { case: "a row from before threads", arguments: { thread: "sess-old" }, replies: { "sessions.list": listed([sessionRow({ id: "sess-old" })]) } },
    { case: "refused once a turn ran", arguments: { thread: THREAD }, replies: { "sessions.list": listed(), "sessions.forget": no("thread-7f3a9c21e4b5 did work; forget the workspace instead", "usage") } },
  ],
  thread_allow: [
    { case: "a command", arguments: { thread: "thread-7f" }, replies: asked([ask("Bash", { command: "rm -rf \u0085 build", description: "clean" }, CONSENT)]) },
    { case: "a server's tool", arguments: { thread: THREAD }, replies: asked([ask("mcp__github__create_pull_request", { title: "x" }, CONSENT)]) },
    { case: "the oldest open prompt", arguments: { thread: THREAD }, replies: asked([frame({ type: "session.permission", workspaceId: "ws-1", sessionId: "sess-2", threadId: THREAD, askId: "ask-0", toolName: "Skill", input: JSON.stringify({ skill: "unslop" }), options: CONSENT }), ask("Bash", { command: "ls" }, CONSENT), frame({ type: "session.permission.closed", workspaceId: "ws-1", sessionId: "sess-2", threadId: THREAD, askId: "ask-9" })]) },
    { case: "no prompt open", arguments: { thread: THREAD }, replies: asked([ask("Bash", { command: "ls" }, CONSENT), frame({ type: "session.permission.closed", workspaceId: "ws-1", sessionId: "sess-2", threadId: THREAD, askId: "ask-1" })]) },
    { case: "a question carries no allow", arguments: { thread: THREAD }, replies: asked([ask("AskUserQuestion", { questions: [] }, [{ id: "a", label: "Yes", effect: "answer" }])]) },
    { case: "the prompt closed first", arguments: { thread: THREAD }, replies: asked([ask("Bash", { command: "ls" }, CONSENT)], { "sessions.answer": answer("gone") }) },
    { case: "no thread", arguments: { thread: "nope" }, replies: { "sessions.list": listed() } },
  ],
  thread_deny: [
    { case: "a write", arguments: { thread: THREAD }, replies: asked([ask("Write", { file_path: "/root/wsp/src/é.ts", content: "x".repeat(2048) }, CONSENT)]) },
    { case: "a write at the root", arguments: { thread: THREAD }, replies: asked([ask("Write", { file_path: "notes.md" }, CONSENT)]) },
    { case: "a plain call with the harness's words", arguments: { thread: THREAD }, replies: asked([ask("WebFetch", "not json", CONSENT, "fetch \u0085 example.com")]) },
    { case: "a plain call without", arguments: { thread: THREAD }, replies: asked([ask("Edit", { file_path: "a" }, CONSENT)]) },
    { case: "no option by that id", arguments: { thread: THREAD }, replies: asked([ask("Bash", { command: "ls" }, CONSENT)], { "sessions.answer": answer("no-option") }) },
    { case: "unsupported", arguments: { thread: THREAD }, replies: asked([ask("Bash", { command: "ls" }, CONSENT)], { "sessions.answer": answer("unsupported") }) },
    { case: "not found", arguments: { thread: THREAD }, replies: asked([ask("Bash", { command: "ls" }, CONSENT)], { "sessions.answer": answer("not-found") }) },
  ],
  exec: [
    {
      case: "output and the folder",
      arguments: { workspace: "attic-work", argv: ["sh", "-c", "echo hi"] },
      replies: { "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "workspaces.exec": ok({ execId: "exec-1", cwd: "/root/wsp" }) },
      pushed: { "workspaces.exec": [frame({ type: "exec.output", execId: "exec-0", text: "someone else's" }), frame({ type: "exec.output", execId: "exec-1", text: "hi \u0085 \"there\"" }), frame({ type: "exec.output", execId: "exec-1", text: "é" }), frame({ type: "exec.exit", execId: "exec-1", exitCode: 3 })] },
    },
    { case: "no folder named and no output", arguments: { workspace: "ws-1", argv: ["true"], cwd: "/tmp" }, replies: { "workspaces.resolve": resolved(NAPPING), "workspaces.wake": resolved(), "workspaces.exec": ok({ execId: "exec-2" }) }, pushed: { "workspaces.exec": [frame({ type: "exec.exit", execId: "exec-2", exitCode: null })] } },
    { case: "the machine went away", arguments: { workspace: "ws-1", argv: ["true"] }, replies: { "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "workspaces.exec": ok({ execId: "exec-3" }) }, pushed: { "workspaces.exec": [frame({ type: "exec.exit", execId: "exec-3", exitCode: null, error: "the machine stopped answering" })] } },
    { case: "a relative folder", arguments: { workspace: "ws-1", argv: ["true"], cwd: "src" }, replies: {} },
    { case: "gone", arguments: { workspace: "ws-1", argv: ["true"] }, replies: { "workspaces.resolve": resolved({ ...GONE, gone: "" }) } },
    { case: "no such workspace", arguments: { workspace: "nope", argv: ["true"] }, replies: { "workspaces.resolve": no("no workspace nope; wsp workspaces lists them", "not-found") } },
  ],
  threads_wait: [
    { case: "already over", arguments: { threads: ["thread-b0"] }, replies: { "sessions.list": listed(), "sessions.history": history(frame({ type: "session.start", workspaceId: "ws-1", sessionId: "sess-3", threadId: OTHER, turnId: "t3" }), frame({ type: "session.done", workspaceId: "ws-1", sessionId: "sess-3", threadId: OTHER, turnId: "t3", result: REPLY })) } },
    { case: "over with nothing in the transcript", arguments: { threads: [OTHER] }, replies: { "sessions.list": listed(), "sessions.history": history() } },
    { case: "a done pushed", arguments: { threads: [THREAD, "thread-b0"], timeout: 30 }, replies: { "sessions.list": listed([SESSIONS[1], sessionRow({ id: "sess-3", threadId: OTHER, status: "running" })]) }, pushed: { "sessions.list": [frame({ type: "session.done", workspaceId: "ws-1", sessionId: "sess-2", threadId: THREAD, turnId: "t2", result: { status: "interrupted", durationMs: 61_000, error: "stopped by the person" } })] } },
    { case: "an end pushed", arguments: { threads: [THREAD] }, replies: { "sessions.list": listed([SESSIONS[1]]), "sessions.history": history(frame({ type: "session.start", ...scope, threadId: THREAD, turnId: "t2" }), frame({ type: "session.end", ...scope, threadId: THREAD, turnId: "t2", reason: "the harness exited \u0085" })) }, pushed: { "sessions.list": [frame({ type: "session.end", workspaceId: "ws-1", sessionId: "sess-2", threadId: THREAD, turnId: "t2", reason: "cut" })] } },
    { case: "timed out on one", arguments: { threads: [THREAD], timeout: 0.05 }, replies: { "sessions.list": listed([SESSIONS[1]]) } },
    { case: "timed out on two", arguments: { threads: [THREAD, OTHER], timeout: 0.25 }, replies: { "sessions.list": listed([SESSIONS[1], sessionRow({ id: "sess-3", threadId: OTHER, status: "running" })]) } },
    { case: "no such thread", arguments: { threads: ["nope"] }, replies: { "sessions.list": listed() } },
  ],
  restart: [
    { case: "back with threads running", arguments: {}, replies: { "host.restart": ok({}), "sessions.list": listed([...SESSIONS, sessionRow({ id: "sess-4", threadId: "thread-4444", status: "running" })]) }, closes: "host.restart" },
    { case: "back with none running", arguments: {}, replies: { "host.restart": ok({}), "sessions.list": listed([]) }, closes: "host.restart" },
    { case: "refused", arguments: {}, replies: { "host.restart": no("this host runs under wsp up in a terminal; only that terminal brings it back", "usage") } },
  ],
  run: [
    { case: "followed to its reply", arguments: { workspace: "attic-work", task: "fix it", model: "claude-opus-5-5", effort: "max" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": START }, pushed: { "sessions.start": TURN } },
    { case: "detached", arguments: { workspace: "attic-work", task: "fix it", detach: true, agent: "codex", notify: ["me", "thread-7f"] }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.list": listed(), "sessions.start": START } },
    { case: "a failed turn on a machine it woke goes back to sleep", arguments: { workspace: "attic-work", task: "fix it" }, replies: { "workspaces.resolve": resolved(NAPPING), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": START, "sessions.list": listed([]), "workspaces.nap": ok({}) }, pushed: { "sessions.start": [done({ status: "failed", error: "the agent crashed \u0085" })] } },
    { case: "a failed turn beside a running one stays awake", arguments: { workspace: "attic-work", task: "fix it" }, replies: { "workspaces.resolve": resolved(NAPPING), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": START, "sessions.list": listed(), "status.list": ok({ statuses: [] }) }, pushed: { "sessions.start": [frame({ type: "session.end", ...scope, turnId: "turn-9" })] } },
    { case: "refused for a sign-in", arguments: { workspace: "attic-work", task: "fix it" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": START }, pushed: { "sessions.start": [done({ status: "failed", error: "claude is not signed in", refusal: "sign-in" })] } },
    { case: "the host stopped under it", arguments: { workspace: "attic-work", task: "fix it" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": START, "sessions.history": history(frame({ type: "session.start", ...scope, turnId: "turn-9" }), done({ status: "completed", text: "after the restart" })) }, closes: "sessions.start" },
    { case: "an empty task", arguments: { workspace: "attic-work", task: "  \n" }, replies: { "workspaces.resolve": resolved() } },
    { case: "a model the agent does not list", arguments: { workspace: "attic-work", task: "t", model: "gpt-9" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES } },
    { case: "an effort the model does not take", arguments: { workspace: "attic-work", task: "t", model: "claude-haiku", effort: "max" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES } },
    { case: "an effort off the model's list", arguments: { workspace: "attic-work", task: "t", model: "claude-opus-5-5", effort: "low" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES } },
    { case: "an access off the table's list", arguments: { workspace: "attic-work", task: "t", agent: "codex", access: "yolo" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES } },
    { case: "an agent with no adapter", arguments: { workspace: "attic-work", task: "t", agent: "nope" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES } },
    { case: "an agent on a host with none", arguments: { workspace: "attic-work", task: "t", agent: "nope" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": ok({ harnesses: [] }) } },
    { case: "a relative folder", arguments: { workspace: "attic-work", task: "t", cwd: "src" }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved() } },
    { case: "a file that is not there", arguments: { workspace: "attic-work", task: "t", files: ["no-such-shot.png"] }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved() } },
    { case: "fast on a model with none", arguments: { workspace: "attic-work", task: "t", fast: true }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES } },
    { case: "no workspace and no repo", arguments: { task: "t" }, replies: {} },
    { case: "no thread stamped", arguments: { workspace: "attic-work", task: "t", detach: true }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": ok({ session: sessionRow({ id: "sess-9", status: "running" }), outcome: "started", turnId: "turn-9" }) } },
    { case: "another version", arguments: { workspace: "attic-work", task: "t", detach: true }, replies: { "workspaces.resolve": resolved(), "harnesses.list": HARNESSES, "workspaces.wake": resolved(), "sessions.start": ok({ outcome: "started" }) } },
  ],
  send: [
    { case: "followed to its reply", arguments: { thread: "thread-7f", message: "and the tests", effort: "low" }, replies: { "sessions.list": listed(), "harnesses.list": HARNESSES, "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.start": START }, pushed: { "sessions.start": TURN } },
    { case: "steered, detached", arguments: { thread: THREAD, message: "also this", detach: true }, replies: { "sessions.list": listed(), "harnesses.list": HARNESSES, "workspaces.resolve": resolved(), "workspaces.wake": resolved(), "sessions.start": ok({ session: sessionRow({ id: "sess-2", threadId: THREAD, status: "running" }), outcome: "steered", turnId: "turn-2" }) } },
    { case: "an empty message", arguments: { thread: THREAD, message: "" }, replies: { "sessions.list": listed() } },
    { case: "a model off the list", arguments: { thread: OTHER, message: "m", model: "o3" }, replies: { "sessions.list": listed(), "harnesses.list": HARNESSES } },
    { case: "a failed turn", arguments: { thread: THREAD, message: "m" }, replies: { "sessions.list": listed(), "harnesses.list": HARNESSES, "workspaces.resolve": resolved(NAPPING), "workspaces.wake": resolved(), "sessions.start": START }, pushed: { "sessions.start": [done({ status: "interrupted" })] } },
  ],
};

/** A recipe tool's call as the tool server makes it: the command line it runs and what that line printed, or none
 * where the tool refuses before running anything. `result` is what the TypeScript tool answers the same call with. */
export interface RecipeCase {
  case: string;
  arguments: Record<string, unknown>;
  /** The platform the printout names this computer by; a case for another platform is not this computer's to replay. */
  platform?: "darwin" | "linux";
  wsp?: { argv: string[]; stdout: string; stderr: string; exit: number };
  result?: Record<string, unknown>;
}

const RECIPE: Recipe = {
  version: 1,
  at: "2026-09-27T10:00:00.000Z",
  tick: "used",
  histories: [
    { agent: "claude", state: "read", sessions: 42, calls: 1_200 },
    { agent: "codex", state: "empty", sessions: 0, calls: 0 },
  ],
  rows: [
    { id: "claude", kind: "agent", on: true, source: { kind: "installed", paths: ["/usr/local/bin/claude"], bin: true } },
    { id: "codex", kind: "agent", on: false, source: { kind: "installed", paths: [], bin: true } },
    { id: "node", kind: "tool", on: true, source: { kind: "used", sessions: 12, calls: 340 }, pin: { tag: "v22.11.0", sha256: "ab12" } },
    { id: "docker", kind: "tool", on: false, source: { kind: "used", sessions: 1, calls: 2 } },
    { id: "gh", kind: "tool", on: true, source: { kind: "project", why: "the \u0085 workflow calls gh" }, pin: { tag: "2.62.0", latest: true } },
    { id: "go", kind: "tool", on: true, source: { kind: "installed", paths: ["/usr/local/go/bin/go"], bin: true } },
    { id: "rust", kind: "tool", on: true, size: 1_600_000_000, source: { kind: "used", sessions: 30, calls: 900 } },
  ],
  custom: [{ kind: "custom", id: "just", name: "just", install: ["brew install just", "echo é"], check: "command -v just", why: "for the build", size: 5_300_000 }],
};

const COMMANDS: CommandCount[] = Array.from({ length: COMMANDS_SHOWN + 2 }, (_, i) => ({ name: i === 0 ? "maké" : `cmd-${String(i).padStart(2, "0")}`, calls: 1_000 - i * 7, sessions: 30 - i }) as CommandCount);
const ALSO_HERE = [
  { id: "brew/ffmpeg", name: "ffmpeg", manager: "brew", group: "Homebrew", install: "apt-get install -y ffmpeg", check: "command -v ffmpeg", size: 52_000_000 },
  { id: "brew/tree", name: "tree", manager: "brew", group: "Homebrew", install: "apt-get install -y tree", check: "command -v tree" },
  { id: "npm/tsx", name: "tsx", manager: "npm", group: "npm globals", install: "npm i -g tsx", check: "command -v tsx", size: 900 },
] as unknown as ScanRow[];

const printed = (value: unknown): string => `${jsonLine(value)}\n`;
const answeredWith = (text: string, value: object): Record<string, unknown> => ({ content: [{ type: "text", text }], structuredContent: value });
const READING = "Reading this computer against the catalog and your agents' session histories. Nothing leaves this computer.\n";
const recipeUsage = (VERBS.find(v => v.name === "recipe") as { usage: string }).usage;

export function recipeCases(): Record<string, RecipeCase[]> {
  const full = recipeAnswer(RECIPE, "/tmp/recipe \u0085.json", COMMANDS);
  const bare = recipeAnswer({ ...RECIPE, tick: undefined, rows: [], custom: undefined }, "/nonexistent/recipe.json", []);
  const refusal = usageRefusal('--set takes <id>=on or <id>=off, and got "node=maybe".', "Write the row id, an equals sign, then on or off.");
  const scanned = recipeScan(RECIPE, COMMANDS, ALSO_HERE);
  const unscanned = recipeScan({ ...RECIPE, tick: "installed" }, [], undefined);
  const nothingElse = recipeScan({ ...RECIPE, tick: "default" }, [], []);
  const scan = (platform: "darwin" | "linux", value: ReturnType<typeof recipeScan>, name: string, args: Record<string, unknown> = {}): RecipeCase => ({
    case: `${name} on ${platform}`,
    arguments: args,
    platform,
    wsp: { argv: ["recipe", "scan", "--json", "--state", "{state}", ...(args["project"] as string[] | undefined ?? []).map(p => `--project=${p}`)], stdout: printed(value), stderr: READING, exit: 0 },
    result: answeredWith(scanPrintout(value, platform).join("\n"), value),
  });
  return {
    recipe: [
      {
        case: "every input",
        arguments: { tick: "used", set: ["node=on", "docker=off"], signin: ["gh=machine"], add: ["just=brew install just"], add_check: ["just=just --version"], why: "for the build \u0085", engine: true, project: ["/root/wsp"], out: "/tmp/recipe \u0085.json" },
        wsp: {
          argv: ["recipe", "--json", "--state", "{state}", "--tick=used", "--set=node=on", "--set=docker=off", "--signin=gh=machine", "--add=just=brew install just", "--add-check=just=just --version", "--why=for the build \u0085", "--engine", "--project=/root/wsp", "--out=/tmp/recipe \u0085.json"],
          stdout: printed(full),
          stderr: READING,
          exit: 0,
        },
        result: answeredWith(recipePrintout(full).join("\n"), full),
      },
      { case: "no input", arguments: { engine: false }, wsp: { argv: ["recipe", "--json", "--state", "{state}"], stdout: printed(bare), stderr: "", exit: 0 }, result: answeredWith(recipePrintout(bare).join("\n"), bare) },
      { case: "refused by the command line", arguments: { set: ["node=maybe"] }, wsp: { argv: ["recipe", "--json", "--state", "{state}", "--set=node=maybe"], stdout: "", stderr: `${READING}${jsonLine(verbFailure(refusal))}\n`, exit: verbFailure(refusal).exit }, result: toolFailure(refusal, recipeUsage) as unknown as Record<string, unknown> },
      { case: "a relative out", arguments: { out: "recipe.json" } },
      { case: "a relative project", arguments: { project: ["/root/wsp", "src"] } },
    ],
    recipe_scan: [
      scan("linux", scanned, "scanned", { project: ["/root/wsp"] }),
      scan("darwin", scanned, "scanned", { project: ["/root/wsp"] }),
      scan("linux", unscanned, "nothing looked"),
      scan("linux", nothingElse, "nothing else here"),
      { case: "a relative project", arguments: { project: ["src"] } },
    ],
  };
}
