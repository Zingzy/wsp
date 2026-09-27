// SPDX-License-Identifier: AGPL-3.0-only
// The shell line that runs one OpenCode turn, as `opencode run --help` on
// opencode 1.18.18 spells the flags. The prompt travels on stdin through a
// quoted heredoc: run reads stdin whenever it is not a terminal and takes it as
// the message when no message words are given (the run command in the 1.18.18
// binary), so a long task never meets the kernel's per-argument cap. -f takes
// many values, so no word follows the last one but the heredoc.
import { inFolder, shellQuote } from "@wsp/protocol";

const PROMPT_END = "WSP_PROMPT_END";
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** -m's provider/model; the model half may hold slashes of its own, as a routed model's id does. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** OpenCode's one access mode here: run relays no permission prompt and rejects each one its settings raise
 * (measured on 1.18.18), so --auto, which approves whatever those settings do not deny, is the one a turn works in. */
export const AUTO_MODE = "auto";

export interface OpenCodeEnvOptions {
  base?: Readonly<Record<string, string | undefined>>;
  /** The key the vault holds for this agent and the variable its sign-in row names for it. */
  apiKey?: string;
  keyEnv?: string;
}

export function buildEnv(options: OpenCodeEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? {})) if (value !== undefined) env[key] = value;
  if (options.apiKey !== undefined && options.keyEnv !== undefined) env[options.keyEnv] = options.apiKey;
  return env;
}

export interface BuildCommandOptions {
  prompt: string;
  /** The session id an earlier turn's events carried; the turn continues that session. */
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  title?: string;
  /** Absolute paths of images already on the machine. */
  images?: readonly string[];
}

function slug(name: string, value: string): string {
  if (!SLUG_RE.test(value)) throw new Error(`${name} must be a plain slug, got "${value}"`);
  return value;
}

function model(value: string): string {
  if (!MODEL_RE.test(value)) throw new Error(`model must be provider/model, got "${value}"`);
  return value;
}

function imagePath(path: string): string {
  if (!path.startsWith("/") || path.includes("\n")) throw new Error(`an image path must be one absolute path on the machine, got "${path}"`);
  return shellQuote(path);
}

export function buildCommand(options: BuildCommandOptions): string {
  const { prompt, resume, cwd, effort, permissionMode, title, images } = options;
  if (prompt.split("\n").includes(PROMPT_END)) throw new Error(`the prompt has a line that reads ${PROMPT_END}, which ends the prompt`);
  if (permissionMode !== undefined && permissionMode !== AUTO_MODE) throw new Error(`permissionMode must be ${AUTO_MODE}, got "${permissionMode}"`);
  const line = [
    "opencode run --format json",
    // The JSON stream names a failure only as an unexpected server error and a ref; the log line with that ref says
    // what failed (measured on 1.18.18), so the log rides the turn's output at the one level that prints it.
    "--print-logs --log-level ERROR",
    ...(cwd === undefined ? [] : [`--dir ${shellQuote(cwd)}`]),
    ...(resume === undefined ? [] : [`-s ${slug("resume", resume)}`]),
    ...(options.model === undefined ? [] : [`-m ${model(options.model)}`]),
    ...(effort === undefined ? [] : [`--variant ${slug("effort", effort)}`]),
    ...(title === undefined ? [] : [`--title=${shellQuote(title)}`]),
    ...(permissionMode === AUTO_MODE ? ["--auto"] : []),
    ...(images ?? []).map(path => `-f ${imagePath(path)}`),
  ].join(" ");
  return inFolder(cwd, `${line} <<'${PROMPT_END}'\n${prompt}\n${PROMPT_END}`);
}
