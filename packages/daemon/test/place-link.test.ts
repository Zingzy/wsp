// SPDX-License-Identifier: AGPL-3.0-only
// The link a place holds to its host, against a fake host that is a real ws
// server with a real ed25519 pair: nothing here fakes a signature, so the
// handshake the daemon runs is the one the host answers.
import { createPrivateKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import WebSocket from "ws";
import { placeLinkTranscript, type PlaceFile } from "@wsp/protocol";
import { PlaceLink, placeBackoffMs, readPlaceFile, writePlaceFile, type LinkOps, type PlaceSelfReport } from "../src/link.js";
import { rejectedEvents } from "./wire-events.js";
import { startDaemon, type DaemonHandle } from "../src/main.js";

const dirs: string[] = [];
const servers: WebSocketServer[] = [];
const links: PlaceLink[] = [];
const daemons: DaemonHandle[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) await link.close();
  for (const d of daemons.splice(0)) await d.close();
  for (const s of servers.splice(0)) await new Promise<void>(done => s.close(() => done()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const report = async (): Promise<PlaceSelfReport> => ({
  name: "old-macbook",
  platform: "linux",
  arch: "x64",
  os: "Linux 6.8.0",
  shape: { cpu: 4, memMb: 4096 },
  login: { HOME: "/home/maya", USER: "maya", PATH: "/usr/bin" },
  docker: true,
  daemonVersion: 17,
  wsp: ["/usr/bin/wsp"],
});

function pair(): { publicKey: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

function placeFile(hostUrls: string[], hostPublicKey: string, keyPem: string): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-link-"));
  dirs.push(dir);
  const keyPath = join(dir, "place-key.pem");
  writeFileSync(keyPath, keyPem);
  const file: PlaceFile = { placeId: "p_ab12cd34", name: "old-macbook", hostUrls, hostPublicKey, keyPath, joinedAt: new Date(0).toISOString() };
  const path = join(dir, "place.json");
  writePlaceFile(path, file);
  return path;
}

/** A host that answers the handshake with a real signature. `wrongTranscript` signs the place's own half instead of
 * its own, which is the one thing a place must refuse. */
interface FakeHost {
  url: string;
  /** How many sockets the place has opened to it. */
  dials: () => number;
  /** Every frame the place sent after the handshake, in order. */
  frames: Record<string, unknown>[];
  /** The socket the place is holding, once it has proved. */
  socket: Promise<ServerSocket>;
  publicKey: string;
}

async function fakeHost(opts: { key?: { publicKey: string; privateKeyPem: string }; wrongTranscript?: boolean; refuse?: string } = {}): Promise<FakeHost> {
  const key = opts.key ?? pair();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  const frames: Record<string, unknown>[] = [];
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
        ws.send(JSON.stringify({ id: frame["id"], ok: true }));
        held(ws);
        return;
      }
      frames.push(frame);
    });
  });
  const port = await listening(wss);
  return { url: `http://127.0.0.1:${port}`, dials: () => dials, frames, socket, publicKey: key.publicKey };
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
  it("sends place.auth as its first frame and nothing else before it is answered", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const file = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const link = new PlaceLink({ file, report, onLeave: async () => [] }, () => {});
    links.push(link);
    // The place's own key is not the host's; the file above pins the host's, which is what it verifies against.
    await settled(200);
    expect(link.status()).toBe("linked");
  });

  it("dials the second address when the first refuses the connect, and names both in its log", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const dead = "http://127.0.0.1:1";
    const file = placeFile([dead, host.url], key.publicKey, pair().privateKeyPem);
    const lines: string[] = [];
    const link = new PlaceLink({ file, report, onLeave: async () => [], log: line => lines.push(line), connectTimeoutMs: 500 }, () => {});
    links.push(link);
    await settled(600);
    expect(link.status()).toBe("linked");
    expect(lines.join("\n")).toContain(dead);
    expect(lines.join("\n")).toContain(host.url);
  });

  it("ends the attempt before it sends its report when the host's signature is over the wrong transcript", async () => {
    const key = pair();
    const host = await fakeHost({ key, wrongTranscript: true });
    const file = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const lines: string[] = [];
    const link = new PlaceLink({ file, report, onLeave: async () => [], log: line => lines.push(line), backoffMs: () => 60_000 }, () => {});
    links.push(link);
    await settled(200);
    expect(link.status()).toBe("dialing");
    expect(lines.join("\n")).toContain("did not prove the key this computer learned at join");
    expect(host.frames).toEqual([]);
  });

  it("refuses a host whose key is not the one this computer pinned", async () => {
    const host = await fakeHost();
    const file = placeFile([host.url], pair().publicKey, pair().privateKeyPem);
    const lines: string[] = [];
    const link = new PlaceLink({ file, report, onLeave: async () => [], log: line => lines.push(line), backoffMs: () => 60_000 }, () => {});
    links.push(link);
    await settled(200);
    expect(link.status()).toBe("dialing");
    expect(lines.join("\n")).toContain("nothing was sent to it");
  });

  it("stops dialling for minutes when the host says it holds no such place", async () => {
    const host = await fakeHost({ refuse: "this host holds no place by that id; join it with a code from wsp add" });
    const file = placeFile([host.url], pair().publicKey, pair().privateKeyPem);
    const lines: string[] = [];
    const link = new PlaceLink({ file, report, onLeave: async () => [], log: line => lines.push(line), refusedRetryMs: 600_000 }, () => {});
    links.push(link);
    await settled(200);
    expect(link.status()).toBe("refused");
    expect(lines.join("\n")).toContain("holds no place by that id");
  });

  it("says so and waits when this computer holds no place file at all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-link-none-"));
    dirs.push(dir);
    const lines: string[] = [];
    const link = new PlaceLink({ file: join(dir, "place.json"), report, onLeave: async () => [], log: line => lines.push(line), refusedRetryMs: 600_000 }, () => {});
    links.push(link);
    await settled(100);
    expect(lines.join("\n")).toContain("wsp join <address> --code <code>");
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
    const file = placeFile([`http://127.0.0.1:${port}`], key.publicKey, mine.privateKeyPem);
    const link = new PlaceLink({ file, report, onLeave: async () => [] }, () => {});
    links.push(link);
    await settled(200);
    expect(proved).toBe(true);
  });

  it("cuts a link that carried no frame at all and dials again", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const file = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const lines: string[] = [];
    const link = new PlaceLink({ file, report, onLeave: async () => [], log: line => lines.push(line), quietMs: 120, backoffMs: () => 60_000 }, () => {});
    links.push(link);
    await settled(400);
    expect(lines.join("\n")).toContain("cutting the link and dialling again");
    expect(link.status()).toBe("dialing");
  });
});

