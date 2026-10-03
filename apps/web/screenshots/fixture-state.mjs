// SPDX-License-Identifier: AGPL-3.0-only
// The throwaway states a screenshot run and a persona lab serve, one per kind
// of person: what their sidebar holds, whether an image is sealed, and what
// their threads say. The default is what the screenshot run photographs, this
// computer with work on it and two computers of the person's own joined to it,
// its projects recorded on each and the threads with the transcript each
// replays, one of them opened by another thread's agent, so no surface is
// photographed empty and the spawned row's grammar is in a shot; the rest vary
// the setup a tester meets. Nothing here is a real computer, a real key or a
// real folder, and the copies are served by the provider that answers out of
// memory, so no fixture dials anything.
//
// One workspace stands on one machine, and this computer is one machine, so no
// fixture puts two rows on it: a sidebar wsp refuses to make is a sidebar a
// tester judges the product by, and one read three rows here and could not say
// which computer two of them were on.
//
// Every folder a fixture names sits under the home the host serving it runs
// in, and a workspace of the local kind is named the way wsp names one here. A
// tester given somebody else's home and somebody else's threads spent their
// first minute working out whose Mac they were on, and a project folder under
// the person's own home put a tester's turn inside the person's real
// repository.
import { DAEMON_VERSION, HERE_PLACE_ID as HERE, STATE_SHAPE } from "@wsp/protocol";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

/** The name wsp gives a workspace of the local kind, which is this computer's host name. */
const THIS_COMPUTER = hostname();

/** The home every folder in a fixture hangs off: the home the host serving it runs under, which for a lab is the
 * lab's own and for the screenshot run is this computer's. A turn starts in the one project its workspace has, so
 * a project folder under the person's own home is a tester's agent running inside the person's real repository,
 * with their project MCP servers, their instruction file and their files to edit (measured 2026-09-12). Set once
 * per build below and read by every helper here, since every path in a fixture hangs off the same home. */
let HOME = homedir();

/** The cloud word the fixture being built stands in for, which is the computer a fork's project is recorded on: the
 * host names the provider it forks on by that word, and a project on any other word would be a fork on a computer
 * this host has never heard of. Set once per build below, as the home is. */
let CLOUD;

/** The folder a project on this computer sits in: under the work folder of the home the host runs in, never beside
 * the person's own checkouts. */
const projectDest = name => join(HOME, "wsp-work", name);

/** Every stamp hangs off the hour this run started in rather than a date written here: the app words a
 * thread's time as a distance from now, and a fixed date would drift into the future and read "now" on
 * every row. Rounded to the hour so two runs in one hour are byte for byte the same. */
const AT = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const ago = minutes => AT - minutes * 60_000;

/** A UUID for a fixture's own word, the same one every run: the harness refuses a session id that is not a UUID
 * (`packages/adapter-claude/src/landmines.ts`), so a seeded thread sent into answered with that refusal and a
 * tester read it as the product losing their message. Minted from the word rather than at random so two runs of
 * one fixture are byte for byte the same file. */
