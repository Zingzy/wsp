// SPDX-License-Identifier: AGPL-3.0-only
import { CATALOG_AGENTS } from "@wsp/catalog";
import { harnessExec } from "@wsp/engine";
import {
  CONVERSATION_GONE_FIX,
  CONVERSATION_OPEN_KIND,
  EARLIER_MESSAGES,
  NO_CONVERSATIONS_FIX,
  RESUME_WHERE_FIX,
  RESUME_WHERE_LINE,
  conversationGoneLine,
  conversationIsThreadFix,
  conversationIsThreadLine,
  conversationOpenFix,
  conversationOpenLine,
  conversationsUnreadLine,
  conversationsUpdateFix,
  copiesFolder,
  earlierLine,
  noConversationsLine,
  refusal,
  toolActivityLine,
  toolDoneLine,
  unknownOpLine,
  type Caller,
  type ConversationRoad,
  type ConversationStore,
  type ConversationsAnswer,
  type ConversationsHeld,
  type DaemonFrame,
  type OutsideConversation,
  type ResumeAsk,
} from "@wsp/protocol";
import type { ConversationsArea, RuntimeContext } from "../context.js";
import type { LiveWorkspace } from "../types/wiring.js";
import type { OutsideOpening } from "../types/api.js";

/** How long one read of an agent's store on the project's computer may take: a list pages a few times. */
const STORE_EXEC_MS = 30_000;

