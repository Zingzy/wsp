// SPDX-License-Identifier: AGPL-3.0-only
// A Claude Code session copied through one message to a new session beside it:
// the message's own chain, parentUuid by parentUuid back to the session's start
// or to the compact_boundary it sits after, and no other line. A fork, a rewind
// and a side question each start from one. The read prints only what the walk
// needs, the walk is plain code here, and the write takes the source's own
// lines by number on the computer, so no JSON tool has to be there and no turn
// of the source crosses the wire twice.
//
// Measured on 2.1.296 (2026-10-10): a copy through a turn's last reply resumed
// knowing that turn and every turn before it and nothing after; a copy through a
// reply before the last compaction resumed where --resume-session-at at the same
// uuid exits 1 with "No message found with message.uuid of"; a copy through the
// live end of a rewound session resumed on the live branch. The copy keeps the
// source's session ids on its lines and the CLI writes the new id on its own.

import { endRun, fmtDuration, shellQuote } from "@wsp/protocol";
import type { ExecStreamFactory } from "@wsp/protocol";
import { UUID_RE, newSessionId } from "./landmines.js";

/** How long the read or the write of one copy may take before it is ended: a read of a 20 MB session carries a few
 * megabytes, and a box over a slow link answers in seconds. */
export const COPY_WALL_MS = 90_000;

/** The length from which a string in a read line is printed empty: every id, type and tool name the walk reads is
 * shorter, and 255 is the most a repeat count may say on macOS's sed. */
const READ_STRING = 200;

/** The words the CLI itself says for a session its store does not hold. */
export const noConversationLine = (session: string): string => `No conversation found with session ID: ${session}`;

const uuid = (what: string, id: string): string => {
  if (!UUID_RE.test(id)) throw new Error(`${what} must be a UUID, got "${id}"`);
  return id;
};

/** The shell words that find a session's file under the config dir's projects folder, wherever the CLI filed it, into
 * $src, or end the run with the CLI's own sentence for a session it does not hold. */
export const sessionFileLine = (configDir: string, session: string): string =>
  `src=$(ls ${shellQuote(`${configDir}/projects`)}/*/${uuid("session identifier", session)}.jsonl 2>/dev/null | head -n 1); [ -n "$src" ] || { echo ${shellQuote(noConversationLine(session))} >&2; exit 1; }`;

/** Prints how many whole lines the session's file holds, then each of those lines that names a message, after its
 * line number and a colon, every long string in it printed empty. A line still being written has no newline yet and
 * is left out, so a running session's file reads as it stood. An opening quote follows a colon, a comma or a bracket,
 * so a closing one never starts a blanked run. */
export function chainReadCommand(o: { session: string; configDir: string }): string {
  const blank = shellQuote(String.raw`s/([,:{[])"([^"\\]|\\.){${READ_STRING},}"/\1""/g`);
  return `${sessionFileLine(o.configDir, o.session)}; n=$(wc -l < "$src"); echo $n; head -n "$n" "$src" | sed -E ${blank} | grep -n -F '"uuid":"'`;
}

/** One message line of the read, as the walk reads it. */
export interface ChainLine {
  /** Its line number in the session's file, from 1. */
  at: number;
  uuid: string;
  parent: string | null;
  type: string;
  /** Where the conversation the CLI loads begins: a compact_boundary, whose summary follows it. */
  boundary: boolean;
  /** On an assistant line, its API message's id and the calls it holds; on a user line, the calls it answers. */
  messageId?: string;
  calls: { id: string; name: string; input: unknown }[];
  answers: string[];
}

const record = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** The read's lines as the walk reads them: its first line the file's count, then one per message. A line that does
 * not parse is left out, and a chain through it is refused rather than copied short. */
