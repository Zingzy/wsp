// SPDX-License-Identifier: AGPL-3.0-only
// The workspace and image tools' part of the record the daemon binary's tool
// server serves from: every sentence those tools say, in the shape the Rust
// side fills, and the calls recorded per tool. A sentence is taken off the
// function or the tool that says it here, with each value it names standing
// in as {name}, so its words keep one home in this package.
import { CATALOG, ROAD_MODULES } from "@wsp/catalog";
import {
  START_WORDS,
  COPY_CURRENT,
  COPY_STALE,
  HERE_PLACE_ID,
  IMAGE_ALREADY_NEWEST,
  IMAGE_NO_VAULT,
  INSTALLS_LATEST,
  LoginState,
  NOTIFY_ME,
  NO_SEALED_IMAGE,
  SUM_SHOWN,
  WORKSPACE_KIND_WORDS,
  addedProjectOn,
  agentsLine,
  committedLine,
  deleteNotice,
  fixAskedLine,
  fixConflictsLine,
  fixNothingLine,
  fixMergeChildLine,
  FIX_CHECK_OR_CHILD,
  mergedLine,
  updateConflictsLine,
  updatedLine,
  discardedLine,
  goneRefusal,
  goneRoadRefusal,
  imageKeptLine,
  noProjectImageLine,
  onDeleteOf,
  UNNAMED_COMPUTER,
  projectImageRemoveNotice,
  projectImageRemovedLine,
  sealedLoginsHeld,
  shellQuote,
  thisComputer,
  threadDeletedLine,
  workspaceStateLine,
  worktreeRemovedLine,
  type WorkspaceState,
  mergeConflictsLine,
  mergedInLine,
  nothingToMergeLine,
} from "@wsp/protocol";
import { absoluteFolder, agentsToolAskedNothing, deletedLine, forgotLine, imageMovedLine, otherVersion, NO_DRAFT_FIX, noDraftLine, rebuiltLine, renamedWorkspaceLine, type HostClient } from "../src/verbs.js";
import type { TurnCase } from "./mcp-record-turns.js";

type Replies = Record<string, string>;
/** The line the TypeScript server writes for one call against a host answering each op with its frame, with the
 * cloud on where `cloud` says so. */
export type LineOf = (tool: string, args: Record<string, unknown>, replies: Replies, extra?: Pick<TurnCase, "cloud">) => Promise<{ line: string }>;

/** The cases of a tool the TypeScript server serves with the cloud on alone. */
const onCloud = (cases: TurnCase[]): TurnCase[] => cases.map(c => ({ ...c, cloud: true }));
export type HostOf = (replies: Replies) => HostClient;

const reply = (body: Record<string, unknown>): string => JSON.stringify({ id: 1, ok: true, ...body });
const refused = (error: string, kind?: string): string => JSON.stringify({ id: 1, ok: false, error, ...(kind !== undefined ? { kind } : {}) });

/** The text a sentence is said in with one of its parts standing in as {name}; a part the text no longer holds is a
 * sentence that changed shape, which has to fail here rather than record a template nothing fills. */
function slot(text: string, part: string, name: string): string {
  if (!text.includes(part)) throw new Error(`${JSON.stringify(text)} holds no ${JSON.stringify(part)} to stand in as {${name}}`);
  return text.replace(part, `{${name}}`);
}

async function thrown(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected a refusal");
}

const textOf = ({ line }: { line: string }): string => (JSON.parse(line) as { result: { content: { text: string }[] } }).result.content[0]!.text;

const STATES: readonly WorkspaceState[] = ["running", "pausing", "paused", "waking", "unreachable", "gone"];

