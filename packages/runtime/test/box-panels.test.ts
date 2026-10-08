// SPDX-License-Identifier: AGPL-3.0-only
// The panes of a thread in a folder on a computer the person joined: its ports,
// found by a watch of the folder's own over its threads' cgroups and opened here
// at the same number on demand; its processes in a cgroup per thread, which a
// stop and a delete end whole; its terminal on that computer, in the folder, as
// the login, with the environment the turn got; and the computer's readings.
// The computer is a fake on the link, keeping every frame the host sends it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join as joinPath } from "node:path";
import { createConnection, createServer, type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_VERSION, FORWARD_MAX_PER_TARGET, paneForwardCapLine, paneForwardFloorLine, paneForwardQuietLine, paneForwardStoppedLine, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, TURN_TOKEN_ENV, cgroupEndScript, cgroupJoinLine, threadCgroup, threadCgroupsEndScript, threadLeftLine, type TurnResult } from "@wsp/protocol";
import type { HarnessAdapterFactory, HarnessStartOptions } from "../src/runtime.js";
import type { DaemonChannel } from "../src/daemon-channel.js";
import { namedWatchRefusal } from "../src/account/box-panels.js";
import { ctx, sockets, serving, code, join, relink, placesOf, answersLeave, KEEPS_NO_IMAGE } from "./places-fixture.js";
import { until } from "./until.js";
import { report } from "./place-join.js";
import { fakeClock } from "./fake-clock.js";
import { WsClient } from "./ws-client.js";
import type { Clock } from "../src/clock.js";

interface Box {
  /** Every frame the host sent, op and all. */
  frames: Record<string, unknown>[];
  /** Every command an exec frame carried. */
  execs: string[];
  /** A turn's launch and a thread's end, as they reached the computer and as it answered them. */
  order: string[];
  client: WsClient;
}

/** How the fake computer answers: how long a thread's end takes there. */
interface BoxShape {
  endMs?: number;
  /** A thread's end there leaves a process standing, as one stuck in the kernel does. */
  endFails?: boolean;
  /** A thread's end there is never answered. */
  endHangs?: boolean;
}

/** A joined computer as its daemon answers the host: its login, a turn's launch and polls, and the panes' frames. */
function box(client: WsClient, login: { home: string; owner: string }, listening: () => number[], shape: BoxShape = {}): Box {
  const seen: Box = { frames: [], execs: [], order: [], client };
  let stopped = false;
  client.onFrame(raw => {
    const frame = raw as unknown as Record<string, unknown>;
    const op = typeof frame["op"] === "string" ? frame["op"] : undefined;
    if (op === undefined) return;
    seen.frames.push(frame);
    const say = (payload: Record<string, unknown>): void => client.say({ id: frame["id"], ok: true, ...payload });
    if (op === "machine.backend") return say(KEEPS_NO_IMAGE);
    if (op === "ports.watch") return say({ ports: listening().map(port => ({ port, pid: 900, uid: 0, loopback: true })) });
    if (op === "pty.create") return say({ ptyId: "pty_1", pid: 4242 });
    if (op !== "exec") return say({});
    const cmd = String(frame["cmd"]);
    seen.execs.push(cmd);
    const out = (stdout: string): void => say({ exitCode: 0, stdout, stderr: "", truncated: false });
    if (cmd.includes("command -v runuser")) return out(`Linux\n0\nroot\n${login.owner}\n1\n${login.home}\n/usr/bin\n`);
    // A line handed to the owner of the home rides inside one quoted argument; the claim is read off the line itself.
    const handed = /^runuser -u '[^']+' -- bash -c '(.*)'$/s.exec(cmd);
    const line = handed === null ? cmd : handed[1]!.replaceAll("'\\''", "'");
    const claim = /mkdir '([^']+)'"\$n"/.exec(line);
    if (claim !== null) return out(`${claim[1]!}\n`);
    if (cmd.includes("WSP_LAUNCHED")) {
      seen.order.push("launch");
      return out("WSP_LAUNCHED\n");
    }
    if (cmd.includes("cgroup.procs -exec cat")) {
      seen.order.push("end starts");
      if (shape.endHangs === true) return;
      setTimeout(() => {
        seen.order.push("end answers");
        if (shape.endFails === true) say({ exitCode: 1, stdout: "", stderr: `processes 4242 of ${line.match(/'(\/wsp-threads\/[^']+)'/)?.[1] ?? ""} did not end\n`, truncated: false });
        else out("");
      }, shape.endMs ?? 0);
      return;
    }
    const sentinel = /(__WSP_EOF_[0-9a-f]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) return out(stopped ? `\n${sentinel} 143 down \n` : `\n${sentinel}  up \n`);
    if (cmd.includes("kill -TERM -- -$P")) stopped = true;
    return out("");
  });
  return seen;
}

