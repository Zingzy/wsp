// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, placeCannotBootLine, type PlaceReport } from "@wsp/protocol";
import { until } from "./until.js";
import { report } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, answersLeave, remove } from "./places-fixture.js";

describe("a computer that turns unable to run workspaces keeps its link, and refuses only what runs inside a copy", () => {
  const BLOCKED = "this computer mounts cgroup v1 at /sys/fs/cgroup, and wsp runs workspaces on cgroup v2 alone: boot it with systemd.unified_cgroup_hierarchy=1";
  const blocked = (): PlaceReport => report("srv", { daemonVersion: DAEMON_VERSION, runsWorkspaces: false, workspacesBlocked: BLOCKED });
  const SAID = placeCannotBootLine("srv", BLOCKED);

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
});