const uuidFor = word => {
  const h = createHash("sha1").update(`wsp-fixture:${word}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** The three ids one seeded turn wears, each a UUID and each the same one wherever the fixture names that thread:
 * the sessions, the transcript's events and a spawned thread's parent all read them through here, so one table
 * of ids cannot drift into two shapes. */
export const sessionId = name => uuidFor(`session:${name}`);
export const threadId = name => uuidFor(`thread:${name}`);
const turnId = name => uuidFor(`turn:${name}`);

const workspace = (id, name, extra = {}) => ({
  id,
  name,
  machineId: "local",
  phase: "running",
  kind: "local",
  golden: "",
  createdAt: new Date(ago(60 * 26)).toISOString(),
  size: { cpu: 10, memMb: 32768 },
  home: HOME,
  folder: HOME,
  spec: {},
  ...extra,
});

/** The name this computer's own row wears in every fixture, as a person gives it in System Settings: the same in
 * every shot whichever Mac takes it. */
export const HERE_LABEL = "zingzy's MacBook Pro";

/** The agents on this computer in every fixture, which the harness stands in for under the throwaway home: what each
 * agent's own version flag and sign-in status command say, by catalog id, the newest version each vendor is taken to
 * have published, and the MCP servers in the agents' own files. A server with tools is a stand-in command that
 * answers them; one without is written as given and never started. Claude answers a side question after a wait long
 * enough for the asking shot and short enough for the answered one. */
export const HERE_AGENTS = {
  agents: {
    claude: {
      version: "2.1.283 (Claude Code)",
      status: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
      aside: {
        afterS: 8,
        text: "I'm in the spoo folder on this computer. You last asked why the short links were 302ing twice, and I moved the trailing-slash rewrite ahead of the canonical host check so each form redirects once.",
      },
      /** What the agent drafts when a commit message is asked of it, after the same wait so a shot can catch the box
       * still drafting and a later one filled. */
      draft: {
        afterS: 1,
        text: "Round the cart total once, at the end\n\nThe total rounded each line and added the pennies up, so three lines at 0.335\nlanded on 1.00 or 1.01 depending on the order. It rounds the sum now.",
      },
    },
    codex: { version: "codex-cli 0.155.0", status: "Logged in using ChatGPT" },
  },
  latest: { claude: "2.1.283", codex: "0.155.0" },
  servers: [
    {
      name: "docs",
      agents: ["claude", "codex"],
      tools: [
        { name: "search_docs", description: "Search the project's docs by keyword." },
        { name: "read_page", description: "Read one docs page as markdown." },
      ],
    },
    { name: "linear", agents: ["claude"], transport: { kind: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } } },
  ],
  /** Skills in an agent's own folder, one the seeded session announces and one it does not, so the / menu shows a
   * skill sent as the command Claude knows and one sent as $name. */
  skills: [
    { name: "why", agent: "claude", description: "Why a decision was made, from the history behind it." },
    { name: "release-notes", agent: "claude", description: "Draft the release notes for what merged since the last tag." },
  ],
};

/** The files a project on this computer holds beyond its first two, as the composer's @ menu lists them: the ones the
 * seeded transcripts talk about, so a picked file is one the thread already names. */
export const HERE_PROJECT_FILES = [
  "apps/api/src/redirect.ts",
  "apps/api/src/middleware.ts",
  "apps/api/src/routes/links.ts",
  "apps/api/test/redirect.test.ts",
  "apps/web/src/pages/Links.tsx",
  "apps/web/src/components/LinkChart.tsx",
  "package.json",
];

/** What `gh` answers for a project on this computer: its open pull requests and issues, as the # menu lists them.
 * The stand-in answers these in gh's own JSON, so the daemon reads them exactly as it reads the real command's. */
export const HERE_HOST_ITEMS = {
  pr: [
    { number: 41, title: "Run the canonical host check after the slash rewrite", body: "Every request to /r/abc/ bounced once through /r/abc. The rewrite runs first now.", url: "https://github.com/you/spoo/pull/41" },
    { number: 38, title: "Rate limit the redirect endpoint", body: "Caps each client at 60 redirects a minute.", url: "https://github.com/you/spoo/pull/38" },
  ],
  issue: [{ number: 36, title: "Short links with a trailing slash bounce twice", body: "Seen on /r/abc/ in Safari.", url: "https://github.com/you/spoo/issues/36" }],
};

/** The pull request spoo's branch has, in gh's own JSON for each read the host makes of it: the fields a read asks
 * for, its checks, how far main has moved on, its page with the comments on its lines, and the repository's merge
 * settings. One check failed and changes were asked for, so the tile, the pane and the thread's row have each word to
 * show; the conflicting one has its checks passed and a conflict with main. */
/** A long markdown body, so the Overview tab shows its headings, lists, code and inline code clamped under the fade. */
const CART_BODY = [
  "## What changed",
  "",
  "The total **rounded each line** and added the pennies up, so three lines at `0.335` landed on `1.00` or `1.01`",
  "depending on the order. It rounds the sum now, once, at the end.",
  "",
  "### Why",
  "",
  "- Per-line rounding compounds the error across a cart.",
  "- The order of the lines then decides the total, which a cart must never do.",
  "- Rounding the sum once is the only place a penny is dropped.",
  "",
  "```ts",
  "export function cartTotal(lines: readonly Line[]): Money {",
  "  const sum = lines.reduce((acc, line) => acc + line.price * line.qty, 0);",
  "  return roundMoney(sum);",
  "}",
  "```",
  "",
  "### Still to do",
  "",
  "1. A test with three lines at 0.335.",
  "2. A note in the changelog.",
  "3. A look at the discount path, which rounds twice.",
  "",
  "See the [rounding note](https://github.com/you/spoo/wiki/rounding) for the history.",
].join("\n");

/** Twenty commits for the Commits tab, the last a merge from main so its dot reads hollow. */
const CART_AUTHORS = ["cass", "maya", "ravi", "you"];
const CART_PAGE_COMMITS = Array.from({ length: 20 }, (_, i) => {
  const n = i + 1;
  const merge = n === 20;
  return {
    oid: `${n.toString(16).padStart(2, "0")}${"c0ffee0b1d2e3f405162738495a6b7c8d9e0f1a2".slice(0, 38)}`,
    messageHeadline: merge ? "Merge branch 'main' into fix/cart-rounding" : `Round the cart total, step ${n}`,
    committedDate: `2026-09-${String(8 + Math.floor(i / 3)).padStart(2, "0")}T${String(9 + (i % 8)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00Z`,
    authors: [{ login: CART_AUTHORS[i % CART_AUTHORS.length], name: CART_AUTHORS[i % CART_AUTHORS.length] }],
  };
});
const CART_VIEW_COMMITS = CART_PAGE_COMMITS.map(c => ({ oid: c.oid, messageHeadline: c.messageHeadline }));

const CART_PULL = {
  repo: "you/spoo",
  branch: "fix/cart-rounding",
  behind: 2,
  view: {
    number: 42,
    url: "https://github.com/you/spoo/pull/42",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "fix/cart-rounding",
    headRefOid: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    additions: 12,
    deletions: 3,
    changedFiles: 5,
    commits: CART_VIEW_COMMITS,
  },
  checks: [
    { name: "test", bucket: "fail", link: "https://github.com/you/spoo/actions/runs/36495564111/job/109174214002", workflow: "ci", description: "" },
    { name: "lint", bucket: "pass", link: "https://github.com/you/spoo/actions/runs/36495564111/job/109174214003", workflow: "ci", description: "" },
    { name: "preview", bucket: "pass", link: "https://vercel.com/you/spoo/deployments/7", workflow: "", description: "Deployment ready" },
  ],
  page: {
    title: "Round the cart total once, at the end",
    body: CART_BODY,
    author: { login: "cass" },
    updatedAt: "2026-09-29T09:22:00Z",
    commits: CART_PAGE_COMMITS,
    reviews: [{ author: { login: "maya" }, state: "CHANGES_REQUESTED", body: "The rounding is right. The test for three lines is missing.", submittedAt: "2026-09-29T09:20:00Z" }],
    comments: [{ author: { login: "maya" }, body: "Tried it on the staging cart, the totals match now.", createdAt: "2026-09-29T09:14:00Z" }],
    files: [
      { path: "src/cart/total.ts", additions: 4, deletions: 0 },
      { path: "src/cart/discount.ts", additions: 3, deletions: 2 },
      { path: "test/cart/total.test.ts", additions: 8, deletions: 0 },
      { path: "README.md", additions: 2, deletions: 1 },
      { path: "todo.md", additions: 6, deletions: 2 },
    ],
  },
  lineComments: [
    { id: 7, path: "src/cart/total.ts", line: 3, original_line: 3, side: "RIGHT", user: { login: "maya" }, body: "Round once here, and add a test with three lines at 0.335.", html_url: "https://github.com/you/spoo/pull/42#discussion_r7", created_at: "2026-09-29T09:19:00Z" },
  ],
  settings: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerDefaultMergeMethod: "SQUASH", autoMerge: true },
};
const CONFLICT_PULL = {
  ...CART_PULL,
  view: { ...CART_PULL.view, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY", reviewDecision: "APPROVED" },
  checks: CART_PULL.checks.map(c => ({ ...c, bucket: "pass" })),
  page: { ...CART_PULL.page, reviews: [{ author: { login: "maya" }, state: "APPROVED", body: "", submittedAt: "2026-09-29T09:40:00Z" }] },
};
const FIXTURE_PULLS = { failed: [CART_PULL], conflict: [CONFLICT_PULL] };

/** macInUse with its spoo workspace turned into a review of pull request 42: where the work came from and the draft
 * the reviewer's reply wrote, two comments on lines of the diff and one outside it, which goes into the summary;
 * posted, the same draft once Post has put it on the pull request. */
const REVIEW_FROM = { kind: "review", repo: "you/spoo", number: 42, url: CART_PULL.view.url, title: CART_PULL.page.title, base: "main", head: { branch: CART_PULL.branch, oid: CART_PULL.view.headRefOid } };
const REVIEW_DRAFT = {
  verdict: "request_changes",
  summary: "The rounding is right and the sum is rounded once. The three-line case the bug came from has no test, and the README still says each line rounds.",
  comments: [
    { id: "c1", path: "src/cart/total.ts", line: 3, side: "RIGHT", body: "Round here once, then add a test with three lines at 0.335 so the order no longer matters.", on: true },
    { id: "c2", path: "README.md", line: 12, side: "RIGHT", body: "This still says each line is rounded before the sum.", on: true },
    { id: "c3", path: "src/cart/lines.ts", line: 40, side: "RIGHT", body: "lineTotal rounds too; it is not in this diff, but it is the second rounding.", on: true, inSummary: true },
  ],
  headOid: CART_PULL.view.headRefOid,
  threadId: threadId("redirect"),
  at: ago(6),
};
const inReview = posted => () => {
  const state = macInUse();
  const ws = state.workspaces.ws_api;
  ws.name = "Review #42 Round the cart total once, at";
  ws.from = REVIEW_FROM;
  ws.review = posted ? { ...REVIEW_DRAFT, posted: { url: `${CART_PULL.view.url}#pullrequestreview-9`, at: ago(2), folded: ["src/cart/lines.ts:40"] } } : REVIEW_DRAFT;
  return state;
};

/** A project as the host records one: one computer, the source that computer sees and the folder a workspace of it
 * works in. A project here is a folder under the work folder; anywhere else it is a repo the computer cloned into
 * `path`. Every field the add writes is written, as the add writes it. */
const project = (name, computer, minutes, path = computer === HERE ? projectDest(name) : `/root/${name}`) => {
  const remote = `https://github.com/you/${name}.git`;
  const memoryKey = path.replace(/[^A-Za-z0-9]/g, "-");
  return {
    id: `pr_${name}`,
    name,
    computer,
    source: computer === HERE ? { kind: "folder", path } : { kind: "git", url: remote },
    path,
    remote,
    defaultBranch: "main",
    memoryKey,
    memoryDir: computer === HERE ? join(HOME, ".claude", "projects", memoryKey, "memory") : `/root/.wsp/projects/${memoryKey}/memory`,
    createdAt: new Date(ago(minutes)).toISOString(),
  };
};

/** A turn still running when the host comes up keeps running only where the machine gives no answer about its run,
 * which a fork on the stand-in does, so `run` names one; a turn stopped on a prompt carries its lead as `asking`. */
const turn = (thread, minutes, workspaceId = "ws_api") => ({
  id: sessionId(thread.id),
  workspaceId,
  harness: thread.agent ?? "claude",
  status: thread.status ?? "completed",
  startedBy: thread.startedBy ?? "person",
  threadId: threadId(thread.id),
  turnId: turnId(thread.id),
  prompt: thread.prompt,
  harnessTitle: thread.title,
  titleSource: "harness",
  startedAt: ago(minutes),
  ...(thread.status === "running" ? { run: `run_${thread.id}` } : { endedAt: ago(minutes - 3) }),
  ...(thread.asking === undefined ? {} : { asking: thread.asking }),
  // The agent's own session, which a side question copies; only a thread a shot asks one of names it.
  ...(thread.session === undefined ? {} : { claudeSessionId: thread.session }),
  cwd: thread.cwd ?? projectDest("spoo"),
  model: thread.model ?? "opus",
  permissionMode: "default",
  ...(thread.attempt === undefined ? {} : { attempt: thread.attempt }),
  // What the turn on this row cost, as the runtime stamps it: a thread's opener reads its own figure beside what
  // the threads it opened spent, and a row without one would leave that second figure unsaid.
  costUsd: thread.costUsd,
  ...(thread.parent === undefined ? {} : { parentThreadId: threadId(thread.parent), rootThreadId: threadId(thread.root) }),
});

const event = (thread, rest, workspaceId = "ws_api") => ({ workspaceId, sessionId: sessionId(thread.id), threadId: threadId(thread.id), turnId: turnId(thread.id), ...rest });

/** A whole turn as the transcript holds it: the person's words, a thought, one tool call and its result, the step
 * list or the plan where the agent kept one, the reply, the two events that close it, and what the turn changed in
 * its folder where it changed something. */
const replay = (thread, minutes, workspaceId = "ws_api") => {
  const events = [
    event(thread, { type: "session.start", at: ago(minutes), prompt: thread.prompt, model: "opus", cwd: thread.cwd ?? projectDest("spoo"), ...(thread.harness === undefined ? {} : { harness: thread.harness }) }, workspaceId),
    event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "thinking", text: thread.thought }, workspaceId),
    event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "tool_use", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.input }, workspaceId),
    event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "tool_result", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.result }, workspaceId),
    ...(thread.steps === undefined ? [] : [event(thread, { type: "session.plan", at: ago(minutes - 2), steps: thread.steps }, workspaceId)]),
    ...(thread.proposed === undefined ? [] : [event(thread, { type: "session.plan", at: ago(minutes - 2), text: thread.proposed }, workspaceId)]),
    event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "text", text: thread.reply }, workspaceId),
    event(
      thread,
      {
        type: "session.done",
        at: ago(minutes - 3),
        result: { status: "completed", durationMs: 178_000, costUsd: thread.costUsd, text: thread.reply, ...(thread.model === undefined ? {} : { model: thread.model }), ...(thread.tokens === undefined ? {} : { tokens: thread.tokens }) },
      },
      workspaceId,
    ),
    event(thread, { type: "session.end", at: ago(minutes - 3), exitCode: 0, sawResult: true }, workspaceId),
  ];
  // A running turn has not closed, so its transcript stops at the reply so far.
  if (thread.status === "running") return events.slice(0, -2);
  return thread.changes === undefined ? events : [...events, event(thread, { type: "session.changes", at: ago(minutes - 3), ...thread.changes }, workspaceId)];
};

/** What a real init announces, cut to what fits a shot: a run of bare names, the CLI's own screens among them,
 * and the commands two plugins named themselves in. The menu groups on the source those names carry. */
const ANNOUNCED_COMMANDS = ["compact", "context", "cost", "init", "review", "login", "model", "unslop", "why", "wizard", "code-review:code-review", "ralph-loop:ralph-loop", "ralph-loop:cancel-ralph"];

const REPLY_TOKENS = { input: 22_564, output: 1_251, cached: 18_435, cacheWrite: 4_113, context: 42_310, window: 200_000 };

const REDIRECT = {
  id: "redirect",
  harness: { slashCommands: ANNOUNCED_COMMANDS },
  prompt: "the short links are 302ing twice, find out why",
  title: "Double redirect on short links",
  thought: "Both forms of the path answer, so the rewrite and the canonical host check are probably fighting each other. Read the middleware order before anything else.",
  tool: { name: "Grep", input: '{"pattern":"canonicalHost","path":"apps/api/src"}', result: "apps/api/src/redirect.ts:31\napps/api/src/middleware.ts:12" },
  reply: [
    "The redirect loop came from the canonical host check running before the trailing-slash rewrite, so every request to `/r/abc/` bounced once through `/r/abc` and back.",
    "",
    "I moved the rewrite ahead of the check and pinned the order with a test:",
    "",
    "- `apps/api/src/redirect.ts:48` rewrites first now",
    "- `apps/api/test/redirect.test.ts` covers the slash and the bare form",
    "",
    "Both forms answer 302 once.",
  ].join("\n"),
  costUsd: 0.42,
  tokens: REPLY_TOKENS,
};

const CHART = {
  id: "chart",
  prompt: "swap the bar chart on the dashboard for a line",
  title: "Dashboard chart is a line now",
  thought: "The series is daily clicks over ninety days, so a line is the right mark. Keep the axis and the tooltip as they are.",
  tool: { name: "Read", input: '{"file_path":"apps/web/src/dashboard/ClicksChart.tsx"}', result: "export function ClicksChart({ points }: Props) {\n  return <BarChart data={points} />;\n}" },
  reply: ["The dashboard chart is a line now, same axis and same tooltip.", "", "`apps/web/src/dashboard/ClicksChart.tsx` draws `LineChart`, and the story file renders both the ninety-day series and the empty one."].join("\n"),
  costUsd: 0.18,
};

/** The image every fork in a fixture boots from: the head version of the sealed manifest below. */
const HEAD_SNAPSHOT = "fksnap_v2";