/** A harness whose turn runs through the launch road and ends when it is stopped, recording its environment. */
function launching(envs: Readonly<Record<string, string>>[]): HarnessAdapterFactory {
  return hctx => ({
    steers: false,
    start: o => {
      envs.push(hctx.env);
      const stream = hctx.execStream("claude -p hi", { env: { ...hctx.env } });
      const finished = stream.exited.then((): TurnResult => ({ status: "interrupted" }));
      void (async () => {
        for await (const _ of stream.lines);
      })();
      o.onEvent({ type: "session.start", sessionId: randomUUID() });
      return { localId: randomUUID(), finished, interrupt: async () => stream.teardown() };
    },
  });
}

/** A harness that answers at once, recording what each turn started with. */
function answering(starts: { o: HarnessStartOptions; env: Readonly<Record<string, string>> }[]): HarnessAdapterFactory {
  return hctx => ({
    steers: false,
    start: o => {
      starts.push({ o, env: hctx.env });
      const sessionId = randomUUID();
      const result: TurnResult = { status: "completed", text: "ok" };
      o.onEvent({ type: "session.start", sessionId });
      o.onEvent({ type: "turn.done", sessionId, result });
      o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
    },
  });
}

/** A harness whose first turn runs until the test ends it, as an agent's turn ends on its own, and whose later
 * turns run through the launch road until they are stopped. */
function endingOnCue(cue: { end?: () => void }): HarnessAdapterFactory {
  const later = launching([]);
  let turns = 0;
  return hctx => {
    const adapter = later(hctx);
    return {
      ...adapter,
      start: o => {
        turns += 1;
        if (turns > 1) return adapter.start(o);
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "done" };
        o.onEvent({ type: "session.start", sessionId });
        let done!: () => void;
        const finished = new Promise<TurnResult>(resolve => (done = () => resolve(result)));
        cue.end = () => {
          o.onEvent({ type: "turn.done", sessionId, result });
          o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
          done();
        };
        return { localId: sessionId, finished, interrupt: async () => cue.end!() };
      },
    };
  };
}

const HETZNER = { home: "/root", owner: "root" };

async function joined(o: { login?: { home: string; owner: string }; adapters: Record<string, HarnessAdapterFactory>; listening?: () => number[]; shape?: BoxShape; clock?: Clock }) {
  const login = o.login ?? HETZNER;
  const { hostKey, store } = await serving({ adapters: o.adapters, ...(o.clock === undefined ? {} : { clock: o.clock }) });
  let seen!: Box;
  const sent = report("hetzner", { login: { HOME: login.home, USER: login.owner, PATH: "/usr/bin" }, daemonVersion: DAEMON_VERSION });
  const { client, placeId, pair } = await join(hostKey, {
    code: await code(),
    report: sent,
    answers: c => {
      seen = box(c, login, o.listening ?? (() => []), o.shape);
    },
  });
  sockets.push(client.ws);
  const rt = ctx.runtime!;
  const project = await rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "hetzner", name: "spoo-ts" });
  const at = await rt.workspaces.folderFor({ project: project.id });
  /** The computer dialling in again after its link dropped, answering as before, on a fake of its own. */
  const back = async (): Promise<Box> => {
    let again!: Box;
    const linked = await relink(hostKey, placeId, pair, sent, c => (again = box(c, login, o.listening ?? (() => []), o.shape)));
    sockets.push(linked.client.ws);
    return again;
  };
  return { rt, seen, store, project, placeId, back, workspaceId: at.workspace.id, folder: at.workspace.folder ?? project.path };
}

