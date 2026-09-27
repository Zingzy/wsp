// SPDX-License-Identifier: AGPL-3.0-only
// The shell line that runs one Cursor turn, as `cursor-agent --help` on cursor-cli
// 2026.09.26-dd393fe spells the flags. The prompt travels on stdin through a
// quoted heredoc: with no prompt words the CLI reads stdin whenever it is not a
// terminal (src/commands/build-prompt.ts in that build), so a long task never
// meets the kernel's per-argument cap. --trust answers the folder question a
// headless run would stop on, for this process alone. A print run never updates
// the binary under it: only the interactive screen starts the self-update
// (src/run-agent.tsx), so the version the image pinned is the one that runs.
import { inFolder, shellQuote } from "@wsp/protocol";

const PROMPT_END = "WSP_PROMPT_END";
const CHAT_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Proposes changes and applies none: what a print run does without --force (cursor.com/docs/cli/headless). */
export const DEFAULT_MODE = "default";
/** Edits and runs commands without asking, unless the CLI's own settings deny them. */
export const FORCE_MODE = "force";

export interface CursorEnvOptions {
  base?: Readonly<Record<string, string | undefined>>;
  /** The key the vault holds for this agent and the variable its sign-in row names, CURSOR_API_KEY: never --api-key,
   * which would put the key on the process's argument list. */
  apiKey?: string;
  keyEnv?: string;
}

export function buildEnv(options: CursorEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? {})) if (value !== undefined) env[key] = value;
  if (options.apiKey !== undefined && options.keyEnv !== undefined) env[options.keyEnv] = options.apiKey;
  return env;
}

export interface BuildCommandOptions {
  prompt: string;
  /** The chat id an earlier turn's init announced; the turn continues that chat. */
  resume?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
}

export function buildCommand(options: BuildCommandOptions): string {
  const { prompt, resume, cwd, model, permissionMode } = options;
  if (prompt.split("\n").includes(PROMPT_END)) throw new Error(`the prompt has a line that reads ${PROMPT_END}, which ends the prompt`);
  if (permissionMode !== undefined && permissionMode !== DEFAULT_MODE && permissionMode !== FORCE_MODE) {
    throw new Error(`permissionMode must be one of ${DEFAULT_MODE}, ${FORCE_MODE}, got "${permissionMode}"`);
  }
  if (model !== undefined && (model.startsWith("-") || model.includes("\n"))) throw new Error(`model must be one model name, got "${model}"`);
  if (resume !== undefined && !CHAT_RE.test(resume)) throw new Error(`resume must be a chat id, got "${resume}"`);
  const line = [
    "cursor-agent -p --output-format stream-json --stream-partial-output --trust",
    ...(cwd === undefined ? [] : [`--workspace ${shellQuote(cwd)}`]),
    ...(model === undefined ? [] : [`--model ${shellQuote(model)}`]),
    ...(resume === undefined ? [] : [`--resume ${resume}`]),
    ...(permissionMode === FORCE_MODE ? ["--force"] : []),
  ].join(" ");
  return inFolder(cwd, `${line} <<'${PROMPT_END}'\n${prompt}\n${PROMPT_END}`);
}
