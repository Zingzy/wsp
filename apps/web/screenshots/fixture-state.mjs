// SPDX-License-Identifier: AGPL-3.0-only
// The throwaway states a screenshot run and a persona lab serve, one per kind
// of person: what their sidebar holds, whether an image is sealed, and what
// their threads say. The default is what the screenshot run photographs, this
// computer with work on it, four workspaces of the local kind, folders
// imported into three of them and the threads with the transcript each
// replays, one of them opened by another thread's agent, so no surface is
// photographed empty and the spawned row's grammar is in a shot; the rest vary
// the setup a tester meets. Nothing here is a real computer, a real key or a
// real folder, and the copies are served by the provider that answers out of
// memory, so no fixture dials anything.
//
// Every folder a fixture names sits under this computer's own home, and a
// workspace of the local kind is named the way wsp names one here. A tester
// given somebody else's home and somebody else's threads spent their first
// minute working out whose Mac they were on.
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** This computer, as the app would show it to the person sitting at it: their own home, and the name wsp gives a
 * workspace of the local kind, which is this computer's host name. */
const HOME = homedir();
const THIS_COMPUTER = hostname();

/** Every stamp hangs off the hour this run started in rather than a date written here: the app words a
 * thread's time as a distance from now, and a fixed date would drift into the future and read "now" on
 * every row. Rounded to the hour so two runs in one hour are byte for byte the same. */
const AT = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const ago = minutes => AT - minutes * 60_000;

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
  ...extra,
});

const project = (name, size, minutes) => ({ name, dest: join(HOME, name), importedAt: new Date(ago(minutes)).toISOString(), size });

const turn = (thread, minutes, workspaceId = "ws_api") => ({
  id: `s_${thread.id}`,
  workspaceId,
  harness: "claude",
  status: "completed",
  startedBy: thread.startedBy ?? "person",
  threadId: `th_${thread.id}`,
  turnId: `turn_${thread.id}`,
  prompt: thread.prompt,
  harnessTitle: thread.title,
  titleSource: "harness",
  startedAt: ago(minutes),
  endedAt: ago(minutes - 3),
  cwd: thread.cwd ?? join(HOME, "spoo"),
  model: "opus",
  permissionMode: "default",
  ...(thread.parent === undefined ? {} : { parentThreadId: `th_${thread.parent}`, rootThreadId: `th_${thread.root}` }),
});

const event = (thread, rest, workspaceId = "ws_api") => ({ workspaceId, sessionId: `s_${thread.id}`, threadId: `th_${thread.id}`, turnId: `turn_${thread.id}`, ...rest });

/** A whole turn as the transcript holds it: the person's words, a thought, one tool call and its result,
 * the reply, and the two events that close it. */
const replay = (thread, minutes, workspaceId = "ws_api") => [
  event(thread, { type: "session.start", at: ago(minutes), prompt: thread.prompt, model: "opus", cwd: thread.cwd ?? join(HOME, "spoo") }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "thinking", text: thread.thought }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 1), kind: "tool_use", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.input }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "tool_result", toolName: thread.tool.name, toolUseId: `tu_${thread.id}`, text: thread.tool.result }, workspaceId),
  event(thread, { type: "session.delta", at: ago(minutes - 2), kind: "text", text: thread.reply }, workspaceId),
  event(thread, { type: "session.done", at: ago(minutes - 3), result: { status: "completed", durationMs: 178_000, costUsd: thread.costUsd, text: thread.reply } }, workspaceId),
  event(thread, { type: "session.end", at: ago(minutes - 3), exitCode: 0, sawResult: true }, workspaceId),
];

