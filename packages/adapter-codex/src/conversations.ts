// SPDX-License-Identifier: AGPL-3.0-only
// Codex's own threads on a computer, for a person picking one up as a thread, read through `codex app-server` there:
// thread/list for the folder's threads (one indexed row each, 400 threads in 56 ms on 0.162.1), thread/turns/list and
// thread/items/list for the earlier messages, which answer while another process writes the thread. Nothing reads
// Codex's sqlite or its rollouts directly.
//
// Codex holds one writer per thread: a second process that resumes a thread another holds is answered -32600 "thread
// <id> already has an active writer" in about 20 ms, and its TUI's daemon lets go about a minute after its window
// closes (measured twice on 0.162.1). So whether a thread is open elsewhere is learned by resuming it, the way a turn
// would, in a server that ends at once.
import { ENV_FROM_INPUT, foldersStampCommand, programWord, shellQuote, type AgentLaunch, type ConversationLine, type ConversationOrigin, type ConversationStore, type StoredConversation } from "@wsp/protocol";
import { answersOf, appServerScript, initializeRequest, notification, request, type ServerAnswer } from "@wsp/catalog";

/** Codex's words for a thread another process writes, the -32600 answer's own (0.162.1). */
export const WRITER_HELD = "already has an active writer";
/** Codex's words for a thread it holds no such id for: a resume's, a read's, and either's for an id that is no thread
 * id at all (0.162.1). */
const GONE = /no rollout found|thread not loaded|invalid thread id/;
/** How soon Codex lets go of a thread whose window closed, in a sentence. */
export const LETS_GO = "Codex lets go about a minute after its window closes.";
/** The originator wsp's own app-server names itself by, `clientInfo.name` in initializeRequest. */
const WSP_ORIGINATOR = "wsp";
/** How many threads one page of thread/list answers, the most it takes, and how many pages a list reads. */
const PAGE = 100;
const PAGES = 10;
const TURN_PAGE = 100;
const ITEM_PAGE = 200;

const INIT = 1;
const ASK = 2;
const OPEN = 3;

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** One script: the server opened under the environment off its input, then each stage's requests. */
function script(launch: AgentLaunch | undefined, stages: { lines: string[]; answers: number }[]): string {
  return `cd ~ && ${ENV_FROM_INPUT}\n${appServerScript(programWord("codex", launch), stages)}`;
}

const opening = (): { lines: string[]; answers: number } => ({ lines: [initializeRequest(INIT), notification("initialized")], answers: 1 });

/** One page of the folder's threads, the interactive ones (thread/list leaves `exec` runs out by default), the most
 * recently active first. */
export function listCommand(o: { cwds: readonly string[]; cursor?: string; launch?: AgentLaunch }): string {
  return script(o.launch, [opening(), { lines: [request(ASK, "thread/list", { cwd: [...o.cwds], sortKey: "recency_at", limit: PAGE, ...(o.cursor !== undefined ? { cursor: o.cursor } : {}) })], answers: 1 }]);
}

/** Who opened a thread, off the source and originator its index row carries. */
const originOf = (thread: Record<string, unknown>): ConversationOrigin =>
  str(thread.originator) === WSP_ORIGINATOR ? "wsp" : str(thread.source) === "exec" || str(thread.source) === "appServer" ? "script" : "terminal";

/** A thread as the list shows it: the name the person gave it, else its first message. */
function rowOf(thread: Record<string, unknown>): (StoredConversation & { path?: string }) | undefined {
  const id = str(thread.id);
  const cwd = str(thread.cwd);
  if (id === undefined || cwd === undefined) return undefined;
  const preview = str(thread.preview)?.trim();
  const branch = str(rec(thread.gitInfo)?.branch);
  const at = num(thread.recencyAt) ?? num(thread.updatedAt) ?? num(thread.createdAt) ?? 0;
  const path = str(thread.path);
  return {
    id,
    title: str(thread.name) ?? preview ?? id,
    ...(preview !== undefined ? { firstPrompt: preview } : {}),
    ...(branch !== undefined ? { branch } : {}),
    cwd,
    lastAt: at * 1000,
    origin: originOf(thread),
    ...(path !== undefined ? { path } : {}),
  };
}

/** The answer to one request, or the server's refusal of it in words. */
function answerOf(stdout: string, id: number, what: string): Record<string, unknown> {
  const answer: ServerAnswer | undefined = answersOf(stdout).get(id);
  if (answer === undefined) throw new Error(`codex's app server did not answer ${what}`);
  if ("error" in answer) throw new Error(answer.error.message);
  return answer.result;
}

export function parseList(stdout: string): { rows: (StoredConversation & { path?: string })[]; next?: string } {
  const result = answerOf(stdout, ASK, "thread/list");
  const data = Array.isArray(result.data) ? result.data : [];
  const next = str(result.nextCursor);
  return { rows: data.flatMap(t => rowOf(rec(t) ?? {}) ?? []), ...(next !== undefined ? { next } : {}) };
}

/** The stamp of the newest day folder under sessions/, where Codex writes each new thread's rollout (YYYY/MM/DD on
 * 0.162.1); a thread from any folder moves it, which only costs one more list. */
export const newestDayStampCommand = (home: string): string =>
  `d=$(ls -d ${shellQuote(`${home}/sessions`)}/*/*/* 2>/dev/null | tail -n 1); ${foldersStampCommand(['"$d"'])}`;

/** What the store says without asking Codex: how soon it lets go of a thread, and the newest day folder's stamp. */
export const storeMarks = (home: string): Pick<ConversationStore, "letsGo" | "stamp"> => ({ letsGo: LETS_GO, stamp: (_cwds, road) => road.exec(newestDayStampCommand(home)) });

