// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { PLACES_TICKET_REFUSAL, DAEMON_VERSION, agentsCell, THREAD_OPS, readJoinToken, type PlaceReport } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { newPlaceKeyPair, signInsOf } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { DOOR, HERE, report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, saysItsFacts, LOGINS, remove, PLACE_FACTS } from "./places-fixture.js";

describe("what a computer says it forks with", () => {
  it("is asked once per computer, and asked again when it dials back on another daemon, so a field the version before it never carried lands on the row", async () => {
    const { hostKey } = await serving();
    const asks = { count: 0 };
    let logins: string | undefined;
    const answers = saysItsFacts(() => ({ ...PLACE_FACTS, ...(logins === undefined ? {} : { logins }) }), asks);
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers });
    sockets.push(client.ws);
    // The first attach asks, and what that daemon said is kept: it shares no logins, so the row carries none.
    await until(async () => ctx.runtime!.places!.offerOf(placeId) === PLACE_FACTS.offer);
    expect(asks.count).toBe(1);
    expect((await placesOf()).find(p => p.id === placeId)!.logins).toBeUndefined();

    // A dial on the same daemon is the same computer saying the same thing: nothing is asked again.
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const same = await relink(hostKey, placeId, pair, behind, answers);
    sockets.push(same.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === true);
    expect(asks.count).toBe(1);

    // It takes the daemon this host deploys and dials back on it, and that one shares its logins.
    logins = LOGINS;
    same.client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const newer = await relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION }), answers);
    sockets.push(newer.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.logins === LOGINS);
    expect(asks.count).toBe(2);
    // The backend a fork there stands on reads the same answer, which is what fills a create's shares.
    expect(ctx.runtime!.places!.backendOf(placeId)?.logins).toBe(LOGINS);
  });

  it("is read over the link a join has just opened, so the row an install answers with already says where that computer keeps its logins", async () => {
    const hostKey = newPlaceKeyPair();
    const asks = { count: 0 };
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store: memoryStore(),
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          const { client } = await join(hostKey, {
            code: readJoinToken(req.code).code,
            name: "box",
            answers: saysItsFacts(() => ({ ...PLACE_FACTS, logins: LOGINS }), asks),
          });
          sockets.push(client.ws);
          return { name: "box" };
        },
      },
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const added = await ctx.runtime.places!.add({ address: "root@10.0.0.9", name: "box", hostUrls: DOOR }, Date.now());
    // Before the add answers, not behind it: the sign-in the join offers next reads this field off the row.
    expect(added.place.logins).toBe(LOGINS);
    expect(asks.count).toBe(1);
  });

});

describe("a channel to the daemon on a computer you own", () => {
  it("rides the link that computer opened: the frame goes up it, the answer comes back under the ask, and what it pushes reaches the socket that asked", async () => {
    const { hostKey } = await serving();
    const asked: Record<string, unknown>[] = [];
    // The computer answers the pty frames the host sends it, as its own daemon would, and pushes one chunk back.
    const answers = (c: WsClient): void => {
      c.onFrame(raw => {
        const frame = raw as unknown as Record<string, unknown>;
        const op = frame["op"];
        if (typeof op !== "string" || !op.startsWith("pty.")) return;
        asked.push(frame);
        c.say({ id: frame["id"], ok: true, ptyId: "pty_7" });
        c.say({ type: "pty.data", ptyId: "pty_7", data: "Open https://auth.openai.com/device" });
      });
    };
    const { client, placeId } = await join(hostKey, { code: await code(), answers });
    sockets.push(client.ws);
    const mine = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(mine.ws);
    const opened = await mine.request("daemon.open", { placeId });
    expect(opened.ok, String(opened["error"])).toBe(true);
    const channel = String(opened["channel"]);
    const sent = await mine.request("daemon.send", { channel, frame: { op: "pty.create", cols: 80, rows: 24, env: { CODEX_HOME: "/wsp/logins/codex" } } });
    expect(sent["reply"]).toMatchObject({ ok: true, ptyId: "pty_7" });
    // The frame reached that computer whole, the environment the sign-in runs with included.
    expect(asked.at(-1)).toMatchObject({ op: "pty.create", cols: 80, env: { CODEX_HOME: "/wsp/logins/codex" } });
    await until(async () => mine.events.some(e => e.type === "daemon.event" && e["channel"] === channel && String((e["event"] as Record<string, unknown>)["data"]).includes("auth.openai.com")));
    // One daemon per channel: naming both, or neither, is the caller not saying which.
    expect((await mine.request("daemon.open", { placeId, workspaceId: "w_1" })).ok).toBe(false);
    expect((await mine.request("daemon.open", {})).ok).toBe(false);
    // The computer going away ends the channel, since whatever was running behind it is no longer reachable.
    client.close();
    await until(async () => mine.events.some(e => e.type === "daemon.closed" && e["channel"] === channel));
    // And a computer that is not connected has no channel to open at all.
    expect(String((await mine.request("daemon.open", { placeId }))["error"])).toContain("old-macbook");
  });

  it("is the host's own road: a socket let in on a ticket is refused, as it is for every other places op", async () => {
    const { hostKey } = await serving();
    const { placeId } = await join(hostKey, { code: await code() });
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(host.ws);
    const issued = await host.request("ticket.issue", { purpose: "connect" });
    expect(issued.ok, String(issued["error"])).toBe(true);
    const ticketed = await WsClient.connect(ctx.srv!.port, { ticket: String(issued["ticket"]) });
    sockets.push(ticketed.ws);
    const refused = await ticketed.request("daemon.open", { placeId });
    expect(refused.ok).toBe(false);
    expect(refused["error"]).toBe(PLACES_TICKET_REFUSAL);
  });
});

