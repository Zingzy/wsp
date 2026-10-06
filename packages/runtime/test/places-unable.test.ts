// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, placeCannotBootLine, type PlaceReport, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory } from "../src/runtime.js";
import { newPlaceKeyPair, type PlaceUpdateRequest, type PlaceUpdater } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, projectOn } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, answersLeave, remove, ForkingPlace, forks, daemonOps } from "./places-fixture.js";

describe("a computer that turns unable to run workspaces keeps its link, and refuses only what runs inside a copy", () => {
  const BLOCKED = "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1";
  const blocked = (): PlaceReport => report("srv", { daemonVersion: DAEMON_VERSION, runsWorkspaces: false, workspacesBlocked: BLOCKED });
  const SAID = placeCannotBootLine("srv", BLOCKED);

  /** A workspace forked on srv while it ran workspaces, then srv dialling back with its doctor saying it no longer
   * can, as it does after a reboot into a kernel line without cgroup v2. */
  const blockedFork = async (
    opts: { update?: PlaceUpdater; before?: (id: string) => Promise<void>; adapter?: HarnessAdapterFactory } = {},
  ): Promise<{ place: () => ForkingPlace; placeId: string; made: { id: string; machineId: string }; turns: string[]; renamed: string[] }> => {
    const turns: string[] = [];
    const renamed: string[] = [];
    const factory: HarnessAdapterFactory = opts.adapter ?? (() => ({
      steers: false,
      renameSession: async (_id, title) => (renamed.push(title), { kind: "written" }),
      start: ({ onEvent }) => {
        turns.push("started");
        const sessionId = randomUUID();
        const result: TurnResult = { status: "completed", text: "ok" };
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return { localId: sessionId, finished: Promise.resolve(result), interrupt: async () => {} };
      },
    }));
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: factory }, placeLinks: wiring(hostKey, { id: "solari", rateUsdPerHour: 0.11 }, opts.update), placeRelinkWaitMs: 50, killConfirm: { graceMs: 40, pollMs: 1 } });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    let place!: ForkingPlace;
    const { client, placeId, pair } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: c => (place = forks(c)) });
    sockets.push(client.ws);
    const made = await ctx.runtime.workspaces.create({ project: (await projectOn(ctx.runtime, "srv")).id, golden: "snap_g", name: "work" });
    await opts.before?.(made.id);
    const again = await relink(hostKey, placeId, pair, blocked(), c => (place = forks(c)));
    sockets.push(again.client.ws);
    expect(again.proved, String(again.proved["error"])).toMatchObject({ ok: true });
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === true);
    return { place: () => place, placeId, made: { id: made.id, machineId: made.machineId }, turns, renamed };
  };

  it("holds the link, moves the last seen stamp, and carries the doctor's sentence on the row rather than as a refused dial", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), name: "srv" });
    sockets.push(joined.client.ws);
    const before = (await placesOf()).find(p => p.id === joined.placeId)!.lastSeenAt!;
    const absences: Record<string, unknown>[] = [];
    ctx.runtime!.events.on("place.absent", e => absences.push(e as Record<string, unknown>));
    await new Promise(r => setTimeout(r, 5));
    const again = await relink(hostKey, joined.placeId, joined.pair, report("srv", { runsWorkspaces: false, workspacesBlocked: BLOCKED }));
    sockets.push(again.client.ws);
    expect(again.proved, String(again.proved["error"])).toMatchObject({ ok: true });
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    const row = (await placesOf()).find(p => p.id === joined.placeId)!;
    expect(row.blocked).toBe(SAID);
    expect(row.dialled).toBeUndefined();
    expect(Date.parse(row.lastSeenAt!)).toBeGreaterThan(Date.parse(before));
    expect(absences.filter(e => e["said"] !== undefined)).toEqual([]);
  });

  it("refuses a send into a thread there in the doctor's sentence, and starts no turn", async () => {
    const { made, turns, place } = await blockedFork();
    const execs = place().asked["machine.exec"] ?? 0;
    await expect(ctx.runtime!.sessions.start(made.id, { prompt: "one", harness: "claude" })).rejects.toThrow(SAID);
    expect(turns).toEqual([]);
    expect(place().asked["machine.exec"] ?? 0).toBe(execs);
  });

  /** A turn opened while srv ran workspaces, still running once it cannot, as the daemon keeps containers across a restart. */
  const runningThrough = (steers: boolean) => {
    const steered: string[] = [];
    const opened: ((r: TurnResult) => void)[] = [];
    let thread = "";
    const adapter: HarnessAdapterFactory = () => ({
      steers,
      start: ({ onEvent, resume }) => {
        const sessionId = resume ?? randomUUID();
        queueMicrotask(() => onEvent({ type: "session.start", sessionId }));
        let end!: (r: TurnResult) => void;
        const finished = new Promise<TurnResult>(r => {
          end = result => {
            onEvent({ type: "turn.done", sessionId, result });
            onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
            r(result);
          };
        });
        opened.push(end);
        return { localId: sessionId, finished, interrupt: async () => end({ status: "interrupted" }), steer: async (prompt: string) => (steered.push(prompt), "accepted" as const) };
      },
    });
    const before = async (id: string): Promise<void> => {
      const started = await ctx.runtime!.sessions.start(id, { prompt: "one", harness: "claude" });
      thread = started.view().threadId!;
      await until(async () => (await ctx.runtime!.sessions.list(id))[0]?.claudeSessionId !== undefined);
    };
    return { adapter, before, steered, opened, thread: () => thread };
  };

  it("lets a send into a turn still running there join it, as a steer does, so the person can still steer or stop it", async () => {
    const through = runningThrough(true);
    const { made } = await blockedFork({ adapter: through.adapter, before: through.before });
    const joined = await ctx.runtime!.sessions.start(made.id, { prompt: "two", thread: through.thread() });
    expect(joined.outcome).toBe("steered");
    expect(through.steered).toEqual(["two"]);
    expect(through.opened).toHaveLength(1);
  });

  it("refuses a send queued behind a turn running there once that turn ends, in the doctor's sentence, and starts no turn", async () => {
    const through = runningThrough(false);
    const { made } = await blockedFork({ adapter: through.adapter, before: through.before });
    const queued = ctx.runtime!.sessions.start(made.id, { prompt: "two", thread: through.thread() });
    const settled = queued.then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    await new Promise(r => setTimeout(r, 20));
    through.opened[0]!({ status: "completed", text: "ok" });
    expect(await settled).toBe(SAID);
    expect(through.opened).toHaveLength(1);
  });

  it("answers git.status for a copy there, the read an ask before a delete makes, and the beat the panes' link opens on", async () => {
    const { made, place } = await blockedFork();
    const app = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(app.ws);
    const opened = await app.request("daemon.open", { workspaceId: made.id });
    expect(opened.ok, String(opened["error"])).toBe(true);
    const channel = String(opened["channel"]);
    const sent = (frame: Record<string, unknown>) => app.request("daemon.send", { channel, frame }).then(r => r["reply"]);
    expect(await sent({ op: "ping" })).toMatchObject({ ok: true });
    expect(await sent({ op: "git.status", cwd: "/root/work" })).toMatchObject({ ok: true, branch: "work" });
    expect(place().frames.filter(f => f["op"] === "git.status")).toMatchObject([{ machineId: made.machineId }]);
    expect(await sent({ op: "git.diff", cwd: "/root/work" })).toMatchObject({ ok: false, error: SAID });
  });

  it.each([
    { road: "the panes' road, Terminal, Files and Diff included", open: (id: string) => ctx.runtime!.workspaces.daemonChannel(id, () => {}) },
    { road: "the guest road, which a sign-in and an agent session inside the copy reach this host by", open: (id: string) => ctx.runtime!.workspaces.guestChannel(id, () => {}) },
  ])("refuses every other frame on $road, in the doctor's sentence before it reaches that computer", async ({ open }) => {
    const { made, place } = await blockedFork();
    const channel = await open(made.id);
    for (const { op } of daemonOps().filter(o => o.op !== "git.status" && o.op !== "ping")) {
      const before = place().asked[op] ?? 0;
      expect(await channel.send({ op, ptyId: "p1", path: "/root/work", cwd: "/root/work", cols: 80, rows: 24 }), op).toMatchObject({ ok: false, error: SAID });
      expect(place().asked[op] ?? 0, op).toBe(before);
    }
    expect(place().frames.filter(f => f["op"] !== "git.status")).toEqual([]);
    channel.close();
  });

  it.each([
    { road: "the panes' road", open: (id: string, on: (e: Record<string, unknown>) => void) => ctx.runtime!.workspaces.daemonChannel(id, on) },
    { road: "the guest road", open: (id: string, on: (e: Record<string, unknown>) => void) => ctx.runtime!.workspaces.guestChannel(id, on) },
  ])("lets no session the computer pushes in on $road, so a sign-in or an agent session there opens nothing on this host", async ({ open }) => {
    const { made, place } = await blockedFork();
    const heard: Record<string, unknown>[] = [];
    const channel = await open(made.id, e => heard.push(e));
    for (const s of [{ session: "g1", kind: "cli", argv: ["agents", "signin", "claude"] }, { session: "g2", kind: "mcp", argv: [] }]) {
      place().push({ type: "guest.opened", machineId: made.machineId, life: "l1", token: "dev-1.tok", cwd: "/root/work", ...s });
    }
    // One socket carries the pushes and the answer in order, so the ping's answer comes after both pushes were read.
    expect(await channel.send({ op: "ping" })).toMatchObject({ ok: true });
    channel.close();
    expect(heard.map(e => e["type"])).toEqual(["daemon.hello"]);
  });

  it("refuses the Browser's road to a port inside the copy in the doctor's sentence", async () => {
    const { made, place } = await blockedFork();
    await expect(ctx.runtime!.workspaces.portReach(made.id, 3000)).rejects.toThrow(SAID);
    await expect(ctx.runtime!.workspaces.portProbe(made.id, 3000)).rejects.toThrow(SAID);
    expect(place().asked["machine.previewUrl"] ?? 0).toBe(0);
  });

  it("refuses a new workspace there, the road New thread and run --on take, in the doctor's sentence, and forks nothing", async () => {
    const { place } = await blockedFork();
    const made = place().created.length;
    await expect(ctx.runtime!.workspaces.create({ project: (await projectOn(ctx.runtime!, "srv")).id, golden: "snap_g", name: "more" })).rejects.toThrow(SAID);
    expect(place().created).toHaveLength(made);
  });

  it("refuses a command inside the copy, on both of exec's roads, in the doctor's sentence", async () => {
    const { made, place } = await blockedFork();
    const execs = place().asked["machine.exec"] ?? 0;
    await expect(ctx.runtime!.workspaces.exec(made.id, "true")).rejects.toThrow(SAID);
    await expect(ctx.runtime!.workspaces.execStream(made.id, ["true"])).rejects.toThrow(SAID);
    expect(place().asked["machine.exec"] ?? 0).toBe(execs);
  });

  it("refuses the bring back in the doctor's sentence, before a git frame leaves", async () => {
    const { made, place } = await blockedFork();
    await expect(ctx.runtime!.workspaces.bringBack({ workspaceId: made.id })).rejects.toThrow(SAID);
    expect(place().frames).toEqual([]);
  });

  it("refuses a wake of a stopped copy there in the row's sentence, not the boot's words, and resumes nothing", async () => {
    const { made, place } = await blockedFork({ before: id => ctx.runtime!.workspaces.nap(id).then(() => undefined) });
    await expect(ctx.runtime!.workspaces.wake(made.id)).rejects.toThrow(SAID);
    expect(place().resumed).toBe(0);
    expect(place().asked["machine.resume"] ?? 0).toBe(0);
  });

  it("refuses naming a thread there, which writes inside the copy, in the doctor's sentence", async () => {
    let session = "";
    const { renamed } = await blockedFork({
      before: async id => {
        const started = await ctx.runtime!.sessions.start(id, { prompt: "one", harness: "claude" });
        await started.finished;
        session = started.id;
      },
    });
    await expect(ctx.runtime!.sessions.rename(session, "a name")).rejects.toThrow(SAID);
    expect(renamed).toEqual([]);
  });

  it("refuses carrying a folder into the copy or out of it in the doctor's sentence, before the bundler or the lander is asked", async () => {
    const { made } = await blockedFork();
    await expect(ctx.runtime!.projects.import({ workspaceId: made.id, source: "/s", dest: "/d", bundler: {} as never })).rejects.toThrow(SAID);
    await expect(ctx.runtime!.projects.export({ workspaceId: made.id, source: "/s", dest: "/d", lander: {} as never })).rejects.toThrow(SAID);
  });

  it("deletes a workspace there over the link", async () => {
    const { made, place } = await blockedFork();
    await ctx.runtime!.workspaces.delete(made.id);
    expect(place().killed).toContain(made.machineId);
    expect(await ctx.runtime!.workspaces.list()).toEqual([]);
  });

  it("takes the computer out over the link, asking it to sweep itself", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), name: "srv" });
    sockets.push(joined.client.ws);
    const asked: string[] = [];
    const again = await relink(hostKey, joined.placeId, joined.pair, blocked(), c => answersLeave(c, ["/root/.wsp/place.json"], asked));
    sockets.push(again.client.ws);
    expect(again.proved, String(again.proved["error"])).toMatchObject({ ok: true });
    const answer = await remove(joined.placeId);
    expect(answer["removed"]).toBe(true);
    expect(asked).toEqual(["place.leave"]);
  });

  it("hands the update pass the link", async () => {
    const asked: PlaceUpdateRequest[] = [];
    const { placeId } = await blockedFork({ update: async req => void asked.push(req) });
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const answer = await c.request("places.update", { placeId });
    c.close();
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.link).toBeDefined();
  });
});
