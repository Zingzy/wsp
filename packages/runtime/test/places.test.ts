// SPDX-License-Identifier: AGPL-3.0-only
// The host's side of a place: the handshake a joining computer takes, the
// records and links the door holds, the workspace a join records, and the two
// ops a person's own socket reaches. The signatures here are real ed25519
// ones, so what the door verifies is what a place would send.
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { connect as netConnect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import {
  AGENTS_ON,
  placeSettingsLine,
  dayStart,
  spendCapRefusal,
  NO_PLACE_INSTALLER,
  PLACE_CODE_REFUSAL,
  PLACE_DOOR_REFUSAL,
  PLACE_DOOR_UNSERVED,
  PLACES_TICKET_REFUSAL,
  deviceHeldRefusal,
  noSignInRefusal,
  SIGN_IN_LINE_REFUSAL,
  AGENTS_KEY_REFUSAL,
  PLACE_LOGIN_REFUSED_KIND,
  PLACE_HOST_KEY_KIND,
  PLACE_KEY_REFUSAL,
  PLACE_UNKNOWN_REFUSAL,
  placeRefusalTranscript,
  PLACE_LINK_NONCE_BYTES,
  DAEMON_VERSION,
  FS_FOLDERS_DAEMON_VERSION,
  PLACE_WORKSPACE_PATH,
  placeBehindLine,
  agentsCell,
  placeDaemonBehind,
  placeWatchesItselfLine,
  forkProcsUnreadLine,
  forkOpRefusedLine,
  placeServesDaemonLine,
  noHostCliLine,
  THREAD_OPS,
  placeDaemonPaths,
  absentComputer,
  workspaceStateOf,
  placeBuildsNoImageLine,
  placeForksNowhereLine,
  placeCannotBootLine,
  placeNotAWorkspaceLine,
  placeNotAWorkspaceFix,
  workspaceState,
  placeLinkTranscript,
  joinToken,
  readJoinToken,
  JoinMint,
  PAIR_CODE_TTL_MS,
  MINT_JOIN_REFUSAL,
  PLACES_WORDS,
  SSH_HOSTS_REFUSAL,
  placeNoDaemonPortLine,
  placeNoLinkLine,
  placeNoHomeLine,
  MCP_ID_PREFIX,
  placeProvisionPaths,
  placeProvisioningLine,
  placeStillInstalledLine,
  placeDialBackLine,
  placeWentAwayLine,
  workFolderIn,
  copyStoppedLine,
  NO_IMAGES_HERE,
  probePath,
  twoPlacesRefusal,
  HERE_PLACE_ID,
  noSuchPlaceRefusal,
  providerFoldersRefusal,
  providerAgentsRefusal,
  refusal,
  type HostFolderListing,
  type AgentsSignInEvent,
  type GoldenStageEvent,
  type PlaceBack,
  type PlaceProvisionRow,
  type PlaceStageEvent,
  type PlaceReport,
  type PlaceView,
  type TurnResult,
  TURN_WALL_MS,
  turnCutLine,
  PLACE_SUDO_KIND,
} from "@wsp/protocol";
import { CODEX_TOML, MCP_SERVERS_JSON, TOOL_PREFIX, installEnv, installHomes } from "@wsp/catalog";
import type { MachineExecOptions } from "../src/machine-exec.js";
import { copyKey, createRuntime, GUEST_LOGIN_ENV, wiredPlace, type GoldenRecipe, type HarnessAdapterFactory, type HostFolders, type PlaceBackends, type Runtime } from "../src/runtime.js";
import { COPY_RECIPE, dfOk, recipeWith } from "./image-fixtures.js";
import { HANDSHAKE, MCP_READ_MARK, NoProviderBackend, SERVER_MARK, keyFingerprint, type Machine, type MachineBackend, type ProvisionPlan } from "@wsp/engine";
import { freshEphemeral, makeSeal, sealKeys, sharedSecret } from "@wsp/keys";
import { NO_PLACE_UPDATER, PlaceAddTakenBackError, PlaceLoginRefusedError, PlaceProvisioningError, type PlaceBackHolder, type PlaceRecord, newPlaceKeyPair, signInsOf, placeLoginRoadLine, placeSweptOverLinkLine, placeSweptOverSshLine, type PlaceDialler, type PlaceInstallRequest, type PlaceKeyPair, type PlaceLeaveRequest, type PlaceLeaver, type PlaceLogin, type PlaceProvisioner, type PlaceUpdateRequest, type PlaceUpdater, type PlaceWiring } from "../src/places.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { NO_AGENTS_READER, type AgentsActs, type AgentsOn, type AgentsReader, type ServerIcons, type ServersActs, type SkillsActs } from "../src/agents-read.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, createOn, fakeLocal, projectOn } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { scriptGuest } from "./script-guest.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { DOOR, HERE, agreeing, joinAt, nonce, relinkAt, report, signWith, wiring } from "./place-join.js";
import { PR_REST, ctx, sockets, serving, code, join, relink, yielding, placesOf, saysItsFacts, LOGINS, answersLeave, remove, ForkingPlace, PLACE_FACTS, PLACE_ROADS, KEEPS_NO_IMAGE, SEALED, HOLDS_PROJECTS, forks, daemonOps } from "./places-fixture.js";