/** Every sentence the workspace and image tools say, recorded under `workspaces` in record/words.json. */
export async function workspaceWords(line: LineOf, host: HostOf): Promise<Record<string, unknown>> {
  const running = { name: "{name}", phase: "running", machineId: "{machine}" } as never;
  const ws = (over: Record<string, unknown>) => ({ id: "{id}", name: "{name}", machineId: "{machine}", phase: "running", golden: "g", createdAt: "c", project: { id: "p", name: "n", path: "/p", computer: "c" }, ...over });
  const deleteText = textOf(await line("delete", { workspace: "w" }, { "workspaces.resolve": reply({ workspace: ws({ machineId: "m", kind: "cloud" }) }), "sessions.list": reply({ sessions: [] }) }));
  const golden = { snapshotId: "{id}", projects: [], golden: "g", workspaceId: "w", workspaceName: "W", createdAt: "2026-01-01T00:00:00.000Z" };
  const removeText = textOf(await line("image_remove", { image: "{id}" }, { "projectGoldens.list": reply({ projectGoldens: [golden] }) }, { cloud: true }));
  const project = { id: "p", name: "{project}", path: "/p", computer: HERE_PLACE_ID, source: { kind: "folder", path: "/p" } };
  const forkOf = (asked: Record<string, unknown>) => ({ "workspaces.resolve": reply({ workspace: ws({}) }), "projects.resolve": reply({ project: asked }) });
  const copyText = textOf(await line("fork", { workspace: "w", size: "2x4" }, forkOf(project), { cloud: true }));
  const offered = [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0.09 }];
  const sizeText = textOf(await line("fork", { workspace: "w", size: "{word}" }, { ...forkOf({ ...project, computer: "solari" }), "workspaces.landing": reply({ capabilities: { sizes: offered } }) }, { cloud: true }));
  const here = (worktree?: Record<string, unknown>) => ({ "sessions.list": reply({ sessions: [{ id: "s", workspaceId: "w", harness: "claude", status: "completed", threadId: "{thread}" }] }), "workspaces.list": reply({ workspaces: [ws({ id: "w", kind: "local", machineId: "here", ...(worktree !== undefined ? { worktree } : {}) })] }) });
  const threadKeptFolder = textOf(await line("delete", { thread: "{thread}" }, here()));
  const threadKeptWorktree = textOf(await line("delete", { thread: "{thread}" }, here({ path: "{path}", branch: "b", made: true })));
  const noThreadHere = textOf(await line("delete", { thread: "{ref}" }, { "sessions.list": reply({ sessions: [] }) }));
  const deleteNamesNothing = textOf(await line("delete", {}, {}));
  const localFolder = textOf(await line("forget", { workspace: "w" }, { "workspaces.resolve": reply({ workspace: ws({ kind: "local", machineId: "here" }) }) }));
  const agentsText = textOf(await line("workspaces_agents", { workspace: "w", spawn: "off" }, { "workspaces.resolve": reply({ workspace: ws({}) }), "workspaces.agents": reply({ workspace: ws({}) }) }));
  const cloud = onDeleteOf("cloud", undefined, "{machine}");
  const forked = { ...WORKSPACE, id: "{id}", name: "{name}" };
  const forkReplies = { "workspaces.resolve": reply({ workspace: WORKSPACE }), "harnesses.list": reply({ harnesses: [] }), "projects.resolve": reply({ project: PROJECT }), "workspaces.landing": reply({ capabilities: { sizes: [] } }), "workspaces.create": reply({ workspace: forked }) };
  const firstTurnFailed = textOf(await line("fork", { workspace: "w", task: "t" }, { ...forkReplies, "sessions.start": refused("{failure}") }, { cloud: true }));
  if (!firstTurnFailed.endsWith("{failure}")) throw new Error(`${JSON.stringify(firstTurnFailed)} does not end on the failure`);
  return {
    otherVersionResolve: otherVersion("workspaces.resolve"),
    goneBare: goneRefusal("{name}", "{action}"),
    goneSaid: goneRefusal("{name}", "{action}", "{words}"),
    stateLines: Object.fromEntries(STATES.map(s => [s, workspaceStateLine("{name}", s)])),
    rebuildRefused: Object.fromEntries(STATES.map(s => [s, goneRoadRefusal(s, "rebuild")])),
    onMachine: slot(rebuiltLine(running), workspaceStateLine("{name}", "running"), "state"),
    renamed: renamedWorkspaceLine({ was: "{was}", workspace: { name: "{name}", id: "{id}" } as never }),
    agentsSet: slot(agentsText, agentsLine(undefined), "agents"),
    agentsOff: agentsLine(undefined),
    agentsOne: agentsLine({ spawn: true, maxMachines: 1, maxDepth: 1 }),
    agentsMany: agentsLine({ spawn: true, maxMachines: "{count}" as never, maxDepth: 1 }),
    agentsNothing: await thrown(() => {
      throw agentsToolAskedNothing();
    }),
    forgotOne: forgotLine({ workspace: { name: "{name}", id: "{id}" } as never, threads: 1 }),
    forgotMany: forgotLine({ workspace: { name: "{name}", id: "{id}" } as never, threads: "{count}" as never }),
    unnamedComputer: UNNAMED_COMPUTER,
    onDelete: {
      ...Object.fromEntries(Object.keys(WORKSPACE_KIND_WORDS).map(kind => [kind, { asked: onDeleteOf(kind as never, undefined, "{machine}").asked, done: onDeleteOf(kind as never, undefined, "{machine}").done("{machine}") }])),
      worktree: { asked: onDeleteOf("local", { path: "{path}" }, "{machine}").asked, done: onDeleteOf("local", { path: "{path}" }, "{machine}").done("{machine}") },
      place: { asked: onDeleteOf("cloud", undefined, "{machine}", { name: "{name}", computer: "{computer}" }).asked, done: onDeleteOf("cloud", undefined, "{machine}", { name: "{name}", computer: "{computer}" }).done("{machine}") },
      none: { asked: onDeleteOf("cloud", undefined, "").asked, done: onDeleteOf("cloud", undefined, "").done("") },
    },
    deleteNoticeOne: slot(deleteNotice(1, "cloud", undefined, "{machine}"), cloud.asked, "asked"),
    deleteNoticeMany: slot(deleteNotice("{count}" as never, "cloud", undefined, "{machine}"), cloud.asked, "asked"),
    deletedOne: slot(deletedLine({ workspace: { name: "{name}", id: "{id}", machineId: "{machine}", kind: "cloud" } as never, threads: 1 }), cloud.done("{machine}"), "done"),
    deletedMany: slot(deletedLine({ workspace: { name: "{name}", id: "{id}", machineId: "{machine}", kind: "cloud" } as never, threads: "{count}" as never }), cloud.done("{machine}"), "done"),
    deleteKept: slot(deleteText, deleteNotice(0, "cloud", undefined, "m"), "notice"),
    keptFallback: imageKeptLine([], true),
    keptNone: imageKeptLine([]),
    keptOne: imageKeptLine(["{names}"]),
    keptMany: slot(slot(imageKeptLine(["{names}", "{names}"]), "{names}, {names}", "names"), "2", "count"),
    alreadyNewest: IMAGE_ALREADY_NEWEST,
    moved: slot(slot(imageMovedLine({ workspace: running, moved: false, kept: [] }), rebuiltLine(running), "rebuilt"), IMAGE_ALREADY_NEWEST, "kept"),
    noProjectImage: noProjectImageLine("{id}"),
    removeKept: slot(removeText, projectImageRemoveNotice(golden), "notice"),
    removeNotice: projectImageRemoveNotice({ workspaceName: "{workspace}", createdAt: "{date}" }),
    removedGone: projectImageRemovedLine("{id}", true),
    removedNow: projectImageRemovedLine("{id}", false),
    noSealedImage: NO_SEALED_IMAGE,
    imageNoVault: IMAGE_NO_VAULT,
    copyCurrent: COPY_CURRENT,
    copyStale: COPY_STALE,
    installsLatest: INSTALLS_LATEST,
    loginsHeld: LoginState.options.filter(state => sealedLoginsHeld({ logins: [{ name: "n", state }] }) === 1),
    sumShown: SUM_SHOWN,
    catalogNames: Object.fromEntries(CATALOG.map(e => [e.id, e.name])),
    roadWords: Object.fromEntries(Object.entries(ROAD_MODULES).map(([road, module]) => [road, module.words])),
    addedProject: addedProjectOn({ name: "{name}", id: "{id}", computer: "pl_x", source: { kind: "folder", path: "{source}" }, path: "{path}" } as never, "{computer}"),
    addedProjectHere: slot(addedProjectOn({ name: "{name}", id: "{id}", computer: HERE_PLACE_ID, source: { kind: "folder", path: "{source}" }, path: "{path}" } as never, "{computer}"), shellQuote("{name}"), "quoted"),
    thisMac: thisComputer("darwin"),
    thisComputer: thisComputer("linux"),
    herePlaceId: HERE_PLACE_ID,
    copyTakesNone: slot(copyText, "--size", "words"),
    sizeRefused: slot(sizeText, "2x4 ($0.09/hr)", "sizes"),
    cwdNotAbsolute: await thrown(() => absoluteFolder("{path}")),
    committedOne: slot(committedLine("{name}", { oid: "abcdefghij", subject: "{subject}", filesChanged: 1 }), "abcdefg", "oid"),
    committedMany: slot(slot(committedLine("{name}", { oid: "abcdefghij", subject: "{subject}", filesChanged: 2 }), "abcdefg", "oid"), "2", "count"),
    noDraft: noDraftLine("{note}"),
    noDraftBare: noDraftLine(undefined),
    noDraftFix: NO_DRAFT_FIX,
    discarded: discardedLine("{name}", "{path}"),
    fixAsked: fixAskedLine("{name}", "{agent}", "{check}"),
    fixConflicts: fixConflictsLine("{name}", "{agent}", "{base}"),
    fixNothing: fixNothingLine("{name}", "{base}"),
    fixMergeChild: fixMergeChildLine("{name}", "{agent}", "{child}"),
    fixCheckOrChild: FIX_CHECK_OR_CHILD,
    merged: slot(mergedLine("{name}", { number: 7, method: "{method}" as never, merged: true }), "7", "number"),
    mergeArmed: slot(mergedLine("{name}", { number: 7, method: "merge", merged: false }), "7", "number"),
    updatedNone: updatedLine("{name}", "{base}", 0),
    updatedOne: updatedLine("{name}", "{base}", 1),
    updatedMany: slot(updatedLine("{name}", "{base}", 2), "2", "count"),
    updateConflicts: updateConflictsLine("{name}", "{base}", ["{files}"]),
    madeBare: START_WORDS.made("{name}", undefined),
    madeIssue: slot(START_WORDS.made("{name}", { kind: "issue", number: 7 } as never), "7", "number"),
    madePullRequest: slot(START_WORDS.made("{name}", { kind: "pull_request", number: 7 } as never), "7", "number"),
    postedOne: slot(slot(START_WORDS.posted("{name}", 7, 1, 3), "7", "number"), "3", "folded"),
    postedMany: slot(slot(slot(START_WORDS.posted("{name}", 7, 2, 3), "7", "number"), "2", "count"), "3", "folded"),
    updateConflictsJoin: after(updateConflictsLine("{name}", "{base}", ["{a}", "{b}"]), updateConflictsLine("{name}", "{base}", ["{a}"])).replace("{b}", ""),
    mergedInOne: mergedInLine("{lead}", "{branch}", "{child}", 1),
    mergedInMany: slot(mergedInLine("{lead}", "{branch}", "{child}", 2), "2", "count"),
    mergeConflicts: mergeConflictsLine("{lead}", "{branch}", ["{paths}"]),
    nothingToMerge: nothingToMergeLine("{lead}", "{child}"),
    firstTurnFailed,
    threadKeptFolder,
    threadKeptWorktree,
    noThreadHere,
    deleteNamesNothing,
    localFolder,
    threadDeleted: threadDeletedLine("{thread}", { threads: 1 }),
    threadDeletedOne: threadDeletedLine("{thread}", { worktree: "{path}", threads: 1 }),
    threadDeletedMany: slot(threadDeletedLine("{thread}", { worktree: "{path}", threads: 2 }), "2", "count"),
    worktreeRemoved: worktreeRemovedLine("{branch}"),
  };
}

