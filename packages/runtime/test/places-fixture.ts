// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { afterEach, expect } from "vitest";
import type WebSocket from "ws";
import type { PlaceReport, PlaceView } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HostFolders, type Runtime } from "../src/runtime.js";
import { newPlaceKeyPair, type PlaceKeyPair, type PlaceLeaver, type PlaceUpdater, type PlaceWiring } from "../src/places.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import type { AgentsActs, AgentsReader, ServerIcons, ServersActs, SkillsActs } from "../src/agents-read.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";
import { joinAt, relinkAt, wiring } from "./place-join.js";

/** Every fact of a pull request a read answers but its number, link, state and host, which each case names. */
export const PR_REST: Omit<import("@wsp/protocol").PullRequest, "number" | "url" | "state" | "host"> = { draft: false, base: "main", branch: "work", headOid: "abc1234", headSubject: "Do the work", mergeable: "unknown", mergeState: "unknown", review: "none", checks: [], additions: 1, deletions: 0, changedFiles: 1, commits: 1 };

/** The server and runtime a case stands up, on an object since a file importing them cannot assign an imported binding. */
export const ctx: { srv?: RuntimeServer; runtime?: Runtime } = {};
export const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await ctx.srv?.close();
  ctx.srv = undefined;
  await ctx.runtime?.close();
  ctx.runtime = undefined;
});

export async function serving(opts: { provider?: { id: string; rateUsdPerHour: number }; store?: Store; relinkWaitMs?: number; update?: PlaceUpdater; updateWaitMs?: number; leave?: PlaceLeaver; vault?: Record<string, string>; folders?: HostFolders; agentsReader?: AgentsReader; agentsActs?: AgentsActs; skillsActs?: SkillsActs; serversActs?: ServersActs; serverIcons?: ServerIcons; adapters?: Record<string, HarnessAdapterFactory>; runOver?: PlaceWiring["runOver"]; back?: PlaceWiring["back"]; dialWaitMs?: number } = {}, serve: { log?: (line: string) => void } = {}): Promise<{ hostKey: PlaceKeyPair; store: Store }> {
  const store = opts.store ?? memoryStore();
  const hostKey = newPlaceKeyPair();
  ctx.runtime = createRuntime({
    backend: stubBackend(),
    store,
    adapters: opts.adapters ?? {},
    ...(opts.vault === undefined ? {} : { vault: () => opts.vault! }),
    ...(opts.agentsReader === undefined ? {} : { agentsReader: opts.agentsReader }),
    ...(opts.agentsActs === undefined ? {} : { agentsActs: opts.agentsActs }),
    ...(opts.skillsActs === undefined ? {} : { skillsActs: opts.skillsActs }),
    ...(opts.serversActs === undefined ? {} : { serversActs: opts.serversActs }),
    ...(opts.serverIcons === undefined ? {} : { serverIcons: opts.serverIcons }),
    placeLinks: { ...wiring(hostKey, opts.provider, opts.update), ...(opts.leave === undefined ? {} : { leave: opts.leave }), ...(opts.runOver === undefined ? {} : { runOver: opts.runOver }), ...(opts.back === undefined ? {} : { back: opts.back }) },
    ...(opts.relinkWaitMs !== undefined ? { placeRelinkWaitMs: opts.relinkWaitMs } : {}),
    ...(opts.dialWaitMs !== undefined ? { placeDialWaitMs: opts.dialWaitMs } : {}),
    ...(opts.updateWaitMs !== undefined ? { placeUpdateWaitMs: opts.updateWaitMs } : {}),
  });
  ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices, ...(opts.folders === undefined ? {} : { folders: opts.folders }), ...(serve.log === undefined ? {} : { log: serve.log }) });
  return { hostKey, store };
}

/** A code minted over the host's own socket, which is the only road to one. */
export async function code(): Promise<string> {
  const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
  const issued = await c.request("pair.issue");
  c.close();
  expect(issued.ok, String(issued["error"])).toBe(true);
  return issued["code"] as string;
}