/** A port nothing on this computer listens on now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const opened: (DaemonChannel | Server)[] = [];
afterEach(() => {
  for (const held of opened.splice(0)) held.close();
});

const pane = async (rt: Awaited<ReturnType<typeof joined>>["rt"], workspaceId: string, heard: Record<string, unknown>[]): Promise<DaemonChannel> => {
  const channel = await rt.workspaces.daemonChannel(workspaceId, e => heard.push(e));
  opened.push(channel);
  return channel;
};

describe("the ports of a thread in a folder on a computer the person joined", () => {
  it("are found by a watch of the folder's own over its threads' cgroups and its folder, and open here at the same number on demand", async () => {
    const port = await freePort();
    const starts: { o: HarnessStartOptions; env: Readonly<Record<string, string>> }[] = [];
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: answering(starts) }, listening: () => [port] });
    const first = await rt.sessions.start(workspaceId, { prompt: "serve it", harness: "claude" });
    await first.finished;
    const threadId = first.view().threadId!;

    const heard: Record<string, unknown>[] = [];
    const channel = await pane(rt, workspaceId, heard);
    const watched = (await channel.send({ id: 1, op: "ports.watch" })) as Record<string, unknown>;
    expect((watched["ports"] as { port: number }[]).map(p => p.port)).toEqual([port]);
    // The link's own watch is the socket's, named for nothing; the folder's is a watch of its own beside it.
    const named = (): Record<string, unknown>[] => seen.frames.filter(f => f["op"] === "ports.watch" && f["watch"] !== undefined);
    const asked = named();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ roots: [], folder: "/root/spoo-ts", cgroups: [threadCgroup(threadId)], watch: workspaceId });

    // The link carries every watch on that computer: this folder's, another folder's, and the host's own.
    seen.client.say({ type: "port.open", port: 5173, watch: "ws_other" });
    seen.client.say({ type: "port.open", port: 7777 });
    seen.client.say({ type: "port.open", port, pid: 900, watch: workspaceId });
    await expect.poll(() => heard.filter(e => e["type"] === "port.open").map(e => e["port"])).toEqual([port]);

    // A thread that starts there names its cgroup in the watch again.
    const second = await rt.sessions.start(workspaceId, { prompt: "another", harness: "claude" });
    await second.finished;
    await expect.poll(() => named().length).toBe(2);
    expect(named().at(-1)?.["cgroups"]).toEqual([threadCgroup(second.view().threadId!), threadCgroup(threadId)]);

    // Opening it asks for the same number on this computer, and a connection there is a tunnel to that port on the
    // computer itself, naming no workspace.
    const reach = await rt.workspaces.portReach(workspaceId, port);
    expect(reach.url).toBe(`http://localhost:${port}/`);
    const conn = createConnection({ host: "127.0.0.1", port });
    await new Promise<void>(resolve => conn.once("connect", () => resolve()));
    await expect.poll(() => seen.frames.find(f => f["op"] === "tunnel.open")).toMatchObject({ port });
    expect(seen.frames.find(f => f["op"] === "tunnel.open")?.["machineId"]).toBeUndefined();
    conn.destroy();
    // Asked again, the same forward answers.
    expect((await rt.workspaces.portReach(workspaceId, port)).url).toBe(`http://localhost:${port}/`);
  });

  it("opens on the first free number above one this computer already uses", async () => {
    const port = await freePort();
    const taken = createServer();
    await new Promise<void>(resolve => taken.listen(port, "127.0.0.1", resolve));
    opened.push(taken);
    const { rt, workspaceId } = await joined({ adapters: { claude: answering([]) }, listening: () => [port] });
    const url = new URL((await rt.workspaces.portReach(workspaceId, port)).url);
    expect(Number(url.port)).toBeGreaterThan(port);
    expect(url.hostname).toBe("localhost");
  });
});

/** Whether a connection to this computer's port is taken now. */
const connects = (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const conn = createConnection({ host: "127.0.0.1", port });
    conn.once("connect", () => {
      conn.destroy();
      resolve(true);
    });
    conn.once("error", () => resolve(false));
  });

/** The forwards the app's Ports list reads, and a stop of one, over the app's own socket. */
async function portsList(): Promise<Record<string, unknown>[]> {
  const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
  const answer = await c.request("forwards.list");
  c.close();
  return answer["forwards"] as Record<string, unknown>[];
}

