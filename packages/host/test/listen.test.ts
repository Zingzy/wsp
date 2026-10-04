// SPDX-License-Identifier: AGPL-3.0-only
// What the page carries about this computer: the loopback page carries the
// digest of the host's token and never the token, a page beyond it carries no
// digest, the lock and the address lines name the address, and the runtime
// answers on the app's own port at WS_PATH. A box on a relay binds this
// computer alone and is reached down both roads at once, so there it is what a
// request carries that decides, not what the host bound.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loopbackThreadsLine, listenBeyondLoopbackLine, LOOPBACK, WILDCARD, WS_PATH, type BootPayload } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { serve, type CliIO } from "../src/cli.js";
import { hereUrl } from "../src/pairing.js";
import { writeRelayRecord } from "../src/relay-link.js";
import { deviceKeyOf, readDeviceKeyPair, readRelayRecord } from "../src/account.js";
import { spawn } from "node:child_process";
import { addressLines } from "../src/host-lock.js";
import { httpProbe } from "../src/service.js";
import { hostAddress } from "../src/verbs.js";
import { startHost, type HostHandle } from "../src/server.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";

const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { token: "" };</script>`;
const PAGE = `<!doctype html>
<html><head></head><body><div id="root"></div>
${DEV_BOOT}
</body></html>
`;

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (lines: string[] = []): CliIO => ({ log: l => lines.push(l), error: l => lines.push(l), ask: noPrompt, askSecret: noPrompt });

// The relay cases here start a real child and wait for it to go, which the default five seconds can miss under a
// loaded machine.
vi.setConfig({ testTimeout: 20_000 });

let dirs: string[] = [];
let handle: HostHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-listen-web-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')\n");
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

function testRuntime(): Runtime {
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  return createRuntime({ backend: stubBackend(), store, adapters: {} });
}

async function up(listen?: string): Promise<{ handle: HostHandle; runtime: Runtime }> {
  const runtime = testRuntime();
  handle = await startHost({ runtime, webDir: fakeWebDir(), port: 0, ...(listen !== undefined ? { listen } : {}) });
  return { handle, runtime };
}

/** The boot object out of the page the host served, which is the one inline script it carries. */
async function bootOf(port: number, headers: Record<string, string> = {}): Promise<BootPayload> {
  const html = await (await fetch(`http://127.0.0.1:${port}/`, { headers })).text();
  const script = /<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(html);
  return JSON.parse(script![1]!) as BootPayload;
}

/** What the connector puts on every request it forwards, as a request that came in through the tunnel carries it. */
const THROUGH_CONNECTOR = { "cf-connecting-ip": "203.0.113.7", "cf-ray": "8e0f4a1b2c3d4e5f-BOM" };

/** A request down a raw socket, the only road that puts a header on the wire in the capitals it was written in and
 * the only one that names a Host of its own, which fetch keeps for itself. */
async function raw(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port, method: "GET", path: "/", headers },
      res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => (text += chunk));
        res.once("end", () => done({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.once("error", fail);
    req.end();
  });
}

/** The same reading down that socket. */
async function rawBootOf(port: number, headers: Record<string, string>): Promise<BootPayload> {
  const { body } = await raw(port, headers);
  return JSON.parse(/<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(body)![1]!) as BootPayload;
}

/** What a page's upgrade gets when this host refuses it: the socket never opens, so no frame of it is ever read. */
async function upgradeRefused(url: string, origin: string): Promise<string> {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  return new Promise<string>((done, fail) => {
    ws.once("error", (e: Error) => done(e.message));
    ws.once("open", () => {
      ws.close();
      fail(new Error(`${url} opened for a page at ${origin}`));
    });
  });
}

/** And what it gets when the host takes it: an open socket the host token authenticates, as the app's own page has. */
async function upgradeTaken(url: string, origin: string, token: string): Promise<boolean> {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const reply = await new Promise<Record<string, unknown>>(done => {
    ws.once("message", frame => done(JSON.parse(String(frame)) as Record<string, unknown>));
    ws.send(JSON.stringify({ id: 1, op: "auth", token }));
  });
  ws.close();
  return reply["ok"] === true;
}

