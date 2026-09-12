// SPDX-License-Identifier: AGPL-3.0-only
// The link a place holds to its host, against a fake host that is a real ws
// server with a real ed25519 pair: nothing here fakes a signature, so the
// handshake the daemon runs is the one the host answers.
import { createPrivateKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { NO_PLACE_FILE_LINE, PLACE_UNKNOWN_REFUSAL, PlaceProveRequest, PlaceReport, hostKeyRefusal, hostQuietLine, linkedLine, placeDaemonPaths, placeLinkTranscript, type PlaceFile } from "@wsp/protocol";
import { placeBackoffMs, readPlaceFile, writePlaceFile } from "../src/link.js";
import { daemonUnderTest, type DaemonUnderTest, type DaemonUnderTestArgs } from "./harness.js";
import { rejectedEvents } from "./wire-events.js";

const dirs: string[] = [];
const servers: WebSocketServer[] = [];
const daemons: DaemonUnderTest[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

/** A fake home joined as a place: the place file and its key where a join puts them under that home. */
function placeFile(hostUrls: string[], hostPublicKey: string, keyPem: string): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), "wsp-link-"));
  dirs.push(home);
  const at = placeDaemonPaths(home);
  const file: PlaceFile = { placeId: "p_ab12cd34", name: "old-macbook", hostUrls, hostPublicKey, keyPath: at.placeKey, joinedAt: new Date(0).toISOString() };
  writePlaceFile(at.placeFile, file);
  writeFileSync(at.placeKey, keyPem);
  return { home, file: at.placeFile };
}

/** The daemon a place runs, dialling out on the file under its home; the token is what its own loopback door takes. */
async function placeDaemon(place: { home: string; file: string }, args: DaemonUnderTestArgs = {}): Promise<DaemonUnderTest> {
  const d = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: "link-token", kind: "place", root: place.home, home: place.home, placeFile: place.file, rootsPath: placeDaemonPaths(place.home).rootsPath, ...args });
  daemons.push(d);
  return d;
}

/** Waits for one line of the daemon's log. */
const untilLogged = (d: DaemonUnderTest, test: (line: string) => boolean, timeout = 5_000): Promise<string> =>
  vi.waitFor(
    () => {
      const found = d.log().find(test);
      expect(found).toBeDefined();
      return found!;
    },
    { timeout, interval: 10 },
  );

/** A host that answers the handshake with a real signature. `wrongTranscript` signs the place's own half instead of
 * its own, which is the one thing a place must refuse. */
interface FakeHost {
  url: string;
  /** How many sockets the place has opened to it. */
  dials: () => number;
  /** Every frame the place sent after the handshake, in order. */
  frames: Record<string, unknown>[];
  /** Every place.prove the place sent, report and all. */
  proofs: Record<string, unknown>[];
  /** The socket the place is holding, once it has proved. */
  socket: Promise<ServerSocket>;
  publicKey: string;
}

async function fakeHost(opts: { key?: { publicKey: string; privateKeyPem: string }; wrongTranscript?: boolean; refuse?: string } = {}): Promise<FakeHost> {
  const key = opts.key ?? pair();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
  const proofs: Record<string, unknown>[] = [];
  let dials = 0;
  let held!: (s: ServerSocket) => void;
  const socket = new Promise<ServerSocket>(done => (held = done));
  wss.on("connection", ws => {
    dials++;
    ws.on("error", () => {});
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame["op"] === "place.auth") {
        if (opts.refuse !== undefined) {
          ws.send(JSON.stringify({ id: frame["id"], ok: false, error: opts.refuse, kind: "auth" }));
          ws.close(4401, "unauthorized");
          return;
        }
        const placeId = String(frame["placeId"]);
        const placeNonce = String(frame["nonce"]);
        const nonce = Buffer.alloc(32, 9).toString("base64");
        const bytes = opts.wrongTranscript === true ? placeLinkTranscript("place", placeId, placeNonce, nonce) : placeLinkTranscript("host", placeId, placeNonce, nonce);
        const signature = sign(null, bytes, createPrivateKey(key.privateKeyPem)).toString("base64");
        ws.send(JSON.stringify({ id: frame["id"], ok: true, nonce, hostPublicKey: key.publicKey, signature }));
        return;
      }
      if (frame["op"] === "place.prove") {
        proofs.push(frame);
        ws.send(JSON.stringify({ id: frame["id"], ok: true }));
        held(ws);
        return;
      }
      frames.push(frame);
    });
  });
  const port = await listening(wss);
  return { url: `http://127.0.0.1:${port}`, dials: () => dials, frames, proofs, socket, publicKey: key.publicKey };
}

