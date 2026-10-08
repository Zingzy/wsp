// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  CREATED_AT_LABEL,
  type Builder,
  type ImportLedger,
  type Machine,
  type MachineBackend,
  type MachineKind,
  type MachineSpec,
  type PreviewReach,
} from "@wsp/engine";
import type { KeptAgent } from "@wsp/protocol";
import type {
  DaemonReachView,
  ExecStreamFactory,
  GoldenBaseTool,
  GoldenStage,
  GoldenStep,
  ProjectImportResult,
  ProjectView,
  ProjectImportStage,
  SessionEvent,
  SessionView,
  McpServerSpec,
  TurnResult,
  TurnStatus,
  WorkspaceKind,
  WorkspaceSize,
} from "@wsp/protocol";
import { type ThreadPlacement, ThreadScope, WorkspaceOrigin } from "@wsp/protocol";
import { fmtDuration, type WorktreeFolder } from "@wsp/protocol";
import type { MachineExecOptions, TurnWaiting } from "../machine-exec.js";
import type { SubagentView } from "@wsp/protocol";
import type { ScopedRoad } from "../devices.js";
import type { BlobMark } from "../store.js";
import type { HarnessSession } from "./harness.js";
import type { ProjectImportOptions, WorkspaceRecord, LiveWorkspace, StageReport, SessionHandle, GoldenRecipe } from "./wiring.js";

export const WORKSPACES = "workspaces";
/** The projects this host holds, by id: a computer, a source that computer can see and the branch a workspace of
 * it starts on. A workspace's record names one of these and nothing else about it. */
export const PROJECTS = "projects";
/** The seed choice a person asked to be remembered, keyed by the folder on this computer it was made for: the next
 * add of that folder starts with those ticks rather than the catalog's own. */
export const SEED_CHOICES = "seed-choices";
/** One manifest per place and golden name: a place's own built copy of the image, keyed `<place>/<name>`. A state
 * file written before places carries it under the bare name and the boot moves it under the wired place. */
export const GOLDENS = "goldens";
/** The recipe each sealed version was built from, keyed `<place>/<name>@v<version>`; the next update diffs against the head's. */
export const GOLDEN_RECIPES = "golden-recipes";
/** One document per project golden, keyed by its snapshot id. */
export const PROJECT_GOLDENS = "project-goldens";
/** The image record the host owns, one per golden name; every copy is built from it. */
export const IMAGES = "images";
/** The one refusal for a copy build on a runtime wired without a composer for its recipe. */
export const NO_COPY_RECIPE = "this runtime cannot compose the recipe a copy builds from; the host that serves the app wires one";
/** The one refusal for a seed on a runtime the host wired no folder reader into: nothing of the person's folder is
 * read or sent by a runtime that cannot show them the menu first. */
export const NO_SEED_WIRING = "this runtime cannot read a folder on this computer, so a folder cannot seed a project elsewhere; the host that serves the app wires the reader";

/** One blob per sealed version, `<name>@v<version>`: the vault as it was taken off that version's builder. */
export const IMAGE_VAULTS = "image-vaults";
/** The one key rule for a place's copy of a golden, and for the recipe that copy was built from. */
export const copyKey = (place: string, name: string): string => `${place}/${name}`;
/** The same rule read back: the place and the golden a stored key names. A key from before places names no place,
 * and its copy is the wired one's, which only the caller knows the name of. */
export const copyKeyParts = (key: string): { place?: string; name: string } => {
  const at = key.indexOf("/");
  return at === -1 ? { name: key } : { place: key.slice(0, at), name: key.slice(at + 1) };
};
export const recipeKey = (name: string, version: number): string => `${name}@v${version}`;
export const vaultKey = recipeKey;
export const TRANSCRIPTS = "transcripts";
/** The events of a transcript an older build kept inside the state file that fell outside the byte cap as it moved to
 * a file of its own: written at the move and never trimmed, so no event the person had is lost. */
export const TRANSCRIPT_HEADS = "transcript-heads";
/** Each transcript's index, beside it: what the host keeps of a transcript it does not hold. */
export const TRANSCRIPT_INDEX = "transcript-index";
/** The images a person's messages carried, one blob each under its attachmentKey: the transcript keeps their records
 * alone, and a client that did not send one, or sent it before a restart, draws it from here. */
export const ATTACHMENTS = "attachments";
/** One document per workspace naming the images it keeps, by thread, so a thread or a workspace takes exactly its
 * own with it whatever its transcript has since trimmed. */
export const ATTACHMENT_KEYS = "attachment-keys";
/** One document per workspace: the turns sessions.list serves, read back at boot so the rows outlive the process. */
export const SESSIONS = "sessions";
/** The name a person gave a workspace, keyed by its id, which its machines carry as a label across every rebuild:
 * the sweep reads it when it records a machine whose workspace document this store lost, so a restored record keeps
 * that name rather than the one the fork stamped, which the provider takes at create and never updates. */
export const WORKSPACE_NAMES = "workspace-names";
/** The machine of every workspace deleted here, by machine id: one listed running again is the sweep's to kill, not a
 * lost record to report and leave billing. */
export const DROPPED = "dropped-machines";
/** One Solari sandbox read gone after its delete listed running again 73 minutes later (measured 2026-09-26), and a
 * durable record the provider reloads has no bound; a live record claims its machine before this set is read, so a
 * wide window costs nothing. */
export const DROPPED_WATCH_MS = 7 * 24 * 60 * 60_000;
/** One record under one id: the person's view preferences. */
export const PREFERENCES = "preferences";
export const PREFERENCES_ID = "default";
/** One record under one id: when this state file began keeping a read stamp per thread. A thread whose turn ended
 * before it reads as seen, so the stamps arriving do not mark every old thread unread at once. */
export const READS = "reads";
export const READS_ID = "since";