/** Redeems a code the way a browser does: the first frame of a socket nothing authed, over the app's own port. */
async function redeem(port: number, code: string): Promise<{ deviceToken?: string; error?: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const reply = await new Promise<Record<string, unknown>>(done => {
    ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
    ws.send(JSON.stringify({ id: 1, op: "pair.redeem", code, name: "a laptop" }));
  });
  ws.close();
  return reply as { deviceToken?: string; error?: string };
}

/** A code, minted the way wsp host pair does: over a socket holding the host's own token. */
async function pairCode(port: number, token: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  await new Promise<void>((done, fail) => {
    ws.once("open", () => done());
    ws.once("error", fail);
  });
  const ask = (frame: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise(done => {
      ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
      ws.send(JSON.stringify(frame));
    });
  await ask({ id: 1, op: "auth", token });
  const issued = await ask({ id: 2, op: "pair.issue" });
  ws.close();
  return issued["code"] as string;
}

const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

describe("a host on this computer alone", () => {
  it("inlines the digest of its own token in the page, never the token, and says the page is paired", async () => {
    const { handle: h } = await up();
    const boot = await bootOf(h.port);
    expect(boot.tokenHash).toBe(digestOf(h.authToken));
    expect(boot).not.toHaveProperty("token");
    expect(JSON.stringify(boot)).not.toContain(h.authToken);
    expect(boot.paired).toBe(true);
    expect(boot.wsPath).toBe(WS_PATH);
  });

  it("serves the runtime on the app's own port at WS_PATH", async () => {
    const { handle: h } = await up();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}${WS_PATH}`);
    await new Promise<void>((done, fail) => {
      ws.once("open", () => done());
      ws.once("error", fail);
    });
    const reply = await new Promise<Record<string, unknown>>(done => {
      ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
      ws.send(JSON.stringify({ id: 1, op: "auth", token: h.authToken }));
    });
    expect(reply["ok"]).toBe(true);
    ws.close();
  });
});

describe("a page at a name this host does not answer at", () => {
  it("reads no digest out of the page, though it reached the loopback port", async () => {
    const { handle: h } = await up();
    const boot = await rawBootOf(h.port, { Host: `evil.example:${h.port}` });
    expect(boot.tokenHash).toBeUndefined();
    expect(boot.paired).toBe(false);
  });

  it("reads every loopback name as this computer, whatever port it names, and no other name as one", async () => {
    const { handle: h } = await up();
    for (const host of [`127.0.0.1:${h.port}`, `localhost:${h.port}`, `[::1]:${h.port}`, "127.0.0.1:54321"]) {
      const boot = await rawBootOf(h.port, { Host: host });
      expect(boot.tokenHash, host).toBe(digestOf(h.authToken));
      expect(boot.paired, host).toBe(true);
    }
    // A name is never this computer, however it begins: a rebinding attacker registers what it likes.
    for (const host of [`evil.example:${h.port}`, "wsp.example", `127.evil.example:${h.port}`, `[2001:db8::5]:${h.port}`]) {
      const boot = await rawBootOf(h.port, { Host: host });
      expect(boot.tokenHash, host).toBeUndefined();
      expect(boot.paired, host).toBe(false);
    }
  });

  it("refuses its upgrade before a frame of it is read", async () => {
    const { handle: h } = await up();
    const foreign = `http://evil.example:${h.port}`;
    expect(await upgradeRefused(`ws://127.0.0.1:${h.port}${WS_PATH}`, foreign)).toContain("403");

    // The app's own page dials from the one name it was served at, and opens as it always did.
    const own = `http://127.0.0.1:${h.port}`;
    expect(await upgradeTaken(`ws://127.0.0.1:${h.port}${WS_PATH}`, own, h.authToken)).toBe(true);
  });
});