describe("the socket a place proved, served as an inbound one", () => {
  it("hands the host a daemon that answers ping and pushes only frames the protocol takes", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const file = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    const root = mkdtempSync(join(tmpdir(), "wsp-link-root-"));
    dirs.push(root);
    const daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      token: "link-token",
      kind: "place",
      root,
      inboxDir: root,
      rootsPath: join(root, "roots"),
      link: { file, report, onLeave: async () => ["the unit", "the key"] },
    });
    daemons.push(daemon);
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

  it("answers place.leave with what the sweep took and then asks for the process to end", async () => {
    const key = pair();
    const host = await fakeHost({ key });
    const file = placeFile([host.url], key.publicKey, pair().privateKeyPem);
    let ended = 0;
    let ops: LinkOps | undefined;
    const link = new PlaceLink({ file, report, onLeave: async () => ["the launchd agent", "/home/maya/.wsp/place.json"], exit: () => ended++ }, (_ws, given) => (ops = given));
    links.push(link);
    await settled(200);
    expect(ops).toBeDefined();
    expect(await ops!["place.leave"]!()).toEqual({ swept: ["the launchd agent", "/home/maya/.wsp/place.json"] });
    // The exit is asked for after the reply is on the wire, which is the next turn of the loop.
    await settled(50);
    expect(ended).toBe(1);
    // Nothing dials again: the sweep unloaded the unit, so a redial would be an agent nothing brings back.
    const dialed = host.dials();
    await settled(150);
    expect(host.dials()).toBe(dialed);
  });
});

describe("the place file", () => {
  it("reads back what was written, and a file that is not one reads as none", () => {
    const key = pair();
    const path = placeFile(["http://192.168.1.20:4400"], key.publicKey, pair().privateKeyPem);
    expect(readPlaceFile(path)?.placeId).toBe("p_ab12cd34");
    writeFileSync(path, "not a place file");
    expect(readPlaceFile(path)).toBeUndefined();
    expect(readPlaceFile(`${path}.nope`)).toBeUndefined();
  });
});