const settled = (ms = 50): Promise<void> => new Promise(done => setTimeout(done, ms));

/** The port a fresh server bound, once it has: address() answers null until the loop turns. */
const listening = (wss: WebSocketServer): Promise<number> =>
  new Promise((done, fail) => {
    wss.once("listening", () => done((wss.address() as { port: number }).port));
    wss.once("error", fail);
  });

describe("the wait before each attempt", () => {
  it("doubles from two seconds to thirty and stops there", () => {
    expect([1, 2, 3, 4, 5, 6].map(placeBackoffMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});

describe("the link a place dials", () => {
  it("sends place.auth as its first frame and proves with a report the host reads, before anything else", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const place = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    // The place's own key is not the host's; the file above pins the host's, which is what it verifies against.
    const d = await placeDaemon(place, { wspArgv: ["/usr/local/bin/node", "/opt/wsp/bin.js"] });
    await host.socket;
    await untilLogged(d, line => line === linkedLine(host.url));
    // The place asked nothing of the host; what the host saw after the handshake is the daemon's hello and no request.
    expect(host.frames.filter(f => "op" in f)).toEqual([]);
    // The report is the daemon's own, off the home and the words it was started with, in the shape the host parses.
    const proof = PlaceProveRequest.parse(host.proofs[0]);
    const report = PlaceReport.parse(proof.report);
    expect(report).toMatchObject({ name: "old-macbook", dialed: host.url, daemonPort: d.port, wsp: ["/usr/local/bin/node", "/opt/wsp/bin.js"], login: { HOME: place.home } });
    expect(report.shape.cpu).toBeGreaterThan(0);
  });

  it("dials the second address when the first refuses the connect, and names both in its log", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const dead = "http://127.0.0.1:1";
    const place = placeFile([dead, host.url], key.publicKey, pair().privateKeyPem);
    const d = await placeDaemon(place, { linkConnectMs: 500 });
    await untilLogged(d, line => line === linkedLine(host.url));
    expect(d.log().join("\n")).toContain(dead);
    expect(d.log().join("\n")).toContain(host.url);
  });

  it("ends the attempt before it sends its report when the host's signature is over the wrong transcript", async () => {
    const key = pair();
    const host = await fakeHost({ key, wrongTranscript: true });
    const place = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const d = await placeDaemon(place, { linkBackoffMs: 60_000 });
    await untilLogged(d, line => line === hostKeyRefusal(host.url));
    await settled(100);
    expect(host.frames).toEqual([]);
    expect(host.proofs).toEqual([]);
    expect(d.log()).not.toContain(linkedLine(host.url));
  });

  it("refuses a host whose key is not the one this computer pinned", async () => {
    const host = await fakeHost();
    const place = placeFile([host.url], pair().publicKey, pair().privateKeyPem);
    const d = await placeDaemon(place, { linkBackoffMs: 60_000 });
    await untilLogged(d, line => line === hostKeyRefusal(host.url));
    await settled(100);
    expect(host.proofs).toEqual([]);
    expect(d.log()).not.toContain(linkedLine(host.url));
  });

  it("stops dialling for minutes when the host says it holds no such place", async () => {
    const host = await fakeHost({ refuse: PLACE_UNKNOWN_REFUSAL });
    const place = placeFile([host.url], pair().publicKey, pair().privateKeyPem);
    const d = await placeDaemon(place, { linkRefusedRetryMs: 600_000 });
    await untilLogged(d, line => line.includes("holds no place by that id"));
    // Refused is a wait of minutes, not the backoff of seconds: no second dial lands in the time a redial would take.
    await settled(300);
    expect(host.dials()).toBe(1);
  });

  it("says so and waits when this computer holds no place file at all", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-link-none-"));
    dirs.push(home);
    const d = await placeDaemon({ home, file: placeDaemonPaths(home).placeFile }, { linkRefusedRetryMs: 600_000 });
    await untilLogged(d, line => line === NO_PLACE_FILE_LINE);
  });

  it("proves the place's own half against the key on its file, which is what the host verifies", async () => {
    const key = pair();
    const mine = pair();
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    servers.push(wss);
    let proved: boolean | undefined;
    wss.on("connection", ws => {
      ws.on("error", () => {});
      let expect1: Uint8Array | undefined;
      ws.on("message", raw => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame["op"] === "place.auth") {
          const placeId = String(frame["placeId"]);
          const placeNonce = String(frame["nonce"]);
          const nonce = Buffer.alloc(32, 4).toString("base64");
          expect1 = placeLinkTranscript("place", placeId, nonce, placeNonce);
          const signature = sign(null, placeLinkTranscript("host", placeId, placeNonce, nonce), createPrivateKey(key.privateKeyPem)).toString("base64");
          ws.send(JSON.stringify({ id: frame["id"], ok: true, nonce, hostPublicKey: key.publicKey, signature }));
          return;
        }
        if (frame["op"] === "place.prove") {
          proved = verify(null, expect1!, { key: Buffer.from(mine.publicKey, "base64"), format: "der", type: "spki" }, Buffer.from(String(frame["signature"]), "base64"));
          ws.send(JSON.stringify({ id: frame["id"], ok: true }));
        }
      });
    });
    const port = await listening(wss);
    const place = placeFile([`http://127.0.0.1:${port}`], key.publicKey, mine.privateKeyPem);
    await placeDaemon(place);
    await vi.waitFor(() => expect(proved).toBe(true), { timeout: 5_000, interval: 10 });
  });

  it("cuts a link that carried no frame at all and dials again", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const place = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const d = await placeDaemon(place, { linkQuietMs: 120, linkBackoffMs: 60_000 });
    await untilLogged(d, line => line === hostQuietLine(host.url, 0));
    // Dialling again is the backoff away, a minute here: the link is down and nothing has redialled yet.
    await settled(100);
    expect(host.dials()).toBe(1);
  });
});

