// SPDX-License-Identifier: AGPL-3.0-only
// The Docker backend against a fake Engine API in this process: a real HTTP
// server on a unix socket, so the dial, the request line, the query and the
// bodies are the ones a daemon would read.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCKER_BOOT_CMD, DOCKER_LIFECYCLE, DOCKER_PRICING, DockerBackend, HOSTNAME_MAX, parseDockerHost } from "../src/docker-backend.js";
import { OWNER_LABEL, WSP_LABEL } from "../src/labels.js";
import { FakeEngine, frame } from "./fake-docker-engine.js";

const RUNNING = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  Id: id,
  Created: "2026-09-11T02:00:00.000Z",
  State: { Status: "running" },
  Config: { Labels: { [WSP_LABEL]: "1" } },
  HostConfig: { Memory: 1024 * 1024 * 1024, NanoCpus: 2_000_000_000 },
  NetworkSettings: { Ports: { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "49155" }] } },
  ...extra,
});

describe("parseDockerHost", () => {
  it("takes this computer's own socket when nothing names a daemon", () => {
    expect(parseDockerHost(undefined)).toEqual({ kind: "unix", path: "/var/run/docker.sock" });
    expect(parseDockerHost("")).toEqual({ kind: "unix", path: "/var/run/docker.sock" });
  });

  it("reads a unix, a tcp and an ssh dial", () => {
    expect(parseDockerHost("unix:///tmp/d.sock")).toEqual({ kind: "unix", path: "/tmp/d.sock" });
    expect(parseDockerHost("tcp://box.example:2376")).toEqual({ kind: "tcp", host: "box.example", port: 2376, tls: true });
    expect(parseDockerHost("tcp://box.example:2375")).toEqual({ kind: "tcp", host: "box.example", port: 2375, tls: false });
    expect(parseDockerHost("ssh://maya@127.0.0.1:2222")).toEqual({ kind: "ssh", user: "maya", host: "127.0.0.1", port: 2222 });
    expect(parseDockerHost("ssh://box.example")).toEqual({ kind: "ssh", user: "", host: "box.example", port: 22 });
  });

  it("refuses a dial it has no road for", () => {
    expect(() => parseDockerHost("npipe:////./pipe/docker_engine")).toThrow(/npipe/);
  });
});

