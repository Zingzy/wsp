// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { THREAD_AGENTS } from "@wsp/catalog";
import { ConversationsAnswer, fmtBytes, usageRefusal, type OutsideConversation } from "@wsp/protocol";
import { table, usageIs, tool, flag, type HostClient, type Verb, type VerbDeps } from "./client.js";
import { projectsOf } from "./workspaces-help.js";
import { asJson } from "./io.js";
import { projectOfFolder } from "./turns-help.js";

/** The project a line names: the one asked for, else the one whose folder it was typed in; a thread with none named
 * lists its own project's, which the host reads off its token. */
async function projectAsked(client: HostClient, ref: string | undefined, deps: Pick<VerbDeps, "cwd">): Promise<string | undefined> {
  if (ref !== undefined) return ref;
  if (deps.cwd === undefined) return undefined;
  return projectOfFolder(await projectsOf(client).catch(() => []), deps.cwd)?.id;
}

const listed = (client: HostClient, project: string | undefined, agent: string | undefined): Promise<ConversationsAnswer> =>
  client.request<Record<string, unknown>>("conversations.list", { ...(project !== undefined ? { project } : {}), ...(agent !== undefined ? { agent } : {}) }).then(a => ConversationsAnswer.parse(a));

/** The last change as a person's clock reads it, to the minute. */
const changed = (at: number): string => new Date(at).toLocaleString("sv-SE").slice(0, 16);

/** What a row says beside its title: open in another app, already a thread, or a wsp thread's. */
const mark = (r: OutsideConversation): string => (r.thread !== undefined ? `thread ${r.thread.slice(0, 8)}` : r.live ? "open elsewhere" : r.origin === "wsp" ? "wsp" : "");

export function conversationsLines(answer: ConversationsAnswer): string[] {
  const rows = answer.rows.length === 0 ? ["no Claude Code or Codex conversations in this folder"] : table([["AGENT", "ID", "CHANGED", "SIZE", "BRANCH", "", "TITLE"], ...answer.rows.map(r => [r.agent, r.id, changed(r.lastAt), r.bytes !== undefined ? fmtBytes(r.bytes) : "-", r.branch ?? "-", mark(r), r.title])]);
  return [...rows, ...answer.held.map(h => `${h.said}. ${h.fix}`)];
}

export const CONVERSATION_VERBS: readonly Verb[] = [
  {
    name: "conversations",
    usage: "wsp conversations [<project>] [--agent <id>]",
    about:
      "the conversations Claude Code and Codex kept in the project's folder and its worktrees outside wsp, newest first, each with its id, last change, size, branch and title, and whether another app holds it open; wsp run --resume <id> opens a thread on one",
    page: "agent",
    options: { agent: { type: "string" } },
    run: async ctx => {
      if (ctx.args.length > 1) throw usageRefusal(`wsp conversations takes one project; ${ctx.args[1]!} reads as a second.`, usageIs(ctx));
      const client = await ctx.client();
      const answer = await listed(client, await projectAsked(client, ctx.args[0], ctx), flag(ctx.flags, "agent"));
      ctx.out.emit(answer, conversationsLines(answer).join("\n"));
      return 0;
    },
    tool: tool({
      description: `The conversations the agents kept in a project's folder and its worktrees on the project's computer outside wsp, Claude Code's off its transcripts and Codex's off its own app server, newest first: agent, id, title (the person's name for it, else the agent's, else its last or first prompt), firstPrompt, branch, cwd, lastAt (ms), bytes, origin (terminal, wsp or script), live (another app holds it open now), thread (the wsp thread already on it, which is the one to send into) and letsGo (where the agent refuses a second writer: how soon it lets go of one whose window closed, in its own sentence). A Claude Code conversation a script ran is left out unless it is a wsp thread's. held names an agent whose store did not answer, in two halves. run with resume opens a thread on one; one that is live needs copy.`,
      input: {
        project: z.string().optional().describe("the project, by the name or the id projects lists; absent from a thread, the thread's own project"),
        agent: z.string().optional().describe(`one agent's conversations alone, one of ${THREAD_AGENTS.join(", ")}; absent lists every agent's`),
      },
      output: ConversationsAnswer.shape,
      call: async ({ project, agent }, deps) => {
        const answer = await listed(await deps.client(), project, agent);
        return asJson(answer);
      },
    }),
  },
];
