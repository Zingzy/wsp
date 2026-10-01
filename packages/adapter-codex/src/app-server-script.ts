// SPDX-License-Identifier: AGPL-3.0-only
// A few requests put to `codex app-server` outside any turn, as one bash
// script a computer runs, and its answers read back by request id.
//
// The app-server exits the moment its stdin closes, before it has answered, so
// the script holds its stdin open through a named pipe and closes it on the
// last answer: a fixed wait would be a wait the person sits through. The
// answers arrive in no fixed order (measured twice on 0.153.0, id 3 and id 4
// either way round), so the reader counts answers rather than watching for the
// last id it sent. Requests go in stages: a stage is sent only once every
// answer the stages before it wait for is in, so a read that has to see what a
// request did is never answered ahead of it.
import { shellQuote } from "@wsp/protocol";

/** How long the reader waits for one more line before giving up on the answers it has not had. Measured at 140 ms for
 * four answers on 0.153.0, so this is the stall case only; it is under the runtime's 30s timeout on a whole script. */
export const LINE_WAIT_S = 10;

export const request = (id: number, method: string, params: Record<string, unknown> = {}): string => JSON.stringify({ jsonrpc: "2.0", id, method, params });

export const notification = (method: string): string => JSON.stringify({ jsonrpc: "2.0", method, params: {} });

export const initializeRequest = (id: number): string => request(id, "initialize", { clientInfo: { name: "wsp", version: "0" } });

/** One stage: the JSON lines it writes and how many answers it waits for. */
export interface ServerStage {
  lines: readonly string[];
  answers: number;
}

/** The server under `codex` fed stage by stage, every line it prints copied to stdout. */
export function appServerScript(codex: string, stages: readonly ServerStage[]): string {
  let waited = 0;
  const staged = stages.flatMap((stage, at) => {
    const before = waited;
    waited += stage.answers;
    const body = [
      `printf '%s\\n' ${stage.lines.map(line => shellQuote(line)).join(" ")} >&3`,
      `while [ "$answers" -lt ${String(waited)} ] && IFS= read -r -t ${String(LINE_WAIT_S)} -u 4 line; do`,
      `  printf '%s\\n' "$line"`,
      `  case $line in '{"id":'*) answers=$((answers + 1)) ;; esac`,
      "done",
    ];
    return at === 0 ? body : [`if [ "$answers" -ge ${String(before)} ]; then`, ...body.map(l => `  ${l}`), "fi"];
  });
  return [
    // Two named pipes rather than a coprocess: the Mac's own bash is 3.2, which has none, and the tests prove this
    // script on whatever bash runs them.
    'WSP_PROBE_DIR=$(mktemp -d) && mkfifo "$WSP_PROBE_DIR/in" "$WSP_PROBE_DIR/out"',
    `${codex} app-server <"$WSP_PROBE_DIR/in" >"$WSP_PROBE_DIR/out" &`,
    "WSP_APP_SERVER_PID=$!",
    'exec 3>"$WSP_PROBE_DIR/in" 4<"$WSP_PROBE_DIR/out"',
    "answers=0",
    ...staged,
    "exec 3>&- 4<&-",
    // Only ever the pid the shell recorded: bare `kill 0` would signal the whole group.
    'kill "$WSP_APP_SERVER_PID" 2>/dev/null || :',
    'rm -rf "$WSP_PROBE_DIR"',
  ].join("\n");
}

export type ServerAnswer = { result: Record<string, unknown> } | { error: { code?: number; message: string } };

function rec(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Each answer in the text, a result or an error, by the numeric id the script sent it under. */
export function answersOf(text: string): Map<number, ServerAnswer> {
  const byId = new Map<number, ServerAnswer>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const message = rec(value);
    if (typeof message?.id !== "number") continue;
    const result = rec(message.result);
    const error = rec(message.error);
    if (result !== undefined) byId.set(message.id, { result });
    else if (error !== undefined) byId.set(message.id, { error: { ...(typeof error.code === "number" ? { code: error.code } : {}), message: typeof error.message === "string" ? error.message : "codex refused the request without saying why" } });
  }
  return byId;
}

/** The result answered under one id, or nothing where the server answered an error or nothing at all. */
export const resultOf = (answers: ReadonlyMap<number, ServerAnswer>, id: number): Record<string, unknown> | undefined => {
  const answer = answers.get(id);
  return answer !== undefined && "result" in answer ? answer.result : undefined;
};
