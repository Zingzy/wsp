// SPDX-License-Identifier: AGPL-3.0-only
// wsp doctor: proves the whole reach path against one live machine and prints
// a timing table. fork -> deploy daemon -> previewUrl -> heartbeat client ->
// inbox round trip -> kill, with a check at the end that this host left none.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_CONFIG_DIR, CURL_NET, GOLDEN_SETUP, GOLDEN_SMOKE, NODE_RELEASES } from "@wsp/catalog";
import { CREATED_AT_LABEL, DAEMON_PORT, DOCTOR_LABEL, EXEC_ENV, GUEST_SUPERVISOR_PATH, GUEST_USER_ENV, OWNER_LABEL, TOOLS_PATH, WSP_LABEL, isMissing, isReserved, landBytes, whoseMachine, type DaemonSupervisor, type Machine, type MachineBackend } from "@wsp/engine";
import { DAEMON_MEMORY_MAX_PERCENT, DAEMON_NICE, DAEMON_OOM_SCORE_ADJ, GUEST_DAEMON_DIR, LOOPBACK, NO_SNAPSHOT_LISTING, NO_TEMPLATES_LINE, THIS_COMPUTER, isLocalWorkspace, otherHostsMachinesLine, templateRecordedLine, templateSkippedLine, type SnapshotStorage } from "@wsp/protocol";
import { goldenHead, writeDaemonTokenScript, type AccountOrphans, type GoldenVersion, type Runtime } from "@wsp/runtime";
import WebSocket from "ws";
import { assetDir, assetName, assetProof } from "./assets.js";
import { describeDeleted, describeOrphanOffer, describeOrphans, describeStorage } from "./storage.js";
import type { CliIO } from "./cli.js";

const execFileAsync = promisify(execFile);

// --- daemon bundle --------------------------------------------------------

// Runs inside the daemon dir. Loopback binds are unreachable through the
// preview edge (it dials eth0), so 0.0.0.0 is the whole point of this file.
// PATH is set before the daemon loads, never inherited: a relaunch from the
// guest's side arrives with a bare one (measured after an OOM kill, 2026-09-06).
// The killer's score and the nice value are written here, on the daemon's own
// pid, so every road that starts the daemon gives them; a start that may not
// write one (not root, or no Linux /proc) says so in the log and runs on.
export const START_MJS = `import { writeFileSync } from "node:fs";
import { setPriority } from "node:os";
process.env.PATH = ${JSON.stringify(TOOLS_PATH)};
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
const d = await startDaemon({ host: "0.0.0.0", openSocketPath: OPEN_SOCKET_PATH });
console.log(\`wsp-daemon listening on 0.0.0.0:\${d.port}\`);
`;

// Mirror @wsp/daemon's relay constants: importing the package here would pull
// node-pty into the host and the desktop bundle. The shim posts to the socket
// start.mjs opens; the daemon's own tests pin the script against its copy.
export const OPEN_SHIM_PATH = "/usr/local/bin/wsp-open";
const OPEN_SOCKET_PATH = "/root/.wsp/open.sock";
export const OPEN_SHIM_SCRIPT = `#!/bin/sh
[ "$#" -ge 1 ] || exit 0
printf '%s' "$1" | curl -s -m 1 -o /dev/null --unix-socket ${OPEN_SOCKET_PATH} -X POST --data-binary @- http://wsp/open >/dev/null 2>&1
exit 0
`;

/** Lay out an installable copy of the daemon: its dist build, a start script,
 * and a package.json whose dependency pins mirror the daemon's (node-pty has
 * no linux prebuilds, so the guest's npm install compiles it, ~5s). */
