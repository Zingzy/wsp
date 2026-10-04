// SPDX-License-Identifier: AGPL-3.0-only
// The contract every daemon speaking this wire is held to, as one fixture set
// under daemon/fixtures/contract: frames the schemas here must take and refuse,
// one file pair per op and per event type, and the words and numbers the
// daemon emits that a client or a test matches on. This side is the source:
// the words and numbers are regenerated from this package's exports and must
// equal the committed files, and a daemon written in another language checks
// its own constants and types against the same files, never against a build
// of this package.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ZodLiteral, type ZodObject, type ZodRawShape, type ZodTypeAny } from "zod";
import {
  AUTH_DEADLINE_MS,
  CACHE_DIRS,
  REPO_CAP,
  REPO_DEPTH,
  DAEMON_AUTH_DEADLINE_PASSED,
  DAEMON_TOKEN_ROTATED,
  DAEMON_DEFAULT_HOST,
  DAEMON_DEFAULT_PORT,
  DAEMON_FIRST_FRAME_NOT_AUTH,
  DAEMON_INVALID_JSON,
  DAEMON_NICE,
  DAEMON_NO_TOKEN,
  DAEMON_OOM_SCORE_ADJ,
  DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  DAEMON_ROOTS_PATH,
  DAEMON_SAMPLER_INTERVAL_MS,
  DAEMON_TOKEN_PATH,
  GUEST_WSP_HOME,
  HOMEBREW_HOME,
  HOMEBREW_PREFIX,
  SHARED_TOOL_ROOTS,
  TOOLS_PATH,
  PLACE_WORKSPACE_PATH,
  WORKSPACE_OVERLAID,
  DAEMON_TOKEN_REFUSED,
  DAEMON_VERSION,
  CopyReport,
  DaemonAuthRequest,
  DaemonErrorResponse,
  DaemonEvent,
  DaemonRequest,
  EXEC_BODY_MAX,
  PR_REPLY_BODY_MAX,
  MachineLinkRequest,
  EXEC_DEADLINE_EXIT,
  EXEC_OUTPUT_MAX,
  EXEC_TIMEOUT_DEFAULT_MS,
  FS_LIST_CAP_ENTRIES,
  FS_FILES_CAP_ENTRIES,
  GIT_PR_LIST_CAP,
  GIT_PR_LIST_BODY_CAP,
  FS_READ_CAP_BYTES,
  FS_WRITE_CAP_BYTES,
  FS_SEARCH_CAP_FILES,
  FS_SEARCH_CAP_HITS,
  GIT_DIFF_CAP_BYTES,
  GUEST_ARGV_MAX,
  GUEST_CWD_MAX,
  GUEST_DAEMON_DIR,
  GUEST_DAEMON_SOCKET_PATH,
  GUEST_INBOX_DIR,
  GUEST_MANIFEST_PATH,
  GUEST_FRAME_CAP_BYTES,
  GUEST_IN_FLIGHT_CAP_BYTES,
  GUEST_IN_FLIGHT_FULL,
  GUEST_MESSAGE_CAP_BYTES,
  GUEST_NOT_WATCHER,
  GUEST_QUEUE_CAP_FRAMES,
  GUEST_QUEUE_FULL,
  GUEST_SESSIONS_PER_WORKSPACE_CAP,
  GUEST_WORKSPACE_FULL,
  GUEST_UNWATCHED,
  GUEST_UNWATCHED_MS,
  GUEST_TOKEN_MAX,
  GUEST_WSP_PATH,
  GitPrReply,
  GitPrReadReply,
  GitIssueReadReply,
  GitPrCheckoutReply,
  GitPrDiffReply,
  GitPrReviewReply,
  GitPrReplyReply,
  GitPrResolveReply,
  GitPrReactReply,
  REVIEW_DIFF_MAX_BYTES,
  GitPrViewReply,
  GitRunLogReply,
  GitPrMergeReply,
  GitRepoReadReply,
  GitStartOnReply,
  GitBranchCompareReply,
  GitMergeInReply,
  GitUpdateReply,
  CHECK_LOG_LINES,
  GitPrListReply,
  GitCommitReply,
  GitDiscardReply,
  GitCheckpointReply,
  GitRestoreReply,
  GitCheckpointDropReply,
  GitWorktreesReply,
  GitBranchesReply,
  WorktreeReport,
  WorktreeRemoval,
  FsFilesReply,
  GitSnapshotReply,
  SysHistoryReply,
  GitPushReply,
  GuestCliMessage,
  GuestOpenReply,
  SshStartReply,
  HostFolderListing,
  HTTP_URL_MAX,
  NOT_ON_A_BRANCH,
  NO_REMOTE,
  noGitCredentialLine,
  noHostCliLine,
  nothingAheadLine,
  onBaseRefusal,
  MachineAnswersReply,
  MachineBackendReply,
  MachineCapacityReply,
  MachineExecReply,
  MachineHandleReply,
  MachineListReply,
  MachineReachReply,
  MachineReadingReply,
  MachineShapeReply,
  MachineStateReply,
  NO_IMAGES_HERE,
  NO_PLACE_FILE_LINE,
  NOT_ON_THIS_KIND,
  NOT_ON_THIS_ROAD,
  OPEN_SHIM_PATH,
  OPEN_SOCKET_PATH,
  PID_MAX,
  SSH_IDLE_MS,
  SSH_KEY_MAX,
  PLACE_LINK_NONCE_BYTES,
  PORT_COMMAND_BYTES,
  PRE_AUTH_MAX_BYTES,
  PROC_CAP,
  PROC_CMDLINE_BYTES,
  PROC_SAMPLER_STARTED,
  PROC_SAMPLER_STOPPED,
  PTY_SCROLLBACK_CAP_BYTES,
  PlaceAuthRequest,
  PlaceProveRequest,
  SYS_SAMPLER_STARTED,
  SYS_SAMPLER_STOPPED,
  TUNNEL_CAP,
  WORK_OOM_SCORE_ADJ,
  XDG_OPEN_PATH,
  WSP_WORKSPACE_APPARMOR_PATH,
  TOOL_LINKS_DIR,
  TOOL_PREFIX,
  authUnreadableLine,
  daemonListeningLine,
  dialFailedLine,
  dialTimedOutLine,
  dialUnansweredLine,
  foldersOutsideLine,
  guestNoDaemonLine,
  HOST_CLOSED_LINE,
  placeKeptForLinkLine,
  placeOutsideLeftLine,
  guestWspShim,
  hostKeyRefusal,
  hostQuietLine,
  hostRefusedLine,
  linkHostUnsealedLine,
  linkOutOfOrderLine,
  linkedLine,
  notAFrameLine,
  placeDaemonPaths,
  placeOwnedPaths,
  portScopeRefusal,
  probePath,
  unknownOpLine,
  boxFullLine,
  workScoreLine,
} from "../src/index.js";

