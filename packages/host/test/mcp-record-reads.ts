// SPDX-License-Identifier: AGPL-3.0-only
// The recorded calls of the read tools the daemon binary's tool server
// answers, for mcp-record.test.ts to replay through this package's server:
// per tool, each case's arguments and the frame the host answers every op
// with. The frames carry what a byte compare has to survive, and fields out
// of the order a parsed reply is answered in, with a field no schema names.

import { DEFAULT_PREFERENCES } from "@wsp/protocol";

/** One recorded call: its name, the tool's arguments, and the frame the host answers each op with. */
interface Case {
  case: string;
  arguments: Record<string, unknown>;
  replies: Record<string, string>;
}

const reply = (body: Record<string, unknown>): string => JSON.stringify({ id: 1, ok: true, ...body });
const refused = (error: string, kind?: string): string => JSON.stringify({ id: 1, ok: false, error, ...(kind !== undefined ? { kind } : {}) });

const AWKWARD = "zingzy's \u0085box\u007f \"one\" \\ two\nthree 🧪";

/** A workspace as workspaces.resolve answers it, which the tool reads as WorkspaceOut. */
const WORKSPACE = { id: "ws-1", name: "parser", machineId: "m-1", phase: "running", golden: "golden-1", createdAt: "2026-09-27T00:00:00.000Z", project: { id: "proj-1", name: "wsp", path: "/w", computer: "place-9" } };

const PLACES = reply({
  places: [
    { id: "here", kind: "computer", name: "this mac", default: true },
    { id: "place-9", kind: "computer", name: "attic", default: false },
  ],
});

const REPORT = {
  readAt: "2026-09-27T10:00:00.000Z",
  user: "zingzy",
  home: "/Users/zingzy",
  target: { placeId: "here" },
  unknownTop: { anything: 1 },
  stale: "napping",
  agents: [
    { name: "Claude Code", id: "claude", installed: true, version: "2.1.0", latest: "2.2.0", pinned: "2.1.0", road: "wsp", path: "/usr/local/bin/claude", signIn: "signed-in", signInRoad: "device", wspTools: true, notInSchema: 1, update: { command: "claude update \u0085", to: "2.2.0" }, signInDetail: "OAuth credentials", setup: { envNames: ["FOO"], on: true, program: "/opt/🧪/claude" } },
    { id: "codex", name: "Codex \u0085", installed: false, road: "none", signIn: "none", signInRoad: "code", wspTools: false },
    { id: "gemini", name: "Gemini", installed: true, version: "1.0", road: "own", path: "/opt/🧪/gemini", signIn: "unknown", signInRoad: "terminal", wspTools: false },
    { id: "amp", name: "Amp", installed: true, road: "shim", signIn: "vault-key", signInRoad: "key", wspTools: true },
  ],
  skills: [
    { scope: "user", name: "unslop", description: "cut the tells", paths: [{ path: "~/.claude/skills/unslop", agent: "claude", linkTo: "~/.agents/skills/unslop" }, { path: "~/.agents/skills/unslop" }] },
    { name: "tab\there\nnew \u0085line", paths: [{ path: "~/p/.claude/skills/x", off: true }], scope: "project", project: { path: "~/p", name: "wsp \u0007bell", id: "proj-1" } },
    { name: "plug", paths: [{ path: "~/.claude/plugins/p/skills/plug" }], scope: "plugin" },
  ],
  servers: [
    { name: "linear", agent: "claude", scope: "user", file: "~/.claude.json", transport: { kind: "http", host: "mcp.linear.app" }, envNames: [], auth: "unknown", enabled: true, inRecipe: false },
    { agent: "codex", name: "wsp", scope: "project", file: "~/p/.codex/config.toml", transport: { line: "wsp mcp --scoped", kind: "stdio" }, envNames: ["WSP_HOST_URL", "WSP_HOST_TOKEN"], auth: "open", enabled: false, project: { id: "proj-1", name: "wsp", path: "~/p" } },
    { agent: "not-in-catalog", name: "odd", scope: "home", file: "~/.x", transport: { kind: "stdio", line: "odd é" }, envNames: [], auth: "open", enabled: true, tools: [{ name: "t" }] },
  ],
  refused: ["codex: config.toml did not \u0085parse\nat line 3"],
  projects: [{ name: "wsp", id: "proj-1", path: "~/p", extra: true }],
  reach: "here",
};

