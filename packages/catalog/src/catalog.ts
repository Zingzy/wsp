// SPDX-License-Identifier: AGPL-3.0-only
// The catalog: every agent wsp ships and every tool agents reach for, one
// entry each, with the road it takes onto a Linux machine, its sign-in and
// status check, the global config that carries over, how it keys project
// state to a path, and whether it is on by default with the evidence behind
// that. The wizard's tables read from here; nothing here runs a command.
import { GCLOUD, KUBECTL } from "./linux-casks.js";
import { GOLDEN_SETUP, HERMES_INSTALL, MIB, NODE_RELEASES, UV_INSTALL, nodeInstallScript, type InstallRoad } from "./roads.js";
import { NO_SIGN_IN, SIGN_IN_ROWS, type SignIn } from "./signin.js";

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

/** An agent is never on by default: the wizard ticks the ones found on the Mac. */
export interface AgentEntry extends EntryBase {
  kind: "agent";
  /** Every store that holds the project's path. */
  projectState: readonly ProjectState[];
}

export interface ToolEntry extends EntryBase {
  kind: "tool";
  defaultOn: boolean;
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
const github = (repo: string): InstallRoad => ({ road: "release", asset: { github: repo } });
const tool = { kind: "tool", configPaths: [] } as const;
const agent = (id: keyof typeof AGENT_MIB) => ({ id, kind: "agent", bin: id, size: AGENT_MIB[id] * MIB }) as const;

export const CATALOG: readonly CatalogEntry[] = [
  // --- agents: the six whose project state a move can follow -------------------------------------------------------
  {
    ...agent("claude"),
    name: "Claude Code",
    installRoad: { road: "script", script: GOLDEN_SETUP },
    signIn: SIGN_IN_ROWS.claude,
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
    source: { sessions: 149, images: 1, road: "measured" },
  },
  {
    ...agent("codex"),
    name: "Codex",
    installRoad: npm("@openai/codex", "0.153.0"),
    node: 16,
    signIn: SIGN_IN_ROWS.codex,
    configPaths: ["~/.codex/config.toml", "~/.codex/AGENTS.md", "~/.codex/prompts", "~/.codex/skills"],
    projectState: [
      { state: "rollout transcript", location: "sessions/YYYY/MM/DD/rollout-TIMESTAMP-THREADID.jsonl", key: "by date and thread id, not by path", pathFields: ["cwd in the session_meta payload and on per-turn lines"], move: "rewrite cwd", status: "measured" },
      { state: "thread index", location: "state_5.sqlite, table threads", key: "one row per thread id", pathFields: ["cwd", "rollout_path"], move: "update threads set cwd; rollout_path changes only if CODEX_HOME itself moves", status: "measured" },
      { state: "trust", location: "config.toml, table [projects.\"PATH\"]", key: "the quoted resolved path as the TOML table name", pathFields: ["the table name"], move: "rename the table", status: "inferred" },
      { state: "memories", location: "memories/rollout_summaries/*.md and memories/MEMORY.md", key: "global files", pathFields: ["cwd: and path: lines in each summary", "applies_to: cwd=PATH lines in MEMORY.md"], move: "rewrite if memories should follow the project", status: "inferred" },
    ],
    source: { sessions: 5, images: 1, road: "measured" },
  },
  {
    ...agent("gemini"),
    name: "Gemini CLI",
    installRoad: npm("@google/gemini-cli", "0.58.0"),
    node: 20,
    signIn: SIGN_IN_ROWS.gemini,
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
    name: "OpenCode",
    installRoad: npm("opencode-ai", "1.18.27"),
    signIn: SIGN_IN_ROWS.opencode,
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
    name: "Pi",
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
    name: "Hermes Agent",
    installRoad: { road: "script", script: HERMES_INSTALL },
    signIn: SIGN_IN_ROWS.hermes,
    configPaths: ["~/.hermes/config.yaml", "~/.hermes/SOUL.md", "~/.hermes/memories", "~/.hermes/skills", "~/.hermes/cron", "~/.hermes/hooks"],
    projectState: [
      { state: "sessions", location: "state.db, table sessions", key: "id like 20260906_033144_55e3e2", pathFields: ["cwd", "git_repo_root"], move: "update sessions set cwd and git_repo_root", status: "measured" },
      { state: "projects registry", location: "projects.db: projects.primary_path, project_folders.path, discovered_repos.root", key: "resolved path columns", pathFields: ["primary_path", "path", "root"], move: "update the rows", status: "inferred" },
    ],
    source: { sessions: 1, images: 0, road: "measured" },
  },

  // --- tools on by default: both sources agree or one is overwhelming --------------------------------------------
  { ...tool, id: "git", name: "git", bin: "git", installRoad: apt("git"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 118, images: 5, road: "unmeasured" } },
  { ...tool, id: "gh", name: "GitHub CLI", bin: "gh", installRoad: github("cli/cli"), signIn: SIGN_IN_ROWS.gh, defaultOn: true, source: { sessions: 100, images: 3, road: "unmeasured" } },
  { ...tool, id: "curl", name: "curl", bin: "curl", installRoad: apt("curl"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 87, images: 4, road: "unmeasured" } },
  { ...tool, id: "jq", name: "jq", bin: "jq", installRoad: apt("jq"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 17, images: 5, road: "unmeasured" } },
  { ...tool, id: "ripgrep", name: "ripgrep", bin: "rg", installRoad: apt("ripgrep"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 10, images: 4, road: "unmeasured" } },
  { ...tool, id: "node", name: "Node 22 with npm", bin: "node", installRoad: { road: "script", script: nodeInstallScript(22, NODE_RELEASES[22]) }, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 73, images: 5, road: "measured" }, size: NODE_BYTES },
  { ...tool, id: "pnpm", name: "pnpm", bin: "pnpm", installRoad: npm("pnpm", "11.9.0"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 36, images: 3, road: "unmeasured" } },
  { ...tool, id: "python", name: "Python 3.12", bin: "python3", ...brew("python@3.12"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 107, images: 4, road: "unmeasured" } },
  { ...tool, id: "uv", name: "uv", bin: "uv", installRoad: { road: "script", script: UV_INSTALL }, signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 46, images: 3, road: "unmeasured" } },
  { ...tool, id: "docker", name: "Docker engine and compose", bin: "docker", installRoad: apt("docker.io", "docker-compose-v2"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 30, images: 3, road: "unmeasured" } },
  { ...tool, id: "agent-browser", name: "agent-browser", bin: "agent-browser", installRoad: npm("agent-browser", "0.31.1"), signIn: NO_SIGN_IN, defaultOn: true, source: { sessions: 45, images: 0, road: "unmeasured", note: "sessions counted on one Mac only; on by default for this user until a second data point" } },

  // --- tools on request ---------------------------------------------------------------------------------------------
  { ...tool, id: "go", name: "Go", bin: "go", ...brew("go"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 9, images: 4, road: "measured" } },
  { ...tool, id: "rust", name: "Rust with cargo", bin: "cargo", ...brew("rust"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 4, images: 3, road: "unmeasured" } },
  { ...tool, id: "java", name: "Java 21", bin: "java", ...brew("openjdk@21"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "measured" } },
  { ...tool, id: "maven", name: "Maven", bin: "mvn", ...brew("maven"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "unmeasured" } },
  { ...tool, id: "gradle", name: "Gradle", bin: "gradle", ...brew("gradle"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 4, road: "measured" } },
  { ...tool, id: "wrangler", name: "Cloudflare Wrangler", bin: "wrangler", installRoad: npm("wrangler"), signIn: SIGN_IN_ROWS.wrangler, defaultOn: false, source: { sessions: 3, images: 0, road: "unmeasured" } },
  { ...tool, id: "cloudflared", name: "cloudflared", bin: "cloudflared", installRoad: github("cloudflare/cloudflared"), signIn: SIGN_IN_ROWS.cloudflared, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "gcloud", name: "Google Cloud CLI", bin: "gcloud", installRoad: { road: "release", asset: { vendor: GCLOUD } }, signIn: SIGN_IN_ROWS.gcloud, defaultOn: false, source: { sessions: 4, images: 0, road: "measured" } },
  { ...tool, id: "kubectl", name: "kubectl", bin: "kubectl", installRoad: { road: "release", asset: { vendor: KUBECTL } }, signIn: SIGN_IN_ROWS.kubectl, defaultOn: false, source: { sessions: 1, images: 1, road: "unmeasured" } },
  { ...tool, id: "aws", name: "AWS CLI", bin: "aws", ...brew("awscli"), signIn: SIGN_IN_ROWS.aws, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "vercel", name: "Vercel CLI", bin: "vercel", installRoad: npm("vercel"), signIn: SIGN_IN_ROWS.vercel, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "netlify", name: "Netlify CLI", bin: "netlify", installRoad: npm("netlify-cli"), signIn: SIGN_IN_ROWS.netlify, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "fly", name: "flyctl", bin: "fly", installRoad: github("superfly/flyctl"), signIn: SIGN_IN_ROWS.fly, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "supabase", name: "Supabase CLI", bin: "supabase", installRoad: github("supabase/cli"), signIn: SIGN_IN_ROWS.supabase, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "railway", name: "Railway CLI", bin: "railway", installRoad: npm("@railway/cli"), signIn: SIGN_IN_ROWS.railway, defaultOn: false, source: { sessions: 1, images: 0, road: "unmeasured" } },
  { ...tool, id: "doppler", name: "Doppler CLI", bin: "doppler", installRoad: github("DopplerHQ/cli"), signIn: SIGN_IN_ROWS.doppler, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  // 1Password publishes the CLI through its own apt repository, which the road has to add first.
  { ...tool, id: "op", name: "1Password CLI", bin: "op", installRoad: apt("1password-cli"), signIn: SIGN_IN_ROWS.op, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "ffmpeg", name: "ffmpeg", bin: "ffmpeg", installRoad: apt("ffmpeg"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 0, road: "unmeasured" } },
  { ...tool, id: "yq", name: "yq", bin: "yq", installRoad: github("mikefarah/yq"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
  { ...tool, id: "git-lfs", name: "Git LFS", bin: "git-lfs", installRoad: apt("git-lfs"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 2, road: "unmeasured" } },
  { ...tool, id: "tmux", name: "tmux", bin: "tmux", installRoad: apt("tmux"), signIn: NO_SIGN_IN, defaultOn: false, source: { sessions: 0, images: 3, road: "unmeasured" } },
];

export const CATALOG_AGENTS: readonly AgentEntry[] = CATALOG.filter((e): e is AgentEntry => e.kind === "agent");

const BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(CATALOG.map(e => [e.id, e]));

/** The entry by its id, or nothing. */
export function catalogEntry(id: string): CatalogEntry | undefined {
  return BY_ID.get(id);
}

/** Exits 0 once an entry is on the machine. */
export function smokeOf(e: CatalogEntry): string {
  return `${e.bin} --version`;
}

/** The bash line an agent's road runs; only the npm and script roads install an agent, and an npm agent is pinned. */
export function agentInstallLine(e: CatalogEntry): string {
  const road = e.installRoad;
  switch (road.road) {
    case "npm":
      if (road.version === undefined) throw new Error(`${e.id} names no version to pin`);
      return `npm install -g ${road.ignoreScripts === true ? "--ignore-scripts " : ""}${road.package}@${road.version}`;
    case "script":
      return road.script;
    default:
      throw new Error(`${e.id} takes the ${road.road} road, which installs no agent`);
  }
}