const CONTRACT = fileURLToPath(new URL("../../../daemon/fixtures/contract/", import.meta.url));

/** The frames a file holds, which is always an array with something in it. */
function frames(dir: string, name: string): unknown[] {
  const path = join(CONTRACT, dir, name);
  const held = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(held) || held.length === 0) throw new Error(`${path} must hold a non-empty array of frames`);
  return held;
}

/** The op or type names a discriminated union takes, off its options. */
const namesOf = (union: { options: ZodObject<ZodRawShape>[] }, key: string): string[] =>
  union.options
    .map(option => {
      const literal = option.shape[key];
      if (!(literal instanceof ZodLiteral)) throw new Error(`${key} is not a literal on every option`);
      return String(literal.value);
    })
    .sort();

/** The op names with a file pair under frames, off the files. */
const filed = (dir: string): string[] => [...new Set(readdirSync(join(CONTRACT, dir)).map(f => f.replace(/\.(accept|reject)\.json$/, "")))].sort();

/** Which schema reads a frame by its op: every op the daemon answers inbound is one DaemonRequest option, the auth
 * frame is its own, the two the place sends outward to its host are theirs, and the machine ops the host sends a
 * place over the link are the link's own union. */
const OUTBOUND: Record<string, ZodTypeAny> = { auth: DaemonAuthRequest, "place.auth": PlaceAuthRequest, "place.prove": PlaceProveRequest };
const schemaFor = (op: string): ZodTypeAny => OUTBOUND[op] ?? (op.startsWith("machine.") ? MachineLinkRequest : DaemonRequest);

describe("every op and every event has its accept and reject frames", () => {
  it("names one file pair per op the daemon answers, per machine op on the link, plus auth and the two frames a place sends its host", () => {
    expect(filed("frames")).toEqual([...namesOf(DaemonRequest, "op"), ...namesOf(MachineLinkRequest, "op"), ...Object.keys(OUTBOUND)].sort());
  });

  it("names one file pair per event type the daemon pushes", () => {
    expect(filed("events")).toEqual(namesOf(DaemonEvent, "type"));
  });

  it("has both halves of every pair", () => {
    for (const dir of ["frames", "events"]) {
      for (const name of filed(dir)) {
        for (const half of ["accept", "reject"]) expect(existsSync(join(CONTRACT, dir, `${name}.${half}.json`)), `${dir}/${name}.${half}.json`).toBe(true);
      }
    }
  });
});