/** What the timeline shows as the last row of a turn the runtime ended, not the harness. */
export const PAUSED_REASON = "machine paused while the agent was working";
export const DELETED_REASON = "machine deleted while the agent was working";
export const RESTARTED_REASON = "host restarted while the agent was working";
export const GONE_REASON = "machine gone at the provider while the agent was working";
/** The host log's one line for a workspace found gone, from the road and from the record load alike. */
export const goneLogLine = (workspaceId: string, words: string): string => `workspace ${workspaceId} is gone: ${words}`;
/** The host log's one line for the runs a connecting host ended on a machine because no row of its own held them. */
export const sweptRunsLogLine = (workspaceId: string, runs: readonly string[]): string =>
  `ended ${runs.length === 1 ? "1 harness run" : `${runs.length} harness runs`} on ${workspaceId} that no thread here holds: ${runs.join(", ")}`;
/** The host log's one line for a harness store that would not give a title, said once per session until a read
 * answers. */
export const noTitleLogLine = (sessionId: string, workspaceId: string, words: string): string =>
  `no title for session ${sessionId.slice(0, 8)} on ${workspaceId}: ${words}`;
/** The host log's one line for a thread its harness would not name; the thread keeps its opening turn's words and
 * nothing asks again, so this is said once per thread. */
export const noMadeTitleLogLine = (threadId: string, workspaceId: string, words: string): string =>
  `thread ${threadId.slice(0, 8)} on ${workspaceId} keeps its opening words: ${words}`;
/** The log line for a turn's end whose checkout kept no checkpoint: the turn stands, and only its files cannot be rewound. */
export const noCheckpointLogLine = (threadId: string, workspaceId: string, words: string): string =>
  `no checkpoint of the files at thread ${threadId.slice(0, 8)}'s turn end on workspace ${workspaceId}: ${words}`;
/** The host log's one line for a name the harness's own store would not take: the thread carries the name here
 * whatever its harness did with it, so only the harness's own UI is out of step. */
export const noNameWriteLogLine = (sessionId: string, workspaceId: string, words: string): string =>
  `the harness did not take the name for session ${sessionId.slice(0, 8)} on ${workspaceId}: ${words}`;
/** What a cut turn's parent hears: the row's own span, since no harness result reports one. */
export const restartCutLine = (elapsedMs: number): string => `cut by a host restart after ${fmtDuration(elapsedMs, "clock")}`;
/** A guest with no daemon is asked again after this long (one may be deployed later). */
export const DAEMON_TOKEN_MISS_TTL_MS = 60_000;
/** Events kept per workspace; the oldest fall off so one chatty workspace cannot grow the store forever. */
export const TRANSCRIPT_CAP = 5000;
/** The bytes of JSON one workspace's transcript keeps, past which its oldest events fall off too: every transcript
 * is held in memory whole, and a turn's tool calls carry whole files, so the count alone let one workspace hold a
 * hundred megabytes. */
export const TRANSCRIPT_BYTES = 4 * 1024 * 1024;
/** The characters of one tool result a transcript keeps. Every reader of a kept result reads its first line (the
 * app's row, the terminal's line, a subagent's answer), and the live stream still carries it whole. */
export const TOOL_RESULT_KEPT = 16 * 1024;
/** The transcripts held whole after they were opened, the newest kept: reopening one of them reads no file. Every
 * other transcript is its index and the events written since its last flush. */
export const TRANSCRIPTS_HELD = 4;
/** The bytes of events written since a transcript's last flush past which it flushes without waiting for a turn
 * boundary, so a turn that streams for an hour holds no more of itself than a flushed transcript would. */
export const PENDING_FLUSH_BYTES = 1024 * 1024;
/** setTimeout's longest wait; a longer one fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** One thread's words as search reads them: its messages, the message still open, and when it last said anything. */
export interface ThreadWords {
  lines: string[];
  open: string | undefined;
  last: number;
}

/** What the host keeps of a transcript it does not hold: each thread's words for search, and the facts a send reads
 * off the transcript. Folded one event at a time in the order they were written, so it answers what a walk of the
 * whole transcript would. */
export interface TranscriptIndex {
  words: Map<string, ThreadWords>;
  /** The harness session each thread's newest start announced. */
  starts: Map<string, string>;
  /** Whether each thread's newest end came with no exit code and no result. */
  cut: Map<string, boolean>;
  /** The folder, access, model and effort each session's newest start that named one named. */
  facts: Map<string, SessionFacts>;
  /** The turn each start the transcript holds by its request id opened or joined: a start sent again under that id
   * after the host stopped under it is answered with this turn, never a second one. */
  taken: Map<string, Taken>;
  /** Each thread's subagents by the agent's id for them, in the order they started, with the turn each ran under. */
  children: Map<string, Map<string, Child>>;
  /** The newest position the transcript has issued. It never moves back, so the position of an event a delete or a
   * rewind took away is never issued again. */
  pos: number;
}

/** A subagent as the index holds it: what a listing answers, the turn whose end stops it if it is still running, and
 * when its newest start row was written, which a resumed child is held by while that row is in the ring. */
export type Child = SubagentView & { turnId?: string; startRow?: number };

export interface Taken {
  sessionId: string;
  threadId: string;
  turnId: string;
  outcome: "started" | "steered";
}

/** A transcript file that is there and did not read. Nothing is written over it, since what it holds is still in it. */
export const transcriptUnreadLine = (workspaceId: string, why: string): string => `the transcript of ${workspaceId} does not read (${why})`;

/** What a resumed session's turns carry, read off its newest start that named each. */
export const SESSION_FACTS = ["cwd", "permissionMode", "model", "effort"] as const;
export type SessionFacts = Partial<Record<(typeof SESSION_FACTS)[number], string>>;

export const emptyIndex = (): TranscriptIndex => ({ words: new Map(), starts: new Map(), cut: new Map(), facts: new Map(), taken: new Map(), children: new Map(), pos: 0 });

/** One session.subagent row into a thread's children: a start makes the child, or runs a resumed one again, and an end
 * moves one the index holds. An end whose start has left the ring finds none, so the child stays gone with it. */
