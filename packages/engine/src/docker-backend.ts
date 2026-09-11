// SPDX-License-Identifier: AGPL-3.0-only
// The backend for machines on a Docker daemon: this computer's own, or one on
// a box reached over ssh. It sits behind the same MachineBackend seam Solari
// does, so nothing above the engine learns which it holds. A golden is an
// image, a fork is a container from it, a snapshot is a commit, and a nap is
// the freezer cgroup. What a container cannot do is said in the capabilities
// rather than worked around: no live clone, no signed URLs, no public port
// routes, and no memory in a snapshot, so a fork boots cold.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { connect as netConnect } from "node:net";
import { join, posix } from "node:path";
import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { Capabilities } from "@wsp/protocol";
import { classify, isMissing, type WspError } from "./errors.js";
import { INLINE_EXEC_MS, execDetached } from "./exec-detached.js";
import { EXEC_ENV } from "./golden-import.js";
import { WSP_LABEL } from "./labels.js";
import type { BackendPricing, DaemonSupervisor, ExecResult, Lifecycle, Machine, MachineBackend, MachineKind, MachineLife, MachineShape, MachineSpec, MachineState, PreviewReach, RunOptions, SnapshotRow, SnapshotStoragePricing, TemplateRow } from "./machine.js";
import { DAEMON_PORT } from "./preview.js";
import { makeSshControlDir, SSH_CONTROL_PERSIST_S, sshControlPath } from "./ssh-backend.js";

/** How long a fetch of an image may take before the call is cut off: a base image is a few hundred megabytes over
 * whatever line the box has. */
export const PULL_MS = 600_000;

/** The Engine API version every call is made under. Docker 29 refuses a client below 1.44, and nothing here needs a
 * field newer than that, so the version is pinned rather than negotiated on every dial. */
export const DOCKER_API_VERSION = "v1.44";

/** The daemon's socket on a computer whose DOCKER_HOST names nothing. */
export const DOCKER_DEFAULT_SOCKET = "/var/run/docker.sock";

/** The image a builder boots from when nothing names one: the same long term release the goldens are built against
 * on every other provider. */
export const DOCKER_BASE_IMAGE = "ubuntu:24.04";

/** What a container's host name may be: the kernel takes 64 bytes and refuses the create outright above it. */
export const HOSTNAME_MAX = 63;

/** The repository every snapshot is committed under, and the prefix of every promoted template. */
export const DOCKER_REPO = "wsp";

/** The label a committed image carries the name it was taken under in, since an image's tags are not a name a
 * listing can be trusted to keep (a retag moves them). */
export const SNAPSHOT_LABEL = "wsp-snapshot";

/** Where a guest with no service manager keeps the script that keeps the daemon running. A container's boot runs it
 * when it is there, so a fork of a sealed image starts its daemon with nothing dialling in; the daemon deploy is
 * what writes it. */
export const GUEST_SUPERVISOR_PATH = "/root/wsp-daemon/supervise.sh";

/** Every wsp container boots this: the daemon's supervisor once an image carries one, else a process that holds the
 * container up so execs can reach it. A builder is created before any daemon exists, and the same command serves it
 * and every fork of the image it seals. */
export const DOCKER_BOOT_CMD: readonly string[] = [
  "/bin/sh",
  "-c",
  `if [ -x ${GUEST_SUPERVISOR_PATH} ]; then exec ${GUEST_SUPERVISOR_PATH}; fi\nexec sleep infinity`,
];

/** Nothing here is billed by anyone: the box is the person's own and the daemon charges nothing for an image. */
const NO_SNAPSHOT_STORAGE: SnapshotStoragePricing = { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" };

/** The sizes a fork may ask for. A container takes any figure the box can give, so these are the two shapes a
 * person picks between rather than a provider's clamp; both cost nothing. */
const SIZES: readonly { cpu: number; memMb: number }[] = [
  { cpu: 2, memMb: 4096 },
  { cpu: 4, memMb: 8192 },
];

export const DOCKER_PRICING: BackendPricing = {
  rateUsdPerHour: () => 0,
  defaultSize: SIZES[0]!,
  snapshotStorage: NO_SNAPSHOT_STORAGE,
};

/** The most of the box one machine's memory limit may name: a limit above what the box holds is a promise the box
 * cannot keep, and the first container to believe it takes the box's other containers down with it. Half leaves the
 * daemon, the person's own containers and the page cache the rest. */
export const BOX_MEMORY_SHARE = 0.5;

/** How a container's own status reads as a machine state. `removing` is folded into gone: the daemon has taken the
 * container and nothing will run on it again. */
const STATE_MAP: Record<string, MachineState> = {
  created: "starting",
  restarting: "starting",
  running: "running",
  paused: "paused",
  exited: "gone",
  dead: "gone",
  removing: "gone",
};

/** How a daemon is dialled. One road per kind and nothing else in this file knows the difference. */
export type DockerDial =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number; tls: boolean }
  | { kind: "ssh"; user: string; host: string; port: number };