const EMPTY_REPORT = { target: { workspaceId: "ws-1" }, home: "/root", user: "root", readAt: "2026-09-27T10:00:00.000Z", agents: [], skills: [], servers: [], refused: [] };

const reportCases = (tool: string): Case[] => [
  { case: "here", arguments: {}, replies: { "agents.read": reply({ report: REPORT }) } },
  { case: "a workspace", arguments: { workspace: "ws one" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "agents.read": reply({ report: EMPTY_REPORT }) } },
  { case: "a computer", arguments: { on: "attic" }, replies: { "places.list": PLACES, "agents.read": reply({ report: { ...REPORT, stale: undefined, target: { placeId: "place-9", project: "wsp" } } }) } },
  { case: "both", arguments: { workspace: "w", on: "attic" }, replies: {} },
  { case: "no such computer", arguments: { on: "cellar" }, replies: { "places.list": PLACES } },
  { case: "a report this build cannot read", arguments: {}, replies: { "agents.read": reply({ report: { ...REPORT, [tool]: [{ name: 5 }] } }) } },
  { case: "refused", arguments: { workspace: "gone" }, replies: { "workspaces.resolve": refused("no workspace gone", "not-found") } },
];

const SETUP = {
  job: {
    stoppable: true,
    step: 2,
    road: "manual",
    id: "job-1",
    phase: "signing-in",
    keys: { solari: true, "2": false },
    screens: [{ id: "agents", title: "Agents \u0085", top: "pick", items: [{ label: "Claude", id: "claude", detail: ["a", "b"], size: 1.5, lock: "on", extra: 1 }], ticks: ["claude"], answers: { q: "a" }, footer: [{ tone: "red", text: "careful" }] }],
    rows: [{ state: "waiting", label: "GitHub 🧪", kind: "sign-in", id: "gh", page: "https://github.com/login/device", code: "ABCD-1234", since: 1727431200000.5 }],
    progress: { total: 9, done: 4 },
    log: ["line \"one\""],
    golden: { version: 3 },
  },
  agents: [{ takesTools: true, name: "Claude Code", configured: true, id: "claude", extra: "x" }],
  pricing: { rateUsdPerHour: 0.1 + 0.2, size: { memMb: 16384, cpu: 8 } },
  home: "/Users/zingzy",
  keyProvider: "solari",
  keys: { solari: true, anthropic: false },
  place: { name: "solari", id: "place-solari" },
  unknownTop: 1,
};

const SESSIONS = [
  { id: "s-1", workspaceId: "ws-1", harness: "claude", status: "completed", threadId: "t-1111aaaa", prompt: "Fix the flaky \u0085test in the parser module and then tidy the imports around it. Then ship.", startedAt: 1727431200000, endedAt: 1727431260000, claudeSessionId: "c-1", costUsd: 0.1, startedBy: "agent", parentThreadId: "t-0", rootThreadId: "t-0" },
  { id: "s-2", workspaceId: "ws-2", harness: "codex", status: "running", prompt: "look", startedAt: 1727431300000.25, pid: 4242 },
  { id: "s-3", workspaceId: "ws-1", harness: "claude", status: "running", threadId: "t-1111aaaa", harnessTitle: "  Parser\n fix  🧪", costUsd: 0.2, asking: "ask-1", readAt: 1727431270000, settledAt: 1727431265000, cwd: "/w/é", waitingOn: { title: "other", threadId: "t-2", workspaceId: "ws-1", sessionId: "s-9", prompt: { askId: "a", toolName: "Bash", input: "{}", options: [] } } },
  { id: "s-4", workspaceId: "ws-gone", harness: "claude", status: "failed", threadId: "t-4", refusal: "sign-in", claudeSessionId: "c-4" },
  { id: "s-5", workspaceId: "ws-3", harness: "claude", status: "completed", threadId: "t-5" },
  { id: "s-6", workspaceId: "ws-3", harness: "codex", status: "completed", threadId: "t-6" },
  { id: "s-7", workspaceId: "ws-4", harness: "claude", status: "completed", threadId: "t-7" },
  { id: "s-8", workspaceId: "ws-5", harness: "claude", status: "completed", threadId: "t-8", cwd: "/nowhere/worktrees/proj-1/old/src" },
  { id: "s-9", workspaceId: "ws-6", harness: "claude", status: "completed", threadId: "t-9" },
];