export function foldChild(index: TranscriptIndex, e: Extract<SessionEvent, { type: "session.subagent" }>): void {
  if (e.threadId === undefined) return;
  const held = index.children.get(e.threadId) ?? new Map<string, Child>();
  const child = held.get(e.task);
  if (e.state === "running") {
    held.set(e.task, {
      id: e.task,
      title: e.title ?? child?.title ?? e.task,
      state: "running",
      ...((e.parentToolUseId ?? child?.parentToolUseId) !== undefined ? { parentToolUseId: e.parentToolUseId ?? child?.parentToolUseId } : {}),
      ...((e.depth ?? child?.depth) !== undefined ? { depth: e.depth ?? child?.depth } : {}),
      startedAt: child?.startedAt ?? e.at ?? 0,
      ...(e.turnId !== undefined ? { turnId: e.turnId } : {}),
      ...(e.at !== undefined ? { startRow: e.at } : {}),
    });
    index.children.set(e.threadId, held);
  } else if (child !== undefined) {
    child.state = e.state;
    child.endedAt = e.at ?? child.startedAt;
  }
}

/** A turn's end stops every child of it still running: whatever ended the turn ended them with it. */
export function endChildren(index: TranscriptIndex, threadId: string, turnId: string | undefined, at: number | undefined): void {
  for (const child of index.children.get(threadId)?.values() ?? []) {
    if (child.state !== "running" || child.turnId !== turnId) continue;
    child.state = "stopped";
    child.endedAt = at ?? child.startedAt;
  }
}

/** A row the ring dropped: a child whose start it was leaves the index with it. */
export function forgetChild(index: TranscriptIndex, e: SessionEvent): void {
  if (e.type !== "session.subagent" || e.state !== "running" || e.threadId === undefined) return;
  const held = index.children.get(e.threadId);
  if (held === undefined || held.get(e.task)?.startRow !== e.at) return;
  held.delete(e.task);
  if (held.size === 0) index.children.delete(e.threadId);
}

/** One event into an index: the person's messages and its own agent's replies by thread, a reply's pieces joined back
 * into the one message they are, and the newest start and end of each thread and session. A subagent's lines are the
 * subagent's, and a row stamped no thread names none a hit could open. */
export function foldEvent(index: TranscriptIndex, e: SessionEvent): void {
  if (e.pos !== undefined && e.pos > index.pos) index.pos = e.pos;
  if ((e.type === "session.start" || e.type === "session.steer") && e.requestId !== undefined && e.threadId !== undefined && e.turnId !== undefined) {
    index.taken.set(e.requestId, { sessionId: e.sessionId, threadId: e.threadId, turnId: e.turnId, outcome: e.type === "session.start" ? "started" : "steered" });
  }
  if (e.type === "session.start") {
    if (e.threadId !== undefined) index.starts.set(e.threadId, e.sessionId);
    const facts = index.facts.get(e.sessionId) ?? {};
    for (const fact of SESSION_FACTS) if (e[fact] !== undefined) facts[fact] = e[fact];
    index.facts.set(e.sessionId, facts);
  } else if (e.type === "session.end" && e.threadId !== undefined) {
    index.cut.set(e.threadId, e.exitCode === null && !e.sawResult);
    endChildren(index, e.threadId, e.turnId, e.at);
  } else if (e.type === "session.subagent") foldChild(index, e);
  if (e.threadId === undefined) return;
  const held = index.words.get(e.threadId) ?? { lines: [], open: undefined, last: 0 };
  index.words.set(e.threadId, held);
  held.last = Math.max(held.last, e.at ?? 0);
  if ((e.type === "session.start" && e.prompt !== undefined) || e.type === "session.steer") {
    held.lines.push(e.prompt!);
    held.open = undefined;
  } else if (e.type === "session.delta" && e.kind === "text" && e.parentToolUseId === undefined) {
    const message = `${e.turnId ?? e.sessionId}:${e.messageId ?? ""}`;
    if (held.open === message) held.lines[held.lines.length - 1] += e.text;
    else held.lines.push(e.text);
    held.open = message;
  }
}

export const indexOf = (events: readonly SessionEvent[]): TranscriptIndex => {
  const index = emptyIndex();
  for (const e of events) foldEvent(index, e);
  return index;
};
/** How much of itself a turn has written, read off its workspace's transcript, where a live turn's rows are at the
 * tail. Only these are kept, since a turn holding the transcript would hold it whole for as long as it runs. */
export interface TurnWritten {
  lines: number;
  /** The subagent rows it wrote, counted apart from the deltas: a host from before they were written counted only
   * deltas, and a run it left is re-read with every one of its subagent lines still to write. */
  subagents: number;
  /** Its compaction rows, counted apart from the deltas for the same reason. */
  compactions: number;
  reply?: TurnResult["status"];
  started: boolean;
  /** Its card is written, so a host that re-opens it writes no second one, as a reply already written stands. */
  changes: boolean;
}
export const turnWritten = (events: readonly SessionEvent[], turnId: string): TurnWritten => {
  const lastOf = <T extends SessionEvent["type"]>(type: T): Extract<SessionEvent, { type: T }> | undefined => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.type === type && e.turnId === turnId) return e as Extract<SessionEvent, { type: T }>;
    }
    return undefined;
  };
  // From the stamp the last surviving line carries rather than from how many survive: the transcript is capped per
  // workspace and drops its oldest rows, so counting them would read a turn whose head has been evicted as shorter
  // than it was and write its tail a second time.
  const lines = lastOf("session.delta")?.line ?? 0;
  const subagents = lastOf("session.subagent")?.line ?? 0;
  const compactions = lastOf("session.compacted")?.line ?? 0;
  const reply = lastOf("session.done")?.result.status;
  // A turn with a line or a reply already written had its start written too, whether or not the cap still holds it:
  // a second start row at the tail of the transcript would sit after the work it opened.
  return { lines, subagents, compactions, ...(reply !== undefined ? { reply } : {}), started: lines > 0 || subagents > 0 || compactions > 0 || reply !== undefined || lastOf("session.start") !== undefined, changes: lastOf("session.changes") !== undefined };
};