/** The daemon a DOCKER_HOST word names. A bare word names this computer's own socket. The ssh road is the one the
 * docker CLI takes for a remote box: nothing is installed there beyond Docker and sshd, where a tcp dial would need
 * a certificate authority minted and a port opened. */
export function parseDockerHost(host: string | undefined): DockerDial {
  if (host === undefined || host === "") return { kind: "unix", path: DOCKER_DEFAULT_SOCKET };
  if (host.startsWith("unix://")) return { kind: "unix", path: host.slice("unix://".length) };
  if (host.startsWith("tcp://") || host.startsWith("ssh://")) {
    const url = new URL(host);
    if (url.protocol === "ssh:") {
      return { kind: "ssh", user: decodeURIComponent(url.username), host: url.hostname, port: Number(url.port) || 22 };
    }
    // 2376 is the port the docker daemon serves TLS on; 2375 is the plain one it warns about.
    const port = Number(url.port) || 2376;
    return { kind: "tcp", host: url.hostname, port, tls: port !== 2375 };
  }
  throw new Error(`${host} is not a Docker daemon this backend dials; name it as unix://, tcp:// or ssh://`);
}

/** The ssh client's argv for one dial. The daemon's socket is root on the box, so the connection carries the
 * person's own login and the daemon's own stdio road rather than a port anyone could reach. */