/** A fork of a sealed image, as the record holds one: no folder of its own, since a fork's shell lands in the
 * machine's home, and a size, so nothing asks the provider what shape it is. A project on one is named after the
 * fork it sits on: the image a snapshot takes is named after the projects it holds, so a fork called api holding a
 * project called spoo answers "Image of spoo taken" on a screen headed api, and no persona here has ever heard of
 * spoo. */
const fork = (id, name, machineId, extra = {}) => ({
  id,
  name,
  machineId,
  phase: "running",
  kind: "cloud",
  golden: HEAD_SNAPSHOT,
  createdAt: new Date(ago(60 * 8)).toISOString(),
  home: "/root",
  size: { cpu: 4, memMb: 8192 },
  // The environment and labels a create was asked for, empty here as a create that named none writes them. A
  // record without this field is one the runtime reads through on the road a wake takes, where it re-forks and
  // reads the envs off it: two testers met the TypeError that raises as a toast in the app.
  spec: {},
  ...extra,
});

/** The image a person has sealed, two versions deep: what a fixture with cloud machines forks from, and what takes
 * the cloud setup button out of the sidebar's foot. */
const sealed = () => ({
  default: {
    head: 2,
    versions: [
      {
        version: 1,
        snapshotId: "fksnap_v1",
        baseTemplate: "base",
        setupSha: "0000000000000000000000000000000000000000000000000000000000000001",
        createdAt: new Date(ago(60 * 60)).toISOString(),
        smoke: { cmd: "claude --version", exitCode: 0 },
        size: { cpu: 4, memMb: 8192 },
      },
      {
        version: 2,
        snapshotId: HEAD_SNAPSHOT,
        baseTemplate: "base",
        setupSha: "0000000000000000000000000000000000000000000000000000000000000002",
        createdAt: new Date(ago(60 * 30)).toISOString(),
        smoke: { cmd: "claude --version", exitCode: 0 },
        size: { cpu: 4, memMb: 8192 },
        logins: [
          { name: "claude", state: "copied" },
          { name: "gh", state: "signed-in" },
        ],
      },
    ],
  },
});

/** A thread an agent inside another thread opened: the same shape as a person's, with the tree it hangs in. */
const spawned = (id, of, parent, root) => ({ ...of, id, parent, root, startedBy: "agent" });

const MIGRATE = {
  id: "migrate",
  prompt: "move every service off the old queue, one machine each, and report back",
  title: "Queue migration across three services",
  thought: "Three services, three machines, one thread each. Fork them first so nothing waits on a build.",
  tool: { name: "wsp", input: '{"tool":"fork","count":3}', result: "api, web, docs" },
  reply: ["Three machines are up and each has a thread on it.", "", "- api: the publisher is on the new queue", "- web: waiting on the api's client", "- docs: nothing to move, it only reads"].join("\n"),
  costUsd: 1.14,
};

/** A lead thread and the one its own agent opened under it, so a shot carries the spawned row's grammar: the
 * workspace dropped where it is the row above's, then where that workspace runs, and no opener word. */
const SEARCH = {
  id: "search",
  prompt: "ship the search rewrite",
  title: "Ship the search rewrite",
  thought: "The index is the slow half, so read how the query is built before touching the ranking.",
  tool: { name: "Read", input: '{"file_path":"apps/api/src/search/query.ts"}', result: "export function buildQuery(term: string) {\n  return db.select().where(like(links.slug, `%${term}%`));\n}" },
  reply: "The query is a LIKE over every row. I opened a thread to write the index migration while I take the ranking.",
  costUsd: 0.63,
};

const MIGRATION = {
  id: "migration",
  prompt: "write the migration for the click index",
  title: "Write the migration",
  thought: "One index on clicks(link_id, at) covers both reads; write it as a migration rather than by hand.",
  tool: { name: "Write", input: '{"file_path":"apps/api/migrations/0007_click_index.sql"}', result: "CREATE INDEX clicks_link_at ON clicks (link_id, at);" },
  reply: "The migration is written and runs in 40 ms on the copy of the table I tried it against.",
  costUsd: 0.21,
};

/** Every workspace's meter as a host that has ticked keeps it, with where the workspace stands: the fixture's own
 * meter where it names one, and a first tick at nothing spent where it does not. A host meters a workspace from its
 * first tick, five seconds into a watch, and counts it against a computer only once it knows where it stands, so a
 * state without these read no spend until then, and a run whose earlier shots were quick drew the Spend line in the
 * later theme's shots alone. */
const metered = (workspaces, meters = {}) =>
  Object.fromEntries(
    workspaces.map(w => {
      const [, doc] = meters[w.id] === undefined ? meter(w.id, { rateUsdPerHour: 0, hours: 0, phase: w.phase }) : [w.id, meters[w.id]];
      const where = { kind: w.kind, machineId: w.machineId, ...(w.place === undefined ? {} : { place: w.place }), ...(w.provider === undefined ? {} : { provider: w.provider }) };
      return [w.id, { ...doc, where }];
    }),
  );

/** One store as the JSON file holds it: one object per collection, keyed the way the runtime keys it. Every
 * fixture below builds one. */
/** `readsSince` is when the host began keeping read stamps, minutes ago: a turn that ended after it and whose thread
 * says `seen` nowhere reads Done. Without it the host starts keeping them as it comes up, and every thread reads seen. */
const store = ({ projects, workspaces, sessions = {}, transcripts = {}, goldens, images, places, meters, preferences, readsSince }) => ({
  ...(readsSince === undefined ? {} : { reads: { since: { at: ago(readsSince) } } }),
  projects: Object.fromEntries(projects.map(p => [p.id, p])),
  workspaces: Object.fromEntries(workspaces.map(w => [w.id, w])),
  sessions,
  transcripts,
  ...(goldens !== undefined ? { goldens } : {}),
  "cost-histories": metered(workspaces, meters),
  ...(images !== undefined ? { images } : {}),
  ...(preferences === undefined ? {} : { preferences: { default: preferences } }),
  ...(places === undefined
    ? {}
    : {
        places,
        // The last computer added is the one a verb means when nobody says; its row wears the mark.
        "place-default": { default: { placeId: Object.keys(places)[0] } },
      }),
});

/** A workspace standing on a joined computer, as the host records one: a copy that computer made, filed under the
 * place it stands on, so the settings table counts it against that computer's row. */
const onPlace = (id, name, placeId, size, projectId) => ({
  id,
  name,
  machineId: `${placeId}-${name}`,
  phase: "running",
  kind: "cloud",
  place: placeId,
  project: projectId,
  golden: "",
  createdAt: new Date(ago(60 * 20)).toISOString(),
  size,
  shape: size,
  spec: {},
});

/** What a joined computer that holds workspaces says about the backend it offers, kept on its record so a workspace
 * standing there is served before the computer dials in: copies of the computer, priced at nothing. */
const placeFacts = size => ({
  offer: "docker",
  capabilities: {
    liveCloneForks: false,
    pauseMode: "memory",
    replacesMachine: true,
    previewUrls: false,
    signedUrls: false,
    callbackRelay: true,
    diskSnapshots: true,
    images: true,
    snapshotsAnyLife: false,
    snapshotListing: true,
    templates: true,
    kept: false,
    copies: true,
    ownNetwork: true,
    sizes: [{ ...size, rateUsdPerHour: 0 }],
  },
  pricing: { defaultSize: size, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
  baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
});

/** A computer somebody joined, as the host's record of it: what it last reported about itself, and when it was
 * last seen, so the table has a row that is not this computer. */
const place = (id, name, minutes, over = {}, holdsWorkspaces = false) => ({
  id,
  name,
  ...(holdsWorkspaces ? { backendFacts: placeFacts(over.shape ?? { cpu: 4, memMb: 8192 }) } : {}),
  publicKey: `no-key-verifies-against-this-${id}`,
  joinedAt: new Date(ago(60 * 26)).toISOString(),
  lastSeenAt: new Date(ago(minutes)).toISOString(),
  report: {
    name,
    platform: "darwin",
    arch: "arm64",
    os: "Darwin 24.6.0",
    shape: { cpu: 4, memMb: 8192 },
    diskFreeBytes: 91 * 1024 ** 3,
    login: { HOME: "/Users/maya", USER: "maya", PATH: "/usr/bin" },
    runsWorkspaces: false, engine: "none",
    daemonVersion: 17,
    wsp: ["/Users/maya/.wsp/bin/wsp"],
    agents: ["claude", "codex"],
    dialed: "http://192.168.1.20:4420",
    ...over,
  },
});

/** The threads one workspace holds, oldest first, with the transcript each replays. The order is the order the
 * runtime writes them in: the app opens the last row's thread when a person has picked none, and the centre
 * replays the last turn, so a thread out of order here heads the page with one title and fills it with another
 * turn's words. */
const threadsOn = (workspaceId, rows) => ({
  sessions: {
    [workspaceId]: {
      workspaceId,
      sessions: rows.map(([thread, minutes]) => turn(thread, minutes, workspaceId)),
      // A thread marked seen was shown by a window as its turn ended, and one marked settled was put away then too,
      // both of which the host keeps on the thread's record, as it keeps a pin and a snooze, which reads it too.
      threads: Object.fromEntries(
        rows
          .filter(([thread]) => thread.seen === true || thread.settled === true || thread.pinned === true || thread.snoozed === true)
          .map(([thread, minutes]) => [
            threadId(thread.id),
            {
              harness: thread.agent ?? "claude",
              ...(thread.seen === true || thread.settled === true || thread.snoozed === true ? { readAt: ago(minutes - 3) } : {}),
              ...(thread.settled === true ? { settledAt: ago(minutes - 3) } : {}),
              ...(thread.pinned === true ? { pinnedAt: ago(10) } : {}),
              ...(thread.snoozed === true ? { snoozedUntil: AT + 3 * 60 * 60_000 } : {}),
            },
          ]),
      ),
    },
  },
  transcripts: { [workspaceId]: { workspaceId, events: rows.flatMap(([thread, minutes]) => replay(thread, minutes, workspaceId)) } },
});

/** Two stores' threads side by side, since a fixture with machines in more than one place has threads in more
 * than one place too. */
const merge = (...parts) => ({
  sessions: Object.assign({}, ...parts.map(p => p.sessions)),
  transcripts: Object.assign({}, ...parts.map(p => p.transcripts)),
});

/** How long a fixture's meter has been running when the run photographs it: long enough for the chart to draw a
 * line rather than a dot, and short enough that the day and month ranges are held, which is the state a workspace
 * made this morning is in. */
const METERED_MIN = 40;

/** The meter one workspace opens with, as the host's own cost history holds it: the stretch it has been awake and
 * what that came to at its rate. Without one every fork in a fixture reads $0.0000 accrued beside a rate per hour,
 * since the meter starts at the tick after the host came up, and five testers asked what the number was for. Two
 * points where there is a stretch, as a host that has been metering holds them: the run's first tick and its
 * newest, which is minutes old, so the host carries the line on from there rather than starting again. */
const meter = (workspaceId, { rateUsdPerHour, hours, phase = "running" }) => {
  const rate = phase === "running" ? rateUsdPerHour : 0;
  const total = rateUsdPerHour * hours;
  const point = (minutesAgo, awakeMs, accruedUsd) => ({
    type: "workspace.cost",
    workspaceId,
    phase,
    rateUsdPerHour: rate,
    awakeMs,
    accruedUsd: Number(accruedUsd.toFixed(4)),
    at: new Date(ago(minutesAgo)).toISOString(),
  });
  const run = (rate * (METERED_MIN - 2)) / 60;
  // Nothing on the clock is one tick and no stretch: a persona who has run nothing has nothing for the chart to
  // draw, and a second point at the same total would be a line of no length under a meter that reads zero.
  const points =
    hours === 0 ? [point(2, 0, 0)] : [point(METERED_MIN, hours * 3_600_000 - (rate > 0 ? (METERED_MIN - 2) * 60_000 : 0), total - run), point(2, hours * 3_600_000, total)];
  return [workspaceId, { workspaceId, points }];
};

/** What the stand-in charges for the shape every fork in a fixture takes, as its own table prices it
 * (`packages/engine/src/fake-backend.ts`): four cores and 8 GB. */
const FORK_RATE = 0.16;

/** This computer after a while of use, with two computers of the person's own joined to it: one workspace on each,
 * three projects recorded on this one, threads on two of them, and no image sealed. What the screenshot run photographs, since a surface with nothing on it shows a
 * reviewer nothing.
 *
 * Three rows and not five: one workspace stands on one machine, and this computer is one machine, so the four
 * local rows this fixture used to carry are a sidebar wsp never makes. The ids stay where
 * they were, since the surfaces list names rows by id: ws_api is this computer now, and ws_web the workspace on
 * the old MacBook. The threads that stood on the rows that went stand on this computer, which is where a person
 * with one Mac would have run them. */
const macInUse = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("wsp", HERE, 60 * 5), project("landing", HERE, 60 * 9), project("web", "p_oldmacbook", 60 * 22, "/Users/maya/web"), project("box-build", "p_hetzner", 60 * 21)],
    workspaces: [
      workspace("ws_api", THIS_COMPUTER, { project: "pr_spoo" }),
      onPlace("ws_web", "web", "p_oldmacbook", { cpu: 4, memMb: 8192 }, "pr_web"),
      onPlace("ws_hetzner", "box-build", "p_hetzner", { cpu: 2, memMb: 4096 }, "pr_box-build"),
    ],
    ...merge(
      threadsOn("ws_api", [[CHART, 300], [{ ...REDIRECT, session: uuidFor("claude:redirect") }, 45], [SEARCH, 12], [spawned("migration", MIGRATION, "search", "search"), 9]]),
      threadsOn("ws_hetzner", [[{ ...CHART, id: "chart-box" }, 200], [{ ...REDIRECT, id: "redirect-box" }, 30]]),
    ),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, true),
      p_oldmacbook: place("p_oldmacbook", "old-macbook", 120, {}, true),
    },
  });

