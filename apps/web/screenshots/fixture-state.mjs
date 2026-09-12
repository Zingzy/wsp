// SPDX-License-Identifier: AGPL-3.0-only
// The throwaway states a screenshot run and a persona lab serve, one per kind
// of person: what their sidebar holds, whether an image is sealed, and what
// their threads say. The default is what the screenshot run photographs, this
// computer with work on it and two computers of the person's own joined to it,
// the folders imported into this one and the threads with the transcript each
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

/** The folder a workspace's projects are imported into, the way wsp imports one: under the work folder of the home
 * the host runs in, never beside the person's own checkouts. */
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
  home: HOME,
  folder: HOME,
  spec: {},
  ...extra,
});

const project = (name, size, minutes) => ({ name, dest: projectDest(name), importedAt: new Date(ago(minutes)).toISOString(), size });

const turn = (thread, minutes, workspaceId = "ws_api") => ({
  id: sessionId(thread.id),
  workspaceId,
  harness: "claude",
  status: "completed",
  startedBy: thread.startedBy ?? "person",
  threadId: threadId(thread.id),
  turnId: turnId(thread.id),
  prompt: thread.prompt,
  harnessTitle: thread.title,
  titleSource: "harness",
  startedAt: ago(minutes),
  endedAt: ago(minutes - 3),
  cwd: thread.cwd ?? projectDest("spoo"),
  model: "opus",
  permissionMode: "default",
  // What the turn on this row cost, as the runtime stamps it: a thread's opener reads its own figure beside what
  // the threads it opened spent, and a row without one would leave that second figure unsaid.
  costUsd: thread.costUsd,
  ...(thread.parent === undefined ? {} : { parentThreadId: threadId(thread.parent), rootThreadId: threadId(thread.root) }),
});

const event = (thread, rest, workspaceId = "ws_api") => ({ workspaceId, sessionId: sessionId(thread.id), threadId: threadId(thread.id), turnId: turnId(thread.id), ...rest });

/** A whole turn as the transcript holds it: the person's words, a thought, one tool call and its result,
 * the reply, and the two events that close it. */
const replay = (thread, minutes, workspaceId = "ws_api") => [
  event(thread, { type: "session.start", at: ago(minutes), prompt: thread.prompt, model: "opus", cwd: thread.cwd ?? projectDest("spoo"), ...(thread.harness === undefined ? {} : { harness: thread.harness }) }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "thinking", text: thread.thought }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "tool_use", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.input }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "tool_result", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.result }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "text", text: thread.reply }, workspaceId),
  event(thread, { type: "session.done", at: ago(minutes - 3), result: { status: "completed", durationMs: 178_000, costUsd: thread.costUsd, text: thread.reply } }, workspaceId),
  event(thread, { type: "session.end", at: ago(minutes - 3), exitCode: 0, sawResult: true }, workspaceId),
];

/** What a real init announces, cut to what fits a shot: a run of bare names, the CLI's own screens among them,
 * and the commands two plugins named themselves in. The menu groups on the source those names carry. */
const ANNOUNCED_COMMANDS = ["compact", "context", "cost", "init", "review", "login", "model", "unslop", "why", "wizard", "code-review:code-review", "ralph-loop:ralph-loop", "ralph-loop:cancel-ralph"];

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

/** One store as the JSON file holds it: one object per collection, keyed the way the runtime keys it. Every
 * fixture below builds one. */
const store = ({ workspaces, sessions = {}, transcripts = {}, goldens, images, places, meters }) => ({
  workspaces: Object.fromEntries(workspaces.map(w => [w.id, w])),
  sessions,
  transcripts,
  ...(goldens !== undefined ? { goldens } : {}),
  ...(meters === undefined ? {} : { "cost-histories": meters }),
  ...(images !== undefined ? { images } : {}),
  ...(places === undefined
    ? {}
    : {
        places,
        // The last computer added is the one a verb means when nobody says; its row wears the mark.
        "place-default": { default: { placeId: Object.keys(places)[0] } },
      }),
});