describe("a port a Browser pane opens for a thread in a folder on a computer the person joined", () => {
  it("stands while the pane keeps asking, past ten quiet minutes, and goes once the pane stops", async () => {
    const { clock, advance } = fakeClock();
    const port = await freePort();
    const { rt, workspaceId } = await joined({ adapters: { claude: answering([]) }, listening: () => [port], clock });
    const reach = await rt.workspaces.portReach(workspaceId, port);
    expect(reach.url).toBe(`http://localhost:${port}/`);
    // The pane asks again halfway through what the answer gives it.
    expect(reach.expiresAt - clock.now()).toBe(120_000);
    expect(await connects(port)).toBe(true);
    for (let minute = 0; minute < 11; minute++) {
      advance(60_000);
      await rt.workspaces.portReach(workspaceId, port);
    }
    expect(await connects(port)).toBe(true);
    // The pane closed: nothing asks, and once the connection above has closed the hold runs out.
    await new Promise(resolve => setTimeout(resolve, 100));
    advance(120_000);
    await expect.poll(() => connects(port)).toBe(false);
    expect(await portsList()).toEqual([]);
  });

  it("goes after a quiet hour while the pane still shows it, tells the pane so once, and opens again when asked after that", async () => {
    const { clock, advance } = fakeClock();
    const port = await freePort();
    const { rt, workspaceId } = await joined({ adapters: { claude: answering([]) }, listening: () => [port], clock });
    await rt.workspaces.portReach(workspaceId, port);
    for (let minute = 0; minute < 60; minute++) {
      advance(60_000);
      if (minute < 59) await rt.workspaces.portReach(workspaceId, port);
    }
    await expect.poll(() => connects(port)).toBe(false);
    await expect(rt.workspaces.portReach(workspaceId, port)).rejects.toThrow(paneForwardQuietLine(port));
    expect((await rt.workspaces.portReach(workspaceId, port)).url).toBe(`http://localhost:${port}/`);
  });

  it("takes no port below 1024 and no more than the relay's cap for one workspace, and shows in the Ports list, which stops it", async () => {
    const { rt, workspaceId } = await joined({ adapters: { claude: answering([]) } });
    await expect(rt.workspaces.portReach(workspaceId, 80)).rejects.toThrow(paneForwardFloorLine(80));
    const ports: number[] = [];
    for (let i = 0; i < FORWARD_MAX_PER_TARGET + 1; i++) ports.push(await freePort());
    for (const port of ports.slice(0, FORWARD_MAX_PER_TARGET)) await rt.workspaces.portReach(workspaceId, port);
    await expect(rt.workspaces.portReach(workspaceId, ports.at(-1)!)).rejects.toThrow(paneForwardCapLine("spoo-ts", FORWARD_MAX_PER_TARGET));
    const listed = await portsList();
    expect(listed).toHaveLength(FORWARD_MAX_PER_TARGET);
    expect(listed[0]).toMatchObject({ workspaceId, port: ports[0], name: "spoo-ts", kind: "url" });
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await c.request("forwards.stop", { workspaceId, port: ports[0] })).toMatchObject({ ok: true });
    c.close();
    expect(await connects(ports[0]!)).toBe(false);
    expect(await portsList()).toHaveLength(FORWARD_MAX_PER_TARGET - 1);
    // The pane still showing it asks again within its hold and is told it was stopped, so the frame goes and the
    // forward stays closed until the person opens the address again.
    await expect(rt.workspaces.portReach(workspaceId, ports[0]!)).rejects.toThrow(paneForwardStoppedLine(ports[0]!));
    expect(await connects(ports[0]!)).toBe(false);
    expect((await rt.workspaces.portReach(workspaceId, ports[0]!)).url).toBe(`http://localhost:${ports[0]}/`);
  });
});