/** This computer and nothing else, as the person sitting at it first meets it: no project added yet, so no
 * workspace and no thread, since a workspace is a copy of a project. Two personas are given this one, the person
 * with a Mac and nothing else and the person who will sign in to nothing, because what those two meet is the same
 * window; what differs is what they try to do in it. */
const thisComputer = () => store({ projects: [], workspaces: [] });

/** This computer and an old laptop the person joined: this computer as the one workspace it is, the laptop as a
 * workspace standing on that computer, and the laptop itself in the places collection with the shape it reported,
 * four cores and 8 GB. It was a workspace of the local kind until a tester met his own ThinkPad claiming this Mac's
 * ten cores and a folder on this Mac: a joined computer is a place, and a local workspace is this computer alone.
 * One row for this Mac and not two, because one workspace stands on one machine and this computer is one machine:
 * a tester read "the only one it can be" beside three rows and could not tell which computer
 * two of them were on. No thread on either, since nothing has been run here yet. */
const macAndLaptop = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("landing", HERE, 60 * 9), project("notes", "p_oldlaptop", 60 * 20, "/home/dev/notes")],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" }), onPlace("ws_laptop", "old-laptop", "p_oldlaptop", { cpu: 4, memMb: 8192 }, "pr_notes")],
    places: {
      p_oldlaptop: place(
        "p_oldlaptop",
        "old-laptop",
        12,
        { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 61 * 1024 ** 3, login: { HOME: "/home/dev", USER: "dev", PATH: "/usr/bin" }, wsp: ["/home/dev/.wsp/bin/wsp"] },
        true,
      ),
    },
  });

/** This computer and a server of the person's own running Docker: the server is a place, and the workspace on it
 * stands there rather than at a provider. A fork at a cloud named "vps-build" was read as a rented machine wearing
 * the word for her own box. This computer is one row, for macAndLaptop's reason. */
const macAndVps = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("build", "p_vps", 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" }), onPlace("ws_build", "build", "p_vps", { cpu: 2, memMb: 4096 }, "pr_build")],
    places: {
      p_vps: place(
        "p_vps",
        "vps",
        2,
        { platform: "linux", os: "Debian GNU/Linux 12", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 44 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" }, wsp: ["/root/.wsp/bin/wsp"] },
        true,
      ),
    },
  });

/** One fork on Boat, asleep: no workspace on this computer at all, and no thread on it, since this person
 * has run nothing yet. This is the persona who comes to paste a key, so nothing of theirs may be awake and
 * spending while they type one: two running forks and $2.44 read to a tester as money already gone on a cloud
 * nobody had given a key to, and the meter moving a cent while the screen said "naps to $0" read as the product
 * contradicting itself. */
const asciiOnly = () =>
  store({
    projects: [project("api", CLOUD, 60 * 20)],
    workspaces: [fork("ws_api", "api", "fk_ascii_1", { phase: "napping", project: "pr_api" })],
    goldens: sealed(),
    // Nothing on the clock: this persona is on the trial they opened minutes ago, and a sidebar reading $0.48
    // before they had pasted a key was read as the product billing them for a machine they never made.
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 0, phase: "napping" })]),
  });

/** The switch a fixture's forks carry, the one a person turns on when they want the threads on a machine to open
 * threads of their own: on, capped at the two machines this account holds. Off is what a record without it reads
 * as, and the AGENTS column is then empty on every row, which a tester read as an image that carries no agent at
 * all. */
const AGENTS_SPAWN = { spawn: true, maxMachines: 2, maxDepth: 1 };

/** Forks on Solari and nothing else, one of them napping, which is where most of a fleet sits. */
const solariOnly = () =>
  store({
    projects: [project("api", CLOUD, 60 * 20), project("web", CLOUD, 60 * 20)],
    workspaces: [
      fork("ws_api", "api", "fk_slr_1", { agents: AGENTS_SPAWN, project: "pr_api" }),
      fork("ws_web", "web", "fk_slr_2", { agents: AGENTS_SPAWN, phase: "napping", vaultedAt: new Date(ago(90)).toISOString(), project: "pr_web" }),
    ],
    goldens: sealed(),
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 8 }), meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 3, phase: "napping" })]),
  });

/** Machines at a cloud and one on this computer: the sidebar a person who has moved between providers has. Both
 * forks wear the cloud this host is wired to, because a host forks at one provider and every row reads that one
 * word; a record that names its own provider is what a second cloud in one sidebar waits on. */
const bothProviders = () =>
  store({
    projects: [project("wsp", HERE, 60 * 5), project("api", CLOUD, 60 * 20), project("web", CLOUD, 60 * 20)],
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { project: "pr_wsp" }),
      fork("ws_api", "api", "fk_slr_1", { project: "pr_api" }),
      fork("ws_web", "web", "fk_slr_2", { phase: "napping", project: "pr_web" }),
    ],
    goldens: sealed(),
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 8 }), meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 4, phase: "napping" })]),
  });

/** The hash the record and every copy built from it carry; a copy built from an older record carries the other one,
 * which is what the copies table reads as stale. */
const IMAGE_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const OLDER_HASH = "da39a3ee5e6b4b0d3255bfef95601890afd80709da39a3ee5e6b4b0d3255bfef";

/** One row of a recipe as the record keeps it; the Image row counts them by kind. */
const recipeRow = (id, kind) => ({ id, kind, on: true, source: { kind: "popular", sessions: 0, images: 0 } });

/** The image record a host owns once wsp init has sealed one: what Settings > Image reads its facts line and its
 * Built row off. The vault is what says the sign-ins are held, so its absence would take the standing word off
 * every copy. */
const imageRecord = () => ({
  default: {
    name: "default",
    version: 1,
    hash: IMAGE_HASH,
    recipeHash: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    recipe: {
      version: 1,
      at: new Date(ago(150)).toISOString(),
      histories: [],
      rows: [
        ...["claude", "codex"].map(id => recipeRow(id, "agent")),
        ...["ripgrep", "fd", "jq", "gh", "node", "pnpm", "uv", "tmux"].map(id => recipeRow(id, "tool")),
      ],
    },
    pins: [
      { id: "claude", tag: "2.1.283" },
      { id: "codex", tag: "0.155.1" },
    ],
    logins: [
      { name: "claude", state: "copied" },
      { name: "gh", state: "signed-in" },
      { name: "npm", state: "copied" },
      { name: "aws", state: "skipped" },
    ],
    sealedAt: new Date(ago(150)).toISOString(),
    sealedFrom: "this Mac",
    vault: { sha256: "1c8e5f2a9b0d4e6f7a8b9c0d1e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b", bytes: 2_400_000, paths: 9, takenAt: new Date(ago(150)).toISOString() },
    usedBytes: Math.round(4.2 * 1024 ** 3),
  },
});

/** One place's built copy of the image, as that place's own manifest keeps it: the key names the place, the head
 * version's imageHash names the record it was built from. */
const copyAt = (place, minutes, extra = {}) => [
  `${place}/default`,
  {
    head: 1,
    versions: [
      {
        version: 1,
        snapshotId: `imgsnap_${place}`,
        baseTemplate: "base",
        setupSha: "0000000000000000000000000000000000000000000000000000000000000003",
        createdAt: new Date(ago(minutes)).toISOString(),
        smoke: { cmd: "claude --version", exitCode: 0 },
        size: { cpu: 2, memMb: 4096 },
        imageHash: IMAGE_HASH,
        usedBytes: Math.round(4.2 * 1024 ** 3),
        ...extra,
      },
    ],
  },
];

/** The third child's thread. The root's reply says a thread stands on each of the three machines, and the docs one
 * had none: a tester counted the rows, found two, and read the reply as the product lying to him. */
