// SPDX-License-Identifier: AGPL-3.0-only
// Fixture data for the add-a-computer prototype: what this Mac has and what
// one Linux box reports, shaped the way the setup job's record will carry it.
// Nothing here reaches a host; the screens are drawn from these rows alone.
import type { PlaceView, ProjectHue, ProjectIcon, SshHostSuggestion } from "@wsp/protocol";

export const MAC_NAME = "zingzy's MacBook Pro";
export const BOX_NAME = "studio";

export const HERE: PlaceView = { id: "p_here", kind: "computer", name: "zingzy-mbp", label: MAC_NAME, mac: "macbook", default: true, present: true, shape: { cpu: 10, memMb: 16384 }, takesForks: false };
export const STUDIO: PlaceView = { id: "p_studio", kind: "computer", name: BOX_NAME, default: false, present: true, os: "Ubuntu 24.04", shape: { cpu: 8, memMb: 32768 }, diskFreeBytes: 61_000_000_000, takesForks: true };
export const SPOO: PlaceView = { id: "p_spoo", kind: "computer", name: "spoo", default: false, present: true, os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 7700 }, takesForks: true, behind: { word: "runs daemon 57, this wsp deploys 61", fix: "wsp add spoo --update", act: "update" } };
export const SPOO_MONGO: PlaceView = { id: "p_mongo", kind: "computer", name: "spoo-mongo", default: false, present: true, os: "Debian 12", shape: { cpu: 2, memMb: 4096 }, takesForks: true };
export const BOAT: PlaceView = { id: "p_boat", kind: "computer", name: "Boat", default: false, present: false, lastSeenAt: "2026-10-01T18:02:00Z", shape: { cpu: 4, memMb: 8192 }, takesForks: true };
export const DISHAPC: PlaceView = { id: "p_disha", kind: "computer", name: "dishapc", default: false, present: true, os: "Ubuntu 22.04", shape: { cpu: 4, memMb: 16384 }, takesForks: true };
export const PLACES: PlaceView[] = [HERE, SPOO, STUDIO, SPOO_MONGO, DISHAPC, BOAT];

export const SSH_HOSTS: (SshHostSuggestion & { added?: true })[] = [
  { alias: "studio", hostName: "65.21.4.12", user: "root", from: "config" },
  { alias: "oldlaptop", hostName: "oldlaptop.local", user: "zingzy", from: "config" },
  { alias: "spoo-mongo", hostName: "95.216.8.77", user: "root", from: "config" },
  { alias: "jumpbox", hostName: "jump.zingzy.dev", user: "ubuntu", from: "config" },
  { alias: "dishapc", hostName: "192.168.1.24", user: "disha", from: "config" },
  { alias: "spoo", hostName: "spoo.me", user: "root", from: "config", added: true },
];

export const HOST_KEY = { kind: "ED25519", fingerprint: "SHA256:tK3mX9Qf2bWq8vRz0YhN4cL7pJd1sE6gA5uF8oH2kIw" };

/** One row of a step as the record carries it: its state, a note and how long it took. */
export type StepState = "waiting" | "working" | "done" | "needs-you" | "failed";
export interface StepLine {
  readonly id: string;
  readonly name: string;
  readonly state: StepState;
  readonly note?: string;
  readonly ms?: number;
  /** A failure's two sentences: what happened, and what would fix it. */
  readonly said?: string;
  readonly fix?: string;
  /** A sign-in waiting on the person: the page that opened here and the code the tool printed. */
  readonly wait?: { readonly url: string; readonly code: string; readonly left: string };
  /** An item of the row that did not land, under a row that otherwise did. */
  readonly sub?: true;
}