export function readChain(read: readonly string[]): { total: number; lines: ChainLine[] } {
  const total = Number(read[0]);
  if (!Number.isSafeInteger(total)) throw new Error(read.at(-1) ?? "the session's file could not be read");
  const lines: ChainLine[] = [];
  for (const raw of read.slice(1)) {
    const colon = raw.indexOf(":");
    const at = Number(raw.slice(0, colon));
    let line: Record<string, unknown> | undefined;
    try {
      line = record(JSON.parse(raw.slice(colon + 1)));
    } catch {
      continue;
    }
    if (line === undefined || !Number.isSafeInteger(at) || typeof line.uuid !== "string") continue;
    const message = record(line.message);
    const blocks = Array.isArray(message?.content) ? message.content.map(record).filter(b => b !== undefined) : [];
    lines.push({
      at,
      uuid: line.uuid,
      parent: typeof line.parentUuid === "string" ? line.parentUuid : null,
      type: typeof line.type === "string" ? line.type : "",
      boundary: line.type === "system" && line.subtype === "compact_boundary",
      ...(line.type === "assistant" && typeof message?.id === "string" ? { messageId: message.id } : {}),
      calls: line.type === "assistant" ? blocks.filter(b => b.type === "tool_use" && typeof b.id === "string").map(b => ({ id: b.id as string, name: String(b.name), input: b.input ?? {} })) : [],
      answers: line.type === "user" ? blocks.filter(b => b.type === "tool_result" && typeof b.tool_use_id === "string").map(b => b.tool_use_id as string) : [],
    });
  }
  return { total, lines };
}

/** The line numbers of the chain that ends at `anchor`, oldest first: the anchor's line, then each parent's, back to
 * the session's first message or to the compact_boundary the anchor sits after. Every later line, every branch a
 * rewind left behind and every line before that boundary stays out. Throws where the file holds no message by that
 * uuid, and where a link of the chain is missing, rather than copying it short. */
export function chainThrough(lines: readonly ChainLine[], anchor: string): number[] {
  const byUuid = new Map(lines.map(l => [l.uuid, l] as const));
  if (!byUuid.has(anchor)) throw new Error(`the session holds no message ${anchor}`);
  const kept: number[] = [];
  const seen = new Set<string>();
  for (let at: string | null = anchor; at !== null; ) {
    const line = byUuid.get(at);
    if (line === undefined || seen.has(at)) throw new Error(`the session's chain to message ${anchor} is broken at ${at}`);
    seen.add(at);
    kept.push(line.at);
    if (line.boundary) break;
    at = line.parent;
  }
  return kept.sort((a, b) => a - b);
}

/** Where a copy of a session that may still be running ends: its newest message, or where the newest assistant
 * message holds a call with no result yet, the message before that one's first line. Resumed with that call in it,
 * 2.1.280 wrote "[Request interrupted by user for tool use]" as its result, and every answer said the call was
 * interrupted (7 of 7 on Sonnet 5). `running` names each call left out, for the question. */
export function liveEnd(lines: readonly ChainLine[]): { anchor: string; running: string[] } | undefined {
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  const newest = [...lines].reverse().find(l => l.type === "assistant");
  const answered = new Set(lines.flatMap(l => l.answers));
  const open = newest?.messageId === undefined ? [] : lines.filter(l => l.messageId === newest.messageId).flatMap(l => l.calls).filter(c => !answered.has(c.id));
  if (open.length === 0) return { anchor: last.uuid, running: [] };
  const first = lines.find(l => l.messageId === newest!.messageId)!;
  if (first.parent === null) return undefined;
  return { anchor: first.parent, running: open.map(c => `${c.name} ${JSON.stringify(c.input).slice(0, 300)}`) };
}