export function dockerSshArgs(dial: Extract<DockerDial, { kind: "ssh" }>, opts: { keyPath?: string; knownHostsPath?: string; controlDir?: string } = {}): string[] {
  return [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
    // Every call to the box's daemon is a dial of its own, and a turn's poll is three of them a second and a half:
    // without a master connection each one is a key exchange and a line in the box's auth log (measured on the
    // machines wsp reaches over ssh, which take the same three flags).
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${sshControlPath({ user: dial.user, host: dial.host, port: dial.port }, opts.controlDir)}`,
    "-o",
    `ControlPersist=${SSH_CONTROL_PERSIST_S}`,
    ...(opts.knownHostsPath !== undefined ? ["-o", `UserKnownHostsFile=${opts.knownHostsPath}`] : []),
    "-p",
    String(dial.port),
    ...(opts.keyPath !== undefined ? ["-i", opts.keyPath, "-o", "IdentitiesOnly=yes"] : []),
    dial.user === "" ? dial.host : `${dial.user}@${dial.host}`,
    "docker",
    "system",
    "dial-stdio",
  ];
}

/** What a request is carried over. A test hands its own; the roads below are the only ones that leave this process. */
export type DockerTransport = () => { options: RequestOptions; close?: () => void };

/** The one dialler for every kind of daemon: a socket on this computer, a TLS connection to a box's daemon port, or
 * the daemon's own stdio road through ssh, which is what the docker CLI takes for ssh:// and needs nothing on the
 * box but Docker and sshd. */
export function dockerTransport(dial: DockerDial, opts: { certPath?: string; keyPath?: string; knownHostsPath?: string } = {}): DockerTransport {
  if (dial.kind === "unix") return () => ({ options: { socketPath: dial.path } });
  if (dial.kind === "tcp") {
    const certs = dial.tls && opts.certPath !== undefined
      ? {
          ca: readFileSync(join(opts.certPath, "ca.pem")),
          cert: readFileSync(join(opts.certPath, "cert.pem")),
          key: readFileSync(join(opts.certPath, "key.pem")),
        }
      : {};
    return () => ({
      options: dial.tls
        ? { createConnection: () => tlsConnect({ host: dial.host, port: dial.port, ...certs }) as unknown as ReturnType<typeof netConnect> }
        : { host: dial.host, port: dial.port },
    });
  }
  return () => {
    const child = spawn("ssh", dockerSshArgs(dial, { ...opts, controlDir: makeSshControlDir() }), { stdio: ["pipe", "pipe", "pipe"] });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => {
      said = `${said}${chunk.toString("utf8")}`.slice(-500);
    });
    const socket = Duplex.from({ readable: child.stdout, writable: child.stdin });
    // The http client asks a socket for these; a duplex over a child process has no such knobs and needs none.
    Object.assign(socket, {
      setNoDelay: () => socket,
      setKeepAlive: () => socket,
      setTimeout: () => socket,
      ref: () => socket,
      unref: () => socket,
    });
    child.on("error", e => socket.destroy(e));
    child.on("exit", code => {
      if (code !== null && code !== 0) socket.destroy(new Error(`ssh to ${dial.host} ended (exit ${code})${said === "" ? "" : `: ${said.trim()}`}`));
    });
    return {
      options: { createConnection: () => socket as unknown as ReturnType<typeof netConnect> },
      close: () => child.kill(),
    };
  };
}

/** A container id or an image reference as it goes into a path. Nothing is escaped: the daemon's own client sends
 * `wsp/golden:template` whole, and an escaped slash or colon is read differently by its router. A reference
 * carrying anything that would end the path is refused here rather than sent. */
export function pathRef(ref: string): string {
  if (ref === "" || /[?#\s%]/.test(ref)) throw new Error(`${JSON.stringify(ref)} is not a name the Docker daemon can be asked about`);
  return ref;
}

function fail(e: WspError): never {
  throw Object.assign(new Error(e.message || `${e.kind} (${e.status})`), e);
}

interface RequestOpts {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** A tar for the archive road; it goes up as it is, with no JSON around it. */
  raw?: Buffer;
  timeoutMs?: number;
  /** The answer is a stream of JSON lines rather than one document: it comes back as the text it was. */
  lines?: boolean;
}

function queryString(query: Record<string, string | undefined> | undefined): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, v);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** One request to the daemon, answered with the response and its body. Non-2xx is read as the daemon's own message
 * and thrown as the engine's error kinds, so a container the daemon lost reads missing here as a machine the
 * provider lost does everywhere else. */
function call(transport: DockerTransport, method: string, path: string, opts: RequestOpts = {}): Promise<{ status: number; body: Buffer }> {
  const payload = opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), "utf8"));
  return new Promise((resolve, reject) => {
    const dialled = transport();
    let settled = false;
    const close = (): void => dialled.close?.();
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = httpRequest(
      {
        ...dialled.options,
        method,
        path: `/${DOCKER_API_VERSION}${path}${queryString(opts.query)}`,
        headers: {
          Host: "docker",
          ...(payload === undefined ? {} : { "Content-Type": opts.raw !== undefined ? "application/x-tar" : "application/json", "Content-Length": String(payload.length) }),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(() => {
          close();
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        }));
        res.on("error", (e: Error) => done(() => {
          close();
          reject(e);
        }));
      },
    );
    const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => {
      req.destroy(new Error(`the Docker daemon did not answer ${method} ${path} in ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    req.on("close", () => {
      if (timer !== undefined) clearTimeout(timer);
    });
    req.on("error", (e: Error) => done(() => {
      close();
      reject(e);
    }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** The same request with its answer read as JSON, and the daemon's refusal turned into the engine's error. */
async function json<T>(transport: DockerTransport, method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const { status, body } = await call(transport, method, path, opts);
  const text = body.toString("utf8");
  if (status < 200 || status >= 300) {
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch { /* the daemon answered something that is not JSON */ }
    fail(classify(status, { error: message }));
  }
  if (opts.lines === true) return text as T;
  return (text === "" ? {} : JSON.parse(text)) as T;
}

/** Docker's multiplexed stream: an eight byte header with the stream number and the payload length, then the
 * payload. A chunk boundary can land anywhere, so the frames are read off a running buffer. */
export function demux(stream: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let at = 0;
  while (at + 8 <= stream.length) {
    const which = stream[at];
    const size = stream.readUInt32BE(at + 4);
    const start = at + 8;
    const end = Math.min(start + size, stream.length);
    (which === 2 ? err : out).push(stream.subarray(start, end));
    at = start + size;
  }
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

/** One file as a tar the archive road takes: a ustar header and the bytes, padded to the block, then the two empty
 * blocks a reader stops at. Built here rather than by this computer's tar, whose extended headers the daemon
 * refuses (macOS writes com.apple.provenance as an xattr header and the extract fails on it). */
export function oneFileTar(name: string, bytes: Buffer, mode = 0o644): Buffer {
  // A ustar name field is 100 bytes with a NUL after it: a longer name would land under a shorter one, silently.
  if (Buffer.byteLength(name) > 99) throw new Error(`${name} is too long a name for one tar entry`);
  const header = Buffer.alloc(512);
  const put = (text: string, at: number, len: number): void => {
    header.write(text.slice(0, len - 1), at, "utf8");
  };
  put(name, 0, 100);
  put(mode.toString(8).padStart(7, "0"), 100, 8);
  put("0".padStart(7, "0"), 108, 8);
  put("0".padStart(7, "0"), 116, 8);
  put(bytes.length.toString(8).padStart(11, "0"), 124, 12);
  put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0"), 136, 12);
  header.write("        ", 148, 8, "utf8");
  header.write("0", 156, 1, "utf8");
  header.write("ustar", 257, 5, "utf8");
  header.write("00", 263, 2, "utf8");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, bytes, padding, Buffer.alloc(1024)]);
}

/** What a name may carry into an image tag: the daemon takes letters, digits, underscore, dot and hyphen, up to 128,
 * and refuses anything else. A golden's own name rides in it, so whatever else it holds is turned into a hyphen
 * rather than the commit failing at the daemon. */
export function imageTag(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[.-]+/, "");
  return (cleaned === "" ? "snapshot" : cleaned).slice(0, 128);
}

interface ContainerView {
  Id: string;
  Created?: string;
  State?: { Status?: string };
  Config?: { Labels?: Record<string, string> };
  HostConfig?: { Memory?: number; NanoCpus?: number };
  NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
}

interface ImageView {
  Id: string;
  RepoTags?: string[] | null;
  Size?: number;
  Created?: number;
  Labels?: Record<string, string> | null;
}

export interface DockerBackendOptions {
  /** The daemon to dial, as DOCKER_HOST words it; this computer's own socket when absent. */
  host?: string;
  /** Where the certificates for a tcp dial are, as DOCKER_CERT_PATH names it. */
  certPath?: string;
  /** The key an ssh dial logs in with; absent leaves ssh its own config and agent. */
  keyPath?: string;
  /** The file an ssh dial checks the box's key against; absent leaves ssh its own. */
  knownHostsPath?: string;
  /** The image a builder boots from when nothing names one. */
  baseImage?: string;
  /** How a request reaches the daemon; tests hand in their own. */
  transport?: DockerTransport;
}

export const DOCKER_LIFECYCLE: Lifecycle = {
  budgets: {
    // Unpause is synchronous, and a second freeze fixes nothing a first did not: a failed check goes straight to the rebuild.
    wakeAttempts: 1,
    daemonAnswersMs: 30_000,
  },
};

export class DockerBackend implements MachineBackend {
  readonly capabilities: Capabilities;
  readonly lifecycle = DOCKER_LIFECYCLE;
  readonly pricing = DOCKER_PRICING;
  /** A container boots from an image, and the same one serves both kinds: there is no desktop on this backend, and
   * a desktop machine's own stream has no meaning here. */
  readonly baseTemplates: Readonly<Record<MachineKind, string>>;

  private readonly transport: DockerTransport;
  private readonly dial: DockerDial;
  /** Whether the daemon runs on the computer this host runs on. A container's published port lands on the daemon's
   * own loopback, so on this computer the host can dial it and on a box it cannot without a forward. Read once,
   * here, and every road that turns on it reads this. */
  private readonly onThisComputer: boolean;

  constructor(opts: DockerBackendOptions = {}) {
    this.dial = parseDockerHost(opts.host);
    this.transport = opts.transport ?? dockerTransport(this.dial, {
      ...(opts.certPath !== undefined ? { certPath: opts.certPath } : {}),
      ...(opts.keyPath !== undefined ? { keyPath: opts.keyPath } : {}),
      ...(opts.knownHostsPath !== undefined ? { knownHostsPath: opts.knownHostsPath } : {}),
    });
    this.onThisComputer = this.dial.kind === "unix";
    const image = opts.baseImage ?? DOCKER_BASE_IMAGE;
    this.baseTemplates = { sandbox: image, desktop: image };
    this.capabilities = {
      liveCloneForks: false, // a commit holds no memory, so a fork boots cold and wsp starts the agents again
      pauseMode: "memory", // the freezer cgroup keeps the processes and every byte they hold: a nap saves CPU, never memory
      resize: false,
      previewUrls: false, // a published port is bare TCP with no token and no expiry, so nothing public is minted
      signedUrls: false, // bytes go through the archive API instead
      containers: false, // a container inside a container needs a daemon of its own, which nothing here installs
      // The daemon's port is published on the box's loopback, which this host dials when the box is this computer,
      // so a sign-in a guest opens reaches the person's browser. A daemon on another box needs a forward first.
      callbackRelay: this.onThisComputer,
      snapshotListing: true,
      templates: true,
      kept: false, // a fork wsp made and can rebuild: a turn that wrecks its disk costs nothing else
      sizes: SIZES.map(size => ({ ...size, rateUsdPerHour: 0 })),
    };
  }

  /** One request to the daemon this backend dials. */
  request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
    return json<T>(this.transport, method, path, opts);
  }

  /** The stream of one exec, read whole: the daemon holds the connection open until the command ends. */
  execStream(execId: string, timeoutMs: number): Promise<Buffer> {
    return call(this.transport, "POST", `/exec/${pathRef(execId)}/start`, { body: { Detach: false, Tty: false }, timeoutMs }).then(r => {
      if (r.status < 200 || r.status >= 300) fail(classify(r.status, { error: r.body.toString("utf8") }));
      return r.body;
    });
  }

  /** Fetches an image the box does not have. A create names a registry reference on the first build of a golden, and
   * a box that has never run wsp holds none of them; a snapshot's own id is never fetched, since an image the box
   * lost is not one any registry has. */
  async pull(reference: string): Promise<void> {
    const cut = reference.lastIndexOf(":");
    const tagged = cut > 0 && !reference.slice(cut + 1).includes("/");
    const answer = await this.request<unknown>("POST", "/images/create", {
      query: { fromImage: tagged ? reference.slice(0, cut) : reference, ...(tagged ? { tag: reference.slice(cut + 1) } : {}) },
      timeoutMs: PULL_MS,
      // The daemon streams its progress as JSON lines and answers 200 even for a reference it could not fetch, so
      // the stream itself is read for the refusal.
      lines: true,
    });
    const said = String(answer);
    if (/"errorDetail"|"error":/.test(said)) throw new Error(`the Docker daemon could not fetch ${reference}: ${said.slice(-300)}`);
  }

  async create(spec: MachineSpec): Promise<Machine> {
    const image = spec.fromSnapshot ?? spec.template ?? this.baseTemplates[spec.kind];
    // The container's name is the only idempotency the daemon has: a second create under the same name is refused
    // with 409, and the machine the first one booted is what the caller wanted.
    const name = `wsp-${spec.idempotencyKey === undefined ? randomBytes(8).toString("hex") : imageTag(spec.idempotencyKey).toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
    const size = await this.sizeOnBox(spec);
    const body = {
      Image: image,
      Cmd: [...DOCKER_BOOT_CMD],
      // A host name is capped at 64 bytes by the kernel, and a machine wsp names after a long record would be
      // refused at boot with sethostname: invalid argument (a live seal died on its smoke fork, 2026-09-11).
      Hostname: name.slice(0, HOSTNAME_MAX),
      ...(spec.envs === undefined ? {} : { Env: Object.entries(spec.envs).map(([k, v]) => `${k}=${v}`) }),
      Labels: { [WSP_LABEL]: "1", ...spec.labels },
      ExposedPorts: { [`${DAEMON_PORT}/tcp`]: {} },
      HostConfig: {
        // tini reaps: every exec's children are the container's, and a daemon restarted by the supervisor leaves none.
        Init: true,
        ...(size.memMb === undefined ? {} : { Memory: size.memMb * 1024 * 1024 }),
        ...(size.cpu === undefined ? {} : { NanoCpus: size.cpu * 1_000_000_000 }),
        // Bound to the loopback of the computer the daemon runs on: the token in the first frame is the only gate on
        // the daemon, and a port on the box's public address would put it where anyone can knock.
        PortBindings: { [`${DAEMON_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }] },
      },
      // spec.diskGb is not asked for: a per container quota needs overlay2 on xfs mounted with pquota, and a
      // container on any other filesystem is refused at create rather than given the box's disk.
    };
    const started = (): Promise<{ Id: string }> => this.request<{ Id: string }>("POST", "/containers/create", { query: { name }, body });
    let id: string;
    let replayed = false;
    try {
      id = (await started()).Id;
    } catch (e) {
      const kind = (e as WspError).kind;
      if (kind === "conflict") {
        id = (await this.request<ContainerView>("GET", `/containers/${pathRef(name)}/json`)).Id;
        replayed = true;
      } else if (kind === "missing" && !image.startsWith("sha256:")) {
        // The box has never held this image: fetch it once and boot from it, which is what a first build on a fresh
        // box does. A snapshot's own id is not fetched: no registry has one.
        await this.pull(image);
        id = (await started()).Id;
      } else {
        throw e;
      }
    }
    if (!replayed) {
      // A container the daemon made and would not start is ours and nobody else's: it is removed here rather than
      // left behind, since the caller never learns its id (a refused start left one on the box, 2026-09-11).
      await this.request("POST", `/containers/${id}/start`).catch(async (e: unknown) => {
        await this.request("DELETE", `/containers/${id}`, { query: { force: "true", v: "true" } }).catch(() => {});
        throw e;
      });
    }
    return new DockerMachine(this, id, spec.kind, this.onThisComputer, spec.labels, undefined, replayed);
  }

  async get(id: string): Promise<Machine> {
    const view = await this.inspect(id);
    return new DockerMachine(this, view.Id, "sandbox", this.onThisComputer, view.Config?.Labels, {
      state: stateOf(view),
      ...(view.Created !== undefined ? { createdAt: view.Created } : {}),
    });
  }

  /** What the box has, read once: a machine's size is held to it. */
  private box: Promise<{ MemTotal?: number; NCPU?: number }> | undefined;

  /** The size this box can actually give, out of the one asked for. A provider that clamps a request is a shape the
   * callers already read back off describe(), so the version a seal records is what the box built. */
  async sizeOnBox(spec: Pick<MachineSpec, "cpu" | "memMb">): Promise<{ memMb?: number; cpu?: number }> {
    if (spec.memMb === undefined && spec.cpu === undefined) return {};
    const info: { MemTotal?: number; NCPU?: number } = await (this.box ??= this.request<{ MemTotal?: number; NCPU?: number }>("GET", "/info").catch(() => ({})));
    const roomMb = info.MemTotal === undefined || info.MemTotal === 0 ? undefined : Math.floor((info.MemTotal * BOX_MEMORY_SHARE) / (1024 * 1024));
    const cores = info.NCPU === undefined || info.NCPU === 0 ? undefined : info.NCPU;
    return {
      ...(spec.memMb === undefined ? {} : { memMb: roomMb === undefined ? spec.memMb : Math.min(spec.memMb, roomMb) }),
      ...(spec.cpu === undefined ? {} : { cpu: cores === undefined ? spec.cpu : Math.min(spec.cpu, cores) }),
    };
  }

  inspect(id: string): Promise<ContainerView> {
    return this.request<ContainerView>("GET", `/containers/${pathRef(id)}/json`);
  }

  async list(labels?: Record<string, string>): Promise<{ id: string; state: MachineState; labels: Record<string, string>; size?: { cpu: number; memMb: number } }[]> {
    // Only containers wearing wsp's own label are ever listed: a box runs the person's own containers beside ours.
    const filters = JSON.stringify({ label: [`${WSP_LABEL}=1`, ...Object.entries(labels ?? {}).map(([k, v]) => `${k}=${v}`)] });
    const rows = await this.request<{ Id: string; State?: string; Labels?: Record<string, string>; HostConfig?: { Memory?: number; NanoCpus?: number } }[]>(
      "GET", "/containers/json", { query: { all: "true", filters } },
    );
    return rows.map(row => {
      const size = sizeOf(row.HostConfig);
      return {
        id: row.Id,
        state: STATE_MAP[row.State ?? ""] ?? "gone",
        labels: row.Labels ?? {},
        ...(size !== undefined ? { size } : {}),
      };
    });
  }

  async deleteSnapshot(id: string): Promise<void> {
    await this.request("DELETE", `/images/${pathRef(id)}`);
  }

  /** Every image wsp committed on this daemon, with what it takes on the box's disk. `Size` counts every layer,
   * shared ones included, so two versions off one base each read the whole. */
  async listSnapshots(): Promise<SnapshotRow[]> {
    const rows = await this.request<ImageView[]>("GET", "/images/json", { query: { filters: JSON.stringify({ label: [`${WSP_LABEL}=1`] }) } });
    return rows.map(row => {
      const name = row.Labels?.[SNAPSHOT_LABEL];
      return {
        id: row.Id,
        ...(name !== undefined ? { name } : {}),
        sizeBytes: row.Size ?? 0,
        ...(row.Created !== undefined ? { createdAt: new Date(row.Created * 1000).toISOString() } : {}),
      };
    });
  }

  /** A committed image is already durable: promoting it is a second name for it, under which forks boot. */
  async promoteSnapshot(snapshotId: string, name: string): Promise<string> {
    const repo = `${DOCKER_REPO}/${imageTag(name).toLowerCase()}`;
    await this.request("POST", `/images/${pathRef(snapshotId)}/tag`, { query: { repo, tag: "template" } });
    return `${repo}:template`;
  }

  async getTemplate(id: string): Promise<TemplateRow> {
    const view = await this.request<{ Id: string; Created?: string; Config?: { Labels?: Record<string, string> } }>("GET", `/images/${pathRef(id)}/json`);
    // An image either is on the box or is not: there is no building state to wait out.
    return { id, name: id, status: "ready", ...(view.Created !== undefined ? { createdAt: view.Created } : {}) };
  }

  async listTemplates(): Promise<TemplateRow[]> {
    const rows = await this.request<ImageView[]>("GET", "/images/json", { query: { filters: JSON.stringify({ label: [`${WSP_LABEL}=1`] }) } });
    return rows.flatMap(row => (row.RepoTags ?? []).filter(tag => tag.endsWith(":template")).map(tag => ({
      id: tag,
      name: tag,
      status: "ready" as const,
      ...(row.Created !== undefined ? { createdAt: new Date(row.Created * 1000).toISOString() } : {}),
    })));
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.request("DELETE", `/images/${pathRef(id)}`);
  }

  /** The one read that proves the daemon is there and takes no machine's time: its own version. */
  async checkKey(): Promise<void> {
    await this.request("GET", "/version");
  }
}