describe("the processes of a thread in a folder on a computer the person joined", () => {
  it("stand in a cgroup of the thread's own from its launch, and a stop and a delete end that cgroup whole as root", async () => {
    const envs: Readonly<Record<string, string>>[] = [];
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: launching(envs) } });
    const run = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await expect.poll(() => seen.execs.some(cmd => cmd.includes("WSP_LAUNCHED"))).toBe(true);
    const threadId = run.view().threadId!;
    const launch = seen.execs.find(cmd => cmd.includes("WSP_LAUNCHED"))!;
    // The shell stands itself in the cgroup, then starts the turn: what it starts, a server it detached included,
    // stands there too.
    expect(launch.startsWith(`${cgroupJoinLine(threadCgroup(threadId))}\n`)).toBe(true);
    // The polls are not the thread's: they join no cgroup.
    expect(seen.execs.filter(cmd => cmd.includes("__WSP_EOF_")).every(cmd => !cmd.includes("cgroup.procs"))).toBe(true);

    await rt.sessions.interrupt(run.view().id);
    await run.finished;
    expect(seen.execs).toContain(cgroupEndScript(threadCgroup(threadId)));

    await rt.sessions.delete(threadId);
    expect(seen.execs).toContain(cgroupEndScript(threadCgroup(threadId), { remove: true }));
  });

  it("are ended there, every thread's, before the computer's own leave when it is removed over its link", async () => {
    const { hostKey } = await serving();
    const asked: string[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      answers: c => {
        c.onFrame(raw => {
          const frame = raw as unknown as Record<string, unknown>;
          if (frame["op"] === "exec" && frame["cmd"] === threadCgroupsEndScript()) asked.push("threads end");
        });
        answersLeave(c, [], asked);
      },
    });
    sockets.push(client.ws);
    await ctx.runtime!.places!.remove(placeId);
    expect(asked).toEqual(["threads end", "place.leave"]);
  });

  it("start the next turn a stop's own queue held only once that stop's end has answered", async () => {
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: launching([]) }, shape: { endMs: 1500 } });
    const run = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await expect.poll(() => seen.order).toEqual(["launch"]);
    const queued = rt.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: run.view().threadId! });
    await rt.sessions.interrupt(run.view().id);
    const next = await queued;
    await expect.poll(() => seen.order.filter(step => step === "launch")).toHaveLength(2);
    expect(seen.order).toEqual(["launch", "end starts", "end answers", "launch"]);
    await rt.sessions.interrupt(next.view().id);
    await next.finished;
  });

  it("leave the next turn running when a stop lands on the turn before it after that turn ended on its own", async () => {
    const cue: { end?: () => void } = {};
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: endingOnCue(cue) } });
    const first = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await expect.poll(() => cue.end).toBeDefined();
    const queued = rt.sessions.start(workspaceId, { prompt: "and then", harness: "claude", thread: first.view().threadId! });
    // The first turn ends on its own as the person presses Stop on it: the queued turn launches at once, and the
    // stop arrives naming the turn that ended.
    cue.end!();
    const next = await queued;
    await expect.poll(() => seen.order).toEqual(["launch"]);
    expect(await rt.sessions.interrupt(first.view().id)).toEqual({ outcome: "not-running" });
    expect(seen.order).toEqual(["launch"]);
    expect(seen.execs.some(cmd => cmd.includes("cgroup.procs -exec cat"))).toBe(false);
    expect(next.view().status).toBe("running");
    await rt.sessions.interrupt(next.view().id);
    await next.finished;
  });

  it("go on being stopped and deleted while the computer is away, and are ended there when it dials back", async () => {
    const { rt, seen, project, placeId, back, workspaceId } = await joined({ adapters: { claude: answering([]) } });
    const run = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await run.finished;
    const threadId = run.view().threadId!;
    seen.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === false);
    // Nothing of the stop or the delete needs that computer: a finished turn has nothing here to stop.
    expect(await rt.sessions.interrupt(run.view().id)).toEqual({ outcome: "not-running" });
    expect(await rt.sessions.delete(threadId)).toEqual({ workspaceId, threads: 1 });
    expect((await rt.projects.remove(project.id)).said).toContain("is no longer a project on hetzner");
    // The cgroup the thread left there is ended and taken away at the computer's next link.
    const again = await back();
    await expect.poll(() => again.execs).toContain(cgroupEndScript(threadCgroup(threadId), { remove: true }));
  });

  it("go on being deleted when their end does not finish there, owe it to the next link, and a stop says what it left", async () => {
    const shape: BoxShape = { endFails: true };
    const { rt, seen, store, placeId, back, workspaceId } = await joined({ adapters: { claude: answering([]) }, shape });
    const run = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await run.finished;
    const threadId = run.view().threadId!;
    const stopped = await rt.sessions.interrupt(run.view().id);
    expect(stopped).toEqual({ outcome: "not-running", left: threadLeftLine("hetzner", [4242]) });
    expect(stopped.left).not.toContain("/wsp-threads");
    expect(await rt.sessions.delete(threadId)).toEqual({ workspaceId, threads: 1 });
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });
    // The computer's next link ends it, and owes nothing once it has.
    shape.endFails = false;
    seen.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === false);
    const again = await back();
    await expect.poll(() => again.execs).toContain(cgroupEndScript(threadCgroup(threadId), { remove: true }));
    await expect.poll(() => store.get("thread-ends", placeId)).toBeUndefined();
  });

  it("go on being deleted when the computer stops answering during their end, and owe it", async () => {
    const { rt, seen, store, placeId, workspaceId } = await joined({ adapters: { claude: answering([]) }, shape: { endHangs: true } });
    const run = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await run.finished;
    const threadId = run.view().threadId!;
    const deleted = rt.sessions.delete(threadId);
    await expect.poll(() => seen.order).toContain("end starts");
    seen.client.close();
    expect(await deleted).toEqual({ workspaceId, threads: 1 });
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });
  });

  it("owe nothing to a computer once it is removed", async () => {
    const { rt, seen, store, project, placeId, workspaceId } = await joined({ adapters: { claude: answering([]) } });
    const run = await rt.sessions.start(workspaceId, { prompt: "serve", harness: "claude" });
    await run.finished;
    const threadId = run.view().threadId!;
    seen.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === false);
    await rt.sessions.delete(threadId);
    expect(await store.get("thread-ends", placeId)).toEqual({ threads: [threadId] });
    await rt.projects.remove(project.id);
    expect((await rt.places!.remove(placeId)).removed).toBe(true);
    await expect.poll(() => store.get("thread-ends", placeId)).toBeUndefined();
  });

  it("are listed to every pane there off one watch of the link, with the cgroup each stands in, and killed by that computer's daemon", async () => {
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: answering([]) } });
    const a: Record<string, unknown>[] = [];
    const b: Record<string, unknown>[] = [];
    const first = await pane(rt, workspaceId, a);
    const second = await pane(rt, workspaceId, b);
    expect(await first.send({ id: 1, op: "proc.watch" })).toMatchObject({ ok: true });
    expect(await second.send({ id: 1, op: "proc.watch" })).toMatchObject({ ok: true });
    const row = { pid: 900, ppid: 1, user: "root", state: "S", comm: "node", cmdline: "node server.js", cpu: 2, rss: 4096, startedAt: 1, cgroup: "/wsp-threads/t1" };
    seen.client.say({ type: "proc.snapshot", at: 1, daemon: 7, total: 1, procs: [row], seq: 1 });
    await expect.poll(() => [a, b].map(heard => heard.find(e => e["type"] === "proc.snapshot")?.["procs"])).toEqual([[row], [row]]);

    // One pane going leaves the link watching for the other; the last one going ends it.
    await first.send({ id: 2, op: "proc.unwatch" });
    expect(seen.frames.filter(f => f["op"] === "proc.unwatch")).toHaveLength(0);
    second.close();
    await expect.poll(() => seen.frames.filter(f => f["op"] === "proc.unwatch")).toHaveLength(1);

    expect(await first.send({ id: 3, op: "proc.kill", pid: 900, signal: "TERM" })).toMatchObject({ ok: true });
    expect(seen.frames.filter(f => f["op"] === "proc.kill")).toMatchObject([{ pid: 900, signal: "TERM" }]);
  });

  it("are watched over a link that dropped for no pane that went with it, and the link that replaced it counts its own", async () => {
    const { rt, seen, workspaceId, back } = await joined({ adapters: { claude: answering([]) } });
    const gone = await pane(rt, workspaceId, []);
    expect(await gone.send({ id: 1, op: "proc.watch" })).toMatchObject({ ok: true });
    expect(await gone.send({ id: 2, op: "ports.watch" })).toMatchObject({ ok: true });
    seen.client.close();
    await gone.closed;
    const again = await back();
    const fresh = await pane(rt, workspaceId, []);
    expect(await fresh.send({ id: 1, op: "proc.watch" })).toMatchObject({ ok: true });
    fresh.close();
    // The pane that went with the old link holds nothing on the new one: the last pane on it going ends its watch.
    await expect.poll(() => again.frames.filter(f => f["op"] === "proc.unwatch")).toHaveLength(1);
    // And a thread that starts names its cgroup to no watch, since no pane watches the folder's ports any more.
    await (await rt.sessions.start(workspaceId, { prompt: "hi", harness: "claude" })).finished;
    expect(again.frames.filter(f => f["op"] === "ports.watch" && f["watch"] !== undefined)).toHaveLength(0);
  });
});