/** The size of each file, one line each in order, blank where it could not be read: GNU stat, then BSD's. */
export function sizesCommand(paths: readonly string[]): string {
  return `for p in ${paths.map(shellQuote).join(" ")}; do s=$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null); printf '%s\\n' "$s"; done`;
}

export const parseSizes = (stdout: string, count: number): (number | undefined)[] => {
  const lines = stdout.split("\n");
  return Array.from({ length: count }, (_, i) => {
    const n = Number(lines[i]?.trim());
    return lines[i]?.trim() !== "" && Number.isSafeInteger(n) ? n : undefined;
  });
};

/** The thread opened, by a resume that takes it as a writer where `probe` asks whether another process holds it and
 * by a read otherwise, then one page of its turns newest first, each with its messages alone. */
export function turnsCommand(o: { threadId: string; probe: boolean; cursor?: string; launch?: AgentLaunch }): string {
  const turns = request(ASK, "thread/turns/list", { threadId: o.threadId, limit: TURN_PAGE, sortDirection: "desc", itemsView: "summary", ...(o.cursor !== undefined ? { cursor: o.cursor } : {}) });
  if (o.cursor !== undefined) return script(o.launch, [opening(), { lines: [turns], answers: 1 }]);
  const open = o.probe ? request(OPEN, "thread/resume", { threadId: o.threadId }) : request(OPEN, "thread/read", { threadId: o.threadId, includeTurns: false });
  return script(o.launch, [opening(), { lines: [open], answers: 1 }, { lines: [turns], answers: 1 }]);
}

/** One page of the thread's items, newest first. */
export function itemsCommand(o: { threadId: string; cursor?: string; launch?: AgentLaunch }): string {
  return script(o.launch, [opening(), { lines: [request(ASK, "thread/items/list", { threadId: o.threadId, limit: ITEM_PAGE, sortDirection: "desc", ...(o.cursor !== undefined ? { cursor: o.cursor } : {}) })], answers: 1 }]);
}

/** What opening the thread said: gone where Codex holds no such thread, open where another process writes it, else
 * the folder it runs in and its name. */
export function parseOpened(stdout: string): "gone" | "open" | { cwd?: string; title?: string } {
  const answer = answersOf(stdout).get(OPEN);
  if (answer === undefined) throw new Error("codex's app server did not answer opening the thread");
  if ("error" in answer) {
    if (answer.error.message.includes(WRITER_HELD)) return "open";
    if (GONE.test(answer.error.message)) return "gone";
    throw new Error(answer.error.message);
  }
  const thread = rec(answer.result.thread) ?? {};
  const cwd = str(thread.cwd) ?? str(answer.result.cwd);
  const title = str(thread.name) ?? str(thread.preview)?.trim();
  return { ...(cwd !== undefined ? { cwd } : {}), ...(title !== undefined ? { title } : {}) };
}

/** One page of turns: each turn's id and how many messages its summary holds. */
export function parseTurns(stdout: string): { turns: { id: string; messages: number }[]; next?: string } {
  const result = answerOf(stdout, ASK, "thread/turns/list");
  const data = Array.isArray(result.data) ? result.data : [];
  const turns = data.flatMap(t => {
    const turn = rec(t);
    const id = str(turn?.id);
    if (id === undefined) return [];
    const items = Array.isArray(turn?.items) ? turn.items : [];
    return [{ id, messages: items.filter(i => isMessage(rec(i))).length }];
  });
  const next = str(result.nextCursor);
  return { turns, ...(next !== undefined ? { next } : {}) };
}

const isMessage = (item: Record<string, unknown> | undefined): boolean => item?.type === "userMessage" || item?.type === "agentMessage";

/** One page of items: each with its turn and its row, where it is a message or a call. */
export function parseItems(stdout: string, toolOf: (item: Record<string, unknown>) => { tool: string; text: string } | undefined): { items: { turnId?: string; line: ConversationLine }[]; next?: string } {
  const result = answerOf(stdout, ASK, "thread/items/list");
  const data = Array.isArray(result.data) ? result.data : [];
  const items = data.flatMap(entry => {
    const held = rec(entry);
    const item = rec(held?.item);
    if (item === undefined) return [];
    const turnId = str(held?.turnId);
    const line = lineOf(item, toolOf);
    return line === undefined ? [] : [{ ...(turnId !== undefined ? { turnId } : {}), line }];
  });
  const next = str(result.nextCursor);
  return { items, ...(next !== undefined ? { next } : {}) };
}

function lineOf(item: Record<string, unknown>, toolOf: (item: Record<string, unknown>) => { tool: string; text: string } | undefined): ConversationLine | undefined {
  if (item.type === "userMessage") {
    const parts = Array.isArray(item.content) ? item.content : [];
    const text = parts.flatMap(p => (rec(p)?.type === "text" ? (str(rec(p)?.text) ?? []) : [])).join("\n").trim();
    return text === "" ? undefined : { who: "person", text };
  }
  if (item.type === "agentMessage") {
    const text = str(item.text);
    return text === undefined ? undefined : { who: "agent", text };
  }
  const call = toolOf(item);
  return call === undefined ? undefined : { who: "tool", tool: call.tool, text: call.text };
}

/** The newest `last` messages of a thread's items, oldest first, the calls among them kept, and how many messages of
 * the thread's `total` came before them. */
export function newestLines(items: readonly ConversationLine[], total: number, last: number): { lines: ConversationLine[]; earlier: number } {
  const kept: ConversationLine[] = [];
  let messages = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const line = items[i]!;
    if (line.who !== "tool") {
      if (messages === last) break;
      messages++;
    }
    kept.unshift(line);
  }
  while (kept[0]?.who === "tool") kept.shift();
  return { lines: kept, earlier: Math.max(0, total - messages) };
}

export const LIST_PAGES = PAGES;