describe("the schemas take every accept frame and refuse every reject frame", () => {
  for (const op of filed("frames")) {
    it(`frames/${op}`, () => {
      const schema = schemaFor(op);
      for (const frame of frames("frames", `${op}.accept.json`)) {
        const parsed = schema.safeParse(frame);
        expect(parsed.success, `${op} must accept ${JSON.stringify(frame).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        // A frame under an op's file is that op's frame: the discriminant is what the file is named after.
        expect((frame as { op: string }).op).toBe(op);
      }
      for (const frame of frames("frames", `${op}.reject.json`)) {
        expect(schema.safeParse(frame).success, `${op} must refuse ${JSON.stringify(frame).slice(0, 200)}`).toBe(false);
      }
    });
  }

  for (const type of filed("events")) {
    it(`events/${type}`, () => {
      for (const event of frames("events", `${type}.accept.json`)) {
        const parsed = DaemonEvent.safeParse(event);
        expect(parsed.success, `${type} must accept ${JSON.stringify(event).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
        expect((event as { type: string }).type).toBe(type);
      }
      for (const event of frames("events", `${type}.reject.json`)) {
        expect(DaemonEvent.safeParse(event).success, `${type} must refuse ${JSON.stringify(event).slice(0, 200)}`).toBe(false);
      }
    });
  }
});

/** A sentence with a value in it is kept as its template: the braces name what the daemon fills in. */
const words = (): Record<string, string> => ({
  tokenRefused: DAEMON_TOKEN_REFUSED,
  firstFrameNotAuth: DAEMON_FIRST_FRAME_NOT_AUTH,
  preAuthBytesExceeded: DAEMON_PRE_AUTH_BYTES_EXCEEDED,
  authDeadlinePassed: DAEMON_AUTH_DEADLINE_PASSED,
  tokenRotated: DAEMON_TOKEN_ROTATED,
  invalidJson: DAEMON_INVALID_JSON,
  noToken: DAEMON_NO_TOKEN,
  unknownOp: unknownOpLine("{op}"),
  portScopeRefusal: portScopeRefusal("{port}"),
  foldersOutside: foldersOutsideLine("{dir}", "{roots}"),
  notOnThisRoad: NOT_ON_THIS_ROAD,
  notOnThisKind: NOT_ON_THIS_KIND,
  noImagesHere: NO_IMAGES_HERE,
  guestNotWatcher: GUEST_NOT_WATCHER,
  guestQueueFull: GUEST_QUEUE_FULL,
  guestInFlightFull: GUEST_IN_FLIGHT_FULL,
  guestWorkspaceFull: GUEST_WORKSPACE_FULL,
  guestUnwatched: GUEST_UNWATCHED,
  guestNoDaemon: guestNoDaemonLine("{port}"),
  hostClosed: HOST_CLOSED_LINE,
  placeKeptForLink: placeKeptForLinkLine("{path}"),
  placeOutsideLeft: placeOutsideLeftLine("{prefix}"),
  onBase: onBaseRefusal("{base}"),
  notOnABranch: NOT_ON_A_BRANCH,
  nothingAhead: nothingAheadLine("{branch}", "{base}"),
  noRemote: NO_REMOTE,
  noHostCli: noHostCliLine("{host}"),
  noGitCredential: noGitCredentialLine("{host}", "{fix}"),
  noGitCredentialNoFix: noGitCredentialLine("{host}"),
  hostKeyRefusal: hostKeyRefusal("{url}"),
  listening: daemonListeningLine("{host}", "{port}"),
  sysSamplerStarted: SYS_SAMPLER_STARTED,
  sysSamplerStopped: SYS_SAMPLER_STOPPED,
  procSamplerStarted: PROC_SAMPLER_STARTED,
  procSamplerStopped: PROC_SAMPLER_STOPPED,
  noPlaceFile: NO_PLACE_FILE_LINE,
  linked: linkedLine("{url}"),
  hostQuiet: hostQuietLine("{url}", "{seconds}"),
  dialUnanswered: dialUnansweredLine("{url}"),
  dialTimedOut: dialTimedOutLine("{url}", "{seconds}"),
  dialFailed: dialFailedLine("{url}", "{error}"),
  notAFrame: notAFrameLine("{url}"),
  authUnreadable: authUnreadableLine("{url}", "{error}"),
  hostRefused: hostRefusedLine("{url}", "{refusal}"),
  linkOutOfOrder: linkOutOfOrderLine("{url}"),
  linkHostUnsealed: linkHostUnsealedLine("{url}"),
  boxFull: boxFullLine("{need}", "{free}", { name: "{name}", quietMin: "{quiet}" }),
  boxFullOwnWork: boxFullLine("{need}", "{free}"),
});

/** The home the owned-paths fixture is rendered for: one letter, so the list reads as the shape of the paths
 * rather than as somebody's login, and the daemon's twin renders the same one. */
const FIXTURE_HOME = "/h";

/** The binary the wsp shim's fixture is rendered onto: the shim's one hole, kept as its template the way a
 * sentence with a value in it is, since the path differs on each road that writes the shim. */
const SHIM_BINARY = "{binary}";

/** The home the probe path's fixture is rendered for: root's, since every directory the tools PATH names under a
 * home is under that one and a made-up home would take nothing off the list. */
const PROBE_HOME = "/root";

const numbers = (): Record<string, number | string | readonly string[]> => ({
  daemonVersion: DAEMON_VERSION,
  execBodyMax: EXEC_BODY_MAX,
  prReplyBodyMax: PR_REPLY_BODY_MAX,
  guestMessageCapBytes: GUEST_MESSAGE_CAP_BYTES,
  guestQueueCapFrames: GUEST_QUEUE_CAP_FRAMES,
  guestInFlightCapBytes: GUEST_IN_FLIGHT_CAP_BYTES,
  guestSessionsPerWorkspaceCap: GUEST_SESSIONS_PER_WORKSPACE_CAP,
  guestFrameCapBytes: GUEST_FRAME_CAP_BYTES,
  guestUnwatchedMs: GUEST_UNWATCHED_MS,
  guestTokenMax: GUEST_TOKEN_MAX,
  guestArgvMax: GUEST_ARGV_MAX,
  guestCwdMax: GUEST_CWD_MAX,
  execOutputMax: EXEC_OUTPUT_MAX,
  execTimeoutDefaultMs: EXEC_TIMEOUT_DEFAULT_MS,
  execDeadlineExit: EXEC_DEADLINE_EXIT,
  placeLinkNonceBytes: PLACE_LINK_NONCE_BYTES,
  preAuthMaxBytes: PRE_AUTH_MAX_BYTES,
  authDeadlineMs: AUTH_DEADLINE_MS,
  tunnelCap: TUNNEL_CAP,
  fsReadCapBytes: FS_READ_CAP_BYTES,
  fsWriteCapBytes: FS_WRITE_CAP_BYTES,
  fsListCapEntries: FS_LIST_CAP_ENTRIES,
  fsFilesCapEntries: FS_FILES_CAP_ENTRIES,
  gitPrListCap: GIT_PR_LIST_CAP,
  gitPrListBodyCap: GIT_PR_LIST_BODY_CAP,
  checkLogLines: CHECK_LOG_LINES,
  reviewDiffMaxBytes: REVIEW_DIFF_MAX_BYTES,
  fsSearchCapFiles: FS_SEARCH_CAP_FILES,
  fsSearchCapHits: FS_SEARCH_CAP_HITS,
  gitDiffCapBytes: GIT_DIFF_CAP_BYTES,
  ptyScrollbackCapBytes: PTY_SCROLLBACK_CAP_BYTES,
  procCmdlineBytes: PROC_CMDLINE_BYTES,
  portCommandBytes: PORT_COMMAND_BYTES,
  procCap: PROC_CAP,
  pidMax: PID_MAX,
  sshKeyMax: SSH_KEY_MAX,
  sshIdleMs: SSH_IDLE_MS,
  openBodyMax: HTTP_URL_MAX,
  daemonDefaultHost: DAEMON_DEFAULT_HOST,
  daemonDefaultPort: DAEMON_DEFAULT_PORT,
  daemonSamplerIntervalMs: DAEMON_SAMPLER_INTERVAL_MS,
  guestWspHome: GUEST_WSP_HOME,
  workspaceOverlaid: WORKSPACE_OVERLAID,
  homebrewHome: HOMEBREW_HOME,
  homebrewPrefix: HOMEBREW_PREFIX,
  sharedToolRoots: SHARED_TOOL_ROOTS,
  toolsPath: TOOLS_PATH,
  placeWorkspacePath: PLACE_WORKSPACE_PATH,
  daemonTokenPath: DAEMON_TOKEN_PATH,
  daemonRootsPath: DAEMON_ROOTS_PATH,
  guestInboxDir: GUEST_INBOX_DIR,
  guestManifestPath: GUEST_MANIFEST_PATH,
  openShimPath: OPEN_SHIM_PATH,
  xdgOpenPath: XDG_OPEN_PATH,
  workspaceApparmorPath: WSP_WORKSPACE_APPARMOR_PATH,
  toolPrefix: TOOL_PREFIX,
  toolLinksDir: TOOL_LINKS_DIR,
  openSocketPath: OPEN_SOCKET_PATH,
  guestDaemonSocketPath: GUEST_DAEMON_SOCKET_PATH,
  guestDaemonDir: GUEST_DAEMON_DIR,
  guestWspPath: GUEST_WSP_PATH,
  daemonOomScoreAdj: DAEMON_OOM_SCORE_ADJ,
  daemonNice: DAEMON_NICE,
  workOomScoreAdj: WORK_OOM_SCORE_ADJ,
  workScoreLine: workScoreLine(),
  cacheDirs: [...CACHE_DIRS],
  repoDepth: REPO_DEPTH,
  repoCap: REPO_CAP,
});

/** The replies a daemon answers the machine ops with, one file per reply schema under replies/, each holding samples
 * that use every optional field once and leave every one out once. A daemon in another language reads the same
 * files through its own reply types and must write them back byte for byte in meaning; the schemas here parse them,
 * so a field renamed on either side fails one of the two. Only the replies such a daemon answers today are listed. */
/** A pull request as a read answers it: a failed Actions job, a check another service reports, and each other word. */
const PR_FACT = {
  number: 12,
  url: "https://github.com/Zingzy/wsp-pr-lab/pull/12",
  state: "open",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "fix/ci-status",
  headOid: "ec5c10de663bd1860925ad42e9580bab4eb1d377",
  headSubject: "Set .ci-status to 1",
  mergeable: "mergeable",
  mergeState: "blocked",
  review: "changes_asked",
  checks: [
    { name: "ci", workflow: "ci", state: "fail", run: { runId: 36495564111, jobId: 109174214002 }, link: "https://github.com/Zingzy/wsp-pr-lab/actions/runs/36495564111/job/109174214002", startedAt: "2026-09-28T10:00:00Z", completedAt: "2026-09-28T10:16:00Z" },
    { name: "buildkite/wsp", state: "pass", link: "https://ci.example.com/build/7", description: "All good ✓" },
    { name: "deploy", state: "skipped" },
    { name: "lint", state: "cancelled" },
    { name: "e2e", workflow: "ci", state: "pending" },
  ],
  additions: 120,
  deletions: 30,
  changedFiles: 9,
  commits: 4,
  behindBase: 3,
  autoMerge: { method: "squash", by: "ana" },
};
const PR_MERGED = {
  number: 12,
  url: "https://github.com/o/r/pull/12",
  state: "merged",
  host: "github.com",
  draft: false,
  base: "main",
  branch: "work",
  headOid: "abc",
  headSubject: "",
  mergeable: "unknown",
  mergeState: "unknown",
  review: "approved",
  checks: [],
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  commits: 1,
};

const REPLIES: Record<string, { schema: ZodTypeAny; samples: unknown[] }> = {
  MachineBackendReply: {
    schema: MachineBackendReply,
    samples: [
      {
        offer: "runtime",
        capabilities: {
          liveCloneForks: false,
          pauseMode: "disk",
          replacesMachine: true,
          previewUrls: false,
          signedUrls: false,
          callbackRelay: true,
          diskSnapshots: true,
          images: true,
          snapshotsAnyLife: false,
          snapshotListing: true,
          templates: true,
          sizes: [
            { cpu: 2, memMb: 4096, rateUsdPerHour: 0 },
            { cpu: 4, memMb: 8192, rateUsdPerHour: 0 },
          ],
          kept: false,
          copies: true,
          ownNetwork: true,
        },
        pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" }, builderDiskGb: 40 },
        lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30000, resumeAsks: { everyMs: 5000, forMs: 60000 } } },
        baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
        logins: "/wsp/logins",
      },
      {
        offer: "runtime",
        capabilities: {
          liveCloneForks: false,
          replacesMachine: true,
          previewUrls: false,
          signedUrls: false,
          callbackRelay: false,
          diskSnapshots: false,
          images: false,
          snapshotsAnyLife: false,
          snapshotListing: false,
          templates: false,
          sizes: [],
          kept: false,
          copies: true,
          ownNetwork: true,
        },
        pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
      },
    ],
  },
  MachineCapacityReply: {
    schema: MachineCapacityReply,
    samples: [
      {
        cores: 4,
        memMb: 7751,
        memRoomMb: 2851,
        machineMemMb: 3875,
        cpuTaken: 1,
        memTakenMb: 1024,
        diskFreeBytes: 47400000000,
        images: [
          { id: "sha256:a61567bd31828687156d735ea8eb01ba4e37636e225dd6a48ba94136a70d9d61", name: "ubuntu:24.04", sizeBytes: 29763253 },
          { id: "sha256:0000000000000000000000000000000000000000000000000000000000000000", sizeBytes: 0 },
        ],
        machines: { running: 1, paused: 1 },
      },
    ],
  },
  MachineHandleReply: {
    schema: MachineHandleReply,
    samples: [
      {
        machine: {
          id: "wsp-live-665-build",
          kind: "sandbox",
          streamUrl: "https://stream.example/x",
          labels: { wsp: "1", "wsp-owner": "state-1" },
          seen: { state: "running", createdAt: "2026-09-12T13:00:00.000Z" },
          replayed: true,
          daemonSupervisor: "entrypoint",
          notice: "size 2x4 on 2 cores: cpu clamped to 1 and memory clamped to 2 GB",
          roads: { previewUrl: false, daemonAnswers: true, putBytes: true, describe: true, facts: false, metrics: true },
        },
      },
      { machine: { id: "wsp-8fef733ad77786dc", kind: "desktop", roads: { previewUrl: true, daemonAnswers: true, putBytes: false, describe: false, facts: true, metrics: false } } },
      { machine: { id: "c1", kind: "sandbox", seen: { state: "paused" }, roads: { previewUrl: false, daemonAnswers: false, putBytes: false, describe: false, facts: false, metrics: false } } },
    ],
  },
  MachineListReply: {
    schema: MachineListReply,
    samples: [
      {
        machines: [
          { id: "wsp-a", state: "running", labels: { wsp: "1", row: "yes" }, size: { cpu: 2, memMb: 1024 } },
          { id: "wsp-b", state: "gone", labels: {} },
        ],
      },
      { machines: [] },
    ],
  },
  MachineExecReply: { schema: MachineExecReply, samples: [{ result: { exitCode: 7, stdout: "out\n", stderr: "err\n" } }, { result: { exitCode: 124, stdout: "", stderr: "" } }] },
  MachineStateReply: { schema: MachineStateReply, samples: [{ state: "starting" }, { state: "running" }, { state: "paused" }, { state: "gone" }] },
  MachineReadingReply: {
    schema: MachineReadingReply,
    samples: [
      {
        reading: {
          state: "running",
          cpu: 1,
          memMb: 2048,
          memBytes: 734003200,
          cpuUsageUsec: 41200000,
          uptimeMs: 5430000,
          procs: 37,
          quietForMs: 143000,
          address: "10.65.0.6",
          cgroup: "/sys/fs/cgroup/wsp/wsp-8fef733ad77786dc",
          upper: "/wsp/run/wsp-8fef733ad77786dc/upper",
        },
      },
      { reading: { state: "paused", cgroup: "/sys/fs/cgroup/wsp/wsp-a", upper: "/wsp/run/wsp-a/upper" } },
    ],
  },
  MachineShapeReply: { schema: MachineShapeReply, samples: [{ shape: { cpu: 2, memMb: 1024, diskGb: 20, createdAt: "2026-09-12T13:00:00.000Z", usedBytes: 5284823040 } }, { shape: {} }] },
  MachineAnswersReply: { schema: MachineAnswersReply, samples: [{ answers: true }, { answers: false }] },
  MachineReachReply: { schema: MachineReachReply, samples: [{ reach: { url: "http://127.0.0.1:41234", token: "", expiresAt: 9007199254740991 } }] },
  GitPushReply: {
    schema: GitPushReply,
    samples: [
      {
        branch: "pricing-page",
        base: "main",
        remote: "origin",
        ahead: 2,
        uncommitted: 1,
        stat: [" src/page.tsx | 14 ++++++++++----", " 1 file changed, 10 insertions(+), 4 deletions(-)"],
      },
      { branch: "work", base: "main", remote: "origin", ahead: 1, uncommitted: 0, stat: [] },
    ],
  },
  GitPrReply: {
    schema: GitPrReply,
    samples: [
      { pr: PR_FACT, created: true },
      { pr: PR_MERGED, created: false },
    ],
  },
  GitIssueReadReply: { schema: GitIssueReadReply, samples: [{"issue": {"number": 5, "url": "https://github.com/Zingzy/wsp-pr-lab/issues/5", "title": "Add a greeting line to notes.txt", "body": "The first line should say hello.", "state": "OPEN", "comments": [{"author": "maya", "body": "Keep it one line.", "at": "2026-09-29T10:00:00Z"}]}}, {"issue": {"number": 7, "url": "https://github.com/Zingzy/wsp-pr-lab/pull/7", "title": "Rename the status word", "body": "", "state": "OPEN", "comments": []}}] },
  GitPrCheckoutReply: { schema: GitPrCheckoutReply, samples: [{"branch": "lab/review-me"}] },
  GitPrDiffReply: { schema: GitPrDiffReply, samples: [{"diff": "diff --git a/status.txt b/status.txt\n--- a/status.txt\n+++ b/status.txt\n@@ -1 +1 @@\n-ok\n+okay\n", "truncated": false, "left": []}, {"diff": "", "truncated": true, "left": ["big.json"]}] },
  GitPrReviewReply: { schema: GitPrReviewReply, samples: [{"url": "https://github.com/Zingzy/wsp-pr-lab/pull/7#pullrequestreview-1", "folded": []}, {"url": "https://github.com/Zingzy/wsp-pr-lab/pull/7#pullrequestreview-2", "folded": ["c2"]}] },
  GitPrReadReply: {
    schema: GitPrReadReply,
    samples: [{ pr: PR_FACT }, { pr: { ...PR_MERGED, state: "closed", mergeable: "conflicting", review: "none", draft: true } }, {}],
  },
  GitPrViewReply: {
    schema: GitPrViewReply,
    samples: [
      {
        title: "Set .ci-status back to 0",
        body: "The check failed on \"exit 1\"…",
        author: "ana",
        createdAt: "2026-09-28T09:00:00Z",
        updatedAt: "2026-09-28T12:00:00Z",
        closedAt: "2026-09-28T13:00:00Z",
        mergedAt: "2026-09-28T13:00:00Z",
        mergedBy: "bo",
        mergeCommit: "0f6de7b4f0aef53a94505efc2d57e87c578196f7",
        labels: [{ name: "dependencies", color: "0366d6", description: "Pull requests that update a dependency file" }, { name: "go", color: "16e2e2" }],
        reviewRequests: [{ name: "babakks", team: false }, { name: "cli/core", team: true }],
        latestReviews: [{ author: "bo", state: "approved", at: "2026-09-28T12:30:00Z" }],
        assignees: ["ana"],
        commits: [
          { oid: "abc", subject: "Set ci status", body: "The check reads the file.", at: "2026-09-28T10:00:00Z", author: "ana", parents: 1, additions: 2, deletions: 1, check: "fail" },
          { oid: "def", subject: "Merge main", body: "", at: "2026-09-28T10:30:00Z", author: "ana" },
        ],
        reviews: [
          { id: 5324159317, nodeId: "PRR_kwDOULIAx88AAAABPVg5VQ", author: "ana", association: "member", state: "changes_requested", body: "see line 3", at: "2026-09-28T11:00:00Z", reactions: [{ content: "+1", count: 2, mine: true }] },
          { author: "bo", state: "approved", body: "", at: "2026-09-28T12:30:00Z", reactions: [] },
        ],
        comments: [
          { id: 5835049811, nodeId: "IC_kwDOULIAx88AAAABXM_oAA", author: "github-actions[bot]", association: "none", bot: true, avatar: "https://avatars.githubusercontent.com/in/15368?v=4", body: "Deployed ✓", url: "https://github.com/o/r/pull/12#issuecomment-5835049811", at: "2026-09-28T12:00:00Z", reactions: [{ content: "rocket", count: 1, mine: false }, { content: "eyes", count: 3, mine: true }] },
          { id: 5835081370, author: "bo", bot: false, body: "thanks", url: "https://github.com/o/r/pull/12#issuecomment-5835081370", at: "2026-09-28T12:01:00Z", reactions: [] },
        ],
        reviewComments: [
          {
            id: 7,
            path: "check.sh",
            line: 3,
            side: "RIGHT",
            author: "ana",
            association: "owner",
            bot: false,
            avatar: "https://avatars.githubusercontent.com/u/1?v=4",
            body: "exit 1 here",
            url: "https://github.com/o/r/pull/12#discussion_r7",
            at: "2026-09-28T11:00:00Z",
            hunk: "@@ -1,2 +1,3 @@\n a\n+b\n c",
            reviewId: 5324159317,
            resolved: false,
            nodeId: "PRRC_kwDOULIAx87090GY",
            threadId: "PRRT_kwDOULIAx85cqYb8",
            reactions: [{ content: "heart", count: 1, mine: false }],
          },
          { id: 8, path: "old.sh", author: "bo", bot: false, body: "gone", url: "u", at: "t", replyTo: 7, resolved: true, threadId: "PRRT_kwDOULIAx85cqYb8", reactions: [] },
        ],
        files: [{ path: "check.sh", additions: 2, deletions: 1 }],
        cut: { commits: true, threads: true, comments: true },
      },
      { title: "", body: "", author: "", createdAt: "", updatedAt: "", labels: [], reviewRequests: [], latestReviews: [], assignees: [], commits: [], reviews: [], comments: [], reviewComments: [], files: [] },
    ],
  },
  GitPrReplyReply: {
    schema: GitPrReplyReply,
    samples: [
      { comment: { id: 5952733077, nodeId: "IC_kwDOULIAx88AAAABYsB0lQ", author: "Zingzy", association: "owner", bot: false, avatar: "https://avatars.githubusercontent.com/u/90309290?v=4", body: "Fixed in 9703d1f.", url: "https://github.com/o/r/pull/12#issuecomment-5952733077", at: "2026-10-02T12:00:00Z", reactions: [] } },
      { reviewComment: { id: 4110044839, nodeId: "PRRC_kwDOULIAx87091Cn", path: "check.sh", line: 3, side: "RIGHT", author: "Zingzy", association: "owner", bot: false, body: "Done.", url: "u", at: "t", hunk: "@@ -1 +1 @@\n-a\n+b", replyTo: 7, reviewId: 5324405558, reactions: [] } },
    ],
  },
  GitPrResolveReply: { schema: GitPrResolveReply, samples: [{ threadId: "PRRT_kwDOULIAx85cqYb8", resolved: true }, { threadId: "PRRT_kwDOULIAx85cqYb8", resolved: false }] },
  GitPrReactReply: {
    schema: GitPrReactReply,
    samples: [{ subject: "IC_kwDOULIAx88AAAABXM_oAA", reactions: [{ content: "+1", count: 1, mine: true }, { content: "-1", count: 2, mine: false }, { content: "laugh", count: 1, mine: false }, { content: "hooray", count: 1, mine: false }, { content: "confused", count: 1, mine: false }, { content: "heart", count: 1, mine: false }, { content: "rocket", count: 1, mine: false }, { content: "eyes", count: 1, mine: false }] }, { subject: "PRR_kwDOULIAx88AAAABPVg5VQ", reactions: [] }],
  },
  GitRunLogReply: {
    schema: GitRunLogReply,
    samples: [
      { lines: ["Run tests\t2026-09-28T10:00:00Z npm ERR! test failed", "Run tests\t2026-09-28T10:00:01Z exit 1"], truncated: true },
      { lines: [], truncated: false },
    ],
  },
  GitPrMergeReply: { schema: GitPrMergeReply, samples: [{ merged: true, autoArmed: false }, { merged: false, autoArmed: true }] },
  GitRepoReadReply: {
    schema: GitRepoReadReply,
    samples: [
      { methods: ["merge", "squash", "rebase"], defaultMethod: "merge", autoMerge: false },
      { methods: ["squash"], defaultMethod: "squash", autoMerge: true },
    ],
  },
  GitStartOnReply: { schema: GitStartOnReply, samples: [{ branch: "tree/lead", oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904" }] },
  GitBranchCompareReply: { schema: GitBranchCompareReply, samples: [{ pushed: true, aheadBy: 2, behindBy: 1, status: "diverged" }, { pushed: false }] },
  GitMergeInReply: {
    schema: GitMergeInReply,
    samples: [
      { branch: "child/one", merged: true, commits: 3, oid: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head: "9daeafb9864cf43055ae93beb0afd6c7d144bfa4", conflicts: [] },
      { branch: "child/two", merged: false, commits: 0, conflicts: ["lead.txt", "src/a b.ts"] },
    ],
  },
  GitUpdateReply: {
    schema: GitUpdateReply,
    samples: [
      { base: "main", merged: true, commits: 4, conflicts: [] },
      { base: "release/1.0", merged: false, commits: 0, conflicts: ["README.md", "src/a b.ts"] },
    ],
  },
  GitPrListReply: {
    schema: GitPrListReply,
    samples: [
      {
        items: [
          { kind: "pull-request", number: 42, title: "Login breaks on Safari", body: "Safari drops the cookie.", url: "https://github.com/o/r/pull/42" },
          { kind: "issue", number: 7, title: "Add dark mode", body: "", url: "https://github.com/o/r/issues/7" },
        ],
      },
      { items: [], note: "no signed-in command line for github.com is on this computer, so its pull requests and issues are not listed" },
    ],
  },
  GitCommitReply: {
    schema: GitCommitReply,
    samples: [
      { oid: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", subject: "Round the cart total once", filesChanged: 2, insertions: 10, deletions: 4 },
      { oid: "0123456789abcdef0123456789abcdef01234567", subject: "", filesChanged: 1, insertions: 0, deletions: 0 },
    ],
  },
  GitDiscardReply: { schema: GitDiscardReply, samples: [{ path: "src/cart.ts" }, { path: "a*b.txt" }] },
  GitCheckpointReply: {
    schema: GitCheckpointReply,
    samples: [
      { ref: "refs/wsp/checkpoints/spoo-fix-login/thr_01a0e365/turn_3", commit: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", changed: true },
      { ref: "refs/wsp/checkpoints/wsp-boat/thr_01a0e365/turn_4", commit: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", changed: false },
    ],
  },
  GitRestoreReply: { schema: GitRestoreReply, samples: [{ before: "refs/wsp/checkpoints/spoo-fix-login/thr_01a0e365/turn_1-before-1790521483000", files: 3 }] },
  GitSnapshotReply: { schema: GitSnapshotReply, samples: [{ commit: "0123456789abcdef0123456789abcdef01234567" }] },
  GitCheckpointDropReply: { schema: GitCheckpointDropReply, samples: [{ dropped: 12 }, { dropped: 0 }] },
  GitWorktreesReply: {
    schema: GitWorktreesReply,
    samples: [
      {
        worktrees: [
          { path: "/Users/dev/wsp", branch: "main", head: "1ac97f8d7ea55cc4f6a4f8f2f0e4f3b6ce9dc0c9" },
          { path: "/Users/dev/.wsp/worktrees/pr_9eb41ab3/feat-pricing", branch: "feat/pricing", head: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4" },
          { path: "/Users/dev/scratch", head: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", prunable: true },
        ],
      },
      { worktrees: [{ path: "/srv/repo.git" }] },
    ],
  },
  GitBranchesReply: {
    schema: GitBranchesReply,
    samples: [
      {
        current: "main",
        branches: [
          { name: "main", oid: "1ac97f8d7ea55cc4f6a4f8f2f0e4f3b6ce9dc0c9", committed: 1790521483, upstream: "origin/main", worktree: "/Users/dev/wsp" },
          { name: "feat/pricing", oid: "5f1c0e2b9a7d4c3e8f6a1b2c3d4e5f60718293a4", committed: 1790400000 },
        ],
      },
      { branches: [], truncated: true },
    ],
  },
  WorktreeReport: {
    schema: WorktreeReport,
    samples: [
      {
        path: "/Users/dev/.wsp/worktrees/pr_9eb41ab3/feat-pricing",
        branch: "feat/pricing",
        made: true,
        carried: [".env", "node_modules", "packages/host/node_modules"],
        plain: ["packages/host/node_modules"],
        ms: 812,
      },
      { path: "/Users/dev/wsp", branch: "main", made: false, carried: [], ms: 76 },
    ],
  },
  WorktreeRemoval: {
    schema: WorktreeRemoval,
    samples: [
      { path: "/Users/dev/.wsp/worktrees/pr_9eb41ab3/feat-pricing" },
      { path: "/Users/dev/.wsp/worktrees/pr_9eb41ab3/loose", rescued: "refs/rescue/pr_9eb41ab3/loose/5f1c0e2b9a7d" },
    ],
  },
  SysHistoryReply: {
    schema: SysHistoryReply,
    samples: [
      { points: [{ at: 1_790_640_000_000, cpu: 20.5, load1: 0.42, mem: { used: 2_048_000, total: 8_192_000 }, disk: { used: 40_960_000, total: 81_920_000 } }], stepMs: 300_000, truncated: false },
      { points: [], stepMs: 7_200_000, truncated: true },
    ],
  },
  FsFilesReply: { schema: FsFilesReply, samples: [{ files: ["README.md", "src/ChatView.tsx"], truncated: false }, { files: [], truncated: true }] },
  GuestOpenReply: { schema: GuestOpenReply, samples: [{ session: "g1" }] },
  SshStartReply: { schema: SshStartReply, samples: [{ port: 42022, hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOvWlEn2x0cQO0mTu7nV9VbWSm5aXQ3u2QYqZ2mGHcbS" }] },
  HostFolderListing: {
    schema: HostFolderListing,
    samples: [
      {
        dir: "/home/maya",
        roots: ["/home/maya", "/wsp/projects/p_1/checkout"],
        folders: [
          { path: "/home/maya/code", repo: true },
          { path: "/home/maya/notes", repo: false },
        ],
        hidden: 3,
      },
      { dir: "/home/maya/notes", roots: ["/home/maya"], folders: [], hidden: 0 },
      { dir: "/home/maya", roots: ["/home/maya"], folders: [{ path: "/home/maya/code/spoo", repo: true, branch: "main", touchedAt: 1758700000000 }], hidden: 0 },
    ],
  },
  GuestCliMessage: { schema: GuestCliMessage, samples: [{ stream: "out", text: "rows\n" }, { stream: "err", text: "one line\n" }, { exit: 3 }] },
  CopyReport: {
    schema: CopyReport,
    samples: [
      {
        road: "clonefile",
        path: "/Users/dev/spoo-landing-pricing-page",
        base: "1ac97f8d7ea55cc4f6a4f8f2f0e4f3b6ce9dc0c9",
        branch: "main",
        fetched: true,
        carried: "deps-and-config",
        excluded: [".next", "node_modules/.cache"],
        skipped: ["node_modules/.cache: node_modules is a link or not a folder, so nothing under it was removed"],
        bytes: 6442450944,
        ms: 4900,
      },
      {
        road: "worktree",
        path: "/Users/dev/spoo-landing-qr-codes",
        base: "2bd08e9f8fb66dd5a7b5a9a3a1f5a4c7df0ed1d0",
        branch: "",
        fetched: false,
        carried: "config-only",
        excluded: [],
        bytes: 21474836481,
        ms: 12400,
        fellBack: "the folder is 20.0 GB and a clone above 20.0 GB is not taken",
      },
    ],
  },
  DaemonErrorResponse: {
    schema: DaemonErrorResponse,
    samples: [
      { id: 7, ok: false, error: "no such workspace: wsp-x", kind: "missing", status: 404 },
      { id: "a", ok: false, error: "this computer's backend has no facts" },
      { id: null, ok: false, error: "invalid json" },
    ],
  },
};

describe("the replies are what the schemas parse and what the fixture set holds", () => {
  for (const [name, { schema, samples }] of Object.entries(REPLIES)) {
    it(`replies/${name}.json parses and equals its regeneration`, () => {
      for (const sample of samples) {
        const parsed = schema.safeParse(sample);
        expect(parsed.success, `${name} must accept ${JSON.stringify(sample).slice(0, 200)}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
      }
      const text = `${JSON.stringify(samples, null, 2)}\n`;
      const regenerated = join(tmpdir(), `wsp-contract-reply-${name}.json`);
      writeFileSync(regenerated, text);
      const path = join(CONTRACT, "replies", `${name}.json`);
      expect(existsSync(path), `daemon/fixtures/contract/replies/${name}.json is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
      expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/replies/${name}.json is behind the protocol. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
    });
  }

  it("names one file per reply and no other", () => {
    expect(readdirSync(join(CONTRACT, "replies")).map(f => f.replace(/\.json$/, "")).sort()).toEqual(Object.keys(REPLIES).sort());
  });
});

describe("the words and numbers are what this package exports", () => {
  for (const [name, regenerate] of [
    ["words.json", words],
    ["numbers.json", numbers],
    // The order a leave walks, which the daemon's own list is held to: the provision folder after the daemon's
    // and wsp's own folder last, so nothing under it is left on a computer the person joined.
    ["place-paths.json", () => placeOwnedPaths(FIXTURE_HOME)],
  ] as const) {
    it(`${name} equals its regeneration`, () => {
      const fresh = regenerate();
      const text = `${JSON.stringify(fresh, null, 2)}\n`;
      const regenerated = join(tmpdir(), `wsp-contract-${name}`);
      writeFileSync(regenerated, text);
      const committed = existsSync(join(CONTRACT, name)) ? (JSON.parse(readFileSync(join(CONTRACT, name), "utf8")) as unknown) : undefined;
      expect(committed, `daemon/fixtures/contract/${name} is behind the protocol. The regenerated file is at ${regenerated}: copy it over daemon/fixtures/contract/${name} and commit it`).toEqual(fresh);
      expect(readFileSync(join(CONTRACT, name), "utf8")).toBe(text);
    });
  }

  it("probe-path.txt equals its regeneration, so what the daemon runs a command through and what the job exports is one list", () => {
    const text = `${probePath(PROBE_HOME)}\n`;
    const regenerated = join(tmpdir(), "wsp-contract-probe-path.txt");
    writeFileSync(regenerated, text);
    const path = join(CONTRACT, "probe-path.txt");
    expect(existsSync(path), `daemon/fixtures/contract/probe-path.txt is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/probe-path.txt is behind the protocol. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });

  it("guest-wsp-shim.sh equals its regeneration, so the word inside a fork and inside a workspace is one text", () => {
    const text = guestWspShim(SHIM_BINARY);
    const regenerated = join(tmpdir(), "wsp-contract-guest-wsp-shim.sh");
    writeFileSync(regenerated, text);
    const path = join(CONTRACT, "guest-wsp-shim.sh");
    expect(existsSync(path), `daemon/fixtures/contract/guest-wsp-shim.sh is missing. The regenerated file is at ${regenerated}: copy it there and commit it`).toBe(true);
    expect(readFileSync(path, "utf8"), `daemon/fixtures/contract/guest-wsp-shim.sh is behind the protocol. The regenerated file is at ${regenerated}: copy it over and commit it`).toBe(text);
  });

  it("puts every file the daemon inside a machine writes for itself under one folder, by the names a joined computer uses", () => {
    // A workspace on a computer somebody joined has this folder of its own bound over the computer's, so a path
    // that slipped out of it would be written into a /root every workspace there shares: the second workspace's
    // deploy would rewrite the first one's token.
    for (const path of [DAEMON_TOKEN_PATH, GUEST_INBOX_DIR, GUEST_MANIFEST_PATH, OPEN_SOCKET_PATH, DAEMON_ROOTS_PATH, GUEST_DAEMON_SOCKET_PATH]) {
      expect(path.startsWith(`${GUEST_WSP_HOME}/`), path).toBe(true);
    }
    // And they are the names a daemon uses under the home of a computer somebody joined: one daemon, one rule.
    const at = placeDaemonPaths("/root");
    expect({ wsp: at.wsp, token: at.tokenPath, inbox: at.inbox, manifest: at.manifestPath, socket: at.openSocket, roots: at.rootsPath }).toEqual({
      wsp: GUEST_WSP_HOME,
      token: DAEMON_TOKEN_PATH,
      inbox: GUEST_INBOX_DIR,
      manifest: GUEST_MANIFEST_PATH,
      socket: OPEN_SOCKET_PATH,
      roots: DAEMON_ROOTS_PATH,
    });
    // The binary the host deploys is not one of them: it is the host's to land and sits beside the folder.
    expect(GUEST_DAEMON_DIR.startsWith(GUEST_WSP_HOME)).toBe(false);
  });

  it("holds every 4401 reason once, and the listening line names a host and a port", () => {
    const w = words();
    expect(new Set([w["tokenRefused"], w["firstFrameNotAuth"], w["preAuthBytesExceeded"], w["authDeadlinePassed"]]).size).toBe(4);
    expect(w["listening"]).toBe("wsp-daemon listening on {host}:{port}");
    expect(w["unknownOp"]).toBe("unknown op: {op}");
  });
});