describe("what a page carries about this computer", () => {
  /** A host serving a state file, which is the one thing the boot object names a path of. */
  async function withState(listen?: string): Promise<{ handle: HostHandle; statePath: string }> {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-state-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, statePath, ...(listen !== undefined ? { listen } : {}) });
    return { handle, statePath };
  }

  it("names the state file on this computer's own page", async () => {
    const { handle: h, statePath } = await withState();
    const boot = await bootOf(h.port);
    expect(boot.statePath).toBe(statePath);
    expect(boot.paired).toBe(true);
  });

  it("gives a stranger the pairing screen alone: no state path and no digest, at a name this host does not answer at or through the connector", async () => {
    const { handle: h } = await withState();
    for (const headers of [{ Host: `evil.example:${h.port}` }, { ...THROUGH_CONNECTOR, Host: `127.0.0.1:${h.port}` }]) {
      const boot = await rawBootOf(h.port, headers);
      expect(boot.statePath, JSON.stringify(headers)).toBeUndefined();
      expect(boot.tokenHash, JSON.stringify(headers)).toBeUndefined();
      expect(boot.paired, JSON.stringify(headers)).toBe(false);
      // The page still dials the origin it came from, which is the one road a paired device has.
      expect(boot.wsPath, JSON.stringify(headers)).toBe(WS_PATH);
    }
  });

  it("gives every page a host bound beyond this computer serves the same, its own included", async () => {
    const { handle: h } = await withState("0.0.0.0");
    const boot = await bootOf(h.port);
    expect(boot.statePath).toBeUndefined();
    expect(boot.paired).toBe(false);
  });
});

describe("a host that listens beyond this computer", () => {
  it("serves the page with no digest and paired false", async () => {
    const { handle: h } = await up("0.0.0.0");
    const boot = await bootOf(h.port);
    expect(boot.tokenHash).toBeUndefined();
    expect(boot.paired).toBe(false);
    expect(boot.wsPath).toBe(WS_PATH);
  });

  it("pairs whatever a request carries, since the connector's headers are not what opened that road", async () => {
    const { handle: h } = await up("0.0.0.0");
    for (const headers of [{}, THROUGH_CONNECTOR]) {
      const boot = await bootOf(h.port, headers);
      expect(boot.tokenHash).toBeUndefined();
      expect(boot.paired).toBe(false);
    }
  });

  it("still serves the page and its assets to anyone who reaches the port, since pairing is the gate", async () => {
    const { handle: h } = await up("0.0.0.0");
    expect((await fetch(`http://127.0.0.1:${h.port}/`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${h.port}/assets/app.js`)).status).toBe(200);
  });
});

describe("the address every reading names", () => {
  it("addressLines names the bound address, and a reading with none means this computer alone", () => {
    expect(addressLines("/s/state.json", { port: 4400, address: "0.0.0.0" })[0]).toBe("app         http://0.0.0.0:4400");
    expect(addressLines("/s/state.json", { port: 4400 })[0]).toBe(`app         http://${LOOPBACK}:4400`);
  });

  it("addressLines spells an IPv6 address the way every other line does, through the one authority rule", () => {
    const lines = addressLines("/s/state.json", { port: 4400, address: "2001:db8::5" });
    expect(lines[0]).toBe("app         http://[2001:db8::5]:4400");
    expect(lines[1]).toContain(`ws://[2001:db8::5]:4400${WS_PATH}`);
  });

  it("says once, as it starts, that the page is now reachable and pairing is the gate", () => {
    expect(listenBeyondLoopbackLine("0.0.0.0")).toContain("wsp host pair");
  });
});

describe("where a thread on this computer dials this host", () => {
  it("is the host's own port on loopback, one value the guest door and a turn's launch both read", async () => {
    const cell: { url?: string } = {};
    handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, here: cell });
    expect(cell.url).toBe(`http://${LOOPBACK}:${handle.port}`);
    await handle.close();
    handle = undefined;
    // The wildcard answers on loopback too, so a host bound to it is dialled there.
    const wild: { url?: string } = {};
    handle = await startHost({ runtime: testRuntime(), webDir: fakeWebDir(), port: 0, listen: WILDCARD, here: wild });
    expect(wild.url).toBe(`http://${LOOPBACK}:${handle.port}`);
  });

  it("is nothing on a host bound to one address beyond loopback, which says so as it starts", async ctx => {
    expect(hereUrl("192.168.1.20", 4801)).toBeUndefined();
    expect(hereUrl("::1", 4801)).toBe("http://[::1]:4801");
    expect(hereUrl("::", 4801)).toBe(`http://${LOOPBACK}:4801`);
    expect(loopbackThreadsLine("192.168.1.20")).toContain("loopback");
    const beyond = Object.values(networkInterfaces())
      .flatMap(rows => rows ?? [])
      .find(row => row.family === "IPv4" && !row.internal)?.address;
    if (beyond === undefined) {
      ctx.skip();
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-beyond-"));
    dirs.push(dir);
    const cell: { url?: string } = {};
    const lines: string[] = [];
    handle = await serve(quietIO(lines), { port: 0, address: beyond, statePath: join(dir, "state.json"), webDir: fakeWebDir(), runtime: testRuntime(), here: cell });
    expect(cell.url).toBeUndefined();
    expect(lines).toContain(loopbackThreadsLine(beyond));
  });
});

describe("where a tool on this computer dials", () => {
  it("reads the address out of the lock, so a host on one named address is reachable and not assumed loopback", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-dial-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(join(dir, "host-token"), "a-token");
    const lock = (address?: string): void =>
      writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, startedAt: new Date().toISOString(), ...(address !== undefined ? { address } : {}) }));

    lock("100.64.0.3");
    expect(hostAddress(statePath)).toEqual({ url: `ws://100.64.0.3:4400${WS_PATH}`, token: "a-token" });
    lock("::1");
    expect(hostAddress(statePath).url).toBe(`ws://[::1]:4400${WS_PATH}`);
    lock("0.0.0.0");
    expect(hostAddress(statePath).url).toBe(`ws://${LOOPBACK}:4400${WS_PATH}`);
    lock();
    expect(hostAddress(statePath).url).toBe(`ws://${LOOPBACK}:4400${WS_PATH}`);
  });
});