/** A workspace standing on a joined computer: the machine id the engine gives one, so the settings table counts it
 * against that computer's row. Every path a turn there runs under is built from the login it reported, so a record
 * without one is a record no join wrote and the runtime refuses it at startup. */
const onPlace = (id, name, placeId, size, login = { HOME: "/root", USER: "root", PATH: "/usr/local/bin:/usr/bin:/bin" }) => ({
  id,
  name,
  machineId: `place:${placeId}`,
  phase: "running",
  kind: "place",
  golden: "",
  createdAt: new Date(ago(60 * 20)).toISOString(),
  home: login.HOME,
  folder: login.HOME,
  login,
  size,
  shape: size,
  spec: {},
});

/** A computer somebody joined, as the host's record of it: what it last reported about itself, and when it was
 * last seen, so the table has a row that is not this computer. */
const place = (id, name, minutes, over = {}, workspaceId) => ({
  id,
  name,
  ...(workspaceId === undefined ? {} : { workspaceId }),
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
    docker: false,
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
  sessions: { [workspaceId]: { workspaceId, sessions: rows.map(([thread, minutes]) => turn(thread, minutes, workspaceId)) } },
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
 * the folders imported into this one, threads on two of them, and no image sealed, so the cloud setup button
 * stands in the sidebar's foot. What the screenshot run photographs, since a surface with nothing on it shows a
 * reviewer nothing.
 *
 * Three rows and not five: one workspace stands on one machine, and this computer is one machine, so the four
 * local rows this fixture used to carry are a sidebar wsp refuses to make (`alreadyRecorded`). The ids stay where
 * they were, since the surfaces list names rows by id: ws_api is this computer now, and ws_web the workspace on
 * the old MacBook. The threads that stood on the rows that went stand on this computer, which is where a person
 * with one Mac would have run them. */
const macInUse = () =>
  store({
    workspaces: [
      workspace("ws_api", THIS_COMPUTER, { projects: [project("spoo", 48_200_000, 60 * 20), project("wsp", 133_000_000, 60 * 5), project("landing", 9_400_000, 60 * 9)] }),
      onPlace("ws_web", "web", "p_oldmacbook", { cpu: 4, memMb: 8192 }, { HOME: "/Users/maya", USER: "maya", PATH: "/usr/local/bin:/usr/bin:/bin" }),
      onPlace("ws_hetzner", "box-build", "p_hetzner", { cpu: 2, memMb: 4096 }),
    ],
    ...merge(
      threadsOn("ws_api", [[CHART, 300], [REDIRECT, 45], [SEARCH, 12], [spawned("migration", MIGRATION, "search", "search"), 9]]),
      threadsOn("ws_hetzner", [[CHART, 200], [REDIRECT, 30]]),
    ),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, docker: true, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, "ws_hetzner"),
      p_oldmacbook: place("p_oldmacbook", "old-macbook", 120, {}, "ws_web"),
    },
  });

/** This computer and nothing else, as the person sitting at it first meets it: one workspace, named after this
 * computer, with no folder imported and no thread on it. Two personas are given this one, the person with a Mac
 * and nothing else and the person who will sign in to nothing, because what those two meet is the same window;
 * what differs is what they try to do in it. */
const thisComputer = () => store({ workspaces: [workspace("ws_here", THIS_COMPUTER)] });

/** This computer and an old laptop the person joined: this computer as the one workspace it is, the laptop as a
 * workspace standing on that computer, and the laptop itself in the places collection with the shape it reported,
 * four cores and 8 GB. It was a workspace of the local kind until a tester met his own ThinkPad claiming this Mac's
 * ten cores and a folder on this Mac: a joined computer is a place, and a local workspace is this computer alone.
 * One row for this Mac and not two, because one workspace stands on one machine and this computer is one machine
 * (`alreadyRecorded`): a tester read "the only one it can be" beside three rows and could not tell which computer
 * two of them were on. No thread on either, since nothing has been run here yet. */
