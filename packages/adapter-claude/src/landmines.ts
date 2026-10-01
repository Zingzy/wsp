// Encoded Claude Code deployment quirks. Sources: pingdotgg/t3code (MIT, see
// NOTICE; logic only) and measured behavior in solari-poc/RESULTS.md.

import { randomUUID } from "node:crypto";
import { inFolder, launchWords, programWord, shellQuote } from "@wsp/protocol";
import type { AgentLaunch, McpServerSpec, TurnImage } from "@wsp/protocol";
import { PERMISSION_PROMPT_TOOL, SKIP_PROMPTS_MODE } from "./permissions.js";

// Inherited CLAUDE_CODE_*/CLAUDECODE mark the child as nested inside another
// Claude Code run; FORCE_CODE_TERMINAL flips terminal detection (t3code unsets
// it for headless probes).
export const ENV_STRIP_PATTERNS: readonly RegExp[] = [
  /^CLAUDE_CODE_/,
  /^CLAUDECODE$/,
  /^FORCE_CODE_TERMINAL$/,
];

// From t3code's probe options: headless runs must not probe for IDEs, or the
// CLI spawns discovery process trees on every invocation. A headless run also
// leaves the task list tools off, which the CLI's own terminal has on.
const HEADLESS_OVERRIDES = {
  CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
  CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
} as const;

/** The variable that tells the CLI which folder under its projects directory to keep this run's sessions and its
 * auto memory in. Set after the strip, never through `base`: the strip drops every inherited CLAUDE_CODE_* as a
 * nesting mark, and this one is ours. */
export const PROJECT_DIR_ENV = "CLAUDE_CODE_PROJECT_DIR_NAME";