export async function stageDaemonBundle(stageDir: string, daemonDir = assetDir("daemon"), cliDir = assetDir("cli")): Promise<void> {
  const daemonPkg = JSON.parse(readFileSync(join(daemonDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  // Read before anything is copied: an asset folder that was never built is named here, in the words the asset
  // table gives it, rather than as a raw copy failure halfway through a bundle.
  for (const [kind, from] of [["daemon", daemonDir] as const, ["cli", cliDir] as const]) {
    const proof = join(from, assetProof(kind));
    if (!existsSync(proof)) throw new Error(`${assetName(kind)} missing: ${proof}`);
  }
  mkdirSync(stageDir, { recursive: true });
  cpSync(join(daemonDir, "dist"), join(stageDir, "dist"), { recursive: true });
  // The wsp command rides with the daemon so every machine that has one has wsp at GUEST_WSP_BIN, with no install
  // of its own and nothing on the golden: it is what a turn's own agent runs to reach back into this host.
  cpSync(cliDir, join(stageDir, "wsp"), { recursive: true });
  writeFileSync(join(stageDir, "start.mjs"), START_MJS);
  writeFileSync(join(stageDir, "wsp-open"), OPEN_SHIM_SCRIPT, { mode: 0o755 });
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

function nodeBootstrap(): string {
  const v = GUEST_NODE.version;
  return [
    CURL_NET,
    "if ! command -v node >/dev/null 2>&1; then",
    '  arch="$(uname -m)"',
    '  case "$arch" in',
    `    x86_64) pkg=node-v${v}-linux-x64.tar.gz sha=${GUEST_NODE.sha256.x86_64} ;;`,
    `    aarch64) pkg=node-v${v}-linux-arm64.tar.gz sha=${GUEST_NODE.sha256.aarch64} ;;`,
    '    *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
    "  esac",
    `  curl -o "/tmp/$pkg" "https://nodejs.org/dist/v${v}/$pkg"`,
    '  echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
    '  tar -xzf "/tmp/$pkg" -C /usr/local --strip-components=1',
    '  rm -f "/tmp/$pkg"',
    "fi",
    // A Node under /usr/local carries its headers, so node-pty compiles against them instead of downloading a set.
    'case "$(command -v node)" in /usr/local/bin/node) export npm_config_nodedir=/usr/local ;; esac',
  ].join("\n");
}

/** Vite reads this list of extra allowed hosts from the environment (8.2.2, measured 2026-09-05); without it every
 * dev server answers 403 through the preview edge. Next.js and webpack-dev-server have no env equivalent. */
export const VITE_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/** The supervisor's name for the daemon, the one string the unit file, the stop, the start and the log read. */
export const DAEMON_UNIT = "wsp-daemon.service";
export const DAEMON_UNIT_PATH = `/etc/systemd/system/${DAEMON_UNIT}`;

/** Where a guest with no service manager keeps the daemon's output, and the size the supervisor truncates it at.
 * A container has no journal, and nothing else on it would bound a file. */
export const DAEMON_LOG_PATH = "/var/log/wsp-daemon.log";
export const DAEMON_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Where a supervisor records its own pid, so a deploy knows whether one is already watching the daemon, and where
 * it records the daemon's, which is how a deploy stops the daemon on a guest with no socket tools. */
export const DAEMON_SUPERVISOR_PID_PATH = "/root/wsp-daemon/supervise.pid";
export const DAEMON_PID_PATH = "/root/wsp-daemon/daemon.pid";

/** What the daemon has printed lately, for a deploy that has to say why the port never came up. Under a service
 * manager it is the journal, which rotates itself against a cap it states at boot (395 MB on a 20 GB guest,
 * measured 2026-09-08); the redirect this replaced truncated the file on every deploy, and an appended one under
 * Restart=always with no start limit has no end. A guest with no journal reads the file its supervisor bounds. */
export const daemonLogCommand = (lines = 50, supervisor: DaemonSupervisor = "systemd"): string =>
  supervisor === "entrypoint" ? `tail -n ${lines} ${DAEMON_LOG_PATH}` : `journalctl -u ${DAEMON_UNIT} -n ${lines} --no-pager`;

/** The script that keeps the daemon running on a guest with no service manager: the machine's own boot runs it, so
 * a fork of a sealed image starts its daemon with nobody dialling in, and a daemon the kernel's memory killer took
 * comes back a second later. It states its environment rather than inheriting one, the way the unit does: a boot
 * hands it nothing. It never execs the daemon, so the loop keeps control of the restart; the container's PID 1
 * reaps what the daemon leaves behind. */
export function daemonSupervisorScript(previewHostSuffix?: string): string {
  return [
    "#!/bin/sh",
    `echo $$ > ${DAEMON_SUPERVISOR_PID_PATH}`,
    `export PATH=${TOOLS_PATH}`,
    ...Object.entries(GUEST_USER_ENV).map(([name, value]) => `export ${name}=${value}`),
    ...(previewHostSuffix !== undefined ? [`export ${VITE_ALLOWED_HOSTS_ENV}='${previewHostSuffix}'`] : []),
    "cd /root/wsp-daemon",
    "while :; do",
    `  [ -f ${DAEMON_LOG_PATH} ] && [ "$(wc -c < ${DAEMON_LOG_PATH})" -gt ${DAEMON_LOG_MAX_BYTES} ] && : > ${DAEMON_LOG_PATH}`,
    `  node /root/wsp-daemon/start.mjs >> ${DAEMON_LOG_PATH} 2>&1 &`,
    // The daemon's own pid, written here because a container ships no socket tools: it is how a deploy stops the
    // daemon it is replacing, and the supervisor puts the new one up a second later.
    `  echo $! > ${DAEMON_PID_PATH}`,
    `  wait $!`,
    "  sleep 1",
    "done",
    "",
  ].join("\n");
}

/** The unit the daemon runs under. Until 2026-09-08 it was started with setsid over the provider's exec and had no
 * supervisor at all: the kernel's memory killer took one and the machine sat with no daemon for five hours while
 * its turns, which go over that same exec, kept running. Restart=always is the whole point of the file, so the
 * start rate limit that would give up after five restarts is off. OOMPolicy=continue keeps a killed child (a test
 * run under a terminal) from taking the daemon with it, which systemd's default of stop would do. MemoryMax is a
 * share of the machine, not a figure, because every terminal the daemon opens sits in its cgroup. Output goes to
 * the journal, the one store on the guest that bounds itself. The environment is stated here rather than
 * inherited: a restart at boot or after a kill inherits nothing from the exec that deployed the daemon. */
export function daemonUnit(previewHostSuffix?: string): string {
  return [
    "[Unit]",
    "Description=wsp daemon",
    "After=network.target",
    "StartLimitIntervalSec=0",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${GUEST_DAEMON_DIR}`,
    `Environment=PATH=${TOOLS_PATH}`,
    ...Object.entries(GUEST_USER_ENV).map(([name, value]) => `Environment=${name}=${value}`),
    ...(previewHostSuffix !== undefined ? [`Environment=${VITE_ALLOWED_HOSTS_ENV}=${previewHostSuffix}`] : []),
    // Through sh so node is found on the unit's PATH: a machine that shipped its own node keeps it where it is.
    `ExecStart=/bin/sh -c 'exec node ${GUEST_DAEMON_DIR}/start.mjs'`,
    "Restart=always",
    "RestartSec=1",
    `MemoryMax=${DAEMON_MEMORY_MAX_PERCENT}%`,
    "OOMPolicy=continue",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Stops whatever holds the daemon's port before the new daemon starts: an update lands on a machine whose daemon
 * is running, and a second bind would fail while the port check still read the old one as up. The unit goes first,
 * since an explicit stop is the only thing Restart=always yields to and killing the pid under it would have
 * systemd put the old daemon straight back. What is left is a daemon from before the unit: its pid comes from the
 * socket table, the one place the guest names it (nothing else may bind the port; the machine context says so).
 * A fresh machine has neither and skips through. */
export function stopDaemonScript(): string {
  return [
    `systemctl stop ${DAEMON_UNIT} 2>/dev/null || true`,
    `old="$(ss -ltnpH 'sport = :${DAEMON_PORT}' | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n 1)"`,
    'if [ -n "$old" ]; then',
    '  kill "$old" 2>/dev/null || true',
    "  for _ in $(seq 20); do",
    `    ss -ltnH 'sport = :${DAEMON_PORT}' | grep -q . || break`,
    "    sleep 0.25",
    "  done",
    `  ss -ltnH 'sport = :${DAEMON_PORT}' | grep -q . && kill -9 "$old" 2>/dev/null && sleep 0.5`,
    '  echo "DAEMON_STOPPED $old"',
    "fi",
  ].join("\n");
}

/** What the daemon is left running under on this guest: its service manager, or the machine's own boot on a guest
 * that has none. The two roads share every line but the last few, so a bundle, a token and a shim land the same way
 * whichever supervises. */
const unitRoad = (previewHostSuffix: string | undefined): string[] => [
  `cat > ${DAEMON_UNIT_PATH} <<'WSP_UNIT'\n${daemonUnit(previewHostSuffix)}WSP_UNIT`,
  "systemctl daemon-reload",
  // Enabled as well as started: a machine that reboots or comes back from a snapshot brings the daemon with it.
  `systemctl enable ${DAEMON_UNIT}`,
  `systemctl restart ${DAEMON_UNIT}`,
];

/** The supervisor road: the script the machine's boot runs goes on disk, and the daemon is started here only when
 * nothing is already watching it. On a machine booted from a sealed image the supervisor is the machine's own first
 * process; killing the daemon it watches is what puts the new bundle in, and starting a second one would fight it. */
const supervisorRoad = (previewHostSuffix: string | undefined): string[] => [
  `cat > ${GUEST_SUPERVISOR_PATH} <<'WSP_SUPERVISOR'\n${daemonSupervisorScript(previewHostSuffix)}WSP_SUPERVISOR`,
  `chmod 0755 ${GUEST_SUPERVISOR_PATH}`,
  // The daemon being replaced is stopped by the pid the supervisor recorded: a container image ships no socket
  // tools, so nothing here can read the port's holder the way the unit road does.
  // `|| true` on both reads: the script runs under set -e, where an assignment whose command substitution fails
  // ends it, and a machine that never had a daemon has neither file (a live deploy died here, 2026-09-11).
  `old="$(cat ${DAEMON_PID_PATH} 2>/dev/null || true)"`,
  'if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old" 2>/dev/null || true; echo "DAEMON_STOPPED $old"; fi',
  `sup="$(cat ${DAEMON_SUPERVISOR_PID_PATH} 2>/dev/null || true)"`,
  'if [ -n "$sup" ] && kill -0 "$sup" 2>/dev/null; then',
  '  echo "DAEMON_SUPERVISED $sup"',
  "else",
  `  setsid nohup ${GUEST_SUPERVISOR_PATH} >> ${DAEMON_LOG_PATH} 2>&1 &`,
  "fi",
];

/** Whether the daemon is serving, in the words the guest can answer in: the socket table where the guest has one,
 * and bash's own network road on a container image, which ships neither ss nor curl. */
const portCheck = (supervisor: DaemonSupervisor): string =>
  supervisor === "entrypoint" ? `(exec 3<>/dev/tcp/${LOOPBACK}/${DAEMON_PORT}) 2>/dev/null` : `ss -ltnH 'sport = :${DAEMON_PORT}' | grep -q .`;

/** The in-guest install+start sequence. `previewHostSuffix` (".preview.example.com") is what dev servers must
 * accept to answer through the edge; absent on a backend without preview URLs. The daemon is left running under
 * whatever supervises it, so nothing here has to outlive the exec. */
export function deployScript(token: string, previewHostSuffix?: string, supervisor: DaemonSupervisor = "systemd"): string {
  return [
    "set -e",
    'export PATH="/usr/local/bin:$PATH"',
    // An unsupervised daemon is what this deploy exists to stop shipping: a guest with a service manager registers a
    // unit with it, one without gets the supervisor its own boot runs, and a guest that can do neither says so.
    ...(supervisor === "systemd" ? ["command -v systemctl >/dev/null || { echo NO_SYSTEMD; false; }"] : []),
    // The exec running this carries PATH and nothing else (measured 2026-09-05), and npm and the bundle's build
    // read the guest's home. What the daemon itself hands to every pty comes from its unit, not from here.
    EXEC_ENV,
    `mkdir -p ${GUEST_DAEMON_DIR} /root/inbox`,
    `tar -xzf ${GUEST_DAEMON_DIR}.tgz -C ${GUEST_DAEMON_DIR}`,
    nodeBootstrap(),
    'echo "NODE_VERSION $(node --version)"',
    `cd ${GUEST_DAEMON_DIR}`,
    "npm install --omit=dev --no-audit --no-fund > /tmp/wsp-npm.log 2>&1 || { tail -3 /tmp/wsp-npm.log; echo NPM_FAIL; false; }",
    `rm -rf ${GUEST_DAEMON_DIR}/node_modules/node-pty/prebuilds`,
    // Both names: only some tools read BROWSER; the rest exec xdg-open by name, and /usr/local/bin is first on PATH.
    // BROWSER itself is set by the daemon for its ptys, by profile.d for login shells, and in a fork's envs only
    // when its golden was sealed with the shim (claudeEnvs), never on a machine that may lack the file.
    `install -m 0755 ${GUEST_DAEMON_DIR}/wsp-open ${OPEN_SHIM_PATH}`,
    `ln -sfn ${OPEN_SHIM_PATH} /usr/local/bin/xdg-open`,
    `mkdir -p /etc/profile.d && printf 'export BROWSER=%s\\nunset DISPLAY\\n' ${OPEN_SHIM_PATH} > /etc/profile.d/wsp-open.sh`,
    // Login shells read it from profile.d; the daemon's ptys inherit it from the daemon, exported before it starts.
    ...(previewHostSuffix !== undefined
      ? [
          `printf 'export ${VITE_ALLOWED_HOSTS_ENV}=%s\\n' '${previewHostSuffix}' > /etc/profile.d/wsp-preview.sh`,
          `export ${VITE_ALLOWED_HOSTS_ENV}='${previewHostSuffix}'`,
        ]
      : []),
    writeDaemonTokenScript(token),
    ...(supervisor === "systemd" ? [stopDaemonScript(), ...unitRoad(previewHostSuffix)] : supervisorRoad(previewHostSuffix)),
    // A service manager restarts the daemon at once; a supervisor that was already watching sleeps a second first,
    // so that road waits longer for the port than a unit's does.
    `for _ in $(seq ${supervisor === "entrypoint" ? 40 : 20}); do ${portCheck(supervisor)} && break; sleep 0.25; done`,
    supervisor === "entrypoint"
      ? `${portCheck(supervisor)} && echo DAEMON_UP || { ${daemonLogCommand(50, supervisor)}; echo DAEMON_DOWN; }`
      : `ss -ltn | grep -q ${DAEMON_PORT} && echo DAEMON_UP || { ${daemonLogCommand()}; echo DAEMON_DOWN; }`,
  ].join("\n");
}

/** The preview host with its machine-and-port label cut off ("<id>-7070.preview.example.com" gives
 * ".preview.example.com"): the suffix every port on this machine is served under, read off the backend
 * rather than assumed. Undefined on a backend with no route to a guest port, on a host with no dot to cut at, and
 * on a route to an address rather than a name, which is what a machine reached at a published port answers with:
 * an allowlist entry is for the name a browser would ask for. */
export async function previewHostSuffix(machine: Machine): Promise<string | undefined> {
  if (machine.previewUrl === undefined) return undefined;
  const { hostname } = new URL((await machine.previewUrl(DAEMON_PORT)).url);
  if (isIP(hostname) !== 0) return undefined;
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
 * with (the runtime replaces it the first time a client reaches the daemon) and the Node version the daemon runs on. */
export async function deployDaemon(
  machine: Machine,
  opts: { token?: string; daemonDir?: string; cliDir?: string } = {},
): Promise<{ token: string; node: string }> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "wsp-daemon-bundle-"));
  const tgz = `${stage}.tgz`;
  try {
    await stageDaemonBundle(stage, opts.daemonDir, opts.cliDir);
    await packBundle(stage, tgz);
    await landBytes(machine, `${GUEST_DAEMON_DIR}.tgz`, readFileSync(tgz));

    const suffix = await previewHostSuffix(machine);
    const res = await machine.run(deployScript(token, suffix, machine.daemonSupervisor ?? "systemd"), { deadlineMs: 180_000 });
    if (res.exitCode !== 0 || !res.stdout.includes("DAEMON_UP")) {
      throw new Error(`daemon deploy failed: ${res.stdout.slice(-300)} ${res.stderr.slice(-200)}`);
    }
    const node = /NODE_VERSION (v\S+)/.exec(res.stdout)?.[1] ?? "unknown";
    return { token, node };
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