describe("a code spent by a road that proves itself another way", () => {
  it("spends once: the second spend is false, whatever asks", async () => {
    const store = memoryStore();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const issued = await ctx.runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await ctx.runtime.devices.spend(issued.code, 1)).toBe(true);
    expect(await ctx.runtime.devices.spend(issued.code, 2)).toBe(false);
  });

  it("still admits a device on a fresh code and refuses a spent one, which is one code store for both roads", async () => {
    const store = memoryStore();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const first = await ctx.runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await ctx.runtime.devices.redeem(first.code, "a laptop", 1)).toBeDefined();
    expect(await ctx.runtime.devices.redeem(first.code, "a laptop", 2)).toBeUndefined();
    const second = await ctx.runtime.devices.issue({ now: 0, ttlMs: 10_000 });
    expect(await ctx.runtime.devices.spend(second.code, 1)).toBe(true);
    expect(await ctx.runtime.devices.redeem(second.code, "a laptop", 2)).toBeUndefined();
  });

  it("refuses a code that ran out, and spends it either way so one guess never gets two tries", async () => {
    const store = memoryStore();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
    const issued = await ctx.runtime.devices.issue({ now: 0, ttlMs: 10 });
    expect(await ctx.runtime.devices.spend(issued.code, 100)).toBe(false);
    expect(await ctx.runtime.devices.spend(issued.code, 5)).toBe(false);
  });
});