const DOCS_READ = {
  id: "docs-move",
  prompt: "check what the docs site does with the old queue",
  title: "Docs only read from the queue",
  thought: "If the docs never publish, there is nothing to move here and the machine can go back to sleep.",
  tool: { name: "Grep", input: '{"pattern":"queue","path":"apps/docs"}', result: "apps/docs/src/status.mdx:14" },
  reply: "The docs only read the queue's status page, so there is nothing to move. I have left the page as it is and stopped.",
  costUsd: 0.09,
};

/** Every state the one thread status slot draws, a child each under one root: working on api, stopped on a
 * permission prompt on web, failed on docs, and resting beside the working one on api. */
const threadStates = () => {
  const tree = { parentThreadId: threadId("migrate"), rootThreadId: threadId("migrate") };
  return store({
    projects: [project("wsp", HERE, 60 * 5), project("api", CLOUD, 60 * 9), project("web", CLOUD, 60 * 9), project("docs", CLOUD, 60 * 9)],
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, project: "pr_wsp" }),
      fork("ws_api", "api", "fk_run_1", { ...tree, project: "pr_api", createdAt: new Date(ago(60 * 8)).toISOString() }),
      fork("ws_web", "web", "fk_run_2", { ...tree, project: "pr_web", createdAt: new Date(ago(60 * 8 - 2)).toISOString() }),
      fork("ws_docs", "docs", "fk_run_3", { ...tree, project: "pr_docs", createdAt: new Date(ago(60 * 8 - 4)).toISOString() }),
    ],
    ...merge(
      threadsOn("ws_here", [[MIGRATE, 120]]),
      threadsOn("ws_api", [
        [spawned("api-index", MIGRATION, "migrate", "migrate"), 110],
        [{ ...spawned("api-move", REDIRECT, "migrate", "migrate"), status: "running" }, 4],
      ]),
      threadsOn("ws_web", [[{ ...spawned("web-move", CHART, "migrate", "migrate"), status: "running", asking: "Permission for Bash: pnpm install" }, 12]]),
      threadsOn("ws_docs", [[{ ...spawned("docs-move", DOCS_READ, "migrate", "migrate"), status: "failed" }, 30]]),
    ),
    goldens: sealed(),
    // Two computers the person joined beside the cloud, so the computer switcher lists a row of each kind.
    places: {
      p_spoo: place("p_spoo", "spoo", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
      p_studio: place("p_studio", "studio", 4, { runsWorkspaces: true }),
    },
  });
};

/** A person who drives agents with agents: this computer with spawning on, three forks a root thread made, and a
 * thread on each hanging under that root. */
const orchestrator = () => {
  const root = { ...MIGRATE };
  const tree = { parentThreadId: threadId("migrate"), rootThreadId: threadId("migrate") };
  return store({
    // Three forks made one after another, minutes apart, because the sidebar draws its rows in the order the
    // workspaces were made and a fixture where all three claim one minute says nothing about that order.
    projects: [project("wsp", HERE, 60 * 5), project("api", CLOUD, 60 * 9), project("web", CLOUD, 60 * 9), project("docs", CLOUD, 60 * 9)],
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, project: "pr_wsp" }),
      fork("ws_api", "api", "fk_run_1", { ...tree, project: "pr_api", createdAt: new Date(ago(60 * 8)).toISOString() }),
      fork("ws_web", "web", "fk_run_2", { ...tree, project: "pr_web", createdAt: new Date(ago(60 * 8 - 2)).toISOString() }),
      fork("ws_docs", "docs", "fk_run_3", { ...tree, project: "pr_docs", phase: "napping", createdAt: new Date(ago(60 * 8 - 4)).toISOString() }),
    ],
    ...merge(
      // Inside the two quiet hours a read tree folds after, whatever minute of the hour AT was rounded down from.
      threadsOn("ws_here", [[root, 55]]),
      threadsOn("ws_api", [[spawned("api-move", REDIRECT, "migrate", "migrate"), 45]]),
      threadsOn("ws_web", [[spawned("web-move", CHART, "migrate", "migrate"), 40]]),
      threadsOn("ws_docs", [[spawned("docs-move", DOCS_READ, "migrate", "migrate"), 35]]),
    ),
    goldens: sealed(),
    meters: Object.fromEntries([
      meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 2 }),
      meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 2 }),
      meter("ws_docs", { rateUsdPerHour: FORK_RATE, hours: 1, phase: "napping" }),
    ]),
  });
};

/** This computer with an image sealed and two computers of the person's own joined to it, both running Docker, and
 * no workspace on either yet: a person with somewhere to put one. What the creation log is photographed from. */
const macAndBoxes = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" })],
    goldens: sealed(),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
      p_studio: place("p_studio", "old-macbook", 4, { runsWorkspaces: true, engine: "docker" }),
    },
  });

/** Settings > Usage in the owner's shape, with a week behind it: Claude Code on an API key kept in wsp's keys, its
 * turns run on this computer and on Boat, Codex on ChatGPT Plus here with its last reading, Hermes Agent and
 * OpenCode installed with no plan limit, and a week of turns at the owner's size, a billion tokens a day nearly all
 * read from cache. The limits and the ledger days are what the host itself keeps; the price table is kept as read,
 * so no shot downloads it. */
const usageState = () => ({
  ...store({
    projects: [project("spoo", HERE, 60 * 20)],
    workspaces: [workspace("ws_here", THIS_COMPUTER, { project: "pr_spoo" })],
  }),
  "usage-index": { days: { days: usageDays().map(d => d.day) } },
  limits: {
    "claude:vault-key": { key: "claude:vault-key", agent: "claude", label: "Claude Code with an API key", road: "vault", windows: [], keyed: true, readAt: Date.now() - 12 * 60_000, computers: ["box", HERE] },
    "codex:acct_7f3": { key: "codex:acct_7f3", agent: "codex", label: "maya@example.com", road: "named", plan: "plus", windows: [{ kind: "session", usedPercent: 62, resetsAt: Date.now() + 150 * 60_000 }, { kind: "week", usedPercent: 18, resetsAt: Date.now() + 3 * 86_400_000 }], status: "ok", readAt: Date.now() - 20 * 60_000, computers: [HERE] },
  },
});

const dayKey = at => new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Seven days of the ledger, one document each, in this computer's zone as the host files them: Claude Code's turns
 * on the key here and on Boat, and Codex's here, none with a cost of its own, so the table prices them all. */
const usageDays = () =>
  Array.from({ length: 7 }, (_, back) => {
    const at = Date.now() - back * 86_400_000;
    const day = dayKey(at);
    const busy = [1.4, 0.6, 1.1, 0.3, 1.8, 0.9, 1.2][back];
    const row = (o, n) => ({ day, hour: 10 + (n % 8), turns: 3 + n, costReported: undefined, ...o });
    const tokens = (input, output, cached) => ({ input: Math.round(input * busy), output: Math.round(output * busy), cached: Math.round(cached * busy), cacheWrite: 0, reasoning: 0 });
    const clean = r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined));
    return {
      day,
      rows: [
        row({ agent: "claude", account: "claude:vault-key", computer: HERE, project: "pr_spoo", model: "claude-opus-4-5", tokens: tokens(640_000_000, 640_000, 602_000_000), source: "wsp" }, 1),
        row({ agent: "claude", account: "claude:vault-key", computer: "box", project: "pr_spoo", model: "claude-opus-4-5", tokens: tokens(410_000_000, 400_000, 380_000_000), source: "wsp" }, 2),
        row({ agent: "codex", account: "codex:acct_7f3", computer: HERE, project: "pr_spoo", model: "gpt-5.5", tokens: tokens(3_100_000, 6_000, 2_900_000), source: "wsp" }, 3),
      ].map(clean),
    };
  });

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** A week of this computer's minute readings as its daemon keeps them, a file a UTC day, with no reading from one
 * to seven each night while it slept, so the chart has its gaps. */
const readingsDays = () => {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const files = new Map();
  for (let at = now - 7 * 86_400_000; at <= now; at += 60_000) {
    const hour = new Date(at).getHours();
    if (hour >= 1 && hour < 7) continue;
    const t = at / 3_600_000;
    const work = Math.max(0, Math.sin(((hour - 8) / 14) * Math.PI));
    const cpu = Math.min(96, 6 + 38 * work + 9 * Math.abs(Math.sin(t * 3.1)) + 4 * Math.sin(t * 11.7));
    const mem = Math.round((14 + 7 * work + 1.5 * Math.sin(t * 0.7)) * GIB);
    const disk = Math.round(612 * GIB + ((at - (now - 7 * 86_400_000)) / 86_400_000) * 3.2 * GIB);
    const line = JSON.stringify({ at, cpu: Number(cpu.toFixed(1)), load1: Number((cpu / 12).toFixed(2)), mem: { used: mem, total: 32 * GIB }, disk: { used: disk, total: 994 * GIB } });
    const name = `${new Date(at).toISOString().slice(0, 10)}.jsonl`;
    files.set(name, `${files.get(name) ?? ""}${line}\n`);
  }
  return [...files].map(([name, text]) => ({ path: join("readings", name), text }));
};

/** Claude Code's own log of a week of work run outside wsp, in a folder no project holds: what the host's read of
 * this computer's logs files as outside wsp, a message a day. */
const claudeLog = () => {
  const lines = Array.from({ length: 7 }, (_, back) => {
    const at = Date.now() - back * 86_400_000 - 2 * 3_600_000;
    const usage = { input_tokens: 4_000 + back * 900, output_tokens: 6_000 + back * 400, cache_read_input_tokens: 90_000 + back * 11_000, cache_creation_input_tokens: 2_000 };
    return JSON.stringify({ type: "assistant", timestamp: new Date(at).toISOString(), cwd: join(HOME, "notes"), message: { id: `msg_fixture_${back}`, model: "claude-opus-4-5", usage } });
  });
  return { path: join("..", ".claude", "projects", "-notes", `${uuidFor("usage:claude-log")}.jsonl`), text: `${lines.join("\n")}\n` };
};

const usageFiles = () => [
  claudeLog(),
  ...usageDays().map(d => ({ path: join("blobs", "usage-days", d.day), text: JSON.stringify(d) })),
  { path: join("blobs", "prices", "litellm"), text: JSON.stringify({ fetchedAt: Date.now(), table: { "gpt-5.5": { input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, provider: "openai" }, "claude-opus-4-5": { input: 5e-6, output: 2.5e-5, cacheRead: 5e-7, cacheWrite: 6.25e-6, provider: "anthropic" } } }) },
  ...readingsDays(),
];

/** This computer's agents for the Usage fixture: the ones every fixture has, and OpenCode signed in with a key of
 * its own, which prints no limits. */