function sizeOf(host: { Memory?: number; NanoCpus?: number } | undefined): { cpu: number; memMb: number } | undefined {
  if (host?.Memory === undefined || host.Memory === 0 || host.NanoCpus === undefined || host.NanoCpus === 0) return undefined;
  return { cpu: host.NanoCpus / 1_000_000_000, memMb: Math.round(host.Memory / (1024 * 1024)) };
}

function stateOf(view: ContainerView): MachineState {
  return STATE_MAP[view.State?.Status ?? ""] ?? "gone";
}

/** One container as a machine. Its daemon is the container's own boot rather than a service manager, since a
 * container has no init to register a unit with. */
export class DockerMachine implements Machine {
  readonly streamUrl = undefined;
  readonly daemonSupervisor: DaemonSupervisor = "entrypoint";
  /** Only on a machine whose daemon runs on this computer: a published port sits on the daemon host's loopback, so
   * on a box it is a route this host cannot take, and a machine that answered one anyway would be read as a fork
   * whose daemon died, re-paused, resurrected and redeployed on every wake. Absent is what every road above reads
   * (`hasDaemon` is the presence of this) and absent is the truth on a box until a forward exists. */
  readonly previewUrl?: (port: number) => Promise<PreviewReach>;

  constructor(
    private readonly backend: DockerBackend,
    readonly id: string,
    readonly kind: MachineKind,
    onThisComputer: boolean,
    readonly labels?: Record<string, string>,
    readonly seen?: { state: MachineState; createdAt?: string },
    readonly replayed?: boolean,
  ) {
    if (onThisComputer) this.previewUrl = port => this.publishedPort(port);
  }

