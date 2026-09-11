// SPDX-License-Identifier: AGPL-3.0-only
// wsp doctor: proves the whole reach path against one live machine and prints
// a timing table. fork -> deploy daemon -> previewUrl -> heartbeat client ->
// inbox round trip -> kill, with a check at the end that this host left none.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_CONFIG_DIR, CURL_NET, GOLDEN_SETUP, GOLDEN_SMOKE, NODE_RELEASES } from "@wsp/catalog";
import { CREATED_AT_LABEL, DAEMON_PORT, DOCTOR_LABEL, EXEC_ENV, GUEST_USER_ENV, OWNER_LABEL, TOOLS_PATH, WSP_LABEL, GUEST_TMP, isMissing, isReserved, landBytes, RUN_DIR, whoseMachine, type Machine, type MachineBackend } from "@wsp/engine";
import { DAEMON_MEMORY_MAX_PERCENT, DAEMON_NICE, DAEMON_OOM_SCORE_ADJ, DAEMON_ROOTS_PATH, LOOPBACK, NO_BUILD_TOOLS_LINE, NO_LINGER_LINE, NO_SNAPSHOT_LISTING, NO_TEMPLATES_LINE, THIS_COMPUTER, isLocalWorkspace, otherHostsMachinesLine, rootsPathIn, shellQuote, sshDaemonPaths, templateRecordedLine, templateSkippedLine, type SnapshotStorage, type WorkspaceKind } from "@wsp/protocol";
import { DAEMON_TOKEN_PATH, goldenHead, writeDaemonTokenScript, type AccountOrphans, type GoldenVersion, type Runtime } from "@wsp/runtime";
import WebSocket from "ws";
import { assetDir } from "./assets.js";
import { describeDeleted, describeOrphanOffer, describeOrphans, describeStorage } from "./storage.js";
import type { CliIO } from "./cli.js";

const execFileAsync = promisify(execFile);

// --- where a daemon lives on a machine ------------------------------------

/** Everywhere one machine's daemon keeps something, how it binds and who supervises it. A fork wsp made is root's,
 * so everything sits under /root behind a system unit reachable through the preview edge; a machine the person
 * already owns is reached under their own login, so every path sits under their home, the unit is their own
 * login's, and the daemon binds loopback with the port forwarded from this computer. One value per place, read by
 * the bundle, the unit, the stop and the deploy, so no line below compares a kind. */
export interface DaemonPlace {
  /** Which kind of machine this daemon serves, which picks the two modules its Live rows and Processes tab read. */
  kind: WorkspaceKind;
  /** Where the bundle is unpacked and the daemon runs from. */
  dir: string;
  /** Where the packed bundle lands before it is unpacked. */
  bundle: string;
  inbox: string;
  tokenPath: string;
  /** The file naming the imported project folders the daemon may browse beside its root. */
  rootsPath: string;
  /** The folder every fs and git op resolves inside, beside the folders the roots file names. */
  root: string;
  /** Made before anything lands: every folder a path here needs that the machine may not already have. */
  make: readonly string[];
  /** Prepended to the deploy's own PATH, so the node it installs is the node it then runs. */
  pathPrefix: readonly string[];
  /** Exported before the deploy runs. A guest exec carries PATH and nothing else, while an ssh login arrives as
   * the person it belongs to and needs only what its own session manager wants. */
  exportEnv: readonly string[];
  /** Whether the paths here came from the machine rather than from wsp. A fork chose its own and its script is
   * pinned byte for byte by the golden's content hash; a machine somebody owns answered with a home wsp did not
   * choose, and isPlainPath admits a space in one, so every path there is quoted in each language the deploy
   * writes: the shell for its scripts and systemd's own for the unit. */
  quotePaths: boolean;
  /** How this host's daemon token reaches the machine. A fork is root's alone, so the deploy writes it in the
   * script; a machine somebody else may hold an account on would have it in a world readable /proc/<pid>/cmdline
   * for the length of that exec, so there it travels the machine's own byte road and the script never names it. */
  tokenRoad: "script" | "bytes";
  /** What must hold on the machine before anything is installed on it; empty where wsp built the machine and
   * already knows. Each line ends the deploy itself when it refuses, since the exit status of a guard behind ||
   * is not what set -e acts on. */
  preflight: readonly string[];
  /** Where a download or a log the deploy makes goes. */
  scratch: string;
  /** Where a run's script, streams and exit code live on this machine. */
  runDir: string;
  /** Where Node is installed when the machine carries none the daemon runs on. */
  nodeDir: string;
  /** The least Node major the daemon runs on, checked before the bootstrap. Absent asks only that some node is
   * there, which is what a golden builder's own base floor already put under /usr/local. */
  nodeLeast?: number;
  /** Where the browser shim and its xdg-open name go; a folder already on the machine's own PATH. */
  binDir: string;
  openShim: string;
  openSocket: string;
  /** The file wsp owns and rewrites on every deploy, holding the BROWSER export. */
  profileFile: string;
  /** The person's own login file one guarded source line is added to. A guest reads its whole profile.d folder and
   * needs none; .profile rather than .bashrc on a machine that is somebody's, since bash reads .bashrc only for an
   * interactive shell that is not a login, and every road onto the machine that reads a dotfile at all is a login. */
  profileSource?: string;
  /** Whose systemd runs the unit: the machine's, or the login's own. */
  scope: "system" | "user";
  unitPath: string;
  /** The PATH the daemon and every pty under it get, stated on the unit rather than inherited. */
  toolsPath: string;
  /** The rest of the unit's environment, stated the same way. */
  unitEnv: Readonly<Record<string, string>>;
  /** What the unit is enabled under, which differs between a machine's systemd and a login's. */
  wantedBy: string;
  /** The address the daemon binds. */
  bind: string;
  /** The port it binds; 0 asks the machine for a free one. */
  port: number;
  /** Where the daemon writes the port it bound, for a place that gave it none to bind. */
  portFile?: string;
  /** The options start.mjs hands startDaemon, as the source text they are written as rather than as values: a
   * guest's socket path is the bundle's own export, which is a name and not a string. */
  daemonArgs: readonly string[];
  /** Quarter seconds the deploy waits for the daemon to answer before it reads the log instead. */
  upTries: number;
}

/** The supervisor's name for the daemon, the one string the unit file, the stop, the start and the log read. */
export const DAEMON_UNIT = "wsp-daemon.service";

const GUEST_DIR = "/root/wsp-daemon";
const GUEST_BIN = "/usr/local/bin";

/** The place a machine wsp forked keeps its daemon: root's own, under a system unit, bound on every address
 * because the preview edge dials the guest's eth0 and loopback answers 502. */
