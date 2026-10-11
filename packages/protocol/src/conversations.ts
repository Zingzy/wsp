// SPDX-License-Identifier: AGPL-3.0-only
// The conversations an agent kept on a computer outside wsp, which a person can pick up as a thread: one row per
// conversation as the agent's own store tells it, what an adapter reads them with (ConversationStore), and the words
// every road says them in. The app says conversation where the agent's own word is session.
import { z } from "zod";
import { refusalLine } from "./words/thread.js";
import type { HarnessExec } from "./adapter-port.js";

/** Who opened a conversation, as its agent's store says: the person in a terminal or an editor, wsp, or a script. */
export const ConversationOrigin = z.enum(["terminal", "wsp", "script"]);
export type ConversationOrigin = z.infer<typeof ConversationOrigin>;

/** One conversation in a project's folder or one of its worktrees. `lastAt` is ms epoch, `bytes` the size of the file
 * the agent keeps it in where that was read; `live` says a process outside wsp holds it open now; `thread` is the wsp
 * thread that already runs on it; `letsGo` says, in the agent's own sentence, that it refuses a second writer and
 * how soon it lets go of a closed one, so trying again later is an answer. */
export const OutsideConversation = z.object({
  agent: z.string(),
  id: z.string(),
  title: z.string(),
  firstPrompt: z.string().optional(),
  branch: z.string().optional(),
  cwd: z.string(),
  lastAt: z.number(),
  bytes: z.number().optional(),
  origin: ConversationOrigin,
  live: z.boolean(),
  thread: z.string().optional(),
  letsGo: z.string().optional(),
});
export type OutsideConversation = z.infer<typeof OutsideConversation>;

/** One agent whose conversations were not read, in two halves. */
export const ConversationsHeld = z.object({ agent: z.string(), said: z.string(), fix: z.string() });
export type ConversationsHeld = z.infer<typeof ConversationsHeld>;

/** A project's conversations, newest first, and the agents whose store did not answer. */
export const ConversationsAnswer = z.object({ rows: z.array(OutsideConversation), held: z.array(ConversationsHeld) });
export type ConversationsAnswer = z.infer<typeof ConversationsAnswer>;

/** What a start names to pick one up: the agent's id for it, and whether the thread runs on a copy of it. */
export const ResumeAsk = z.object({ id: z.string().min(1).max(200), copy: z.boolean().optional() });
export type ResumeAsk = z.infer<typeof ResumeAsk>;

/** One row of a conversation's earlier messages: the person's, the agent's, or one tool call by the agent's own name
 * for the tool with its input as text. */
export interface ConversationLine {
  who: "person" | "agent" | "tool";
  text: string;
  tool?: string;
}

/** A conversation as an adapter reads it off its agent's store; the runtime adds what only wsp knows. */
export interface StoredConversation {
  id: string;
  title: string;
  firstPrompt?: string;
  branch?: string;
  cwd: string;
  lastAt: number;
  bytes?: number;
  origin: ConversationOrigin;
}

/** The earlier conversation a thread opens with: where it ran, its name, its newest messages and how many came before. */
export interface ConversationEarlier {
  cwd?: string;
  title?: string;
  lines: ConversationLine[];
  earlier: number;
}