const USAGE_AGENTS = { ...HERE_AGENTS, agents: { ...HERE_AGENTS.agents, opencode: { version: "1.18.18", status: "1 credentials" }, hermes: { version: "0.4.2", status: "nous (1 credentials):\n  #1 nous-portal" } }, latest: { ...HERE_AGENTS.latest, opencode: "1.18.18", hermes: "0.4.2" } };

/** A person whose image is sealed and built in two places: what Settings > Image reads when there is a record to
 * read. One copy stands on the record as it is now and one was built from the record before it, so the table shows
 * both standing words. One workspace, for macInUse's reason: this computer is one machine. */
const imageBuilt = () =>
  store({
    projects: [project("spoo", HERE, 60 * 20), project("landing", HERE, 60 * 9)],
    workspaces: [workspace("ws_api", THIS_COMPUTER, { project: "pr_spoo" })],
    goldens: Object.fromEntries([copyAt("p_hetzner", 90), copyAt("ascii", 60, { imageHash: OLDER_HASH })]),
    images: imageRecord(),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, true),
    },
  });

/** One thread of the tiles fixture: a title that is its prompt, and a turn that reads it, since only the selected
 * thread's transcript is read in a shot. */
const tileThread = (id, title, over = {}) => ({
  id,
  prompt: title,
  title,
  thought: "Read the failing test before touching the code.",
  tool: { name: "Read", input: '{"file_path":"src/cart/total.ts"}', result: "export function total(lines) { return lines.reduce((sum, l) => sum + round(l.price), 0); }" },
  reply: "Done, and the branch is pushed.",
  costUsd: 0.2,
  ...over,
});

/** A copy on a branch, as the record keeps the copy it was made of. */
const copyOn = (name, branch) => ({ path: join(HOME, ".wsp", "worktrees", name), branch, made: true });

/** A lead on this computer and the threads its agent opened, each on a child copy of the same project on a branch of
 * its own: what the lead's THREADS rows read as the tree of branches. The copies' folders are not made, so each row's
 * branch is the one its copy record keeps, and the lead's is the branch it was cut from; the counts come from the
 * stand-in gh's compare, a branch it answers 404 for being one the remote lacks. */
const TREE_LEAD = {
  id: "tree-lead",
  prompt: "split the cart fixes across three helpers, then merge them into one pull request",
  title: "Cart fixes, one helper each",
  thought: "Three small fixes that touch different files: one child each, then merge them into my branch.",
  tool: { name: "wsp", input: '{"tool":"new","count":3}', result: "rounding, coupons, totals" },
  reply: "Three helpers are on it. I will merge each branch into mine as it lands and open one pull request.",
  costUsd: 0.42,
};
const helper = (id, title, over = {}) => ({
  ...spawned(
    id,
    { id, prompt: title.toLowerCase(), title, thought: "One file, then a commit on my own branch.", tool: { name: "Edit", input: '{"file_path":"src/cart/total.ts"}', result: "The file was updated." }, reply: "Done, committed on my branch and pushed.", costUsd: 0.2 },
    "tree-lead",
    "tree-lead",
  ),
  ...over,
});
const treeChild = (id, name, branch, extra = {}) =>
  workspace(id, name, { machineId: `local-${name}`, project: "pr_tree-lab", worktree: copyOn(`tree-lab-${name}`, branch), parentWorkspaceId: "ws_lead", parentThreadId: threadId("tree-lead"), rootThreadId: threadId("tree-lead"), base: "tree/lead", ...extra });
const treeFixture = children =>
  store({
    projects: [project("tree-lab", HERE, 60 * 3)],
    workspaces: [workspace("ws_lead", "cart fixes", { project: "pr_tree-lab", worktree: copyOn("tree-lab-lead", "tree/lead"), base: "tree/lead", agents: { spawn: true, maxMachines: 5, maxDepth: 1 } }), ...children.map(c => c.workspace)],
    ...merge(threadsOn("ws_lead", [[TREE_LEAD, 50]]), ...children.map(c => threadsOn(c.workspace.id, [[c.thread, c.minutes]]))),
  });
/** A child in each state the row draws before anything went wrong: working, quiet and ahead, merged, and not pushed. */
const treeRows = () =>
  treeFixture([
    { workspace: treeChild("ws_rounding", "rounding", "fix/rounding"), thread: helper("rounding", "Round the cart total once", { status: "running" }), minutes: 6 },
    { workspace: treeChild("ws_coupons", "coupons", "fix/coupons"), thread: helper("coupons", "Expire coupons at midnight"), minutes: 30 },
    { workspace: treeChild("ws_totals", "totals", "fix/totals", { tree: { merged: { oid: "4b825dc", at: ago(20), head: "9daeafb" } } }), thread: helper("totals", "Show totals with tax"), minutes: 40 },
    { workspace: treeChild("ws_badges", "badges", "fix/badges"), thread: helper("badges", "Badge the free shipping line"), minutes: 25 },
  ]);
/** A child whose merge into the lead stopped on conflicts, and one whose computer could not push its branch. */
const treeConflict = () =>
  treeFixture([
    { workspace: treeChild("ws_header", "header", "fix/header", { tree: { conflicts: ["lead.txt", "src/cart/total.ts"] } }), thread: helper("header", "Rename the cart header"), minutes: 20 },
    { workspace: treeChild("ws_badges", "badges", "fix/badges", { tree: { pushRefused: "this computer has no git credential for github.com, so nothing was pushed; sign gh in on it with gh auth login, then gh auth setup-git, then bring back again" } }), thread: helper("badges", "Badge the free shipping line"), minutes: 15 },
  ]);
/** What the stand-in gh's compare answers for the tree's branches against the lead's. */
const TREE_COMPARES = {
  "you/tree-lab": {
    "fix/rounding": { ahead_by: 1, behind_by: 0, status: "ahead" },
    "fix/coupons": { ahead_by: 2, behind_by: 0, status: "ahead" },
    "fix/totals": { ahead_by: 0, behind_by: 1, status: "behind" },
    "fix/badges": 404,
    "fix/header": { ahead_by: 1, behind_by: 1, status: "diverged" },
  },
};

/** The same sidebar with the person's marks on it: the relay pinned to the top, the paused fork's finish snoozed
 * out of the list, and the projects dragged into an order of their own. */
const tilesMarked = () => tiles({ marked: true });

/** The same sidebar with the lead's turn finished and the lead snoozed while two threads its agent opened still run:
 * the tree keeps its root alone at the foot of Idle, saying quietly how many work. */
const tilesSnoozed = () => tiles({ snoozedTree: true });

/** The sidebar the locked tile screens draw: a root on this computer stopped on a question, with three threads its
 * agent opened under it, one working beside it here and two on a Solari fork of the same project, one working and one
 * resting; then a working thread on the joined computer spoo, a finished one nobody has opened yet on a
 * Solari fork that has since paused, which reads Done and nothing about the pause, a failed one put away by hand and
 * three that were read and went quiet days ago, which fold into Settled. A fork carries no copy record and reads its branch off its own daemon, which no
 * stand-in machine answers for the project's folder, so its tiles show the agent's mark with no branch. One
 * workspace stands on this computer, for macInUse's reason, and each project wears a look, as a person picks one. */
const tiles = ({ marked = false, snoozedTree = false } = {}) => {
  const tree = { parent: "flaky", root: "flaky", startedBy: "agent" };
  const forkTree = { parentThreadId: threadId("flaky"), rootThreadId: threadId("flaky") };
  const spooPlace = place("p_spoo", "spoo", 1, { platform: "linux", os: "Ubuntu 24.04", runsWorkspaces: true, engine: "docker", login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, true);
  const onSpoo = (id, name, projectId, branch) => ({ ...onPlace(id, name, "p_spoo", { cpu: 4, memMb: 8192 }, projectId), worktree: copyOn(`${name}-${id}`, branch) });
  const landing = { icon: "folder", hue: "orange" };
  return store({
    projects: [
      project("spoo-landing", HERE, 60 * 30),
      { ...project("spoo-landing", CLOUD, 60 * 30), id: "pr_spoo-landing-cloud" },
      { ...project("spoo-landing", "p_spoo", 60 * 30), id: "pr_spoo-landing-spoo" },
      project("wsp", "p_spoo", 60 * 30),
      project("dark-contrast", CLOUD, 60 * 30),
    ],
    workspaces: [
      workspace("ws_flaky", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-flaky", "fix/checkout-flakes") }),
      fork("ws_solari", "spoo-landing", "fk_tile_1", { ...forkTree, project: "pr_spoo-landing-cloud" }),
      onSpoo("ws_relay", "relay", "pr_wsp", "relay-one-helper"),
      onSpoo("ws_release", "release", "pr_wsp", "release-0.9"),
      fork("ws_dark", "dark-contrast", "fk_tile_2", { phase: "napping", project: "pr_dark-contrast" }),
      onSpoo("ws_coupons", "coupons", "pr_spoo-landing-spoo", "feat/coupons"),
      onSpoo("ws_pty", "pty", "pr_wsp", "fix/pty-leak"),
      onSpoo("ws_diff", "diff-viewer", "pr_spoo-landing-spoo", "spike/diff-viewer"),
    ],
    ...merge(
      threadsOn("ws_flaky", [
        [tileThread("flaky", "Fix the three flaky checkout tests", snoozedTree ? { seen: true, snoozed: true } : { status: "running", asking: "Permission for Bash: pnpm test cart" }), 40],
        [{ ...tileThread("address", "Address form race", { status: "running", agent: "codex" }), ...tree }, 6],
      ]),
      threadsOn("ws_solari", [
        [{ ...tileThread("coupon", "Coupon expiry test", { seen: true }), ...tree }, 35],
        [
          {
            ...tileThread("cart", "Cart total rounding", { status: "running" }),
            ...tree,
            prompt: "Find why the cart total test is flaky and fix it. Push a branch and tell me.",
            reply: "Found it: the total rounds per line instead of once at the end. The test's fixture has three lines at 0.335, so the per line rounding lands on 1.00 or 1.01 depending on the order the cart iterates.\n\nMoved the rounding to the end in cart/total.ts, added a fixture that pins the order, and pushed fix/cart-rounding, 2 files. Telling the lead.",
          },
          14,
        ],
      ]),
      threadsOn("ws_relay", [[tileThread("relay", "Move the relay to one callback helper", { status: "running", pinned: marked }), 45]]),
      threadsOn("ws_dark", [[tileThread("dark", "Dark mode contrast pass", { agent: "codex", snoozed: marked }), 183]]),
      threadsOn("ws_release", [[tileThread("release", "Release notes for 0.9", { status: "failed", settled: true }), 240]]),
      threadsOn("ws_coupons", [[tileThread("coupons", "Coupon codes at checkout", { seen: true }), 60 * 30]]),
      threadsOn("ws_pty", [[tileThread("pty", "Stop the daemon leaking ptys", { seen: true }), 60 * 50]]),
      threadsOn("ws_diff", [[tileThread("diff", "Try the new diff viewer", { agent: "codex", seen: true }), 60 * 24 * 6]]),
    ),
    readsSince: 60 * 24 * 7,
    // The image built at Solari off the record, so the cloud's page reads its agents and its image row.
    goldens: { ...sealed(), ...Object.fromEntries([copyAt("solari", 90)]) },
    images: imageRecord(),
    places: { p_spoo: spooPlace },
    preferences: {
      projectLook: { "pr_spoo-landing": landing, "pr_spoo-landing-cloud": landing, "pr_spoo-landing-spoo": landing, "pr_dark-contrast": landing, pr_wsp: { icon: "terminal", hue: "teal" } },
      ...(marked ? { projectOrder: ["pr_wsp", "pr_dark-contrast", "pr_spoo-landing-spoo"] } : {}),
    },
  });
};

/** One send from spoo-landing's home to three models: a copy on this computer per model, each running the same task
 * under one attempt, beside a thread opened alone. What the sidebar's group and the home's picks are shot from. */
const tilesAttempt = () => {
  const task = "Find why the cart total test is flaky and fix it";
  const tried = (id, agent, model, label, minutes) => ({
    workspace: workspace(`ws_${id}`, `${nameOfTask(task)} (${label})`, { machineId: `local-${id}`, project: "pr_spoo-landing", worktree: copyOn(`spoo-landing-${id}`, `try/${id}`), createdAt: new Date(ago(minutes + 1)).toISOString() }),
    threads: threadsOn(`ws_${id}`, [[tileThread(id, task, { status: "running", agent, model, attempt: "att_cart" }), minutes]]),
  });
  const picks = [tried("opus", "claude", "claude-opus-5-5", "Opus 5.5", 12), tried("sonnet", "claude", "claude-sonnet-4-5", "Sonnet 4.5", 11.9), tried("sol", "codex", "gpt-5.6-sol", "GPT-5.6-Sol", 11.8)];
  return store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_flaky", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-flaky", "fix/checkout-flakes") }), ...picks.map(p => p.workspace)],
    ...merge(threadsOn("ws_flaky", [[tileThread("coupon", "Coupon expiry test", { seen: true }), 35]]), ...picks.map(p => p.threads)),
    readsSince: 60 * 24 * 7,
    preferences: { projectLook: { "pr_spoo-landing": { icon: "folder", hue: "orange" } } },
  });
};

