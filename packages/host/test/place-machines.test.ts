// SPDX-License-Identifier: AGPL-3.0-only
// The server half of a place's machines: every machine.* frame answered
// against the backend this computer offers, and the whole of it once more
// through a real daemon link, so what the host drives is what a Docker daemon
// on the other computer reads.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EXEC_BODY_MAX, NOT_ON_THIS_ROAD } from "@wsp/protocol";
import { DockerBackend, LinkBackend, type ExecResult, type Machine, type MachineBackend, type MachineSpec } from "@wsp/engine";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import { machineOps } from "../src/place-machines.js";
import { PLACE_OFFERS, offeredBackend } from "../src/place-offers.js";
import { FakeEngine } from "../../engine/test/fake-docker-engine.js";
import { closeFakePlaceHosts, fakePlaceHost, placePair, settled, testPlaceFile } from "../../daemon/test/fake-place-host.js";
import { linkOver } from "./machine-link.js";

const dirs: string[] = [];
const daemons: DaemonHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  for (const d of daemons.splice(0)) await d.close();
  await closeFakePlaceHosts();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One frame as it arrives on the link: the op, its id and the fields the caller names. */
let frames = 0;
const frame = (op: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({ id: ++frames, op, ...fields });

const tmp = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), name));
  dirs.push(dir);
  return dir;
};

const report = async () => ({
  name: "old-macbook",
  platform: "linux" as const,
  arch: "x64",
  os: "Linux 6.8.0",
  shape: { cpu: 4, memMb: 4096 },
  login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
  docker: true,
  daemonVersion: 17,
  agents: [],
  wsp: ["/usr/bin/wsp"],
});

/** A machine that records what it was asked and answers plainly. */
function fakeMachine(id: string, put: { path: string; bytes: Uint8Array }[] = []): Machine & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    id,
    kind: "sandbox",
    daemonSupervisor: "entrypoint",
    labels: { wsp: "1" },
    exec: async (cmd: string): Promise<ExecResult> => {
      asked.push(`exec ${cmd}`);
      return { exitCode: 0, stdout: cmd, stderr: "" };
    },
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    snapshot: async (name: string) => {
      asked.push(`snapshot ${name}`);
      return `sha256:${name}`;
    },
    pause: async () => void asked.push("pause"),
    resume: async () => void asked.push("resume"),
    kill: async () => void asked.push("kill"),
    state: async () => "running" as const,
    downloadUrl: async (path: string) => `https://down${path}`,
    uploadUrl: async (path: string) => `https://up${path}`,
    previewUrl: async (port: number) => ({ url: `http://127.0.0.1:${30000 + port}`, token: "", expiresAt: 1 }),
    daemonAnswers: async () => true,
    putBytes: async (path: string, bytes: Uint8Array) => void put.push({ path, bytes }),
    describe: async () => ({ cpu: 2, memMb: 4096 }),
    facts: async () => ({ os: "Linux", uptimeMs: 10, folder: "/root" }),
    metrics: async () => undefined,
  };
}

