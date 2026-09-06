// SPDX-License-Identifier: AGPL-3.0-only
// wsp doctor: proves the whole reach path against one live machine and prints
// a timing table. fork -> deploy daemon -> previewUrl -> heartbeat client ->
// inbox round trip -> kill, with a zero-machines check at the end.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CLAUDE_CONFIG_DIR, GOLDEN_SETUP, GOLDEN_SMOKE, NODE_RELEASES } from "@wsp/catalog";
import { DAEMON_PORT, TOOLS_PATH, type Machine } from "@wsp/engine";
import { goldenHead, writeDaemonTokenScript, type GoldenVersion, type Runtime } from "@wsp/runtime";
import WebSocket from "ws";
import type { CliIO } from "./cli.js";

const execFileAsync = promisify(execFile);

// --- daemon bundle --------------------------------------------------------

// Runs inside /root/wsp-daemon. Loopback binds are unreachable through the
// preview edge (it dials eth0), so 0.0.0.0 is the whole point of this file.
const START_MJS = `import { OPEN_SOCKET_PATH, startDaemon } from "./dist/index.js";
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

function resolveDaemonDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@wsp/daemon/package.json"));
}

/** Lay out an installable copy of the daemon: its dist build, a start script,
 * and a package.json whose dependency pins mirror the daemon's (node-pty has
 * no linux prebuilds, so the guest's npm install compiles it, ~5s). */
export async function stageDaemonBundle(stageDir: string, daemonDir = resolveDaemonDir()): Promise<void> {
  const daemonPkg = JSON.parse(readFileSync(join(daemonDir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  mkdirSync(stageDir, { recursive: true });
  cpSync(join(daemonDir, "dist"), join(stageDir, "dist"), { recursive: true });
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

/** Desktop templates ship no node; the sandbox template carries its own and
 * keeps it (an agent that needs a newer one asks for it in the import). */
export const GUEST_NODE = NODE_RELEASES[22];

function nodeBootstrap(): string {
  const v = GUEST_NODE.version;
  return [
    "if ! command -v node >/dev/null 2>&1; then",
    '  arch="$(uname -m)"',
    '  case "$arch" in',
    `    x86_64) pkg=node-v${v}-linux-x64.tar.gz sha=${GUEST_NODE.sha256.x86_64} ;;`,
    `    aarch64) pkg=node-v${v}-linux-arm64.tar.gz sha=${GUEST_NODE.sha256.aarch64} ;;`,
    '    *) echo "unsupported arch: $arch" >&2; exit 1 ;;',
    "  esac",
    `  curl -fsSL -o "/tmp/$pkg" "https://nodejs.org/dist/v${v}/$pkg"`,
    '  echo "$sha  /tmp/$pkg" | sha256sum -c - >/dev/null',
    '  tar -xzf "/tmp/$pkg" -C /usr/local --strip-components=1',
    '  rm -f "/tmp/$pkg"',
    "  export npm_config_nodedir=/usr/local",
    "fi",
  ].join("\n");
}

/** Vite reads this list of extra allowed hosts from the environment (8.2.2, measured 2026-09-05); without it every
 * dev server answers 403 through the preview edge. Next.js and webpack-dev-server have no env equivalent. */
export const VITE_ALLOWED_HOSTS_ENV = "__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS";

/** The in-guest install+start sequence. The setsid line ends in a bare `&`
 * with the sleep on the same statement: `&` already terminates a command, so
 * joining it with `;` would be a bash syntax error (a live run died on it).
 * `previewHostSuffix` (".preview.example.com") is what dev servers must accept
 * to answer through the edge; absent on a backend without preview URLs. */
export function deployScript(token: string, previewHostSuffix?: string): string {
  return [
    "set -e",
    'export PATH="/usr/local/bin:$PATH"',
    // The daemon started below hands its environment to every pty and harness launch, and the exec running
    // this carries PATH and nothing else (measured 2026-09-05).
    "export HOME=/root USER=root",
    "mkdir -p /root/wsp-daemon /root/inbox",
    "tar -xzf /root/wsp-daemon.tgz -C /root/wsp-daemon",
    nodeBootstrap(),
    'echo "NODE_VERSION $(node --version)"',
    "cd /root/wsp-daemon",
    "npm install --omit=dev --no-audit --no-fund > /tmp/wsp-npm.log 2>&1 || { tail -3 /tmp/wsp-npm.log; echo NPM_FAIL; false; }",
    "rm -rf /root/.npm /root/.cache/node-gyp /root/wsp-daemon/node_modules/node-pty/prebuilds",
    // Both names: only some tools read BROWSER; the rest exec xdg-open by name, and /usr/local/bin is first on PATH.
    // BROWSER itself is set by the daemon for its ptys, by profile.d for login shells, and in a fork's envs only
    // when its golden was sealed with the shim (claudeEnvs), never on a machine that may lack the file.
    `install -m 0755 /root/wsp-daemon/wsp-open ${OPEN_SHIM_PATH}`,
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
    "setsid nohup node /root/wsp-daemon/start.mjs > /root/daemon.log 2>&1 < /dev/null & sleep 1.5",
    "ss -ltn | grep -q 7070 && echo DAEMON_UP || { cat /root/daemon.log; echo DAEMON_DOWN; }",
  ].join("\n");
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

/** Upload and start the daemon on a machine; returns the token it starts with
 * (the runtime replaces it the first time a client reaches the daemon) and the
 * Node version the daemon runs on. */
export async function deployDaemon(
  machine: Machine,
  opts: { token?: string; daemonDir?: string } = {},
): Promise<{ token: string; node: string }> {
  const token = opts.token ?? randomBytes(24).toString("hex");
  const stage = mkdtempSync(join(tmpdir(), "wsp-daemon-bundle-"));
  const tgz = `${stage}.tgz`;
  try {
    await stageDaemonBundle(stage, opts.daemonDir);
    await packBundle(stage, tgz);
    const putUrl = await machine.uploadUrl("/root/wsp-daemon.tgz");
    const put = await fetch(putUrl, { method: "PUT", body: readFileSync(tgz) });
    if (!put.ok) throw new Error(`bundle upload failed: HTTP ${put.status}`);

    const suffix = await previewHostSuffix(machine);
    const res = await machine.run(deployScript(token, suffix), { deadlineMs: 180_000 });
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

/** Sleeping experiments on the account carry a poc label (ttl-test, p1, ...): never touch them. */
export function isReserved(labels: Record<string, string>): boolean {
  return "poc" in labels;
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

export interface DoctorOptions {
  /** Envs baked into golden builds and forks (claude credentials). */
  envs?: Record<string, string>;
  daemonDir?: string;
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
      cpu: 2,
      memMb: 4096,
      envs: opts.envs,
      labels: { wsp: "1", "wsp-doctor": "1", createdAt: new Date().toISOString() },
    });
    return version.snapshotId;
  };

  try {
    io.log("doctor: proving the reach loop against one live machine");

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
          labels: { wsp: "1", "wsp-doctor": "1", createdAt: new Date().toISOString() },
        };
        try {
          return await rt.workspaces.create(spec);
        } catch (e) {
          if ((e as { kind?: string }).kind !== "missing") throw e;
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
        const leftover = (await rt.backend.list()).filter(m => !isReserved(m.labels) && m.state !== "gone");
        if (leftover.length > 0) throw new Error(`machines still up: ${leftover.map(m => m.id).join(", ")}`);
      },
      () => "workspace deleted, no machines left on the account",
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