/** One join, as a computer would make it, on this file's own host. */
export const join = (hostKey: PlaceKeyPair, opts: Parameters<typeof joinAt>[2] = { code: "" }) => joinAt(ctx.srv!.port, hostKey, opts);

/** A place that already joined, dialling in again, on this file's own host. */
export const relink = (hostKey: PlaceKeyPair, placeId: string, pair: PlaceKeyPair, sent?: PlaceReport, answers?: (c: WsClient) => void) => relinkAt(ctx.srv!.port, hostKey, placeId, pair, sent, answers);

/** The same store with a timer in front of every read and write, as a store on a disk or behind a network has:
 * the loop turns inside each of them, which is where a handover that is not order-safe drops a frame. */
export function yielding(inner: Store): Store {
  const soon = (): Promise<void> => new Promise(done => setTimeout(done, 30));
  return {
    get: async (c, id) => (await soon(), inner.get(c, id)),
    put: async (c, id, v) => (await soon(), inner.put(c, id, v)),
    list: async c => (await soon(), inner.list(c)),
    keys: async c => (await soon(), inner.keys(c)),
    delete: async (c, id) => (await soon(), inner.delete(c, id)),
    getBlob: async (c, id) => (await soon(), inner.getBlob(c, id)),
    putBlob: async (c, id, b) => (await soon(), inner.putBlob(c, id, b)),
    deleteBlob: async (c, id) => (await soon(), inner.deleteBlob(c, id)),
    statBlob: async (c, id) => (await soon(), inner.statBlob(c, id)),
  };
}

export const placesOf = async (): Promise<PlaceView[]> => {
  const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
  const answer = await c.request("places.list");
  c.close();
  expect(answer.ok, String(answer["error"])).toBe(true);
  return answer["places"] as PlaceView[];
};

/** A place answering machine.backend with the facts this test hands it, counting the asks: the facts belong to
 * the daemon that answered, so a test can move the answer between dials the way an update does. Its capacity is
 * answered too, since a computer whose facts are on the record is asked for that at every listing. */
export const saysItsFacts = (facts: () => Record<string, unknown>, asks: { count: number }, afterMs = 0) => (c: WsClient): void => {
  c.onFrame(raw => {
    const frame = raw as unknown as { id?: number; op?: string };
    if (frame.op === "machine.capacity") {
      const room = { cores: 4, memMb: 8192, memRoomMb: 4096, machineMemMb: 4096, diskFreeBytes: 10 * 1024 ** 3, images: [], machines: { running: 0, paused: 0 } };
      c.say({ id: frame.id, ok: true, ...room });
      return;
    }
    if (frame.op !== "machine.backend") return;
    asks.count += 1;
    // `afterMs` is a computer that takes a moment to answer, which is what makes a road that reads the row
    // without waiting for it read a row that has not got it yet.
    const answer = (): void => c.say({ id: frame.id, ok: true, ...facts() });
    if (afterMs === 0) answer();
    else setTimeout(answer, afterMs).unref?.();
  });
};

/** Where a computer keeps the logins its workspaces share, as its daemon reports one. */
export const LOGINS = "/wsp/logins";

/** A computer that answers the frames a remove sends it: the reads of what wsp merged into the agents' own files
 * there, which on a computer with no list beside its job come back with nothing to take, and the sweep with what
 * its own leave took. */
export function answersLeave(client: WsClient, swept: readonly string[], asked?: string[]): void {
  client.onFrame(raw => {
    const frame = raw as unknown as { id?: number; op?: string };
    if (frame.op === "exec") return void client.say({ id: frame.id, ok: true, exitCode: 0, stdout: "", stderr: "", truncated: false });
    if (frame.op !== "place.leave") return;
    asked?.push("place.leave");
    client.say({ id: frame.id, ok: true, swept: [...swept] });
  });
}