/** How an adapter reaches the computer the store is on: one shell line, or one frame to its daemon. */
export interface ConversationRoad {
  exec: HarnessExec;
  ask: (frame: { op: string } & Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** An agent's own store of conversations, read on the project's computer. `list` answers the conversations whose
 * recorded folder is one of `cwds`; `live` the ids a running process holds now, null where nothing could say;
 * `stamp` a few words that change when a conversation is added to the folders' store, read without starting the agent;
 * `earlier` one conversation's newest messages, gone where the store holds no such id, and open where `probe` asked it
 * and another process is writing it. `letsGo` says the agent refuses a second writer and lets go of a closed one,
 * and how soon, in a sentence. */
export interface ConversationStore {
  list(cwds: readonly string[], road: ConversationRoad): Promise<StoredConversation[]>;
  live?(road: ConversationRoad): Promise<ReadonlySet<string> | null>;
  stamp?(cwds: readonly string[], road: ConversationRoad): Promise<string>;
  earlier(id: string, o: { cwds: readonly string[]; last: number; probe: boolean }, road: ConversationRoad): Promise<ConversationEarlier | "gone" | "open">;
  readonly letsGo?: string;
}

/** A store read that fails the same way until something changes on the computer, the agent not installed there; a
 * list kept with one answers the visits of its minute, where any other failure is read again on the next visit. */
export const lastingStoreError = (message: string): Error => Object.assign(new Error(message), { lasting: true });
export const isLastingStoreError = (e: unknown): boolean => e instanceof Error && (e as { lasting?: unknown }).lasting === true;

/** A line per folder, each a shell word: its mtime in seconds and how many names it holds, blank where it is not
 * there; GNU stat, then BSD's. A transcript or rollout added moves its folder, one appended to does not. */
export const foldersStampCommand = (folders: readonly string[]): string =>
  `for d in ${folders.join(" ")}; do printf '%s %s\\n' "$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null)" "$(ls -A "$d" 2>/dev/null | wc -l)"; done`;

/** How many of a conversation's newest messages a thread opens with. */
export const EARLIER_MESSAGES = 200;

/** The kind a start carries when the conversation is open in another app, which the app answers with its confirm. */
export const CONVERSATION_OPEN_KIND = "conversation-open";

export const CONVERSATION_WORDS = {
  menu: "Resume a conversation...",
  row: "Resume a conversation",
  search: "Search conversations...",
  openProjectFirst: "Open a project first",
  empty: "No Claude Code or Codex conversations in this folder.",
  noMatch: "No matching conversations.",
  live: "Open in another app",
  thread: "Already a thread",
  startFresh: "Start fresh",
  send: "Continue",
  copy: "Continue in a copy",
  tryAgain: "Try again",
  cancel: "Cancel",
  group: (project: string): string => `Conversations in ${project}`,
  reading: (computer: string): string => `Reading conversations on ${computer}`,
  inFolder: (n: number): string => `${n} in this folder`,
  continues: (title: string, copy: boolean): string => (copy ? `Continues a copy of ${title}` : `Continues ${title}`),
  openTitle: (title: string, computer: string): string => `${title} is open in another app on ${computer}`,
  openNote: (letsGo: string | undefined): string =>
    letsGo === undefined ? "Continuing it here too would split it. Continue in a copy, or close it there first." : `Continue in a copy, or close it there and try again. ${letsGo}`,
  heldRow: (agent: string): string => `${agent} conversations`,
  heldNote: (computer: string): string => `Update ${computer} to list them`,
} as const;

/** The line that stands for the messages a thread did not open with. */
export const earlierLine = (count: number, agent: string): string => `${count} earlier ${count === 1 ? "message stays" : "messages stay"} in ${agent}'s own history`;

export const conversationOpenLine = (title: string, computer: string): string => `${CONVERSATION_WORDS.openTitle(title, computer)}, so continuing it here would split it`;
export const conversationOpenFix = (letsGo: string | undefined): string => `Continue in a copy with --copy, or close it there and try again.${letsGo === undefined ? "" : ` ${letsGo}`}`;
/** A turn the agent would not open because another process writes the conversation, in two halves. */
export const conversationWrittenElsewhereLine = (agent: string, letsGo: string | undefined): string =>
  refusalLine(`${agent} is writing this conversation in another app, so this turn did not run`, `Close it there and send again.${letsGo === undefined ? "" : ` ${letsGo}`}`);
export const conversationGoneLine = (agent: string, id: string, computer: string): string => `${agent} holds no conversation ${id} on ${computer} any more`;
export const CONVERSATION_GONE_FIX = "Pick one that is still there from wsp conversations.";
export const conversationIsThreadLine = (id: string, thread: string): string => `conversation ${id} is thread ${thread.slice(0, 8)} already`;
export const conversationIsThreadFix = (thread: string): string => `Send into it with wsp send ${thread.slice(0, 8)}.`;
export const noConversationsLine = (agent: string): string => `wsp cannot pick up ${agent} conversations`;
export const NO_CONVERSATIONS_FIX = "Resume a Claude Code or Codex conversation.";
export const RESUME_WHERE_LINE = "a resumed conversation runs where it ran, so --resume takes no --branch, --cwd or --beside";
export const RESUME_WHERE_FIX = "Leave --branch, --cwd and --beside off; the thread opens in the folder the conversation ran in.";
export const RESUME_A_THREAD_LINE = "--resume opens a thread, so it does not go to one that is already open";
export const RESUME_A_THREAD_FIX = "Start a thread on the conversation with wsp run --resume <id>, or send into the open one without it.";
export const RESUME_HERE_LINE = "--resume picks up a conversation on the project's own computer, and this project's threads run on machines wsp makes for them";
export const RESUME_HERE_FIX = "Name a project on this computer or on a box.";
export const COPY_ALONE_LINE = "--copy copies the conversation --resume names, so it goes with --resume";
export const COPY_ALONE_FIX = "Add --resume <id>, or leave --copy off.";
export const conversationsUnreadLine = (agent: string, computer: string): string => `${agent} conversations on ${computer} were not read`;
export const conversationsUpdateFix = (computer: string): string => `Update ${computer} with wsp add ${computer} --update to list them.`;