/** A thread whose marks and picks moved between its turns: the latest turn's stand, and the opening turn's attempt. */
const PLACED = [
  { ...SESSIONS[0]!, pinnedAt: 1727431000000, section: { name: "working", whileState: "running" }, attempt: "att-1", permissionMode: "acceptEdits", fast: false },
  { ...SESSIONS[2]!, pinnedAt: 1727431280000.5, snoozedUntil: 1727434800000, wokeAt: 1727431290000, section: { name: "needs-you", whileState: "asking \"é\"" }, attempt: "att-2", permissionMode: "bypass \u0085", fast: true },
];

const WORKSPACES = reply({
  workspaces: [
    { id: "ws-1", name: "parser", project: { id: "proj-1", name: "wsp", computer: "place-9" } },
    { id: "ws-2", name: "look", project: { id: "proj-2", name: "site", computer: "place-unnamed" } },
    { id: "ws-3", name: "wsp@feat", kind: "local", project: { id: "proj-1", name: "wsp", path: "/nowhere/wsp", computer: "here" }, worktree: { path: "/nowhere/worktrees/proj-1/feat", branch: "feat/é", made: true }, folder: "/nowhere/worktrees/proj-1/feat" },
    { id: "ws-4", name: "wsp", kind: "local", project: { id: "proj-1", name: "wsp", path: "/nowhere/wsp", computer: "here" } },
    { id: "ws-5", name: "wsp@old", kind: "local", project: { id: "proj-1", name: "wsp", path: "/nowhere/wsp", computer: "here" }, worktree: { path: "/nowhere/worktrees/proj-1/old", branch: "old", made: true, gone: true }, folder: "/nowhere/wsp" },
    { id: "ws-6", name: "wsp@gone", kind: "local", project: { id: "proj-1", name: "wsp", path: "/nowhere/wsp-two", computer: "here" }, worktree: { path: "/nowhere/worktrees/proj-1/gone", branch: "gone", made: true, gone: true }, folder: "/nowhere/wsp-two" },
  ],
});

const at = (ms: number) => 1727431200000 + ms;