const macAndLaptop = () =>
  store({
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { projects: [project("spoo", 48_200_000, 60 * 20), project("landing", 9_400_000, 60 * 9)] }),
      onPlace("ws_laptop", "old-laptop", "p_oldlaptop", { cpu: 4, memMb: 8192 }, { HOME: "/home/dev", USER: "dev", PATH: "/usr/local/bin:/usr/bin:/bin" }),
    ],
    places: {
      p_oldlaptop: place(
        "p_oldlaptop",
        "old-laptop",
        12,
        { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 61 * 1024 ** 3, login: { HOME: "/home/dev", USER: "dev", PATH: "/usr/bin" }, wsp: ["/home/dev/.wsp/bin/wsp"] },
        "ws_laptop",
      ),
    },
  });

/** This computer and a server of the person's own running Docker: the server is a place, and the workspace on it
 * stands there rather than at a provider. A fork at a cloud named "vps-build" was read as a rented machine wearing
 * the word for her own box. This computer is one row, for macAndLaptop's reason. */
const macAndVps = () =>
  store({
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      onPlace("ws_build", "build", "p_vps", { cpu: 2, memMb: 4096 }),
    ],
    places: {
      p_vps: place(
        "p_vps",
        "vps",
        2,
        { platform: "linux", os: "Debian GNU/Linux 12", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 44 * 1024 ** 3, docker: true, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" }, wsp: ["/root/.wsp/bin/wsp"] },
        "ws_build",
      ),
    },
  });

/** One fork on Box by ASCII, asleep: no workspace on this computer at all, and no thread on it, since this person
 * has run nothing yet. This is the persona who comes to paste a key, so nothing of theirs may be awake and
 * spending while they type one: two running forks and $2.44 read to a tester as money already gone on a cloud
 * nobody had given a key to, and the meter moving a cent while the screen said "naps to $0" read as the product
 * contradicting itself. */
const asciiOnly = () =>
  store({
    workspaces: [fork("ws_api", "api", "fk_ascii_1", { phase: "napping", projects: [project("api", 48_200_000, 60 * 20)] })],
    goldens: sealed(),
    // Nothing on the clock: this persona is on the trial they opened minutes ago, and a sidebar reading $0.48
    // before they had pasted a key was read as the product billing them for a machine they never made.
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 0, phase: "napping" })]),
  });

/** Forks on Solari and nothing else, one of them napping, which is where most of a fleet sits. */
const solariOnly = () =>
  store({
    workspaces: [
      fork("ws_api", "api", "fk_slr_1", { projects: [project("api", 48_200_000, 60 * 20)] }),
      fork("ws_web", "web", "fk_slr_2", { phase: "napping", vaultedAt: new Date(ago(90)).toISOString() }),
    ],
    goldens: sealed(),
    meters: Object.fromEntries([meter("ws_api", { rateUsdPerHour: FORK_RATE, hours: 8 }), meter("ws_web", { rateUsdPerHour: FORK_RATE, hours: 3, phase: "napping" })]),
  });

/** Machines at a cloud and one on this computer: the sidebar a person who has moved between providers has. Both
 * forks wear the cloud this host is wired to, because a host forks at one provider and every row reads that one
 * word; a record that names its own provider is what a second cloud in one sidebar waits on. */
const bothProviders = () =>
  store({
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { projects: [project("wsp", 133_000_000, 60 * 5)] }),
      fork("ws_api", "api", "fk_slr_1", { projects: [project("api", 48_200_000, 60 * 20)] }),
      fork("ws_web", "web", "fk_slr_2", { phase: "napping" }),
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
        ...["agents/claude", "agents/codex"].map(id => recipeRow(id, "agent")),
        ...["ripgrep", "fd", "jq", "gh", "fzf", "bat", "delta", "httpie", "node", "pnpm", "uv", "tmux", "neovim"].map(name => recipeRow(`tools/brew/${name}`, "tool")),
      ],
    },
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

/** A person who drives agents with agents: this computer with spawning on, three forks a root thread made, and a
 * thread on each hanging under that root. */
