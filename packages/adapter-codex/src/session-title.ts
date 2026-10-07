// SPDX-License-Identifier: AGPL-3.0-only
// What Codex itself calls a thread, read from the thread index in CODEX_HOME:
// state_<schema version>.sqlite, table threads, one row per thread id (the
// catalog's measured row for codex). Two columns name a thread: title, which
// the CLI fills from the thread's opening words and never leaves null, and
// name, which stays null until the person names the thread, so name wins where
// it has one, and a rename from here lands in that same column through the
// app server. Measured on codex-cli 0.153.0 against state_5.sqlite.

import { ENV_FROM_INPUT, generatedTitle, inFolder, programWord, shellQuote } from "@wsp/protocol";
import type { AgentLaunch, SessionRenameWrite } from "@wsp/protocol";
import { answersOf, appServerScript, initializeRequest, notification, request } from "./app-server-script.js";
import { slug } from "./command.js";

const PROMPT_END = "WSP_PROMPT_END";

/**
 * One shell line for the guest: the thread's row as JSON, out of the highest-versioned state db (the file name
 * carries the schema version, so a codex upgrade moves it). The names are sorted inside CODEX_HOME on the number
 * after the underscore, so state_10 beats state_5 and a home whose own path holds an underscore cannot confuse the
 * field. Read-only, so a running codex keeps its write lock, and json_object rather than printed columns, since a
 * name may hold whatever character a separator would use. Nothing on stdout when the machine has no sqlite3, no
 * state db or no such row, which reads as no title.
 */
export function sessionTitleCommand(options: { home: string; threadId: string }): string {
  const query = `select json_object('name', name, 'title', title) from threads where id = '${slug("threadId", options.threadId)}' limit 1;`;
  return (
    `command -v sqlite3 > /dev/null 2>&1 || exit 0; ` +
    `cd ${shellQuote(options.home)} 2>/dev/null || exit 0; ` +
    `d=$(ls -1 state_*.sqlite 2>/dev/null | sort -t_ -k2,2n | tail -n 1); [ -n "$d" ] || exit 0; ` +
    `sqlite3 -readonly "$d" ${shellQuote(query)} 2>/dev/null; true`
  );
}

/** The thread's name where the person gave it one, else the title the CLI derived; null when the row is missing or both are blank. */
export function parseSessionTitle(stdout: string): string | null {
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    for (const column of ["name", "title"] as const) {
      const title = (typeof row[column] === "string" ? (row[column] as string) : "").trim();
      if (title !== "") return title;
    }
    return null;
  }
  return null;
}

/**
 * One shell line for the guest that asks the CLI itself to name a thread: one `codex exec` turn on the question,
 * since a one-shot answer needs none of the app server's channel. It runs read-only rather than with the sandbox off, since the answer is one line of words and nothing it could write
 * belongs to the thread it names, and under the same CODEX_HOME as a session, which a guest exec would not carry: it
 * reads that off its input with the rest of `buildEnv`.
 */
export function titleForCommand(options: { prompt: string; model?: string; launch?: AgentLaunch }): string {
  if (options.prompt.split("\n").includes(PROMPT_END)) throw new Error(`the prompt has a line that reads ${PROMPT_END}, which ends the prompt`);
  // The question rides a quoted heredoc on stdin, read by the `-` that ends the flags; the heredoc also closes stdin,
  // which codex exec otherwise waits on when it is not a terminal.
  return `${ENV_FROM_INPUT}; ${inFolder(undefined, `${questionLine(options.model, options.launch)} <<'${PROMPT_END}'\n${options.prompt}\n${PROMPT_END}`)}`;
}

/** The one-shot question a title and a draft both ask: read-only, no approval asked, on the question from stdin. */
const questionLine = (model: string | undefined, launch: AgentLaunch | undefined): string =>
  `${programWord("codex", launch)} exec --json --skip-git-repo-check -c sandbox_mode='"read-only"' -c approval_policy='"never"'${model === undefined ? "" : ` -m ${slug("model", model)}`} -`;

/**
 * One shell line for the guest that asks the CLI for a commit message: the one-shot turn the title asks, read-only and
 * under the session's CODEX_HOME, on the question in the file the runtime put on the machine, since a diff is longer
 * than any command line may be.
 */
export function draftForCommand(options: { promptFile: string; model?: string; launch?: AgentLaunch }): string {
  return `${ENV_FROM_INPUT}; ${inFolder(undefined, `${questionLine(options.model, options.launch)} < ${shellQuote(options.promptFile)}`)}`;
}

/** The message out of the turn's events: the last agent message whole; null when the turn failed or said nothing. */
export function parseDraftFor(stdout: string): string | null {
  let text: string | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.type === "agent_message" && typeof row.text === "string") text = row.text;
  }
  return text === undefined || text.trim() === "" ? null : text;
}

/** The title out of the turn's events: the last agent message, sanitized; null when the turn failed, said nothing or
 * said something that is not a title. */
export function parseTitleFor(stdout: string): string | null {
  let text: string | undefined;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== "item.completed") continue;
    const item = event.item;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (row.type === "agent_message" && typeof row.text === "string") text = row.text;
  }
  return text === undefined ? null : generatedTitle(text);
}

const INIT = 1;
const NAME = 2;
/** Codex's refusal for a thread it has neither a rollout nor an index row for, measured on codex-cli 0.155.1 and
 * 0.160.0: a thread whose first turn has not been written yet, which a later write names. */
const NO_ROLLOUT = "no rollout found";

/**
 * One bash script for the guest that names a thread through the app server's own `thread/name/set`. Codex writes a
 * thread's index row only once its first turn is written, so an update of the db before then changes nothing; the
 * server writes the name into the row and lists it in its own thread/list. `cd ~` and the environment off its input
 * first, as the catalog probe does: a guest exec carries no environment of its own.
 */
export function renameCommand(options: { threadId: string; title: string; launch?: AgentLaunch }): string {
  const codex = programWord("codex", options.launch);
  const lines = [initializeRequest(INIT), notification("initialized"), request(NAME, "thread/name/set", { threadId: slug("threadId", options.threadId), name: options.title })];
  return `cd ~ && ${ENV_FROM_INPUT}\n${appServerScript(codex, [{ lines, answers: 2 }])}`;
}

/** What the write came to: codex's answer to the request, its refusal for a thread it has not written yet read as no
 * session, and any other refusal or no answer at all as the reason nothing was written. */
export function parseRename(stdout: string): SessionRenameWrite {
  const answer = answersOf(stdout).get(NAME);
  if (answer === undefined) return { kind: "failed", error: "codex's app server did not answer the rename" };
  if ("result" in answer) return { kind: "written" };
  return answer.error.message.startsWith(NO_ROLLOUT) ? { kind: "no-session" } : { kind: "failed", error: answer.error.message };
}