/** An index as its file holds it, with the mark of the transcript file it was read off: an index whose transcript
 * has been written since (a crash between the two writes, a failed index write) is one boot reads again, and so is
 * one that does not parse, and one written before it held the starts by request id, since the restart that brings
 * this host up is the one a send may be waiting across. */
export const indexBytes = (index: TranscriptIndex, of: BlobMark | undefined): Buffer =>
  Buffer.from(JSON.stringify({ of, words: [...index.words], starts: [...index.starts], cut: [...index.cut], facts: [...index.facts], taken: [...index.taken], children: [...index.children].map(([thread, held]) => [thread, [...held]]), pos: index.pos }));
export const indexRead = (bytes: Buffer): { index: TranscriptIndex; of?: BlobMark } | undefined => {
  try {
    const held = JSON.parse(bytes.toString("utf8")) as { of?: BlobMark; words: [string, ThreadWords][]; starts: [string, string][]; cut: [string, boolean][]; facts: [string, SessionFacts][]; taken?: [string, Taken][]; children?: [string, [string, Child][]][]; pos?: number };
    if (held.taken === undefined || held.children === undefined || held.pos === undefined) return undefined;
    const children = new Map(held.children.map(([thread, kids]) => [thread, new Map(kids)]));
    return { index: { words: new Map(held.words), starts: new Map(held.starts), cut: new Map(held.cut), facts: new Map(held.facts), taken: new Map(held.taken), children, pos: held.pos }, ...(held.of !== undefined ? { of: held.of } : {}) };
  } catch {
    return undefined;
  }
};

/** The words around a hit, on one line: a little before it and more after, an ellipsis where the text goes on. */
export function snippetAround(text: string, at: number, length: number): string {
  const from = Math.max(0, at - 40);
  const to = Math.min(text.length, at + length + 80);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}
/** Index rows kept per workspace; the oldest finished rows fall off, a running one never does. A row that falls off
 * still holding its launch's commit takes its unread card with it. */
export const SESSION_INDEX_CAP = 200;
/** A turn boundary waits this long for more before the transcript is written; measured at one put per
 * event, 5000 events cost 4 s of memory-store clones and 6.6 s of file rewrites after the last turn. */
export const TRANSCRIPT_FLUSH_MS = 250;

/** What a restore needs about a workspace that no label on its machine carries: the name as a person set it here,
 * and the project the workspace was made for. Kept beside the workspace records, so a sweep that finds a machine
 * whose record this store lost can put the record back under the same name and the same project. */
export interface NamedWorkspace {
  workspaceId: string;
  name: string;
  project?: string;
}

export interface DroppedMachine {
  machineId: string;
  at: string;
}

export interface TranscriptRecord {
  workspaceId: string;
  events: SessionEvent[];
}

/** What a live turn knows beyond its row: the status of a reply that landed while its process still ran, absent
 * until the harness's result arrives and read by every road that ends the row before the process exits. */
export interface TurnLive {
  reply?: TurnStatus;
}

/** The message a turn's agent was handed and the effort it ran at, kept beside its run while it runs: the row's own
 * prompt is the thread's opening once a later turn takes the row over, and an agent that takes its message after its
 * process starts is handed this one by a host that re-opens the run before it went. */
export interface TurnAsked {
  prompt: string;
  effort?: string;
  /** The message as the person typed it, where the agent was handed more (the paths of the files it carried): what
   * the turn's own start row shows, written by a host that re-opens a turn before its first row went. */
  typed?: string;
}

/** How long a closing host waits for the agents it kept to exit on their EOF before it lets go of reading them. */
export const KEPT_CLOSE_WAIT_MS = 2_000;

/** A thread's agent process kept up between its turns: what its launch fixed, the session it holds, the turn token and
 * device its environment carries, the box its stream reads for a turn stopped on a person, how its session file stood
 * when its last turn ended, when that was, and the cancel of the keep's own clock. */
export interface KeptProcess {
  workspaceId: string;
  agent: KeptAgent<HarnessSession>;
  launch: KeptLaunch;
  session: string;
  turnToken: string;
  scopeDeviceId?: string;
  waiting: { on: boolean };
  file?: SessionFileStamp;
  usedAt: number;
  cancel: () => void;
}

/** A launch as a kept process is matched against: what is fixed for the life of the process (the agent, the folder, the
 * MCP servers named, the binary's version and the person's setup for it), and the picks a send made. */
export interface KeptLaunch {
  fixed: string;
  picks: Readonly<Record<string, unknown>>;
}

/** Whether a send's launch is the kept one's: the same fixed part, and every pick the send names the one the process
 * runs at. A send into a thread that names no model or effort leaves the session at its own, which is the process's. */
export function launchesAs(kept: KeptLaunch, send: KeptLaunch): boolean {
  return kept.fixed === send.fixed && Object.entries(send.picks).every(([pick, value]) => kept.picks[pick] === value);
}

/** How a kept agent's session file stood when its turn ended: the path it was found at and its size, or no path where
 * the agent had written none yet. */
export interface SessionFileStamp {
  path?: string;
  size: number;
}

