// SPDX-License-Identifier: AGPL-3.0-only
// The shell line that runs one Codex turn on a workspace, as `codex exec
// --help` on codex-cli 0.153.0 spells the flags. The prompt travels on stdin
// through a quoted heredoc, since a long task as an argument would hit the
// kernel's per-argument cap, and `-` tells codex to read it there; the heredoc
// also closes stdin, which codex otherwise waits on when it is not a terminal.
import { shellQuote } from "@wsp/protocol";

const PROMPT_END = "WSP_PROMPT_END";
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** The sandbox modes `codex exec -s` takes; the one that turns the sandbox off is the flag that also skips approvals. */
const SANDBOXED = ["read-only", "workspace-write"];
const NO_SANDBOX = "danger-full-access";

export interface CodexEnvOptions {
  base?: Readonly<Record<string, string | undefined>>;
  /** Absolute path for CODEX_HOME, where the golden's sign-in put auth.json. */
  home: string;
}

/** CODEX_HOME points codex at the home the sign-in wrote, since a guest exec carries no HOME to derive it from. */
export function buildEnv(options: CodexEnvOptions): Record<string, string> {
  const home = options.home.trim();
  if (!home.startsWith("/")) throw new Error(`home must be an absolute path, got "${options.home}"`);
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.base ?? {})) if (value !== undefined) clean[key] = value;
  return { ...clean, CODEX_HOME: home };
}

export interface BuildCommandOptions {
  prompt: string;
  /** The thread id an earlier turn's thread.started announced; the turn continues that thread. */
  resume?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  /** One of the catalog's sandbox modes; absent runs without a sandbox, as every turn in a throwaway machine does. */
  permissionMode?: string;
}

function slug(name: string, value: string): string {
  if (!SLUG_RE.test(value)) throw new Error(`${name} must be a plain slug, got "${value}"`);
  return value;
}

/** A config override whose value is a TOML string, which is JSON's quoting for these plain words. */
const config = (key: string, value: string): string => `-c ${key}=${shellQuote(JSON.stringify(value))}`;

/** exec takes the mode as -s and resume has no such flag, so both set the config key the flag writes. */
function accessFlags(mode: string | undefined): string[] {
  if (mode === undefined || mode === NO_SANDBOX) return ["--dangerously-bypass-approvals-and-sandbox"];
  if (!SANDBOXED.includes(mode)) throw new Error(`permissionMode must be one of ${[...SANDBOXED, NO_SANDBOX].join(", ")}, got "${mode}"`);
  return [config("sandbox_mode", mode), config("approval_policy", "never")];
}

/**
 * The turn as one bash line: `codex exec` (or `codex exec resume <id>`) with JSONL events on stdout, outside a git
 * checkout allowed since a thread may start in the home folder, and the prompt as the heredoc on stdin. Guest exec
 * carries no HOME, so the default folder is `~`, which bash reads from passwd.
 */
export function buildCommand(options: BuildCommandOptions): string {
  const { prompt, resume, cwd, model, effort, permissionMode } = options;
  if (prompt.split("\n").includes(PROMPT_END)) throw new Error(`the prompt has a line that reads ${PROMPT_END}, which ends the prompt`);
  const codex = [
    "codex exec",
    ...(resume === undefined ? [] : [`resume ${slug("resume", resume)}`]),
    "--json",
    "--skip-git-repo-check",
    ...accessFlags(permissionMode),
    ...(model === undefined ? [] : [`-m ${slug("model", model)}`]),
    ...(effort === undefined ? [] : [config("model_reasoning_effort", slug("effort", effort))]),
    "-",
  ].join(" ");
  return `cd ${cwd === undefined ? "~" : shellQuote(cwd)} && ${codex} <<'${PROMPT_END}'\n${prompt}\n${PROMPT_END}`;
}

/** Interrupt is a hard boundary, as it is for every harness: teardown (SIGTERM), then SIGKILL after this grace window. */
export const INTERRUPT_GRACE_MS = 5_000;
