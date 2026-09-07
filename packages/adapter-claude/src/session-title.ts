// SPDX-License-Identifier: AGPL-3.0-only
// What Claude Code itself calls a session, read from the session file it keeps
// under CLAUDE_CONFIG_DIR/projects/<folder key>/<session id>.jsonl. Two record
// kinds carry a title, both one-line objects beside the message lines:
// {"type":"ai-title","aiTitle":...} is the one the CLI generates, and
// {"type":"custom-title","customTitle":...} the one the person typed when they
// renamed the session. Measured on 2.1.263: both are re-appended at every turn
// boundary, and the last ai-title of a renamed session sat one line AFTER its
// last custom-title, so the newest record does not decide it; the person's
// rename wins wherever in the file it sits.

import { generatedTitle, shellQuote } from "@wsp/protocol";
import { buildEnv } from "./landmines.js";

const AI_TITLE = '"type":"ai-title"';
const CUSTOM_TITLE = '"type":"custom-title"';

/**
 * One shell line for the guest: the last record of each kind from the session's file, in whichever project folder
 * holds it (the folder key is the session's path, which the caller does not know), the freshest file first where a
 * moved project left the id under two keys. Two greps rather than one, so the newest of each kind comes back
 * whatever order the CLI wrote them in, and the whole file rather than its tail, since a title record sits wherever
 * the session's last turn ended. Nothing on stdout when there is no such file, which reads as no title.
 */
export function sessionTitleCommand(options: { configDir: string; sessionId: string }): string {
  const file = `${shellQuote(`${options.configDir}/projects`)}/*/${shellQuote(`${options.sessionId}.jsonl`)}`;
  return (
    `f=$(ls -1t ${file} 2>/dev/null | head -n 1); [ -n "$f" ] || exit 0; ` +
    `grep -F ${shellQuote(CUSTOM_TITLE)} "$f" | tail -n 1; ` +
    `grep -F ${shellQuote(AI_TITLE)} "$f" | tail -n 1; true`
  );
}

/** The title the records name, the person's rename beating the generated one; null when neither is there or both are blank. */
export function parseSessionTitle(stdout: string): string | null {
  let generated: string | undefined;
  let renamed: string | undefined;
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
    const record = value as Record<string, unknown>;
    if (record.type === "custom-title" && typeof record.customTitle === "string") renamed = record.customTitle;
    if (record.type === "ai-title" && typeof record.aiTitle === "string") generated = record.aiTitle;
  }
  for (const candidate of [renamed, generated]) {
    const title = (candidate ?? "").trim();
    if (title !== "") return title;
  }
  return null;
}

/**
 * One shell line for the guest that asks the CLI itself to name a thread: a print-mode turn on the question, with
 * the prompt on stdin rather than in the argv (a brief's excerpt would hit the kernel's per-argument cap) and the
 * whole answer as one JSON object. --bare skips hooks, plugins and CLAUDE.md, as the catalog probe does, so a
 * person's SessionStart hooks do not run on a question; no tool is allowed, since the answer is one line of words
 * and a tool call would cost a turn of its own. The same config dir and the same stripped environment as a session,
 * so the question runs as the person's sign-in and never as a nested Claude Code.
 */
export function titleForCommand(options: { configDir: string; prompt: string; model?: string; baseEnv?: Readonly<Record<string, string | undefined>> }): string {
  const env = buildEnv({ base: options.baseEnv, configDir: options.configDir });
  const exports = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ");
  const clean = `unset \${!CLAUDE_CODE_@} CLAUDECODE FORCE_CODE_TERMINAL; export ${exports}`;
  const claude = ["claude -p", "--bare", "--output-format json", "--allowed-tools ''", ...(options.model === undefined ? [] : [`--model ${shellQuote(options.model)}`])].join(" ");
  return `cd ~ && ${clean}; printf '%s' ${shellQuote(options.prompt)} | ${claude}`;
}

/** The title out of the print-mode answer: its result field, sanitized; null when the CLI errored, answered nothing
 * or answered something that is not a title. */
export function parseTitleFor(stdout: string): string | null {
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
    const answer = value as Record<string, unknown>;
    if (answer.type !== "result" || answer.is_error === true) continue;
    if (typeof answer.result !== "string") continue;
    return generatedTitle(answer.result);
  }
  return null;
}