describe("a computer joining", () => {
  it("is recorded on a host nothing has asked a verb of yet, which is every host a place dials as it starts", async () => {
    // The records are read lazily, on the first verb; a place dials on its own and asks for none, so the roads it
    // reaches wait on that one reading rather than finding an empty host.
    const store = memoryStore();
    const hostKey = newPlaceKeyPair();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    // A second host over the same store, asked nothing, still sees the name the first one recorded.
    await ctx.srv.close();
    await ctx.runtime.close();
    ctx.runtime = createRuntime({ backend: stubBackend(), store, adapters: {}, placeLinks: wiring(hostKey) });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(second.placeId).toMatch(/^p_[0-9a-f]{16}$/);
    expect((await placesOf()).filter(p => p.name === "old-macbook")).toHaveLength(2);
  });

  it("spends the code, records the place with its key and report, marks it default, and records no workspace of its own", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    expect(placeId).toMatch(/^p_[0-9a-f]{16}$/);
    const places = await placesOf();
    const row = places.find(p => p.id === placeId)!;
    expect(row).toMatchObject({ kind: "computer", name: "old-macbook", default: true, takesForks: true, os: "Ubuntu 24.04", present: true });
    expect(row.shape).toEqual({ cpu: 4, memMb: 4096 });
    // The computer is a place, not a workspace: nothing is on the sidebar or in wsp workspaces until a fork lands.
    expect(await ctx.runtime!.workspaces.list()).toEqual([]);
  });

  it("refuses a computer whose kernel cannot boot the image, in the doctor's own sentence, and writes no record for it", async () => {
    const { hostKey, store } = await serving();
    const blocked = "this computer's kernel has no overlay filesystem, which a workspace here reads this computer's own directories through";
    // The report crosses on the prove, inside the seal, so that is where a computer that cannot boot is turned
    // down: nothing of it was read before this host had proved the key the join line named.
    const { client, proved } = await join(hostKey, { code: await code(), report: report("laptop", { runsWorkspaces: false, workspacesBlocked: blocked }), expectProved: false });
    sockets.push(client.ws);
    expect(String(proved["error"])).toBe(placeCannotBootLine("laptop", blocked));
    expect((await placesOf()).filter(p => p.id !== "here")).toEqual([]);
    expect(await store.list("places")).toEqual([]);
  });

  it("names a word that is a place and not a workspace with the road to a workspace there, rather than calling it missing", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // What wsp run <place> and wsp exec <place> meet: both resolve their target through this one reading.
    await expect(ctx.runtime!.workspaces.resolve("old-macbook")).rejects.toThrow(placeNotAWorkspaceLine("old-macbook"));
    await expect(ctx.runtime!.workspaces.resolve("old-macbook")).rejects.toThrow(placeNotAWorkspaceFix("old-macbook"));
  });

  it("refuses a code this host is not holding, in the one sentence every reason reads as", async () => {
    const { hostKey } = await serving();
    const { client, proved } = await join(hostKey, { code: "NOTACODE", expectProved: false });
    expect(String(proved["error"])).toContain("wsp add");
    expect(proved).toMatchObject({ ok: false, error: PLACE_CODE_REFUSAL, kind: "auth" });
    expect(await client.closed()).toBe(4401);
  });

  it("refuses a code a second time, so a spent code is worth nothing", async () => {
    const { hostKey } = await serving();
    const spent = await code();
    const first = await join(hostKey, { code: spent });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: spent, expectProved: false });
    expect(second.proved).toMatchObject({ ok: false, error: PLACE_CODE_REFUSAL });
    expect(await placesOf()).toHaveLength(2); // this computer and the one place that did join
  });

  it("refuses a report whose home is not a plain path, before the code is spent", async () => {
    const { hostKey } = await serving();
    const fresh = await code();
    const bad = await join(hostKey, { code: fresh, report: report("old-macbook", { login: { HOME: "/home/maya; rm -rf /" } }), expectProved: false });
    expect(bad.proved.ok).toBe(false);
    expect(String(bad.proved["error"])).toContain("not a plain path");
    // The code was not spent by a join that was never going to stand.
    const good = await join(hostKey, { code: fresh });
    sockets.push(good.client.ws);
    expect(good.placeId).not.toBe("");
  });

  it("writes no record and spends no code for a join whose prove this host refused, so nothing of it is left behind", async () => {
    const { hostKey, store } = await serving();
    const fresh = await code();
    const slipped = await join(hostKey, {
      code: fresh,
      report: report("old-macbook", { login: { HOME: "/home/m; rm -rf /", USER: "maya", PATH: "/usr/bin" } }),
      expectProved: false,
    });
    expect(slipped.proved).toMatchObject({ ok: false });
    expect(String(slipped.proved["error"])).toContain("not a plain path");
    expect(await slipped.client.closed()).toBe(4401);
    // The record is written on the prove and on nothing before it, so a join answered and never proved leaves no
    // place standing and no code spent.
    expect(await store.list("places")).toEqual([]);
    expect((await placesOf()).filter(p => p.id !== "here")).toEqual([]);
    const good = await join(hostKey, { code: fresh });
    sockets.push(good.client.ws);
    expect(good.placeId).not.toBe("");
  });

  it("refuses the same report on a relink, and the workspace keeps the login it had", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    const again = await relink(hostKey, joined.placeId, joined.pair, report("old-macbook", { login: { HOME: "/home/m; rm -rf /", USER: "maya", PATH: "/usr/bin" } }));
    expect(again.proved).toMatchObject({ ok: false });
    expect(String(again.proved["error"])).toContain("not a plain path");
    expect(await again.client.closed()).toBe(4401);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.present).toBe(false);
    expect((await ctx.runtime!.places!.reportOf(joined.placeId))!.login["HOME"]).toBe("/home/maya");
  });

  it("keeps the name this computer joined under, whatever a later report calls itself", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code(), name: "old-macbook" });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    // A box whose own place file a hostile process edited: it relinks under the name of another computer on this
    // host, and everything that names that word would follow it.
    const again = await relink(hostKey, joined.placeId, joined.pair, report("attic-server"));
    expect(again.proved.ok, String(again.proved["error"])).toBe(true);
    sockets.push(again.client.ws);
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.name).toBe("old-macbook");
    // The rest of the report is the newest one all the same: the name is the one field a relink cannot move.
    expect((await ctx.runtime!.places!.reportOf(joined.placeId))!.name).toBe("attic-server");
    await expect(ctx.runtime!.places!.placeFor("attic-server")).rejects.toThrow(/no place named attic-server/);
    expect(await ctx.runtime!.places!.placeFor("old-macbook")).toEqual({ placeId: joined.placeId });
  });

  it("refuses a word two computers on this host answer to, with both ids, and lands nothing on either", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code(), name: "old-macbook" });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: await code(), name: "old-macbook" });
    sockets.push(second.client.ws);
    // Both joined under the word, which is the person's own doing and not a name one of them took; ids tell them
    // apart, so every road that resolves the word says so rather than taking whichever joined first.
    await expect(ctx.runtime!.places!.placeFor("old-macbook")).rejects.toThrow(twoPlacesRefusal("old-macbook", [first.placeId, second.placeId]));
    expect(await ctx.runtime!.places!.placeFor(second.placeId)).toEqual({ placeId: second.placeId });
  });

  it("keeps a report's PATH and store folders only where they are plain paths, as the ssh read does", async () => {
    const { hostKey } = await serving();
    const sent = report("old-macbook", {
      login: { HOME: "/home/maya", USER: "maya", PATH: "/home/maya/bin:/usr/bin:/opt/a b", CLAUDE_CONFIG_DIR: "/tmp/x; rm -rf /" },
    });
    const joined = await join(hostKey, { code: await code(), report: sent });
    sockets.push(joined.client.ws);
    const kept = await ctx.runtime!.places!.reportOf(joined.placeId);
    expect(kept!.login["CLAUDE_CONFIG_DIR"]).toBeUndefined();
    expect(kept!.login["PATH"]).toBe("/home/maya/bin:/usr/bin");
    expect(kept!.login["HOME"]).toBe("/home/maya");
  });

  it("draws a joined Mac as the Mac its report names, and a computer that names no Mac as none", async () => {
    const { hostKey } = await serving();
    const mac = await join(hostKey, { code: await code(), report: report("studio", { platform: "darwin", os: "Darwin 25.4.0", model: "Mac mini (2024)" }) });
    sockets.push(mac.client.ws);
    const box = await join(hostKey, { code: await code(), report: report("vps") });
    sockets.push(box.client.ws);
    const views = await placesOf();
    expect(views.find(p => p.id === mac.placeId)?.mac).toBe("mac-mini");
    expect(views.find(p => p.id === box.placeId)?.mac).toBeUndefined();
  });

  it("records a second computer under a name another place already holds, since a place is no workspace and ids tell them apart", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    sockets.push(first.client.ws);
    const second = await join(hostKey, { code: await code() });
    sockets.push(second.client.ws);
    expect(second.reply["notice"]).toBeUndefined();
    expect((await placesOf()).filter(p => p.name === "old-macbook").map(p => p.id).sort()).toEqual([first.placeId, second.placeId].sort());
    expect(await ctx.runtime!.workspaces.list()).toEqual([]);
  });
});

