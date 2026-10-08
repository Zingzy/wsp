// SPDX-License-Identifier: AGPL-3.0-only
// A thread's row on a computer the person joined leaves unreachable the moment
// that computer dials back in, after a host restart or a dropped link, rather
// than at the next poll. A box thread's folder record reads unsupported once
// back: the folder has no daemon of its own to ask, only the box's link.
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { ctx, placesOf, relink, sockets } from "./places-fixture.js";
import { report, wiring } from "./place-join.js";
import { box, HETZNER, joined } from "./box-fixture.js";
import { until } from "./until.js";

const BACK = report("hetzner", { login: { HOME: "/root", USER: "root", PATH: "/usr/bin" } });

/** Every reach a workspace's row was pushed with, in order. */
function pushedFor(id: () => string): string[] {
  const pushed: string[] = [];
  ctx.runtime!.events.on("workspace.status", e => {
    if (e.type === "workspace.status" && e.status.id === id()) pushed.push(e.status.reach.state);
  });
  return pushed;
}

describe("a box thread's row when its computer dials back in", () => {
  it("is pushed the moment the computer dials back in after a host restart, not at the next poll", async () => {
    const store = memoryStore();
    const { rt, project, hostKey, placeId, pair } = await joined({ store });
    const made = (await rt.workspaces.folderFor({ project: project.id })).workspace;
    expect(made.kind).toBe("place");
    for (const ws of sockets.splice(0)) ws.close();
    await ctx.srv!.close();
    await ctx.runtime!.close();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const pushed = pushedFor(() => made.id);
    const stop = ctx.runtime.status.watch({ pollIntervalMs: 60_000 });
    try {
      await until(() => pushed.at(-1) === "unreachable");
      const back = await relink(hostKey, placeId, pair, BACK, c => void box(c, HETZNER));
      sockets.push(back.client.ws);
      await until(() => pushed.at(-1) === "unsupported", 1000);
    } finally {
      stop();
    }
  });

  it("is pushed the moment the computer dials back in after its link dropped, not at the next poll", async () => {
    const { rt, project, hostKey, placeId, pair } = await joined();
    const made = (await rt.workspaces.folderFor({ project: project.id })).workspace;
    const pushed = pushedFor(() => made.id);
    for (const ws of sockets.splice(0)) ws.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const stop = rt.status.watch({ pollIntervalMs: 60_000 });
    try {
      await until(() => pushed.at(-1) === "unreachable");
      const back = await relink(hostKey, placeId, pair, BACK, c => void box(c, HETZNER));
      sockets.push(back.client.ws);
      await until(() => pushed.at(-1) === "unsupported", 1000);
    } finally {
      stop();
    }
  });

  it("keeps its row off unreachable after the computer dials back while a full tick that began during the gap is out", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = await joined({ store });
    const made = (await first.rt.workspaces.folderFor({ project: first.project.id })).workspace;
    for (const ws of sockets.splice(0)) ws.close();
    await ctx.srv!.close();
    await ctx.runtime!.close();
    // The same host again with a cloud beside the box, whose machine holds the tick open.
    ctx.runtime = createRuntime({ backend, store, adapters: {}, placeLinks: wiring(first.hostKey, { id: "solari", rateUsdPerHour: 0.11 }) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const cloud = await createOn(ctx.runtime, { golden: "snap_g", name: "c", on: "solari" });
    // The tick's slowest machine answers only once the computer is back, so the tick's row for the box thread was built while it was away.
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let asked = false;
    backend.machines.find(m => m.id === cloud.machineId)!.daemonAnswers = async () => {
      asked = true;
      await gate;
      return true;
    };
    const pushed = pushedFor(() => made.id);
    let cloudPushed = 0;
    ctx.runtime.events.on("workspace.status", e => {
      if (e.type === "workspace.status" && e.status.id === cloud.id) cloudPushed++;
    });
    const stop = ctx.runtime.status.watch({ pollIntervalMs: 60_000 });
    try {
      await until(() => asked);
      const back = await relink(first.hostKey, first.placeId, first.pair, BACK, c => void box(c, HETZNER));
      sockets.push(back.client.ws);
      await until(() => pushed.at(-1) === "unsupported", 1000);
      release();
      await until(() => cloudPushed > 0);
      expect(pushed.at(-1)).toBe("unsupported");
    } finally {
      stop();
    }
  });
});