describe("the socket a place proved, served as an inbound one", () => {
  it("hands the host a daemon that answers ping and pushes only frames the protocol takes", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const place = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    await placeDaemon(place);
    const ws = await host.socket;
    const answers: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    ws.on("message", raw => {
      const f = JSON.parse(String(raw)) as Record<string, unknown>;
      if (f["type"] !== undefined) events.push(f);
      else answers.push(f);
    });
    const ask = (id: number, op: string): Promise<Record<string, unknown>> => {
      ws.send(JSON.stringify({ id, op }));
      return new Promise(done => {
        const at = setInterval(() => {
          const found = answers.find(a => a["id"] === id);
          if (found !== undefined) {
            clearInterval(at);
            done(found);
          }
        }, 10);
      });
    };
    expect(await ask(11, "ping")).toMatchObject({ ok: true });
    // The hello the daemon pushes the moment the socket is served, which is what tells the host what it is talking to.
    await settled(50);
    expect(events.some(e => e["type"] === "daemon.hello")).toBe(true);
    expect(rejectedEvents(events)).toEqual([]);
  });

  it("answers place.leave with what the sweep took and then ends the process", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const place = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const at = placeDaemonPaths(place.home);
    // What a join and a daemon leave under the home: the token file beside the place file and its key.
    writeFileSync(at.tokenPath, "a-token\n");
    const d = await placeDaemon(place);
    const ws = await host.socket;
    const answers: Record<string, unknown>[] = [];
    ws.on("message", raw => {
      const f = JSON.parse(String(raw)) as Record<string, unknown>;
      if (f["type"] === undefined) answers.push(f);
    });
    ws.send(JSON.stringify({ id: 21, op: "place.leave" }));
    const answer = await vi.waitFor(
      () => {
        const found = answers.find(a => a["id"] === 21);
        expect(found).toBeDefined();
        return found!;
      },
      { timeout: 5_000, interval: 10 },
    );
    // The sweep is the real one over that home: the place file, its key and the token are gone and named.
    expect(answer).toMatchObject({ ok: true, swept: [at.placeFile, at.placeKey, at.tokenPath] });
    for (const path of [at.placeFile, at.placeKey, at.tokenPath]) expect(existsSync(path)).toBe(false);
    // The process ends after the reply is on the wire, and nothing dials again: the sweep took what would bring it back.
    await Promise.race([d.exited, settled(5_000).then(() => Promise.reject(new Error("the daemon did not end after the leave")))]);
    const dialed = host.dials();
    await settled(150);
    expect(host.dials()).toBe(dialed);
  });
});

describe("the place file", () => {
  it("reads back what was written, and a file that is not one reads as none", () => {
    const key = pair();
    const { file: path } = placeFile(["http://192.168.1.20:4400"], key.publicKey, pair().privateKeyPem);
    expect(readPlaceFile(path)?.placeId).toBe("p_ab12cd34");
    writeFileSync(path, "not a place file");
    expect(readPlaceFile(path)).toBeUndefined();
    expect(readPlaceFile(`${path}.nope`)).toBeUndefined();
  });
});