/** The one file under `folder` whose name ends in `name`, `depth` folders down, newest folders first. */
export function findSessionFile(folder: string, name: string, depth: number): string | undefined {
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return undefined;
  }
  if (depth === 0) {
    const file = entries.find(e => e.isFile() && e.name.endsWith(name));
    return file === undefined ? undefined : join(folder, file.name);
  }
  for (const dir of entries.filter(e => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const found = findSessionFile(join(folder, dir.name), name, depth - 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export function stampSessionFile(at: KeptAgent<unknown>["sessionFile"], known?: string): SessionFileStamp | undefined {
  if (at === undefined) return undefined;
  const path = known ?? findSessionFile(at.folder, at.name, at.depth);
  return path === undefined ? { size: -1 } : { path, size: sizeOf(path) };
}

/** Whether the session file stands as the stamp found it: the same size where one was found, still none where none
 * was. An agent that names no file is taken at its word. */
export function sameSessionFile(at: KeptAgent<unknown>["sessionFile"], stamp: SessionFileStamp | undefined): boolean {
  if (at === undefined || stamp === undefined) return true;
  const now = stampSessionFile(at, stamp.path);
  return now !== undefined && now.path === stamp.path && now.size === stamp.size;
}

/** A turn's message read back off the host's own session index, nothing where the document holds anything else. */
export function readAsked(raw: unknown): TurnAsked | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { prompt, effort, typed } = raw as Record<string, unknown>;
  return typeof prompt === "string" ? { prompt, ...(typeof effort === "string" ? { effort } : {}), ...(typeof typed === "string" ? { typed } : {}) } : undefined;
}

/** A thread scope read back off the host's own session index: the shape the runtime minted, and nothing where the
 * document holds anything else, so a line delivered after a restart is never started under a caller nobody proved. */
export function readScope(raw: unknown): ThreadScope | undefined {
  if (raw === undefined) return undefined;
  const read = ThreadScope.safeParse(raw);
  return read.success ? read.data : undefined;
}

/** The road those targets were registered from, read back the same way and for the same reason: a document
 * written before the road rode beside them carries none, and one carrying a word this protocol does not know
 * carries nothing, so a line delivered after a restart starts under no road nobody wrote. */
export function readRoad(raw: unknown): WorkspaceOrigin | undefined {
  if (raw === undefined) return undefined;
  const read = WorkspaceOrigin.safeParse(raw);
  return read.success ? read.data : undefined;
}

/** A thread's own record: the agent it runs on and the access it is at, written at its first turn and moved by the
 * access verb alone. The rows are capped at SESSION_INDEX_CAP per workspace and the transcript at TRANSCRIPT_CAP
 * events, while a thread keeps its agent and its access for its whole life, so both are read here first and off
 * the rows only for a thread from before the record existed. */
export interface ThreadRecord {
  harness: string;
  permissionMode?: string;
  /** When a window last showed the thread and when the person settled it, ms epoch; kept here rather than on a row,
   * since every row of the thread shares them and a row falls off the cap while the thread lives on. */
  readAt?: number;
  settledAt?: number;
  /** The person's marks on the thread, kept here for the same reason; snoozedUntil is kept after it passes, since
   * the thread reads Done off it until a window shows it. */
  pinnedAt?: number;
  snoozedUntil?: number;
  section?: ThreadPlacement;
  /** The anchor a rewind kept, held until the next turn of a harness that cuts on its next resume has taken it. */
  resumeAt?: string;
  /** Resume at reset, armed on the turn a usage limit stopped: the reset it goes on at, ms epoch, and that turn's id,
   * so a newer turn leaves it nothing to resume. */
  limitResume?: { at: number; turnId: string };
  /** The checkpoint of the files as they stood before the last rewind that moved them, which Undo rewind restores,
   * held until the thread's next turn ends. */
  rewound?: { before: string; at: number };
  /** The folders this thread's attached files landed in, which a forget of the thread or a delete of its workspace
   * takes them off. */
  filesIn?: string[];
  /** Whether a turn of the thread did work, by threadRan's rule, kept here because the rows that say so fall off the
   * cap. Absent reads as worked, so a record that never said is never taken for a thread that ran nothing. */
  worked?: boolean;
}

export interface SessionIndexRecord {
  workspaceId: string;
  /** The files a person marked viewed, by path, against the blob id each had then. */
  viewed?: Record<string, string>;
  /** reply is the held status of a turn whose result landed while its process still ran, on a row still running;
   * run is where that turn is on its machine, so a host that comes back re-opens it rather than failing it, and
   * turnToken is what that surviving process still has in its environment, so the host that re-opens it can answer
   * for it; from is where the turn starts in that run's log, on a process that served the thread's earlier turns. All
   * of these are written for a running row alone. snapshot is the commit the turn's launch took of its
   * folder, which the turn's changes are read against wherever it ends; written while the turn runs and until that
   * read is in. */
  sessions: (SessionView & { turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; reply?: TurnStatus; run?: string; from?: number; asked?: TurnAsked; turnToken?: string; scopeDeviceId?: string; snapshot?: string })[];
  /** Every thread of the workspace by its runtime id; absent on a document from before threads had a record. */
  threads?: Record<string, ThreadRecord>;
}

/** Builders live apart from workspaces: never in the rail, and a record left
 * by a crashed wizard is exactly what reap() sweeps. */
export const BUILDERS = "builders";
/** One id per state file, stamped on every machine it creates so another host's sweep can tell them apart from its own. */
export const OWNER = "owner";
/** The create attempt in flight for a record, written before the provider hears of it. */
export const CREATES = "creates";
/** The provider caps a key at 255 characters (measured 2026-09-04); the purpose is hashed past what a 16-hex nonce leaves. */
export const KEY_PURPOSE_MAX = 255 - 17;
export interface PendingCreate {
  key: string;
  createdAt: string;
  /** The request's fingerprint: a changed request is a new attempt, never a replay of the old one. */
  body: string;
  host: string;
  pid: number;
}

/** The spec minus what is minted per attempt, so the same request from two attempts reads the same. */
export function fingerprint(spec: MachineSpec): string {
  const { idempotencyKey, labels, ...rest } = spec;
  const { [CREATED_AT_LABEL]: stamp, ...stamped } = labels ?? {};
  void idempotencyKey;
  void stamp;
  return createHash("sha256").update(JSON.stringify({ ...rest, labels: stamped })).digest("hex");
}
/** A holder's heartbeat older than this, or a holder whose pid is gone, no longer keeps a builder from another process. */
export const HELD_TTL_MS = 15 * 60_000;
/** Own builders beat this often on their own timer, so a sweep stuck on a slow listing cannot starve the hold. */
export const HEARTBEAT_MS = 5 * 60_000;

export const isCapRefusal = (e: unknown): boolean => (e as { kind?: unknown }).kind === "concurrency";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

export interface BuilderRecord {
  id: string;
  name: string;
  kind: MachineKind;
  baseTemplate: string;
  setupSha: string;
  createdAt: string;
  size: WorkspaceSize;
  streamUrl?: string;
  /** True from creation until the machine is ever paused, resumed or restored. Whether a builder that lost it can
   * still be sealed is the place's own rule, read off its backend (`snapshotsAnyLife`), never assumed here. */
  firstLife: boolean;
  /** The process using this builder: written at creation and attach, refreshed every sweep, cleared on close.
   * Another process over the same store leaves the record alone while the holder is alive and the heartbeat fresh. */
  heldBy?: { host: string; pid: number; heartbeat: string };
  /** Written the moment the machine exists, before any stage runs, and dropped when prepare finishes; a
   * record still marked by a dead holder never completed its setup and can never seal. */
  building?: true;
  /** What of the recipe this builder carries; a prepare with the same recipe hash reuses it. */
  import?: ImportLedger;
  /** The base tools read on this builder, or on the golden it was forked from; the version it seals records them. */
  base?: GoldenBaseTool[];
  /** Saved as this version and kept running since; an update of that version lands on it, the sweep stops it at GRACE_MS. */
  sealed?: { at: string; version: number };
  /** The place this builder was made at, so a provider swapped in mid-build never becomes where it seals. Absent,
   * on a record from before places, reads as the wired place. */
  place?: string;
}

export interface LiveBuilder {
  record: BuilderRecord;
  builder: Builder;
  /** Whether a seal can still be taken from it: its machine's first life, or a place whose copy of a disk is the
   * disk as it stands. What `life` is derived from and what the builder's view carries. */
  sealable: boolean;
  /** own: made or attached to by this process. reusable: an earlier process's record, marked and running,
   * wearing this owner's label or none; the sweep ages it out at six hours. stale: an earlier record that
   * can never seal; the sweep stops it. foreign: wears another state file's label; never touched.
   * held: another live process is using it; never touched while its heartbeat is fresh. Read once at load: a
   * host that runs on keeps what it read, and host.lock keeps a second init from starting beside it. */
  life: "own" | "reusable" | "stale" | "foreign" | "held";
  reach?: PreviewReach;
  /** The recipe the prepare that made or attached to it carried, when it named one; the seal reads it back. */
  recipe?: GoldenRecipe;
}

/** What prepare rejects with once its signal aborted. `builderId` is the machine it had, when one existed: killed
 * by its recorded id and its record dropped, unless `kept` (attached to, a seal still in it, hold released,
 * record left reusable) or `left` (the kill failed for this reason and the record stays for the sweep). */
export class PrepareStoppedError extends Error {
  readonly builderId?: string;
  readonly kept: boolean;
  readonly left?: string;
  constructor(builderId?: string, outcome?: { kept: true } | { left: string }) {
    const kept = outcome !== undefined && "kept" in outcome;
    const left = outcome !== undefined && "left" in outcome ? outcome.left : undefined;
    super(
      builderId === undefined
        ? "prepare stopped before a machine existed"
        : kept
          ? `prepare stopped; builder ${builderId} left running with a seal still in it`
          : left === undefined
            ? `prepare stopped; builder ${builderId} killed`
            : `prepare stopped; builder ${builderId} did not stop: ${left}`,
    );
    this.name = "PrepareStoppedError";
    if (builderId !== undefined) this.builderId = builderId;
    this.kept = kept;
    if (left !== undefined) this.left = left;
  }
}

/** Stand-in for a machine that vanished while we were away; resume() failing with
 * kind "missing" is what a wake settles gone on. */
export function deadMachine(id: string): Machine {
  const gone = () => Object.assign(new Error(`machine ${id} is gone`), { kind: "missing", status: 404 });
  return {
    id,
    kind: "sandbox",
    streamUrl: undefined,
    exec: async () => {
      throw gone();
    },
    run: async () => {
      throw gone();
    },
    snapshot: async () => {
      throw gone();
    },
    pause: async () => {
      throw gone();
    },
    resume: async () => {
      throw gone();
    },
    kill: async () => {},
    state: async () => "gone",
    downloadUrl: async () => {
      throw gone();
    },
    uploadUrl: async () => {
      throw gone();
    },
  };
}

/** The mark a stand-in for an absent place's machine carries, so the one reading of "nothing about this machine is
 * known yet" is a fact of the handle rather than a guess from the record's phase. */
export const ABSENT = Symbol("absent machine");

/** Whether this handle is that stand-in. */
export const isAbsentMachine = (m: Machine): boolean => (m as { [ABSENT]?: boolean })[ABSENT] === true;

/** The machine a record nothing can be asked about is held by until whatever is missing comes back: the place it
 * stands on dialling in again, or the provider key this host was started without. Nothing about it is known right
 * now and nothing is asked, so the row reads unreachable with the sentence of whatever is away and the provider is
 * asked nothing. The refusal is the caller's, since the two are not the same sentence and neither is a guess. */
export function absentMachine(id: string, kind: MachineKind, away: () => never): Machine {
  const machine: Machine = {
    id,
    kind,
    streamUrl: undefined,
    exec: async () => away(),
    run: async () => away(),
    snapshot: async () => away(),
    pause: async () => away(),
    resume: async () => away(),
    kill: async () => away(),
    state: async () => away(),
    downloadUrl: async () => away(),
    uploadUrl: async () => away(),
  };
  return Object.assign(machine, { [ABSENT]: true });
}

/** Reads at most `cap` bytes of the body and cancels the rest; a body that dies mid-read still leaves the status to report. */
export async function readBodyUpTo(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch {
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, Math.min(size, cap)).toString("utf8");
}

/** The calls a backend carries only when its provider has them. One list, so a handle built out of a backend
 * forwards every one of them rather than naming the few a road happened to need. */
export const OPTIONAL_BACKEND_CALLS = ["checkKey", "listSnapshots", "promoteSnapshot", "getTemplate", "listTemplates", "deleteTemplate"] as const;

/** Those calls bound to the backend, for a handle that stands in front of it. A backend is a module with its
 * methods on its prototype, so a spread of it carries none of them; each one is taken by name here. */
export function forwardedCalls(backend: MachineBackend): Partial<MachineBackend> {
  const out: Record<string, unknown> = {};
  for (const name of OPTIONAL_BACKEND_CALLS) {
    const call = backend[name];
    if (typeof call === "function") out[name] = call.bind(backend);
  }
  return out as Partial<MachineBackend>;
}

/** What a daemon refused a frame with, the code beside the sentence: a caller branches on the reason rather than
 * on the words, which is what the code is for. */
export class DaemonRefusal extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DaemonRefusal";
  }
}