export async function remove(placeId: string): Promise<Record<string, unknown>> {
  const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
  const answer = await c.request("places.remove", { placeId });
  c.close();
  return answer;
}

/** A joined computer that forks: it answers the machine ops on the socket it opened, as the agent on it does, and
 * records what the host asked it for. Nothing here is the server half itself, which lives with the agent; this is
 * one computer's worth of answers, so the runtime's own roads are what the test is reading. */
export interface ForkingPlace {
  created: Record<string, unknown>[];
  killed: string[];
  paused: number;
  resumed: number;
  tunnels: { tunnelId: string; port: number }[];
  /** What the next create answers with instead of a machine; cleared after one use. */
  refuseCreate?: { error: string; kind: string; status: number };
  /** What a pull request frame is refused with, for the note a bring back carries beside a landed push. */
  refuseGitPr?: { error: string; code: string };
  /** Every op the host sent, in order. */
  ops: string[];
  /** Every files or git frame the host sent for a workspace on this computer, whole: the workspace named on it is
   * what a case reads. */
  frames: Record<string, unknown>[];
  /** How many times each op was asked. */
  asked: Record<string, number>;
  /** The ask of the machine's own daemon check that first answers yes; every one before it answers no. */
  daemonAnswersAfter: number;
  /** Ops this computer takes and never answers, so a test can close the socket with a frame in flight on it. */
  swallow: Set<string>;
  /** One event up the link, as this computer's daemon pushes one for a workspace on it. */
  push(event: Record<string, unknown>): void;
  /** Holds every resume frame until it is called, for a wake a test wants in flight. */
  holdResumes(): () => void;
}

export const PLACE_FACTS = {
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
    sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }],
  },
  pricing: { defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
  lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
  baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
};

export const PLACE_ROADS = { previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true };
/** What a computer somebody joined answers about itself once its workspaces are copies of the computer: it keeps
 * no image, so nothing behind an image is offered either. The shape the daemon of this build reports. */
export const KEEPS_NO_IMAGE = {
  ...PLACE_FACTS,
  capabilities: { ...PLACE_FACTS.capabilities, images: false, diskSnapshots: false, snapshotsAnyLife: false, snapshotListing: false, templates: false },
  baseTemplates: undefined,
};

/** One sealed version of this host's own image, promoted to a template: what a fork at a provider that keeps
 * images stands on, and the image a create on a computer that keeps none is handed and must not send. */
export const SEALED = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_g", templateId: "tpl_g", baseTemplate: "base", setupSha: "s1", createdAt: "2026-09-16T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 } }],
};

/** What a computer says about itself that keeps the project checkouts it holds on a disk of its own, and no image,
 * so the work of an add there runs in a copy of its own directories. */
export const HOLDS_PROJECTS = { ...KEEPS_NO_IMAGE, projects: "/wsp/projects" };

/** The login a computer joined as root reports, the one login a thread in a folder there runs as. */
export const ROOT_LOGIN = { HOME: "/root", USER: "root", PATH: "/usr/bin" };

/** What a computer joined as root answers a command on itself with: who its lines run as, and nothing else. */
export const asRoot = (cmd: string): { exitCode: number; stdout: string; stderr: string } => ({ exitCode: 0, stdout: cmd.includes("command -v runuser") ? "Linux\n0\nroot\nroot\n1\n/root\n/usr/bin\n" : "", stderr: "" });