export const CHECKS_RUNNING: StepLine[] = [
  { id: "connect", name: "Connected", state: "done", note: "root@65.21.4.12 over ssh", ms: 400 },
  { id: "root", name: "Root", state: "done", note: "Logged in as root", ms: 100 },
  { id: "system", name: "System", state: "done", note: "Ubuntu 24.04, systemd, cgroup v2", ms: 300 },
  { id: "chip", name: "Chip", state: "done", note: "x86_64", ms: 100 },
  { id: "reach", name: "Reach", state: "done", note: "studio dials back over ssh", ms: 1200 },
  { id: "disk", name: "Disk", state: "done", note: "61 GB free of 80 GB", ms: 200 },
  { id: "wsp", name: "Install wsp", state: "working", note: "7 MB daemon under systemd, then it dials back here" },
];

export const CHECKS_REFUSED: StepLine[] = [
  { id: "connect", name: "Connected", state: "done", note: "ubuntu@jump.zingzy.dev over ssh", ms: 600 },
  { id: "root", name: "Root", state: "failed", said: "jumpbox logged in as ubuntu. Root on the box is required.", fix: "Add it as root@jump.zingzy.dev, or put User root under Host jumpbox in your ssh config." },
  { id: "system", name: "System", state: "done", note: "Ubuntu 22.04, systemd, cgroup v2", ms: 300 },
  { id: "chip", name: "Chip", state: "done", note: "arm64", ms: 100 },
  { id: "reach", name: "Reach", state: "done", note: "jumpbox reaches this Mac on port 7788", ms: 900 },
  { id: "disk", name: "Disk", state: "failed", said: "1.1 GB free of 20 GB. wsp needs 1.3 GB before anything you pick.", fix: "Free some room on jumpbox and try again." },
  { id: "wsp", name: "Install wsp", state: "waiting" },
];

export interface AgentPick {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly note: string;
  readonly ticked: boolean;
  readonly signIns: readonly string[];
  readonly signIn: string;
}
export const AGENTS: AgentPick[] = [
  { id: "claude", name: "Claude Code", version: "2.1.286", note: "Signed in here with an API key.", ticked: true, signIns: ["Copy the key", "Sign in on studio", "Later"], signIn: "Copy the key" },
  { id: "codex", name: "Codex", version: "0.47.0", note: "ChatGPT Plus here, which does not travel as a token.", ticked: true, signIns: ["Sign in on studio", "Later"], signIn: "Sign in on studio" },
  { id: "opencode", name: "OpenCode", version: "1.18.18", note: "Not signed in here.", ticked: false, signIns: ["Sign in on studio", "Later"], signIn: "Sign in on studio" },
];

export interface ServerPick {
  readonly id: string;
  readonly name: string;
  readonly agents: readonly string[];
  readonly note: string;
  readonly ticked: boolean;
}
export const SERVERS: ServerPick[] = [
  { id: "wsp", name: "wsp", agents: ["claude", "codex"], note: "Its key travels with it.", ticked: true },
  { id: "context7", name: "context7", agents: ["claude", "codex"], note: "No sign-in.", ticked: true },
  { id: "gsc", name: "gsc", agents: ["claude"], note: "Signs in once on studio, in your browser here.", ticked: true },
  { id: "linear", name: "linear", agents: ["claude"], note: "Signs in once on studio, in your browser here.", ticked: true },
  { id: "playwright", name: "playwright", agents: ["claude"], note: "No sign-in.", ticked: true },
  { id: "github", name: "github", agents: ["codex"], note: "Its token travels with it.", ticked: true },
  { id: "cloudflare_observability", name: "cloudflare_observability", agents: ["claude"], note: "Signs in once on studio, in your browser here.", ticked: true },
  { id: "firecrawl", name: "firecrawl", agents: ["claude"], note: "Its key travels with it.", ticked: false },
  { id: "excalidraw", name: "excalidraw", agents: ["claude"], note: "No sign-in.", ticked: false },
];

