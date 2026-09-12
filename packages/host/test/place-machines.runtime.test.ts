// SPDX-License-Identifier: AGPL-3.0-only
// The round trip of place-machines.test.ts with this computer's own workspace
// runtime on the far side: the Rust daemon, started by the test as a place with
// a throwaway root, answering the same frames from the kernel instead of a
// Docker daemon. One daemon serves every case here, so the file holds its own
// lifecycle instead of the Docker file's per-case sweep. Root, cgroup v2 and a
// registry are what it needs, so it runs under WSP_RUNTIME_LIVE=1 alone. The last case deploys the daemon onto a
// workspace and reads its hello back through the forward, which takes apt, nodejs.org and npm from inside.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { DaemonEvent } from "@wsp/protocol";
import { LinkBackend, OWNER_LABEL, type ExecResult, type Machine, type MachineSpec } from "@wsp/engine";
import { connectDaemon } from "@wsp/runtime";
import { closeFakePlaceHosts, fakePlaceHost, placePair, testPlaceFile } from "../../daemon/test/fake-place-host.js";
import { spawnDaemon, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { deployDaemon } from "../src/doctor.js";
import { linkOver } from "./machine-link.js";

const RUNTIME_LIVE = process.env["WSP_RUNTIME_LIVE"] === "1";
const RUNTIME_BIN = process.env["WSP_DAEMON_BIN"] ?? fileURLToPath(new URL("../../../daemon/target/release/wsp-daemon", import.meta.url));
/** This run's own label, so two suites on one box never list or kill each other's workspaces. */
const LIVE_OWNER = `live-665-${process.pid}`;
const CGROUPS = "/sys/fs/cgroup/wsp";
/** A line answered on the workspace's port 7070 from every address it has; the base image carries perl and nothing
 * else that listens. */
const ANSWER_ON_7070 = "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"0.0.0.0\", LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die $!; while ($c = $s->accept) { print $c \"hello from inside\\n\"; close $c }' > /dev/null 2> /tmp/listen.err & sleep 0.5; cat /tmp/listen.err";

/** One line read off a fresh connection to the box's loopback port, inside two seconds. */
const readLine = (port: number): Promise<string> =>
  new Promise((done, fail) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    socket.setTimeout(2_000, () => fail(new Error(`127.0.0.1:${port} answered nothing in 2 s`)));
    socket.on("data", chunk => {
      text += String(chunk);
      if (text.includes("\n")) socket.end();
    });
    socket.on("error", fail);
    socket.on("close", () => done(text.trim()));
  });