describe("the probe wsp status and wsp up --service wait on", () => {
  it("asks the address the lock names, so a host on one named address does not read as dead", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("", { status: 200 });
    }) as typeof fetch;
    try {
      const lock = (address?: string) => ({ pid: process.pid, port: 4401, startedAt: "", ...(address !== undefined ? { address } : {}) });
      expect(await httpProbe(lock("172.17.0.2"))).toBe(true);
      expect(await httpProbe(lock("::1"))).toBe(true);
      expect(await httpProbe(lock("0.0.0.0"))).toBe(true);
      expect(await httpProbe(lock())).toBe(true);
      expect(seen).toEqual(["http://172.17.0.2:4401/", "http://[::1]:4401/", `http://${LOOPBACK}:4401/`, `http://${LOOPBACK}:4401/`]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("the lock the host writes", () => {
  it("records the address it bound so wsp status and wsp host pair read it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-state-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const runtime = testRuntime();
    handle = await serve(quietIO(), { port: 0, address: "0.0.0.0", statePath, webDir: fakeWebDir(), runtime });
    const lock = JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")) as { address?: string; port: number };
    expect(lock.address).toBe("0.0.0.0");
    expect(addressLines(statePath, lock)[0]).toBe(`app         http://0.0.0.0:${lock.port}`);
  });
});

describe("a host on loopback that a relay carries traffic to", () => {
  /** A linked box serving its own loopback port, with the relay itself off: what decides here is what a request
   * carries, not whether the tunnel is up. */
  async function linkedBox(tag: string): Promise<{ h: HostHandle; lines: string[]; runtime: Runtime; statePath: string; home: string }> {
    const dir = mkdtempSync(join(tmpdir(), `wsp-listen-${tag}-`));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const home = join(dir, "home");
    mkdirSync(home);
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", linkedAt: new Date().toISOString() });
    const lines: string[] = [];
    const runtime = testRuntime();
    handle = await serve(quietIO(lines), { port: 0, statePath, webDir: fakeWebDir(), runtime, home });
    return { h: handle, lines, runtime, statePath, home };
  }

  it("records the key of the wsp home it was handed, minted there, on a record linked before it had one", async () => {
    const { statePath, home } = await linkedBox("relay-key");
    const minted = readDeviceKeyPair(home);
    expect(minted).toBeDefined();
    expect(readRelayRecord(statePath)?.deviceKey?.fingerprint).toBe(deviceKeyOf(minted!).fingerprint);
  });

  it("serves its own computer's app the token's digest in the page, exactly as it did before it was linked", async () => {
    const { h } = await linkedBox("relay-here");
    const boot = await bootOf(h.port);
    expect(boot.tokenHash).toBe(digestOf(h.authToken));
    expect(boot.paired).toBe(true);
  });

  it("takes the pairing road on a request the connector forwarded, and the local road on one it did not, down the one port", async () => {
    const { h } = await linkedBox("relay-through");
    const port = h.port;

    // Both readings on the one host, since telling them apart is the whole of what this does: a host that answers
    // the same way to both has no rule at all.
    const forwarded = await bootOf(port, THROUGH_CONNECTOR);
    expect(forwarded.tokenHash).toBeUndefined();
    expect(forwarded.paired).toBe(false);

    const local = await bootOf(port);
    expect(local.tokenHash).toBe(digestOf(h.authToken));
    expect(local.paired).toBe(true);

    // The one road in for the forwarded request still works: a code from the host's own terminal buys a device token.
    const code = await pairCode(port, h.authToken);
    const redeemed = await redeem(port, code);
    expect(redeemed.deviceToken).toMatch(/\S/);
  });

  it("says at start which requests pair and which open as before", async () => {
    const { lines } = await linkedBox("relay-said");
    expect(lines.join("\n")).toContain("through the relay");
  });

  it("still opens its own door for a computer on this network, which the relay is no road to", async () => {
    const { h } = await linkedBox("relay-door");
    const view = await h.door.open();
    expect(h.door.port()).toBeDefined();
    expect(view.port).toBe(h.door.port());
    expect(view.port).not.toBe(h.port);
  });

  it("reads either of the connector's two headers, in the capitals cloudflared writes them", async () => {
    const { h } = await linkedBox("relay-half");
    // Written the way the connector writes them and sent down a raw socket, since fetch lowercases what it is given
    // and this host's reading has to hold for what actually arrives.
    for (const header of [["Cf-Connecting-Ip", "203.0.113.7"], ["Cf-Ray", "8e0f4a1b2c3d4e5f-BOM"]] as const) {
      const boot = await rawBootOf(h.port, { [header[0]]: header[1] });
      expect(boot.tokenHash, header[0]).toBeUndefined();
      expect(boot.paired, header[0]).toBe(false);
    }
  });
});

describe("wsp up --no-relay on a linked box", () => {
  it("serves its own computer the token's digest, and stops the connector an earlier run left running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-norelay-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", hostname: "h1.boxes.example", linkedAt: new Date().toISOString() });
    // A connector from a run that was killed: the tunnel it carries reaches this port whatever this run was asked for.
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    writeFileSync(join(dir, "connector.pid"), JSON.stringify({ pid: orphan.pid, startedAt: new Date().toISOString() }));
    const gone = new Promise<void>(done => orphan.once("exit", () => done()));

    handle = await serve(quietIO(), { port: 0, statePath, webDir: fakeWebDir(), runtime: testRuntime(), relay: false });

    const boot = await bootOf(handle.port);
    expect(boot.tokenHash).toBe(digestOf(handle.authToken));
    expect(boot.paired).toBe(true);
    expect((await bootOf(handle.port, THROUGH_CONNECTOR)).paired).toBe(false);
    await gone;
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
  });
});
