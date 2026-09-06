// SPDX-License-Identifier: AGPL-3.0-only
// The catalog: every agent wsp ships and every tool agents reach for, one
// entry each, with the road it takes onto a Linux machine, its sign-in and
// status check, the global config that carries over, how it keys project
// state to a path, and whether it is on by default with the evidence behind
// that. The wizard's tables read from here; nothing here runs a command.
import { CLAUDE_CONTEXT, CODEX_CONTEXT, GEMINI_CONTEXT, HERMES_CONTEXT, OPENCODE_CONTEXT, PI_CONTEXT, type AgentContext } from "./context.js";
import { GCLOUD, KUBECTL } from "./linux-casks.js";
import { CODEX_TOML, MCP_SERVERS_JSON, OPENCODE_JSON, type McpConfig } from "./mcp.js";
import { roadModule } from "./road-modules.js";
import { CLAUDE_CONFIG_DIR, GOLDEN_SETUP, HERMES_INSTALL, MIB, NODE_RELEASES, PYTHON_INSTALL, UV_INSTALL, nodeInstallScript, type InstallRoad } from "./roads.js";
import { NO_SIGN_IN, SIGN_IN_ROWS, hasLogin, keysIdOf, keysRowOf, loginIdOf, type KeyFiles, type SignIn } from "./signin.js";

export type EntryKind = "agent" | "tool";

/** Where a default comes from: sessions with a tool call on the machine the histories were mined from (155 of them,
 * one Mac, 2026-09-05; an agent's row counts the sessions it ran), the count of the five published lab sandbox
 * images that ship the tool, and whether a guest has run the entry's road. */
export interface Evidence {
  sessions: number;
  images: number;
  /** Unmeasured until a golden build on a guest has installed the entry by this road and its smoke passed. */
  road: "measured" | "unmeasured";
  note?: string;
}

/** One store of an agent's project state and how it is keyed to the project's absolute path; `move` is what a
 * project move has to do to it. Measured by moving a scratch project on 2026-09-05, or inferred from a file. */
export interface ProjectState {
  state: string;
  location: string;
  key: string;
  pathFields: readonly string[];
  move: string;
  status: "measured" | "inferred";
}

interface EntryBase {
  id: string;
  name: string;
  kind: EntryKind;
  /** The command the install puts on PATH. */
  bin: string;
  installRoad: InstallRoad;
  /** Agents: the lowest Node major the package's engines field accepts; absent when it declares none. */
  node?: number;
  signIn: SignIn;
  /** Global config that travels with the entry; an allowlist, since login files sit beside it. */
  configPaths: readonly string[];
  /** Config the entry rewrites while it runs: it travels, and never decides whether a golden is the same golden. */
  volatile?: readonly string[];
  source: Evidence;
  /** Bytes on the machine where measured. */
  size?: number;
}

/** The session store formats a reader exists for; the collector registers one reader per format. */
export const HISTORY_FORMATS = ["claude-jsonl", "codex-rollout", "hermes-sqlite"] as const;
export type HistoryFormat = (typeof HISTORY_FORMATS)[number];

/** Where an agent keeps its session histories on the computer and in which format: transcripts under a directory
 * or one database file. Only tool names and command words are ever read from them, never a line's content. */
export interface SessionHistory {
  format: HistoryFormat;
  /** `~/`-relative. */
  root: string;
}

/** An agent is never on by default: the wizard ticks the ones found on the Mac. */
export interface AgentEntry extends EntryBase {
  kind: "agent";
  /** The directory the projectState rows sit under, relative to the home directory of the computer the agent ran on. */
  stateHome: string;
  /** Where that directory is on the guest when it is not stateHome under the guest's home, absolute. */
  guestStateHome?: string;
  /** The variable that points the agent at guestStateHome; a golden with the agent carries it in its envs. */
  stateHomeEnv?: string;
  /** Every store that holds the project's path. */
  projectState: readonly ProjectState[];
  /** Absent while the agent's session format has no reader: its history reads as none. */
  history?: SessionHistory;
  /** Where the agent on this computer keeps its user-wide MCP servers and how one is named there, per its own docs;
   * absent when the catalog knows no such file for it, and wsp's server is then added by hand. */
  mcp?: McpConfig;
  /** How the agent loads the machine context on the guest; absent, it gets no hook and no skill there. */
  context?: AgentContext;
}

