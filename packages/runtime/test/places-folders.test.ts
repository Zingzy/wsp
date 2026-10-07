// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { COMPUTER_ROAD, PLACES_TICKET_REFUSAL, DAEMON_VERSION, FS_FOLDERS_DAEMON_VERSION, PLACE_WORKSPACE_PATH, placeBehindLine, placeDaemonBehind, absentComputer, HERE_PLACE_ID, noSuchPlaceRefusal, providerFoldersRefusal, type HostFolderListing } from "@wsp/protocol";
import { TOOL_PREFIX, installEnv, installHomes } from "@wsp/catalog";
import { removeScript } from "../src/project-landing.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { report } from "./place-join.js";
import { ctx, sockets, serving, code, join, ForkingPlace, HOLDS_PROJECTS, forks } from "./places-fixture.js";

describe("a project on a computer you joined", () => {
  /** Every command that computer was asked to run on itself rather than in a workspace on it. */
  const onItself = (client: WsClient): string[] => {
    const ran: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { op?: string; cmd?: string };
      if (frame.op === "exec") ran.push(String(frame.cmd));
    });
    return ran;
  };

  it("is cloned by the add into the folder that computer keeps checkouts in, and that folder goes when the record does", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, HOLDS_PROJECTS)) });
    sockets.push(client.ws);
    const ran = onItself(client);
    const project = await ctx.runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing-906" });
    // The checkout is wsp's own folder on that computer, and what a workspace of it reads is outside the
    // computer's own home.
    expect(project.checkout).toBe(`/wsp/projects/${project.id}/checkout`);
    expect(project.path).toBe("/srv/landing-906");
    // One workspace of that computer did the work and was stopped; the clone ran inside it.
    expect(place.created).toHaveLength(1);
    expect(place.killed).toHaveLength(1);
    // And it read what a workspace there reads: a computer that keeps no image is worked in a copy of its own
    // directories with the shared home bound in, so the install runs on the prefix's order and its knobs rather
    // than finding whatever stands under that home.
    const envs = place.created[0]!["envs"] as Record<string, string>;
    expect(envs["PATH"]).toBe(PLACE_WORKSPACE_PATH);
    expect(envs).toMatchObject(installEnv(installHomes(TOOL_PREFIX)));
    // The remove runs one command on the computer itself, over the same link, and says what went.
    const { said } = await ctx.runtime!.projects.remove(project.id);
    // That one command reads whether the agent there kept memory for this project and then takes wsp's own
    // folder; this computer answered nothing, so the sentence ends at the checkout rather than naming a folder
    // that is not there.
    expect(ran.filter(cmd => cmd.includes("rm -rf"))).toEqual([removeScript({ dir: `/wsp/projects/${project.id}`, memoryDir: project.memoryDir })]);
    expect(said).toBe(`landing-906 is no longer a project on srv; the folder wsp kept for it there, /wsp/projects/${project.id}, is gone with its checkout`);
    expect(await ctx.runtime!.projects.list()).toEqual([]);
  });

  it("is refused in that computer's own absent sentence while it is not connected, with nothing made anywhere", async () => {
    const { hostKey } = await serving();
    let place!: ForkingPlace;
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", answers: c => (place = forks(c, undefined, undefined, HOLDS_PROJECTS)) });
    sockets.push(client.ws);
    // The computer says what it forks with once, then goes.
    await until(async () => ctx.runtime!.places!.offerOf(placeId) === HOLDS_PROJECTS.offer);
    client.close();
    await until(async () => (await ctx.runtime!.places!.list(0)).find(p => p.id === placeId)?.present === false);
    await expect(ctx.runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing-906" })).rejects.toThrow(absentComputer("srv", null).sentence);
    // Nothing was forked there and nothing was recorded here: the refusal comes before either.
    expect(place.created).toEqual([]);
    expect(await ctx.runtime!.projects.list()).toEqual([]);
  });
});