const orchestrator = () => {
  const root = { ...MIGRATE };
  const tree = { parentThreadId: threadId("migrate"), rootThreadId: threadId("migrate") };
  return store({
    // Three forks made one after another, minutes apart, because the sidebar draws its rows in the order the
    // workspaces were made and a fixture where all three claim one minute says nothing about that order.
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, projects: [project("wsp", 133_000_000, 60 * 5)] }),
      fork("ws_api", "api", "fk_run_1", { ...tree, createdAt: new Date(ago(60 * 8)).toISOString() }),
      fork("ws_web", "web", "fk_run_2", { ...tree, createdAt: new Date(ago(60 * 8 - 2)).toISOString() }),
      fork("ws_docs", "docs", "fk_run_3", { ...tree, phase: "napping", createdAt: new Date(ago(60 * 8 - 4)).toISOString() }),
    ],
    ...merge(
      threadsOn("ws_here", [[root, 120]]),
      threadsOn("ws_api", [[spawned("api-move", REDIRECT, "migrate", "migrate"), 100]]),
      threadsOn("ws_web", [[spawned("web-move", CHART, "migrate", "migrate"), 90]]),
      threadsOn("ws_docs", [[spawned("docs-move", DOCS_READ, "migrate", "migrate"), 85]]),
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
 * no workspace on either yet: the person the New workspace dialog is written for, who has somewhere to put one and
 * has to pick. What the dialog and the creation log are photographed from. */
const macAndBoxes = () =>
  store({
    workspaces: [workspace("ws_here", THIS_COMPUTER, { projects: [project("spoo", 48_200_000, 60 * 20)] })],
    goldens: sealed(),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, docker: true, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }),
      p_studio: place("p_studio", "old-macbook", 4, { docker: true }),
    },
  });

/** A person whose image is sealed and built in two places: what Settings > Image reads when there is a record to
 * read. One copy stands on the record as it is now and one was built from the record before it, so the table shows
 * both standing words. One workspace, for macInUse's reason: this computer is one machine. */
const imageBuilt = () =>
  store({
    workspaces: [workspace("ws_api", THIS_COMPUTER, { projects: [project("spoo", 48_200_000, 60 * 20), project("landing", 9_400_000, 60 * 9)] })],
    goldens: Object.fromEntries([copyAt("hetzner", 90), copyAt("ascii", 60, { imageHash: OLDER_HASH })]),
    images: imageRecord(),
  });

/** Every setup a lab can serve, by the word `--fixture` takes. One row per kind of person: what builds its store,
 * and the cloud its machines are meant to be at, which the stand-in provider then wears as its own word. Without
 * that word every fork in a fixture reads "fake" on the row where a person reads which cloud they are paying.
 * Adding a fixture is a row here and its builder above. */
const FIXTURES = {
  "mac-in-use": { build: macInUse },
  "mac-only": { build: thisComputer },
  "mac-and-laptop": { build: macAndLaptop },
  "mac-and-vps": { build: macAndVps },
  "ascii-only": { build: asciiOnly, cloud: "box" },
  "solari-only": { build: solariOnly, cloud: "solari" },
  "both-providers": { build: bothProviders, cloud: "solari" },
  "no-sign-in": { build: thisComputer },
  "mac-and-boxes": { build: macAndBoxes },
  orchestrator: { build: orchestrator, cloud: "box" },
  "image-built": { build: imageBuilt },
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

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
  return fixtureRow(name).build();
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
      .filter(w => w.kind === "cloud")
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

/** Every folder a fixture expects to exist, so whoever serves it can make them: the projects imported into its
 * workspaces, which is where a turn on one of them starts. */
export function fixtureFolders(state) {
  return Object.values(state.workspaces ?? {}).flatMap(w => (w.projects ?? []).map(p => p.dest));
}

/** The cloud a fixture's machines are meant to be at, by the id that provider's own module carries; nothing for a
 * fixture with no cloud machine in it. The host serves every fork through the stand-in whichever this says, and
 * the word only decides what the rows call the place those machines live. */
export function fixtureCloud(name = "mac-in-use") {
  return fixtureRow(name).cloud;
}