export const CLOUD_PLACE: DaemonPlace = {
  kind: "cloud",
  dir: GUEST_DIR,
  bundle: `${GUEST_DIR}.tgz`,
  inbox: "/root/inbox",
  tokenPath: DAEMON_TOKEN_PATH,
  rootsPath: DAEMON_ROOTS_PATH,
  root: "/root",
  make: [GUEST_DIR, "/root/inbox"],
  pathPrefix: [GUEST_BIN],
  exportEnv: [EXEC_ENV],
  quotePaths: false,
  tokenRoad: "script",
  preflight: [],
  scratch: GUEST_TMP,
  runDir: RUN_DIR,
  nodeDir: "/usr/local",
  binDir: GUEST_BIN,
  openShim: `${GUEST_BIN}/wsp-open`,
  openSocket: "/root/.wsp/open.sock",
  profileFile: "/etc/profile.d/wsp-open.sh",
  scope: "system",
  unitPath: `/etc/systemd/system/${DAEMON_UNIT}`,
  toolsPath: TOOLS_PATH,
  unitEnv: GUEST_USER_ENV,
  wantedBy: "multi-user.target",
  bind: "0.0.0.0",
  port: DAEMON_PORT,
  daemonArgs: ['host: "0.0.0.0"', "openSocketPath: OPEN_SOCKET_PATH"],
  upTries: 20,
};

/** The place a machine reached over ssh keeps its daemon: under the login's own home, behind that login's systemd,
 * bound on loopback and on whatever port the machine had free, which it writes down for the host to forward to.
 * Nothing here needs root, and nothing on the machine listens beyond its own loopback. Where each file sits is
 * the protocol's rule, since the runtime reads the token and the port back off the same layout. */
export function sshDaemonPlace(login: { home: string; path: string }): DaemonPlace {
  const at = sshDaemonPaths(login.home);
  const nodeBin = `${at.nodeDir}/bin`;
  return {
    kind: "ssh",
    dir: at.dir,
    bundle: at.bundle,
    inbox: at.inbox,
    tokenPath: at.tokenPath,
    rootsPath: at.rootsPath,
    root: login.home,
    make: [at.dir, at.inbox, at.binDir, at.nodeDir, at.unitDir],
    pathPrefix: [nodeBin, at.binDir],
    // A login that arrives without its own session manager's address cannot talk to its systemd at all, and every
    // line below would fail at the bus rather than at the thing it was doing.
    exportEnv: ['export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"'],
    quotePaths: true,
    tokenRoad: "bytes",
    preflight: [
      `for t in cc make python3; do command -v "$t" >/dev/null 2>&1 || { echo ${shellQuote(NO_BUILD_TOOLS_LINE)}; exit 1; }; done`,
      // Asked only where the machine can answer: without linger the login's own systemd stops with its last
      // session and takes the daemon with it the moment the host's connection closes, so a deploy that skipped
      // this would look like it worked and be gone by the next dial.
      `if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then echo ${shellQuote(NO_LINGER_LINE)}; exit 1; fi`,
    ],
    scratch: at.wsp,
    runDir: at.runDir,
    nodeDir: at.nodeDir,
    nodeLeast: 22,
    binDir: at.binDir,
    openShim: `${at.binDir}/wsp-open`,
    openSocket: at.openSocket,
    profileFile: at.profileFile,
    profileSource: `${login.home.replace(/\/+$/, "")}/.profile`,
    scope: "user",
    unitPath: `${at.unitDir}/${DAEMON_UNIT}`,
    toolsPath: [nodeBin, at.binDir, login.path].join(":"),
    unitEnv: { HOME: login.home },
    wantedBy: "default.target",
    // Nothing on a machine somebody else owns may listen past its own loopback: the host reaches this daemon
    // through an ssh forward, which dials that machine's own loopback from its own side.
    bind: LOOPBACK,
    port: 0,
    portFile: at.portFile,
    daemonArgs: [
      `host: ${JSON.stringify(LOOPBACK)}`,
      "port: 0",
      `kind: ${JSON.stringify("ssh")}`,
      `root: ${JSON.stringify(login.home)}`,
      `rootsPath: ${JSON.stringify(at.rootsPath)}`,
      `tokenPath: ${JSON.stringify(at.tokenPath)}`,
      `inboxDir: ${JSON.stringify(at.inbox)}`,
      `manifest: { path: ${JSON.stringify(at.manifestPath)} }`,
      `openSocketPath: ${JSON.stringify(at.openSocket)}`,
    ],
    upTries: 80,
  };
}

export const DAEMON_UNIT_PATH = CLOUD_PLACE.unitPath;

/** A path as this place's shell scripts write it: quoted where it came from the machine, since a home with a
 * space in it would otherwise make `rm -rf /Users/Jane Doe/.wsp` two words and take /Users/Jane with it. */
const sh = (place: DaemonPlace, path: string): string => (place.quotePaths ? shellQuote(path) : path);

/** The same for a unit file's Environment=, which systemd splits on whitespace into one assignment per word, so
 * a value holding a space is double quoted there. Not every setting wants that: WorkingDirectory= takes the rest
 * of its line as the path and reads a quote as part of it ("path is not absolute", measured on systemd 255,
 * 2026-09-11), and ExecStart= is a command line whose own shell does the quoting inside it. */
const unitEnvLine = (place: DaemonPlace, value: string): string => (place.quotePaths ? `"${value}"` : value);

/** The systemd this place's unit belongs to. */
const systemctlIn = (place: DaemonPlace): string => (place.scope === "user" ? "systemctl --user" : "systemctl");

// --- daemon bundle --------------------------------------------------------

/** Runs inside the place's own folder. A fork binds 0.0.0.0 because loopback binds are unreachable through the
 * preview edge (it dials eth0); a machine reached over ssh binds loopback and writes down the port it was given,
 * which is the one thing the host cannot know before the daemon is up. PATH is set before the daemon loads, never
 * inherited: a relaunch from the machine's side arrives with a bare one (measured after an OOM kill, 2026-09-06).
 * The killer's score and the nice value are written here, on the daemon's own pid, so every road that starts the
 * daemon gives them; a start that may not write one (not root, or no Linux /proc) says so in the log and runs on. */