/** Line numbers as ranges, "1-12,14,18-20": what the write reads off its stdin, short however long the chain. */
export function lineRanges(numbers: readonly number[]): string {
  const out: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j++;
    out.push(i === j ? `${numbers[i]}` : `${numbers[i]}-${numbers[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

/** The write: the source's lines named on stdin as ranges, byte for byte and in order, into a file beside the source
 * under a dot name, renamed to `<fork>.jsonl` once it holds `count` lines, so a reader never finds a copy cut short and
 * a failed write leaves nothing. */
export function chainWriteCommand(o: { session: string; fork: string; configDir: string; count: number }): string {
  const fork = uuid("session identifier", o.fork);
  if (!Number.isSafeInteger(o.count) || o.count < 1) throw new Error(`a copy keeps a whole number of lines, got ${o.count}`);
  const pick = shellQuote('NR == FNR { n = split($0, r, ","); for (i = 1; i <= n; i++) { m = split(r[i], ab, "-"); for (j = ab[1] + 0; j <= ab[m] + 0; j++) keep[j] = 1 } next } FNR in keep');
  const short = shellQuote(`the copy of session ${o.session} came out short`);
  return `${sessionFileLine(o.configDir, o.session)}; tmp="\${src%/*}/.${fork}.jsonl.part"; awk ${pick} - "$src" > "$tmp" && [ $(($(wc -l < "$tmp"))) -eq ${o.count} ] && mv -f "$tmp" "\${src%/*}/${fork}.jsonl" || { rm -f "$tmp"; echo ${short} >&2; exit 1; }`;
}

/** Removes a copy's file and the folder the CLI keeps beside one, wherever it filed them under the projects folder,
 * leaving every other session there. */
export function copyCleanupCommand(o: { fork: string; configDir: string }): string {
  const fork = uuid("session identifier", o.fork);
  const projects = shellQuote(`${o.configDir}/projects`);
  return `rm -rf ${projects}/*/${fork}.jsonl ${projects}/*/${fork}`;
}

/** Why a copy was given up on: its read or its write said nothing for the whole wall. */
export const copyWallLine = (ms: number): string => `the copy of the session had not finished after ${fmtDuration(ms)} and was stopped`;

/** Where a copy ends: a message by its uuid, or the session's live end, cut before any call still running. */
export type CopyThrough = { anchor: string } | "live";

/**
 * A copy of the session through one message, on the road the session's turns run on and with their environment: the
 * read, the walk here, then the write, which takes the chain's line numbers on its stdin. Answers the copy's id and,
 * for a copy through the live end, the calls it left out. Rejects with the read's or the write's own last line, and
 * where the walk finds no such message, before anything is written.
 */
export async function copySession(o: { exec: ExecStreamFactory; env: Readonly<Record<string, string>>; configDir: string; session: string; through: CopyThrough; graceMs: number; wallMs?: number }): Promise<{ session: string; running: string[] }> {
  const wallMs = o.wallMs ?? COPY_WALL_MS;
  const run = async (command: string, input?: string): Promise<{ lines: string[]; code: number | null }> => {
    const stream = o.exec(command, { env: { ...o.env }, ...(input !== undefined ? { input: [input] } : {}) });
    if (input !== undefined) stream.closeInput();
    let walled = false;
    const wall = setTimeout(() => {
      walled = true;
      void endRun(stream, o.graceMs).catch(() => {});
    }, wallMs);
    const lines: string[] = [];
    try {
      for await (const line of stream.lines) lines.push(line);
    } finally {
      clearTimeout(wall);
    }
    const code = await stream.exited.catch(() => null);
    if (walled) throw new Error(copyWallLine(wallMs));
    return { lines, code };
  };
  const read = await run(chainReadCommand({ session: o.session, configDir: o.configDir }));
  if (read.code !== 0) throw new Error(read.lines.at(-1) ?? noConversationLine(o.session));
  const { lines } = readChain(read.lines);
  const end = o.through === "live" ? liveEnd(lines) : { anchor: o.through.anchor, running: [] };
  if (end === undefined) throw new Error(`the session ${o.session} holds no message to copy`);
  const kept = chainThrough(lines, end.anchor);
  const fork = newSessionId();
  const wrote = await run(chainWriteCommand({ session: o.session, fork, configDir: o.configDir, count: kept.length }), lineRanges(kept));
  if (wrote.code !== 0) throw new Error(wrote.lines.at(-1) ?? `the copy of session ${o.session} was not written`);
  return { session: fork, running: end.running };
}