describe("a place dialling back in", () => {
  it("answers a signature this computer can check against the host's key over the transcript it challenged with", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    const again = await WsClient.connect(ctx.srv!.port);
    sockets.push(again.ws);
    const mine = nonce();
    const agreed = agreeing();
    const answer = await again.request("place.auth", { placeId, nonce: mine, ephemeral: agreed.ephemeral });
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["hostPublicKey"]).toBe(hostKey.publicKey);
    const { verify } = await import("node:crypto");
    const ok = verify(
      null,
      placeLinkTranscript("host", placeId, mine, String(answer["nonce"]), { challenger: agreed.ephemeral, answerer: String(answer["ephemeral"]) }),
      { key: Buffer.from(hostKey.publicKey, "base64"), format: "der", type: "spki" },
      Buffer.from(String(answer["signature"]), "base64"),
    );
    expect(ok).toBe(true);
  });

  it("refuses an id this host holds no place by, with its own key over the sentence it refused with", async () => {
    const { hostKey } = await serving();
    const c = await WsClient.connect(ctx.srv!.port);
    const mine = nonce();
    const answer = await c.request("place.auth", { placeId: "p_deadbeefdeadbeef", nonce: mine });
    expect(answer).toMatchObject({ ok: false, error: PLACE_UNKNOWN_REFUSAL, kind: "auth" });
    // The word is this host's own and the computer that dialled can prove it: the key it pinned at join over the
    // place it named, the nonce it challenged with and the sentence. That is what earns it the long wait.
    expect(answer["hostPublicKey"]).toBe(hostKey.publicKey);
    const { verify } = await import("node:crypto");
    const stands = (bytes: Uint8Array): boolean =>
      verify(null, bytes, { key: Buffer.from(hostKey.publicKey, "base64"), format: "der", type: "spki" }, Buffer.from(String(answer["signature"]), "base64"));
    expect(stands(placeRefusalTranscript("p_deadbeefdeadbeef", mine, PLACE_UNKNOWN_REFUSAL))).toBe(true);
    expect(stands(placeRefusalTranscript("p_deadbeefdeadbeef", nonce(), PLACE_UNKNOWN_REFUSAL))).toBe(false);
    expect(await c.closed()).toBe(4401);
  });

  it("refuses a prove signed over the wrong transcript, and attaches nothing", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    first.client.close();
    const other = newPlaceKeyPair();
    const c = await WsClient.connect(ctx.srv!.port);
    const mine = nonce();
    const agreed = agreeing();
    const challenged = await c.request("place.auth", { placeId: first.placeId, nonce: mine, ephemeral: agreed.ephemeral });
    agreed.sealFrom(c, first.placeId, challenged);
    const bad = await c.request("place.prove", {
      // Signed with a key this host never learned, which is what a place file copied off a computer would carry.
      signature: signWith(other.privateKeyPem, placeLinkTranscript("place", first.placeId, String(challenged["nonce"]), mine, { challenger: String(challenged["ephemeral"]), answerer: agreed.ephemeral })),
      report: report(),
    });
    expect(bad).toMatchObject({ ok: false, error: PLACE_KEY_REFUSAL });
    expect(await c.closed()).toBe(4401);
  });

  it("refuses a computer whose wsp agrees no key for the link, in the sentence its row already carries, and attaches nothing", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    sockets.push(joined.client.ws);
    const behind = await WsClient.connect(ctx.srv!.port);
    // A daemon older than the seal sends no half of the key agreement: every frame after the handshake would
    // travel where whoever carries the bytes reads it.
    const answer = await behind.request("place.auth", { placeId: joined.placeId, nonce: nonce() });
    expect(answer.ok).toBe(false);
    expect(String(answer["error"])).toContain("is behind");
    expect(await behind.closed()).toBe(4401);
    // The link the join opened is the one this host still holds: nothing of the older dial replaced it.
    expect((await placesOf()).find(p => p.id === joined.placeId)!.present).toBe(true);
  });

  it("takes every frame the computer sends the moment its prove is answered, over a store whose reads and writes yield", async () => {
    // A store on a disk or behind a network turns the loop inside every read and write. The daemon sends its
    // hello the moment its prove is answered, so a handover that let the loop turn between the door's listener
    // and the link's own would lose that frame, leave the two counters a frame apart and close the link on the
    // next one. A memory store hides it by answering inside its own async method.
    const { hostKey } = await serving({ store: yielding(memoryStore()) });
    const joined = await join(hostKey, { code: await code() });
    sockets.push(joined.client.ws);
    joined.client.say({ type: "daemon.hello", root: "/root", version: 17 });
    joined.client.say({ type: "daemon.hello", root: "/root", version: 17 });
    // One more once the record writes are done and the link's own listener certainly stands: a frame lost in the
    // gap leaves this one sealed at a counter the host is not at, which is what ends the link.
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    joined.client.say({ type: "daemon.hello", root: "/root", version: 17 });
    // Nothing closed the link: every frame opened under the key, in the order they were sent.
    const ended = await Promise.race([joined.client.closed(), new Promise<number>(done => setTimeout(() => done(-1), 400))]);
    expect(ended).toBe(-1);
  });

  it("seals every frame after the handshake both ways, and ends a socket that sends one in the clear", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    sockets.push(joined.client.ws);
    // The reply to the prove was binary and opened under the key both ends agreed: the client read it, which is
    // what the prove standing means. A frame in the clear after it is a carrier writing into the link.
    const straight = await WsClient.connect(ctx.srv!.port);
    const agreed = agreeing();
    const challenged = await straight.request("place.auth", { placeId: joined.placeId, nonce: nonce(), ephemeral: agreed.ephemeral });
    expect(challenged.ok).toBe(true);
    agreed.sealFrom(straight, joined.placeId, challenged);
    // Sent past the seal, as a carrier on the path of the bytes would send it.
    straight.ws.send(JSON.stringify({ id: 9, op: "place.prove", signature: Buffer.alloc(64, 1).toString("base64"), report: report() }));
    expect(await straight.closed()).toBe(4401);
  });

  it("refuses a second frame that is not the prove, and a prove on a socket that challenged nothing", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    const wrongOrder = await WsClient.connect(ctx.srv!.port);
    const agreed = agreeing();
    const challenged = await wrongOrder.request("place.auth", { placeId: joined.placeId, nonce: nonce(), ephemeral: agreed.ephemeral });
    // Everything after the host's reply is sealed, the refusal of a frame that is not the prove among it.
    agreed.sealFrom(wrongOrder, joined.placeId, challenged);
    const answer = await wrongOrder.request("status.list");
    expect(answer.ok).toBe(false);
    expect(await wrongOrder.closed()).toBe(4401);

    const bare = await WsClient.connect(ctx.srv!.port);
    const straight = await bare.request("place.prove", { signature: Buffer.alloc(64, 1).toString("base64"), report: report() });
    expect(straight.ok).toBe(false);
    expect(await bare.closed()).toBe(4401);
  });
});

