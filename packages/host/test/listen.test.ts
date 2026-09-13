// SPDX-License-Identifier: AGPL-3.0-only
// What changes when the host binds an address other than this computer's own:
// the page carries no token, the JSON routes ask for a paired device's, the
// lock and the address lines name the address, and the runtime answers on the
// app's own port at WS_PATH. A box on a relay binds this computer alone and is
// reached down both roads at once, so there it is what a request carries that
// decides, not what the host bound.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsOffRefusal, API_UNAUTHORIZED, listenBeyondLoopbackLine, LOOPBACK, WS_PATH, type BootPayload } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { serve, type CliIO } from "../src/cli.js";
import { writeRelayRecord } from "../src/relay-link.js";
import { spawn } from "node:child_process";
import { addressLines } from "../src/host-lock.js";
import { httpProbe } from "../src/service.js";
import { hostAddress } from "../src/verbs.js";
import { startHost, type HostHandle } from "../src/server.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";

const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
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
  handle = await startHost({ runtime, webDir: fakeWebDir(), port: 0, wsPort: 0, ...(listen !== undefined ? { listen } : {}) });
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

/** The same reading down a raw socket, which is the only way to put a header on the wire in the capitals it was
 * written in. */
async function rawBootOf(port: number, headers: Record<string, string>): Promise<BootPayload> {
  const html = await new Promise<string>((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (body += chunk));
      res.once("end", () => done(body));
    });
    req.once("error", fail);
    req.end();
  });
  return JSON.parse(/<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(html)![1]!) as BootPayload;
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
async function pairCode(wsPort: number, token: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
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

describe("a host on this computer alone", () => {
  it("inlines its own token in the page and says the page is paired", async () => {
    const { handle: h } = await up();
    const boot = await bootOf(h.port);
    expect(boot.token).toBe(h.authToken);
    expect(boot.paired).toBe(true);
    expect(boot.wsPath).toBe(WS_PATH);
  });

  it("answers the JSON routes with nothing in the way, as every local tool expects", async () => {
    const { handle: h } = await up();
    const res = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`);
    expect(res.status).toBe(200);
  });

  it("serves the runtime on the app's own port at WS_PATH as well as on its own port", async () => {
    const { handle: h } = await up();
    for (const url of [`ws://127.0.0.1:${h.port}${WS_PATH}`, `ws://127.0.0.1:${h.wsPort}`]) {
      const ws = new WebSocket(url);
      await new Promise<void>((done, fail) => {
        ws.once("open", () => done());
        ws.once("error", fail);
      });
      const reply = await new Promise<Record<string, unknown>>(done => {
        ws.once("message", raw => done(JSON.parse(String(raw)) as Record<string, unknown>));
        ws.send(JSON.stringify({ id: 1, op: "auth", token: h.authToken }));
      });
      expect(reply["ok"], url).toBe(true);
      ws.close();
    }
  });
});

describe("a host that listens beyond this computer", () => {
  it("serves the page with no token and paired false", async () => {
    const { handle: h } = await up("0.0.0.0");
    const boot = await bootOf(h.port);
    expect(boot.token).toBeUndefined();
    expect(boot.paired).toBe(false);
    expect(boot.wsPath).toBe(WS_PATH);
  });

  it("answers 401 on a JSON route with no bearer and 200 with a paired device's token", async () => {
    const { handle: h } = await up("0.0.0.0");
    const bare = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`);
    expect(bare.status).toBe(401);
    expect((await bare.json()) as { error: string }).toEqual({ error: API_UNAUTHORIZED });

    const code = await pairCode(h.wsPort, h.authToken);
    const { deviceToken } = await redeem(h.port, code);
    expect(typeof deviceToken).toBe("string");

    const withToken = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: `Bearer ${deviceToken!}` } });
    expect(withToken.status).toBe(200);

    const wrong = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
  });

  it("a token scoped to a thread is that thread on the JSON routes too, not a paired computer", async () => {
    const { handle: h, runtime } = await up("0.0.0.0");
    const own = await runtime.workspaces.create({ golden: GOLDEN.versions[0]!.snapshotId, name: "lead" });
    const thread = await runtime.devices.mint("thread abcd1234", { kind: "thread", threadId: "t_1", workspaceId: own.id, rootThreadId: "t_1" }, Date.now());
    const auth = { authorization: `Bearer ${thread.deviceToken}` };

    // The listing is the one that thread may drive: the workspace it runs on, and nothing outside its tree.
    const listed = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { headers: auth });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { workspaces: { name: string }[] }).workspaces.map(w => w.name)).toEqual(["lead"]);

    // And the route that forks a machine is held to what that thread may do, which on a workspace with no switch
    // is nothing; a paired computer's token still forks.
    const made = await fetch(`http://127.0.0.1:${h.port}/api/workspaces`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ name: "b1" }) });
    expect(made.status).toBe(500);
    expect((await made.json()) as { error: string }).toEqual({ error: agentsOffRefusal("lead", "fork") });
    expect((await runtime.workspaces.list()).map(w => w.name)).toEqual(["lead"]);
  });

  it("pairs whatever a request carries, since the connector's headers are not what opened that road", async () => {
    const { handle: h } = await up("0.0.0.0");
    for (const headers of [{}, THROUGH_CONNECTOR]) {
      const boot = await bootOf(h.port, headers);
      expect(boot.token).toBeUndefined();
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
    expect(addressLines("/s/state.json", { port: 4400, wsPort: 4410, address: "0.0.0.0" })[0]).toBe("app         http://0.0.0.0:4400");
    expect(addressLines("/s/state.json", { port: 4400, wsPort: 4410 })[0]).toBe(`app         http://${LOOPBACK}:4400`);
  });

  it("addressLines spells an IPv6 address the way every other line does, through the one authority rule", () => {
    const lines = addressLines("/s/state.json", { port: 4400, wsPort: 4410, address: "2001:db8::5" });
    expect(lines[0]).toBe("app         http://[2001:db8::5]:4400");
    expect(lines[1]).toContain("ws://[2001:db8::5]:4410");
  });

  it("says once, as it starts, that the page is now reachable and pairing is the gate", () => {
    expect(listenBeyondLoopbackLine("0.0.0.0")).toContain("wsp host pair");
  });
});

describe("where a tool on this computer dials", () => {
  it("reads the address out of the lock, so a host on one named address is reachable and not assumed loopback", () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-dial-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeFileSync(join(dir, "host-token"), "a-token");
    const lock = (address?: string): void =>
      writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: process.pid, port: 4400, wsPort: 4410, startedAt: new Date().toISOString(), ...(address !== undefined ? { address } : {}) }));

    lock("100.64.0.3");
    expect(hostAddress(statePath)).toEqual({ url: "ws://100.64.0.3:4410", token: "a-token" });
    lock("::1");
    expect(hostAddress(statePath).url).toBe("ws://[::1]:4410");
    lock("0.0.0.0");
    expect(hostAddress(statePath).url).toBe(`ws://${LOOPBACK}:4410`);
    lock();
    expect(hostAddress(statePath).url).toBe(`ws://${LOOPBACK}:4410`);
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
      const lock = (address?: string) => ({ pid: process.pid, port: 4401, wsPort: 4411, startedAt: "", ...(address !== undefined ? { address } : {}) });
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
    handle = await serve(quietIO(), { port: 0, wsPort: 0, address: "0.0.0.0", statePath, webDir: fakeWebDir(), runtime });
    const lock = JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")) as { address?: string; port: number; wsPort: number };
    expect(lock.address).toBe("0.0.0.0");
    expect(addressLines(statePath, lock)[0]).toBe(`app         http://0.0.0.0:${lock.port}`);
  });
});