/** The workspace name a home's send gives a copy: the task's first words, as the app's own nameOfTask cuts them. */
const nameOfTask = task => task.trim().split("\n")[0].split(/\s+/).filter(Boolean).slice(0, 5).join(" ").slice(0, 40);

/** A prompt long enough that the chat clamps its bubble, the size of a builder's brief pasted whole. */
const LONG_PROMPT = [
  "You are a builder for the spoo landing repo, working in this copy of it on this Mac. Build two small tickets as one branch and one PR:",
  "",
  "- The checkout page names this computer's copy by its real name",
  "- A fork's tile shows no branch",
  "",
  "Setup, in this folder:",
  "",
  "1. Read both tickets and every comment on them.",
  "2. Branch off main, and run the test gate before any report.",
  "3. Keep one commit until the review, then one commit per round.",
  "4. Post the report on each ticket when the gate is green.",
].join("\n");

/** A reply long enough to run under the composer, so the glass has words behind it. */
const LONG_REPLY = Array.from({ length: 8 }, (_, i) => `Step ${i + 1}: read the ticket, found the one place the name is written, and moved every caller onto it. The test that pins it went red first and is green now.`).join("\n\n");

/** One running thread on this computer whose first message is that long prompt, so the clamp, its fade and the
 * composer while a turn runs, with the reply scrolling under it, are all on one screen. */
const longPrompt = () =>
  store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_long", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-long", "main") })],
    ...merge(threadsOn("ws_long", [[tileThread("brief", "Two small tickets as one branch", { status: "running", prompt: LONG_PROMPT, reply: LONG_REPLY }), 3]])),
    goldens: sealed(),
  });

/** A thread of several turns on one session row, as a resumed turn keeps it: each turn's replay under its own id,
 * closed by the checkpoint the runtime records at its end, and the row naming the latest. */
const turnsOn = (workspaceId, thread, turns) => {
  const idOf = n => turnId(`${thread.id}:${n}`);
  const last = turns.length - 1;
  const events = turns.flatMap((t, n) => {
    const kept = n === last ? [] : [event(thread, { type: "session.checkpoint", at: ago(t.minutes - 3), ref: `refs/wsp/checkpoints/spoo-landing-rewind/${threadId(thread.id)}/${idOf(n)}`, anchor: uuidFor(`anchor:${thread.id}:${n}`) }, workspaceId)];
    return [...replay({ ...thread, ...t }, t.minutes, workspaceId), ...kept].map(e => ({ ...e, turnId: idOf(n) }));
  });
  const newest = { ...thread, ...turns[last] };
  return {
    sessions: { [workspaceId]: { workspaceId, sessions: [{ ...turn(newest, newest.minutes, workspaceId), turnId: idOf(last) }], threads: {} } },
    transcripts: { [workspaceId]: { workspaceId, events } },
  };
};

/** Two threads of three and two turns on a copy of spoo-landing, each earlier turn closed on a checkpoint, so Rewind
 * to here stands on their earlier replies: one on Claude, which cuts its own conversation and has a thread its agent
 * opened still working under it, and one on Cursor, which keeps its own and is rewound in its files alone. */
const rewind = () => {
  const cart = tileThread("rounding", "Find why the cart total test is flaky");
  const cursor = tileThread("tax", "Round the tax line once", { agent: "cursor", model: "auto" });
  // A thread the lead's agent opened, still working: a rewind of the lead waits for it.
  const child = tileThread("fixture", "Check the tax fixture", { status: "running", parent: "rounding", root: "rounding", startedBy: "agent" });
  const children = threadsOn("ws_rewind", [[child, 5]]);
  const claudeTurns = turnsOn("ws_rewind", cart, [
    { minutes: 40, prompt: "Find why the cart total test is flaky", reply: "The total rounds per line instead of once at the end, so three lines at 0.335 land on 1.00 or 1.01 depending on the order the cart iterates." },
    { minutes: 30, prompt: "Move the rounding to the end and pin it with a test", reply: "Moved the rounding to the end in cart/total.ts and added a fixture that pins the order. The test passes 200 times in a row." },
    { minutes: 20, prompt: "Now round the tax line the same way", reply: "Tax rounds once at the end too, in cart/tax.ts. Two files changed." },
  ]);
  const cursorTurns = turnsOn("ws_rewind", cursor, [
    { minutes: 15, prompt: "Round the tax line once", reply: "Tax now rounds once at the end, in cart/tax.ts." },
    { minutes: 10, prompt: "Add a test for the tax rounding", reply: "Added cart/tax.test.ts with the three line fixture." },
  ]);
  return store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_rewind", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-rewind", "fix/cart-rounding") })],
    sessions: { ws_rewind: { workspaceId: "ws_rewind", sessions: [...cursorTurns.sessions.ws_rewind.sessions, ...children.sessions.ws_rewind.sessions, ...claudeTurns.sessions.ws_rewind.sessions], threads: {} } },
    transcripts: { ws_rewind: { workspaceId: "ws_rewind", events: [...claudeTurns.transcripts.ws_rewind.events, ...cursorTurns.transcripts.ws_rewind.events, ...children.transcripts.ws_rewind.events] } },
    readsSince: 60 * 24 * 7,
    preferences: { projectLook: { "pr_spoo-landing": { icon: "folder", hue: "orange" } } },
  });
};

/** One project on this computer with three answered threads, each carrying what a reply draws under it: the model and
 * tokens its agent counted, the files it changed, the step list it worked through, the plan it proposed, and a reply
 * holding a diagram and a formula. */
const replies = () =>
  store({
    projects: [project("spoo-landing", HERE, 60 * 30)],
    workspaces: [workspace("ws_replies", THIS_COMPUTER, { project: "pr_spoo-landing", worktree: copyOn("spoo-landing-replies", "agent/slash") })],
    ...merge(
      threadsOn("ws_replies", [
        [
          tileThread("replies", "Short links keep their slash", {
            prompt: "keep the trailing slash on short links, and work through it as a list",
            model: "claude-opus-5-5",
            tokens: REPLY_TOKENS,
            steps: [
              { text: "Read the redirect middleware", state: "done" },
              { text: "Move the rewrite ahead of the host check", state: "done" },
              { text: "Pin the order with a test", state: "done" },
              { text: "Run the suite", state: "working" },
              { text: "Push the branch", state: "pending" },
            ],
            reply: ["The rewrite now runs before the canonical host check, so `/r/abc/` answers once.", "", "I added a test for the slash and the bare form, and the suite is running."].join("\n"),
            changes: {
              from: "1".repeat(40),
              to: "2".repeat(40),
              files: [
                { path: "apps/api/src/redirect.ts", kind: "modified", additions: 14, deletions: 3 },
                { path: "apps/api/src/middleware.ts", kind: "modified", additions: 2, deletions: 2 },
                { path: "apps/api/test/redirect.test.ts", kind: "added", additions: 38, deletions: 0 },
              ],
            },
          }),
          40,
        ],
        [
          tileThread("sweep", "Rename the link store across the app", {
            prompt: "rename LinkStore to Links everywhere it is used",
            model: "claude-opus-5-5",
            tokens: { ...REPLY_TOKENS, context: 96_400 },
            reply: "Renamed across the API, the web app and the shared package; the suite passes.",
            changes: {
              from: "3".repeat(40),
              to: "4".repeat(40),
              files: [
                ...Array.from({ length: 24 }, (_, n) => ({ path: `apps/api/src/links/route${n}.ts`, kind: "modified", additions: 6 + (n % 5), deletions: 4 + (n % 3) })),
                ...Array.from({ length: 14 }, (_, n) => ({ path: `apps/web/src/links/Link${n}.tsx`, kind: "modified", additions: 3 + (n % 4), deletions: 2 })),
                ...Array.from({ length: 8 }, (_, n) => ({ path: `packages/shared/src/store${n}.ts`, kind: n === 0 ? "added" : "modified", additions: 12, deletions: n === 0 ? 0 : 9 })),
                { path: ".github/workflows/ci.yml", kind: "modified", additions: 1, deletions: 1 },
                { path: "docs/links.md", kind: "modified", additions: 8, deletions: 8 },
                { path: "CHANGELOG.md", kind: "modified", additions: 3, deletions: 0 },
                { path: "README.md", kind: "modified", additions: 2, deletions: 2 },
              ],
            },
          }),
          30,
        ],
        [
          tileThread("tasks", "Pin the redirect order", {
            prompt: "pin the redirect order with a test and push it, as a list",
            model: "claude-opus-5-5",
            status: "running",
            steps: [
              { text: "Read the redirect middleware", state: "done" },
              { text: "Move the rewrite ahead of the host check", state: "done" },
              { text: "Pin the order with a test", state: "done" },
              { text: "Run the suite", state: "working" },
              { text: "Push the branch", state: "pending" },
            ],
            reply: "The rewrite runs first now; running the suite before I push.",
          }),
          6,
        ],
        [
          tileThread("planned", "Plan a quiet flag", {
            prompt: "plan how to add a --quiet flag",
            model: "claude-opus-5-5",
            tokens: { ...REPLY_TOKENS, context: 18_900 },
            proposed: ["# Add a --quiet flag", "", "1. Parse `--quiet` beside `--json` in `cli.ts`.", "2. Route every progress line through one writer that the flag silences.", "3. Keep errors on stderr whatever the flag says.", "4. Add a test for each of the three."].join("\n"),
            reply: "That is the plan. Say go and I will start with the parser.",
          }),
          20,
        ],
        [
          tileThread("diagram", "Build steps as a diagram", {
            prompt: "reply with a Mermaid flowchart of the build steps and the quadratic formula in LaTeX",
            model: "claude-opus-5-5",
            tokens: { ...REPLY_TOKENS, context: 61_020 },
            reply: [
              "The build, step by step:",
              "",
              "```mermaid",
              "flowchart LR",
              "  A[Install] --> B[Type check]",
              "  B --> C[Test]",
              "  C --> D[Bundle]",
              "  D --> E[Stage the app]",
              "```",
              "",
              "And the quadratic formula:",
              "",
              "$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$",
              "",
              "which holds for any $a \\neq 0$.",
            ].join("\n"),
          }),
          10,
        ],
      ]),
    ),
    goldens: sealed(),
  });

