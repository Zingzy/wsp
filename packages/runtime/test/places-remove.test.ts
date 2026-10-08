// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readJoinToken, placeNoLinkLine, MCP_ID_PREFIX, placeStillInstalledLine, PLACE_SUDO_KIND, heldPlaceScript, placeFileText, placeLoginOtherRefusal, placeLoginUncheckedRefusal, placeLoginElsewhere, placeLoginElsewhereRemovedLine } from "@wsp/protocol";
import { CODEX_TOML, MCP_SERVERS_JSON } from "@wsp/catalog";
import { createRuntime } from "../src/runtime.js";
import { HANDSHAKE, MCP_READ_MARK, SERVER_MARK } from "@wsp/engine";
import { PlaceHostKeyChangedError, PlaceLoginRefusedError, newPlaceKeyPair, placeLoginRoadLine, placeSweptOverLinkLine, placeElsewhereSweptOverLinkLine, placeSweptOverSshLine, type PlaceDialler, type PlaceKeyPair, type PlaceLeaveRequest, type PlaceLeaver, type PlaceLogin, type PlaceUpdateRequest, type PlaceWiring } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { DOOR, report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, placesOf, answersLeave, remove, saysItsFacts, PLACE_FACTS } from "./places-fixture.js";

describe("taking a place back out", () => {
  it("asks the linked place to sweep itself, drops the workspace standing on it, and answers what came off", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    // The place answers place.leave with what its own sweep took; the host never guesses that list.
    answersLeave(client, ["the systemd user unit", "/home/maya/.wsp/place.json"]);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual(["the systemd user unit", "/home/maya/.wsp/place.json"]);
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("takes the servers wsp merged into the agents' own files there back out before it asks that computer to leave", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    sockets.push(client.ws);
    const home = report().login["HOME"]!;
    const config = `${home}/.codex/config.toml`;
    const theirs = ['[projects."/root/repo"]', 'trust_level = "trusted"', ""];
    const text = [...theirs, "[mcp_servers.context7]", 'command = "npx"', ""].join("\n");
    const digest = createHash("sha256").update(CODEX_TOML.entryOf(text, "context7")!).digest("hex");
    // What that computer answers the two long reads of the unmerge with, in the order it makes them: the key
    // lines of the list beside its job, then the file that key sits in.
    const reads = [`${SERVER_MARK}\t${digest}\t${MCP_ID_PREFIX}codex/context7`, `${MCP_READ_MARK} 0 0 ${Buffer.from(text).toString("base64")}`];
    /** One poll of a detached run, as a guest answers it: the exit code, the output so far, and the run gone. */
    const polled = (out: string): string => ["WSP_POLL", "0", Buffer.from(`${out}\n`).toString("base64"), "", "down", "WSP_POLL_END"].join("\n");
    const order: string[] = [];
    client.onFrame(raw => {
      const frame = raw as unknown as { id?: number; op?: string; cmd?: string };
      const say = (body: Record<string, unknown>): void => client.say({ id: frame.id, ok: true, ...body });
      if (frame.op === "exec") {
        const cmd = String(frame.cmd);
        order.push(cmd);
        const stdout = cmd.includes(HANDSHAKE.launched) ? `${HANDSHAKE.launched}\n` : cmd.includes("WSP_POLL") ? polled(reads.shift() ?? "") : "";
        return say({ exitCode: 0, stdout, stderr: "", truncated: false });
      }
      if (frame.op === "place.leave") {
        order.push("place.leave");
        say({ swept: [`${home}/.wsp`] });
      }
    });

    const answer = await remove(placeId);
    // What came out of the agent's own file is said beside what the place's own sweep took.
    expect(answer["swept"]).toEqual([`context7 (out of ${config})`, `${home}/.wsp`]);
    // And the file was written back over the link before the leave took the folder holding the list.
    const wrote = order.findIndex(cmd => cmd.includes(`f='${config}'`) && cmd.includes('mv -f "$n" "$r"'));
    expect(wrote, order.join("\n")).toBeGreaterThanOrEqual(0);
    expect(wrote).toBeLessThan(order.indexOf("place.leave"));
  });

  for (const login of [{ user: "root", home: "/root", codex: "/var/lib/wsp/logins/codex/config.toml" }, { user: "maya", home: "/home/maya", codex: "/home/maya/.codex/config.toml" }]) {
    it(`takes wsp's servers out of the files a box's threads read on a computer joined as ${login.user}, its logins folder only where root reaches it`, async () => {
      const { hostKey } = await serving();
      const sent = report("vps", { login: { HOME: login.home, USER: "root", PATH: "/usr/bin" } });
      const { client, placeId } = await join(hostKey, { code: await code(), report: sent, answers: saysItsFacts(() => ({ ...PLACE_FACTS, logins: "/var/lib/wsp/logins" }), { count: 0 }) });
      sockets.push(client.ws);
      await until(async () => (await placesOf()).find(p => p.id === placeId)?.logins === "/var/lib/wsp/logins");
      const claude = JSON.stringify({ mcpServers: { gsc: { command: "npx", args: ["gsc-mcp"] } } });
      const codex = ["[mcp_servers.context7]", 'command = "npx"', ""].join("\n");
      const sha = (entry: string): string => createHash("sha256").update(entry).digest("hex");
      const keys = [`${SERVER_MARK}\t${sha(MCP_SERVERS_JSON.entryOf(claude, "gsc")!)}\t${MCP_ID_PREFIX}claude/gsc`, `${SERVER_MARK}\t${sha(CODEX_TOML.entryOf(codex, "context7")!)}\t${MCP_ID_PREFIX}codex/context7`].join("\n");
      const reads = [keys, `${MCP_READ_MARK} 0 0 ${Buffer.from(claude).toString("base64")}`, `${MCP_READ_MARK} 0 0 ${Buffer.from(codex).toString("base64")}`];
      const polled = (out: string): string => ["WSP_POLL", "0", Buffer.from(`${out}\n`).toString("base64"), "", "down", "WSP_POLL_END"].join("\n");
      const order: string[] = [];
      client.onFrame(raw => {
        const frame = raw as unknown as { id?: number; op?: string; cmd?: string };
        const say = (body: Record<string, unknown>): void => client.say({ id: frame.id, ok: true, ...body });
        if (frame.op === "exec") {
          const cmd = String(frame.cmd);
          order.push(cmd);
          // Who the box's lines run as: its daemon is root, and the home is the login's.
          if (cmd.includes("command -v runuser")) return say({ exitCode: 0, stdout: `Linux\n0\nroot\n${login.user}\n1\n${login.home}\n/usr/bin\n`, stderr: "", truncated: false });
          const stdout = cmd.includes(HANDSHAKE.launched) ? `${HANDSHAKE.launched}\n` : cmd.includes("WSP_POLL") ? polled(reads.shift() ?? "") : "";
          return say({ exitCode: 0, stdout, stderr: "", truncated: false });
        }
        if (frame.op === "place.leave") say({ swept: [] });
      });
      const answer = await remove(placeId);
      expect(answer["swept"]).toEqual([`gsc (out of ${login.home}/.claude-cfg/.claude.json)`, `context7 (out of ${login.codex})`]);
      for (const file of [`${login.home}/.claude-cfg/.claude.json`, login.codex]) expect(order.some(cmd => cmd.includes(`f='${file}'`) && cmd.includes('mv -f "$n" "$r"')), file).toBe(true);
    });
  }

  it("says the agent is still installed when the place was not connected to sweep", async () => {
    const { hostKey } = await serving();
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(answer["swept"]).toEqual([]);
    expect(String(answer["note"])).toContain("wsp leave on that computer");
  });

  it("answers that nothing was removed for an id this host holds no place by", async () => {
    await serving();
    expect(await remove("p_deadbeefdeadbeef")).toMatchObject({ removed: false });
  });

  it("never logs in to a computer that joined by typing a code, which this host holds no login for", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const { hostKey } = await serving({
      leave: async req => {
        asked.push(req);
        return [];
      },
    });
    const { client, placeId } = await join(hostKey, { code: await code() });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)!.present === false);
    const answer = await remove(placeId);
    expect(answer["removed"]).toBe(true);
    expect(asked).toEqual([]);
    expect(String(answer["note"])).toBe(placeStillInstalledLine("old-macbook"));
  });
});