describe("a host on loopback that a relay carries traffic to", () => {
  /** A linked box serving its own loopback port, with the relay itself off: what decides here is what a request
   * carries, not whether the tunnel is up. */
  async function linkedBox(tag: string): Promise<{ h: HostHandle; lines: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), `wsp-listen-${tag}-`));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", linkedAt: new Date().toISOString() });
    const lines: string[] = [];
    handle = await serve(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), runtime: testRuntime() });
    return { h: handle, lines };
  }

  it("serves its own computer's app the token in the page, exactly as it did before it was linked", async () => {
    const { h } = await linkedBox("relay-here");
    const boot = await bootOf(h.port);
    expect(boot.token).toBe(h.authToken);
    expect(boot.paired).toBe(true);
    expect((await fetch(`http://127.0.0.1:${h.port}/api/workspaces`)).status).toBe(200);
  });

  it("takes the pairing road on a request the connector forwarded, and the local road on one it did not, down the one port", async () => {
    const { h } = await linkedBox("relay-through");
    const port = h.port;

    // Both readings on the one host, since telling them apart is the whole of what this does: a host that answers
    // the same way to both has no rule at all.
    const forwarded = await bootOf(port, THROUGH_CONNECTOR);
    expect(forwarded.token).toBeUndefined();
    expect(forwarded.paired).toBe(false);
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: THROUGH_CONNECTOR })).status).toBe(401);

    const local = await bootOf(port);
    expect(local.token).toBe(h.authToken);
    expect(local.paired).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`)).status).toBe(200);

    // The one road in for the forwarded request still works: a code from the host's own terminal buys a device token.
    const code = await pairCode(h.wsPort, h.authToken);
    const redeemed = await redeem(port, code);
    expect(redeemed.deviceToken).toMatch(/\S/);
    const authed = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { ...THROUGH_CONNECTOR, authorization: `Bearer ${redeemed.deviceToken!}` } });
    expect(authed.status).toBe(200);
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
      expect(boot.token, header[0]).toBeUndefined();
      expect(boot.paired, header[0]).toBe(false);
    }
  });
});

describe("wsp up --no-relay on a linked box", () => {
  it("serves its own computer the token, and stops the connector an earlier run left running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-norelay-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", hostname: "h1.boxes.example", linkedAt: new Date().toISOString() });
    // A connector from a run that was killed: the tunnel it carries reaches this port whatever this run was asked for.
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    writeFileSync(join(dir, "connector.pid"), JSON.stringify({ pid: orphan.pid, startedAt: new Date().toISOString() }));
    const gone = new Promise<void>(done => orphan.once("exit", () => done()));

    handle = await serve(quietIO(), { port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), runtime: testRuntime(), relay: false });

    const boot = await bootOf(handle.port);
    expect(boot.token).toBe(handle.authToken);
    expect(boot.paired).toBe(true);
    expect((await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, { headers: THROUGH_CONNECTOR })).status).toBe(401);
    await gone;
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
  });
});