export function startMjs(place: DaemonPlace): string {
  return `import { writeFileSync } from "node:fs";
import { setPriority } from "node:os";
process.env.PATH = ${JSON.stringify(place.toolsPath)};
try {
  writeFileSync("/proc/self/oom_score_adj", ${JSON.stringify(String(DAEMON_OOM_SCORE_ADJ))});
} catch (e) {
  console.error(\`oom_score_adj not set: \${e.message}\`);
}
try {
  setPriority(${DAEMON_NICE});
} catch (e) {
  console.error(\`priority not set: \${e.message}\`);
}
const { OPEN_SOCKET_PATH, startDaemon } = await import("./dist/index.js");
const d = await startDaemon({ ${place.daemonArgs.join(", ")} });
${place.portFile === undefined ? "" : `writeFileSync(${JSON.stringify(place.portFile)}, String(d.port));\n`}console.log(\`wsp-daemon listening on ${place.bind}:\${d.port}\`);
`;
}

/** Mirror @wsp/daemon's relay constants: importing the package here would pull
 * node-pty into the host and the desktop bundle. The shim posts to the socket
 * start.mjs opens; the daemon's own tests pin the script against its copy. */
export const OPEN_SHIM_PATH = CLOUD_PLACE.openShim;
export function openShimScript(place: DaemonPlace): string {
  return `#!/bin/sh
[ "$#" -ge 1 ] || exit 0
printf '%s' "$1" | curl -s -m 1 -o /dev/null --unix-socket ${sh(place, place.openSocket)} -X POST --data-binary @- http://wsp/open >/dev/null 2>&1
exit 0
`;
}

/** Lay out an installable copy of the daemon for one place: its dist build, a
 * start script, and a package.json whose dependency pins mirror the daemon's
 * (node-pty has no linux prebuilds, so the machine's npm install compiles it, ~5s). */