  private path(suffix = ""): string {
    return `/containers/${pathRef(this.id)}${suffix}`;
  }

  /** bash -c, never -lc: a login shell resets PATH. The exec carries the guest's own environment and nothing of
   * this computer's, so HOME and USER go ahead of the command as they do on every other backend. */
  async exec(cmd: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const timeoutMs = opts?.timeoutMs ?? INLINE_EXEC_MS;
    const { Id } = await this.backend.request<{ Id: string }>("POST", this.path("/exec"), {
      body: { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ["bash", "-c", `${EXEC_ENV}\n${cmd}`] },
      timeoutMs,
    });
    const stream = await this.backend.execStream(Id, timeoutMs);
    const { stdout, stderr } = demux(stream);
    // The daemon has no exec kill road, so a command whose stream ended still has its exit code read here rather
    // than guessed at; a command the deadline cut off leaves the inspect saying it runs.
    const inspected = await this.backend.request<{ ExitCode: number | null; Running: boolean }>("GET", `/exec/${pathRef(Id)}/json`);
    return { exitCode: inspected.ExitCode ?? (inspected.Running ? 124 : -1), stdout, stderr };
  }

  run(script: string, opts: RunOptions): Promise<ExecResult> {
    return execDetached(this, script, opts);
  }

  /** A commit: the container's filesystem as an image, the container held still while it is taken. It holds no
   * memory, so whatever the agents had in theirs is gone and a fork of it starts them again. The disk is the same
   * copy whatever the container has done since it booted, so the life it is handed changes nothing. */
  async snapshot(name: string, _life: MachineLife): Promise<string> {
    const res = await this.backend.request<{ Id: string }>("POST", "/commit", {
      query: { container: this.id, repo: DOCKER_REPO, tag: imageTag(name), pause: "true" },
      body: { Labels: { [WSP_LABEL]: "1", [SNAPSHOT_LABEL]: name } },
    });
    return res.Id;
  }