describe("the terminal and the readings of a thread in a folder on a computer the person joined", () => {
  it("opens a terminal on that computer in the folder, as the login, with the environment the turn got", async () => {
    const starts: { o: HarnessStartOptions; env: Readonly<Record<string, string>> }[] = [];
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: answering(starts) } });
    await (await rt.sessions.start(workspaceId, { prompt: "hi", harness: "claude" })).finished;
    const channel = await pane(rt, workspaceId, []);
    const made = (await channel.send({ id: 1, op: "pty.create", cols: 80, rows: 24 })) as Record<string, unknown>;
    expect(made).toMatchObject({ ok: true, ptyId: "pty_1" });
    const asked = seen.frames.find(f => f["op"] === "pty.create")!;
    expect(asked["cwd"]).toBe("/root/spoo-ts");
    expect(asked["machineId"]).toBeUndefined();
    // The computer's daemon runs it as the login it was added with, which is root: nothing hands it to another.
    expect(asked["user"]).toBeUndefined();
    const env = asked["env"] as Record<string, string>;
    const turn = starts[0]!.env;
    // The turn's environment, the login's home and the agent's store among them, less the tokens only its launch
    // carries, which name that turn.
    const launchOnly = [TURN_TOKEN_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, HOST_KEY_ENV];
    expect(env["HOME"]).toBe("/root");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(turn["CLAUDE_CONFIG_DIR"]);
    for (const name of launchOnly) expect(env[name]).toBeUndefined();
    for (const [name, value] of Object.entries(turn)) if (!launchOnly.includes(name)) expect([name, env[name]]).toEqual([name, value]);
  });

  it("names the shell of a terminal opened there as a root of the folder's port watch, until it exits", async () => {
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: answering([]) } });
    const channel = await pane(rt, workspaceId, []);
    expect(await channel.send({ id: 1, op: "ports.watch", roots: [] })).toMatchObject({ ok: true });
    expect(await channel.send({ id: 2, op: "pty.create", cols: 80, rows: 24 })).toMatchObject({ ok: true, pid: 4242 });
    const named = (): Record<string, unknown>[] => seen.frames.filter(f => f["op"] === "ports.watch" && f["watch"] !== undefined);
    await expect.poll(() => named().at(-1)?.["roots"]).toEqual([4242]);
    seen.client.say({ type: "pty.exit", ptyId: "pty_1", exitCode: 0 });
    await expect.poll(() => named().at(-1)?.["roots"]).toEqual([]);
  });

  it("refuses a pane's own port watch on a computer whose daemon is behind or never said its version", () => {
    expect(namedWatchRefusal("hetzner", undefined)).toMatchObject({ ok: false, code: "unsupported", error: `hetzner is behind: daemon version unknown, host ${DAEMON_VERSION}; wsp add hetzner --update puts this wsp's daemon on it` });
    expect(namedWatchRefusal("hetzner", DAEMON_VERSION - 1)).toMatchObject({ ok: false, code: "unsupported" });
    expect(namedWatchRefusal("hetzner", DAEMON_VERSION)).toBeUndefined();
  });

  it("reads the computer's load to every pane off one watch of the link", async () => {
    const { rt, seen, workspaceId } = await joined({ adapters: { claude: answering([]) } });
    const a: Record<string, unknown>[] = [];
    const b: Record<string, unknown>[] = [];
    expect(await (await pane(rt, workspaceId, a)).send({ id: 1, op: "sys.watch" })).toMatchObject({ ok: true });
    expect(await (await pane(rt, workspaceId, b)).send({ id: 1, op: "sys.watch" })).toMatchObject({ ok: true });
    expect(seen.frames.filter(f => f["op"] === "sys.watch")).toHaveLength(1);
    const sample = { type: "sys.sample", cpu: 12, load1: 0.4, mem: { used: 1, total: 4 }, disk: { used: 2, total: 9 }, at: 1 };
    seen.client.say(sample);
    await expect.poll(() => [a, b].map(heard => heard.filter(e => e["type"] === "sys.sample").length)).toEqual([1, 1]);
  });
});