/** The place file a box holds, naming one computer and the key of the host it joined. */
const placeFile = (placeId: string, hostPublicKey: string): string =>
  placeFileText({ placeId, name: "vps", hostName: "zingzys-mac", hostUrls: ["http://192.168.1.10:14621"], hostPublicKey, keyPath: "/home/maya/.wsp/place.key", joinedAt: "2026-10-07T00:00:00.000Z" });

/** A login that reaches whatever box `file` says stands there, writing down every script it was asked to run. */
const boxAnswering = (file: () => string, ran: string[] = []): NonNullable<PlaceWiring["runOver"]> => async (_login, script) => {
  ran.push(script);
  return { exitCode: 0, stdout: script === heldPlaceScript(report("vps").login["HOME"]!) ? file() : "", stderr: "" };
};

describe("taking a place back out over the login the install used", () => {
  /** A computer this host put the agent on over ssh and then stopped hearing from: its record carries that login
   * and no link, which is the box a remove has to reach itself. */
  const installedAndSilent = async (leave?: PlaceLeaver, more: Partial<PlaceWiring> = {}, boxKey?: string): Promise<{ placeId: string; store: Store; hostKey: PlaceKeyPair }> => {
    const hostKey = newPlaceKeyPair();
    const store = memoryStore();
    let joined = "";
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        install: async req => {
          // The shape a box that stops calling home has: its own join opens a socket and closes it while the
          // install is still running, and nothing dials this host afterwards.
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps") });
          joined = placeId;
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          client.close();
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === false));
          return { name: "vps", ssh: "root@65.21.4.12", sshKeyPath: "/Users/lena/.ssh/hetzner", ...(boxKey === undefined ? {} : { hostKey: boxKey }) };
        },
        ...(leave === undefined ? {} : { leave }),
        runOver: boxAnswering(() => placeFile(joined, hostKey.publicKey)),
        ...more,
      },
      placeJoinWaitMs: 60,
      placeUpdateWaitMs: 60,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await expect(ctx.runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now())).rejects.toThrow(placeNoLinkLine("vps"));
    return { placeId: joined, store, hostKey };
  };

  it("runs the leave over that login, keeps the record until it answered, and says which road it took", async () => {
    const asked: PlaceLeaveRequest[] = [];
    let answer = (): void => {};
    const answered = new Promise<void>(done => (answer = done));
    const took = ["systemd system unit wsp-place-1234abcd.service (stopped)", "/home/maya/.wsp/place.json"];
    const { placeId, store } = await installedAndSilent(async req => {
      asked.push(req);
      await answered;
      return took;
    });
    const removing = ctx.runtime!.places!.remove(placeId);
    await until(() => asked.length === 1);
    // Still this host's while the leave runs: a box that refuses halfway is one a person can still name and try
    // again, and a record dropped first would leave the agent on it with nothing here to reach it by.
    expect(await store.get("places", placeId)).toBeDefined();
    answer();
    const removed = await removing;
    expect(asked[0]!.ssh).toEqual({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    // The line that runs wsp on that computer rides with it, off the last thing it said about itself.
    expect(asked[0]!.report.wsp).toEqual(report("vps").wsp);
    expect(removed.swept).toEqual(took);
    expect(removed.note).toBe("wsp and the service that kept it running are removed from vps");
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("asks for the sudo password before anything touches that computer, and rides it on the leave once sudo took it", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const tried: (string | undefined)[] = [];
    const acts: string[] = [];
    const logins: PlaceLogin[] = [];
    const { placeId, store } = await installedAndSilent(async req => (asked.push(req), ["/home/maya/.wsp"]), {
      sudoOver: async (login, sudoPassword, act) => {
        logins.push(login);
        tried.push(sudoPassword);
        acts.push(`${act.verb} ${act.name}`);
        if (sudoPassword !== "right") throw Object.assign(new Error("maya@65.21.4.12 runs sudo only with maya's password. Type it at wsp remove vps in a terminal."), { kind: PLACE_SUDO_KIND });
        return "taken";
      },
    }, "ssh-ed25519 SHA256:kept");
    // Refused with the add's own kind, before the leave and with the record kept, so the person types it and removes again.
    await expect(ctx.runtime!.places!.remove(placeId)).rejects.toMatchObject({ kind: PLACE_SUDO_KIND });
    expect(asked).toEqual([]);
    // The key the box's ssh answered the add with is kept on the record's road and handed to the read, which holds
    // the box against it before any password goes there; the view a client reads carries none of the road's own.
    expect(((await store.get("places", placeId)) as { road?: { hostKey?: string } }).road?.hostKey).toBe("ssh-ed25519 SHA256:kept");
    expect(logins[0]).toEqual({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostKey: "ssh-ed25519 SHA256:kept" });
    expect(JSON.stringify((await placesOf()).find(p => p.id === placeId))).not.toContain("SHA256:kept");
    const removed = await ctx.runtime!.places!.remove(placeId, { sudoPassword: "right" });
    expect(tried).toEqual([undefined, "right"]);
    expect(acts).toEqual(["remove vps", "remove vps"]);
    expect(asked.map(r => r.sudoPassword)).toEqual(["right"]);
    expect(removed.note).toBe(placeSweptOverSshLine("vps"));
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("rides no password on a login that reaches root without one, whatever came with the remove", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const { placeId } = await installedAndSilent(async req => (asked.push(req), []), { sudoOver: async () => "free" });
    await ctx.runtime!.places!.remove(placeId, { sudoPassword: "stray" });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.sudoPassword).toBeUndefined();
  });

  it("asks for the sudo password before an update over the login, and rides it on the update once sudo took it", async () => {
    const updates: PlaceUpdateRequest[] = [];
    const { placeId } = await installedAndSilent(undefined, {
      sudoOver: async (_login, sudoPassword, act) => {
        if (sudoPassword !== "right") throw Object.assign(new Error(`maya@65.21.4.12 runs sudo only with maya's password. Type it at wsp add ${act.name} --update in a terminal.`), { kind: PLACE_SUDO_KIND });
        return "taken";
      },
      update: async req => (updates.push(req), { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" }),
    });
    await expect(ctx.runtime!.places!.update(placeId)).rejects.toThrow("wsp add vps --update");
    expect(updates).toEqual([]);
    await ctx.runtime!.places!.update(placeId, { sudoPassword: "right" });
    expect(updates.map(r => r.sudoPassword)).toEqual(["right"]);
  });

  it("keeps the sentence a person has always read where the box will not answer the login, and still lets it go", async () => {
    // The refusal the road throws when the login itself would not stand, which is the one it throws for that
    // alone: nothing ran on that computer, so nothing of it is said to have.
    const { placeId, store } = await installedAndSilent(async () => {
      throw new PlaceLoginRefusedError("ssh: connect to host 65.21.4.12 port 22: Connection refused");
    });
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(removed.removed).toBe(true);
    expect(removed.swept).toEqual([]);
    expect(removed.note).toBe(placeStillInstalledLine("vps"));
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("says the leave ran there and stopped in that computer's own words, which is not the same as a login that would not stand", async () => {
    const said = "vps ran the leave and had not finished it within 180s";
    const { placeId } = await installedAndSilent(async () => {
      throw new Error(said);
    });
    const removed = await ctx.runtime!.places!.remove(placeId);
    // The login stood and the leave ran: how far it got is that computer's to say, and a line reading that it did
    // not answer would be telling a person something that did not happen.
    expect(removed.note).toBe(`${placeLoginRoadLine("vps", "root@65.21.4.12", said)}; ${placeStillInstalledLine("vps")}`);
    expect(removed.note).not.toContain("did not answer the login");
    expect(removed.note).toContain(said);
  });

  it("says the agent is still installed on a host wired with no road to log in to one", async () => {
    const { placeId } = await installedAndSilent();
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(removed.swept).toEqual([]);
    expect(removed.note).toBe(placeStillInstalledLine("vps"));
  });

  /** The same box, still dialling this host: its record carries the install's login and the link is up, which is
   * the computer a remove used to sweep over the link alone. The box it holds is that computer's own socket, for
   * a test that has to drop the link mid-remove the way the stop on it does. */
  const installedAndLinked = async (
    leave: PlaceLeaver,
    over: { box?: WsClient; dial?: PlaceDialler; runOver?: PlaceWiring["runOver"] } = {},
  ): Promise<{ placeId: string; overLink: string[]; askedOverLink: string[]; store: Store }> => {
    const hostKey = newPlaceKeyPair();
    const askedOverLink: string[] = [];
    const overLink = ["/home/maya/.wsp/place.json", "/home/maya/.wsp/daemon-token"];
    const store = memoryStore();
    let joined = "";
    ctx.runtime = createRuntime({
      backend: stubBackend(),
      store,
      adapters: {},
      placeLinks: {
        ...wiring(hostKey),
        ...(over.dial === undefined ? {} : { dial: over.dial }),
        install: async req => {
          const { client, placeId } = await join(hostKey, { code: readJoinToken(req.code).code, name: "vps", report: report("vps") });
          joined = placeId;
          over.box = client;
          sockets.push(client.ws);
          // The agent as it answers a leave on the link: it sweeps the files it owns and says what it took.
          answersLeave(client, overLink, askedOverLink);
          await until(async () => (await placesOf()).some(p => p.id === placeId && p.present === true));
          return { name: "vps", ssh: "root@65.21.4.12", sshKeyPath: "/Users/lena/.ssh/hetzner" };
        },
        leave,
        runOver: over.runOver ?? boxAnswering(() => placeFile(joined, hostKey.publicKey)),
      },
      placeJoinWaitMs: 60,
    });
    ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
    await ctx.runtime.places!.add({ address: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner", hostUrls: DOOR }, Date.now());
    return { placeId: joined, overLink, askedOverLink, store };
  };

  it("takes that road on a computer that is holding a link too, since what answers there cannot take its own service", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const took = ["systemd system unit wsp-place-1234abcd.service (stopped)", "/home/maya/.wsp/place.json"];
    const { placeId, askedOverLink } = await installedAndLinked(async req => {
      asked.push(req);
      return took;
    });
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.ssh).toEqual({ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" });
    // The agent on the link is never asked: its sweep leaves the unit that restarts it, and a second sweep after
    // the box's own leave would be a second copy of what came off.
    expect(askedOverLink).toEqual([]);
    expect(removed.swept).toEqual(took);
    expect(removed.note).toBe("wsp and the service that kept it running are removed from vps");
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("falls back to the sweep on the link where that login will not answer, so the files still come off", async () => {
    const { placeId, overLink, askedOverLink } = await installedAndLinked(async () => {
      throw new PlaceLoginRefusedError("ssh: connect to host 65.21.4.12 port 22: Connection refused");
    });
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    // Which road finished it, since the two take different things off: this one left the unit that restarts the
    // agent on that computer, and a person reading the files that came off would have read the rest into it.
    expect(removed.note).toBe(placeSweptOverLinkLine("vps", "root@65.21.4.12"));
  });

  it("lets go of a computer whose own leave dropped the link under it, which is what the stop on that unit does", async () => {
    const took = ["systemd system unit wsp-place-1234abcd.service (stopped)", "/home/maya/.wsp/place.json"];
    const box: { box?: WsClient } = {};
    const { placeId, store, askedOverLink } = await installedAndLinked(async req => {
      // The shape the road makes on a linked box: the leave stops the unit, so the daemon dies and the link drops
      // while this host is still waiting on the answer that comes back over ssh.
      box.box?.close();
      await until(async () => (await placesOf()).find(p => p.id === req.placeId)?.present === false);
      return took;
    }, box);
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(removed.swept).toEqual(took);
    expect(removed.note).toBe("wsp and the service that kept it running are removed from vps");
    expect(askedOverLink).toEqual([]);
    // The record goes and stays gone: the link's own close handler writes the row it last saw, and a write that
    // landed after the removal would put a place this host no longer holds back in the list.
    expect(await store.get("places", placeId)).toBeUndefined();
    await new Promise(done => setTimeout(done, 200));
    expect(await store.get("places", placeId)).toBeUndefined();
    expect((await placesOf()).some(p => p.id === placeId)).toBe(false);
  });

  it("takes the link road at once where the login does not answer the probe, rather than waiting out the leave", async () => {
    let asked = 0;
    const dialled: PlaceLogin[] = [];
    const { placeId, overLink, askedOverLink } = await installedAndLinked(
      async () => {
        asked += 1;
        // A leave the probe should never reach: this one would hold the remove for as long as ssh is black-holed.
        await new Promise(done => setTimeout(done, 5_000));
        return [];
      },
      {
        dial: async login => {
          dialled.push(login);
          throw new Error("ssh: connect to host 65.21.4.12 port 22: Operation timed out");
        },
      },
    );
    const started = Date.now();
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(dialled).toEqual([{ ssh: "root@65.21.4.12", keyPath: "/Users/lena/.ssh/hetzner" }]);
    expect(asked).toBe(0);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    expect(removed.note).toBe(placeSweptOverLinkLine("vps", "root@65.21.4.12"));
  });

  it("carries that computer's own words into the note where the leave ran there and stopped, and still sweeps over the link", async () => {
    const said = "vps ran the leave and did not finish it: Failed to stop: Unit is masked.";
    const { placeId, overLink, askedOverLink } = await installedAndLinked(async () => {
      throw new Error(said);
    });
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    expect(removed.note).toBe(placeSweptOverLinkLine("vps", "root@65.21.4.12", said));
    expect(removed.note).not.toContain("did not answer the login");
  });
  it("runs nothing over a login that reaches another computer's place file, or none, and lets the record go saying so", async () => {
    for (const file of [() => placeFile("p_0123456789abcdef", newPlaceKeyPair().publicKey), () => ""]) {
      const asked: PlaceLeaveRequest[] = [];
      const ran: string[] = [];
      const { placeId, store } = await installedAndSilent(async req => (asked.push(req), []), { runOver: boxAnswering(file, ran) });
      const removed = await ctx.runtime!.places!.remove(placeId);
      // The read of the place file is the one thing that ran there: no plugin came off and no leave went.
      expect(ran).toEqual([heldPlaceScript("/home/maya")]);
      expect(asked).toEqual([]);
      expect(removed.swept).toEqual([]);
      expect(removed.note).toBe(placeLoginElsewhereRemovedLine("root@65.21.4.12", "vps"));
      expect(removed.note).toBe("root@65.21.4.12 no longer reaches the computer added here as vps, so nothing was changed on the machine it reaches; vps is off this host, and whatever wsp left on vps itself stays until wsp leave runs there");
      expect(await store.get("places", placeId)).toBeUndefined();
    }
  });

  it("names the other computer added here where a failed add tried again left a stale record on the same login", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const released: string[] = [];
    let live = "";
    const back: PlaceWiring["back"] = { hold: async (_login, at) => at, release: login => void released.push(login.ssh), door: () => {}, close: () => {} };
    const updates: PlaceUpdateRequest[] = [];
    const { placeId, store, hostKey } = await installedAndSilent(async req => (asked.push(req), []), {
      runOver: boxAnswering(() => placeFile(live, hostKey.publicKey)),
      back,
      update: async req => (updates.push(req), { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" }),
    });
    const again = await join(hostKey, { code: await code(), name: "vps", report: report("vps") });
    sockets.push(again.client.ws);
    live = again.placeId;
    // Both records dial back through one forward on that login, as an add tried again leaves them.
    for (const id of [placeId, live]) {
      const record = (await store.get("places", id)) as { road?: Record<string, unknown> };
      await store.put("places", id, { ...record, road: { ...record.road, ssh: "root@65.21.4.12", back: { boxPort: 4640 } } });
    }
    // An update of the stale record is refused, and told to take that record away by its id: both go by vps.
    const refused = placeLoginOtherRefusal("root@65.21.4.12", { id: placeId, name: "vps" }, "vps");
    await expect(ctx.runtime!.places!.update(placeId)).rejects.toThrow(refused.happened);
    expect(refused.fix).toBe(`This record of vps stands beside that one; take it away with wsp remove ${placeId}.`);
    expect(updates).toEqual([]);
    const removed = await ctx.runtime!.places!.remove(placeId);
    // The live record still holds that forward, so taking the stale one away lets nothing go.
    expect(released).toEqual([]);
    expect(asked).toEqual([]);
    expect(removed.note).toBe(placeLoginElsewhereRemovedLine("root@65.21.4.12", "vps", "vps"));
    // The machine the login reaches is the live computer: the note keeps it added and names no leave to run there.
    expect(removed.note).toBe("root@65.21.4.12 reaches the other computer added here as vps, which stays added, so nothing was changed there; this record of vps is off this host");
    expect(await store.get("places", placeId)).toBeUndefined();
    expect(await store.get("places", live)).toBeDefined();
  });

  it("lets the record go where the login's sudo asks for a password and the box answers with another key, running nothing there", async () => {
    const kinds = ["no password", "typed"] as const;
    for (const typed of kinds) {
      const asked: PlaceLeaveRequest[] = [];
      const ran: string[] = [];
      const tried: (string | undefined)[] = [];
      const { placeId, store } = await installedAndSilent(async req => (asked.push(req), []), {
        // What placeSudoReader throws where the key the login answers with is not the one the add kept.
        sudoOver: async (_login, sudoPassword) => {
          tried.push(sudoPassword);
          throw new PlaceHostKeyChangedError("root@65.21.4.12 answered with ssh-ed25519 AAAAother, not the ssh-ed25519 SHA256:kept you pinned");
        },
        runOver: boxAnswering(() => "", ran),
      }, "ssh-ed25519 SHA256:kept");
      const removed = await ctx.runtime!.places!.remove(placeId, typed === "typed" ? { sudoPassword: "typed" } : {});
      expect(ran).toEqual([]);
      expect(asked).toEqual([]);
      expect(tried).toEqual([typed === "typed" ? "typed" : undefined]);
      expect(removed.note).toBe(placeLoginElsewhereRemovedLine("root@65.21.4.12", "vps"));
      expect(await store.get("places", placeId)).toBeUndefined();
    }
  });

  it("refuses an update where the login's sudo asks and the box answers with another key", async () => {
    const updates: PlaceUpdateRequest[] = [];
    const { placeId, store } = await installedAndSilent(undefined, {
      sudoOver: async () => {
        throw new PlaceHostKeyChangedError("root@65.21.4.12 answered with ssh-ed25519 AAAAother, not the ssh-ed25519 SHA256:kept you pinned");
      },
      update: async req => (updates.push(req), { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" }),
    }, "ssh-ed25519 SHA256:kept");
    await expect(ctx.runtime!.places!.update(placeId)).rejects.toBeInstanceOf(PlaceHostKeyChangedError);
    expect(updates).toEqual([]);
    expect(await store.get("places", placeId)).toBeDefined();
  });

  it("sweeps a linked computer over its link where its login reaches another machine, and runs nothing over the login", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const ran: string[] = [];
    const { placeId, overLink, askedOverLink, store } = await installedAndLinked(async req => (asked.push(req), []), { runOver: boxAnswering(() => "", ran) });
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(asked).toEqual([]);
    expect(ran).toEqual([heldPlaceScript("/home/maya")]);
    expect(askedOverLink).toEqual(["place.leave"]);
    expect(removed.swept).toEqual(overLink);
    expect(removed.note).toBe(placeElsewhereSweptOverLinkLine("vps", placeLoginElsewhere("root@65.21.4.12", "vps")));
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("refuses an update over a login that reaches another machine before a byte goes there", async () => {
    const updates: PlaceUpdateRequest[] = [];
    const { placeId } = await installedAndSilent(undefined, {
      runOver: boxAnswering(() => placeFile("p_0123456789abcdef", newPlaceKeyPair().publicKey)),
      update: async req => (updates.push(req), { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" }),
    });
    await expect(ctx.runtime!.places!.update(placeId)).rejects.toMatchObject({ message: expect.stringContaining(placeLoginOtherRefusal("root@65.21.4.12", { id: placeId, name: "vps" }).happened), kind: "usage" });
    expect(updates).toEqual([]);
  });

  it("reads the place file with the password sudo took, so a login whose sudo asks is checked and not refused", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const reads: (string | undefined)[] = [];
    let live = "";
    const { placeId, store, hostKey } = await installedAndSilent(async req => (asked.push(req), []), {
      sudoOver: async () => "taken",
      runOver: async (_login, script, _timeoutMs, sudoPassword) => {
        if (script === heldPlaceScript("/home/maya")) reads.push(sudoPassword);
        return { exitCode: 0, stdout: script === heldPlaceScript("/home/maya") ? placeFile(live, hostKey.publicKey) : "", stderr: "" };
      },
    }, "ssh-ed25519 SHA256:kept");
    live = placeId;
    const removed = await ctx.runtime!.places!.remove(placeId, { sudoPassword: "right" });
    expect(reads).toEqual(["right"]);
    expect(asked.map(r => r.sudoPassword)).toEqual(["right"]);
    expect(removed.note).toBe(placeSweptOverSshLine("vps"));
    expect(await store.get("places", placeId)).toBeUndefined();
  });

  it("refuses a remove and an update whose place file read times out or fails, and runs nothing more there", async () => {
    for (const failed of [{ exitCode: 124, stderr: "", said: "the read timed out after" }, { exitCode: 1, stderr: "sudo: a password is required\n", said: "sudo: a password is required" }]) {
      const asked: PlaceLeaveRequest[] = [];
      const updates: PlaceUpdateRequest[] = [];
      const ran: string[] = [];
      const { placeId, store } = await installedAndSilent(async req => (asked.push(req), []), {
        runOver: async (_login, script) => (ran.push(script), { exitCode: failed.exitCode, stdout: "", stderr: failed.stderr }),
        update: async req => (updates.push(req), { road: "ssh", at: "/root/.wsp/daemon/wsp-daemon" }),
      });
      const checked = placeLoginUncheckedRefusal("root@65.21.4.12", "vps", failed.said).happened;
      await expect(ctx.runtime!.places!.remove(placeId)).rejects.toMatchObject({ message: expect.stringContaining(checked), kind: "usage" });
      await expect(ctx.runtime!.places!.update(placeId)).rejects.toMatchObject({ message: expect.stringContaining(checked), kind: "usage" });
      expect(ran).toEqual([heldPlaceScript("/home/maya"), heldPlaceScript("/home/maya")]);
      expect(asked).toEqual([]);
      expect(updates).toEqual([]);
      expect(await store.get("places", placeId)).toBeDefined();
    }
  });

  it("lets go of a computer whose login stops answering at the read, running nothing there", async () => {
    const asked: PlaceLeaveRequest[] = [];
    const { placeId, store } = await installedAndSilent(async req => (asked.push(req), []), {
      runOver: async () => {
        throw new PlaceLoginRefusedError("ssh: connect to host 65.21.4.12 port 22: Connection refused");
      },
    });
    const removed = await ctx.runtime!.places!.remove(placeId);
    expect(asked).toEqual([]);
    expect(removed.note).toBe(placeStillInstalledLine("vps"));
    expect(await store.get("places", placeId)).toBeUndefined();
  });
});