/** Every setup a lab can serve, by the word `--fixture` takes. One row per kind of person: what builds its store,
 * the cloud its machines are meant to be at, which the stand-in provider then wears as its own word, and the
 * repositories that person already keeps at the top of their home, which wsp has imported nowhere, and the keys
 * they have saved, which is what the host reads a cloud's key as held off. Without the
 * cloud word every fork in a fixture reads "fake" on the row where a person reads which cloud they are paying;
 * without a repository of their own, a person told to point the app at one of their repositories has none to point
 * it at. Adding a fixture is a row here and its builder above. */
const FIXTURES = {
  "mac-in-use": { build: macInUse },
  "mac-only": { build: thisComputer, repos: ["spoo"] },
  "mac-and-laptop": { build: macAndLaptop },
  "mac-and-vps": { build: macAndVps },
  "ascii-only": { build: asciiOnly, cloud: "box" },
  "solari-only": { build: solariOnly, cloud: "solari" },
  "both-providers": { build: bothProviders, cloud: "solari" },
  "no-sign-in": { build: thisComputer },
  "mac-and-boxes": { build: macAndBoxes },
  orchestrator: { build: orchestrator, cloud: "box" },
  "thread-states": { build: threadStates, cloud: "box" },
  tiles: { build: tiles, cloud: "solari", keys: { SOLARI_API_KEY: "slr_fixture_not_a_key" } },
  "tiles-marks": { build: tilesMarked, cloud: "solari" },
  "tiles-snoozed": { build: tilesSnoozed, cloud: "solari" },
  "tiles-attempt": { build: tilesAttempt },
  "image-built": { build: imageBuilt },
  "long-prompt": { build: longPrompt },
  changes: { build: macInUse, changes: ["spoo"] },
  "pull-request": { build: macInUse, changes: ["spoo"], pulls: "failed" },
  "pull-request-conflict": { build: macInUse, changes: ["spoo"], pulls: "conflict" },
  tree: { build: treeRows, compares: TREE_COMPARES },
  "tree-conflict": { build: treeConflict, compares: TREE_COMPARES },
  "review-draft": { build: inReview(false), changes: ["spoo"], pulls: "failed" },
  "review-posted": { build: inReview(true), changes: ["spoo"], pulls: "failed" },
  rewind: { build: rewind },
  replies: { build: replies },
  usage: { build: usageState, files: usageFiles, agents: () => USAGE_AGENTS, keys: { ANTHROPIC_API_KEY: "sk-ant-x-fixture-not-a-key" } },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** The project folders a fixture leaves mid-work, a branch one commit ahead of main with three files changed and
 * nothing committed, so the Changes pane and a tile's counts have something to show: empty for every other fixture. */
export function fixtureChanges(name, state) {
  const named = new Set(fixtureRow(name).changes ?? []);
  return Object.values(state.projects ?? {}).flatMap(p => (p.computer === HERE && named.has(p.name) ? [p.path] : []));
}

/** The branch compares a fixture's stand-in gh answers, by repository and head branch: none for every fixture that names none. */
export const fixtureCompares = name => (name === undefined ? {} : (fixtureRow(name).compares ?? {}));

/** The pull requests a fixture's stand-in gh answers for: none for every fixture that names none. */
export const fixturePulls = name => {
  const named = name === undefined ? undefined : fixtureRow(name).pulls;
  return named === undefined ? [] : FIXTURE_PULLS[named];
};

/** The files a fixture's host keeps beside its state file, each a path under that folder: blobs and a daemon's
 * readings. None for a fixture that names none. */
export const fixtureFiles = name => (name === undefined ? [] : (fixtureRow(name).files?.() ?? []));

/** This computer's agents as a fixture's host reads them: every fixture's, unless it names its own. */
export const fixtureAgents = name => (name === undefined ? HERE_AGENTS : (fixtureRow(name).agents?.() ?? HERE_AGENTS));

const fixtureRow = name => {
  const row = FIXTURES[name];
  if (row === undefined) throw new Error(`no fixture is called ${name}; there is ${FIXTURE_NAMES.join(", ")}`);
  return row;
};

/** The whole store one fixture serves, with every folder in it under the home the host will run in: a lab passes
 * its own, so nothing a tester's agent opens is the person's. The default is this computer's home, which is what
 * the screenshot run photographs; a lab that took it would put a tester's turn in the person's own repository. */
export function fixtureState(name = "mac-in-use", { home = homedir() } = {}) {
  HOME = resolve(home);
  CLOUD = fixtureRow(name).cloud;
  // A host reads a state file in its own shape alone, so a fixture carries the document this build writes.
  return { ...fixtureRow(name).build(), $shape: { shape: STATE_SHAPE, wsp: "fixture", daemon: DAEMON_VERSION, bin: "fixture-state.mjs", at: new Date(AT).toISOString() } };
}

/** How big every snapshot in a fixture's image reads. Two of them sit inside the stand-in's ten free GB, so the
 * line pricing what an account is storing shows a size and owes nothing. */
const SNAPSHOT_BYTES = Math.round(4.2 * 1024 ** 3);

/** What the provider behind a fixture is already holding: one snapshot per version of every image the fixture says
 * was sealed, in the shape a provider lists them. A stand-in that listed none answered "0 snapshots" on the line
 * that prices an account's storage while the Versions table above it showed two, and a snapshot taken on the same
 * screen did not move it. */
export function fixtureSnapshots(state) {
  return Object.entries(state.goldens ?? {}).flatMap(([golden, manifest]) =>
    manifest.versions.map(v => ({ id: v.snapshotId, name: `wsp-standin-${golden.replace(/[^a-z0-9]+/g, "-")}-v${v.version}`, sizeBytes: SNAPSHOT_BYTES, createdAt: v.createdAt })),
  );
}

/** Whether a fixture's workspace is a fork at the provider the host forks on, which the stand-in answers for; a fork
 * on a joined computer is that computer's, and the stand-in holds nothing of it. */
export const atProvider = w => w.kind === "cloud" && w.place === undefined;

/** The disk every fork in a fixture reads as, the same figure the stand-in gives a machine it mints itself. */
const STANDIN_DISK_GB = 20;

/** Every machine a fixture names, in the state that fixture says it is in, for the stand-in's own records. The
 * state belongs in the records rather than in the machine's id: the stand-in used to read a suffix on the id to
 * know a machine slept, and the id is what `wsp workspaces` prints, so a tester read `fk_slr_2.paused` in the
 * MACHINE column beside a STATE column saying Running. The records file is the one place a fixture and the
 * provider can both read the same fact, and a lab writes it before the host comes up. */
export function fixtureMachines(state) {
  return Object.fromEntries(
    Object.values(state.workspaces ?? {})
      .filter(atProvider)
      .map(w => [
        w.machineId,
        {
          state: w.phase === "napping" ? "paused" : "running",
          shape: { cpu: w.size.cpu, memMb: w.size.memMb, diskGb: STANDIN_DISK_GB, createdAt: w.createdAt },
          labels: {},
        },
      ]),
  );
}

/** Everything the stand-in behind a fixture holds before the host comes up: its machines and its snapshots, in the
 * shape its own records file takes. Both harnesses seed it, so a fork reads the state its fixture gave it whether
 * or not the machines have a folder to run commands in. */
export const fixtureFleet = state => ({ machines: fixtureMachines(state), snapshots: fixtureSnapshots(state) });

/** Every folder a fixture expects to exist on this computer, so whoever serves it can make them: the folder of each
 * project here, which is where a turn on a workspace of it starts. */
export function fixtureFolders(state) {
  return Object.values(state.projects ?? {}).flatMap(p => (p.computer === HERE ? [p.path] : []));
}

/** The repositories a fixture's person already has, as folders under the home the host serving it runs in: work of
 * their own at the top of their home, where a person keeps theirs and where the app's folder picker opens, and
 * never a project any workspace has imported. A tester asked to import one of their own repositories walked up
 * from the work folder, found the app, the bin folder and the work folder, and had nothing to point the app at.
 * Empty for a fixture whose person keeps none. */
export function fixtureRepos(name, { home = homedir() } = {}) {
  return (fixtureRow(name).repos ?? []).map(folder => join(resolve(home), folder));
}

/** The keys a fixture's person has saved, by the variable each is read under: what the host reads as held, never a
 * key any provider takes. The stand-in serves the cloud whatever it holds, so nothing is ever asked with one. */
export function fixtureKeys(name = "mac-in-use") {
  return fixtureRow(name).keys ?? {};
}

/** The cloud a fixture's machines are meant to be at, by the id that provider's own module carries; nothing for a
 * fixture with no cloud machine in it. The host serves every fork through the stand-in whichever this says, and
 * the word only decides what the rows call the place those machines live. */
export function fixtureCloud(name = "mac-in-use") {
  return fixtureRow(name).cloud;
}