  async pause(): Promise<void> {
    await this.backend.request("POST", this.path("/pause"));
  }

  async resume(): Promise<void> {
    await this.backend.request("POST", this.path("/unpause"));
  }

  /** Only this container, by the id this handle was made with: nothing here removes by name or by pattern. */
  async kill(): Promise<void> {
    await this.backend.request("DELETE", this.path(), { query: { force: "true", v: "true" } });
  }

  async state(): Promise<MachineState> {
    try {
      return stateOf(await this.backend.inspect(this.id));
    } catch (e) {
      if (isMissing(e)) return "gone";
      throw e;
    }
  }

  async describe(): Promise<MachineShape> {
    const view = await this.backend.inspect(this.id);
    const size = sizeOf(view.HostConfig);
    return {
      ...(size !== undefined ? size : {}),
      ...(view.Created !== undefined ? { createdAt: view.Created } : {}),
    };
  }

  async metrics(): Promise<void> {
    await this.backend.request("GET", this.path("/stats"), { query: { stream: "false", "one-shot": "true" } });
  }

  /** Where this host dials one of the container's ports: the address the daemon published it on, which is the
   * loopback of the computer the daemon runs on. It is nobody's public route, so it carries no token and lasts as
   * long as the container does. A container's own bridge address is not it: a Mac cannot reach one at all. */
  private async publishedPort(port: number): Promise<PreviewReach> {
    const view = await this.backend.inspect(this.id);
    const bound = view.NetworkSettings?.Ports?.[`${port}/tcp`]?.[0];
    if (bound?.HostPort === undefined || bound.HostPort === "") {
      throw new Error(`container ${this.id} publishes no port ${port}; only the daemon's own port is published`);
    }
    const host = bound.HostIp === undefined || bound.HostIp === "" || bound.HostIp === "0.0.0.0" ? "127.0.0.1" : bound.HostIp;
    return { url: `http://${host}:${bound.HostPort}`, token: "", expiresAt: Number.MAX_SAFE_INTEGER };
  }

  /** Bytes onto the container through the archive road: one file in a tar, extracted where it belongs. */
  async putBytes(path: string, bytes: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<void> {
    await this.backend.request("PUT", this.path("/archive"), {
      query: { path: posix.dirname(path) },
      raw: oneFileTar(posix.basename(path), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  async downloadUrl(): Promise<string> {
    throw new Error("a container serves no signed download URL; its files come out through the archive road");
  }

  async uploadUrl(): Promise<string> {
    throw new Error("a container serves no signed upload URL; its files go in through the archive road");
  }
}
