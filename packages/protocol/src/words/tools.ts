// SPDX-License-Identifier: AGPL-3.0-only
import type { PermissionEffect, PermissionOption, PermissionOutcome, SessionAnswerOutcome, SessionEvent, SessionPermissionEvent } from "../index.js";
import { folderName, parentFolderName } from "../project-path.js";
import { lastLine, plural } from "./base.js";
import { fmtBytes } from "./units.js";
import { titleLine } from "./turn.js";
/** One tool call's input, as the wire's delta carries it: the JSON the harness reported, already parsed. */
type ToolInput = Readonly<Record<string, unknown>>;

/** Which moment a call's line is written for: the call as the harness reported it, which is before it has run and
 * before any prompt it waits on is answered, or the result that says it ran. A row whose words differ between the
 * two carries both, so nothing reads as done before it is. */
type ToolMoment = "asked" | "done";

/** The line one tool name reads as at one of those moments; undefined when the call's input does not carry what
 * the line needs. */
type ToolLine = (input: ToolInput, moment: ToolMoment) => string | undefined;

/** What kind of item a call is to a client that groups its rows by kind, in the words the app's transcript uses. */
export type ToolItemType = "command_execution" | "file_change" | "web_search" | "collab_agent_tool_call" | "mcp_tool_call";

/** What a call asks of the machine, for the client that puts the ask to a person. */
export type ToolRequestKind = "command" | "file-read" | "file-change";

/** One tool's row: the line its call reads as, the input field a client shows for it, what kind of item the call is,
 * the paths it changed when it changes any, and whether it looked through the code. */
interface ToolRow {
  readonly line: ToolLine;
  readonly shows: readonly string[];
  /** The words a person reads for this kind of call, where the harness's own name for it is none: a row that names
   * no title is drawn by that name, which is what every tool a person already knows the word for wants. */
  readonly title?: string;
  /** What the row shows under the title, where the field it is in is not a plain string; `shows` covers the rest. */
  readonly detail?: (input: ToolInput) => string | undefined;
  readonly itemType?: ToolItemType;
  readonly requestKind?: ToolRequestKind;
  readonly paths?: (input: ToolInput) => readonly string[];
  readonly codeSearch?: boolean;
}