export interface ClaudeEnvOptions {
  /** The machine's login environment: a guest's carries its config dir and IS_SANDBOX, a person's own carries theirs. */
  base?: Readonly<Record<string, string | undefined>>;
  apiKey?: string;
  /** The long-lived token from claude setup-token. Set after the strip: the strip removes an inherited CLAUDE_CODE_*
   * as a nesting mark, and this one is ours. An API key beside it wins inside the CLI, so the caller hands one or
   * the other and never both, decided by what the vault holds: its token where there is one, else its key. */
  oauthToken?: string;
  /** The folder under the CLI's projects directory this run keys its sessions and its memory to. What a copy of a
   * project folder is given, so every copy and the person's own terminal in that folder share one memory and one
   * sessions list. Absent leaves the CLI keying off the folder the turn runs in. */
  projectDirName?: string;
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
 * Sets neither CLAUDE_CONFIG_DIR nor IS_SANDBOX: both ride in `base` where they are true. The CLI keys its Keychain
 * item by whether the variable is set, not by its path (the service name gains a hash of the path once it is set),
 * so a Mac that exports it even as ~/.claude reports a claude.ai login as "Not logged in" (measured on 2.1.257 and
 * 2.1.259, 2026-09-10). A machine's login carries IS_SANDBOX=1, what lets --dangerously-skip-permissions run as root
 * there (solari-poc P1), and a guest's carries its config dir, never a changed HOME, which relocates the Keychain
 * lookup (t3code ClaudeHome.ts).
 */
export function buildEnv(options: ClaudeEnvOptions = {}): Record<string, string> {
  return {
    ...stripLandmineEnv(options.base ?? {}),
    ...HEADLESS_OVERRIDES,
    ...(options.apiKey === undefined ? {} : { ANTHROPIC_API_KEY: options.apiKey }),
    ...(options.oauthToken === undefined ? {} : { CLAUDE_CODE_OAUTH_TOKEN: options.oauthToken }),
    ...(options.projectDirName === undefined ? {} : { [PROJECT_DIR_ENV]: options.projectDirName }),
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

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BuildCommandOptions {
  /** Fresh session: the self-generated UUID passed as --session-id. */
  sessionId?: string;
  /** Existing session: passed as --resume instead. */
  resume?: string;
  /** The uuid of the message a rewind kept, on a resume alone: passed as --resume-session-at, which the CLI keeps out
   * of --help and loads the session up to (measured on 2.1.283: a resume at a turn's last message answered as if
   * the turns after it had never run, and its new turn hung off that message in the session file). */
  resumeAt?: string;
  cwd?: string;
  /** The CLI's own slugs, from the harness catalog; absent leaves the CLI's default in place. */
  model?: string;
  effort?: string;
  /** The CLI's own mode slug; absent keeps skipping permissions, what every session did before there was a picker. */
  permissionMode?: string;
  /** "1m" or "200k" from the catalog; the CLI takes 1M as a "[1m]" suffix on the model, so it needs one. */
  contextWindow?: string;
  /** The display name the session is opened under, whatever characters it holds; the CLI writes it into the session's
   * own store as the person's, which is where its resume list and this adapter's title read both take it from. */
  name?: string;
  /** MCP servers this turn gets on top of the config dir's own, by the name each takes in a config. */
  mcpServers?: Readonly<Record<string, McpServerSpec>>;
  /** The model's faster output. The CLI takes it as the fastMode setting, which --settings carries for this launch
   * alone; the result's fast_mode_state says whether the account served it (2.1.283, 2026-09-27). */
  fast?: boolean;
  /** The program run in place of claude and the words added after -p, from the person's setup on that computer. */
  launch?: AgentLaunch;
}

// Model names carry a context suffix like "claude-opus-5[1m]"; nothing else a catalog value needs is outside this set.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

export function slugFlag(flag: string, name: string, value: string | undefined): string[] {
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

/**
 * The access flags for one mode. Bypass, and no mode at all, skip permissions outright. Every other mode names
 * itself, "default" included: sending no flag for it left the person's own settings deciding the turn's access, and
 * on 2.1.263 a turn launched that way came back in the auto mode their store had (measured 2026-09-08), which is
 * not what the picker said. A mode that is not bypass may raise a prompt, and --permission-prompt-tool routes it to
 * this process over the control channel; without the flag the CLI denies every such call by itself.
 */
function permissionFlags(mode: string | undefined): string[] {
  if (mode === undefined || mode === SKIP_PROMPTS_MODE) return ["--dangerously-skip-permissions"];
  return [...slugFlag("--permission-mode", "permissionMode", mode), `--permission-prompt-tool ${PERMISSION_PROMPT_TOOL}`];
}

/**
 * The servers a turn is handed, as this CLI takes them: one --mcp-config carrying the JSON a config file would hold.
 * Not --strict-mcp-config, which would drop the config dir's own servers and leave the turn with these alone.
 */
function mcpConfigFlag(servers: Readonly<Record<string, McpServerSpec>> | undefined): string[] {
  if (servers === undefined || Object.keys(servers).length === 0) return [];
  const mcpServers = Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, { command: s.command, args: [...s.args] }]));
  return [`--mcp-config ${shellQuote(JSON.stringify({ mcpServers }))}`];
}

/**
 * Print-mode stream-json refuses to run without --verbose. `claude -p` reads
 * stdin to the end, so stdin is either closed or a stream-json channel the
 * caller writes and closes on purpose, never a silent open pipe (solari-poc
 * probes, RESULTS.md P1): the prompt and every later message are user lines
 * on that channel, and EOF ends the process after its current turn.
 */
export function buildCommand(options: BuildCommandOptions): string {
  const { sessionId, resume, cwd, model, effort, permissionMode, contextWindow, name, mcpServers, fast } = options;
  if ((sessionId === undefined) === (resume === undefined)) {
    throw new Error("buildCommand needs exactly one of sessionId or resume");
  }
  const id = sessionId ?? resume ?? "";
  if (!UUID_RE.test(id)) {
    throw new Error(`session identifier must be a UUID, got "${id}"`);
  }
  if (options.resumeAt !== undefined && resume === undefined) throw new Error("a cut at a message rides a resume alone");
  if (options.resumeAt !== undefined && !UUID_RE.test(options.resumeAt)) throw new Error(`a cut must name a message by its UUID, got "${options.resumeAt}"`);
  const idFlag = sessionId === undefined ? `--resume ${id}${options.resumeAt === undefined ? "" : ` --resume-session-at ${options.resumeAt}`}` : `--session-id ${id}`;
  const claude = [
    `${programWord("claude", options.launch)} -p`,
    ...launchWords(options.launch),
    "--input-format stream-json",
    "--output-format stream-json",
    "--verbose",
    ...permissionFlags(permissionMode),
    ...slugFlag("--model", "model", modelWithContext(model, contextWindow)),
    ...slugFlag("--effort", "effort", effort),
    ...(name === undefined ? [] : [`--name ${shellQuote(name)}`]),
    ...mcpConfigFlag(mcpServers),
    ...(fast === true ? [`--settings ${shellQuote(JSON.stringify({ fastMode: true }))}`] : []),
    idFlag,
  ].join(" ");
  return inFolder(cwd, claude);
}

/** How much of a session's file the saved cost is looked for in: the CLI appends it as its process exits, so on a
 * resume the last one sits behind the previous turn's few closing lines, and a file of any length costs one read. */
export const SAVED_SPEND_TAIL_BYTES = 8 * 1024 * 1024;

/** Prints the session's saved running cost ahead of a resumed turn's CLI: Claude Code appends its totals to the
 * session's file as cost-state lines, and a resume carries the last one into every result's total_cost_usd. */
export function savedSpendCommand(o: { configDir: string; sessionId: string }): string {
  const file = `${shellQuote(`${o.configDir}/projects`)}/*/${shellQuote(`${o.sessionId}.jsonl`)}`;
  return `wsp_saved=$(ls -1td ${file} 2>/dev/null | head -n 1); [ -z "$wsp_saved" ] || tail -c ${SAVED_SPEND_TAIL_BYTES} "$wsp_saved" | grep -F ${shellQuote('"type":"cost-state"')} | tail -n 1; `;
}

/**
 * One line of the stdin channel: a user message in the CLI's stream-json input shape. Images ride the same message as
 * base64 content blocks ahead of the text, the shape the CLI took on 2.1.263 (measured 2026-09-08: a 64px block sent
 * this way came back described), so nothing has to land on the machine for this harness.
 */
export function userMessageLine(text: string, sessionId: string, images: readonly TurnImage[] = []): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        ...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.bytes } })),
        { type: "text", text },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}
