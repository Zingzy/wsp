// SPDX-License-Identifier: AGPL-3.0-only
// The wsp tools an agent calls from inside its own turn, and the one fact a
// reader outside the host needs about a call still in flight: which thread it
// is behind. A call that follows another thread to the end of its turn cannot
// finish while that thread stands on a question, so the thread making the call
// is stopped on that question too.
import { serverTool } from "./format.js";

/** The name the wsp MCP server has in every agent's config and in every launch that carries it, so an agent's
 * config on this computer and the launch a turn on a machine gets name one server and not two. */
export const MCP_SERVER_NAME = "wsp";

/** The slate's tools, and the name a launch serves them under again for a harness that keeps a server's tools behind
 * a search until asked: Codex lists tools up front only per server (omit_tools_from, codex-rs/core/src/tools/
 * spec_plan.rs at rust-v0.155.1), and an agent that never searched never found the slate. */
export const SLATE_TOOLS = ["slate_catalog", "slate_write", "slate_state", "slate_read"] as const;
export const SLATE_SERVER_NAME = "wsp_slate";

/** The slate's rules where a small model weighs them, at the end of the system prompt, for a thread whose launch
 * carries the scoped wsp server: in the server's instructions alone, behind the person's own CLAUDE.md and skills,
 * Haiku read a token file first and drew in chat. Free of the 2,048 characters an MCP server's instructions keep. */
export const SLATE_BRIEF = [
  "wsp slate. This session is a wsp thread with a slate, a live panel beside this conversation that the person sees. Before any other work, decide whether the request belongs on the slate. It does when the person:",
  "- wants to see, watch, monitor or keep an eye on something, or a result kept fresh or refreshed on a schedule (\"refresh hourly\", \"live\", \"what's unread\");",
  "- wants a dashboard, a form to fill in, a checklist or walkthrough to tick off, or a flow laid out (a diagram);",
  "- asks for a button or control the project has no UI for: the slate is that UI.",
  "Then your first tool call is mcp__wsp__slate_catalog, then mcp__wsp__slate_write. Do not draw it with another tool or skill, write an HTML page, or answer in chat instead.",
  "On the slate, a value that changes comes from a <run>: a cmd, or tool=\"server.tool\" for an MCP tool. Never call that tool yourself and type its numbers in.",
  "A token or key the person keeps in a file stays there: the run's command reads it from the file. Never read that file or put its value in a tool call.",
  "A one-off answer, a comparison or an explanation stays in chat.",
].join("\n");

/** How long an agent that holds its own limit on a tool call lets a wsp call run, which Codex reads as the server
 * entry's tool_timeout_sec: 300 s by default since openai/codex#28234, 60 s before it. A send or a run waits through
 * a wake before its turn starts, and a paused Boat's wake is its resume and then its daemon's budget to answer, which
 * together run past that default; the reply comes after. No limit covers every reply, since a turn has no bound; an
 * hour holds the slowest wake with a long first turn behind it, and work past that is what detach and notify are for. */
export const WSP_TOOL_TIMEOUT_SEC = 3600;

/** Where each wsp call that does not answer until another thread's turn is over names the thread it is behind: the
 * input field holding the references, or `opened` for the call that follows the thread it starts, which has no id
 * until the call has made one. Adding a verb that blocks is a row here and nothing else. */
const FOLLOWS: Readonly<Record<string, { readonly field: string } | { readonly opened: true }>> = {
  send: { field: "thread" },
  run: { opened: true },
  threads_wait: { field: "threads" },
};

/** What a thread's running tool call is waiting behind, read off the call alone: the threads it named, by whatever
 * reference the caller used, or `opened` for a call that follows the thread it started. Nothing for another
 * server's tool, for a wsp verb that answers out of the host alone, and for a detached call, which answers the
 * moment the turn starts and follows nobody. */
export function threadsFollowed(call: { toolName: string; input: string }): { readonly named: readonly string[] } | { readonly opened: true } | undefined {
  const named = serverTool(call.toolName);
  if (named?.server !== MCP_SERVER_NAME) return undefined;
  const follows = FOLLOWS[named.tool];
  if (follows === undefined) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(call.input);
  } catch {
    return undefined;
  }
  if (typeof input !== "object" || input === null) return undefined;
  const args = input as Record<string, unknown>;
  if (args["detach"] === true) return undefined;
  if ("opened" in follows) return follows;
  const value = args[follows.field];
  const refs = (Array.isArray(value) ? value : [value]).filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  return refs.length === 0 ? undefined : { named: refs };
}
