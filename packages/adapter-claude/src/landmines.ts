// Encoded Claude Code deployment quirks. Sources: pingdotgg/t3code (MIT, see
// NOTICE; logic only) and measured behavior in solari-poc/RESULTS.md.

import { randomUUID } from "node:crypto";
import { shellQuote } from "@wsp/protocol";

// Inherited CLAUDE_CODE_*/CLAUDECODE mark the child as nested inside another
// Claude Code run; FORCE_CODE_TERMINAL flips terminal detection (t3code unsets
// it for headless probes).
export const ENV_STRIP_PATTERNS: readonly RegExp[] = [
  /^CLAUDE_CODE_/,
  /^CLAUDECODE$/,
  /^FORCE_CODE_TERMINAL$/,
];

// From t3code's probe options: headless runs must not probe for IDEs, or the
// CLI spawns discovery process trees on every invocation.
const HEADLESS_OVERRIDES = {
  CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
} as const;

export interface ClaudeEnvOptions {
  base?: Readonly<Record<string, string | undefined>>;
  /** Absolute path for CLAUDE_CONFIG_DIR ("/root/.claude-cfg" in guests). */
  configDir: string;
  apiKey?: string;
}

export function stripLandmineEnv(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (ENV_STRIP_PATTERNS.some((pattern) => pattern.test(key))) continue;
    clean[key] = value;
  }
  return clean;
}

/**
 * Config isolation goes through CLAUDE_CONFIG_DIR, never through HOME:
 * overriding HOME relocates the macOS keychain lookup and the CLI reports
 * "Not logged in" (t3code ClaudeHome.ts). IS_SANDBOX=1 is what lets
 * --dangerously-skip-permissions run as root in guests (solari-poc P1).
 */
export function buildEnv(options: ClaudeEnvOptions): Record<string, string> {
  const configDir = options.configDir.trim();
  if (!configDir.startsWith("/")) {
    throw new Error(`configDir must be an absolute path, got "${options.configDir}"`);
  }
  return {
    ...stripLandmineEnv(options.base ?? {}),
    ...HEADLESS_OVERRIDES,
    CLAUDE_CONFIG_DIR: configDir,
    IS_SANDBOX: "1",
    ...(options.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: options.apiKey }),
  };
}

/**
 * The caller generates the session UUID and passes it via --session-id, so the
 * session is addressable (registry, transcript path, --resume) before the CLI
 * prints anything (t3code startSession).
 */
export function newSessionId(): string {
  return randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BuildCommandOptions {
  prompt: string;
  /** Fresh session: the self-generated UUID passed as --session-id. */
  sessionId?: string;
  /** Existing session: passed as --resume instead. */
  resume?: string;
  cwd?: string;
  /** The CLI's own slugs, from the harness catalog; absent leaves the CLI's default in place. */
  model?: string;
  effort?: string;
  /** "default" sends no permission flag; absent keeps skipping permissions, what every session did before there was a picker. */
  permissionMode?: string;
  /** "1m" or "200k" from the catalog; the CLI takes 1M as a "[1m]" suffix on the model, so it needs one. */
  contextWindow?: string;
}

// Model names carry a context suffix like "claude-opus-5[1m]"; nothing else a catalog value needs is outside this set.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

function slugFlag(flag: string, name: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  if (!SLUG_RE.test(value)) throw new Error(`${name} must be a plain slug, got "${value}"`);
  return [`${flag} ${shellQuote(value)}`];
}

function modelWithContext(model: string | undefined, contextWindow: string | undefined): string | undefined {
  if (contextWindow === undefined) return model;
  if (model === undefined) throw new Error("contextWindow needs a model to ride on");
  if (contextWindow === "200k") return model;
  if (contextWindow === "1m") return `${model}[1m]`;
  throw new Error(`contextWindow must be "200k" or "1m", got "${contextWindow}"`);
}

function permissionFlags(mode: string | undefined): string[] {
  if (mode === undefined || mode === "bypassPermissions") return ["--dangerously-skip-permissions"];
  if (mode === "default") return [];
  return slugFlag("--permission-mode", "permissionMode", mode);
}

/**
 * Print-mode stream-json refuses to run without --verbose, and `claude -p`
 * hangs unless stdin is closed (solari-poc probes, RESULTS.md P1).
 * Guest exec carries no HOME (measured on Solari sandboxes), so the default
 * cwd is `~`: tilde expansion falls back to the passwd entry where "$HOME"
 * would expand to nothing.
 */
export function buildCommand(options: BuildCommandOptions): string {
  const { prompt, sessionId, resume, cwd, model, effort, permissionMode, contextWindow } = options;
  if ((sessionId === undefined) === (resume === undefined)) {
    throw new Error("buildCommand needs exactly one of sessionId or resume");
  }
  const id = sessionId ?? resume ?? "";
  if (!UUID_RE.test(id)) {
    throw new Error(`session identifier must be a UUID, got "${id}"`);
  }
  const idFlag = sessionId === undefined ? `--resume ${id}` : `--session-id ${id}`;
  const claude = [
    `claude -p ${shellQuote(prompt)}`,
    "--output-format stream-json",
    "--verbose",
    ...permissionFlags(permissionMode),
    ...slugFlag("--model", "model", modelWithContext(model, contextWindow)),
    ...slugFlag("--effort", "effort", effort),
    idFlag,
    "</dev/null",
  ].join(" ");
  return `cd ${cwd === undefined ? "~" : shellQuote(cwd)} && ${claude}`;
}

/**
 * Interrupt policy from t3code interruptTurn: a graceful interrupt can be
 * acknowledged while background tasks keep the CLI alive, so interrupt is a
 * hard boundary: teardown (close stdin/SIGTERM), then SIGKILL after this
 * grace window.
 */
export const INTERRUPT_GRACE_MS = 5_000;