function toolField(input: ToolInput, name: string): string | undefined {
  const value = input[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A tool a server lends the agent, whose name carries both: `mcp__<server>__<tool>` as every harness spells it. */
export function serverTool(toolName: string): { server: string; tool: string } | undefined {
  const parts = toolName.split("__");
  return parts.length >= 3 && parts[0] === "mcp" && parts[1] !== "" ? { server: parts[1]!, tool: parts.slice(2).join("__") } : undefined;
}

function firstField(input: ToolInput, fields: readonly string[]): string | undefined {
  return fields.map(name => toolField(input, name)).find(value => value !== undefined);
}

const shellRow: ToolRow = {
  line: input => {
    const command = toolField(input, "command");
    return command === undefined ? undefined : `$ ${titleLine(command)}`;
  },
  shows: ["description"],
  itemType: "command_execution",
  requestKind: "command",
};

const pathRow = (doing: string, did: string, field: string, requestKind: ToolRequestKind): ToolRow => ({
  line: (input, moment) => {
    const path = toolField(input, field);
    return path === undefined ? undefined : `${moment === "done" ? did : doing} ${path}`;
  },
  shows: [field],
  requestKind,
  ...(requestKind === "file-change"
    ? { itemType: "file_change" as const, paths: (input: ToolInput) => { const path = toolField(input, field); return path === undefined ? [] : [path]; } }
    : {}),
});

const aboutRow = (words: { doing: string; did?: string }, field: string, rest: Omit<ToolRow, "line" | "shows"> = {}): ToolRow => ({
  line: (input, moment) => {
    const what = toolField(input, field);
    return what === undefined ? undefined : `${(moment === "done" ? words.did : undefined) ?? words.doing} ${titleLine(what)}`;
  },
  shows: [field],
  ...rest,
});

/** Codex reports every path one call touched in a single change item; Claude reports one path per call. */
function changedPaths(input: ToolInput): readonly string[] {
  const changes = input["changes"];
  if (!Array.isArray(changes)) return [];
  return changes.flatMap(change => {
    const path = typeof change === "object" && change !== null ? (change as ToolInput)["path"] : undefined;
    return typeof path === "string" && path.length > 0 ? [path] : [];
  });
}

const changeRow: ToolRow = {
  line: (input, moment) => {
    const paths = changedPaths(input);
    if (paths.length === 0) return undefined;
    const verb = moment === "done" ? "edited" : "editing";
    return paths.length === 1 ? `${verb} ${paths[0]}` : `${verb} ${plural(paths.length, "file")}`;
  },
  shows: [],
  itemType: "file_change",
  requestKind: "file-change",
  paths: changedPaths,
};

/** The harness's question tool, which asks the person and runs nothing. Its prompt is the question itself: the
 * options a person picks from are the tool's own, the pick rides back as the call's input, and there is no consent
 * in it to give. The name is the harness's; the rest of this file reads the shape, never the name. */
export const QUESTION_TOOL = "AskUserQuestion";

/** One choice on a question, as a row draws it: the words on its button and the sentence under them. */
export interface AskedOption {
  /** What the pick is named by on the wire; the label alone is what the harness reads back. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/** One question the harness put to the person: the two or three words it heads it with, the sentence itself, the
 * choices, and whether it takes more than one of them. */
export interface AskedQuestion {
  /** What the harness keys the answer by: the question's own text. */
  readonly key: string;
  /** Where the call put it, which its options' ids and an answer typed for it name it by. */
  readonly index: number;
  readonly header: string;
  readonly question: string;
  readonly options: readonly AskedOption[];
  readonly multiSelect: boolean;
}

/** Several picks travel as one option id, since one pick closes one prompt: a multi-select question's Answer button
 * names every box that is ticked, and a prompt carrying more than one question names one pick per question. */
const PICK_JOIN = "|";

const optionId = (question: number, option: number): string => `q${question}:o${option}`;

function askedOptions(raw: unknown, question: number): AskedOption[] {
  if (!Array.isArray(raw)) return [];
  const options: AskedOption[] = [];
  for (const entry of raw) {
    const fields = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as ToolInput) : undefined;
    const label = fields === undefined ? undefined : toolField(fields, "label");
    if (label === undefined) continue;
    options.push({ id: optionId(question, options.length), label, description: (fields === undefined ? undefined : toolField(fields, "description")) ?? "" });
  }
  return options;
}

/** The questions a call to the question tool carries, in the order it asked them; nothing for every other call and
 * for a question whose input has not finished arriving. A question with no choices stays: it draws as the one field
 * a typed answer goes into. */
export function askedQuestions(toolName: string, input: string): readonly AskedQuestion[] | undefined {
  const fields = toolInput(input);
  return fields === undefined ? undefined : permissionWords(toolName).questions?.(fields);
}

function questionsIn(fields: ToolInput): readonly AskedQuestion[] | undefined {
  const raw = fields["questions"];
  if (!Array.isArray(raw)) return undefined;
  const questions: AskedQuestion[] = [];
  for (const [at, entry] of raw.entries()) {
    const q = typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as ToolInput) : undefined;
    const text = q === undefined ? undefined : toolField(q, "question");
    if (q === undefined || text === undefined) continue;
    const options = askedOptions(q["options"], at);
    questions.push({ key: text, index: at, header: toolField(q, "header") ?? "", question: text, options, multiSelect: q["multiSelect"] === true });
  }
  return questions.length === 0 ? undefined : questions;
}

/** The options a question's prompt carries on the wire: one per choice, each an answer rather than a consent, so
 * nothing offers to allow or refuse a call that only asks. Empty for every other kind of call, which keeps its
 * harness's own options. */
export function questionOptions(toolName: string, input: string): PermissionOption[] {
  const questions = askedQuestions(toolName, input) ?? [];
  return questions.flatMap(q => q.options.map(o => ({ id: o.id, label: o.label, effect: "answer" as const })));
}

/** The pick that answers one question with the person's own words rather than one of its choices: the words ride
 * the id escaped, so neither the join nor a colon in them splits it. */
export const otherOptionId = (question: number, words: string): string => `q${question}:other:${encodeURIComponent(words)}`;

/** An answer typed for a question, read back off its id; nothing for any other id. */
function typedAnswer(id: string): { question: number; words: string } | undefined {
  const match = /^q(\d+):other:(.*)$/.exec(id);
  if (match === null) return undefined;
  try {
    return { question: Number(match[1]), words: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
}

/** One pick as the several options it names, or nothing when any of them is not on this prompt. Every reader of a
 * pick goes through here, so the rule that a multi-select answer is one id holding several lives in one place. A
 * question's prompt also takes answers typed for it, each named by its words; a consent prompt takes none. */
export function pickedOptions(options: readonly PermissionOption[], picked: string): PermissionOption[] | undefined {
  const asks = options.every(o => o.effect === "answer");
  const named = picked.split(PICK_JOIN).map(id => {
    const typed = asks ? typedAnswer(id) : undefined;
    return options.find(o => o.id === id) ?? (typed === undefined ? undefined : { id, label: typed.words, effect: "answer" as const });
  });
  return named.length > 0 && named.every((o): o is PermissionOption => o !== undefined) ? named : undefined;
}

/** The one id a set of ticked boxes travels as. */
export const pickedOptionId = (ids: readonly string[]): string => ids.join(PICK_JOIN);

/** The call's input with the person's answer written into it, which is how the harness reads a pick: every question
 * keyed by its own text, a single-select question answered by the one label and a multi-select one by the labels it
 * took, an answer typed in Other standing as a label. Undefined when the picks name no question on this call. */
export function questionAnswerInput(toolName: string, input: string, picked: readonly string[]): Record<string, unknown> | undefined {
  const fields = toolInput(input);
  const questions = askedQuestions(toolName, input);
  if (questions === undefined || fields === undefined) return undefined;
  const answers: Record<string, string | string[]> = {};
  const typed = picked.flatMap(id => typedAnswer(id) ?? []);
  for (const question of questions) {
    const labels = [...question.options.filter(o => picked.includes(o.id)).map(o => o.label), ...typed.filter(t => t.question === question.index).map(t => t.words)];
    if (labels.length === 0) continue;
    answers[question.key] = question.multiSelect ? labels : labels[0]!;
  }
  return Object.keys(answers).length === 0 ? undefined : { ...fields, answers };
}

/** What the call itself reads as while it waits: the question, never the tool's own name, which is no word a
 * person knows. Registered in the tool table below by the same key the prompt's words are. */
const questionRow: ToolRow = {
  line: input => {
    const first = questionsIn(input)?.[0];
    return first === undefined ? undefined : first.question;
  },
  // No detail: the prompt under this row is the question, whole, and a row that repeated it would put the same
  // sentence on the screen twice.
  title: "Asked you",
  shows: [],
};

const questionAsk: PermissionWords = {
  lead: input => {
    const first = questionsIn(input)?.[0];
    return first === undefined ? undefined : { says: first.question };
  },
  questions: questionsIn,
  named: ["questions"],
};

/** Launching a subagent, under either name the harness gives that call. */
const agentRow: ToolRow = aboutRow({ doing: "agent:" }, "description", { itemType: "collab_agent_tool_call" });

/** Every tool a harness reports, one row per name, Claude's and Codex's alike: what the command line writes for the
 * call and what the app's transcript makes of it come from the same row, so a new tool is a row here and nothing
 * else. A name with no row reads as itself, by the fields below. */
const TOOL_ROWS: ReadonlyMap<string, ToolRow> = new Map<string, ToolRow>([
  ["Bash", shellRow],
  ["command_execution", shellRow],
  ["Read", pathRow("reading", "read", "file_path", "file-read")],
  ["Write", pathRow("writing", "wrote", "file_path", "file-change")],
  ["Edit", pathRow("editing", "edited", "file_path", "file-change")],
  ["MultiEdit", pathRow("editing", "edited", "file_path", "file-change")],
  ["NotebookEdit", pathRow("editing", "edited", "notebook_path", "file-change")],
  ["file_change", changeRow],
  ["Grep", aboutRow({ doing: "searching code for", did: "searched code for" }, "pattern", { codeSearch: true })],
  ["Glob", aboutRow({ doing: "searching code for", did: "searched code for" }, "pattern", { codeSearch: true })],
  ["WebSearch", aboutRow({ doing: "searching the web for", did: "searched the web for" }, "query", { itemType: "web_search" })],
  ["web_search", aboutRow({ doing: "searching the web for", did: "searched the web for" }, "query", { itemType: "web_search" })],
  ["WebFetch", aboutRow({ doing: "fetching", did: "fetched" }, "url", { itemType: "web_search" })],
  ["Task", agentRow],
  ["Agent", agentRow],
  ["spawn_agent", aboutRow({ doing: "agent:" }, "prompt", { itemType: "collab_agent_tool_call" })],
  [QUESTION_TOOL, questionRow],
]);

/** The fields a call's row shows when its own row names none, most particular first. */
const SHOWN_FIELDS: readonly string[] = ["file_path", "notebook_path", "pattern", "query", "url", "description", "prompt"];

/** The call's input as an object, or undefined while it is still arriving or when it is not one. */
function toolInput(input: string): ToolInput | undefined {
  let fields: unknown;
  try {
    fields = JSON.parse(input);
  } catch {
    return undefined;
  }
  return typeof fields === "object" && fields !== null && !Array.isArray(fields) ? (fields as ToolInput) : undefined;
}

/** The one line a tool call reads as while a turn runs: the shell line behind a prompt, the file behind the verb
 * that touched it, the search behind what it looked for, else the tool's own name. `input` is the delta's text,
 * the JSON the harness reported for the call; text that is not an object leaves the name alone. */
export function toolActivityLine(toolName: string | undefined, input: string): string {
  const name = toolName ?? "tool";
  const row = TOOL_ROWS.get(name);
  if (row === undefined) return name;
  const fields = toolInput(input);
  return fields === undefined ? name : row.line(fields, "asked") ?? name;
}

/** The same call once its result says it ran: the past of the line it opened with, which is the only place a client
 * may write one. Nothing for a call whose row reads the same at both moments, and for one whose input never became
 * an object, so the call's own answer stands there instead. */
export function toolDoneLine(toolName: string | undefined, input: string): string | undefined {
  const row = TOOL_ROWS.get(toolName ?? "tool");
  const fields = row === undefined ? undefined : toolInput(input);
  if (row === undefined || fields === undefined) return undefined;
  const done = row.line(fields, "done");
  return done === undefined || done === row.line(fields, "asked") ? undefined : done;
}

/** What a tool call is, for a client whose rows carry more than one line: the field to show, the shell command and
 * what it was for, the paths the call changed, and the kinds a client groups by. Input that is not an object yet is
 * shown as it stands, since a call streams in and a row is drawn before it is whole. */
export interface ToolCallFacts {
  /** The words for this kind of call, where its row names them; absent leaves the harness's own name to stand. */
  readonly title?: string;
  readonly detail?: string;
  readonly command?: string;
  readonly description?: string;
  readonly changedFiles?: readonly string[];
  readonly itemType?: ToolItemType;
  readonly requestKind?: ToolRequestKind;
}

export function toolCallFacts(toolName: string, input: string): ToolCallFacts {
  const row = TOOL_ROWS.get(toolName);
  const itemType = row?.itemType ?? (serverTool(toolName) === undefined ? undefined : "mcp_tool_call");
  const kinds = {
    ...(itemType !== undefined ? { itemType } : {}),
    ...(row?.requestKind !== undefined ? { requestKind: row.requestKind } : {}),
  };
  const titled = row?.title === undefined ? {} : { title: row.title };
  const fields = toolInput(input);
  if (fields === undefined) return { ...kinds, ...titled, ...(input.length > 0 ? { detail: input } : {}) };
  const detail = row?.detail?.(fields) ?? firstField(fields, [...(row?.shows ?? []), ...SHOWN_FIELDS]);
  const shell = row?.requestKind === "command";
  const command = shell ? toolField(fields, "command") : undefined;
  const description = shell ? toolField(fields, "description") : undefined;
  const changedFiles = row?.paths?.(fields) ?? [];
  return {
    ...kinds,
    ...titled,
    ...(detail !== undefined ? { detail } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

/** Whether a call looked through the code, for the client that folds those rows together. */
export function isCodeSearchTool(toolName: string | undefined): boolean {
  return toolName !== undefined && TOOL_ROWS.get(toolName)?.codeSearch === true;
}

/** The sentence a harness stamps on a result it wrote for the agent and not for the person; it carries handles the
 * agent needs and reads as an instruction to a model, and it is cut by every row that shows it. Matched on the
 * stamp rather than on the whole sentence, which differs per kind of thing launched. */
const INTERNAL_RESULT_MARK = "This tool result is internal metadata";

/** Whether the harness marked this result its own note to the agent, so nothing draws it. The one test, read by the
 * line a call's row shows and by the transcript that folds a call's result. */
export function internalToolResult(text: string): boolean {
  return text.includes(INTERNAL_RESULT_MARK);
}

/** What one tool call answered, as the line under the call: its first line by the rule the call's own line is cut
 * by, with the word ahead of it when the harness marked the call failed. Nothing when a call that worked answered
 * with nothing, since a blank line says less than no line. */
export function toolResultLine(text: string, isError = false): string | undefined {
  if (internalToolResult(text)) return undefined;
  const first = titleLine(text);
  if (!isError) return first === "" ? undefined : first;
  return first === "" ? "failed" : `failed: ${first}`;
}

/** What a terminal watching a turn prints once one call's result lands: what a call that changed a file changed,
 * in the past, since the answer such a call hands back is the harness telling itself the write landed; and for
 * every other call what came back, which is what a person is watching it for. Nothing where neither has anything
 * to say. A call still waiting on a person has no result and so no line here, which is what keeps the past out of
 * a terminal until the thing has happened. */
export function toolAnsweredLine(toolName: string | undefined, input: string, result: { text: string; isError?: boolean }): string | undefined {
  if (result.isError !== true && toolCallFacts(toolName ?? "tool", input).requestKind === "file-change") {
    const did = toolDoneLine(toolName, input);
    if (did !== undefined) return did;
  }
  return toolResultLine(result.text, result.isError === true);
}

/** What a call that launched a subagent said the task was, from the call's own input: the title of the fold that
 * subagent's lines sit under. Nothing where the call named no task, and the fold then reads the call. */
export function subagentTaskLine(input: string): string | undefined {
  const fields = toolInput(input);
  const described = fields === undefined ? undefined : toolField(fields, "description");
  return described === undefined ? undefined : titleLine(described);
}

/** What a prompt raised inside a subagent's own run says above it, so a person answering knows which of them is
 * asking rather than reading one unowned question. */
export const subagentAskerLine = (task: string): string => `${task} asks`;

/** Who is asking, above a prompt drawn in a thread that did not raise it: the thread whose turn is stopped on the
 * question, named, since the thread reading this one is only held up until somebody answers it. */
export const waitingAskerLine = (title: string): string => `${title} asks; this thread waits on the answer`;

/** What a thread is doing, as the one line a client with no transcript shows: the tool call it is running, the
 * prompt it is blocked on, else its own latest line of prose. Nothing for an event that says nothing about the
 * work, so a caller keeps the line it had. */
export function threadWorkingLine(e: SessionEvent): string | undefined {
  switch (e.type) {
    case "session.delta":
      return e.kind === "text" || e.kind === "thinking" ? lastLine(e.text) : e.kind === "tool_use" ? toolActivityLine(e.toolName, e.text) : undefined;
    case "session.permission":
      return permissionAskLine(e.toolName, e.input, e.detail);
    default:
      return undefined;
  }
}

/** A prompt's lead in two parts: the words, and the call's own text where the call has some. They are apart because
 * a command is judged by characters a sentence face blurs, two hyphens reading as one dash among them, so a client
 * with more than one face draws the second part as code while a one-face surface joins them back into a sentence. */
interface AskLead {
  readonly says: string;
  readonly code?: string;
}

/** How one kind of call is put to a person when the harness asks permission for it: the lead they judge it by,
 * the input fields that lead already carries, and the field holding a file's body. */
interface PermissionWords {
  readonly lead: (input: ToolInput, toolName: string) => AskLead | undefined;
  /** The questions this kind of call puts to the person, on the one kind that asks rather than does; absent on
   * every other kind, which is what tells a prompt that asks from a prompt that wants consent. */
  readonly questions?: (input: ToolInput) => readonly AskedQuestion[] | undefined;
  /** Fields the lead says itself, left out of the values shown under it so nothing is read twice. */
  readonly named: readonly string[];
  readonly body?: string;
  /** A sentence the agent wrote about the call, prose a client draws in the sentence face: the harness's own
   * reason for a Codex command, the prompt a fetch is read with. Absent on a kind with none. */
  readonly note?: (input: ToolInput, detail: string | undefined) => string | undefined;
}

/** A file's name and its folder as a person says them: `health.ts in src`, or the name alone at the root. */
function fileInFolder(path: string): string {
  const folder = parentFolderName(path);
  return `${folderName(path)}${folder === "" ? "" : ` in ${folder}`}`;
}

const writeAsk: PermissionWords = {
  lead: input => {
    const path = toolField(input, "file_path");
    if (path === undefined) return undefined;
    const folder = parentFolderName(path);
    const content = input["content"];
    const size = typeof content === "string" ? ` (${fmtBytes(new TextEncoder().encode(content).length)})` : "";
    return { says: `Write ${folderName(path)}${folder === "" ? "" : ` in ${folder}`}${size}` };
  },
  named: ["file_path", "content"],
  body: "content",
};

/** Claude's Edit and MultiEdit: the file, and how many places change where there are several. The strings that
 * go and come are the client's to draw as lines; they are never dumped under the lead. */
const editAsk: PermissionWords = {
  lead: input => {
    const path = toolField(input, "file_path");
    if (path === undefined) return undefined;
    const edits = input["edits"];
    const count = Array.isArray(edits) && edits.length > 1 ? ` (${edits.length} places)` : "";
    return { says: `Edit ${fileInFolder(path)}${count}` };
  },
  named: ["file_path", "old_string", "new_string", "replace_all", "edits"],
};

const commandAsk: PermissionWords = {
  lead: input => {
    const command = toolField(input, "command");
    return command === undefined ? undefined : { says: "Run a command:", code: command };
  },
  named: ["command", "description"],
};

/** Codex's command approval: the command and the folder it runs in, with the model's own reason as the note. */
const codexCommandAsk: PermissionWords = {
  lead: input => {
    const command = toolField(input, "command");
    return command === undefined ? undefined : { says: "Run a command:", code: command };
  },
  named: ["command", "cwd"],
  note: (_input, detail) => (detail === undefined || detail === "" ? undefined : detail),
};

/** Codex's file-change approval: the files by name, since the wire carries their paths and kinds and no diff. */
const fileChangeAsk: PermissionWords = {
  lead: input => {
    const changes = input["changes"];
    if (!Array.isArray(changes)) return undefined;
    const paths = changes.map(c => (typeof c === "object" && c !== null ? toolField(c as ToolInput, "path") : undefined)).filter((p): p is string => p !== undefined);
    if (paths.length === 0) return undefined;
    return { says: paths.length === 1 ? `Change ${fileInFolder(paths[0]!)}` : `Change ${paths.length} files: ${paths.map(folderName).join(", ")}` };
  },
  named: ["changes"],
};

/** A page fetched from the web: the address as code, and what the agent will read it for as the note. */
const fetchAsk: PermissionWords = {
  lead: input => {
    const url = toolField(input, "url");
    return url === undefined ? undefined : { says: "Fetch a page:", code: url };
  },
  named: ["url", "prompt"],
  note: input => toolField(input, "prompt"),
};

const skillAsk: PermissionWords = {
  lead: input => {
    const skill = toolField(input, "skill");
    return skill === undefined ? undefined : { says: `Run the skill ${skill}` };
  },
  named: ["skill"],
};

const serverAsk: PermissionWords = {
  lead: (_input, toolName) => {
    const lent = serverTool(toolName);
    return lent === undefined ? undefined : { says: `Use ${lent.server}'s ${lent.tool.replace(/_/g, " ")}` };
  },
  named: [],
};

/** A kind with no words of its own yet: the lead falls back to the harness's own phrase under the tool's name. */
const plainAsk: PermissionWords = { lead: () => undefined, named: [] };

/** Every kind of call a permission prompt is worded for, one row per kind. The chat row and the command line both
 * read this table, so the words live here and in neither of them, and a kind worded later is a row and nothing
 * else. A name no row matches is a server's tool where its name carries one, else the plain row. */
const PERMISSION_ASKS: ReadonlyMap<string, PermissionWords> = new Map<string, PermissionWords>([
  ["Write", writeAsk],
  ["Edit", editAsk],
  ["MultiEdit", editAsk],
  ["Bash", commandAsk],
  ["WebFetch", fetchAsk],
  ["Skill", skillAsk],
  [QUESTION_TOOL, questionAsk],
  // Codex's two approvals, under the names its adapter gives them.
  ["command_execution", codexCommandAsk],
  ["file_change", fileChangeAsk],
]);

function permissionWords(toolName: string): PermissionWords {
  return PERMISSION_ASKS.get(toolName) ?? (serverTool(toolName) === undefined ? plainAsk : serverAsk);
}

/** What the disclosure a file's body sits behind reads: the buttons stay in reach and the file is one click away. */
const BODY_LABEL = "show the file";

/** The lead its kind words the call by, or the harness's own phrase under the tool's name for a call whose input
 * carries none of what its rule needs and for a kind with no rule. */
function askLead(toolName: string, input: string, detail?: string): AskLead {
  const fields = toolInput(input);
  const lead = fields === undefined ? undefined : permissionWords(toolName).lead(fields, toolName);
  if (lead !== undefined) return lead;
  return { says: detail === undefined || detail === "" ? `Permission for ${toolName}` : `Permission for ${toolName}: ${detail}` };
}

/** The two parts joined back into one line, the one rule for it. */
const leadLine = (lead: AskLead): string => (lead.code === undefined ? lead.says : `${lead.says} ${lead.code}`);

/** The prompt row's lead as one line, for a surface with one face: the command line's. No question mark, since the
 * options under it are the question. */
export function permissionAskLine(toolName: string, input: string, detail?: string): string {
  return leadLine(askLead(toolName, input, detail));
}

/** One value as the row reads it: its own whitespace collapsed, so a field holding a paragraph is one line rather
 * than a wall, while the fields stay apart under their separator. */
const restValue = (value: unknown): string =>
  (typeof value === "string" ? value : Array.isArray(value) && value.every(v => typeof v === "string" || typeof v === "number") ? value.join(", ") : (JSON.stringify(value) ?? "")).replace(/\s+/g, " ").trim();

/** The whole of a relayed permission prompt as a client draws it: the lead in its two parts, the input values that
 * lead does not already carry, and the file body folded away behind its own disclosure. Nothing here is cut, since
 * this is the row consent is given on, which is also why a file's text is folded rather than shown: a wall of it
 * between the question and the buttons is what nobody reads. */
export interface PermissionPromptWords {
  /** The lead as one line, the two parts joined, which is what a surface with one face shows. */
  readonly lead: string;
  readonly says: string;
  /** The call's own text, where the call has some: a client with a code face draws this in it, breaks it at no
   * character inside a token and scrolls it sideways rather than cutting it. */
  readonly code?: string;
  readonly rest: string;
  readonly body?: { readonly label: string; readonly text: string };
  /** A sentence the agent wrote about the call, drawn in the sentence face under the lead; absent where there is none. */
  readonly note?: string;
  /** The file the call writes or edits, whole, where it names one. */
  readonly file?: string;
  /** The text an edit takes out and the text it puts in, off its first edit where it makes several. */
  readonly edit?: { readonly old: string; readonly next: string };
  /** Set only on a call that asks the person something: the row draws these and nothing else, since a question's
   * whole input is the question. */
  readonly questions?: readonly AskedQuestion[];
}

export function permissionPromptWords(toolName: string, input: string, detail?: string): PermissionPromptWords {
  const lead = askLead(toolName, input, detail);
  const parts = { lead: leadLine(lead), says: lead.says, ...(lead.code === undefined ? {} : { code: lead.code }) };
  const questions = askedQuestions(toolName, input);
  if (questions !== undefined) return { ...parts, rest: "", questions };
  const fields = toolInput(input);
  if (fields === undefined) return { ...parts, rest: input };
  const words = permissionWords(toolName);
  const named = new Set(words.named);
  const body = words.body === undefined ? undefined : toolField(fields, words.body);
  const note = words.note?.(fields, detail);
  const file = toolField(fields, "file_path");
  const edit = editStrings(fields);
  const rest = Object.entries(fields)
    .filter(([key]) => !named.has(key))
    .map(([key, value]) => `${key}: ${restValue(value)}`)
    .join("\n");
  return {
    ...parts,
    rest,
    ...(body === undefined ? {} : { body: { label: BODY_LABEL, text: body } }),
    ...(note === undefined ? {} : { note }),
    ...(file === undefined ? {} : { file }),
    ...(edit === undefined ? {} : { edit }),
  };
}

/** The strings an edit swaps, off any call that carries them: the first of several edits, else the call's own. Read
 * raw rather than trimmed, since a blank line taken out is part of the change. */
function editStrings(fields: ToolInput): { old: string; next: string } | undefined {
  const edits = fields["edits"];
  const first = Array.isArray(edits) && typeof edits[0] === "object" && edits[0] !== null ? (edits[0] as ToolInput) : fields;
  const old = first["old_string"];
  const next = first["new_string"];
  return typeof old === "string" && typeof next === "string" ? { old, next } : undefined;
}

/** That lead taken off the prompt itself, which is what a thread's row says it is waiting on and what the app says
 * outside the thread's own pane. The one call both make, so the whole prompt is in hand here and reading another of
 * its fields to word the lead is an edit to this body alone. */
export function askingLine(ask: Pick<SessionPermissionEvent, "toolName" | "input" | "detail">): string {
  return permissionAskLine(ask.toolName, ask.input, ask.detail);
}

/** What an answered prompt row reads once it is closed, one word per outcome. The option's own label rides beside it
 * only where it says something the outcome does not, which is the pick that also changed the access for the rest of
 * the turn: "Allowed: Allow" and "Denied: Deny" name the same fact twice. */
export function permissionOutcomeLine(outcome: PermissionOutcome, picked?: { label: string; effect: PermissionEffect }): string {
  const named = picked?.effect === "mode" ? `: ${picked.label}` : "";
  switch (outcome) {
    case "allowed":
      return picked?.effect === "answer" ? `You answered: ${picked.label}` : `Allowed${named}`;
    case "denied":
      return `Denied${named}`;
    case "unanswered":
      return "Nobody answered; denied";
    case "cancelled":
      return "Cancelled with the turn";
    default: {
      const _exhaustive: never = outcome;
      return "";
    }
  }
}

/** What a pick the host would not take came to, one line per outcome it can answer with, said by the app under the
 * prompt and by a terminal that answered it; `answered` is the only one that is not a failure and has no line here. */
export const ANSWER_WORDS: Readonly<Record<Exclude<SessionAnswerOutcome, "answered">, string>> = {
  gone: "the prompt closed before the answer reached it",
  unsupported: "this thread's agent raises no prompt this host can answer",
  "not-found": "this host holds no turn of that thread",
  "no-option": "the prompt carries no option by that id",
};

/** What the harness is told when a person picked deny in the chat: the agent reads it as the call's result, so it
 * says who refused rather than reading as a tool that failed. */
export const PERMISSION_DENIED_LINE = "the person denied this in the chat";

/** The same line with the person's reason, where they gave one: what they want done instead, in their own words. */
export const deniedLine = (reason: string | undefined): string =>
  reason === undefined || reason.trim() === "" ? PERMISSION_DENIED_LINE : `${PERMISSION_DENIED_LINE}, and said what to do instead: ${reason.trim()}`;

/** One option on a prompt that also puts the rest of the turn in another access mode, as the row shows it; the mode
 * arrives as the CLI's own slug and the runtime's harness table lends it the words the picker uses. */
export function permissionModeOptionLabel(modeLabel: string): string {
  return `Allow, then ${modeLabel}`;
}

/** What the access picker says over its list while a turn is running: what a pick does to that turn, read before the
 * pick rather than under the box after it. A pick goes onto the thread's record through the access verb either way;
 * a harness that takes a mode change mid-turn puts it to the turn in front of the person too, the prompt it is
 * stopped on included, and one that does not leaves that turn at its mode, so the thread's next turn is the first
 * at the pick. */
export function accessReachLine(movesRunningTurn: boolean): string {
  return movesRunningTurn ? "Applies to the turn running now" : "Applies from the thread's next turn";
}

/** What the composer says under the box when an access pick the harness's own row said would reach the running turn
 * came back refused: the two halves every refusal in this app has, what happened and then where the pick stands,
 * which is on the thread's record for its next turn. It stands only for a refusal the harness actually answered
 * with, never for one the menu said before the pick, so nobody reads the same sentence twice. Short because that
 * slot is one line the width of the box and it truncates from the right: 54 characters is what fits at the window
 * this app is smallest in (measured 2026-09-08, 364 px of slot at a 1200 px viewport), and a refusal cut before its
 * second half is no use. */
export const ACCESS_REFUSED_WORDS = { said: "The turn refused it.", fix: "The next turn runs at it." } as const;

/** Those two halves as the one line that slot holds. */
export const ACCESS_REFUSED_LINE = `${ACCESS_REFUSED_WORDS.said} ${ACCESS_REFUSED_WORDS.fix}`;
