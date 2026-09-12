// SPDX-License-Identifier: AGPL-3.0-only
// The throwaway states a screenshot run and a persona lab serve, one per kind
// of person: what their sidebar holds, whether an image is sealed, and what
// their threads say. The default is a person with this computer alone, three
// workspaces of the local kind, folders imported into two of them and two
// threads with the transcript each replays, so no surface is photographed
// empty; the rest vary the setup a tester meets. Nothing here is a real
// machine, a real key or a real folder, and the forks are served by the
// provider that answers out of memory, so no fixture dials anything.

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
  home: "/Users/dev",
  folder: "/Users/dev",
  ...extra,
});

const project = (name, size, minutes) => ({ name, dest: `/Users/dev/${name}`, importedAt: new Date(ago(minutes)).toISOString(), size });

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
  cwd: thread.cwd ?? "/Users/dev/spoo",
  model: "opus",
  permissionMode: "default",
  ...(thread.parent === undefined ? {} : { parentThreadId: `th_${thread.parent}`, rootThreadId: `th_${thread.root}` }),
});

const event = (thread, rest, workspaceId = "ws_api") => ({ workspaceId, sessionId: `s_${thread.id}`, threadId: `th_${thread.id}`, turnId: `turn_${thread.id}`, ...rest });

/** A whole turn as the transcript holds it: the person's words, a thought, one tool call and its result,
 * the reply, and the two events that close it. */
const replay = (thread, minutes, workspaceId = "ws_api") => [
  event(thread, { type: "session.start", at: ago(minutes), prompt: thread.prompt, model: "opus", cwd: thread.cwd ?? "/Users/dev/spoo" }, workspaceId),
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

/** A computer somebody joined to this host, as the places collection keeps one: the key is the whole of its
 * identity, so a fixture carries a key of nothing, and the report is what it last said about itself. Nothing here
 * is linked: a link is a live socket, so every joined computer a fixture serves reads as not answering. */
const place = (id, name, minutes, report) => ({
  id,
  name,
  publicKey: `no-key-reads-as-this-${id}`,
  joinedAt: new Date(ago(60 * 30)).toISOString(),
  lastSeenAt: new Date(ago(minutes)).toISOString(),
  report: {
    name,
    arch: "arm64",
    daemonVersion: 1,
    login: { HOME: "/home/dev", USER: "dev", PATH: "/usr/local/bin:/usr/bin:/bin" },
    wsp: ["/usr/local/bin/wsp"],
    dialed: "http://192.168.1.20:7788",
    ...report,
  },
  workspaceId: `ws_${id}`,
});

/** A workspace standing on a joined computer: the machine id the engine gives one, so the settings table counts it
 * against that computer's row. */
const onPlace = (id, name, placeId, size, extra = {}) => ({
  id,
  name,
  machineId: `place:${placeId}`,
  phase: "running",
  kind: "place",
  golden: "",
  createdAt: new Date(ago(60 * 20)).toISOString(),
  home: "/home/dev",
  folder: "/home/dev",
  // Every path a turn on a joined computer runs under is built from the login it reported, so a record without
  // one is a record no join wrote and the runtime refuses it at startup.
  login: { HOME: "/home/dev", USER: "dev", PATH: "/usr/local/bin:/usr/bin:/bin" },
  size,
  shape: size,
  ...extra,
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
        places: Object.fromEntries(places.map(p => [p.id, p])),
        // The last computer added is the one a verb means when nobody says; the settings row wears the word.
        "place-default": { default: { placeId: places[0].id } },
      }),
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

/** The two computers the settings table's own rows are read off: a Linux box of the person's running Docker, and
 * an old Mac that runs their agents and nothing else. */
const JOINED = () => [
  place("p_hetzner", "hetzner", 1, { platform: "linux", os: "Ubuntu 24.04", shape: { cpu: 2, memMb: 4096 }, diskFreeBytes: 38 * 1024 ** 3, docker: true }),
  place("p_laptop", "old-macbook", 120, { platform: "darwin", os: "macOS 15.6", shape: { cpu: 4, memMb: 8192 }, diskFreeBytes: 91 * 1024 ** 3, docker: false }),
];

/** This computer alone: three workspaces of the local kind, no image sealed, so the cloud setup button stands in
 * the sidebar's foot. */
const macOnly = () =>
  store({
    workspaces: [
      workspace("ws_api", "api", { projects: [project("spoo", 48_200_000, 60 * 20), project("wsp", 133_000_000, 60 * 5)] }),
      workspace("ws_web", "web", { projects: [project("landing", 9_400_000, 60 * 9)] }),
      workspace("ws_notes", "notes"),
      onPlace("ws_p_hetzner", "spoo-fix", "p_hetzner", { cpu: 2, memMb: 4096 }),
    ],
    ...merge(API_THREADS(), threadsOn("ws_p_hetzner", [[CHART, 200], [REDIRECT, 30]])),
    places: JOINED(),
  });

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
      workspace("ws_here", "this-mac", { projects: [project("wsp", 133_000_000, 60 * 5)] }),
      fork("ws_api", "api", "fk_ascii_1", { projects: [project("spoo", 48_200_000, 60 * 20)] }),
      fork("ws_web", "web", "fk_slr_2.paused", { phase: "napping" }),
    ],
    ...API_THREADS(),
    goldens: sealed(),
  });

/** A person who signed in to nothing: one workspace of the local kind, no threads, no image. The emptiest the app
 * ever is with a host running. */
const noSignIn = () => store({ workspaces: [workspace("ws_here", "this-mac")] });

/** A person who drives agents with agents: this computer with spawning on, three forks a root thread made, and a
 * thread on each hanging under that root. */
const orchestrator = () => {
  const root = { ...MIGRATE };
  const tree = { parentThreadId: "th_migrate", rootThreadId: "th_migrate" };
  return store({
    workspaces: [
      workspace("ws_here", "this-mac", { agents: { spawn: true, maxMachines: 3, maxDepth: 1 }, projects: [project("wsp", 133_000_000, 60 * 5)] }),
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
  "mac-only": macOnly,
  "mac-and-laptop": macAndLaptop,
  "mac-and-vps": macAndVps,
  "ascii-only": asciiOnly,
  "solari-only": solariOnly,
  "both-providers": bothProviders,
  "no-sign-in": noSignIn,
  orchestrator,
};

export const FIXTURE_NAMES = Object.keys(FIXTURES);

/** The whole store one fixture serves. The default is the person with this computer alone, which is what the
 * screenshot run photographs. */
export function fixtureState(name = "mac-only") {
  const build = FIXTURES[name];
  if (build === undefined) throw new Error(`no fixture is called ${name}; there is ${FIXTURE_NAMES.join(", ")}`);
  return build();
}