const EVENTS = [
  { type: "session.moved", threadId: "t-1111aaaa", turnId: "u1", sessionId: "s", workspaceId: "w", from: "/w/tree é", to: "/w/proj", fresh: true, at: at(0) },
  { type: "session.behind", threadId: "t-1111aaaa", turnId: "u1", sessionId: "s", workspaceId: "w", text: "this worktree is behind pull request #7 \u0085", at: at(0) },
  { type: "session.moved", threadId: "t-1111aaaa", turnId: "u1", sessionId: "s", workspaceId: "w", from: "/w/tree", to: "/w/proj", at: at(0) },
  { type: "session.start", threadId: "t-1111aaaa", turnId: "u1", prompt: "Fix the \u0085test", at: at(0) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "text", text: "Looking ", messageId: "m1", at: at(1000) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "text", text: "now.", messageId: "m1", at: at(1500) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "thinking", text: "hmm", at: at(1600) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k1", toolName: "Read", text: '{"file_path":', at: at(2000) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k1", text: '"/src/🧪.ts"}', at: at(2100) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_result", toolUseId: "k1", text: "contents", at: at(2200) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k2", toolName: "Bash", text: '{"command":"pnpm  test\\n  --run","description":"tests"}', at: at(3000) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_result", toolUseId: "k2", isError: true, at: at(3100) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k3", toolName: "file_change", text: '{"changes":[{"path":"a.ts"},{"path":"b.ts"},{"path":""}]}', at: at(4000) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_result", toolUseId: "k3", at: at(4100) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k4", toolName: "Grep", text: '{"pattern":"TODO\\n more"}', at: at(4200) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolName: "mcp__linear__search", text: "{}", at: at(4300) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k5", toolName: "AskUserQuestion", text: '{"questions":[{"question":"No choices?","options":[]},{"question":"Which one?","options":[{"label":"A"}]}]}', at: at(4400) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k6", toolName: "Task", text: '{"description":"explore\\nthe code"}', at: at(4450) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_result", toolUseId: "k6", at: at(4460) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "tool_use", toolUseId: "k7", toolName: "spawn_agent", text: '{"prompt":"review\\nthe diff"}', at: at(4470) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "text", text: "", at: at(4500) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "text", text: "Done: ", messageId: "m2", at: at(5000) },
  { type: "session.delta", threadId: "t-1111aaaa", kind: "text", text: "fixed \"it\".", messageId: "m3", at: at(5100) },
  { type: "session.permission", threadId: "t-1111aaaa", askId: "p1", toolName: "Bash", input: "{}", options: [] },
  { type: "session.steer", threadId: "t-1111aaaa", prompt: "also docs", at: at(5200) },
  { type: "session.delta", threadId: "t-other", kind: "text", text: "not this thread" },
  { type: "session.done", threadId: "t-1111aaaa", turnId: "u1", at: at(6000), result: { status: "completed", durationMs: 125_400, waitedMs: 70_000, costUsd: 0.125, text: "Done: fixed it." } },
  { type: "session.end", threadId: "t-1111aaaa", turnId: "u1", at: at(6100) },
  { type: "session.start", threadId: "t-1111aaaa", turnId: "u2", prompt: "and the other", at: at(7000) },
  { type: "session.end", threadId: "t-1111aaaa", turnId: "u2", reason: "the machine went away", at: at(8000) },
  { type: "session.start", threadId: "t-1111aaaa", turnId: "u3", at: at(9000) },
  { type: "session.done", threadId: "t-1111aaaa", turnId: "u3", result: { status: "completed", durationMs: 800, text: "  " } },
];

const LISTING = {
  dir: "/Users/zingzy",
  folders: [
    { path: "/Users/zingzy/code", repo: false },
    { path: "/Users/zingzy/wsp 🧪", repo: true, branch: "main", touchedAt: 1727431200000.5 },
    { path: "/Users/zingzy/x\u0085y", repo: true },
  ],
  hidden: 3,
  roots: ["/Users/zingzy", "/Users/zingzy/wsp 🧪"],
  extra: "kept",
};

/** The person's record as preferences.get and preferences.set answer it, with one agent's defaults in it, its keys
 * out of the schema's order. */
const PREFS = (agentDefaults: Record<string, unknown>): Record<string, unknown> => ({ ...DEFAULT_PREFERENCES, agentDefaults, unknownTop: 1 });
const SET_ROW = { ...REPORT.agents[0], setup: { envNames: ["FOO", "BAR"], on: false, args: ["--debug", "a \u0085 b"], configDir: "/Users/x/claude wsp", program: "/opt/🧪/claude" } };
const PROJECT_REF = { id: "proj-1", name: AWKWARD, computer: "here", source: { kind: "folder", path: "/w" }, path: "/w", remote: "", defaultBranch: "main", memoryKey: "-w", memoryDir: "/m/-w", createdAt: "2026-09-27T00:00:00.000Z" };
const RESOLVED = { "proj-1": { access: { from: "project", mode: "bypass", value: "full" }, agent: { from: "project", value: "codex", extra: 1 }, model: { value: "gpt \u0085", from: "default" }, effort: { value: "low", from: "catalog" } } };

/** The four tools that set what a new thread starts on and how an agent runs on a computer. */
const DEFAULTS_CASES: Record<string, Case[]> = {
  agents_default: [
    { case: "set", arguments: { agent: "codex" }, replies: { "preferences.set": reply({ preferences: PREFS({}) }) } },
    { case: "an agent the host runs no thread of", arguments: { agent: "nope" }, replies: { "preferences.set": refused("no harness named nope; the host runs claude, codex", "usage") } },
  ],
  agents_set: [
    { case: "model, effort and access", arguments: { agent: "claude", model: "opus \u0085", effort: "high", access: "ask" }, replies: { "preferences.set": reply({ preferences: PREFS({ claude: { access: "ask", effort: "high", model: "opus \u0085" } }) }) } },
    {
      case: "the picker's lists merged over what stands",
      arguments: { agent: "claude", hide: ["haiku"], show: ["sonnet"], order: ["opus", "haiku"], add_model: ["custom-1", "c0"], drop_model: ["c9"] },
      replies: { "preferences.get": reply({ preferences: PREFS({ claude: { models: { custom: ["c0", "c9"], hide: ["sonnet", "x 🧪"] } } }) }), "preferences.set": reply({ preferences: PREFS({ claude: { models: { custom: ["c0", "custom-1"], order: ["opus", "haiku"], hide: ["x 🧪", "haiku"] } } }) }) },
    },
    { case: "the picker's lists with none standing", arguments: { agent: "codex", hide: ["gpt"] }, replies: { "preferences.get": reply({ preferences: PREFS({}) }), "preferences.set": reply({ preferences: PREFS({ codex: { models: { hide: ["gpt"] } } }) }) } },
    { case: "put back", arguments: { agent: "claude", reset: ["model", "models"] }, replies: { "preferences.set": reply({ preferences: PREFS({}) }) } },
    { case: "nothing to change", arguments: { agent: "claude" }, replies: {} },
    { case: "an agent's own spelling", arguments: { agent: "claude", access: "bypassPermissions" }, replies: {} },
    { case: "a word the agent has no mode for", arguments: { agent: "claude", access: "plan" }, replies: { "preferences.set": refused("Claude Code takes no plan access; it takes ask, auto-edit, full", "usage") } },
  ],
  agents_setup: [
    { case: "set here", arguments: { agent: "claude", enabled: false, program: "/opt/🧪/claude", config: "/Users/x/claude wsp", args: ["--debug", "a \u0085 b"], unset_env: ["OLD"] }, replies: { "agents.setup": reply({ agent: SET_ROW }) } },
    { case: "on a computer", arguments: { agent: "claude", on: "attic", enabled: true, reset: ["program", "args"] }, replies: { "places.list": PLACES, "agents.setup": reply({ agent: REPORT.agents[1] }) } },
    { case: "no such computer", arguments: { agent: "claude", on: "nowhere", enabled: true }, replies: { "places.list": PLACES } },
    { case: "a config folder that is not absolute", arguments: { agent: "claude", config: "claude \"wsp\"" }, replies: {} },
    { case: "a name a shell would not read", arguments: { agent: "claude", unset_env: ["1 BAD"] }, replies: {} },
    { case: "nothing to change", arguments: { agent: "claude" }, replies: {} },
    { case: "refused by the host", arguments: { agent: "claude", config: "/Users/x" }, replies: { "agents.setup": refused("Claude Code's config folder cannot be the home folder itself; name a folder under it", "usage") } },
  ],
  projects_set: [
    { case: "set", arguments: { project: "wsp", agent: "codex", access: "full" }, replies: { "projects.resolve": reply({ project: PROJECT_REF }), "preferences.set": reply({ preferences: PREFS({}) }), "projects.defaults": reply({ defaults: RESOLVED }) } },
    { case: "put back", arguments: { project: "wsp", reset: ["agent", "access"] }, replies: { "projects.resolve": reply({ project: PROJECT_REF }), "preferences.set": reply({ preferences: PREFS({}) }), "projects.defaults": reply({ defaults: { "proj-1": { agent: { value: "claude", from: "catalog" } } } }) } },
    { case: "no defaults answered", arguments: { project: "wsp", effort: "low" }, replies: { "projects.resolve": reply({ project: PROJECT_REF }), "preferences.set": reply({ preferences: PREFS({}) }), "projects.defaults": reply({ defaults: {} }) } },
    { case: "nothing to change", arguments: { project: "wsp" }, replies: {} },
    { case: "no such project", arguments: { project: "nope", model: "m" }, replies: { "projects.resolve": refused('no project "nope"; you have wsp', "usage") } },
  ],
};

export const READS: Record<string, Case[]> = {
  ...DEFAULTS_CASES,
  agents: reportCases("agents"),
  skills: [...reportCases("skills"), { case: "no skills", arguments: {}, replies: { "agents.read": reply({ report: EMPTY_REPORT }) } }],
  servers: [...reportCases("servers"), { case: "no servers", arguments: {}, replies: { "agents.read": reply({ report: EMPTY_REPORT }) } }],
  projects: [
    {
      case: "rows",
      arguments: {},
      replies: {
        "projects.list": reply({ projects: [{ id: "proj-1", name: AWKWARD, computer: "here", source: { kind: "folder", path: "/w" }, path: "/w", remote: "", defaultBranch: "main", memoryKey: "-w", memoryDir: "/m/-w", createdAt: "2026-09-27T00:00:00.000Z", "10": 1 }] }),
        "projects.defaults": reply({ defaults: { "proj-1": { agent: { value: "codex", from: "project" }, model: { value: "gpt \u0085", from: "default" }, access: { value: "auto-edit", mode: "acceptEdits", from: "catalog" } } } }),
      },
    },
    { case: "defaults refused", arguments: {}, replies: { "projects.list": reply({ projects: [] }), "projects.defaults": refused("projects.defaults failed") } },
    { case: "refused", arguments: {}, replies: { "projects.list": refused("projects.list failed") } },
  ],
  setup: [
    { case: "a job", arguments: {}, replies: { "init.get": reply({ setup: SETUP }) } },
    { case: "no job", arguments: {}, replies: { "init.get": reply({ setup: { keys: {}, home: "/root", agents: [], pricing: null, job: null, buildRefusal: "no key" } }) } },
    { case: "a setup this build cannot read", arguments: {}, replies: { "init.get": reply({ setup: { ...SETUP, job: { ...SETUP.job, step: 1.5 } } }) } },
    { case: "refused", arguments: {}, replies: { "init.get": refused("init.get failed", "auth") } },
  ],
  threads: [
    { case: "rows", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: SESSIONS }), "places.list": PLACES } },
    { case: "within a project", arguments: { project: "wsp" }, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: SESSIONS }), "places.list": PLACES } },
    { case: "within a project by id", arguments: { project: "proj-2" }, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: SESSIONS }), "places.list": PLACES } },
    { case: "computers refused", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: SESSIONS }), "places.list": refused("a thread may not list computers", "auth") } },
    { case: "empty", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: [] }) } },
    { case: "pinned, snoozed and in a section", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: PLACED }), "places.list": PLACES } },
    { case: "no such project", arguments: { project: "nope" }, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: SESSIONS }) } },
  ],
  thread_read: [
    { case: "messages", arguments: { thread: "t-1111" }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: EVENTS }), "sessions.read": reply({}) } },
    { case: "last", arguments: { thread: "t-1111aaaa", last: true }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: EVENTS.slice(0, 24) }), "sessions.read": reply({}) } },
    { case: "last with a newer turn", arguments: { thread: "t-1111aaaa", last: true }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: EVENTS.slice(0, 25) }), "sessions.read": reply({}) } },
    { case: "last cut by the runtime", arguments: { thread: "t-1111aaaa", last: true }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: EVENTS.slice(0, 26) }), "sessions.read": reply({}) } },
    { case: "last with no words", arguments: { thread: "t-1111aaaa", last: true }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: EVENTS }), "sessions.read": reply({}) } },
    { case: "a thread of no id", arguments: { thread: "s-2" }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: [] }), "sessions.read": reply({}) } },
    { case: "no reply yet", arguments: { thread: "s-2", last: true }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": reply({ events: [{ type: "session.start", threadId: "s-2", turnId: "x" }] }), "sessions.read": reply({}) } },
    { case: "no such thread", arguments: { thread: "zz" }, replies: { "sessions.list": reply({ sessions: SESSIONS }) } },
    { case: "a prefix of two", arguments: { thread: "s-" }, replies: { "sessions.list": reply({ sessions: SESSIONS.slice(1, 2).concat([{ ...SESSIONS[1]!, id: "s-5" }]) }) } },
    { case: "refused", arguments: { thread: "t-1111aaaa" }, replies: { "sessions.list": reply({ sessions: SESSIONS }), "sessions.history": refused("sessions.history failed") } },
  ],
  folders: [
    { case: "home", arguments: {}, replies: { "host.folders": reply({ listing: LISTING }) } },
    { case: "a folder on another computer", arguments: { folder: "/srv/x", hidden: true, repos: false, on: "attic" }, replies: { "places.list": PLACES, "host.folders": reply({ listing: { ...LISTING, folders: [], hidden: 0 } }) } },
    { case: "a relative folder here", arguments: { folder: "code/é \"x\"", on: "this mac" }, replies: { "places.list": PLACES } },
    { case: "a relative folder there", arguments: { folder: "srv", on: "attic" }, replies: { "places.list": PLACES } },
    { case: "no folders", arguments: { folder: "/empty", repos: true }, replies: { "host.folders": reply({ listing: { dir: "/empty", folders: [], hidden: 2, roots: ["/Users/zingzy"] } }) } },
    { case: "refused", arguments: { folder: "/etc" }, replies: { "host.folders": refused("/etc is outside the folders this computer lets the host read", "usage") } },
  ],
  terminal_config: [
    { case: "no config", arguments: {}, replies: {} },
    { case: "a scheme", arguments: { scheme: "light" }, replies: {} },
  ],
};