describe("the folders of a computer you own", () => {
  const LISTING: HostFolderListing = { dir: "/home/maya", roots: ["/home/maya", "/wsp/projects/p_1/checkout"], folders: [{ path: "/home/maya/code", repo: true }], hidden: 2 };

  /** That computer's daemon answering the folders frame, keeping every one it was asked. */
  const listsFolders = (asked: Record<string, unknown>[], answer: Record<string, unknown> = { ok: true, ...LISTING }) => (c: WsClient) =>
    c.onFrame(raw => {
      const frame = raw as unknown as Record<string, unknown>;
      if (frame["op"] !== "fs.folders") return;
      asked.push(frame);
      c.say({ id: frame["id"], ...answer });
    });

  async function mine(): Promise<WsClient> {
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(c.ws);
    return c;
  }

  it("are read by that computer's daemon over its link, told the folder of every project recorded there, and answered as it listed them", async () => {
    const { hostKey } = await serving();
    const asked: Record<string, unknown>[] = [];
    const { client, placeId } = await join(hostKey, {
      code: await code(),
      name: "srv",
      report: report("srv", { daemonVersion: DAEMON_VERSION }),
      answers: c => {
        forks(c, undefined, undefined, HOLDS_PROJECTS);
        listsFolders(asked)(c);
      },
    });
    sockets.push(client.ws);
    const project = await ctx.runtime!.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "srv", name: "landing" });
    const c = await mine();
    const listed = await c.request("host.folders", { on: placeId, dir: "/home/maya", hidden: true });
    expect(listed.ok, String(listed["error"])).toBe(true);
    expect(listed["listing"]).toEqual(LISTING);
    // The repos listing is that computer's too, over the same frame.
    expect((await c.request("host.folders", { on: placeId, repos: true })).ok).toBe(true);
    expect(asked).toEqual([
      { id: expect.anything(), op: "fs.folders", dir: "/home/maya", hidden: true, projects: [project.checkout], road: COMPUTER_ROAD },
      { id: expect.anything(), op: "fs.folders", repos: true, projects: [project.checkout], road: COMPUTER_ROAD },
    ]);
  });

  it("carry that daemon's own refusal, and are read by a daemon one behind this host's", async () => {
    const { hostKey } = await serving();
    const refusal = "/etc is outside the folders wsp browses on that computer: /home/maya";
    const asked: Record<string, unknown>[] = [];
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: listsFolders(asked, { ok: false, code: "outside-root", error: refusal }) });
    sockets.push(client.ws);
    const c = await mine();
    expect(await c.request("host.folders", { on: placeId, dir: "/etc" })).toMatchObject({ ok: false, error: refusal });
    const behind = await join(hostKey, { code: await code(), name: "old-box", report: report("old-box", { daemonVersion: DAEMON_VERSION - 1 }), answers: listsFolders(asked) });
    sockets.push(behind.client.ws);
    const listed = await c.request("host.folders", { on: behind.placeId, dir: "/home/maya" });
    expect(listed.ok, String(listed["error"])).toBe(true);
    expect(listed["listing"]).toEqual(LISTING);
    expect(asked.map(f => f["dir"])).toEqual(["/etc", "/home/maya"]);
    // One too old to list folders at all is named behind rather than asked.
    const old = report("older-box", { daemonVersion: FS_FOLDERS_DAEMON_VERSION - 1 });
    const older = await join(hostKey, { code: await code(), name: "older-box", report: old, answers: listsFolders(asked) });
    sockets.push(older.client.ws);
    expect(await c.request("host.folders", { on: older.placeId })).toMatchObject({ ok: false, error: placeBehindLine("older-box", placeDaemonBehind(old)!) });
    expect(asked).toHaveLength(2);
  });

  it("are refused on a provider in one sentence saying what to do instead, on a place nobody holds by the places there are, and on a computer that is not connected by its absent sentence", async () => {
    const { hostKey } = await serving({ provider: { id: "solari", rateUsdPerHour: 0.11 } });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }) });
    sockets.push(client.ws);
    const c = await mine();
    const rows = await ctx.runtime!.places!.list(Date.now());
    const provider = rows.find(p => p.kind !== "computer")!;
    expect(await c.request("host.folders", { on: provider.id })).toMatchObject({ ok: false, error: providerFoldersRefusal(provider.name), kind: "usage" });
    expect(await c.request("host.folders", { on: "pl_nobody" })).toMatchObject({ ok: false, error: noSuchPlaceRefusal("pl_nobody", rows.map(p => p.name)), kind: "usage" });
    client.close();
    await until(async () => (await ctx.runtime!.places!.list(0)).find(p => p.id === placeId)?.present === false);
    expect(await c.request("host.folders", { on: placeId })).toMatchObject({ ok: false, error: absentComputer("srv", null).sentence });
  });

  it("are this computer's own when the ask names this computer or none, and a computer of yours is the host's own road alone", async () => {
    const seen: { dir?: string; hidden?: boolean; wide?: boolean }[] = [];
    const here: HostFolderListing = { dir: "/Users/dev", roots: ["/Users/dev"], folders: [], hidden: 0 };
    const { hostKey } = await serving({ folders: { list: async req => (seen.push(req), here) } });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: report("srv", { daemonVersion: DAEMON_VERSION }), answers: listsFolders([]) });
    sockets.push(client.ws);
    const c = await mine();
    expect((await c.request("host.folders", { on: HERE_PLACE_ID, hidden: true }))["listing"]).toEqual(here);
    expect((await c.request("host.folders", {}))["listing"]).toEqual(here);
    expect(seen).toEqual([{ hidden: true, wide: false }, { wide: false }]);
    const issued = await c.request("ticket.issue", { purpose: "connect" });
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    expect(await ticketed.request("host.folders", { on: placeId })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
  });
});