export interface ToolEntry extends EntryBase {
  kind: "tool";
  defaultOn: boolean;
  /** On every golden from the base stage, whatever the Mac has; the floor runs these in catalog order. */
  floor: boolean;
  /** The floor row a script road runs on top of, by id; the npm and apt roads say it themselves. */
  after?: string;
  /** Commands that come along with this row and have a version of their own. */
  brings?: readonly { bin: string; version: string }[];
  /** Package names a recipe's tools row may carry for this same tool, besides its id, its command and its road's argument. */
  covers?: readonly string[];
  /** The major the floor pins, with the tool's plain name: a Mac on another major hears both in the covered row's note. */
  major?: { name: string; version: string };
}

export type CatalogEntry = AgentEntry | ToolEntry;

/** Cellar sizes on the Linux builder, as brew printed them after each pour on 2026-09-05; the Mac's Cellar
 * stands in for the rest, and for these two llvm builds it was a gigabyte short. */
export const LINUX_FORMULA_MIB: Readonly<Record<string, number>> = {
  "llvm@21": 2560,
  "llvm@20": 2458,
  openjdk: 412,
  "openjdk@21": 343,
  "openjdk@17": 316,
  go: 251,
  "firebase-cli": 262,
  gradle: 220,
  zig: 214,
  "zig@0.15": 200,
  swiftlint: 169,
  mongosh: 156,
  binutils: 135,
  beads: 138,
  logcli: 121,
  node: 113,
  rclone: 110,
  "node@24": 106,
  "icu4c@78": 94,
  goreleaser: 85,
  "python@3.14": 82,
  "python@3.12": 77,
  helm: 65,
  uv: 60,
  "helm@3": 60,
};

/** What df moved across each agent's install on the same builder: the global, its caches and whatever the
 * installer put under /root; the cache sweep after the stage gives some of it back. */
const AGENT_MIB = { claude: 208, codex: 455, gemini: 189, opencode: 673, pi: 165, hermes: 484 } as const;

/** The Node release the agents stage puts under /usr/local when the base's major is under their floor. */
export const NODE_BYTES = 250 * MIB;

const brew = (formula: string): { installRoad: InstallRoad; size?: number } => {
  const mib = LINUX_FORMULA_MIB[formula];
  return { installRoad: { road: "brew", formula }, ...(mib !== undefined ? { size: mib * MIB } : {}) };
};
const apt = (...packages: string[]): InstallRoad => ({ road: "apt", packages });
const npm = (pkg: string, version?: string): InstallRoad => ({ road: "npm", package: pkg, ...(version !== undefined ? { version } : {}) });
/** A release road; `go` is the repository's main package for the fall-through, left off when it has none. */
const github = (repo: string, go?: string): InstallRoad => ({ road: "release", repo, ...(go !== undefined ? { go } : {}) });
const tool = { kind: "tool", configPaths: [], floor: false } as const;
const agent = (id: keyof typeof AGENT_MIB) => ({ id, kind: "agent", bin: id, size: AGENT_MIB[id] * MIB }) as const;