describe.skipIf(!RUNTIME_LIVE)("the whole road, over a daemon link a place proved, with the runtime on the far side", () => {
  let daemon: DaemonUnderTest;
  let backend: LinkBackend;
  let root: string;
  const made: Machine[] = [];
  const times: Record<string, number> = {};
  /** The daemon's home and its runtime root, removed once at the end: the root holds a mounted rootfs for as long
   * as a workspace runs. */
  const own: string[] = [];
  const ownDir = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), name));
    own.push(dir);
    return dir;
  };

  const create = async (spec: MachineSpec): Promise<Machine> => {
    const started = Date.now();
    const machine = await backend.create({ ...spec, labels: { [OWNER_LABEL]: LIVE_OWNER, ...spec.labels } });
    times["create to ready"] = Date.now() - started;
    made.push(machine);
    return machine;
  };
  const exec = async (machine: Machine, cmd: string): Promise<ExecResult> => machine.exec(cmd, { timeoutMs: 60_000 });
  const cgroupOf = (id: string): string => join(CGROUPS, id);

  beforeAll(async () => {
    const key = placePair();
    const host = await fakePlaceHost({ key });
    const file = testPlaceFile([host.url], key.publicKey, placePair().privateKeyPem);
    const home = ownDir("wsp-runtime-home-");
    root = ownDir("wsp-runtime-root-");
    const tokenPath = join(home, "token");
    writeFileSync(tokenPath, "link-token\n");
    daemon = await spawnDaemon(RUNTIME_BIN, { host: "127.0.0.1", port: 0, tokenPath, kind: "place", root: home, home, placeFile: file, rootsPath: join(home, "roots"), runtimeRoot: root }, { startMs: 20_000 });
    const socket = await host.socket;
    backend = await LinkBackend.open(linkOver(socket as unknown as WebSocket));
    expect(backend.capabilities.pauseMode).toBe("disk");
    expect(backend.capabilities.diskSnapshots).toBe(true);
  }, 60_000);

  afterAll(async () => {
    const ids = made.map(machine => machine.id);
    for (const machine of made.splice(0)) await machine.kill().catch(() => undefined);
    expect(await backend.list({ [OWNER_LABEL]: LIVE_OWNER })).toEqual([]);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(root);
    // Only this run's cgroups: another suite on the box may have workspaces of its own.
    expect(existsSync(CGROUPS) ? readdirSync(CGROUPS).filter(name => ids.includes(name)) : []).toEqual([]);
    const status = readFileSync(`/proc/${daemon.pid}/status`, "utf8");
    times["daemon VmRSS kB"] = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1]);
    await daemon.close();
    await closeFakePlaceHosts();
    for (const dir of own.splice(0)) rmSync(dir, { recursive: true, force: true });
    console.log(`runtime timings: ${JSON.stringify(times)}`);
  }, 60_000);

  it("builds the container from the spec: image, limits, labels, envs and the boot command", async () => {
    const key = `live-665-build-${process.pid}`;
    const machine = await create({ kind: "sandbox", template: "ubuntu:24.04", cpu: 2, memMb: 1024, envs: { WSP_TOKEN: "t" }, labels: { row: "build" }, idempotencyKey: key });
    expect(machine.id).toBe(`wsp-${key}`);
    expect(await machine.state()).toBe("running");
    const seen = await exec(machine, "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.swap.max; echo $WSP_TOKEN; hostname; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done");
    expect(seen.exitCode).toBe(0);
    const lines = seen.stdout.split("\n");
    expect(lines.slice(0, 5)).toEqual(["1073741824", "200000 100000", "0", "t", `wsp-${key}`]);
    expect(seen.stdout).toContain("exec sleep infinity");
    const again = await backend.create({ kind: "sandbox", idempotencyKey: key });
    expect(again.id).toBe(machine.id);
    expect(again.replayed).toBe(true);
    expect(await machine.describe!()).toMatchObject({ cpu: 2, memMb: 1024 });
  }, 120_000);

  it("holds a machine's size to what the box has, since a limit the box cannot keep takes its neighbours down", async () => {
    const capacity = await backend.capacity();
    const machine = await create({ kind: "sandbox", cpu: 512, memMb: 9_000_000 });
    expect(await machine.describe!()).toMatchObject({ cpu: capacity.cores, memMb: capacity.machineMemMb });
    expect((await exec(machine, "cat /sys/fs/cgroup/memory.max")).stdout.trim()).toBe(String(capacity.machineMemMb * 1024 * 1024));
  }, 60_000);

  it("answers exec with stdout, stderr and the exit code", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await exec(machine, "echo out; echo err >&2; echo $HOME; exit 7")).toEqual({ exitCode: 7, stdout: "out\n/root\n", stderr: "err\n" });
    const rounds = 20;
    const started = Date.now();
    for (let i = 0; i < rounds; i++) await exec(machine, "true");
    times["exec round trip"] = (Date.now() - started) / rounds;
    expect((await machine.exec("sleep 30; echo late", { timeoutMs: 300 })).exitCode).toBe(124);
  }, 60_000);

  it("pauses and resumes with the freezer", async () => {
    const machine = await create({ kind: "sandbox", memMb: 512 });
    await machine.pause();
    expect(await machine.state()).toBe("paused");
    expect(readFileSync(join(cgroupOf(machine.id), "cgroup.events"), "utf8")).toContain("frozen 1");
    times["frozen memory.current bytes"] = Number(readFileSync(join(cgroupOf(machine.id), "memory.current"), "utf8").trim());
    expect((await backend.capacity()).machines.paused).toBe(1);
    await machine.resume();
    expect(await machine.state()).toBe("running");
    expect(readFileSync(join(cgroupOf(machine.id), "cgroup.events"), "utf8")).toContain("frozen 0");
    expect((await exec(machine, "echo awake")).stdout).toBe("awake\n");
  }, 60_000);

  it("kills by removing the container it was given, and nothing of it stays on the box", async () => {
    const machine = await create({ kind: "sandbox" });
    const id = machine.id;
    await machine.kill();
    made.splice(made.indexOf(machine), 1);
    await expect(machine.state()).rejects.toMatchObject({ kind: "missing", status: 404 });
    expect(existsSync(cgroupOf(id))).toBe(false);
    expect(existsSync(join(root, "run", id))).toBe(false);
    expect(readFileSync("/proc/self/mountinfo", "utf8")).not.toContain(join(root, "run", id));
  }, 60_000);

  it("maps every container state, and a container the daemon lost is gone", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await machine.state()).toBe("running");
    await machine.pause();
    expect(await machine.state()).toBe("paused");
    await machine.resume();
    expect(await machine.state()).toBe("running");
    await expect(backend.get("wsp-nobody")).rejects.toMatchObject({ kind: "missing", status: 404, message: "no such workspace: wsp-nobody" });
  }, 60_000);

  it("lists by our labels and answers the size the listing carries", async () => {
    const machine = await create({ kind: "sandbox", cpu: 2, memMb: 1024, labels: { row: "listed" } });
    expect(await backend.list({ row: "listed" })).toEqual([{ id: machine.id, state: "running", labels: { wsp: "1", [OWNER_LABEL]: LIVE_OWNER, row: "listed" }, size: { cpu: 2, memMb: 1024 } }]);
  }, 60_000);

  it("puts bytes where they belong, in parts, and lands the whole file", async () => {
    const machine = await create({ kind: "sandbox" });
    const bytes = randomBytes(5 * 1024 * 1024);
    await machine.putBytes!("/root/wsp daemon/bundle.tgz", bytes);
    const seen = await exec(machine, "sha256sum '/root/wsp daemon/bundle.tgz' | cut -d' ' -f1");
    expect(seen.stdout.trim()).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readdirSync(join(root, "put")).length).toBe(0);
  }, 60_000);

  it("serves no signed URL and says where the bytes go instead", async () => {
    const machine = await create({ kind: "sandbox" });
    await expect(machine.uploadUrl("/root/x")).rejects.toThrow(/no signed upload URL/);
    await expect(machine.downloadUrl("/root/x")).rejects.toThrow(/no signed download URL/);
  }, 60_000);

  it("asks the guest itself whether the daemon is listening, on the road every other call to it takes", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await machine.daemonAnswers!({ timeoutMs: 5_000 })).toBe(false);
    // The base image carries perl and nothing else that listens; the listener sits on the guest's own loopback.
    const listen = await exec(machine, "nohup perl -MIO::Socket::INET -e '$s = IO::Socket::INET->new(LocalAddr => \"127.0.0.1\", LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die $!; sleep 60' > /dev/null 2> /tmp/listen.err & sleep 0.5; cat /tmp/listen.err");
    expect(listen).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await machine.daemonAnswers!({ timeoutMs: 5_000 })).toBe(true);
  }, 60_000);

  it("says a container's daemon is the container's own boot, not a service manager", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(machine.daemonSupervisor).toBe("entrypoint");
    expect((await backend.get(machine.id)).daemonSupervisor).toBe("entrypoint");
  }, 60_000);

  it("describes the container from its record", async () => {
    const machine = await create({ kind: "sandbox", cpu: 1, memMb: 768 });
    const shape = await machine.describe!();
    expect(shape).toMatchObject({ cpu: 1, memMb: 768 });
    expect(shape.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  }, 60_000);

  it("answers the daemon road at the published port on the box's loopback", async () => {
    const machine = await create({ kind: "sandbox" });
    expect(await exec(machine, ANSWER_ON_7070)).toMatchObject({ exitCode: 0, stderr: "" });
    const started = Date.now();
    const reach = await machine.previewUrl!(7070);
    times["previewUrl"] = Date.now() - started;
    // The route the far side published, on its own loopback: the forward is what turns it into one here, and here
    // the forward is the identity since this test runs on the box.
    expect(reach.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(reach.token).toBe("");
    const port = Number(new URL(reach.url).port);
    expect(await readLine(port)).toBe("hello from inside");
    expect((await machine.previewUrl!(7070)).url).toBe(reach.url);
  }, 60_000);

  it("carries a daemon deployed onto a workspace back through the forward, and connectDaemon reads its hello", async () => {
    const machine = await create({ kind: "sandbox", cpu: 2, memMb: 2048 });
    // The deploy itself needs nothing installed now that the daemon is one static binary; what a bare image lacks
    // for the turns after it comes in over the workspace's own outbound road.
    const started = Date.now();
    const apt = await machine.exec(
      "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq > /tmp/apt.log 2>&1 && apt-get install -y -qq curl ca-certificates python3 make g++ >> /tmp/apt.log 2>&1; echo apt $?; tail -c 300 /tmp/apt.log",
      { timeoutMs: 600_000 },
    );
    expect(apt.stdout, apt.stdout).toContain("apt 0");
    times["apt install curl ca-certificates python3 make g++"] = Date.now() - started;
    const deploying = Date.now();
    const { token } = await deployDaemon(machine, { token: randomBytes(24).toString("hex") });
    times["deployDaemon"] = Date.now() - deploying;
    expect(await machine.daemonAnswers!({ timeoutMs: 10_000 })).toBe(true);
    const reach = await machine.previewUrl!(7070);
    const events: DaemonEvent[] = [];
    const link = connectDaemon({ previewUrl: reach.url, token, onEvent: e => events.push(e) });
    try {
      await link.ready;
      expect(events.find(e => e.type === "daemon.hello")).toMatchObject({ type: "daemon.hello" });
      expect((events.find(e => e.type === "daemon.hello") as { root: string }).root).toMatch(/^\//);
    } finally {
      link.close();
    }
  }, 900_000);

  it("holds a memory cap: 700 MB touched under a 512 MB cap exits 137", async () => {
    const machine = await create({ kind: "sandbox", memMb: 512 });
    const hog = await exec(machine, "perl -e '$x = \"x\" x (700 * 1024 * 1024); print length($x)'");
    expect(hog.exitCode).toBe(137);
    // The hog is the kill, never the workspace's own init: its exec and its init carry the kernel's default score.
    expect(await machine.state()).toBe("running");
    expect((await exec(machine, "cat /sys/fs/cgroup/memory.events")).stdout).toContain("oom_kill 1");
    expect((await exec(machine, "echo alive")).stdout).toBe("alive\n");
  }, 60_000);
});