export interface CliPick {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly via: string;
  readonly size: string;
  readonly needs?: string;
  readonly ticked: boolean;
}
export const CLIS: CliPick[] = [
  { id: "gh", name: "gh", version: "2.86.0", via: "apt", size: "40 MB", ticked: true },
  { id: "ripgrep", name: "ripgrep", version: "15.1.0", via: "apt", size: "6 MB", ticked: true },
  { id: "jq", name: "jq", version: "1.8.1", via: "apt", size: "1.2 MB", ticked: true },
  { id: "fd", name: "fd", version: "10.3.0", via: "apt", size: "4 MB", ticked: true },
  { id: "uv", name: "uv", version: "0.9.2", via: "its installer", size: "38 MB", ticked: true },
  { id: "pnpm", name: "pnpm", version: "11.9.0", via: "npm", size: "20 MB", ticked: true },
  { id: "bun", name: "bun", version: "1.3.1", via: "npm", size: "90 MB", ticked: true },
  { id: "cargo-nextest", name: "cargo-nextest", version: "0.9.98", via: "cargo", size: "24 MB", needs: "Needs build-essential, 469 MB more.", ticked: true },
  { id: "yq", name: "yq", version: "4.47.1", via: "apt", size: "10 MB", ticked: false },
];

export interface SkillPick {
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly agents: readonly string[];
  readonly ticked: boolean;
}
const skill = (name: string, agents: readonly string[] = ["claude"], from = "~/.claude/skills"): SkillPick => ({ id: name, name, from, agents, ticked: true });
export const SKILLS: SkillPick[] = [
  skill("unslop", ["claude", "codex"]),
  skill("diagnosing-bugs"),
  skill("blast-radius"),
  skill("typescript-best-practices", ["claude", "codex"]),
  skill("grilling"),
  skill("wizard"),
  skill("wsp", ["claude", "codex"], "~/.agents/skills"),
  skill("wsp-review"),
  skill("agent-pipeline"),
  skill("zingzy-design-taste"),
  skill("writing-plans"),
  skill("prototype"),
  skill("research", ["claude", "codex"]),
  skill("why"),
];
export const SKILL_COUNT = 78;

export interface PluginPick {
  readonly id: string;
  readonly name: string;
  readonly marketplace: string;
  readonly ticked: boolean;
  readonly asks?: string;
}
export const PLUGINS: PluginPick[] = [
  { id: "frontend-design", name: "frontend-design", marketplace: "claude-plugins-official", ticked: true },
  { id: "code-review", name: "code-review", marketplace: "claude-plugins-official", ticked: true },
  { id: "skill-creator", name: "skill-creator", marketplace: "claude-plugins-official", ticked: true },
  { id: "ralph-loop", name: "ralph-loop", marketplace: "claude-plugins-official", ticked: true },
  { id: "brag", name: "brag", marketplace: "hyperframes", ticked: true },
  { id: "dataviz", name: "dataviz", marketplace: "anthropic-labs", ticked: true },
  { id: "turnstile-spin", name: "turnstile-spin", marketplace: "spoo-me", ticked: true, asks: "Runs a command on install, so it is set aside. Accept it from studio's page once the box is up." },
  { id: "excalidraw-skill", name: "excalidraw-skill", marketplace: "excalidraw", ticked: false },
  { id: "raycast-ui-skills", name: "raycast-ui-skills", marketplace: "raycast", ticked: false },
];
export const PLUGIN_COUNT = 17;

export interface ProjectPick {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly note: string;
  readonly size: string;
  readonly ticked: boolean;
  readonly icon: ProjectIcon;
  readonly hue: ProjectHue;
  /** A folder the person picked that is not a wsp project yet. */
  readonly added?: true;
}
export const PROJECTS: ProjectPick[] = [
  { id: "pr_wsp", name: "wsp", path: "~/wsp", note: "github.com/Zingzy/wsp. 2 unpushed commits and the ignored files you ticked come along; caches stay.", size: "1.1 GB", ticked: true, icon: "terminal", hue: "amber" },
  { id: "pr_spoo", name: "spoo", path: "~/spoo", note: "github.com/spoo-me/url-shortener, clean.", size: "180 MB", ticked: false, icon: "globe", hue: "blue" },
  { id: "pr_laya", name: "laya", path: "~/laya", note: "No remote, so the folder is copied whole.", size: "340 MB", ticked: false, icon: "folder", hue: "neutral" },
  { id: "pr_kart", name: "kartsmash", path: "~/kartsmash", note: "No remote, so the folder is copied whole.", size: "2.3 GB", ticked: false, icon: "gamepad", hue: "pink" },
];
export const ADDED_FOLDER: ProjectPick = { id: "pr_portfolio", name: "portfolio", path: "~/Sites/portfolio", note: "Not a wsp project yet. github.com/Zingzy/portfolio, clean.", size: "96 MB", ticked: true, icon: "globe", hue: "neutral", added: true };

