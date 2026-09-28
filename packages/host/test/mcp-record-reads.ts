// SPDX-License-Identifier: AGPL-3.0-only
// The recorded calls of the read tools the daemon binary's tool server
// answers, for mcp-record.test.ts to replay through this package's server:
// per tool, each case's arguments and the frame the host answers every op
// with. The frames carry what a byte compare has to survive, and fields out
// of the order a parsed reply is answered in, with a field no schema names.

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
    { name: "Claude Code", id: "claude", installed: true, version: "2.1.0", latest: "2.2.0", pinned: "2.1.0", road: "wsp", path: "/usr/local/bin/claude", signIn: "signed-in", signInRoad: "device", wspTools: true, notInSchema: 1 },
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
  ],
});

const at = (ms: number) => 1727431200000 + ms;

const EVENTS = [
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

export const READS: Record<string, Case[]> = {
  agents: reportCases("agents"),
  skills: [...reportCases("skills"), { case: "no skills", arguments: {}, replies: { "agents.read": reply({ report: EMPTY_REPORT }) } }],
  servers: [...reportCases("servers"), { case: "no servers", arguments: {}, replies: { "agents.read": reply({ report: EMPTY_REPORT }) } }],
  workspaces: [
    { case: "rows", arguments: {}, replies: { "status.list": reply({ statuses: [{ ...WORKSPACE, name: AWKWARD, "2": "an index key", machineState: "running", size: { cpu: 8, memMb: 16384 }, rateUsdPerHour: 0.1 + 0.2, reach: { state: "reachable", offline: false } }] }) } },
    { case: "empty", arguments: {}, replies: { "status.list": reply({ statuses: [] }) } },
    { case: "refused", arguments: {}, replies: { "status.list": refused("the token this line presented is not one this host holds", "auth") } },
  ],
  projects: [
    { case: "rows", arguments: {}, replies: { "projects.list": reply({ projects: [{ id: "proj-1", name: AWKWARD, computer: "here", source: { kind: "folder", path: "/w" }, path: "/w", remote: "", defaultBranch: "main", memoryKey: "-w", memoryDir: "/m/-w", createdAt: "2026-09-27T00:00:00.000Z", "10": 1 }] }) } },
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
    { case: "within a workspace", arguments: { workspace: "parser" }, replies: { "workspaces.list": WORKSPACES, "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: SESSIONS.slice(0, 1) }), "places.list": PLACES } },
    { case: "computers refused", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: SESSIONS }), "places.list": refused("a thread may not list computers", "auth") } },
    { case: "empty", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: [] }) } },
    { case: "pinned, snoozed and in a section", arguments: {}, replies: { "workspaces.list": WORKSPACES, "sessions.list": reply({ sessions: PLACED }), "places.list": PLACES } },
    { case: "no such workspace", arguments: { workspace: "nope" }, replies: { "workspaces.list": WORKSPACES, "workspaces.resolve": refused("no workspace nope", "not-found") } },
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