/** Whether a refusal is the one a bring back carries as a note: the push landed and the machine has no signed-in
 * command line for the git host, so there is a branch on the remote and no pull request. */
export const isNoHostCli = (e: unknown): boolean => e instanceof DaemonRefusal && e.code === "no-host-cli";
export const isNoGitCredential = (e: unknown): boolean => e instanceof DaemonRefusal && e.code === "no-git-credential";

/** The one place a workspace's kind means anything: the module that answers for machines of that kind. The backend
 * that holds the machine, how a turn's process is launched on it, where each harness keeps its sessions there, the
 * environment a turn runs under, and whether a request relayed from a machine may drive it. Every other road asks
 * the module for a capability or a fact; nothing else compares the kind. Adding a kind is a row here and its
 * wiring, nothing more. */
export interface KindModule {
  /** The backend the machine of one record lives on. A function of the record because a fork can stand at this
   * host's own provider or on a computer somebody joined, and which one is a fact of that record rather than of
   * its kind: everything else a fork meets is the same either way, since the two are the same interface. */
  backend: (record: WorkspaceRecord) => MachineBackend;
  /** How a turn's process is launched on this workspace's machine, under the limits the registry hands every turn. */
  execStream: (entry: LiveWorkspace, opts?: MachineExecOptions, waiting?: TurnWaiting) => ExecStreamFactory;
  /** Refuses a folder's record on this kind before it is written, where nothing a thread there does would run as it
   * should; absent on a kind that takes every folder. */
  admitFolder?: (record: Pick<WorkspaceRecord, "kind" | "place" | "name">) => Promise<void>;
  /** The folder a turn and a command start in on this kind when the caller names none; undefined leaves it to the
   * machine's own road, which for a guest is the home the login shell lands in. A reading of the record, since a
   * workspace on this computer is the copy its record names. */
  folder: (record: WorkspaceRecord) => string | undefined;
  /** Where the harness keeps its sessions on this workspace's machine: a fixed folder on a kind whose machines
   * wsp makes alike, the record's own on a machine that already existed and answered with its home. */
  home: (entry: LiveWorkspace, agentId: string) => string;
  /** The machine's own home, published on the view so a client shortens a folder under it to ~; undefined where
   * the kind has not read one. */
  homeDir: (record: WorkspaceRecord) => string | undefined;
  /** The login environment a turn of one harness runs under there, read the same way. */
  env: (entry: LiveWorkspace, agentId: string) => Readonly<Record<string, string>>;
  /** Whether a login of this agent's own stands where this workspace runs, which decides whether the vault's key
   * is handed to a turn at all: a harness reads a key in its environment ahead of the login on its disk, so
   * handing one where a person signed in would bill the key and leave that login unused. Where a login lives is
   * the kind's own: a computer somebody joined listed what it holds, this computer is read on its own disk, and
   * an image never carries one. */
  loginStands: (entry: LiveWorkspace, agentId: string) => boolean;
  /** How a folder on this computer gets onto a machine of this kind: packed and landed on a fork, its path recorded
   * with nothing copied on this computer, refused where no road exists yet. Answers what landed, which carries the
   * project the record gains, and the done line; the caller keeps the record and the roots file, which every road
   * shares. */
  import: (entry: LiveWorkspace, o: ProjectImportOptions, report: ImportReport) => Promise<ImportLanded>;
  /** Names the project folders the machine's daemon may browse beside its home, where the kind has a daemon. */
  roots: (entry: LiveWorkspace, dests: readonly string[]) => Promise<void>;
  /** Puts this workspace's project inside it, the step between the machine answering and the workspace being
   * ready: a kind that forks clones the repo into the fork. A throw ends the create as any failed stage does. */
  landProject: (entry: LiveWorkspace, project: ProjectView, report: StageReport) => Promise<void>;
  /** What one agent on this workspace keys its sessions and its memory to, where the kind has an answer: on a
   * computer whose workspaces are copies of a folder, the original folder's own key, so every copy and the
   * person's own terminal in that folder share one memory. Nothing where the folder a turn runs in is the key,
   * which is every machine wsp makes. */
  memoryKey: (entry: LiveWorkspace, agentId: string) => string | undefined;
  /** Whether a request relayed from a machine may drive this workspace; a local one answers only this computer,
   * and so does a machine of another kind whose dial names this computer. The machine id is absent on the one
   * road that asks before a machine exists, a fork's create, where only the kind can answer. */
  relayed: (machineId: string | undefined) => boolean;
  /** How wsp itself is run on this kind's machine, for the tools a turn's own agent is given: a fork runs the
   * binary the daemon deploy lands, this computer runs the command the host itself was started as, and a kind wsp
   * puts nothing on answers none, which leaves that kind's turns without the tools. Neither line names a host:
   * the tools read the pair the launch left in the agent's environment, as the wsp a turn's shell runs does. */
  wspMcp: (entry: LiveWorkspace) => McpServerSpec | undefined;
  /** How a turn on this workspace's machine reaches this host, which the kind answers because it is a fact about
   * its machines: a fork's wsp is its daemon's and rides the link this host already holds, so it dials no address,
   * and a turn beside the host dials its loopback. None leaves that turn without a token, since one with nowhere
   * to go opens nothing. */
  turnReach: (entry: LiveWorkspace) => { url?: string } | undefined;
  /** The road a turn on this kind's machine reaches this host by, written on the token minted into it and
   * stamped on every request that token makes: a machine's is relayed, and this computer's is here. */
  turnRoad: ScopedRoad;
  /** Whether a thread's agent process is kept up between its turns here, for the next send to skip its boot: on the
   * computer the host runs on, and on no machine, where a 4 GB box holds two threads' agents already. */
  keepsAgents: boolean;
  /** Whether this machine's daemon can be dialled at all, asked before a road is opened so nothing mints a preview
   * route to find out: a cloud fork needs one, this computer's daemon is on it. Read as truthy, the way the reach
   * word and the status poller read it before this seam existed. */
  hasDaemon: (entry: LiveWorkspace) => boolean;
  /** Whether every workspace of this kind dials the one daemon of the computer the host runs on, which cannot tell
   * one workspace's processes from another's: a channel's ports.watch then names the workspace's own. A cloud
   * fork's daemon is its workspace's alone. */
  sharedDaemon: boolean;
  /** The road to this machine's daemon: where it listens, when the route expires and the token that opens it. A
   * cloud fork's preview route with the token this runtime wrote on the guest; this computer's loopback daemon
   * with the token it holds in memory. Throws with the backend's own words when the machine has no road, which
   * is every time on a kind whose daemon this host cannot prove it is the one dialled. */
  daemonRoad: (entry: LiveWorkspace) => Promise<DaemonReachView>;
  /** The folder on the machine wsp writes its own working files in: a run's script and log, an import's parts.
   * A machine wsp made is wsp's whole, so its shared temporary folder is fine; on a machine somebody owns that
   * folder belongs to every account on it, and one of them could sit on a name wsp is about to write. */
  scratch: (entry: LiveWorkspace) => string;
  /** What comes off the machine when a workspace of this kind is dropped: on a machine the person owns, the
   * daemon and everything wsp kept beside it; nothing on a kind whose machine goes with the delete. The machine
   * itself is the delete's own business; this is only what wsp put on it. */
  dropped: (entry: LiveWorkspace) => Promise<void>;
  /** Which daemon this machine is running, or null where nothing can say: a fork announces it in its hello, a
   * machine the person owns carries what this host put there on its record, and this computer runs its daemon
   * in this process. What the sync compares against the version this wsp would deploy. */
  daemonVersion: (entry: LiveWorkspace) => Promise<number | null>;
  /** Starts another daemon in place of one that is not running, where this host holds the process itself. Only
   * the workspace that is this computer has such a daemon; every other kind's runs on a machine this host can
   * reach but does not hold, and the sentence a caller gets there says so. */
  restartDaemon?: (entry: LiveWorkspace) => Promise<void>;
  /** Puts this runtime's daemon on the machine, replacing one already there. Absent where nothing can: this
   * computer runs its daemon in this process, a host that wired no bundle has none, and a backend that neither
   * mints a signed URL nor carries bytes itself has no road for one. Every road that offers to deploy reads
   * whether this is here, so none offers where another would refuse. */
  deployDaemon?: (entry: LiveWorkspace) => Promise<void | string>;
}
export type ImportReport = (stage: ProjectImportStage, message: string, progress?: { bytes: number; total: number }) => void;
export interface ImportLanded {
  result: ProjectImportResult;
  done: string;
}