function fakeBackend(put: { path: string; bytes: Uint8Array }[] = []): MachineBackend & { made: MachineSpec[]; gets: string[]; machines: Map<string, Machine & { asked: string[] }> } {
  const made: MachineSpec[] = [];
  const gets: string[] = [];
  const machines = new Map<string, Machine & { asked: string[] }>();
  const of = (id: string): Machine & { asked: string[] } => {
    const held = machines.get(id) ?? fakeMachine(id, put);
    machines.set(id, held);
    return held;
  };
  return {
    made,
    gets,
    machines,
    capabilities: {
      liveCloneForks: false,
      pauseMode: "memory",
      resize: false,
      replacesMachine: true,
      previewUrls: false,
      signedUrls: false,
      containers: false,
      callbackRelay: true,
      diskSnapshots: true,
      snapshotListing: true,
      templates: true,
      kept: false,
      sizes: [{ cpu: 2, memMb: 4096, rateUsdPerHour: 0 }],
    },
    pricing: { rateUsdPerHour: () => 0, defaultSize: { cpu: 2, memMb: 4096 }, snapshotStorage: { freeGb: 0, usdPerGbMonth: 0, billedFrom: "" } },
    lifecycle: { budgets: { wakeAttempts: 1, daemonAnswersMs: 30_000 } },
    baseTemplates: { sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" },
    create: async spec => {
      made.push(spec);
      return of(`c${made.length}`);
    },
    get: async id => {
      gets.push(id);
      if (id === "gone") throw Object.assign(new Error("no such container: gone"), { kind: "missing", status: 404 });
      return of(id);
    },
    list: async labels => [{ id: "c1", state: "running" as const, labels: labels ?? {} }],
    deleteSnapshot: async () => undefined,
    listSnapshots: async () => [{ id: "sha256:a", sizeBytes: 10 }],
    promoteSnapshot: async (_id, name) => `wsp/${name}:template`,
    getTemplate: async id => ({ id, name: id, status: "ready" as const }),
    listTemplates: async () => [{ id: "wsp/dev:template", name: "wsp/dev:template", status: "ready" as const }],
    deleteTemplate: async () => undefined,
    checkKey: async () => undefined,
    capacity: async () => ({ cores: 4, memMb: 4096, memRoomMb: 2048, machineMemMb: 2048, diskFreeBytes: 100, images: [], machines: { running: 1, paused: 0 } }),
  };
}

describe("the ops one backend answers", () => {
  it("forwards every op to the backend or the handle and answers in the reply's shape", async () => {
    const backend = fakeBackend();
    const ops = machineOps("docker", backend, tmp("wsp-put-"));
    expect(await ops["machine.backend"]!(frame("machine.backend"))).toMatchObject({ capabilities: backend.capabilities, pricing: { defaultSize: { cpu: 2, memMb: 4096 } }, lifecycle: { budgets: { wakeAttempts: 1 } } });
    expect(await ops["machine.capacity"]!(frame("machine.capacity"))).toMatchObject({ cores: 4 });
    expect(await ops["machine.checkKey"]!(frame("machine.checkKey"))).toEqual({});
    const created = (await ops["machine.create"]!(frame("machine.create", { spec: { kind: "sandbox", template: "wsp/dev:template" } }))) as { machine: { id: string; roads: Record<string, boolean> } };
    expect(backend.made).toEqual([{ kind: "sandbox", template: "wsp/dev:template" }]);
    expect(created.machine.roads).toEqual({ previewUrl: true, daemonAnswers: true, putBytes: true, describe: true, facts: true, metrics: true });
    expect(await ops["machine.list"]!(frame("machine.list", { labels: { owner: "h_1" } }))).toEqual({ machines: [{ id: "c1", state: "running", labels: { owner: "h_1" } }] });
    expect(await ops["machine.exec"]!(frame("machine.exec", { machineId: "c1", cmd: "echo hi", timeoutMs: 50 }))).toEqual({ result: { exitCode: 0, stdout: "echo hi", stderr: "" } });
    expect(await ops["machine.snapshot"]!(frame("machine.snapshot", { machineId: "c1", name: "v1", life: { firstLife: true } }))).toEqual({ snapshotId: "sha256:v1" });
    expect(await ops["machine.state"]!(frame("machine.state", { machineId: "c1" }))).toEqual({ state: "running" });
    expect(await ops["machine.describe"]!(frame("machine.describe", { machineId: "c1" }))).toEqual({ shape: { cpu: 2, memMb: 4096 } });
    expect(await ops["machine.facts"]!(frame("machine.facts", { machineId: "c1" }))).toEqual({ facts: { os: "Linux", uptimeMs: 10, folder: "/root" } });
    expect(await ops["machine.daemonAnswers"]!(frame("machine.daemonAnswers", { machineId: "c1", timeoutMs: 10 }))).toEqual({ answers: true });
    expect(await ops["machine.previewUrl"]!(frame("machine.previewUrl", { machineId: "c1", port: 7070 }))).toEqual({ reach: { url: "http://127.0.0.1:37070", token: "", expiresAt: 1 } });
    expect(await ops["machine.downloadUrl"]!(frame("machine.downloadUrl", { machineId: "c1", path: "/root/a" }))).toEqual({ url: "https://down/root/a" });
    expect(await ops["machine.uploadUrl"]!(frame("machine.uploadUrl", { machineId: "c1", path: "/root/a" }))).toEqual({ url: "https://up/root/a" });
    expect(await ops["machine.listSnapshots"]!(frame("machine.listSnapshots"))).toEqual({ snapshots: [{ id: "sha256:a", sizeBytes: 10 }] });
    expect(await ops["machine.promoteSnapshot"]!(frame("machine.promoteSnapshot", { snapshotId: "sha256:a", name: "dev" }))).toEqual({ templateId: "wsp/dev:template" });
    expect(await ops["machine.listTemplates"]!(frame("machine.listTemplates"))).toMatchObject({ templates: [{ id: "wsp/dev:template" }] });
    expect(await ops["machine.getTemplate"]!(frame("machine.getTemplate", { templateId: "wsp/dev:template" }))).toMatchObject({ template: { id: "wsp/dev:template" } });
    await ops["machine.pause"]!(frame("machine.pause", { machineId: "c1" }));
    await ops["machine.resume"]!(frame("machine.resume", { machineId: "c1" }));
    expect(backend.machines.get("c1")!.asked).toContain("pause");
    expect(backend.machines.get("c1")!.asked).toContain("resume");
  });

  it("answers a machine the backend lost with the backend's own kind, so the host reads it as missing", async () => {
    const ops = machineOps("docker", fakeBackend(), tmp("wsp-put-"));
    await expect(ops["machine.get"]!(frame("machine.get", { machineId: "gone" }))).rejects.toMatchObject({ kind: "missing", status: 404 });
  });

  it("holds a handle by id and drops it at the kill, so the next frame asks the backend again", async () => {
    const backend = fakeBackend();
    const ops = machineOps("docker", backend, tmp("wsp-put-"));
    await ops["machine.exec"]!(frame("machine.exec", { machineId: "c1", cmd: "one" }));
    await ops["machine.exec"]!(frame("machine.exec", { machineId: "c1", cmd: "two" }));
    expect(backend.gets).toEqual(["c1"]);
    await ops["machine.kill"]!(frame("machine.kill", { machineId: "c1" }));
    await ops["machine.exec"]!(frame("machine.exec", { machineId: "c1", cmd: "three" }));
    expect(backend.gets).toEqual(["c1", "c1"]);
  });

  it("assembles the parts of an upload and lands the whole of it, leaving no part behind", async () => {
    const put: { path: string; bytes: Uint8Array }[] = [];
    const putDir = tmp("wsp-put-");
    const ops = machineOps("docker", fakeBackend(put), putDir);
    const bytes = Buffer.from("one two three");
    await ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c1", path: "/root/a", uploadId: "u1", seq: 0, last: false, data: bytes.subarray(0, 4).toString("base64") }));
    await ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c1", path: "/root/a", uploadId: "u1", seq: 1, last: true, data: bytes.subarray(4).toString("base64") }));
    expect(put).toHaveLength(1);
    expect(put[0]!.path).toBe("/root/a");
    expect(Buffer.from(put[0]!.bytes).toString()).toBe("one two three");
    expect(readdirSync(putDir)).toEqual([]);
  });

  it("refuses a part out of order, drops the upload and lands nothing", async () => {
    const put: { path: string; bytes: Uint8Array }[] = [];
    const putDir = tmp("wsp-put-");
    const ops = machineOps("docker", fakeBackend(put), putDir);
    await ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c1", path: "/root/a", uploadId: "u1", seq: 0, last: false, data: "AAAA" }));
    await expect(ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c1", path: "/root/a", uploadId: "u1", seq: 5, last: true, data: "AAAA" }))).rejects.toThrow(/out of order/);
    expect(put).toEqual([]);
    expect(readdirSync(putDir)).toEqual([]);
  });

  it("refuses an upload that changes the machine it was carrying to", async () => {
    const putDir = tmp("wsp-put-");
    const ops = machineOps("docker", fakeBackend(), putDir);
    await ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c1", path: "/root/a", uploadId: "u1", seq: 0, last: false, data: "AAAA" }));
    await expect(ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c2", path: "/root/a", uploadId: "u1", seq: 1, last: true, data: "AAAA" }))).rejects.toThrow(/dropped/);
  });

  it("refuses a frame the protocol would not have sent, so the shape on the wire is read once and here", async () => {
    const ops = machineOps("docker", fakeBackend(), tmp("wsp-put-"));
    // An upload id is a name and never a path: the far side keeps a file under it while the parts arrive.
    await expect(ops["machine.putBytes"]!(frame("machine.putBytes", { machineId: "c1", path: "/root/a", uploadId: "../escape", seq: 0, last: true, data: "AAAA" }))).rejects.toThrow();
    // A command over the body cap, and a machine id that is not a string, are refused before the backend is asked.
    await expect(ops["machine.exec"]!(frame("machine.exec", { machineId: "c1", cmd: "x".repeat(EXEC_BODY_MAX + 1) }))).rejects.toThrow();
    await expect(ops["machine.state"]!(frame("machine.state", { machineId: 7 }))).rejects.toThrow();
  });
});

describe("what a joined computer offers", () => {
  it("answers the first offer whose backend is there", async () => {
    const backend = fakeBackend();
    const offer = await offeredBackend({}, [{ id: "docker", build: () => backend }]);
    expect(offer).toEqual({ id: "docker", backend });
  });

  it("answers nothing when the backend refuses the one read it makes", async () => {
    const refusing = { ...fakeBackend(), checkKey: async () => Promise.reject(new Error("no daemon here")) };
    expect(await offeredBackend({}, [{ id: "docker", build: () => refusing }])).toBeUndefined();
  });

  it("offers Docker, reads the daemon the environment names, and naps by stopping so an idle machine costs nothing", () => {
    expect(PLACE_OFFERS.map(o => o.id)).toEqual(["docker"]);
    const built = PLACE_OFFERS[0]!.build({ DOCKER_HOST: "unix:///tmp/nope.sock" });
    expect(built).toBeInstanceOf(DockerBackend);
    expect(built.capabilities.pauseMode).toBe("disk");
  });
});

describe("the whole road, over a daemon link a place proved", () => {
  const linked = async (ops: Record<string, unknown> | undefined, engineSocket?: string) => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const file = testPlaceFile([host.url], key.publicKey, placePair().privateKeyPem);
    const root = tmp("wsp-link-root-");
    const backend = engineSocket === undefined ? undefined : new DockerBackend({ host: `unix://${engineSocket}` });
    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "link-token",
      kind: "place",
      root,
      inboxDir: root,
      rootsPath: join(root, "roots"),
      link: {
        file,
        report,
        onLeave: async () => [],
        ...(backend !== undefined ? { ops: machineOps("docker", backend, join(root, "put")) } : ops !== undefined ? { ops: ops as never } : {}),
      },
    });
    daemons.push(daemon);
    return { daemon, socket: await host.socket, root };
  };

  it("drives the Docker backend on the far side, byte for byte, through the proxy", async () => {
    const engine = new FakeEngine();
    await engine.start();
    try {
      engine.json("GET", /^\/info$/, { NCPU: 4, MemTotal: 4 * 1024 * 1024 * 1024, DockerRootDir: "/" });
      engine.json("POST", /^\/containers\/create$/, { Id: "c1" });
      engine.json("POST", /^\/containers\/c1\/start$/, {});
      engine.json("GET", /^\/containers\/c1\/json$/, {
        Id: "c1",
        Created: "2026-09-12T00:00:00.000Z",
        State: { Status: "running" },
        Config: { Labels: { wsp: "1" } },
        HostConfig: { Memory: 1024 * 1024 * 1024, NanoCpus: 2_000_000_000 },
        NetworkSettings: { Ports: { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "49155" }] } },
      });
      engine.json("GET", /^\/containers\/json$/, [{ Id: "c1", State: "running", Labels: { wsp: "1" } }]);
      engine.json("POST", /^\/commit$/, { Id: "sha256:committed" });
      engine.json("POST", /^\/containers\/c1\/pause$/, {});
      engine.json("POST", /^\/containers\/c1\/unpause$/, {});
      engine.json("DELETE", /^\/containers\/c1$/, {});
      engine.json("GET", /^\/images\/json$/, []);
      const { socket } = await linked(undefined, engine.socketPath);
      const link = linkOver(socket as unknown as WebSocket);
      const backend = await LinkBackend.open(link);
      expect(backend.capabilities.diskSnapshots).toBe(true);
      const machine = await backend.create({ kind: "sandbox", template: "ubuntu:24.04", memMb: 1024, cpu: 2 });
      expect(machine.id).toBe("c1");
      expect(engine.took("POST", "/containers/create")).toBeDefined();
      expect(await machine.state()).toBe("running");
      expect(await machine.snapshot("v1", { firstLife: true })).toBe("sha256:committed");
      await machine.pause();
      await machine.resume();
      expect(engine.took("POST", "/containers/c1/pause")).toBeDefined();
      expect(engine.took("POST", "/containers/c1/unpause")).toBeDefined();
      // The route the far side published, on its own loopback: the forward is what turns it into one here.
      expect((await machine.previewUrl!(7070)).url).toBe("http://127.0.0.1:49155");
      expect(await backend.list({ wsp: "1" })).toEqual([{ id: "c1", state: "running", labels: { wsp: "1" } }]);
      expect((await backend.capacity()).cores).toBe(4);
      await machine.kill();
      expect(engine.took("DELETE", "/containers/c1")).toBeDefined();
    } finally {
      await engine.stop();
    }
  });

  it("answers a machine op on a socket that is not the link with the one sentence for it", async () => {
    const { daemon, socket } = await linked({ "machine.backend": async () => ({}) });
    void socket;
    const inbound = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
    sockets.push(inbound);
    const answers: Record<string, unknown>[] = [];
    inbound.on("message", raw => answers.push(JSON.parse(String(raw)) as Record<string, unknown>));
    await new Promise<void>(done => inbound.once("open", () => done()));
    inbound.send(JSON.stringify({ id: 1, op: "auth", token: "link-token" }));
    await settled(50);
    inbound.send(JSON.stringify({ id: 2, op: "machine.backend" }));
    await settled(50);
    expect(answers.find(a => a["id"] === 2)).toMatchObject({ ok: false, error: NOT_ON_THIS_ROAD });
    // The leave op reads the same sentence on the same socket: one rule, one refusal.
    inbound.send(JSON.stringify({ id: 3, op: "place.leave" }));
    await settled(50);
    expect(answers.find(a => a["id"] === 3)).toMatchObject({ ok: false, error: NOT_ON_THIS_ROAD });
  });

  it("answers unknown op on a link whose computer offers no backend at all", async () => {
    const { socket } = await linked(undefined);
    const link = linkOver(socket as unknown as WebSocket);
    await expect(link.request("machine.backend")).rejects.toThrow(/unknown op/);
  });
});