describe("the socket a place proved", () => {
  it("stops being a client's: a runtime frame sent after the prove is never answered", async () => {
    const { hostKey } = await serving();
    const { client } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // The place door holds this socket now, and what it reads are daemon frames; the runtime answers nothing. The
    // op asked is one that answers off this process alone, so silence is the door and never a read that hung.
    const raced = await Promise.race([client.request("capabilities.get"), new Promise<"silence">(done => setTimeout(() => done("silence"), 300))]);
    expect(raced).toBe("silence");
    // And a socket nothing handed over answers it at once, so the silence above is this socket's and not the op's.
    const mine = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    sockets.push(mine.ws);
    expect((await mine.request("capabilities.get")).ok).toBe(true);
  });

  it("is replaced by a newer link for the same place, since a laptop that slept dials before the old socket is known to be dead", async () => {
    const { hostKey } = await serving();
    const first = await join(hostKey, { code: await code() });
    const closed = first.client.closed();
    // A second link proves with the key on record: the same handshake, a fresh socket. The door cuts the first.
    const { client: again } = await relink(hostKey, first.placeId, first.pair);
    sockets.push(again.ws);
    expect(await closed).toBe(1000);
    expect((await placesOf()).find(p => p.id === first.placeId)!.present).toBe(true);
  });

  it("moves the login a turn there runs under onto what the newest link reported", async () => {
    const { hostKey } = await serving();
    const joined = await join(hostKey, { code: await code() });
    joined.client.close();
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === false);
    // The person installed a tool under their home and restarted the agent: the next link is where wsp learns it.
    const moved = report("old-macbook", { login: { HOME: "/home/maya-moved", USER: "maya", PATH: "/home/maya/.npm-global/bin:/usr/bin" }, shape: { cpu: 8, memMb: 8192 } });
    const again = await WsClient.connect(ctx.srv!.port);
    sockets.push(again.ws);
    const mine = nonce();
    const agreed = agreeing();
    const challenged = await again.request("place.auth", { placeId: joined.placeId, nonce: mine, ephemeral: agreed.ephemeral });
    agreed.sealFrom(again, joined.placeId, challenged);
    const proved = await again.request("place.prove", {
      signature: signWith(joined.pair.privateKeyPem, placeLinkTranscript("place", joined.placeId, String(challenged["nonce"]), mine, { challenger: String(challenged["ephemeral"]), answerer: agreed.ephemeral })),
      report: moved,
    });
    expect(proved.ok, String(proved["error"])).toBe(true);
    await until(async () => (await placesOf()).find(p => p.id === joined.placeId)!.present === true);
    expect((await placesOf()).find(p => p.id === joined.placeId)!.shape).toEqual({ cpu: 8, memMb: 8192 });
    // The record reads the newest login, so every path a fork there is built from moved with it.
    await until(async () => (await ctx.runtime!.places!.reportOf(joined.placeId))!.login["HOME"] === "/home/maya-moved");
  });

  it("marks the place absent when the socket goes, and moves its last seen", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    expect((await placesOf()).find(p => p.id === placeId)!.present).toBe(true);
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    expect((await placesOf()).find(p => p.id === placeId)!.lastSeenAt).toBeDefined();
  });
});