/** The text after a prefix it must open with. */
function after(text: string, prefix: string): string {
  if (!text.startsWith(prefix)) throw new Error(`${JSON.stringify(text)} does not open with ${JSON.stringify(prefix)}`);
  return text.slice(prefix.length);
}

/** A workspace as a verb answers with it, carrying what a byte compare has to survive: a C1 control, a quote, text
 * past ASCII, a fraction that prints long, and the host's own key order, which is not the schema's. */
const WORKSPACE = {
  name: "alpha \"one\" \u0085 🧪",
  id: "ws-1",
  machineId: "m-1",
  phase: "running",
  kind: "cloud",
  golden: "snap-g1",
  createdAt: "2026-09-27T01:02:03.004Z",
  project: { id: "proj-1", name: "alpha", path: "/root/alpha", computer: "place-9" },
  home: "/root",
  theme: { dots: [{ angle: 12.5, radius: 0.1 + 0.2 }], harmony: "single", grain: 0.5, opacity: 1, mode: "auto" },
  agents: { spawn: true, maxMachines: 2, maxDepth: 1 },
  place: "place-9",
  provider: "solari",
};
const NAPPING = { ...WORKSPACE, phase: "napping" };
const FORKED = { ...WORKSPACE, id: "ws-3", name: "alpha-fork", parentWorkspaceId: "ws-1" };
const SESSION = { id: "s-9", workspaceId: "ws-3", harness: "claude", status: "running", startedBy: "agent", threadId: "t-9" };
/** An agent as a machine describes itself: its models with a legacy one, the efforts, the access modes. */
const CLAUDE = {
  harness: "claude",
  label: "Claude Code",
  isDefault: true,
  source: "machine",
  models: [
    { value: "sonnet", label: "Sonnet", isDefault: true },
    { value: "haiku", label: "Haiku, small", efforts: [] },
  ],
  legacyModels: [{ value: "old", label: "Old" }],
  efforts: [
    { value: "low", label: "Low" },
    { value: "high", label: "High", isDefault: true },
  ],
  permissionModes: [
    { value: "default", label: "Default", isDefault: true },
    { value: "bypass", label: "Bypass" },
  ],
  access: { ask: "default", full: "bypass" },
  contextWindows: [],
};
const CODEX = { ...CLAUDE, harness: "codex", label: "Codex \u0085", isDefault: false, source: "table" };
const event = (over: Record<string, unknown>): string => JSON.stringify({ workspaceId: "ws-3", sessionId: "s-9", threadId: "t-9", turnId: "turn-1", ...over });
/** A fork's replies through its create, and the start of its first thread. */
const forkedWith = (over: Replies): Replies => ({
  "workspaces.resolve": reply({ workspace: WORKSPACE }),
  "harnesses.list": reply({ harnesses: [CODEX, CLAUDE] }),
  "projects.resolve": reply({ project: PROJECT }),
  "workspaces.landing": reply({ capabilities: { sizes: [] } }),
  "workspaces.create": reply({ workspace: FORKED }),
  "sessions.start": reply({ session: SESSION, outcome: "started", turnId: "turn-1" }),
  ...over,
});
const GONE = { ...WORKSPACE, phase: "gone", gone: "the provider has no machine m-1 \u009b" };
const LOCAL = { ...WORKSPACE, id: "ws-2", name: "here", kind: "local", machineId: "here", worktree: { path: "/Users/me/.wsp/worktrees/proj-1/work \u0085", branch: "work", made: true } };
/** Threads on this computer and one on a box: t-2 in a worktree wsp made, t-3 in the project folder. */
const HERE_SESSIONS = [
  { id: "s-1", workspaceId: "ws-1", harness: "claude", status: "completed", threadId: "t-1" },
  { id: "s-2", workspaceId: "ws-2", harness: "codex", status: "completed", threadId: "t-2 \u0085" },
  { id: "s-3", workspaceId: "ws-2", harness: "claude", status: "completed", threadId: "t-3" },
];
const SESSIONS = [
  { id: "s-1", workspaceId: "ws-1", harness: "claude", status: "completed", threadId: "t-1" },
  { id: "s-2", workspaceId: "ws-1", harness: "claude", status: "completed", threadId: "t-1" },
  { id: "s-3", workspaceId: "ws-1", harness: "codex", status: "running" },
];
const GOLDEN = { snapshotId: "snap-p1", projects: [{ name: "alpha", dest: "/root/alpha", importedAt: "2026-09-20T00:00:00.000Z", size: 1234 }], golden: "snap-g1", version: 3, workspaceId: "ws-1", workspaceName: "alpha \u0085", createdAt: "2026-09-21T10:00:00.000Z" };
/** The same record in an order the schema does not hold and with a field it does not know, which a parse drops. */
const GOLDEN_SHUFFLED = { createdAt: GOLDEN.createdAt, workspaceName: GOLDEN.workspaceName, extra: true, workspaceId: GOLDEN.workspaceId, version: 3, golden: GOLDEN.golden, projects: [{ importedAt: "2026-09-20T00:00:00.000Z", dest: "/root/alpha", name: "alpha" }], snapshotId: GOLDEN.snapshotId };
const HASH = "a".repeat(64);
const IMAGE = {
  name: "default",
  version: 2,
  hash: HASH,
  recipeHash: "r-1",
  pins: [
    { id: "node", tag: "22.9.0", sha256: "b".repeat(64) },
    { id: "brew/core/some/formula", tag: "1.0", latest: true, road: "brew" },
    { id: "unknown-road-row", tag: "2", latest: true, road: "nowhere" },
  ],
  logins: [
    { name: "claude", state: "signed-in" },
    { name: "gh", state: "copied" },
    { name: "codex", state: "skipped" },
  ],
  sealedAt: "2026-09-20T00:00:00.000Z",
  sealedFrom: "zingzy's Mac \u0085",
  vault: { sha256: "c".repeat(64), bytes: 4096, paths: 1, takenAt: "2026-09-20T00:00:00.000Z" },
  usedBytes: 5_368_709_120 + 268_435_456,
};
const COPIES = [
  { place: "solari", version: 2, hash: HASH, snapshotId: "snap-c1", builtAt: "2026-09-20T00:00:00.000Z", sizeBytes: 1_288_490_188 },
  { snapshotId: "snap-c2", place: "attic", version: 1, builtAt: "2026-09-19T00:00:00.000Z", unknown: 1 },
];
const PROJECT = {
  id: "proj-1",
  name: "alpha 'quoted'",
  computer: "place-9",
  source: { kind: "github", repo: "dev/alpha" },
  path: "/root/alpha",
  remote: "https://github.com/dev/alpha.git",
  defaultBranch: "main",
  memoryKey: "-root-alpha",
  memoryDir: "/root/.claude/projects/-root-alpha \u0085",
  createdAt: "2026-09-01T00:00:00.000Z",
  base: "main",
};
const PLACES = [{ id: "place-9", kind: "computer", name: "attic \u0085", default: false }];

