// SPDX-License-Identifier: AGPL-3.0-only
// The wsp skill for agents on this computer, inlined at build time from the
// one file in the repo, so the MCP server's instructions and the skill an
// install writes cannot drift apart.
/// <reference path="./markdown.d.ts" />
import text from "../../../skills/wsp/SKILL.md";
import { THREAD_AGENTS, WSP_SKILL_NAME } from "@wsp/catalog";
import { ANOTHER_AGENT_WORDS, BACKGROUND_WORK_WORDS, COORDINATOR_HANDOFF, NOTIFY_CALLER } from "@wsp/protocol";
import { CLOUD_ON } from "./cloud.js";

export const SKILL_NAME = WSP_SKILL_NAME;

/** The mark on the skill's text that only means something on a cloud: a line that ends in it, a heading that ends in
 * it with its whole section, or a span it opens and CLOUD_SPAN_END closes. An HTML comment, so a markdown reader of
 * the file shows the text and not the mark. */
export const CLOUD_MARK = "<!-- cloud -->";
export const CLOUD_SPAN_END = "<!-- /cloud -->";
/** A span said only with the cloud off, where the road it stands in for reads otherwise without one. */
export const NO_CLOUD_MARK = "<!-- no cloud -->";
export const NO_CLOUD_SPAN_END = "<!-- /no cloud -->";

/** Text as a process with or without a cloud reads it: each span kept or dropped by its mark, the marks gone. What the
 * skill's lines and every verb's own words go through, so both follow one rule. */
export function cloudText(text: string, cloud: boolean): string {
  return text.replace(/<!-- cloud -->(.*?)<!-- \/cloud -->/g, (_, kept: string) => (cloud ? kept : "")).replace(/<!-- no cloud -->(.*?)<!-- \/no cloud -->/g, (_, kept: string) => (cloud ? "" : kept));
}

/** The skill as a process with or without a cloud reads it: the marks gone either way, and with no cloud everything
 * they mark gone too. */
export function skillFor(skill: string, cloud: boolean): string {
  const out: string[] = [];
  let dropping: number | undefined;
  let fenced = false;
  for (const line of skill.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#+) /.exec(line);
    if (dropping !== undefined) {
      if (heading === null || heading[1]!.length > dropping) continue;
      dropping = undefined;
    }
    const marked = line.endsWith(` ${CLOUD_MARK}`);
    if (marked && !cloud) {
      if (heading !== null) dropping = heading[1]!.length;
      continue;
    }
    const bare = marked ? line.slice(0, -CLOUD_MARK.length - 1) : line;
    out.push(cloudText(bare, cloud));
  }
  return out.join("\n");
}

/** The skill as this process reads it, worked out at each ask: an install and a tool server opening are the only
 * askers, and holding it would keep a second copy of the file for the host's whole life. */
export const wspSkill = (): string => skillFor(text, CLOUD_ON);

/** The section that walks a person's setup, the numbered steps and the exact lines to watch for. */
export const SETUP_HEADING = "## Setting a person up from nothing";

/** The section of rules for running work: what a machine can do at once and what wastes it. */
export const RULES_HEADING = "## Running work well";

/** The verbs table an agent reads, and the section holding the one verb that blocks, which is a shell script's. A
 * verb whose row sits in the wrong one of these teaches the wrong road, so the parity test pins where each is. */
export const VERBS_HEADING = "## Verbs and tools";
export const SHELL_HEADING = "### For a shell script";

/** What wsp is and where the rest of it lives, between the agent line and the rules: the setup walkthrough and the
 * rules past these three are the skill's, since the whole of them was cut off by Claude Code and copied into every
 * deferred tool's entry by Codex. */
const ESSENTIALS =
  "A project is a folder on one computer, and agents work on it as threads, each shown in the person's sidebar. Setting a person up, every verb and the rules for running work well are in the wsp skill, which `wsp mcp install --agent <id>` writes; read it before setting anyone up.";

/** The agents a thread runs on, from the adapter registry, so the instructions promise no agent the host refuses. */
export function agentsLine(agents: readonly string[]): string {
  return `The agents this host runs threads on, the only values ${CLOUD_ON ? "run and fork take" : "run takes"} as agent: ${agents.join(", ")}.`;
}

/** How much of a server's instructions an agent keeps: Claude Code cuts them to this many characters and drops the
 * rest (measured on 2.1.284, "Server instructions truncated from 7992 to 2048 chars"). */
export const INSTRUCTIONS_KEPT = 2048;

/** What a slate is, carried second so it lands inside what Claude Code keeps, under 220 characters with its full stop
 * (10, "The instructions sentence"); the skill's slate section sits past the cut. */
export const SLATE_WORDS = "This thread can own a slate, a live panel the person reads, presses and fills in: when they ask for a panel, dashboard, form, checklist, tracker or walkthrough, or name the slate, call slate_catalog, then slate_write";

/** What a thread's own tool server opens with, ahead of everything else: that the session is a thread with a slate
 * beside it, keyed on what the person wants to do rather than on the names of pieces, since they say "I wanna see
 * this live" and never "a panel". The slate tools' descriptions carry the same words, since tool search reads those. */
export const THREAD_SLATE_WORDS =
  "This session is a wsp thread with a slate: a live panel shown here, beside this conversation, that the person sees while you work. Show on it whatever they want to see, watch, monitor or keep an eye on that changes (live data, traffic, metrics, a price, logs, a PR, progress, status), want a dashboard, something to fill in or tick off (a form, a checklist, a walkthrough), or a flow laid out (a diagram): call slate_catalog, then slate_write. A one-off answer, a comparison or an explanation, stays in chat unless they ask to see it. Build and read it with the slate tools, never wsp from a shell, which may be another install. Once the slate is written, a request to see something lands there. A run with every={60} refreshes it with no turns; never poll in the chat. Read the sketch a write answers before saying it works, then reply briefly: what you built and what waits on the person.";

/** The MCP server's instructions, whole inside what Claude Code keeps: a thread's slate first, then what another agent
 * is, since it is the one fact an agent acts on before it has read anything else, what wsp is and where the skill is,
 * the agents the host has adapters for, and the two roads to a child's end with the background road. */
export function instructionsOf(agents: readonly string[], scoped = false): string {
  const body = [[`${ANOTHER_AGENT_WORDS}.`, ...(scoped ? [] : [`${SLATE_WORDS}.`]), ESSENTIALS, agentsLine(agents)].join(" "), ...[`${NOTIFY_CALLER}, so nothing is polled.`, `${COORDINATOR_HANDOFF}.`, `${BACKGROUND_WORK_WORDS}.`].map(rule => `- ${rule}`)].join("\n");
  return scoped ? `${THREAD_SLATE_WORDS}\n\n${body}` : body;
}

/** The MCP server's instructions, worked out when a server opens, for the same reason; a thread's own server opens
 * with its slate. */
export const instructions = (scoped = false): string => instructionsOf(THREAD_AGENTS, scoped);