describe("DockerBackend against a fake Engine API", () => {
  let engine: FakeEngine;
  let backend: DockerBackend;

  beforeEach(async () => {
    engine = new FakeEngine();
    await engine.start();
    backend = new DockerBackend({ host: `unix://${engine.socketPath}` });
  });

  afterEach(async () => {
    await engine.stop();
  });

  it("says what this computer has left for one more machine", async () => {
    engine.json("GET", /^\/info$/, { NCPU: 4, MemTotal: 4 * 1024 * 1024 * 1024, DockerRootDir: "/var/lib/docker" });
    // The listing carries no memory at all, as a real daemon's does not: the limits are read per container.
    engine.json("GET", /^\/containers\/json$/, [
      { Id: "a", State: "running", HostConfig: { NetworkMode: "bridge" } },
      { Id: "b", State: "paused", HostConfig: { NetworkMode: "bridge" } },
      { Id: "c", State: "exited", HostConfig: { NetworkMode: "bridge" } },
    ]);
    engine.json("GET", /^\/containers\/a\/json$/, { Id: "a", State: { Status: "running" }, HostConfig: { Memory: 1024 * 1024 * 1024 } });
    engine.json("GET", /^\/containers\/b\/json$/, { Id: "b", State: { Status: "paused" }, HostConfig: { Memory: 512 * 1024 * 1024 } });
    engine.json("GET", /^\/images\/json$/, [{ Id: "sha256:img", Size: 4200, Labels: { "wsp-snapshot": "v1" } }]);
    const statted: string[] = [];
    const reading = new DockerBackend({
      host: `unix://${engine.socketPath}`,
      statfs: async path => {
        statted.push(path);
        return { bavail: 10, bsize: 100 };
      },
    });
    const capacity = await reading.capacity();
    expect(statted).toEqual(["/var/lib/docker"]);
    expect(capacity.cores).toBe(4);
    expect(capacity.memMb).toBe(4096);
    // Half the box less what the live containers are allowed; the exited one is not one of them.
    expect(capacity.memRoomMb).toBe(2048 - 1024 - 512);
    // The most one machine may name here, whatever it asks for: half the box, the share a limit is held to.
    expect(capacity.machineMemMb).toBe(2048);
    expect(capacity.diskFreeBytes).toBe(1000);
    expect(capacity.images).toEqual([{ id: "sha256:img", name: "v1", sizeBytes: 4200 }]);
    expect(capacity.machines).toEqual({ running: 1, paused: 1 });
  });

  it("never says the memory room is below none, whatever the containers were given", async () => {
    engine.json("GET", /^\/info$/, { NCPU: 2, MemTotal: 1024 * 1024 * 1024 });
    engine.json("GET", /^\/containers\/json$/, [{ Id: "a", State: "running" }]);
    engine.json("GET", /^\/containers\/a\/json$/, { Id: "a", State: { Status: "running" }, HostConfig: { Memory: 4096 * 1024 * 1024 } });
    engine.json("GET", /^\/images\/json$/, []);
    const reading = new DockerBackend({ host: `unix://${engine.socketPath}`, statfs: async () => ({ bavail: 0, bsize: 0 }) });
    expect((await reading.capacity()).memRoomMb).toBe(0);
  });

  it("naps by the freezer and wakes from it, where a machine must keep what its processes hold", async () => {
    engine.json("POST", /^\/containers\/c1\/pause$/, {});
    engine.json("POST", /^\/containers\/c1\/unpause$/, {});
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const machine = await backend.get("c1");
    await machine.pause();
    await machine.resume();
    expect(engine.took("POST", "/containers/c1/pause")).toBeDefined();
    expect(engine.took("POST", "/containers/c1/unpause")).toBeDefined();
    expect(backend.capabilities.pauseMode).toBe("memory");
  });

  it("naps by stopping and wakes by starting where the computer keeps no memory for an idle machine", async () => {
    const stopping = new DockerBackend({ host: `unix://${engine.socketPath}`, pauseMode: "disk" });
    engine.json("POST", /^\/containers\/c1\/stop$/, {});
    engine.json("POST", /^\/containers\/c1\/start$/, {});
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const machine = await stopping.get("c1");
    await machine.pause();
    await machine.resume();
    expect(engine.took("POST", "/containers/c1/stop")).toBeDefined();
    expect(engine.took("POST", "/containers/c1/start")).toBeDefined();
    expect(stopping.capabilities.pauseMode).toBe("disk");
  });

  it("reads a stopped container as napping where a nap is a stop, and as gone where it is the freezer", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, { ...RUNNING("c1"), State: { Status: "exited" } });
    engine.json("GET", /^\/containers\/json$/, [{ Id: "c1", State: "exited" }]);
    const stopping = new DockerBackend({ host: `unix://${engine.socketPath}`, pauseMode: "disk" });
    expect(await (await stopping.get("c1")).state()).toBe("paused");
    expect((await stopping.list())[0]!.state).toBe("paused");
    expect(await (await backend.get("c1")).state()).toBe("gone");
    expect((await backend.list())[0]!.state).toBe("gone");
  });

  it("counts every machine it holds, napping ones included, and only what holds memory against the room", async () => {
    engine.json("GET", /^\/info$/, { NCPU: 4, MemTotal: 4 * 1024 * 1024 * 1024, DockerRootDir: "/" });
    engine.json("GET", /^\/containers\/json$/, [{ Id: "a", State: "running" }, { Id: "b", State: "exited" }]);
    engine.json("GET", /^\/containers\/a\/json$/, { Id: "a", State: { Status: "running" }, HostConfig: { Memory: 1024 * 1024 * 1024 } });
    engine.json("GET", /^\/images\/json$/, []);
    const stopping = new DockerBackend({ host: `unix://${engine.socketPath}`, pauseMode: "disk", statfs: async () => ({ bavail: 0, bsize: 0 }) });
    const capacity = await stopping.capacity();
    // The stopped one is a machine the person still has there, so the count carries it and the memory room does not.
    expect(capacity.machines).toEqual({ running: 1, paused: 1 });
    expect(capacity.memRoomMb).toBe(2048 - 1024);
    // Where a nap is the freezer, a stopped container is a machine that is gone and neither count carries it.
    const freezing = new DockerBackend({ host: `unix://${engine.socketPath}`, statfs: async () => ({ bavail: 0, bsize: 0 }) });
    expect((await freezing.capacity()).machines).toEqual({ running: 1, paused: 0 });
  });

  it("says what a container can and cannot do", () => {
    expect(backend.capabilities).toMatchObject({
      liveCloneForks: false,
      pauseMode: "memory",
      resize: false,
      // A container that exists takes no new size, and a fresh one from the same image stands in for it: the pair
      // that says the three verbs read three flags rather than one fact about forks.
      replacesMachine: true,
      previewUrls: false,
      signedUrls: false,
      containers: false,
      callbackRelay: true,
      diskSnapshots: true,
      snapshotListing: true,
      templates: true,
      kept: false,
    });
    expect(backend.capabilities.sizes).toEqual([
      { cpu: 2, memMb: 4096, rateUsdPerHour: 0 },
      { cpu: 4, memMb: 8192, rateUsdPerHour: 0 },
    ]);
    expect(backend.pricing.rateUsdPerHour({ cpu: 4, memMb: 8192 })).toBe(0);
    expect(DOCKER_PRICING.snapshotStorage).toEqual({ freeGb: 0, usdPerGbMonth: 0, billedFrom: "" });
    // One wake attempt: unpause is synchronous, so a failed check goes to the rebuild; no asking again, since the
    // daemon never leaves an unpause unanswered.
    expect(backend.lifecycle).toBe(DOCKER_LIFECYCLE);
    expect(DOCKER_LIFECYCLE.budgets).toEqual({ wakeAttempts: 1, daemonAnswersMs: 30_000 });
    expect(Object.isFrozen(DOCKER_LIFECYCLE)).toBe(true);
    expect(Object.isFrozen(DOCKER_LIFECYCLE.budgets)).toBe(true);
    expect(backend.pricing.builderDiskGb).toBeUndefined();
  });

  it("builds the container from the spec: image, limits, labels, envs and the boot command", async () => {
    engine.json("POST", /^\/containers\/create$/, { Id: "c1", Warnings: [] }, 201);
    engine.json("POST", /^\/containers\/c1\/start$/, {}, 204);
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));

    const machine = await backend.create({
      kind: "sandbox",
      template: "ubuntu:24.04",
      cpu: 2,
      memMb: 1024,
      diskGb: 20,
      envs: { WSP_TOKEN: "t" },
      labels: { [OWNER_LABEL]: "state-1" },
    });

    expect(machine.id).toBe("c1");
    const create = engine.took("POST", "/containers/create")!;
    expect(create.body).toMatchObject({
      Image: "ubuntu:24.04",
      Cmd: DOCKER_BOOT_CMD,
      Env: ["WSP_TOKEN=t"],
      Labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "state-1" },
      ExposedPorts: { "7070/tcp": {} },
      HostConfig: {
        Init: true,
        Memory: 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PortBindings: { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
        ExtraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    // A container's disk is the box's: no quota is asked for, since one needs xfs with pquota under the daemon.
    expect((create.body as { HostConfig: { StorageOpt?: unknown } }).HostConfig.StorageOpt).toBeUndefined();
    expect(create.query.get("name")).toMatch(/^wsp-/);
    expect(engine.took("POST", "/containers/c1/start")).toBeDefined();
  });

  it("holds a machine's size to what the box has, since a limit the box cannot keep takes its neighbours down", async () => {
    engine.json("GET", /^\/info$/, { MemTotal: 4 * 1024 * 1024 * 1024, NCPU: 4 });
    engine.json("POST", /^\/containers\/create$/, { Id: "c3" }, 201);
    engine.json("POST", /^\/containers\/c3\/start$/, {}, 204);
    await backend.create({ kind: "sandbox", cpu: 8, memMb: 8192 });
    expect((engine.took("POST", "/containers/create")!.body as { HostConfig: { Memory: number; NanoCpus: number } }).HostConfig).toMatchObject({
      Memory: 2048 * 1024 * 1024,
      NanoCpus: 4_000_000_000,
    });
  });

  it("fetches an image the box does not have, once, and boots from it", async () => {
    let creates = 0;
    engine.on("POST", /^\/containers\/create$/, (_seen, res) => {
      creates += 1;
      if (creates === 1) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "No such image: ubuntu:24.04" }));
        return;
      }
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ Id: "c4" }));
    });
    engine.on("POST", /^\/images\/create$/, (_seen, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"Pulling from library/ubuntu"}\n{"status":"Download complete"}\n');
    });
    engine.json("POST", /^\/containers\/c4\/start$/, {}, 204);
    const machine = await backend.create({ kind: "sandbox", template: "ubuntu:24.04" });
    expect(machine.id).toBe("c4");
    const pull = engine.took("POST", "/images/create")!;
    expect(pull.query.get("fromImage")).toBe("ubuntu");
    expect(pull.query.get("tag")).toBe("24.04");
    expect(creates).toBe(2);
  });

  it("does not go looking for a snapshot the box lost, since no registry has one", async () => {
    engine.json("POST", /^\/containers\/create$/, { message: "No such image: sha256:deadbeef" }, 404);
    await expect(backend.create({ kind: "sandbox", fromSnapshot: "sha256:deadbeef" })).rejects.toThrow(/No such image/);
    expect(engine.took("POST", "/images/create")).toBeUndefined();
  });

  it("says what the daemon said when a fetch answers 200 with an error in the stream", async () => {
    engine.json("POST", /^\/containers\/create$/, { message: "No such image: nope:1" }, 404);
    engine.on("POST", /^\/images\/create$/, (_seen, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"errorDetail":{"message":"pull access denied for nope"},"error":"pull access denied for nope"}\n');
    });
    await expect(backend.create({ kind: "sandbox", template: "nope:1" })).rejects.toThrow(/pull access denied/);
  });

  it("cuts a long name down to a host name the kernel takes", async () => {
    engine.json("POST", /^\/containers\/create$/, { Id: "c5" }, 201);
    engine.json("POST", /^\/containers\/c5\/start$/, {}, 204);
    await backend.create({ kind: "sandbox", idempotencyKey: `smoke-default-${"a".repeat(80)}` });
    const body = engine.took("POST", "/containers/create")!.body as { Hostname: string };
    expect(body.Hostname.length).toBe(HOSTNAME_MAX);
    // The container's own name keeps every character of the record it was made for; only the host name is cut.
    expect(engine.took("POST", "/containers/create")!.query.get("name")!.length).toBeGreaterThan(HOSTNAME_MAX);
  });

  it("removes a container the daemon would not start, since nobody else learns its id", async () => {
    engine.json("POST", /^\/containers\/create$/, { Id: "c6" }, 201);
    engine.json("POST", /^\/containers\/c6\/start$/, { message: "sethostname: invalid argument" }, 500);
    engine.json("DELETE", /^\/containers\/c6$/, {}, 204);
    await expect(backend.create({ kind: "sandbox" })).rejects.toThrow(/sethostname/);
    const removed = engine.took("DELETE", "/containers/c6")!;
    expect(removed.query.get("force")).toBe("true");
  });

  it("boots a fork from the committed image", async () => {
    engine.json("POST", /^\/containers\/create$/, { Id: "c2" }, 201);
    engine.json("POST", /^\/containers\/c2\/start$/, {}, 204);
    engine.json("GET", /^\/containers\/c2\/json$/, RUNNING("c2"));
    await backend.create({ kind: "sandbox", fromSnapshot: "sha256:abc", template: "ubuntu:24.04" });
    expect((engine.took("POST", "/containers/create")!.body as { Image: string }).Image).toBe("sha256:abc");
  });

  it("answers exec with stdout, stderr and the exit code", async () => {
    engine.json("POST", /^\/containers\/c1\/exec$/, { Id: "e1" }, 201);
    engine.on("POST", /^\/exec\/e1\/start$/, (_seen, res) => {
      res.writeHead(200, { "Content-Type": "application/vnd.docker.multiplexed-stream" });
      res.write(frame(1, "out\n"));
      res.write(frame(2, "err\n"));
      res.end();
    });
    engine.json("GET", /^\/exec\/e1\/json$/, { ExitCode: 7, Running: false });
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));

    const machine = await backend.get("c1");
    const res = await machine.exec("echo out");
    expect(res).toEqual({ exitCode: 7, stdout: "out\n", stderr: "err\n" });
    const create = engine.took("POST", "/containers/c1/exec")!;
    expect(create.body).toMatchObject({ AttachStdout: true, AttachStderr: true, Tty: false });
    const cmd = (create.body as { Cmd: string[] }).Cmd;
    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    // The guest carries HOME and USER ahead of every command, the way every wsp guest exec does.
    expect(cmd[2]).toContain("export HOME=/root");
    expect(cmd[2]).toContain("echo out");
  });

  it("commits a snapshot under the name and answers the image id", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.json("POST", /^\/commit$/, { Id: "sha256:img1" }, 201);
    const machine = await backend.get("c1");
    const id = await machine.snapshot("wsp-mac-default-v1", { firstLife: true });
    expect(id).toBe("sha256:img1");
    const commit = engine.took("POST", "/commit")!;
    expect(commit.query.get("container")).toBe("c1");
    expect(commit.query.get("repo")).toBe("wsp");
    expect(commit.query.get("tag")).toBe("wsp-mac-default-v1");
    expect(commit.query.get("pause")).toBe("true");
    expect(commit.body).toMatchObject({ Labels: { [WSP_LABEL]: "1", "wsp-snapshot": "wsp-mac-default-v1" } });
  });

  it("a commit after an unpause takes the life it is handed and commits: the disk is the same copy from any life", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.json("POST", /^\/containers\/c1\/pause$/, {}, 204);
    engine.json("POST", /^\/containers\/c1\/unpause$/, {}, 204);
    engine.json("POST", /^\/commit$/, { Id: "sha256:img2" }, 201);
    const machine = await backend.get("c1");
    await machine.pause();
    await machine.resume();
    expect(await machine.snapshot("wsp-mac-default-v2", { firstLife: false })).toBe("sha256:img2");
    expect(engine.took("POST", "/commit")!.query.get("tag")).toBe("wsp-mac-default-v2");
  });

  it("promotes a snapshot by tagging the image under the template name", async () => {
    engine.json("POST", /^\/images\/sha256:img1\/tag$/, {}, 201);
    const templateId = await backend.promoteSnapshot("sha256:img1", "wsp-mac-default-v1");
    expect(templateId).toBe("wsp/wsp-mac-default-v1:template");
    const tag = engine.took("POST", "/images/sha256:img1/tag")!;
    expect(tag.query.get("repo")).toBe("wsp/wsp-mac-default-v1");
    expect(tag.query.get("tag")).toBe("template");
  });

  it("lists snapshots with their sizes and leaves images that are not ours alone", async () => {
    engine.json("GET", /^\/images\/json$/, [
      { Id: "sha256:img1", RepoTags: ["wsp:wsp-mac-default-v1"], Size: 1234, Created: 1757000000, Labels: { [WSP_LABEL]: "1", "wsp-snapshot": "wsp-mac-default-v1" } },
    ]);
    const rows = await backend.listSnapshots();
    expect(rows).toEqual([{ id: "sha256:img1", name: "wsp-mac-default-v1", sizeBytes: 1234, createdAt: new Date(1757000000 * 1000).toISOString() }]);
    expect(engine.took("GET", "/images/json")!.query.get("filters")).toBe(JSON.stringify({ label: [`${WSP_LABEL}=1`] }));
  });

  it("pauses and resumes with the freezer", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.json("POST", /^\/containers\/c1\/pause$/, {}, 204);
    engine.json("POST", /^\/containers\/c1\/unpause$/, {}, 204);
    const machine = await backend.get("c1");
    await machine.pause();
    await machine.resume();
    expect(engine.took("POST", "/containers/c1/pause")).toBeDefined();
    expect(engine.took("POST", "/containers/c1/unpause")).toBeDefined();
  });

  it("kills by removing the container it was given, force and volumes", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.json("DELETE", /^\/containers\/c1$/, {}, 204);
    const machine = await backend.get("c1");
    await machine.kill();
    const rm = engine.took("DELETE", "/containers/c1")!;
    expect(rm.query.get("force")).toBe("true");
    expect(rm.query.get("v")).toBe("true");
  });

  it("maps every container state, and a container the daemon lost is gone", async () => {
    const states = { created: "starting", running: "running", restarting: "starting", paused: "paused", exited: "gone", dead: "gone", removing: "gone" } as const;
    for (const [status, expected] of Object.entries(states)) {
      const engineForState = new FakeEngine();
      await engineForState.start();
      engineForState.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1", { State: { Status: status } }));
      const b = new DockerBackend({ host: `unix://${engineForState.socketPath}` });
      expect(await (await b.get("c1")).state()).toBe(expected);
      await engineForState.stop();
    }
    engine.json("GET", /^\/containers\/gone\/json$/, { message: "No such container" }, 404);
    const machine = await backend.get("gone").catch(() => undefined);
    expect(machine).toBeUndefined();
  });

  it("lists by our labels and answers the size the listing carries", async () => {
    engine.json("GET", /^\/containers\/json$/, [
      { Id: "c1", State: "running", Labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "state-1" }, HostConfig: { Memory: 4294967296, NanoCpus: 2_000_000_000 } },
    ]);
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const rows = await backend.list({ [OWNER_LABEL]: "state-1" });
    expect(rows).toEqual([{ id: "c1", state: "running", labels: { [WSP_LABEL]: "1", [OWNER_LABEL]: "state-1" }, size: { cpu: 2, memMb: 4096 } }]);
    const listing = engine.took("GET", "/containers/json")!;
    expect(listing.query.get("all")).toBe("true");
    expect(JSON.parse(listing.query.get("filters")!)).toEqual({ label: [`${WSP_LABEL}=1`, `${OWNER_LABEL}=state-1`] });
  });

  it("puts bytes through the archive API as a one file tar", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.json("PUT", /^\/containers\/c1\/archive$/, {}, 200);
    const machine = await backend.get("c1");
    await machine.putBytes!("/root/wsp-daemon.tgz", Buffer.from("payload bytes"));
    const put = engine.took("PUT", "/containers/c1/archive")!;
    expect(put.query.get("path")).toBe("/root");
    expect(put.raw.subarray(0, 17).toString("utf8").replace(/\0+$/, "")).toBe("wsp-daemon.tgz");
    expect(put.raw.subarray(512, 512 + 13).toString("utf8")).toBe("payload bytes");
    // The tar ends with the two empty blocks a reader stops at.
    expect(put.raw.length % 512).toBe(0);
    expect(put.raw.subarray(put.raw.length - 1024).every(b => b === 0)).toBe(true);
  });

  it("serves no signed URL and says where the bytes go instead", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const machine = await backend.get("c1");
    await expect(machine.uploadUrl("/root/x")).rejects.toThrow(/archive/);
    await expect(machine.downloadUrl("/root/x")).rejects.toThrow(/archive/);
  });

  it("answers the daemon road at the published port on this computer's loopback", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const machine = await backend.get("c1");
    const reach = await machine.previewUrl!(7070);
    expect(reach.url).toBe("http://127.0.0.1:49155");
    expect(reach.token).toBe("");
  });

  it("answers the address a turn inside the container dials this computer at, which the daemon filled the gateway in for", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const machine = await backend.get("c1");
    expect(machine.hostUrl!(4700)).toBe("http://host.docker.internal:4700");
  });

  it("carries no route at all on a daemon that is not this computer's, since its loopback is not ours", async () => {
    // A machine that answered a route this host cannot dial reads as a fork whose daemon died: the wake re-pauses,
    // resurrects and redeploys it every time. Absent is what hasDaemon reads, and absent is the truth on a box.
    for (const host of ["ssh://maya@box.example", "tcp://box.example:2376"]) {
      const remote = new DockerBackend({ host, transport: () => ({ options: { socketPath: engine.socketPath } }) });
      engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
      const machine = await remote.get("c1");
      expect(machine.previewUrl).toBeUndefined();
      // The guest is still askable: no route is no reason for the status to call such a machine unsupported.
      expect(typeof machine.daemonAnswers).toBe("function");
      // And no address home either: the gateway that container reaches leads to the box, not to the computer this
      // host runs on, so a turn on it is told the address the host advertises or nothing at all.
      expect(machine.hostUrl).toBeUndefined();
      // The same reading tells the sign-in relay it has no road home.
      expect(remote.capabilities.callbackRelay).toBe(false);
    }
    expect(backend.capabilities.callbackRelay).toBe(true);
  });

  it("puts bytes under the caller's own bound, and cuts the call off at it", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    // The archive road answers late here, so a bound that is shorter than the answer is the only thing that can end
    // the call: without the forwarding the daemon's own pace stands and this waits the whole second.
    engine.on("PUT", /^\/containers\/c1\/archive$/, (_seen, res) => {
      setTimeout(() => res.writeHead(200).end("{}"), 1_000).unref();
    });
    const machine = await backend.get("c1");
    const started = Date.now();
    await expect(machine.putBytes!("/root/x.bin", new Uint8Array([1, 2, 3]), { timeoutMs: 100 })).rejects.toThrow(/did not answer PUT \/containers\/c1\/archive in 100ms/);
    expect(Date.now() - started).toBeLessThan(900);
    // The bytes still went up as the one file tar the road takes.
    expect(engine.took("PUT", "/containers/c1/archive")!.raw.subarray(512, 515)).toEqual(Buffer.from([1, 2, 3]));
  });

  it("leaves the daemon its own pace when the caller names no bound", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.on("PUT", /^\/containers\/c1\/archive$/, (_seen, res) => {
      setTimeout(() => res.writeHead(200).end("{}"), 200).unref();
    });
    const machine = await backend.get("c1");
    await machine.putBytes!("/root/x.bin", new Uint8Array([4, 5, 6]));
    expect(engine.took("PUT", "/containers/c1/archive")!.raw.subarray(512, 515)).toEqual(Buffer.from([4, 5, 6]));
  });

  it("asks the guest itself whether the daemon is listening, on the road every other call to it takes", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.json("POST", /^\/containers\/c1\/exec$/, { Id: "e1" }, 201);
    engine.on("POST", /^\/exec\/e1\/start$/, (_seen, res) => res.writeHead(200).end());
    let exit = 0;
    engine.on("GET", /^\/exec\/e1\/json$/, (_seen, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ExitCode: exit, Running: false })));

    const machine = await backend.get("c1");
    expect(await machine.daemonAnswers!()).toBe(true);
    // The guest's own loopback, never the published port: the published one is the Docker daemon's computer's.
    expect((engine.took("POST", "/containers/c1/exec")!.body as { Cmd: string[] }).Cmd[2]).toContain("(exec 3<>/dev/tcp/127.0.0.1/7070)");
    exit = 1;
    expect(await machine.daemonAnswers!()).toBe(false);
  });

  it("asks under the caller's own bound, and cuts the ask off at it", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    engine.on("POST", /^\/containers\/c1\/exec$/, (_seen, res) => {
      setTimeout(() => res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ Id: "e1" })), 1_000).unref();
    });
    const machine = await backend.get("c1");
    const started = Date.now();
    await expect(machine.daemonAnswers!({ timeoutMs: 100 })).rejects.toThrow(/did not answer POST \/containers\/c1\/exec in 100ms/);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it("says a container's daemon is the container's own boot, not a service manager", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    expect((await backend.get("c1")).daemonSupervisor).toBe("entrypoint");
  });

  it("describes the container from inspect", async () => {
    engine.json("GET", /^\/containers\/c1\/json$/, RUNNING("c1"));
    const machine = await backend.get("c1");
    expect(await machine.describe!()).toEqual({ cpu: 2, memMb: 1024, createdAt: "2026-09-11T02:00:00.000Z" });
  });

  it("boots from the image the backend names when nothing else does", () => {
    expect(backend.baseTemplates).toEqual({ sandbox: "ubuntu:24.04", desktop: "ubuntu:24.04" });
  });

  it("carries the daemon's answer into the failure", async () => {
    engine.json("POST", /^\/containers\/create$/, { message: "no such network: none" }, 400);
    await expect(backend.create({ kind: "sandbox", template: "nope:1" })).rejects.toThrow(/no such network/);
  });
});