export function forks(
  client: WsClient,
  capacity: {
    cores: number;
    memMb: number;
    memRoomMb: number;
    machineMemMb: number;
    diskFreeBytes: number;
    images: { id: string; sizeBytes: number }[];
    machines: { running: number; paused: number };
  } = {
    cores: 4,
    memMb: 8192,
    memRoomMb: 9000,
    machineMemMb: 4096,
    diskFreeBytes: 10 * 1024 * 1024 * 1024,
    images: [{ id: "sha256:i", sizeBytes: 4 * 1024 * 1024 * 1024 }],
    machines: { running: 1, paused: 0 },
  },
  /** What a command run on a machine there answers; nothing and exit 0 unless the test says. */
  exec: (cmd: string) => { exitCode: number; stdout: string; stderr: string } = () => ({ exitCode: 0, stdout: "", stderr: "" }),
  /** What this computer says it forks with; the default keeps images, which is the shape the copy road is read on. */
  facts: Record<string, unknown> = PLACE_FACTS,
): ForkingPlace {
  let held: ((...args: never[]) => void)[] | undefined;
  const seen: ForkingPlace = {
    created: [],
    killed: [],
    paused: 0,
    resumed: 0,
    tunnels: [],
    ops: [],
    frames: [],
    asked: {},
    daemonAnswersAfter: 1,
    swallow: new Set<string>(),
    push: event => client.say(event),
    holdResumes: () => {
      held = [];
      return () => {
        for (const release of held ?? []) release();
        held = undefined;
      };
    },
  };
  let made = 0;
  let ptys = 0;
  // The container's own word for itself, as a Docker daemon would answer it: a wake reads it before it resumes.
  let state: "running" | "paused" = "running";
  client.onFrame(raw => {
    const frame = raw as unknown as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    const id = frame["id"];
    const say = (payload: Record<string, unknown>): void => client.say({ id, ok: true, ...payload });
    const machine = (machineId: string): Record<string, unknown> => ({ machine: { id: machineId, kind: "sandbox", daemonSupervisor: "entrypoint", roads: PLACE_ROADS } });
    // A machine the host killed is gone from that computer, as the daemon there answers: a get or a state read of
    // it is refused as missing, which is what the kill's own wait for gone reads.
    const gone = (machineId: string): boolean => seen.killed.includes(machineId);
    const missing = (machineId: string): void => void client.say({ id, ok: false, error: `no such machine: ${machineId}`, kind: "missing", status: 404 });
    if (op.startsWith("machine.") || op.startsWith("tunnel.")) seen.ops.push(op);
    seen.asked[op] = (seen.asked[op] ?? 0) + 1;
    if (seen.swallow.has(op)) return;
    switch (op) {
      case "machine.backend":
        return say(facts);
      case "machine.capacity":
        return say(capacity);
      case "machine.create": {
        if (seen.refuseCreate !== undefined) {
          const refusal = seen.refuseCreate;
          delete seen.refuseCreate;
          return void client.say({ id, ok: false, ...refusal });
        }
        seen.created.push(frame["spec"] as Record<string, unknown>);
        return say(machine(`k${++made}`));
      }
      case "machine.get":
        return gone(String(frame["machineId"])) ? missing(String(frame["machineId"])) : say(machine(String(frame["machineId"])));
      case "machine.state":
        return gone(String(frame["machineId"])) ? missing(String(frame["machineId"])) : say({ state });
      case "machine.exec":
        return say({ result: exec(String(frame["cmd"])) });
      case "machine.describe":
        return say({ shape: { cpu: 2, memMb: 4096 } });
      case "machine.facts":
        return say({ facts: { os: "Ubuntu 24.04", uptimeMs: 1000, folder: "/root" } });
      case "machine.metrics":
        return say({});
      case "machine.daemonAnswers":
        return say({ answers: (seen.asked[op] ?? 0) >= seen.daemonAnswersAfter });
      case "machine.previewUrl":
        return say({ reach: { url: "http://127.0.0.1:49155", token: "", expiresAt: 1 } });
      case "machine.pause":
        seen.paused++;
        state = "paused";
        return say({});
      case "machine.resume": {
        seen.resumed++;
        state = "running";
        if (held === undefined) return say({});
        held.push(() => say({}));
        return;
      }
      case "machine.kill":
        seen.killed.push(String(frame["machineId"]));
        return say({});
      case "machine.putBytes":
        return say({});
      // A container mints no signed URL, as the Docker machine's own answer says; a nap that would have exported a
      // vault through one reads the refusal and keeps the vault it had.
      case "machine.downloadUrl":
      case "machine.uploadUrl":
        return void client.say({ id, ok: false, error: "a container serves no signed URL" });
      case "tunnel.open":
        seen.tunnels.push({ tunnelId: String(frame["tunnelId"]), port: Number(frame["port"]) });
        seen.frames.push(frame);
        return say({});
      case "tunnel.write":
      case "tunnel.close":
        seen.frames.push(frame);
        return say({});
      case "ssh.start":
        seen.frames.push(frame);
        return say({ port: 40022, hostKey: "ssh-ed25519 AAAAC3Nz the-fork" });
      // A command on the computer itself: the claim an add makes in the login's home takes the name it asks for, and
      // every other command answers as the case says.
      case "exec": {
        const claim = /mkdir '([^']+)'"\$n"/.exec(String(frame["cmd"]));
        return say({ ...(claim === null ? exec(String(frame["cmd"])) : { exitCode: 0, stdout: `${claim[1]}\n`, stderr: "" }), truncated: false });
      }
      // The workspace's own git, answered by this computer's daemon for the workspace the frame names, which is
      // what a workspace with no daemon of its own is served by.
      case "git.status":
        seen.frames.push(frame);
        return say({ branch: "work", ahead: 0, files: [] });
      // The pane's road: this computer's daemon opens and drives a shell inside the workspace the frame names.
      case "pty.create":
        seen.frames.push(frame);
        return say({ ptyId: `p${++ptys}`, pid: 4242 });
      case "pty.attach":
      case "pty.detach":
      case "pty.write":
      case "pty.resize":
      case "pty.kill":
      case "pty.tab":
        seen.frames.push(frame);
        return say({});
      case "pty.list":
        seen.frames.push(frame);
        return say({ ptys: [] });
      case "proc.watch":
      case "proc.unwatch":
      case "proc.kill":
        return say({});
      case "proc.inspect":
        return say({ pid: frame["pid"] });
      case "ping":
      case "fs.list":
      case "fs.files":
      case "fs.read":
      case "fs.write":
      case "fs.search":
      case "git.diff":
      case "git.snapshot":
      case "git.range":
      case "git.turn":
      case "git.prList":
      case "guest.watch":
      case "guest.reply":
      case "guest.close":
        seen.frames.push(frame);
        return say({});
      case "git.push":
        seen.frames.push(frame);
        return say({ branch: "work", base: String(frame["base"] ?? ""), remote: "origin", ahead: 1, uncommitted: 0, stat: [" README.md | 2 +-"] });
      case "git.pr": {
        seen.frames.push(frame);
        if (seen.refuseGitPr !== undefined) return void client.say({ id, ok: false, ...seen.refuseGitPr });
        return say({ pr: { number: 7, url: "https://github.com/o/r/pull/7", state: "open", host: "github.com", ...PR_REST }, created: true });
      }
      default:
        return;
    }
  });
  return seen;
}

/** Every op the computer's daemon serves, off the frames crate itself, with whether its request names the
 * workspace it is for: a new op there fails this table until it is placed on one side. */
export const daemonOps = (): { op: string; scoped: boolean }[] => {
  const crate = (file: string): string => readFileSync(new URL(`../../../daemon/crates/wsp-frames/src/${file}`, import.meta.url), "utf8");
  const listed = (text: string, name: string): string[] => [...text.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([^\\]]*)\\]`))![1]!.matchAll(/"([^"]+)"/g)].map(m => m[1]!);
  const request = crate("request.rs");
  const body = request.slice(request.indexOf("pub enum DaemonOp"), request.indexOf("pub const DAEMON_OPS"));
  const variants = new Map(body.split(/#\[serde\(rename = "/).slice(1).map(part => [part.slice(0, part.indexOf('"')), part.includes("machine_id")] as const));
  return [...listed(request, "DAEMON_OPS"), ...listed(crate("machine.rs"), "MACHINE_OPS")].map(op => ({ op, scoped: variants.get(op) ?? false }));
};