/** Whether this process may make a cgroup: root on a computer with cgroup v2, which a cloud builder is and CI is not. */
const makesCgroups = process.getuid?.() === 0 && existsSync("/sys/fs/cgroup/cgroup.controllers");

/** Whether this process is still running: there and not a zombie its parent has yet to reap. */
const alive = (pid: number): boolean => existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");

/** Starts a line in this process's own shell as a turn's launch does: the join, then the command detached. */
const launched = (cgroup: string, command: string): number =>
  Number(execFileSync("sh", ["-c", `${cgroupJoinLine(cgroup)}\nsetsid ${command} > /dev/null 2>&1 < /dev/null & echo $!`], { encoding: "utf8" }).trim());

/** Kills what a case started and takes away the cgroups it made, deepest first, whatever the case came to. */
function cleared(pids: number[], cgroups: string[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone, which is the point
    }
  }
  for (const cgroup of [...cgroups, dirname(cgroups.at(-1)!)]) {
    for (let i = 0; i < 30; i++) {
      try {
        rmdirSync(`/sys/fs/cgroup${cgroup}`);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
        execFileSync("sleep", ["0.1"]);
      }
    }
  }
}

describe.runIf(makesCgroups)("a thread's cgroup on this computer", () => {
  it.runIf(existsSync("/run/systemd/system"))("keeps a turn the daemon's unit launched running when that unit stops, in the thread's cgroup", async () => {
    const cgroup = threadCgroup(randomUUID());
    const unit = `wsp-test-daemon-${randomUUID().slice(0, 8)}`;
    const dir = mkdtempSync(joinPath(tmpdir(), "wsp-unit-"));
    let pid = 0;
    try {
      // A unit standing in for the daemon's, which kills its whole cgroup when it stops, starts a turn as the
      // daemon's exec does: the launch's own shell joins the thread's cgroup and starts the turn with setsid.
      // systemd reads $ in a command line as its own, so each is doubled to reach the shell as written.
      const launch = `${cgroupJoinLine(cgroup)}\nsetsid sleep 300 > /dev/null 2>&1 < /dev/null & echo $! > ${dir}/pid; sleep 300`;
      execFileSync("systemd-run", ["--quiet", `--unit=${unit}`, "sh", "-c", launch.replaceAll("$", () => "$$")]);
      await expect.poll(() => existsSync(`${dir}/pid`) && readFileSync(`${dir}/pid`, "utf8").trim() !== "").toBe(true);
      pid = Number(readFileSync(`${dir}/pid`, "utf8").trim());
      expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toBe(`0::${cgroup}\n`);
      execFileSync("systemctl", ["stop", unit]);
      expect(alive(pid)).toBe(true);
      execFileSync("sh", ["-c", cgroupEndScript(cgroup, { remove: true })]);
      expect(alive(pid)).toBe(false);
    } finally {
      try {
        execFileSync("systemctl", ["stop", unit], { stdio: "ignore" });
      } catch {
        // already stopped
      }
      cleared(pid > 0 ? [pid] : [], [cgroup]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ends every thread's cgroup when the computer leaves, and takes the folder they sat in away", () => {
    const under = `/wsp-test-${randomUUID().slice(0, 8)}`;
    const [a, b] = [`${under}/${randomUUID()}`, `${under}/${randomUUID()}`];
    const pids = [launched(a, "sleep 300"), launched(`${b}/sub`, "sleep 300")];
    try {
      const said = execFileSync("sh", ["-c", threadCgroupsEndScript(under)], { encoding: "utf8" });
      expect(said.trim().split("\n").sort()).toEqual([`/sys/fs/cgroup${a}`, `/sys/fs/cgroup${b}`].sort());
      expect(pids.map(alive)).toEqual([false, false]);
      expect(existsSync(`/sys/fs/cgroup${under}`)).toBe(false);
    } finally {
      cleared(pids, [`${b}/sub`, b, a]);
    }
  });

  it("ends a process in a cgroup under the thread's, and takes both cgroups away", () => {
    const cgroup = threadCgroup(randomUUID());
    const pid = launched(`${cgroup}/sub`, "sleep 300");
    try {
      expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(`0::${cgroup}/sub\n`);
      execFileSync("sh", ["-c", cgroupEndScript(cgroup, { remove: true })]);
      expect(alive(pid)).toBe(false);
      expect(existsSync(`/sys/fs/cgroup${cgroup}`)).toBe(false);
    } finally {
      cleared([pid], [`${cgroup}/sub`, cgroup]);
    }
  });

  it("ends only what stood in the cgroup when the stop began, so the next turn launched meanwhile runs on", async () => {
    const cgroup = threadCgroup(randomUUID());
    // A server that takes its time over TERM, which is what keeps the end waiting.
    const server = launched(cgroup, `sh -c 'trap "" TERM; sleep 300'`);
    let next = 0;
    try {
      const ending = new Promise<number>(resolve => {
        const child = spawn("sh", ["-c", cgroupEndScript(cgroup)], { stdio: "ignore" });
        child.on("exit", code => resolve(code ?? -1));
      });
      await new Promise(resolve => setTimeout(resolve, 500));
      next = launched(cgroup, "sleep 300");
      expect(await ending).toBe(0);
      expect(alive(server)).toBe(false);
      expect(alive(next)).toBe(true);
    } finally {
      cleared([server, next].filter(pid => pid > 0), [cgroup]);
    }
  });


  it("holds a server the launch detached, and its end takes that server and the cgroup away", () => {
    const thread = randomUUID();
    const cgroup = threadCgroup(thread);
    // The launch's own shape: the join as root, then a server started with setsid, out of the launch's group.
    const pid = Number(execFileSync("sh", ["-c", `${cgroupJoinLine(cgroup)}\nsetsid sleep 300 > /dev/null 2>&1 < /dev/null & echo $!`], { encoding: "utf8" }).trim());
    try {
      expect(readFileSync(`/proc/${pid}/cgroup`, "utf8")).toContain(`0::${cgroup}\n`);
      execFileSync("sh", ["-c", cgroupEndScript(cgroup, { remove: true })]);
      expect(existsSync(`/proc/${pid}`) && !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ")).toBe(false);
      expect(existsSync(`/sys/fs/cgroup${cgroup}`)).toBe(false);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone, which is the point
      }
      // The folder every thread's cgroup sits in, which this test made on this computer; refused while another stands.
      try {
        rmdirSync(`/sys/fs/cgroup${dirname(cgroup)}`);
      } catch {
        // another thread's cgroup is there
      }
    }
  });
});