export const WORKSPACE_ANSWERED: Record<string, TurnCase[]> = {
  pause: [
    { case: "napped", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.nap": reply({ workspace: NAPPING }) } },
    { case: "other version", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: { id: "ws-1" } }) } },
    { case: "not found", arguments: { workspace: "nope" }, replies: { "workspaces.resolve": refused("no workspace nope; wsp workspaces lists them", "not-found") } },
  ],
  wake: [
    { case: "woken", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.wake": reply({ workspace: WORKSPACE }) } },
    { case: "gone", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: GONE }) } },
    { case: "gone with no words", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: { ...GONE, gone: "" } }) } },
  ],
  snapshot: onCloud([
    { case: "taken", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.snapshot": reply({ projectGolden: GOLDEN_SHUFFLED }) } },
    { case: "refused", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.snapshot": refused("only a first-life machine can be snapshotted") } },
  ]),
  rename: [{ case: "renamed", arguments: { workspace: "alpha", name: "beta \u0085" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.rename": reply({ workspace: { ...WORKSPACE, name: "beta \u0085" } }) } }],
  workspaces_agents: [
    { case: "on", arguments: { workspace: "alpha", spawn: "on", max_machines: 2 }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.agents": reply({ workspace: WORKSPACE }) } },
    { case: "one", arguments: { workspace: "alpha", spawn: "on", max_machines: 1, max_depth: 3 }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.agents": reply({ workspace: { ...WORKSPACE, agents: { spawn: true, maxMachines: 1, maxDepth: 3 } } }) } },
    { case: "off", arguments: { workspace: "alpha", spawn: "off" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.agents": reply({ workspace: { ...WORKSPACE, agents: { spawn: false, maxMachines: 2, maxDepth: 1 } } }) } },
    { case: "caps alone", arguments: { workspace: "alpha", max_machines: 2, max_depth: 2 }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.agents": reply({ workspace: { ...WORKSPACE, agents: { spawn: true, maxMachines: 2, maxDepth: 2 } } }) } },
    { case: "nothing named", arguments: { workspace: "alpha" }, replies: {} },
  ],
  rebuild: onCloud([
    { case: "rebuilt", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: GONE }), "status.list": reply({ statuses: [] }), "workspaces.rebuild": reply({ workspace: { ...WORKSPACE, machineId: "m-2" } }) } },
    { case: "zombie", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "status.list": reply({ statuses: [{ id: "ws-1", machineState: "running", reach: { state: "zombie" } }] }), "workspaces.rebuild": reply({ workspace: { ...WORKSPACE, phase: "waking" } }) } },
    { case: "wake refused", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: { ...NAPPING, wakeRefused: "" } }), "status.list": reply({ statuses: [] }), "workspaces.rebuild": reply({ workspace: WORKSPACE }) } },
    { case: "running", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "status.list": reply({ statuses: [{ id: "ws-1", machineState: "running", reach: { state: "ok" } }] }) } },
    { case: "unreachable", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "status.list": reply({ statuses: [{ id: "ws-1", machineState: "running", reach: { state: "unreachable" } }] }) } },
    { case: "paused", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "status.list": reply({ statuses: [{ id: "ws-1", machineState: "paused", reach: { state: "ok" } }] }) } },
  ]),
  forget: [
    { case: "a folder here", arguments: { workspace: "here" }, replies: { "workspaces.resolve": reply({ workspace: LOCAL }), "sessions.list": reply({ sessions: SESSIONS }) } },
    { case: "forgot", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: GONE }), "sessions.list": reply({ sessions: SESSIONS }), "workspaces.forget": reply({}) } },
    { case: "one thread", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: GONE }), "sessions.list": reply({ sessions: SESSIONS.slice(0, 1) }), "workspaces.forget": reply({}) } },
    { case: "refused", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: [] }), "workspaces.forget": refused("Only a workspace whose computer is gone can be forgotten; this one is running", "usage") } },
  ],
  delete: [
    { case: "unconfirmed", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: SESSIONS }) } },
    { case: "thread unconfirmed", arguments: { thread: "t-2" }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [LOCAL, WORKSPACE] }) } },
    { case: "thread in the folder unconfirmed", arguments: { thread: "t-3", confirm: false }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [{ ...LOCAL, worktree: undefined }, WORKSPACE] }) } },
    { case: "thread deleted with its worktree", arguments: { thread: "t-2", confirm: true }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [LOCAL, WORKSPACE] }), "sessions.delete": reply({ workspaceId: "ws-2", worktree: LOCAL.worktree.path, threads: 2, extra: 1 }) } },
    { case: "thread deleted with one thread", arguments: { thread: "t-2", confirm: true }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [LOCAL, WORKSPACE] }), "sessions.delete": reply({ threads: 1, worktree: LOCAL.worktree.path, workspaceId: "ws-2" }) } },
    { case: "thread deleted in the folder", arguments: { thread: "t-3", confirm: true }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [{ ...LOCAL, worktree: undefined }, WORKSPACE] }), "sessions.delete": reply({ workspaceId: "ws-2", threads: 1 }) } },
    { case: "thread on a box", arguments: { thread: "t-1" }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [LOCAL, WORKSPACE] }) } },
    { case: "no such thread", arguments: { thread: "zz" }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }) } },
    { case: "thread refused", arguments: { thread: "t-2", confirm: true }, replies: { "sessions.list": reply({ sessions: HERE_SESSIONS }), "workspaces.list": reply({ workspaces: [LOCAL, WORKSPACE] }), "sessions.delete": refused("that worktree has 2 files not committed; commit them, or remove it with --force to lose them", "usage") } },
    { case: "nothing named", arguments: {}, replies: {} },
    { case: "a folder here", arguments: { workspace: "here" }, replies: { "workspaces.resolve": reply({ workspace: LOCAL }), "sessions.list": reply({ sessions: SESSIONS }) } },
    { case: "unconfirmed never made", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: { ...WORKSPACE, machineId: "" } }), "sessions.list": reply({ sessions: [] }) } },
    { case: "deleted", arguments: { workspace: "alpha", confirm: true }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: SESSIONS }), "workspaces.delete": reply({}) } },
    { case: "deleted never made", arguments: { workspace: "alpha", confirm: true }, replies: { "workspaces.resolve": reply({ workspace: { ...WORKSPACE, machineId: "" } }), "sessions.list": reply({ sessions: [] }), "workspaces.delete": reply({}) } },
    { case: "deleted on a joined computer", arguments: { workspace: "alpha", confirm: true }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: SESSIONS }), "places.list": reply({ places: PLACES }), "workspaces.delete": reply({}) } },
    { case: "unconfirmed, the names not read", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: [] }), "places.list": refused("not yours to read", "auth") } },
    { case: "unconfirmed at another provider", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "sessions.list": reply({ sessions: [] }), "places.list": reply({ places: [{ id: "place-9", kind: "provider", name: "ascii", default: false }] }) } },
  ],
  worktree: [
    { case: "made", arguments: { project: "alpha", branch: "feat/x \u0085" }, replies: { "worktree.make": reply({ made: true, path: "/Users/me/.wsp/worktrees/proj-1/feat-x-", extra: 1, branch: "feat/x \u0085" }) } },
    { case: "held elsewhere", arguments: { project: "alpha", branch: "main" }, replies: { "worktree.make": reply({ path: "/Users/me/alpha", branch: "main", made: false }) } },
    { case: "refused", arguments: { project: "alpha", branch: "-x" }, replies: { "worktree.make": refused("-x is not a name git takes for a branch", "usage") } },
  ],
  worktree_remove: [
    { case: "removed", arguments: { project: "alpha", branch: "feat/x \u0085", force: true }, replies: { "worktree.remove": reply({}) } },
    { case: "kept", arguments: { project: "alpha", branch: "feat/x", force: false }, replies: { "worktree.remove": reply({ removed: true }) } },
    { case: "refused", arguments: { project: "alpha", branch: "feat/x" }, replies: { "worktree.remove": refused("a thread is working in that worktree; let its turn end or stop it first", "usage") } },
  ],
  image_move: onCloud([
    { case: "kept", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.updateImage": reply({ workspace: { ...WORKSPACE, machineId: "m-3" }, moved: true, kept: ["zeta, one", ".bashrc", "Ärger", "~/b"], extra: 1 }) } },
    { case: "kept one", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.updateImage": reply({ workspace: WORKSPACE, moved: true, kept: [".zshrc"] }) } },
    { case: "kept none", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.updateImage": reply({ workspace: WORKSPACE, moved: true, kept: [] }) } },
    { case: "fallback", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.updateImage": reply({ workspace: WORKSPACE, moved: true, kept: [], fallback: true }) } },
    { case: "newest", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.updateImage": reply({ workspace: NAPPING, moved: false, kept: [], fallback: false }) } },
  ]),
  image_remove: onCloud([
    { case: "unconfirmed", arguments: { image: "snap-p1" }, replies: { "projectGoldens.list": reply({ projectGoldens: [GOLDEN_SHUFFLED] }) } },
    { case: "removed", arguments: { image: "snap-p1", confirm: true }, replies: { "projectGoldens.list": reply({ projectGoldens: [GOLDEN] }), "projectGoldens.remove": reply({ alreadyGone: false, projectGolden: GOLDEN_SHUFFLED }) } },
    { case: "already gone", arguments: { image: "snap-p1", confirm: true }, replies: { "projectGoldens.list": reply({ projectGoldens: [GOLDEN] }), "projectGoldens.remove": reply({ projectGolden: GOLDEN, alreadyGone: true }) } },
    { case: "no such", arguments: { image: "snap-x", confirm: true }, replies: { "projectGoldens.list": reply({ projectGoldens: [GOLDEN] }) } },
  ]),
  image: [
    { case: "record", arguments: {}, replies: { "image.get": reply({ view: { projects: [{ ...GOLDEN, sizeBytes: 900 }, GOLDEN_SHUFFLED], copies: COPIES, image: IMAGE } }) } },
    { case: "no vault", arguments: {}, replies: { "image.get": reply({ view: { image: { ...IMAGE, vault: undefined, usedBytes: undefined, pins: undefined, logins: [] }, copies: COPIES.slice(1), projects: [] } }) } },
    { case: "none", arguments: {}, replies: { "image.get": reply({ view: { image: null, copies: [], projects: [] } }) } },
  ],
  image_build: onCloud([
    {
      case: "built",
      arguments: { place: "attic \u0085" },
      replies: { "places.list": reply({ places: PLACES }), "image.build": reply({ build: { built: true, copy: { builtAt: "2026-09-27T00:00:00.000Z", snapshotId: "snap-c3", place: "place-9", version: 1, hash: HASH, sizeBytes: 2_147_483_648 } } }), "image.get": reply({ view: { image: IMAGE, copies: COPIES, projects: [] } }) },
    },
    { case: "already", arguments: { place: "solari", force: true }, replies: { "places.list": reply({ places: PLACES }), "image.build": reply({ build: { copy: COPIES[0], built: false } }), "image.get": reply({ view: { image: { ...IMAGE, vault: undefined }, copies: COPIES, projects: [] } }) } },
    { case: "no image", arguments: { place: "solari" }, replies: { "places.list": reply({ places: PLACES }), "image.build": reply({ build: { copy: COPIES[0], built: false } }), "image.get": reply({ view: { image: null, copies: [], projects: [] } }) } },
  ]),
  projects_add: [
    { case: "added", arguments: { source: "dev/alpha", on: "attic", base: "main" }, replies: { "projects.add": reply({ project: PROJECT }), "places.list": reply({ places: PLACES }) } },
    { case: "notice", arguments: { source: "https://example.com/dev/alpha.git", on: "attic", name: "alpha" }, replies: { "projects.add": reply({ project: { ...PROJECT, source: { kind: "git", url: "https://example.com/dev/alpha.git" } }, notice: "the seed left 2 commits behind \u0085" }), "places.list": refused("not yours to read", "auth") } },
    { case: "cloned into a folder", arguments: { source: "https://example.com/dev/alpha.git", into: "/Users/me/alpha", base: "main" }, replies: { "projects.add": reply({ project: { ...PROJECT, computer: "place-9", source: { kind: "folder", path: "/Users/me/alpha" } } }), "places.list": reply({ places: PLACES }) } },
    { case: "refused", arguments: { source: "/nowhere" }, replies: { "projects.add": refused("/nowhere is not a git repo", "usage") } },
  ],
  projects_remove: [{ case: "removed", arguments: { project: "alpha" }, replies: { "projects.resolve": reply({ project: PROJECT }), "projects.remove": reply({ said: "alpha 'quoted' is no longer a project here \u0085" }) } }],
  merge_in: [
    {
      case: "merged from a napping lead",
      arguments: { lead: "alpha", child: "beta \u0085" },
      replies: {
        "workspaces.resolve": reply({ workspace: NAPPING }),
        "workspaces.wake": reply({ workspace: WORKSPACE }),
        "workspaces.mergeIn": reply({ conflicts: [], child: "beta \u0085", lead: "alpha \"one\"", branch: "child/caf\u00e9", merged: true, commits: 3 }),
      },
    },
    { case: "one commit", arguments: { lead: "alpha", child: "beta" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.mergeIn": reply({ lead: "alpha", child: "beta", branch: "b", merged: true, commits: 1, conflicts: [] }) } },
    { case: "nothing to take", arguments: { lead: "alpha", child: "beta" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.mergeIn": reply({ lead: "alpha", child: "beta", branch: "child/one", merged: true, commits: 0, conflicts: [] }) } },
    {
      case: "conflicts",
      arguments: { lead: "alpha", child: "beta" },
      replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.mergeIn": reply({ lead: "alpha", child: "beta", branch: "child/two", merged: false, commits: 0, conflicts: ["lead.txt", "src/a b \u0085.ts"] }) },
    },
    { case: "refused", arguments: { lead: "alpha", child: "beta" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.mergeIn": refused("the lead is working") } },
    { case: "gone", arguments: { lead: "alpha", child: "beta" }, replies: { "workspaces.resolve": reply({ workspace: GONE }) } },
  ],
  commit: [
    {
      case: "every change, the message drafted",
      arguments: { workspace: "alpha" },
      replies: {
        "workspaces.resolve": reply({ workspace: NAPPING }),
        "workspaces.wake": reply({ workspace: WORKSPACE }),
        "workspaces.commitDraft": reply({ message: "Fix the \u0085 thing 🧪\n\nBecause it broke." }),
        "workspaces.commit": reply({ oid: "0123456789abcdef0123", subject: "Fix the \u0085 thing 🧪", filesChanged: 1, insertions: 3, deletions: 1 }),
      },
    },
    {
      case: "the files named, with a message",
      arguments: { workspace: "alpha", message: "Name the files", files: ["a.ts", "b \u0085.ts"] },
      replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.commit": reply({ oid: "fedcba9876543210", subject: "Name the files", filesChanged: 2, insertions: 10, deletions: 0 }) },
    },
    { case: "no draft, with the note", arguments: { workspace: "alpha", files: ["a.ts"] }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.commitDraft": reply({ message: null, note: "No agent here drafts commit messages; write it yourself." }) } },
    { case: "no draft, no note", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.commitDraft": reply({ message: null }) } },
    { case: "refused by a hook", arguments: { workspace: "alpha", message: "m" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.commit": refused("a hook said no: lint failed \u0085", "usage") } },
    { case: "gone", arguments: { workspace: "alpha", message: "m" }, replies: { "workspaces.resolve": reply({ workspace: GONE }) } },
  ],
  fix: [
    { case: "a failed check", arguments: { workspace: "alpha", check: "ci \u0085 / test 🧪" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.fix": reply({ outcome: "steered", threadId: "t-1", check: "ci \u0085 / test 🧪", base: "main", agent: "codex" }) } },
    { case: "the conflicts sent", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.fix": reply({ outcome: "started", threadId: "t-2", base: "main", agent: "claude" }) } },
    { case: "a sent fix naming no agent", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.fix": reply({ outcome: "started", threadId: "t-5", base: "main" }) } },
    { case: "an agent the catalog does not name", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.fix": reply({ outcome: "queued", threadId: "t-3", base: "develop", agent: "someone-else" }) } },
    { case: "updated clean, nothing sent", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.fix": reply({ outcome: "updated", base: "main \u0085 🧪" }) } },
    { case: "refused", arguments: { workspace: "alpha", check: "lint" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.fix": refused("lint has not failed on #4", "usage") } },
    { case: "a child to merge", arguments: { workspace: "alpha", child: "beta \u0085 🧪" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.fix": reply({ outcome: "started", threadId: "t-4", child: "beta \u0085 🧪", base: "tree/lead", agent: "claude" }) } },
    { case: "a check and a child", arguments: { workspace: "alpha", check: "lint", child: "beta" }, replies: {} },
    { case: "gone", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: GONE }) } },
  ],
  merge: [
    { case: "merged now", arguments: { workspace: "alpha", method: "squash" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.merge": reply({ number: 4, method: "squash", merged: true, autoArmed: false }) } },
    { case: "armed to merge on its checks", arguments: { workspace: "alpha", when_checks_pass: true }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.merge": reply({ number: 12, method: "merge", merged: false, autoArmed: true }) } },
    { case: "a method off the list", arguments: { workspace: "alpha", method: "fast-forward" }, replies: {} },
    { case: "refused by the repository", arguments: { workspace: "alpha", method: "rebase" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.merge": refused("the repository does not allow rebase merges \u0085", "usage") } },
  ],
  start: [
    { case: "an issue", arguments: { link: "https://github.com/o/r/issues/5" }, replies: { "workspaces.start": reply({ workspace: { ...WORKSPACE, from: { kind: "issue", repo: "o/r", number: 5, url: "https://github.com/o/r/issues/5", title: "Add a line \u0085 🧪" } }, threadId: "t-1", sessionId: "s-1" }) } },
    { case: "a pull request, at the picks named", arguments: { link: "https://github.com/o/r/pull/7", project: "alpha", agent: "claude", model: "opus", effort: "high", access: "auto-edit" }, replies: { "workspaces.start": reply({ workspace: { ...WORKSPACE, from: { kind: "pull_request", repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", title: "Rename", base: "main", head: { branch: "lab/review-me" } } }, threadId: "t-2", sessionId: "s-2" }) } },
    { case: "a workspace answered with no origin", arguments: { link: "https://github.com/o/r/issues/6" }, replies: { "workspaces.start": reply({ workspace: WORKSPACE, threadId: "t-3", sessionId: "s-3" }) } },
    { case: "no project for the repository", arguments: { link: "https://github.com/x/y/issues/1" }, replies: { "workspaces.start": refused("no project here is a checkout of x/y; add one with wsp add https://github.com/x/y", "usage") } },
  ],
  review: [
    { case: "a link", arguments: { target: "https://github.com/o/r/pull/7" }, replies: { "workspaces.review": reply({ workspace: { ...WORKSPACE, from: { kind: "review", repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7", title: "Rename \u0085" } }, threadId: "t-4", sessionId: "s-4" }) } },
    { case: "a workspace's own pull request", arguments: { target: "alpha", agent: "claude", effort: "high" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.review": reply({ workspace: { ...WORKSPACE, from: { kind: "review", repo: "o/r", number: 12, url: "https://github.com/o/r/pull/12", title: "Fix" } }, threadId: "t-5", sessionId: "s-5" }) } },
    { case: "an agent with no read-only access", arguments: { target: "https://github.com/o/r/pull/7", agent: "opencode" }, replies: { "workspaces.review": refused("opencode has no read-only access wsp can give a reviewer; review with codex or claude", "usage") } },
  ],
  review_post: [
    { case: "posted as drafted", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.reviewPost": reply({ url: "https://github.com/o/r/pull/7#pullrequestreview-9", number: 7, comments: 2, folded: 1 }) } },
    { case: "one comment, the verdict and summary edited first", arguments: { workspace: "alpha", verdict: "approve", summary: "Fine \u0085 🧪" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.reviewDraft": reply({ review: { note: "x", at: 1 } }), "workspaces.reviewPost": reply({ url: "https://github.com/o/r/pull/12#pullrequestreview-3", number: 12, comments: 1, folded: 0 }) } },
    { case: "no review yet", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.reviewPost": refused("alpha has no review to post yet", "usage") } },
    { case: "a verdict off the list", arguments: { workspace: "alpha", verdict: "lgtm" }, replies: {} },
  ],
  update: [
    { case: "merged, several commits", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.update": reply({ base: "main", merged: true, commits: 3, conflicts: [] }) } },
    { case: "merged, one commit", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.update": reply({ base: "main 🧪", merged: true, commits: 1, conflicts: [] }) } },
    { case: "already current", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.update": reply({ base: "main", merged: true, commits: 0, conflicts: [] }) } },
    { case: "conflicts", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.update": reply({ base: "main", merged: false, commits: 0, conflicts: ["a.ts", "b \u0085.ts"] }) } },
    { case: "a dirty copy refused", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.update": refused("a.ts has changes no commit holds; commit or discard them, then update again", "usage") } },
    { case: "gone", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: GONE }) } },
  ],
  discard: [
    { case: "discarded", arguments: { workspace: "alpha", path: "src/a \u0085.ts" }, replies: { "workspaces.resolve": reply({ workspace: NAPPING }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.discard": reply({ path: "src/a \u0085.ts" }) } },
    { case: "no change", arguments: { workspace: "alpha", path: "src/a.ts" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "workspaces.wake": reply({ workspace: WORKSPACE }), "workspaces.discard": refused("src/a.ts has no change to discard", "usage") } },
    { case: "gone", arguments: { workspace: "alpha", path: "src/a.ts" }, replies: { "workspaces.resolve": reply({ workspace: GONE }) } },
  ],
  export: [
    {
      case: "exported",
      arguments: { workspace: "alpha", folder: "/Users/me/alpha", agents: ["claude"], replace: true },
      replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "project.export": reply({ exported: { dest: "/Users/me/alpha", files: 12, bytes: 3.5, excluded: ["node_modules"], agents: [{ agent: "claude", files: 2, bytes: 10, outcome: "moved", sessions: 1 }] } }) },
      pushed: {
        "project.export": [
          JSON.stringify({ type: "project.export", workspaceId: "ws-1", dest: "/Users/me/alpha", stage: "copying", message: "copying" }),
          JSON.stringify({ type: "project.export", workspaceId: "ws-1", dest: "/elsewhere", stage: "done", message: "another export's end" }),
          JSON.stringify({ type: "project.export", workspaceId: "ws-1", dest: "/Users/me/alpha", stage: "done", message: "alpha is home at /Users/me/alpha \u0085" }),
        ],
      },
    },
    { case: "refused", arguments: { workspace: "alpha", folder: "/Users/me/alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "project.export": refused("/Users/me/alpha is already there", "exists") } },
  ],
  fork: onCloud([
    { case: "forked", arguments: { workspace: "alpha" }, replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "projects.resolve": reply({ project: PROJECT }), "workspaces.landing": reply({ capabilities: { sizes: [] } }), "workspaces.create": reply({ workspace: { ...WORKSPACE, id: "ws-3", name: "alpha-fork", parentWorkspaceId: "ws-1" } }) } },
    {
      case: "named and sized",
      arguments: { workspace: "alpha", name: "beta", size: "4x8", spawn: "off" },
      replies: { "workspaces.resolve": reply({ workspace: WORKSPACE }), "projects.resolve": reply({ project: PROJECT }), "workspaces.landing": reply({ capabilities: { sizes: [{ cpu: 4, memMb: 8192, rateUsdPerHour: 0.2 }] } }), "workspaces.create": reply({ workspace: { ...WORKSPACE, id: "ws-4", name: "beta" }, notice: "built a copy first" }) },
    },
    { case: "relative folder", arguments: { workspace: "alpha", cwd: "src \"x\"" }, replies: {} },
    {
      case: "first turn",
      arguments: { workspace: "alpha", task: "go \u0085", model: "old", effort: "low", access: "full", cwd: "/root/alpha", notify: [NOTIFY_ME, "t-1"] },
      replies: forkedWith({ "sessions.list": reply({ sessions: SESSIONS }) }),
      pushed: {
        "sessions.start": [
          event({ type: "session.start", afterCut: true }),
          event({ type: "session.done", turnId: "turn-0", result: { status: "failed", error: "another turn's" } }),
          event({ type: "session.delta", kind: "text", text: "re" }),
          event({ type: "session.done", result: { status: "completed", text: "re: go \u0085", costUsd: 0.1 } }),
        ],
      },
    },
    { case: "first turn with no text", arguments: { workspace: "alpha", task: "go", agent: "codex" }, replies: forkedWith({}), pushed: { "sessions.start": [event({ type: "session.done", result: { status: "completed" } })] } },
    { case: "first turn failed", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({}), pushed: { "sessions.start": [event({ type: "session.done", result: { status: "failed", error: "no sign-in for claude \u0085" } })] } },
    { case: "first turn interrupted", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({}), pushed: { "sessions.start": [event({ type: "session.done", result: { status: "interrupted" } })] } },
    { case: "ended by the runtime", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({}), pushed: { "sessions.start": [event({ type: "session.end", reason: "the machine stopped answering" })] } },
    { case: "ended with no reason", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({}), pushed: { "sessions.start": [event({ type: "session.end" })] } },
    { case: "start refused", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({ "sessions.start": refused("the machine refused the start", "auth") }) },
    { case: "start in another shape", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({ "sessions.start": reply({ session: SESSION, outcome: "sideways", turnId: "turn-1" }) }) },
    { case: "no thread stamped", arguments: { workspace: "alpha", task: "go" }, replies: forkedWith({ "sessions.start": reply({ session: { ...SESSION, threadId: undefined }, outcome: "queued", turnId: "turn-1" }) }) },
    { case: "notify names no thread", arguments: { workspace: "alpha", task: "go", notify: ["zz"] }, replies: forkedWith({ "sessions.list": reply({ sessions: SESSIONS }) }) },
    { case: "notify names two", arguments: { workspace: "alpha", task: "go", notify: ["s-"] }, replies: forkedWith({ "sessions.list": reply({ sessions: [{ ...SESSIONS[0], threadId: undefined }, SESSIONS[2]] }) }) },
    { case: "empty task", arguments: { workspace: "alpha", task: " \n " }, replies: forkedWith({}) },
    { case: "no such agent", arguments: { workspace: "alpha", task: "go", agent: "gemini" }, replies: forkedWith({}) },
    { case: "no agent at all", arguments: { workspace: "alpha", task: "go", agent: "gemini" }, replies: forkedWith({ "harnesses.list": reply({ harnesses: [] }) }) },
    { case: "model not offered", arguments: { workspace: "alpha", task: "go", model: "opus-9" }, replies: forkedWith({}) },
    { case: "effort not offered", arguments: { workspace: "alpha", task: "go", effort: "max" }, replies: forkedWith({}) },
    { case: "model takes no effort", arguments: { workspace: "alpha", task: "go", model: "haiku", effort: "low" }, replies: forkedWith({}) },
    { case: "an access that is no word of wsp's", arguments: { workspace: "alpha", task: "go", agent: "codex", access: "yolo" }, replies: forkedWith({}) },
    { case: "an access the agent maps to no mode", arguments: { workspace: "alpha", task: "go", agent: "codex", access: "plan" }, replies: forkedWith({}) },
    { case: "no effort off the built-in table", arguments: { workspace: "alpha", task: "go", agent: "codex", model: "haiku", effort: "low" }, replies: forkedWith({}) },
    { case: "no catalog for the agent", arguments: { workspace: "alpha", task: "go", model: "anything" }, replies: forkedWith({ "harnesses.list": reply({ harnesses: [{ ...CODEX, isDefault: false }] }) }), pushed: { "sessions.start": [event({ type: "session.done", result: { status: "completed", text: "ok" } })] } },
  ]),
};