export function conversationsArea(ctx: RuntimeContext): ConversationsArea {
  const { sessions, transcriptIndex } = ctx;

  /** Every agent session a wsp thread ran, by the thread it is: the rows in memory and each transcript's newest start. */
  const wspSessions = (): Map<string, string> => {
    const mine = new Map<string, string>();
    for (const index of transcriptIndex.values()) for (const [thread, session] of index.starts) mine.set(session, thread);
    for (const s of sessions.values()) if (s.view.claudeSessionId !== undefined && s.view.threadId !== undefined) mine.set(s.view.claudeSessionId, s.view.threadId);
    return mine;
  };

  const roadOf = (entry: LiveWorkspace): ConversationRoad => ({
    exec: harnessExec(entry.machine, STORE_EXEC_MS),
    ask: frame => ctx.withDaemon(entry, ask => ask(frame as DaemonFrame)),
  });

  /** The folders a project's conversations ran in: the project folder, and on this computer every worktree of its
   * repository git lists and every one wsp holds a record of. */
  const foldersOf = async (entry: LiveWorkspace): Promise<string[]> => {
    const project = ctx.projectHeld(entry.record.project);
    const top = project.git?.top;
    const trees = copiesFolder(entry.record.kind) && top !== undefined ? (await ctx.worktreesOf(top)).map(w => w.path) : [];
    const held = ctx.foldersOf(project.id).flatMap(e => (e.record.worktree !== undefined && e.record.worktree.gone !== true ? [e.record.worktree.path] : []));
    return [...new Set([project.path, ...trees, ...held])];
  };

  /** The agents a computer can list conversations for: every agent with an adapter that reads a store, and not turned off there. */
  const storesOn = (entry: LiveWorkspace, agent: string | undefined): { harness: string; store: ConversationStore }[] =>
    CATALOG_AGENTS.flatMap(a => {
      if ((agent !== undefined && a.id !== agent) || ctx.adapters[a.id] === undefined || ctx.agentOff(entry, a.id)) return [];
      const store = ctx.adapterFor(entry, a.id).adapter.conversations;
      return store === undefined ? [] : [{ harness: a.id, store }];
    });

  /** A store read that a daemon from before the op cannot answer, read as the update that computer needs. */
  const unreadOf = (e: unknown, entry: LiveWorkspace, harness: string): ConversationsHeld | undefined => {
    const said = e instanceof Error ? e.message : String(e);
    if (!said.startsWith(unknownOpLine(""))) return undefined;
    const computer = ctx.computerOf(entry);
    return { agent: harness, said: conversationsUnreadLine(ctx.agentLabel(harness), computer), fix: conversationsUpdateFix(computer) };
  };

  const list = async (o: { project?: string; agent?: string }, origin?: Caller): Promise<ConversationsAnswer> => {
    const { entry } = await ctx.folderFor(o.project !== undefined ? { project: o.project } : {}, origin);
    const stores = storesOn(entry, o.agent);
    if (o.agent !== undefined && stores.length === 0) throw refusal(noConversationsLine(ctx.agentLabel(o.agent)), NO_CONVERSATIONS_FIX, "usage");
    const cwds = await foldersOf(entry);
    const road = roadOf(entry);
    const mine = wspSessions();
    const held: ConversationsHeld[] = [];
    const rows: OutsideConversation[] = [];
    await Promise.all(
      stores.map(async ({ harness, store }) => {
        const [listed, live] = await Promise.all([
          // An agent whose store did not answer leaves the others' rows standing: a daemon too old for the read says
          // so in a line; an agent that is not there, or answered nothing, is logged and listed as having none.
          store.list(cwds, road).catch((e: unknown) => {
            const unread = unreadOf(e, entry, harness);
            if (unread !== undefined) held.push(unread);
            else console.warn(`the ${ctx.agentLabel(harness)} conversations on ${ctx.computerOf(entry)} were not read: ${e instanceof Error ? e.message : String(e)}`);
            return [];
          }),
          store.live?.(road) ?? Promise.resolve(null),
        ]);
        for (const row of listed) {
          const thread = mine.get(row.id);
          const reached = thread === undefined ? undefined : ctx.latestOn(thread);
          // A script's conversation is nobody's to pick up, unless it is a wsp thread's.
          if (row.origin === "script" && thread === undefined) continue;
          rows.push({
            agent: harness,
            ...row,
            origin: thread !== undefined ? "wsp" : row.origin,
            live: thread === undefined && live?.has(row.id) === true,
            ...(reached !== undefined && ctx.reachesRow(reached, origin) ? { thread } : {}),
            ...(store.letsGo !== undefined ? { letsGo: store.letsGo } : {}),
          });
        }
      }),
    );
    rows.sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id));
    return { rows, held };
  };

  /** The earlier rows as the thread's transcript holds them: the count of what is left out first, each call as its line. */
  const earlierRows = (lines: { who: "person" | "agent" | "tool"; text: string; tool?: string }[], left: number, harness: string): OutsideOpening["earlier"] => [
    ...(left > 0 ? [{ who: "note" as const, text: earlierLine(left, ctx.agentLabel(harness)) }] : []),
    ...lines.map(l => (l.who === "tool" ? { who: "tool" as const, text: toolDoneLine(l.tool, l.text) ?? toolActivityLine(l.tool, l.text) } : { who: l.who, text: l.text })),
  ];

  const opening = async (workspaceId: string, o: { harness?: string; resume: ResumeAsk }, origin?: Caller): Promise<OutsideOpening> => {
    const entry = await ctx.entryOf(workspaceId, origin);
    const prefs = ctx.state.preferencesHeld ?? (await ctx.preferences.get());
    const harness = o.harness ?? ctx.defaultAgentOf(prefs, entry);
    const label = ctx.agentLabel(harness);
    const store = ctx.adapters[harness] === undefined ? undefined : ctx.adapterFor(entry, harness).adapter.conversations;
    if (store === undefined) throw refusal(noConversationsLine(label), NO_CONVERSATIONS_FIX, "usage");
    const { id } = o.resume;
    const copy = o.resume.copy === true;
    const thread = wspSessions().get(id);
    if (thread !== undefined) throw refusal(conversationIsThreadLine(id, thread), conversationIsThreadFix(thread), "usage");
    const cwds = await foldersOf(entry);
    const road = roadOf(entry);
    const computer = ctx.computerOf(entry);
    const unread = (e: unknown): never => {
      const held = unreadOf(e, entry, harness);
      throw held === undefined ? e : refusal(held.said, held.fix, "usage");
    };
    const read = await store.earlier(id, { cwds, last: EARLIER_MESSAGES, probe: !copy }, road).catch(unread);
    if (read === "gone") throw refusal(conversationGoneLine(label, id, computer), CONVERSATION_GONE_FIX, "not-found");
    const named = read === "open" ? await store.earlier(id, { cwds, last: 0, probe: false }, road).catch(unread) : read;
    const title = typeof named === "object" ? (named.title ?? id) : id;
    const open = read === "open" || (!copy && (await store.live?.(road))?.has(id) === true);
    if (open) throw refusal(conversationOpenLine(title, computer), conversationOpenFix(store.letsGo), CONVERSATION_OPEN_KIND);
    if (typeof read !== "object") throw refusal(conversationGoneLine(label, id, computer), CONVERSATION_GONE_FIX, "not-found");
    return {
      harness,
      id,
      copy,
      project: entry.record.project,
      ...(read.cwd !== undefined ? { cwd: read.cwd } : {}),
      title,
      earlier: earlierRows(read.lines, read.earlier, harness),
    };
  };

  const placed: ConversationsArea["conversations"]["placed"] = async (start, resume, origin) => {
    if (start.thread !== undefined || start.branch !== undefined || start.cwd !== undefined) throw refusal(RESUME_WHERE_LINE, RESUME_WHERE_FIX, "usage");
    const base = start.workspaceId ?? (await ctx.folderFor(start.project !== undefined ? { project: start.project } : {}, origin)).entry.record.id;
    const outside = await opening(base, { ...(start.harness !== undefined ? { harness: start.harness } : {}), resume }, origin);
    const at = await ctx.folderFor({ project: outside.project, ...(outside.cwd !== undefined ? { cwd: outside.cwd } : {}) }, origin);
    return { workspaceId: at.entry.record.id, ...(at.cwd !== undefined ? { cwd: at.cwd } : {}), outside };
  };

  return { conversations: { list, opening, placed } };
}