export interface ConfigPick {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly ticked: boolean;
  readonly signIns?: readonly string[];
  readonly signIn?: string;
}
export const CONFIGS: ConfigPick[] = [
  { id: "git", name: "Git", note: "~/.gitconfig and ~/.config/git. Credential helpers, the signing key and ssh rewrites stay here.", ticked: true },
  { id: "shell", name: "Shell", note: "zsh with .zshrc, .zshenv, aliases, starship and tmux. Secret exports are cut. Bash files never travel.", ticked: true },
  { id: "github", name: "GitHub", note: "gh's token from this Mac, with repo, read:org and workflow.", ticked: true, signIns: ["Copy the token", "Sign in on studio", "Later"], signIn: "Copy the token" },
];

export interface Recipe {
  readonly id: string;
  readonly name: string;
  readonly icon: ProjectIcon;
  readonly holds: string;
  readonly machines: readonly string[];
}
export const RECIPES: Recipe[] = [
  { id: "builders", name: "Builders", icon: "rocket", holds: "Claude Code, Codex, 7 MCP servers, 8 CLIs, 78 skills, 9 plugins, 2 projects, git, shell, GitHub", machines: ["spoo", "studio"] },
  { id: "minimal", name: "Minimal", icon: "zap", holds: "Claude Code, gh, 3 skills, git", machines: [] },
];

export const SUMMARY = {
  lines: [
    ["Agents", "Claude Code, Codex"],
    ["MCP servers", "wsp, context7, gsc, linear, playwright, github, cloudflare_observability"],
    ["CLIs", "gh, ripgrep, jq, fd, uv, pnpm, bun, cargo-nextest"],
    ["Skills", "78 from ~/.claude/skills and ~/.agents/skills"],
    ["Plugins", "9, one set aside"],
    ["Projects", "wsp, portfolio"],
    ["Other config", "git, shell, GitHub"],
  ] as const,
  disk: { need: "3.4 GB", free: "61 GB", tone: "muted" as const, note: "with build-essential for cargo-nextest" },
  diskRefused: { need: "3.4 GB", free: "2.1 GB", tone: "danger" as const, note: "with build-essential for cargo-nextest" },
};

const s = (n: number): number => n * 1000;
export const RUNNING: StepLine[] = [
  { id: "wsp", name: "Install wsp", state: "done", note: "Daemon 61 under systemd, dialled back here.", ms: s(48) },
  { id: "floor", name: "Base packages", state: "done", note: "git, curl, ca-certificates, node 22 and 9 more.", ms: s(72) },
  { id: "agents", name: "Agents", state: "done", note: "Claude Code 2.1.286 and Codex 0.47.0 installed.", ms: s(53) },
  { id: "signin-claude", name: "Claude Code sign-in", state: "done", note: "Key copied.", ms: 600, sub: true },
  { id: "signin-codex", name: "Codex sign-in", state: "needs-you", note: "A tab opened in your browser to sign in on studio.", wait: { url: "https://auth.openai.com/device", code: "4F2K-9QJM", left: "8 min left" }, sub: true },
  { id: "mcp", name: "MCP servers", state: "working", note: "Copying wsp, context7, gsc.", ms: s(3) },
  { id: "clis", name: "CLIs", state: "waiting" },
  { id: "skills", name: "Skills", state: "waiting" },
  { id: "plugins", name: "Plugins", state: "waiting" },
  { id: "projects", name: "Projects", state: "working", note: "Cloning wsp from github.com/Zingzy/wsp.", ms: s(19) },
  { id: "configs", name: "Other config", state: "waiting" },
];