const REDIRECT = {
  id: "redirect",
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
 * machine's home, and a size, so nothing asks the provider what shape it is. */
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

/** A computer that redeemed a pairing code. Only the digest of a token is ever kept, so a fixture carries a digest
 * of nothing: no token exists that hashes to it. */
const device = (id, name, minutes) => ({
  id,
  name,
  tokenHash: `no-token-hashes-to-this-${id}`,
  createdAt: new Date(ago(60 * 30)).toISOString(),
  lastSeenAt: new Date(ago(minutes)).toISOString(),
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
const store = ({ workspaces, sessions = {}, transcripts = {}, goldens, devices, places }) => ({
  workspaces: Object.fromEntries(workspaces.map(w => [w.id, w])),
  sessions,
  transcripts,
  ...(goldens !== undefined ? { goldens } : {}),
  ...(devices !== undefined ? { devices } : {}),
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
const onPlace = (id, name, placeId, size) => ({
  id,
  name,
  machineId: `place:${placeId}`,
  phase: "running",
  kind: "place",
  golden: "",
  createdAt: new Date(ago(60 * 20)).toISOString(),
  home: "/root",
  folder: "/root",
  login: { HOME: "/root", USER: "root", PATH: "/usr/local/bin:/usr/bin:/bin" },
  size,
  shape: size,
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

const API_THREADS = () => threadsOn("ws_api", [[CHART, 300], [REDIRECT, 45]]);

/** This computer after a while of use: three workspaces of the local kind, folders imported into two of them,
 * threads on one, and no image sealed, so the cloud setup button stands in the sidebar's foot. What the screenshot
 * run photographs, since a surface with nothing on it shows a reviewer nothing. */
const macInUse = () =>
  store({
    workspaces: [
      workspace("ws_api", "api", { projects: [project("spoo", 48_200_000, 60 * 20), project("wsp", 133_000_000, 60 * 5)] }),
      workspace("ws_web", "web", { projects: [project("landing", 9_400_000, 60 * 9)] }),
      workspace("ws_notes", "notes"),
      workspace("ws_fix", "spoo-fix", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      onPlace("ws_hetzner", "box-build", "p_hetzner", { cpu: 2, memMb: 4096 }),
    ],
    ...merge(API_THREADS(), threadsOn("ws_fix", [[SEARCH, 12], [spawned("migration", MIGRATION, "search", "search"), 9]]), threadsOn("ws_hetzner", [[CHART, 200], [REDIRECT, 30]])),
    places: {
      p_hetzner: place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, docker: true, login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } }, "ws_hetzner"),
      p_oldmacbook: place("p_oldmacbook", "old-macbook", 120),
    },
  });

/** This computer and nothing else, as the person sitting at it first meets it: one workspace, named after this
 * computer, with no folder imported and no thread on it. Two personas are given this one, the person with a Mac
 * and nothing else and the person who will sign in to nothing, because what those two meet is the same window;
 * what differs is what they try to do in it. */
const thisComputer = () => store({ workspaces: [workspace("ws_here", THIS_COMPUTER)] });

/** This computer and an old laptop that redeemed a pairing code: a second workspace of the local kind, its own
 * home, and the paired computer in the devices collection. */
const macAndLaptop = () =>
  store({
    workspaces: [
      workspace("ws_api", "api", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      workspace("ws_web", "web", { projects: [project("landing", 9_400_000, 60 * 9)] }),
      workspace("ws_laptop", "old-laptop", { home: "/home/dev", folder: "/home/dev", createdAt: new Date(ago(60 * 30)).toISOString() }),
    ],
    ...API_THREADS(),
    devices: { dev_laptop: device("dev_laptop", "old-laptop", 12) },
  });

/** This computer and a server of the person's own running Docker, with one fork made there. */
const macAndVps = () =>
  store({
    workspaces: [
      workspace("ws_api", "api", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      fork("ws_build", "vps-build", "fk_vps_1", { projects: [project("wsp", 133_000_000, 60 * 3)] }),
    ],
    ...API_THREADS(),
    goldens: sealed(),
  });

/** Forks on Box by ASCII and nothing else: no workspace on this computer at all. */
const asciiOnly = () =>
  store({
    workspaces: [
      fork("ws_api", "api", "fk_ascii_1", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      fork("ws_web", "web", "fk_ascii_2", { projects: [project("landing", 9_400_000, 60 * 9)] }),
    ],
    ...API_THREADS(),
    goldens: sealed(),
  });

/** Forks on Solari and nothing else, one of them napping, which is where most of a fleet sits. */
const solariOnly = () =>
  store({
    workspaces: [
      fork("ws_api", "api", "fk_slr_1", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      fork("ws_web", "web", "fk_slr_2.paused", { phase: "napping", vaultedAt: new Date(ago(90)).toISOString() }),
    ],
    ...API_THREADS(),
    goldens: sealed(),
  });

/** Machines in both clouds and one on this computer: the sidebar a person who moved between providers has. */
const bothProviders = () =>
  store({
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { projects: [project("wsp", 133_000_000, 60 * 5)] }),
      fork("ws_api", "api", "fk_ascii_1", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      fork("ws_web", "web", "fk_slr_2.paused", { phase: "napping" }),
    ],
    ...API_THREADS(),
    goldens: sealed(),
  });

/** A person who drives agents with agents: this computer with spawning on, three forks a root thread made, and a
 * thread on each hanging under that root. */
const orchestrator = () => {
  const root = { ...MIGRATE };
  const tree = { parentThreadId: "th_migrate", rootThreadId: "th_migrate" };
  return store({
    workspaces: [
      workspace("ws_here", THIS_COMPUTER, { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, projects: [project("wsp", 133_000_000, 60 * 5)] }),
      fork("ws_api", "api", "fk_run_1", tree),
      fork("ws_web", "web", "fk_run_2", tree),
      fork("ws_docs", "docs", "fk_run_3.paused", { ...tree, phase: "napping" }),
    ],
    ...merge(
      threadsOn("ws_here", [[root, 120]]),
      threadsOn("ws_api", [[spawned("api-move", REDIRECT, "migrate", "migrate"), 100]]),
      threadsOn("ws_web", [[spawned("web-move", CHART, "migrate", "migrate"), 90]]),
    ),
    goldens: sealed(),
  });
};

/** Every setup a lab can serve, by the word `--fixture` takes. One row per kind of person: adding one is a row
 * here and its builder above. */
const FIXTURES = {
  "mac-in-use": macInUse,
  "mac-only": thisComputer,
  "mac-and-laptop": macAndLaptop,
  "mac-and-vps": macAndVps,
  "ascii-only": asciiOnly,
  "solari-only": solariOnly,
  "both-providers": bothProviders,
  "no-sign-in": thisComputer,
  orchestrator,
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** The whole store one fixture serves. The default is this computer with work on it, which is what the screenshot
 * run photographs. */
export function fixtureState(name = "mac-in-use") {
  const build = FIXTURES[name];
  if (build === undefined) throw new Error(`no fixture is called ${name}; there is ${FIXTURE_NAMES.join(", ")}`);
  return build();
}