export async function stageDaemonBundle(stageDir: string, place: DaemonPlace, daemonDir = assetDir("daemon")): Promise<void> {
  const daemonPkg = JSON.parse(readFileSync(join(daemonDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  mkdirSync(stageDir, { recursive: true });
  cpSync(join(daemonDir, "dist"), join(stageDir, "dist"), { recursive: true });
  writeFileSync(join(stageDir, "start.mjs"), startMjs(place));
  writeFileSync(join(stageDir, "wsp-open"), openShimScript(place), { mode: 0o755 });
  writeFileSync(
    join(stageDir, "package.json"),
    JSON.stringify(
      { name: "wsp-daemon-bundle", private: true, type: "module", dependencies: daemonPkg.dependencies },
      null,
      2,
    ),
  );
}

/** A golden builder has the base floor's Node 22 under /usr/local before this runs; a desktop template or a
 * doctor's scratch machine with no node at all gets the same release here. */
export const GUEST_NODE = NODE_RELEASES[22];

function nodeBootstrap(place: DaemonPlace): string {
  const v = GUEST_NODE.version;
  // A machine that is somebody's own may carry a node the daemon will not run on, so the major is read as well as
  // the name; a machine wsp built carries the floor's, and asking its version would only change a script that is
  // already right.
  const old = place.nodeLeast === undefined ? "" : ` || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt ${place.nodeLeast} ]`;
  return [
    CURL_NET,
    `if ! command -v node >/dev/null 2>&1${old}; then`,
    '  arch="$(uname -m)"',
    '  case "$arch" in',
    `    x86_64) pkg=node-v${v}-linux-x64.tar.gz sha=${GUEST_NODE.sha256.x86_64} ;;`,
    `    aarch64) pkg=node-v${v}-linux-arm64.tar.gz sha=${GUEST_NODE.sha256.aarch64} ;;`,
    '    *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
    "  esac",
    `  curl -o "${place.scratch}/$pkg" "https://nodejs.org/dist/v${v}/$pkg"`,
    `  echo "$sha  ${place.scratch}/$pkg" | sha256sum -c - >/dev/null`,
    `  tar -xzf "${place.scratch}/$pkg" -C ${sh(place, place.nodeDir)} --strip-components=1`,
    `  rm -f "${place.scratch}/$pkg"`,
    "fi",
    // A Node under the place's own prefix carries its headers, so node-pty compiles against them instead of downloading a set.
    `case "$(command -v node)" in ${sh(place, `${place.nodeDir}/bin/node`)}) export npm_config_nodedir=${sh(place, place.nodeDir)} ;; esac`,
  ].join("\n");
}

/** Vite reads this list of extra allowed hosts from the environment (8.2.2, measured 2026-09-05); without it every
 * dev server answers 403 through the preview edge. Next.js and webpack-dev-server have no env equivalent. */
export const VITE_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/** What the daemon has printed lately, for a deploy that has to say why the port never came up. The journal
 * rather than a file because journald rotates itself against a cap it states at boot (395 MB on a 20 GB guest,
 * measured 2026-09-08) and nothing else on the machine would bound one: the redirect this replaced truncated the
 * file on every deploy, and an appended one under Restart=always with no start limit has no end. */
export const daemonLogCommand = (place: DaemonPlace = CLOUD_PLACE, lines = 50): string =>
  `journalctl ${place.scope === "user" ? "--user " : ""}-u ${DAEMON_UNIT} -n ${lines} --no-pager`;

/** The unit the daemon runs under. Until 2026-09-08 it was started with setsid over the provider's exec and had no
 * supervisor at all: the kernel's memory killer took one and the machine sat with no daemon for five hours while
 * its turns, which go over that same exec, kept running. Restart=always is the whole point of the file, so the
 * start rate limit that would give up after five restarts is off. OOMPolicy=continue keeps a killed child (a test
 * run under a terminal) from taking the daemon with it, which systemd's default of stop would do. MemoryMax is a
 * share of the machine, not a figure, because every terminal the daemon opens sits in its cgroup. Output goes to
 * the journal, the one store on the machine that bounds itself. The environment is stated here rather than
 * inherited: a restart at boot or after a kill inherits nothing from the exec that deployed the daemon. */
export function daemonUnit(place: DaemonPlace = CLOUD_PLACE, previewHostSuffix?: string): string {
  return [
    "[Unit]",
    "Description=wsp daemon",
    "After=network.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    // The rest of the line is the path, quotes and all, so a space in one needs nothing and a quote would break it.
    `WorkingDirectory=${place.dir}`,
    `Environment=${unitEnvLine(place, `PATH=${place.toolsPath}`)}`,
    ...Object.entries(place.unitEnv).map(([name, value]) => `Environment=${unitEnvLine(place, `${name}=${value}`)}`),
    ...(previewHostSuffix !== undefined ? [`Environment=${VITE_ALLOWED_HOSTS_ENV}=${previewHostSuffix}`] : []),
    // Through sh so node is found on the unit's PATH: a machine that shipped its own node keeps it where it is.
    `ExecStart=/bin/sh -c 'exec node ${place.quotePaths ? `"${place.dir}/start.mjs"` : `${place.dir}/start.mjs`}'`,
    "Restart=always",
    "RestartSec=1",
    `MemoryMax=${DAEMON_MEMORY_MAX_PERCENT}%`,
    "OOMPolicy=continue",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    `WantedBy=${place.wantedBy}`,
    "",
  ].join("\n");
}

/** Stops whatever holds the daemon's place before the new daemon starts: an update lands on a machine whose daemon
 * is running, and a second bind would fail while the port check still read the old one as up. The unit goes first,
 * since an explicit stop is the only thing Restart=always yields to and killing the pid under it would have
 * systemd put the old daemon straight back. On a place with a port of its own, what is left is a daemon from
 * before the unit: its pid comes from the socket table, the one place the guest names it (nothing else may bind
 * the port; the machine context says so). A place whose daemon picks its own port had no such daemon and writes
 * the port it bound, so the file goes instead and the deploy waits for a fresh one. A fresh machine skips through. */
export function stopDaemonScript(place: DaemonPlace = CLOUD_PLACE): string {
  return [
    `${systemctlIn(place)} stop ${DAEMON_UNIT} 2>/dev/null || true`,
    ...(place.portFile !== undefined ? [`rm -f ${sh(place, place.portFile)}`] : []),
    ...(place.port === 0
      ? []
      : [
          `old="$(ss -ltnpH 'sport = :${place.port}' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n 1)"`,
          'if [ -n "$old" ]; then',
          '  kill "$old" 2>/dev/null || true',
          "  for _ in $(seq 20); do",
          `    ss -ltnH 'sport = :${place.port}' | grep -q . || break`,
          "    sleep 0.25",
          "  done",
          `  ss -ltnH 'sport = :${place.port}' | grep -q . && kill -9 "$old" 2>/dev/null && sleep 0.5`,
          '  echo "DAEMON_STOPPED $old"',
          "fi",
        ]),
  ].join("\n");
}

/** How the deploy learns the daemon answered. A place on a known port reads the socket table, which is what a
 * guest has. A place that let the machine pick reads the port the daemon wrote down, which is also the proof it
 * bound, and asks its supervisor whether it is still up: iproute2 is not on every machine somebody owns. */
function upCheck(place: DaemonPlace): string[] {
  if (place.portFile === undefined) {
    return [
      `for _ in $(seq ${place.upTries}); do ss -ltnH 'sport = :${place.port}' | grep -q . && break; sleep 0.25; done`,
      `ss -ltn | grep -q ${place.port} && echo DAEMON_UP || { ${daemonLogCommand(place)}; echo DAEMON_DOWN; }`,
    ];
  }
  return [
    `for _ in $(seq ${place.upTries}); do [ -s ${sh(place, place.portFile)} ] && break; sleep 0.25; done`,
    `p="$(cat ${sh(place, place.portFile)} 2>/dev/null)"`,
    `[ -n "$p" ] && ${systemctlIn(place)} is-active --quiet ${DAEMON_UNIT} && echo "${DAEMON_PORT_LINE} $p" && echo DAEMON_UP || { ${daemonLogCommand(place)}; echo DAEMON_DOWN; }`,
  ];
}

/** What the deploy prints the bound port under, for a place that let the machine pick one. */
export const DAEMON_PORT_LINE = "DAEMON_PORT";

/** The install and start sequence on the machine. `previewHostSuffix` (".preview.example.com") is what dev servers
 * must accept to answer through the edge; absent on a backend without preview URLs. The daemon is left running
 * under its unit, so nothing here has to outlive the exec. */
export function deployScript(place: DaemonPlace, token: string, previewHostSuffix?: string): string {
  const profileDir = posix.dirname(place.profileFile);
  return [
    "set -e",
    `export PATH="${place.pathPrefix.join(":")}:$PATH"`,
    // Nothing else supervises a process on these machines, and an unsupervised daemon is what this deploy exists
    // to stop shipping; a machine without systemd says so here rather than starting one nothing would restart.
    "command -v systemctl >/dev/null || { echo NO_SYSTEMD; false; }",
    // A guest exec carries PATH and nothing else (measured 2026-09-05), and npm and the bundle's build read the
    // machine's home. What the daemon itself hands to every pty comes from its unit, not from here.
    ...place.exportEnv,
    `mkdir -p ${place.make.map(dir => sh(place, dir)).join(" ")}`,
    `tar -xzf ${sh(place, place.bundle)} -C ${sh(place, place.dir)}`,
    nodeBootstrap(place),
    'echo "NODE_VERSION $(node --version)"',
    `cd ${sh(place, place.dir)}`,
    `npm install --omit=dev --no-audit --no-fund > ${sh(place, `${place.scratch}/wsp-npm.log`)} 2>&1 || { tail -3 ${sh(place, `${place.scratch}/wsp-npm.log`)}; echo NPM_FAIL; false; }`,
    `rm -rf ${sh(place, `${place.dir}/node_modules/node-pty/prebuilds`)}`,
    // Both names: only some tools read BROWSER; the rest exec xdg-open by name, and the place's bin folder is first on PATH.
    // BROWSER itself is set by the daemon for its ptys, by the profile file for login shells, and in a fork's envs
    // only when its golden was sealed with the shim (claudeEnvs), never on a machine that may lack the file.
    `install -m 0755 ${sh(place, `${place.dir}/wsp-open`)} ${sh(place, place.openShim)}`,
    `ln -sfn ${sh(place, place.openShim)} ${sh(place, `${place.binDir}/xdg-open`)}`,
    `mkdir -p ${sh(place, profileDir)} && printf 'export BROWSER=%s\\nunset DISPLAY\\n' ${sh(place, place.openShim)} > ${sh(place, place.profileFile)}`,
    // A place whose profile file is the person's own folder is read only if their login file says so, and their
    // login file is theirs: the line goes in once, behind its own name, so a second deploy adds nothing.
    ...(place.profileSource === undefined
      ? []
      : [`grep -q ${shellQuote(place.profileFile)} ${sh(place, place.profileSource)} 2>/dev/null || printf '. %s\\n' ${sh(place, place.profileFile)} >> ${sh(place, place.profileSource)}`]),
    // Login shells read it from the profile file; the daemon's ptys inherit it from the daemon, exported before it starts.
    ...(previewHostSuffix !== undefined
      ? [
          `printf 'export ${VITE_ALLOWED_HOSTS_ENV}=%s\\n' '${previewHostSuffix}' > ${sh(place, `${profileDir}/wsp-preview.sh`)}`,
          `export ${VITE_ALLOWED_HOSTS_ENV}='${previewHostSuffix}'`,
        ]
      : []),
    // A fork is root's alone, so its token is written here; a machine somebody else may hold an account on gets
    // it over the byte road before this runs, since a command sits in a world readable /proc/<pid>/cmdline.
    ...(place.tokenRoad === "script" ? [writeDaemonTokenScript(token, place.tokenPath)] : []),
    stopDaemonScript(place),
    `cat > ${sh(place, place.unitPath)} <<'WSP_UNIT'\n${daemonUnit(place, previewHostSuffix)}WSP_UNIT`,
    `${systemctlIn(place)} daemon-reload`,
    // Enabled as well as started: a machine that reboots or comes back from a snapshot brings the daemon with it.
    `${systemctlIn(place)} enable ${DAEMON_UNIT}`,
    `${systemctlIn(place)} restart ${DAEMON_UNIT}`,
    ...upCheck(place),
  ].join("\n");
}

/** Takes the daemon off a machine and everything wsp kept beside it: the unit stopped, disabled and removed, the
 * bundle, the token, the inbox, the port file and the browser shim, and the one line wsp added to the person's
 * own login file, which would otherwise print an error on every login for a file that is gone. What wsp put on a
 * machine somebody already owns goes when the workspace that put it there does, so the machine is left as wsp
 * found it. Nothing here fails the delete: a machine that will not answer is a machine whose record goes anyway. */
export function removeDaemonScript(place: DaemonPlace): string {
  const systemctl = systemctlIn(place);
  return [
    ...place.exportEnv,
    `${systemctl} disable --now ${DAEMON_UNIT} 2>/dev/null || true`,
    `rm -f ${sh(place, place.unitPath)}`,
    `${systemctl} daemon-reload 2>/dev/null || true`,
    `rm -rf ${wspOwn(place).map(path => sh(place, path)).join(" ")}`,
    `rm -f ${sh(place, place.openShim)} ${sh(place, `${place.binDir}/xdg-open`)}`,
    ...(place.profileSource === undefined
      ? []
      : [
          // Their own login file, so the rewrite lands only when the read of it worked, and the working copy goes
          // either way: a grep that could not read the file would otherwise leave them an empty one.
          `if [ -f ${sh(place, place.profileSource)} ]; then grep -vF ${shellQuote(`. ${place.profileFile}`)} ${sh(place, place.profileSource)} > ${sh(place, `${place.profileSource}.wsp-out`)} && mv -f ${sh(place, `${place.profileSource}.wsp-out`)} ${sh(place, place.profileSource)}; rm -f ${sh(place, `${place.profileSource}.wsp-out`)}; fi`,
        ]),
    `echo ${DAEMON_GONE_LINE}`,
  ].join("\n");
}

/** Everything wsp put on the machine, off the place that named each one: nothing is guessed and no path is
 * written twice. wsp's own folder under somebody's home is not swept whole, since other roads of wsp keep things
 * beside the daemon in it. */
function wspOwn(place: DaemonPlace): string[] {
  return [
    place.dir,
    place.bundle,
    place.inbox,
    place.tokenPath,
    place.rootsPath,
    place.nodeDir,
    place.profileFile,
    place.openSocket,
    place.runDir,
    `${place.scratch}/wsp-npm.log`,
    ...(place.portFile !== undefined ? [place.portFile] : []),
  ];
}

/** What the removal answers with once the machine carries nothing of wsp's any more. */
export const DAEMON_GONE_LINE = "DAEMON_REMOVED";

/** Runs that removal and says what the machine answered, for the one caller that has to report a machine which
 * would not let go of it. */
export async function removeDaemon(machine: Machine, place: DaemonPlace): Promise<void> {
  const res = await machine.run(removeDaemonScript(place), { deadlineMs: 120_000 });
  if (res.exitCode !== 0 || !res.stdout.includes(DAEMON_GONE_LINE)) {
    throw new Error(`the daemon would not come off ${machine.id}: ${res.stdout.slice(-200)} ${res.stderr.slice(-200)}`.trim());
  }
}

/** What must hold on the machine, asked on its own before a single byte of wsp's lands there: a machine that
 * refuses is a machine wsp leaves exactly as it found it, and the person is told what it needs without waiting on
 * an upload first. A place with nothing to ask skips the round trip. */
export function preflightScript(place: DaemonPlace): string {
  return [...place.exportEnv, ...place.preflight, `echo ${PREFLIGHT_OK_LINE}`].join("\n");
}

/** What that check answers with when the machine can take a daemon. */
export const PREFLIGHT_OK_LINE = "PREFLIGHT_OK";

/** Runs it and throws with the machine's own words, which are the sentence the refusing line printed. */
export async function preflight(machine: Machine, place: DaemonPlace): Promise<void> {
  if (place.preflight.length === 0) return;
  const res = await machine.run(preflightScript(place), { deadlineMs: 60_000 });
  if (res.exitCode !== 0 || !res.stdout.includes(PREFLIGHT_OK_LINE)) {
    throw new Error(`${res.stdout.split("\n").filter(line => line !== "").at(-1) ?? res.stderr.slice(-200)}`.trim());
  }
}

/** The preview host with its machine-and-port label cut off ("<id>-7070.preview.example.com" gives
 * ".preview.example.com"): the suffix every port on this machine is served under, read off the backend
 * rather than assumed. Undefined on a backend without preview URLs or a host with no dot to cut at. */
export async function previewHostSuffix(machine: Machine): Promise<string | undefined> {
  if (machine.previewUrl === undefined) return undefined;
  const { hostname } = new URL((await machine.previewUrl(DAEMON_PORT)).url);
  const dot = hostname.indexOf(".");
  return dot > 0 ? hostname.slice(dot) : undefined;
}

/** macOS tar writes com.apple.provenance as pax xattr headers; GNU tar in the
 * guest warns once per file and buries real errors. Measured on bsdtar 3.5.3:
 * --no-xattrs strips them, --no-mac-metadata alone does not and is bsdtar-only. */
export function tarPackCommand(
  stage: string,
  tgz: string,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const flags = platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : ["--no-xattrs"];
  return {
    file: "tar",
    args: [...flags, "-czf", tgz, "-C", stage, "."],
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  };
}

export async function packBundle(stage: string, tgz: string): Promise<void> {
  const { file, args, env } = tarPackCommand(stage, tgz);
  await execFileAsync(file, args, { env });
}

/** Upload and start the daemon on a machine, replacing one already running there; returns the token it starts
 * with (the runtime replaces it the first time a client reaches the daemon), the Node version the daemon runs on
 * and, where the machine picked the port, the port it bound. The bytes go by the one road that reads the machine
 * for how bytes reach it, so a machine whose provider mints no signed URL is deployed to over its own connection. */
export async function deployDaemon(
  machine: Machine,
  opts: { token?: string; daemonDir?: string; place?: DaemonPlace } = {},
): Promise<{ token: string; node: string; port?: number }> {
  const place = opts.place ?? CLOUD_PLACE;
  const token = opts.token ?? randomBytes(24).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "wsp-daemon-bundle-"));
  const tgz = `${stage}.tgz`;
  try {
    // Before the bundle is even packed: what wsp puts on a machine somebody owns goes when the record does, and
    // the surest way to keep that promise for a machine that refuses is to have put nothing there at all.
    await preflight(machine, place);
    await stageDaemonBundle(stage, place, opts.daemonDir);
    await packBundle(stage, tgz);
    await landBytes(machine, place.bundle, new Uint8Array(readFileSync(tgz)));
    // Before the script rather than in it, where the place says the machine may carry other accounts: the bytes
    // go over the connection and no command on that machine ever names the token.
    if (place.tokenRoad === "bytes") await landBytes(machine, place.tokenPath, new TextEncoder().encode(token));

    const suffix = await previewHostSuffix(machine);
    const res = await machine.run(deployScript(place, token, suffix), { deadlineMs: 180_000 });
    if (res.exitCode !== 0 || !res.stdout.includes("DAEMON_UP")) {
      throw new Error(`daemon deploy failed: ${res.stdout.slice(-300)} ${res.stderr.slice(-200)}`);
    }
    const node = /NODE_VERSION (v\S+)/.exec(res.stdout)?.[1] ?? "unknown";
    const port = Number(new RegExp(`${DAEMON_PORT_LINE} (\\d+)`).exec(res.stdout)?.[1] ?? 0);
    return { token, node, ...(port > 0 ? { port } : {}) };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(tgz, { force: true });
  }
}

// --- preview-socket client ------------------------------------------------

export interface DaemonSocket {
  op(op: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
  readonly closed: Promise<number>;
  /** Completed heartbeat round trips. */
  readonly beats: number;
  readonly open: boolean;
}

/** The dial, the auth frame and the op that proves it, before a connect is given up. */
export const DAEMON_CONNECT_TIMEOUT_MS = 15_000;

export interface ConnectOptions {
  /** Preview URL (pt_token in the query) or a plain local daemon URL. */
  url: string;
  /** The daemon's own token, sent as the socket's first frame; the second gate behind the edge's pt_token. */
  token: string;
  /** App-level beat cadence; the edge's idle sweep kills quiet sockets ~30s
   * out and browsers cannot send protocol pings. Default 10s (measured). */
  heartbeatMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
  /** A throw out of onEvent lands here instead of the process: an event from the machine must never end the host. */
  onEventError?: (error: unknown) => void;
  connectTimeoutMs?: number;
}

/** Connect through the preview edge, send the auth frame and prove it with one
 * op round trip before resolving; then keep the socket warm with app-level heartbeats. */
export function connectDaemonSocket(opts: ConnectOptions): Promise<DaemonSocket> {
  const u = new URL(opts.url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u.toString());
    const pending = new Map<number, { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    let beats = 0;
    let settled = false;
    let heartbeat: NodeJS.Timeout | undefined;
    let resolveClosed: (code: number) => void = () => {};
    const closed = new Promise<number>(r => (resolveClosed = r));

    const connectTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error(`daemon connect timed out after ${opts.connectTimeoutMs ?? DAEMON_CONNECT_TIMEOUT_MS}ms`));
      }
    }, opts.connectTimeoutMs ?? DAEMON_CONNECT_TIMEOUT_MS);

    const op = (name: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
      // ws neither throws nor calls back for a send on a closed socket, and the close handler already emptied pending.
      if (ws.readyState !== ws.OPEN) return Promise.reject(new Error(`daemon socket is not open (${name})`));
      const id = nextId++;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, op: name, ...extra }));
      });
    };

    const socket: DaemonSocket = {
      op,
      close: () => {
        if (heartbeat) clearInterval(heartbeat);
        ws.close(1000);
      },
      closed,
      get beats() {
        return beats;
      },
      get open() {
        return ws.readyState === ws.OPEN;
      },
    };

    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      const id = m["id"];
      if (typeof id === "number" && pending.has(id)) {
        pending.get(id)!.resolve(m);
        pending.delete(id);
      } else if (typeof m["type"] === "string") {
        try {
          opts.onEvent?.(m);
        } catch (e) {
          opts.onEventError?.(e);
        }
      }
    });

    ws.on("open", () => {
      // The daemon accepts the upgrade before reading the frame, so only a
      // successful op proves we are in (a bad token closes 4401 instead).
      op("auth", { token: opts.token })
        .then(() => op("manifest.get"))
        .then(
        () => {
          clearTimeout(connectTimer);
          settled = true;
          heartbeat = setInterval(() => {
            op("manifest.get").then(
              () => {
                beats++;
              },
              () => {},
            );
          }, opts.heartbeatMs ?? 10_000);
          resolve(socket);
        },
        e => {
          clearTimeout(connectTimer);
          if (!settled) {
            settled = true;
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
      );
    });
    ws.on("close", (code, reason) => {
      if (heartbeat) clearInterval(heartbeat);
      const err = new Error(`daemon connection closed ${code} ${String(reason)}`);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolveClosed(code);
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(err);
      }
    });
    ws.on("error", e => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

// --- the doctor loop ------------------------------------------------------

function fmtMs(ms: number): string {
  return ms < 10_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

class Timings {
  rows: { step: string; ms: number; note: string }[] = [];
  async time<T>(step: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
    const start = Date.now();
    const v = await fn();
    this.rows.push({ step, ms: Date.now() - start, note: note ? note(v) : "" });
    return v;
  }
  add(step: string, ms: number, note = ""): void {
    this.rows.push({ step, ms, note });
  }
  print(log: (line: string) => void): void {
    const w1 = Math.max(...this.rows.map(r => r.step.length), 4) + 2;
    log("");
    log("step".padEnd(w1) + "time".padEnd(10) + "note");
    log("-".repeat(w1 + 10 + 44));
    for (const r of this.rows) log(r.step.padEnd(w1) + fmtMs(r.ms).padEnd(10) + r.note);
    log("-".repeat(w1 + 10 + 44));
    log("TOTAL".padEnd(w1) + fmtMs(this.rows.reduce((a, r) => a + r.ms, 0)));
  }
}

/** Envs every guest needs: a PATH that reaches the daemon's node, the harness
 * install, and what the golden import's tools stage puts on the machine. */
export const GUEST_ENVS: Record<string, string> = {
  IS_SANDBOX: "1",
  PATH: TOOLS_PATH,
};

/** Without a key the guest still needs the config dir and PATH; a subscription
 * user signs in with /login on the machine, so wsp never sees that credential.
 * BROWSER rides along only for a golden sealed with the shim: Claude Code in an
 * agent session (no TTY, no BROWSER) opens nothing at all, so a remote MCP
 * sign-in from an agent run needs it; a golden without the shim would point
 * every tool at a missing file. */
export function claudeEnvs(anthropicKey?: string, golden?: Pick<GoldenVersion, "browserShim">): Record<string, string> {
  return {
    ...(anthropicKey !== undefined ? { ANTHROPIC_API_KEY: anthropicKey } : {}),
    CLAUDE_CONFIG_DIR,
    ...GUEST_ENVS,
    ...(golden?.browserShim === true ? { BROWSER: OPEN_SHIM_PATH } : {}),
  };
}

/** The doctor's first check: every version of the golden is made durable, so a gateway restart at the provider
 * cannot take the image a person built. Each version is a line, recorded or not; the note is the counts. It never
 * fails the doctor: a version whose snapshot is gone is one line here and the rebuild road below deals with it. */
export async function promoteGoldens(rt: Runtime, io: Pick<CliIO, "log">): Promise<string> {
  let rows: Awaited<ReturnType<Runtime["golden"]["promote"]>>;
  try {
    rows = await rt.golden.promote();
  } catch (e) {
    return `not made durable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (rows === undefined) return NO_TEMPLATES_LINE;
  for (const r of rows) io.log("error" in r ? templateSkippedLine(r.golden, r.version, r.error) : templateRecordedLine(r.golden, r.version, r.templateId, r.sharing));
  if (rows.length === 0) return (await rt.golden.get()) === undefined ? "no golden to make durable" : "every version already has a template";
  const counts = [
    [rows.filter(r => !("error" in r)).length, "promoted"],
    [rows.filter(r => "error" in r).length, "not made durable"],
  ] as const;
  return counts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(", ");
}

/** The doctor's storage step: the account listing split by who made each row, every orphan of this host named, and
 * the offer to delete them, taken on --yes. Rows without this host's mark are named and never passed to a delete,
 * so another host's golden and a person's own snapshot survive a doctor run with --yes. */
export async function cleanOrphans(rt: Runtime, io: Pick<CliIO, "log">, yes: boolean, statePath?: string): Promise<string> {
  let storage: SnapshotStorage | undefined;
  let plan: AccountOrphans | undefined;
  try {
    storage = await rt.golden.storage();
    plan = await rt.golden.orphans();
  } catch (e) {
    return `listing not read: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (storage === undefined || plan === undefined) return NO_SNAPSHOT_LISTING;
  io.log(describeStorage(storage));
  for (const line of describeOrphans(plan)) io.log(line);
  if (plan.snapshots.length === 0 && plan.templates.length === 0) return "no orphan of this host";
  const offer = describeOrphanOffer(plan, yes, statePath);
  if (!yes) return offer;
  io.log(offer);
  const done = await rt.golden.deleteOrphans();
  return done === undefined ? NO_SNAPSHOT_LISTING : describeDeleted(done);
}

/** The doctor's teardown check. Only machines this host made count, by the owner stamp every machine wsp creates
 * wears: a second computer on the same account stands its own, and the doctor deleted none of them. Those are one
 * line, named and left alone; this host's own leftovers fail the run. Returns the step's note. */
export async function verifyNoneLeft(backend: MachineBackend, owner: string, log: (line: string) => void): Promise<string> {
  const rows = (await backend.list()).filter(m => !isReserved(m.labels) && m.state !== "gone");
  const mine = rows.filter(m => whoseMachine(m.labels, owner) === "own");
  const others = rows.filter(m => whoseMachine(m.labels, owner) !== "own");
  if (others.length > 0) log(otherHostsMachinesLine(others.map(m => ({ id: m.id, ...(m.labels[OWNER_LABEL] !== undefined ? { owner: m.labels[OWNER_LABEL]! } : {}) }))));
  if (mine.length > 0) throw new Error(`machines still up: ${mine.map(m => m.id).join(", ")}`);
  return others.length > 0 ? "workspace deleted, no machines of this host left" : "workspace deleted, no machines left on the account";
}

export interface DoctorOptions {
  /** Envs baked into golden builds and forks (claude credentials). */
  envs?: Record<string, string>;
  daemonDir?: string;
  /** Deletes this host's orphan snapshots and templates instead of only naming them. */
  yes?: boolean;
  /** The state file whose records decided which rows are orphans; named in the offer, since a run under a different
   * --state reads the usual file's goldens as recorded by nothing. */
  statePath?: string;
}

/** The word the local road asks the agent for and reads back: random per run, so a reply that carries it was written
 * by a turn this run started rather than left in a store by an earlier one. */
export const localPrompt = (word: string): string => `Reply with exactly this word and nothing else: ${word}`;

/** The doctor's local road: no machine, no provider and no bill. This computer is the workspace, a thread runs on it
 * through the harness whose binary answered here, and its reply is read. It proves the half of wsp a person with no
 * provider key has: the local backend, the turn's child process, the adapter, the transcript. A workspace this run
 * made is forgotten at the end; the one this host already holds is left where it is. */
export async function localDoctor(rt: Runtime, io: CliIO): Promise<number> {
  const timings = new Timings();
  let failed: string | undefined;
  let made: string | undefined;
  try {
    io.log(`doctor: proving a thread on ${THIS_COMPUTER}, with no machine and nothing billing`);

    const workspace = await timings.time(
      "local workspace",
      async () => {
        const held = (await rt.workspaces.list()).find(isLocalWorkspace);
        if (held !== undefined) return held;
        const fresh = await rt.workspaces.createLocal();
        made = fresh.id;
        return fresh;
      },
      w => `${w.name} (${made === undefined ? "already here" : "made for this run"})`,
    );

    const harness = await timings.time(
      "harness here",
      async () => {
        const rows = await rt.harnesses.list(workspace.id);
        const answered = rows.find(r => r.source === "harness");
        if (answered === undefined) {
          const refused = rows.filter(r => r.refusal !== undefined).map(r => `${r.label}: ${r.refusal!}`);
          throw new Error(`no agent on this computer described itself${refused.length > 0 ? ` (${refused.join("; ")})` : ", so none of the ones wsp knows is installed and signed in here"}`);
        }
        return answered;
      },
      h => `${h.label} ${h.version ?? "version unknown"}`,
    );

    const word = `wsp-${randomBytes(3).toString("hex")}`;
    await timings.time(
      "thread and its reply",
      async () => {
        const handle = await rt.sessions.start(workspace.id, { prompt: localPrompt(word), harness: harness.harness });
        const result = await handle.finished;
        if (result.status !== "completed") throw new Error(`the turn ended ${result.status}${result.text === undefined ? "" : `: ${result.text.slice(0, 200)}`}`);
        if (result.text === undefined || !result.text.includes(word)) throw new Error(`the reply did not carry the word this run asked for: ${JSON.stringify(result.text?.slice(0, 200) ?? null)}`);
        return result;
      },
      () => `${harness.label} answered with the word it was asked for`,
    );

    await timings.time(
      "tidy",
      async () => {
        // Delete on this kind drops the record and nothing else: this computer is not a machine to stop.
        if (made !== undefined) await rt.workspaces.delete(made);
      },
      () => (made === undefined ? "the workspace was already here and stays" : "the workspace this run made is forgotten"),
    );
    made = undefined;
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
    if (made !== undefined) await rt.workspaces.delete(made).catch(() => {});
  }

  timings.print(io.log);
  if (failed !== undefined) {
    io.error(`\nDOCTOR FAIL: ${failed}`);
    return 1;
  }
  io.log(`\nDOCTOR PASS: ${THIS_COMPUTER} is a workspace, a thread ran on it and its reply came back.`);
  return 0;
}

export async function doctor(rt: Runtime, io: CliIO, opts: DoctorOptions = {}): Promise<number> {
  const timings = new Timings();
  let failed: string | undefined;
  let workspaceId: string | undefined;
  let socket: DaemonSocket | undefined;
  const eventListeners: ((e: Record<string, unknown>) => void)[] = [];

  const buildGolden = async (): Promise<string> => {
    if (!opts.envs) {
      throw new Error("no golden image and no ANTHROPIC_API_KEY to build one; add the key or run wspx golden build");
    }
    const { version } = await rt.golden.build({
      setup: GOLDEN_SETUP,
      smoke: GOLDEN_SMOKE,
      envs: opts.envs,
      labels: { [WSP_LABEL]: "1", [DOCTOR_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
    });
    return version.snapshotId;
  };

  try {
    io.log("doctor: proving the reach loop against one live machine");

    await timings.time("durable goldens", () => promoteGoldens(rt, io), note => note);
    await timings.time("snapshot storage", () => cleanOrphans(rt, io, opts.yes === true, opts.statePath), note => note);

    let golden = "";
    const head = goldenHead(await rt.golden.get());
    if (head) {
      golden = head.snapshotId;
      timings.add("golden image", 0, `reused v${head.version} (${golden})`);
    } else {
      golden = await timings.time("golden image", buildGolden, id => `built fresh (${id})`);
    }

    const view = await timings.time(
      "fork workspace",
      async () => {
        const spec = {
          golden,
          name: `doctor-${Date.now().toString(36)}`,
          ...(opts.envs !== undefined ? { envs: opts.envs } : {}),
          labels: { [WSP_LABEL]: "1", [DOCTOR_LABEL]: "1", [CREATED_AT_LABEL]: new Date().toISOString() },
        };
        try {
          return await rt.workspaces.create(spec);
        } catch (e) {
          if (!isMissing(e)) throw e;
          io.log("golden snapshot is gone; rebuilding");
          const rebuilt = await buildGolden();
          return rt.workspaces.create({ ...spec, golden: rebuilt });
        }
      },
      w => `machine ${w.machineId.slice(0, 24)}…`,
    );
    workspaceId = view.id;
    const machine = await rt.backend.get(view.machineId);

    const { token } = await timings.time(
      "deploy daemon",
      () => deployDaemon(machine, opts.daemonDir !== undefined ? { daemonDir: opts.daemonDir } : {}),
      r => `node ${r.node}: tar upload + npm install (node-pty compile) + start on 0.0.0.0:7070`,
    );

    if (!machine.previewUrl) {
      throw new Error("this backend mints no preview URLs (capabilities.previewUrls=false); doctor needs one");
    }
    const reach = await timings.time(
      "mint previewUrl",
      () => machine.previewUrl!(DAEMON_PORT),
      r => `expires in ${Math.round((r.expiresAt - Date.now()) / 60_000)}min, host ${new URL(r.url).host}`,
    );

    socket = await timings.time(
      "ws connect + first op",
      () =>
        connectDaemonSocket({
          url: reach.url,
          token,
          onEvent: e => {
            for (const l of eventListeners) l(e);
          },
        }),
      () => "TLS + upgrade + authed manifest.get through the preview edge",
    );

    const beatTarget = 3;
    await timings.time(
      `heartbeats (${beatTarget} x 10s)`,
      async () => {
        const s = socket!;
        const start = Date.now();
        while (s.beats < beatTarget) {
          if (!s.open) throw new Error("socket died between heartbeats (idle sweep won)");
          if (Date.now() - start > 60_000) throw new Error("heartbeats stalled");
          await new Promise(r => setTimeout(r, 250));
        }
      },
      () => "socket alive past the ~30s idle sweep",
    );

    await timings.time(
      "inbox round trip",
      async () => {
        const s = socket!;
        const got = new Promise<void>((resolve, reject) => {
          const t = setTimeout(() => reject(new Error("no inbox.file event in 20s")), 20_000);
          eventListeners.push(e => {
            if (e["type"] === "inbox.file") {
              clearTimeout(t);
              resolve();
            }
          });
        });
        await s.op("inbox.watch");
        await rt.workspaces.exec(workspaceId!, "echo doctor > /root/inbox/doctor-ping.txt");
        await got;
      },
      () => "REST touch -> inbox.file over the preview socket (~2s watcher quiet window)",
    );

    socket.close();
    await timings.time(
      "kill + verify zero",
      async () => {
        await rt.workspaces.delete(workspaceId!);
        workspaceId = undefined;
        return verifyNoneLeft(rt.backend, await rt.owner(), io.log);
      },
      note => note,
    );
  } catch (e) {
    failed = e instanceof Error ? e.message : String(e);
    socket?.close();
    if (workspaceId !== undefined) {
      await rt.workspaces.delete(workspaceId).catch(() => {});
    }
  }

  timings.print(io.log);
  if (failed !== undefined) {
    io.error(`\nDOCTOR FAIL: ${failed}`);
    return 1;
  }
  io.log("\nDOCTOR PASS: fork, daemon, previewUrl, heartbeats, inbox, teardown all live.");
  return 0;
}