export const RUNNING_FAILED: StepLine[] = [
  { id: "wsp", name: "Install wsp", state: "done", note: "Daemon 61 under systemd, dialled back here.", ms: s(48) },
  { id: "floor", name: "Base packages", state: "done", note: "git, curl, ca-certificates, node 22 and 9 more.", ms: s(72) },
  { id: "agents", name: "Agents", state: "done", note: "Claude Code 2.1.286 and Codex 0.47.0 installed.", ms: s(53) },
  { id: "signin-claude", name: "Claude Code sign-in", state: "done", note: "Key copied.", ms: 600, sub: true },
  { id: "signin-codex", name: "Codex sign-in", state: "done", note: "Signed in on studio.", ms: s(41), sub: true },
  { id: "mcp", name: "MCP servers", state: "done", note: "7 copied.", ms: s(18) },
  { id: "clis", name: "CLIs", state: "done", note: "8 installed, build-essential with them.", ms: s(64) },
  { id: "skills", name: "Skills", state: "done", note: "77 of 78 copied.", ms: s(6) },
  { id: "skill-taste", name: "zingzy-design-taste", state: "failed", sub: true, said: "A link inside the folder points at a folder, which never travels.", fix: "Replace the link with a copy here and retry." },
  { id: "plugins", name: "Plugins", state: "done", note: "8 installed, turnstile-spin set aside.", ms: s(22) },
  { id: "projects", name: "Projects", state: "done", note: "portfolio cloned.", ms: s(31) },
  { id: "project-wsp", name: "wsp", state: "failed", sub: true, said: "The clone from github.com/Zingzy/wsp was refused on studio: permission denied (publickey).", fix: "Private keys stay here. Give studio a deploy key, or let gh clone it over https." },
  { id: "configs", name: "Other config", state: "done", note: "git, shell and the GitHub token landed.", ms: s(3) },
];

export const RUNNING_BLOCKED: StepLine[] = [
  { id: "wsp", name: "Install wsp", state: "done", note: "Daemon 61 under systemd, dialled back here.", ms: s(48) },
  { id: "floor", name: "Base packages", state: "failed", said: "apt-get install exited 100 on studio: E: Unable to locate package nodejs.", fix: "The box has no apt sources for node. Fix them on studio and retry; nothing after this ran." },
  { id: "agents", name: "Agents", state: "waiting" },
  { id: "mcp", name: "MCP servers", state: "waiting" },
  { id: "clis", name: "CLIs", state: "waiting" },
  { id: "skills", name: "Skills", state: "waiting" },
  { id: "plugins", name: "Plugins", state: "waiting" },
  { id: "projects", name: "Projects", state: "waiting" },
  { id: "configs", name: "Other config", state: "waiting" },
];

export const RUNNING_DONE: StepLine[] = RUNNING_FAILED.filter(row => row.state !== "failed").map(row => (row.id === "skills" ? { ...row, note: "78 copied." } : row.id === "projects" ? { ...row, note: "wsp and portfolio cloned.", ms: s(58) } : row));

/** What the sidebar's Setting up section holds: one card per machine on its way. */
export interface SetupCard {
  readonly place: PlaceView;
  readonly state: StepState | "pending";
  readonly line: string;
  readonly at: string;
  readonly startedAt: number;
}
export const SETUP_CARDS: SetupCard[] = [
  { place: STUDIO, state: "working", line: "Copying 78 skills", at: "7 of 12", startedAt: Date.now() - 4 * 60_000 - 12_000 },
  { place: SPOO_MONGO, state: "needs-you", line: "Codex needs you to sign in", at: "5 of 12", startedAt: Date.now() - 9 * 60_000 },
  { place: DISHAPC, state: "failed", line: "Base packages did not install", at: "2 of 12", startedAt: Date.now() - 14 * 60_000 },
];
