// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_VERSION, placeDaemonBehind, HERE_PLACE_ID } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { NO_PLACE_UPDATER, newPlaceKeyPair, type PlaceUpdateRequest, type PlaceUpdater } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, fakeLocal } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { report, wiring } from "./place-join.js";
import { ctx, sockets, serving, code, join, relink, placesOf, saysItsFacts, LOGINS, PLACE_FACTS } from "./places-fixture.js";

describe("a computer that runs an older wsp than this host", () => {
  it("says so on its row with what brings it level: wsp add <name> --update on a joined one, this wsp's own road on this one, and nothing on a level one or where no daemon runs here", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-behind-"));
    try {
      const hostKey = newPlaceKeyPair();
      let held: number | undefined = DAEMON_VERSION - 1;
      ctx.runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {}, placeLinks: wiring(hostKey), local: { ...fakeLocal(root), hereDaemon: { version: async () => held ?? DAEMON_VERSION, held: () => held, fix: "updating the wsp app" } } });
      ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
      const old = await join(hostKey, { code: await code(), report: report("spoo", { daemonVersion: DAEMON_VERSION - 1 }) });
      sockets.push(old.client.ws);
      const level = await join(hostKey, { code: await code(), report: report("box", { daemonVersion: DAEMON_VERSION }) });
      sockets.push(level.client.ws);
      const word = placeDaemonBehind({ daemonVersion: DAEMON_VERSION - 1 })!;
      const rows = await placesOf();
      expect(rows.find(p => p.id === old.placeId)).toMatchObject({ daemonVersion: DAEMON_VERSION - 1, behind: { word, fix: "wsp add spoo --update", act: "update" } });
      expect(rows.find(p => p.id === level.placeId)!.behind).toBeUndefined();
      expect(rows.find(p => p.id === HERE_PLACE_ID)).toMatchObject({ daemonVersion: DAEMON_VERSION - 1, behind: { word, fix: "updating the wsp app", act: "install" } });
      held = DAEMON_VERSION;
      const levelled = (await placesOf()).find(p => p.id === HERE_PLACE_ID)!;
      expect(levelled.daemonVersion).toBe(DAEMON_VERSION);
      expect(levelled.behind).toBeUndefined();
      // No daemon started here yet is a version this host does not know, not one it guesses.
      held = undefined;
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)!.daemonVersion).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("moving a place onto the daemon this host deploys", () => {
  /** What the host's own updater does, in miniature: the binary in parts over the link the place is holding, each
   * under one upload id with the sha256 of the whole, and the path the place answered with. An update that asks
   * for no binary answers no landing, as the host's own does: what it runs there instead is wsp's login files,
   * which is the host's road and not this one's. */
  const overTheLink = (bytes: Uint8Array, asked: { req: PlaceUpdateRequest }[]): PlaceUpdater => async req => {
    asked.push({ req });
    if (!req.daemon) return undefined;
    const half = Math.ceil(bytes.length / 2);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let at = "";
    for (const [seq, part] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
      const answer = await req.link!.request("place.update", { uploadId: "u1", seq, last: seq === 1, data: Buffer.from(part).toString("base64"), sha256 });
      at = typeof answer["at"] === "string" ? answer["at"] : at;
    }
    return { road: "link", at };
  };

  /** A place that takes the parts as the daemon does: appended in order, and the last one answered with where the
   * binary landed. What it was sent is kept so the test can read the whole of it back. */
  const takesParts = (landed: Buffer[], sent: { sha256: string[]; uploads: string[] }) => (c: WsClient): void => {
    c.onFrame(raw => {
      const frame = raw as unknown as { id?: number; op?: string; data?: string; sha256?: string; uploadId?: string; last?: boolean };
      if (frame.op !== "place.update") return;
      landed.push(Buffer.from(String(frame.data), "base64"));
      sent.sha256.push(String(frame.sha256));
      sent.uploads.push(String(frame.uploadId));
      c.say({ id: frame.id, ok: true, ...(frame.last === true ? { at: "/home/maya/.wsp/daemon/wsp-daemon", kept: "/home/maya/.wsp/daemon/wsp-daemon.old" } : {}) });
    });
  };

  const update = async (placeId: string): Promise<Record<string, unknown>> => {
    const c = await WsClient.connect(ctx.srv!.port, { token: "host-token" });
    const answer = await c.request("places.update", { placeId });
    c.close();
    return answer;
  };

  it("puts the binary over the link as bytes, and the row reads the new version once that computer dials back on it", async () => {
    const binary = Buffer.from("a daemon built for this box's chip, twice as long as one part");
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(binary, asked), updateWaitMs: 5_000 });
    const landed: Buffer[] = [];
    const sent = { sha256: [] as string[], uploads: [] as string[] };
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers: takesParts(landed, sent) });
    sockets.push(client.ws);

    // The computer restarts its agent on the new binary and dials back saying so, which is what the wait is for.
    const back = setTimeout(() => {
      client.close();
      void relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION })).then(({ client: fresh }) => sockets.push(fresh.ws));
    }, 200);
    back.unref?.();
    const answer = await update(placeId);

    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["name"]).toBe("old-macbook");
    // The daemon half of the reply; the recipe half beside it is this host's own and nothing is wired for it here.
    expect(answer["daemon"]).toMatchObject({ from: DAEMON_VERSION - 1, to: DAEMON_VERSION, road: "link", at: "/home/maya/.wsp/daemon/wsp-daemon" });
    // The row a person reads says it too, and says nothing about being behind any more.
    const row = (await placesOf()).find(p => p.id === placeId)!;
    expect(row.daemonVersion).toBe(DAEMON_VERSION);

    // The binary arrived whole, in order, as bytes on the link and never as a command: two parts under one upload
    // id, each carrying the sha256 of the whole, and what landed is byte for byte what was sent.
    expect(landed).toHaveLength(2);
    expect(Buffer.concat(landed)).toEqual(binary);
    expect(new Set(sent.uploads)).toEqual(new Set(["u1"]));
    expect(new Set(sent.sha256)).toEqual(new Set([createHash("sha256").update(binary).digest("hex")]));
    // The updater is told what the place said about itself, which is how the chip is picked, and handed the link.
    expect(asked).toHaveLength(1);
    expect(asked[0]!.req.report.arch).toBe("x64");
    expect(asked[0]!.req.name).toBe("old-macbook");
  });

  it("is asked again by an update, so the row it answers with carries the new daemon's facts rather than none", async () => {
    const asks = { count: 0 };
    let logins: string | undefined;
    // The facts come back a moment after they are asked for, as a real computer's do: a row read without waiting
    // for that answer is a row the update printed before the new daemon had said anything.
    const answers = (landed: Buffer[], sent: { sha256: string[]; uploads: string[] }) => (c: WsClient): void => {
      takesParts(landed, sent)(c);
      saysItsFacts(() => ({ ...PLACE_FACTS, ...(logins === undefined ? {} : { logins }) }), asks, 600)(c);
    };
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon for this box"), asked), updateWaitMs: 5_000 });
    const landed: Buffer[] = [];
    const sent = { sha256: [] as string[], uploads: [] as string[] };
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId, pair } = await join(hostKey, { code: await code(), report: behind, answers: answers(landed, sent) });
    sockets.push(client.ws);
    await until(async () => ctx.runtime!.places!.offerOf(placeId) === PLACE_FACTS.offer);
    expect((await placesOf()).find(p => p.id === placeId)!.logins).toBeUndefined();

    // The computer restarts its agent on the binary the update landed and dials back on the new daemon, which
    // shares its logins where the one before it shared none.
    logins = LOGINS;
    const back = setTimeout(() => {
      client.close();
      void relink(hostKey, placeId, pair, report("old-macbook", { daemonVersion: DAEMON_VERSION }), answers(landed, sent)).then(({ client: fresh }) => sockets.push(fresh.ws));
    }, 200);
    back.unref?.();
    const answer = await update(placeId);
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["daemon"]).toMatchObject({ to: DAEMON_VERSION });
    // The row read straight after the update carries them: the sign-in on that computer is the next thing a
    // person runs, and it reads this field.
    expect((await placesOf()).find(p => p.id === placeId)!.logins).toBe(LOGINS);
  });

  it("answers what the row still reads, with the reason, when the computer has not come back on it inside the wait", async () => {
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon"), asked), updateWaitMs: 300 });
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId } = await join(hostKey, { code: await code(), report: behind, answers: takesParts([], { sha256: [], uploads: [] }) });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok, String(answer["error"])).toBe(true);
    // Nothing failed: the binary landed and the row moves on the computer's next link, which the note says.
    expect(answer["daemon"]).toMatchObject({ to: DAEMON_VERSION - 1 });
    expect(String((answer["daemon"] as { note?: unknown }).note)).toContain("had not dialled back on it within");
  });

  it("picks up no byte for a place already running this daemon, and refuses one this host does not hold", async () => {
    const asked: { req: PlaceUpdateRequest }[] = [];
    const { hostKey } = await serving({ update: overTheLink(Buffer.from("a daemon"), asked) });
    const level = report("old-macbook", { daemonVersion: DAEMON_VERSION });
    const { client, placeId } = await join(hostKey, { code: await code(), report: level });
    sockets.push(client.ws);
    const answer = await update(placeId);
    // The update is the road the recipe is put on again, so a computer that is current is not refused: it takes
    // the recipe alone, and nothing here is wired to put one on.
    expect(answer.ok, String(answer["error"])).toBe(true);
    expect(answer["daemon"]).toBeUndefined();
    expect(answer["provision"]).toBeUndefined();
    // The updater is asked all the same, since wsp's login files there are this host's to spell; it is told no
    // binary goes with this one, and picks up none.
    expect(asked.map(a => a.req.daemon)).toEqual([false]);
    const nowhere = await update("p_nothing");
    expect(nowhere.ok).toBe(false);
    expect(String(nowhere["error"])).toContain("p_nothing");
  });

  it("hands back the updater's own refusal for a computer that is away, on an update that carries no binary", async () => {
    // What the host's own updater does with the road it has not got: a computer joined by a code holds no ssh
    // login, so an ask that arrives with neither a link nor one is refused there rather than run nowhere.
    const asked: { req: PlaceUpdateRequest }[] = [];
    const away = "srv is not connected and this wsp has no login for it";
    const { hostKey } = await serving({
      update: async req => {
        asked.push({ req });
        if (req.link === undefined && req.ssh === undefined) throw new Error(away);
        return undefined;
      },
    });
    const level = report("srv", { daemonVersion: DAEMON_VERSION });
    const { client, placeId } = await join(hostKey, { code: await code(), name: "srv", report: level });
    client.close();
    await until(async () => (await placesOf()).find(p => p.id === placeId)?.present === false);
    const answer = await update(placeId);
    // The person reads the road's own sentence and the recipe is not started behind it: a computer that is off
    // takes neither wsp's login files nor its recipe until it is back.
    expect(answer.ok).toBe(false);
    expect(answer["error"]).toBe(away);
    expect(asked.map(a => a.req.daemon)).toEqual([false]);
  });

  it("says so plainly on a host wired with no road to put a daemon on a computer", async () => {
    const { hostKey } = await serving();
    const behind = report("old-macbook", { daemonVersion: DAEMON_VERSION - 1 });
    const { client, placeId } = await join(hostKey, { code: await code(), report: behind });
    sockets.push(client.ws);
    const answer = await update(placeId);
    expect(answer.ok).toBe(false);
    expect(answer["error"]).toBe(NO_PLACE_UPDATER);
  });
});