describe("what stands for each agent on a computer you own", () => {
  const withAgents = (over: Partial<PlaceReport> = {}) => report("spoo", { agents: ["claude", "codex"], ...over });

  it("reads a login off the files that computer listed, else the vault's variable, else nothing", () => {
    const signedIn = signInsOf(withAgents({ logins: ["codex/auth.json"] }), {});
    // Codex signed in on the box itself: that file is what every workspace there shares.
    expect(signedIn).toEqual({ claude: "none", codex: "signed-in" });
    // Claude Code keeps no login on a machine at all, so the vault's token or key is the whole of its sign-in there.
    expect(signInsOf(withAgents({ logins: [] }), { ANTHROPIC_API_KEY: "sk-ant-x" })).toEqual({ claude: "vault-key", codex: "none" });
    expect(signInsOf(withAgents({ logins: [] }), { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" })).toEqual({ claude: "vault-key", codex: "none" });
    expect(signInsOf(withAgents({ logins: [] }), { OPENAI_API_KEY: "sk-x" })).toEqual({ claude: "none", codex: "vault-key" });
    // A login on the computer wins over a key this host holds, which is the order a turn there is handed.
    expect(signInsOf(withAgents({ logins: ["codex/auth.json"] }), { OPENAI_API_KEY: "sk-x" })?.codex).toBe("signed-in");
    // A folder with no file under it is no login: the name the row shares is what has to be there.
    expect(signInsOf(withAgents({ logins: ["gemini/oauth_creds.json"] }), {})?.codex).toBe("none");
  });

  it("says nothing at all about a computer whose daemon lists no logins, which is unknown and not none", () => {
    expect(signInsOf(withAgents(), {})).toBeUndefined();
  });

  it("puts the versions that computer reported and the word for each agent on its row", async () => {
    const { hostKey } = await serving({ vault: { ANTHROPIC_API_KEY: "sk-ant-x" } });
    const sent = withAgents({ logins: [], agentVersions: { claude: "2.1.270 (Claude Code)", codex: "codex-cli 0.153.0" } });
    const { client } = await join(hostKey, { code: await code(), report: sent });
    const row = (await placesOf()).find(p => p.name === "spoo")!;
    expect(row.agentVersions).toEqual(sent.agentVersions);
    expect(row.signIns).toEqual({ claude: "vault-key", codex: "none" });
    expect(agentsCell(row)).toBe("claude 2.1.270 your key, codex 0.153.0 not signed in");
    client.close();
  });

  it("leaves both off the row of a computer running a daemon older than they are", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code(), report: withAgents() });
    const row = (await placesOf()).find(p => p.name === "spoo")!;
    expect(row.agentVersions).toBeUndefined();
    expect(row.signIns).toBeUndefined();
    client.close();
  });
});

describe("the list of every place", () => {
  it("puts this computer first, the computers joined after it and the provider last, with exactly one default", async () => {
    const { hostKey } = await serving({ provider: { id: "box", rateUsdPerHour: 0.018 } });
    const first = await join(hostKey, { code: await code(), name: "box" });
    sockets.push(first.client.ws);
    const places = await placesOf();
    expect(places.map(p => p.kind)).toEqual(["computer", "computer", "provider"]);
    expect(places[0]).toMatchObject({ id: "here", name: HERE.name, present: true, takesForks: false });
    expect(places.at(-1)).toMatchObject({ id: "box", kind: "provider", rateUsdPerHour: 0.018, takesForks: true });
    expect(places.filter(p => p.default)).toHaveLength(1);
    expect(places.find(p => p.default)!.id).toBe(first.placeId);
  });

  it("falls back to this computer as the default when the place the mark named is gone, and forgets the cap set on it", async () => {
    const { hostKey, store } = await serving();
    const joined = await join(hostKey, { code: await code() });
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await host.request("places.set", { placeId: joined.placeId, threads: 1 })).toMatchObject({ ok: true });
    host.close();
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    const removed = await remove(joined.placeId);
    expect(removed["removed"]).toBe(true);
    const places = await placesOf();
    expect(places.find(p => p.default)!.id).toBe("here");
    expect(await store.get("caps", joined.placeId)).toBeUndefined();
  });

  it("notes a login a sign-in at a terminal landed on that computer, so the listing says signed in before it dials again", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), report: report("srv", { agents: ["codex"], logins: [] }) });
    sockets.push(joined.client.ws);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.signIns?.["codex"]).toBe("none");
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    expect(await host.request("places.loginLanded", { placeId: joined.placeId, agent: "codex" })).toMatchObject({ ok: true });
    host.close();
    expect((await placesOf()).find(p => p.id === joined.placeId)!.signIns?.["codex"]).toBe("signed-in");
  });

  it("is refused on a socket let in on a ticket, and is no op a thread may send", async () => {
    await serving();
    const host = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const { ticket } = (await host.request("ticket.issue", { purpose: "relay" })) as { ticket: string };
    host.close();
    const relayed = await WsClient.connect(ctx.srv!.port, { ticket });
    expect(await relayed.request("places.list")).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.remove", { placeId: "p_1" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.add", { address: "root@10.0.0.9" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.dial", { placeId: "p_1" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.loginLanded", { placeId: "p_1", agent: "codex" })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL });
    expect(await relayed.request("places.set", { placeId: "p_1", threads: 1 })).toMatchObject({ ok: false, error: PLACES_TICKET_REFUSAL, kind: "ticket" });
    relayed.close();
    expect(THREAD_OPS).not.toContain("places.list");
    expect(THREAD_OPS).not.toContain("places.remove");
    expect(THREAD_OPS).not.toContain("places.add");
  });
});