/** What the two rules a request is read against need of a workspace: what a record holds, and what a create is
 * checked with before there is a record. */
export type WorkspaceLike = { id?: string; kind: WorkspaceKind; name: string; machineId?: string; rootThreadId?: string; project?: string; worktree?: WorktreeFolder };

/** One build stage as its frame carries it, with nothing of the stream around it: what a gap in a link replays. */
export interface StageFrame {
  name: string;
  stage: GoldenStage;
  detail?: string;
  step?: GoldenStep;
  left?: string[];
}

/** One workspace's kept images, by thread: the key each one's bytes are a blob under, and its type. */
export type KeptImages = { threads: Record<string, { key: string; mediaType: string }[]> };

/** A child's start as its lead's copy answered it: the branch the child's work goes back into, whether its copy has
 * to be put on that branch after it is made, and the lines the fork says. */
export interface ChildStart {
  base: string | undefined;
  onLeads: boolean;
  lines: string[];
}

/** Keyed by the workspace and holding the machine it was about, so a machine replaced under the record inherits nothing. */
export type MachineMoment = { machineId: string; at: number };

export type StoredBuilder = Omit<BuilderRecord, "size" | "firstLife"> & { size?: WorkspaceSize; firstLife?: boolean };

export type LiveSession = { view: SessionView; turnId: string; handle: SessionHandle; turnLive?: TurnLive };

/** What re-opening a turn the store left running came to. `attached` is a reader on the run again and the thread
 * goes on; `gone` is the machine's own answer that it no longer holds the run, the one answer that ends the turn;
 * `unreached` is a machine that said nothing for the whole reach window, which says nothing about the run, so the
 * row is left running for the poll that watches machines to settle if the machine really is away; `cannot` is a
 * run this host has no road to at all, and the row reads as a turn the restart cut. */
export type Reopened = "attached" | "gone" | "unreached" | "cannot";

export type SessionEntry = { view: SessionView; turnId: string; notify?: readonly string[]; notifyBy?: ThreadScope; notifyRoad?: WorkspaceOrigin; turnToken?: string; scopeDeviceId?: string; handle?: SessionHandle; end?: (reason: string) => void; turnLive?: TurnLive; run?: string; from?: number; asked?: TurnAsked; snapshot?: string; pid?: number; launch?: Promise<void>; calls?: Map<string, { toolName: string; input: string }> };