export const CATALOG: readonly CatalogEntry[] = [
  // --- agents: the six whose project state a move can follow -------------------------------------------------------
  {
    ...agent("claude"),
    stateHome: ".claude",
    guestStateHome: CLAUDE_CONFIG_DIR,
    stateHomeEnv: "CLAUDE_CONFIG_DIR",
    name: "Claude Code",
    context: CLAUDE_CONTEXT,
    installRoad: { road: "script", script: GOLDEN_SETUP },
    signIn: SIGN_IN_ROWS.claude,
    // https://docs.claude.com/en/docs/claude-code/mcp (user scope; project scope lives in each repo's .mcp.json)
    mcp: { format: MCP_SERVERS_JSON, files: ["~/.claude.json"], scope: "user scope and your home folder", httpAuth: "its sign-in is kept with the Claude Code login" },
    configPaths: [
      "~/.claude/settings.json", "~/.claude/CLAUDE.md", "~/.claude/skills", "~/.claude/agents", "~/.claude/commands",
      "~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json",
    ],
    // ~/.claude.json holds per-project state and caches rewritten on every run; the plugin indexes carry lastUpdated stamps.
    volatile: ["~/.claude/plugins/installed_plugins.json", "~/.claude/plugins/known_marketplaces.json", "~/.claude.json"],
    projectState: [
      { state: "session transcripts", location: "projects/KEY/SESSIONID.jsonl and projects/KEY/SESSIONID/", key: "the resolved path with every character outside A-Z a-z 0-9 replaced by a dash", pathFields: ["cwd on every message line"], move: "rename the KEY directory; rewriting cwd is optional", status: "measured" },
      { state: "auto memory", location: "projects/KEY/memory/", key: "the same KEY", pathFields: [], move: "comes along with the directory rename", status: "measured" },
      { state: "per-project settings", location: "~/.claude.json, the projects object", key: "the plain resolved path as the JSON key", pathFields: ["the key"], move: "rename the key", status: "inferred" },
      { state: "prompt history", location: "history.jsonl", key: "one line per prompt", pathFields: ["project"], move: "rewrite the field", status: "inferred" },
    ],
    history: { format: "claude-jsonl", root: "~/.claude/projects" },
    source: { sessions: 149, images: 1, road: "measured" },
  },
  {
    ...agent("codex"),
    stateHome: ".codex",
    name: "Codex",
    context: CODEX_CONTEXT,
    installRoad: npm("@openai/codex", "0.153.0"),
    node: 16,
    signIn: SIGN_IN_ROWS.codex,
    // https://developers.openai.com/codex/config-basic (project scope is a trusted repo's .codex/config.toml)
    mcp: { format: CODEX_TOML, files: ["~/.codex/config.toml"], scope: "user scope" },
    configPaths: ["~/.codex/config.toml", "~/.codex/AGENTS.md", "~/.codex/prompts", "~/.codex/skills"],
    projectState: [
      { state: "rollout transcript", location: "sessions/YYYY/MM/DD/rollout-TIMESTAMP-THREADID.jsonl", key: "by date and thread id, not by path", pathFields: ["cwd in the session_meta payload and on per-turn lines"], move: "rewrite cwd", status: "measured" },
      { state: "thread index", location: "state_5.sqlite, table threads", key: "one row per thread id", pathFields: ["cwd", "rollout_path"], move: "update threads set cwd; rollout_path changes only if CODEX_HOME itself moves", status: "measured" },
      { state: "trust", location: "config.toml, table [projects.\"PATH\"]", key: "the quoted resolved path as the TOML table name", pathFields: ["the table name"], move: "rename the table", status: "inferred" },
      { state: "memories", location: "memories/rollout_summaries/*.md and memories/MEMORY.md", key: "global files", pathFields: ["cwd: and path: lines in each summary", "applies_to: cwd=PATH lines in MEMORY.md"], move: "rewrite if memories should follow the project", status: "inferred" },
    ],
    history: { format: "codex-rollout", root: "~/.codex/sessions" },
    source: { sessions: 5, images: 1, road: "measured" },
  },
  {
    ...agent("gemini"),
    stateHome: ".gemini",
    name: "Gemini CLI",
    context: GEMINI_CONTEXT,
    installRoad: npm("@google/gemini-cli", "0.58.0"),
    node: 20,
    signIn: SIGN_IN_ROWS.gemini,
    // https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md (project scope is a repo's .gemini/settings.json)
    mcp: { format: MCP_SERVERS_JSON, files: ["~/.gemini/settings.json"], scope: "user scope" },
    configPaths: ["~/.gemini/settings.json", "~/.gemini/GEMINI.md", "~/.gemini/commands"],
    projectState: [
      { state: "project registry", location: "projects.json", key: "{\"projects\": {\"PATH\": \"SLUG\"}}; SLUG is the folder basename, deduplicated", pathFields: ["the key"], move: "rewrite the key, keep the slug", status: "measured" },
      { state: "project temp dir", location: "tmp/SLUG/ with chats/, logs/ and .project_root", key: "the slug from the registry", pathFields: [".project_root"], move: "rewrite .project_root", status: "measured" },
      { state: "shell history", location: "history/SLUG/ with .project_root", key: "the same slug", pathFields: [".project_root"], move: "rewrite .project_root", status: "measured" },
      { state: "chat files", location: "tmp/SLUG/chats/session-TIMESTAMP-ID8.jsonl", key: "by slug directory", pathFields: ["projectHash in the header line, the sha256 hex of the resolved path", "the workspace path as text in the first user message"], move: "optional; neither listing nor resume checks it", status: "measured" },
      { state: "trust", location: "trustedFolders.json", key: "the resolved path to a trust level", pathFields: ["the key"], move: "rewrite the key", status: "inferred" },
    ],
    source: { sessions: 0, images: 0, road: "measured" },
  },
  {
    ...agent("opencode"),
    stateHome: ".local/share/opencode",
    name: "OpenCode",
    context: OPENCODE_CONTEXT,
    installRoad: npm("opencode-ai", "1.18.27"),
    signIn: SIGN_IN_ROWS.opencode,
    // https://opencode.ai/docs/mcp-servers/ (project scope is a repo's opencode.json)
    mcp: { format: OPENCODE_JSON, files: ["~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc"], scope: "user scope" },
    configPaths: [
      "~/.config/opencode/opencode.json", "~/.config/opencode/opencode.jsonc", "~/.config/opencode/AGENTS.md", "~/.config/opencode/package.json",
      "~/.config/opencode/agents", "~/.config/opencode/commands", "~/.config/opencode/plugins", "~/.config/opencode/skills", "~/.config/opencode/themes",
    ],
    projectState: [
      { state: "project", location: "opencode.db, table project", key: "id is the git root commit hash; \"global\" for folders outside git", pathFields: ["worktree", "sandboxes"], move: "update project set worktree, clear sandboxes", status: "measured" },
      { state: "project directories", location: "table project_directory", key: "(project_id, directory)", pathFields: ["directory"], move: "update the row", status: "measured" },
      { state: "sessions", location: "table session", key: "id ses_..., project_id", pathFields: ["directory"], move: "update session set directory", status: "measured" },
    ],
    source: { sessions: 0, images: 0, road: "measured" },
  },
  {
    ...agent("pi"),
    stateHome: ".pi/agent",
    name: "Pi",
    context: PI_CONTEXT,
    installRoad: { road: "npm", package: "@earendil-works/pi-coding-agent", version: "0.84.4", ignoreScripts: true },
    node: 22,
    signIn: SIGN_IN_ROWS.pi,
    // models.json stays: a provider entry may carry a literal apiKey. trust.json stays: it keys on this laptop's absolute project paths.
    configPaths: [
      "~/.pi/agent/settings.json", "~/.pi/agent/keybindings.json", "~/.pi/agent/AGENTS.md", "~/.pi/agent/SYSTEM.md", "~/.pi/agent/APPEND_SYSTEM.md",
      "~/.pi/agent/prompts", "~/.pi/agent/skills", "~/.pi/agent/extensions", "~/.pi/agent/themes",
    ],
    projectState: [
      { state: "sessions", location: "sessions/KEY/TIMESTAMP_SESSIONID.jsonl", key: "two dashes, the resolved path without its leading slash with every slash, backslash and colon replaced by a dash, two dashes; dots and underscores kept", pathFields: ["cwd in the header line"], move: "rename the KEY directory; rewriting cwd is optional", status: "measured" },
      { state: "trust", location: "trust.json", key: "the resolved path to true; a parent folder covers its children", pathFields: ["the key"], move: "rewrite the key", status: "inferred" },
    ],
    source: { sessions: 0, images: 0, road: "measured" },
  },
  {
    ...agent("hermes"),
    stateHome: ".hermes",
    name: "Hermes Agent",
    context: HERMES_CONTEXT,
    installRoad: { road: "script", script: HERMES_INSTALL },
    signIn: SIGN_IN_ROWS.hermes,
    configPaths: ["~/.hermes/config.yaml", "~/.hermes/SOUL.md", "~/.hermes/memories", "~/.hermes/skills", "~/.hermes/cron", "~/.hermes/hooks"],
    projectState: [
      { state: "sessions", location: "state.db, table sessions", key: "id like 20260906_033144_55e3e2", pathFields: ["cwd", "git_repo_root"], move: "update sessions set cwd and git_repo_root", status: "measured" },
      { state: "projects registry", location: "projects.db: projects.primary_path, project_folders.path, discovered_repos.root", key: "resolved path columns", pathFields: ["primary_path", "path", "root"], move: "update the rows", status: "inferred" },
    ],
    history: { format: "hermes-sqlite", root: "~/.hermes/state.db" },
    source: { sessions: 1, images: 0, road: "measured" },
  },

  // --- tools on by default: both sources agree or one is overwhelming --------------------------------------------
  // The floor rows first, in the order the base stage installs them: a row waits only on rows above it.
  { ...tool, id: "node", name: "Node 22 with npm", bin: "node", installRoad: { road: "script", script: nodeInstallScript(22, NODE_RELEASES[22]) }, floor: true, covers: ["node@22"], major: { name: "Node", version: "22" }, brings: [{ bin: "npm", version: "npm --version" }], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 73, images: 5, road: "measured" }, size: NODE_BYTES },
  { ...tool, id: "pnpm", name: "pnpm", bin: "pnpm", installRoad: npm("pnpm", "11.9.0"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 36, images: 3, road: "unmeasured" } },
  { ...tool, id: "uv", name: "uv", bin: "uv", installRoad: { road: "script", script: UV_INSTALL }, floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 46, images: 3, road: "unmeasured" } },
  { ...tool, id: "python", name: "Python 3.12", bin: "python3", installRoad: { road: "script", script: PYTHON_INSTALL }, floor: true, after: "uv", covers: ["python@3.12"], major: { name: "Python", version: "3.12" }, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 107, images: 4, road: "unmeasured" } },
  { ...tool, id: "git", name: "git", bin: "git", installRoad: apt("git"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 118, images: 5, road: "unmeasured" } },
  { ...tool, id: "jq", name: "jq", bin: "jq", installRoad: apt("jq"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 17, images: 5, road: "unmeasured" } },
  { ...tool, id: "ripgrep", name: "ripgrep", bin: "rg", installRoad: apt("ripgrep"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 10, images: 4, road: "unmeasured" } },
  { ...tool, id: "curl", name: "curl", bin: "curl", installRoad: apt("curl"), floor: true, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 87, images: 4, road: "unmeasured" } },
  { ...tool, id: "docker", name: "Docker engine and compose", bin: "docker", installRoad: apt("docker.io", "docker-compose-v2"), floor: true, covers: ["docker-compose"], brings: [{ bin: "docker compose", version: "docker compose version" }], signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 30, images: 3, road: "unmeasured" } },
  // gh has no pinned release yet and agent-browser waits on a second data point: default-on through the tools stage.
  { ...tool, id: "gh", name: "GitHub CLI", bin: "gh", installRoad: github("cli/cli", "github.com/cli/cli/v2/cmd/gh"), signIn: SIGN_IN_ROWS.gh, defaultOn: true, source: { sessions: 100, images: 3, road: "unmeasured" } },
  { ...tool, id: "agent-browser", name: "agent-browser", bin: "agent-browser", installRoad: npm("agent-browser", "0.31.1"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 45, images: 0, road: "unmeasured", note: "sessions counted on one Mac only; on by default for this user until a second data point" } },

  // --- tools on request ---------------------------------------------------------------------------------------------
  { ...tool, id: "go", name: "Go", bin: "go", ...brew("go"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 9, images: 4, road: "measured" } },
  { ...tool, id: "rust", name: "Rust with cargo", bin: "cargo", ...brew("rust"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 4, images: 3, road: "unmeasured" } },
  { ...tool, id: "java", name: "Java 21", bin: "java", ...brew("openjdk@21"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "measured" } },
  { ...tool, id: "maven", name: "Maven", bin: "mvn", ...brew("maven"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "unmeasured" } },
  { ...tool, id: "gradle", name: "Gradle", bin: "gradle", ...brew("gradle"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "measured" } },
  { ...tool, id: "wrangler", name: "Cloudflare Wrangler", bin: "wrangler", installRoad: npm("wrangler"), covers: ["cloudflare-wrangler"], signIn: SIGN_IN_ROWS.wrangler, defaultOn: false, source: { sessions: 3, images: 0, road: "unmeasured" } },
  { ...tool, id: "cloudflared", name: "cloudflared", bin: "cloudflared", installRoad: github("cloudflare/cloudflared", "github.com/cloudflare/cloudflared/cmd/cloudflared"), signIn: SIGN_IN_ROWS.cloudflared, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "gcloud", name: "Google Cloud CLI", bin: "gcloud", installRoad: { road: "vendor", cask: GCLOUD }, signIn: SIGN_IN_ROWS.gcloud, defaultOn: false, source: { sessions: 4, images: 0, road: "measured" } },
  { ...tool, id: "kubectl", name: "kubectl", bin: "kubectl", installRoad: { road: "vendor", cask: KUBECTL }, covers: ["kubernetes-cli"], signIn: SIGN_IN_ROWS.kubectl, defaultOn: false, source: { sessions: 1, images: 1, road: "unmeasured" } },
  { ...tool, id: "aws", name: "AWS CLI", bin: "aws", ...brew("awscli"), signIn: SIGN_IN_ROWS.aws, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "vercel", name: "Vercel CLI", bin: "vercel", installRoad: npm("vercel"), signIn: SIGN_IN_ROWS.vercel, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "netlify", name: "Netlify CLI", bin: "netlify", installRoad: npm("netlify-cli"), signIn: SIGN_IN_ROWS.netlify, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "fly", name: "flyctl", bin: "fly", installRoad: github("superfly/flyctl", "github.com/superfly/flyctl"), signIn: SIGN_IN_ROWS.fly, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "supabase", name: "Supabase CLI", bin: "supabase", installRoad: github("supabase/cli"), signIn: SIGN_IN_ROWS.supabase, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "railway", name: "Railway CLI", bin: "railway", installRoad: npm("@railway/cli"), signIn: SIGN_IN_ROWS.railway, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "doppler", name: "Doppler CLI", bin: "doppler", installRoad: github("DopplerHQ/cli", "github.com/DopplerHQ/cli"), signIn: SIGN_IN_ROWS.doppler, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  // 1Password publishes the CLI through its own apt repository, which the road has to add first.
  { ...tool, id: "op", name: "1Password CLI", bin: "op", installRoad: apt("1password-cli"), signIn: SIGN_IN_ROWS.op, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "ffmpeg", name: "ffmpeg", bin: "ffmpeg", installRoad: apt("ffmpeg"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "yq", name: "yq", bin: "yq", installRoad: github("mikefarah/yq", "github.com/mikefarah/yq/v4"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "git-lfs", name: "Git LFS", bin: "git-lfs", installRoad: apt("git-lfs"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 2, road: "unmeasured" } },
  { ...tool, id: "tmux", name: "tmux", bin: "tmux", installRoad: apt("tmux"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
];

export const CATALOG_AGENTS: readonly AgentEntry[] = CATALOG.filter((e): e is AgentEntry => e.kind === "agent");

const firstAgent = CATALOG_AGENTS[0];
if (firstAgent === undefined) throw new Error("the catalog has no agent");
/** The agent a thread runs when none is named and the composer's first pick: the catalog's first agent. */
export const DEFAULT_AGENT: AgentEntry = firstAgent;
export const CATALOG_TOOLS: readonly ToolEntry[] = CATALOG.filter((e): e is ToolEntry => e.kind === "tool");

/** The envs a golden carries for an agent on it: the variable that points it at its state home on the guest. */
export function guestEnv(a: AgentEntry): Record<string, string> {
  return a.stateHomeEnv !== undefined && a.guestStateHome !== undefined ? { [a.stateHomeEnv]: a.guestStateHome } : {};
}

/** An agent entry whose MCP config the catalog knows. */
export type McpAgent = AgentEntry & { mcp: McpConfig };
/** The agents whose config the catalog knows how to read a server from and place one in, in catalog order. */
export const MCP_AGENTS: readonly McpAgent[] = CATALOG_AGENTS.filter((a): a is McpAgent => a.mcp !== undefined);

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(CATALOG.map(e => [e.id, e]));

/** What every golden gets in its base stage, whatever the Mac has: the entries flagged for the floor, in catalog order. */
export const BASE_FLOOR: readonly ToolEntry[] = CATALOG.filter((e): e is ToolEntry => e.kind === "tool" && e.floor);

/** The floor row an entry's install runs on top of: what its road says (the npm road on node, an apt package on the
 * index read once), else what the entry names (a script on `after`). */
export function installAfter(e: ToolEntry): string | undefined {
  return roadModule(e.installRoad).after ?? e.after;
}

const roadNames = (road: InstallRoad): readonly string[] => roadModule(road).names(road);

/** The catalog tool a package name the collector wrote stands for: by id, by the command it puts on PATH, by its
 * road's own name for it, by a name it covers, or by a command it brings along; or nothing. */
export function catalogToolFor(pkg: string): ToolEntry | undefined {
  return CATALOG_TOOLS.find(e => e.id === pkg || e.bin === pkg || roadNames(e.installRoad).includes(pkg) || (e.covers ?? []).includes(pkg) || (e.brings ?? []).some(b => b.bin === pkg));
}

/** The base row a recipe's tools row stands for, or nothing when the tool is not on the floor. */
export function baseEntryFor(pkg: string): ToolEntry | undefined {
  const e = catalogToolFor(pkg);
  return e?.floor === true ? e : undefined;
}

/** What a ticked row the floor covers says in the build: the base row's name, or both majors when this Mac's differs
 * from the one the floor pins (as many dot-separated parts of the Mac's version as the pin names). */
export function baseNote(e: ToolEntry, macVersion: string | undefined): string {
  const own = `${e.name} is part of the base`;
  if (e.major === undefined || macVersion === undefined) return own;
  const mac = macVersion.replace(/^v/, "").split(".").slice(0, e.major.version.split(".").length).join(".");
  return mac === e.major.version ? own : `${e.major.name} ${e.major.version} is part of the base; this Mac runs ${e.major.name} ${mac}`;
}

/** The entry by its id, or nothing. */
export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** An entry as the catalog names it; an id the catalog does not know reads as itself. */
export function agentName(id: string): string {
  return catalogEntry(id)?.name ?? id;
}

/** One row the Sign-ins screen can show, under the login id the collector files it: an entry's own sign-in (a
 * login to run, or a note about having none), or the keys row beside a login whose key files travel only by copy. */
export interface LoginRow {
  id: string;
  entry: CatalogEntry;
  signIn: SignIn;
  /** The key files this row copies; absent on the login itself. */
  keys?: KeyFiles;
}

export const LOGIN_ROWS: readonly LoginRow[] = CATALOG.flatMap((e): LoginRow[] => {
  const s = e.signIn;
  if (!hasLogin(s)) return s.note !== undefined ? [{ id: loginIdOf(e.id), entry: e, signIn: s }] : [];
  return [{ id: loginIdOf(e.id), entry: e, signIn: s }, ...(s.keys === undefined ? [] : [{ id: keysIdOf(e.id), entry: e, signIn: keysRowOf(s.keys, s.status), keys: s.keys }])];
});

const LOGIN_ROW_BY_ID: ReadonlyMap<string, LoginRow> = new Map(LOGIN_ROWS.map(r => [r.id, r]));

/** The sign-in row filed under a login id, or nothing for a tool the catalog does not know. */
export function loginRow(id: string): LoginRow | undefined {
  return LOGIN_ROW_BY_ID.get(id);
}

/** Exits 0 once an entry is on the machine. */
export function smokeOf(e: CatalogEntry): string {
  return `${e.bin} --version`;
}

/** The bash line an entry's road runs on the guest, from the road's module; an entry whose road has nothing to run is a
 * catalog error, since every entry promises its command. */
export function installLine(e: CatalogEntry): string {
  const line = roadModule(e.installRoad).install(e.installRoad, e.bin);
  if (typeof line !== "string") throw new Error(`${e.id}: ${line.note}`);
  return line;
}
