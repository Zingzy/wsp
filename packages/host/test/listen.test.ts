// SPDX-License-Identifier: AGPL-3.0-only
// What changes when the host binds an address other than this computer's own:
// the page carries no token, the JSON routes ask for a paired device's, the
// lock and the address lines name the address, and the runtime answers on the
// app's own port at WS_PATH.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { API_UNAUTHORIZED, listenBeyondLoopbackLine, LOOPBACK, WS_PATH, type BootPayload } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { serve, type CliIO } from "../src/cli.js";
import { writeRelayRecord } from "../src/relay-link.js";
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
  void store.put("goldens", "default", GOLDEN);
  return createRuntime({ backend: stubBackend(), store, adapters: {} });
}

async function up(listen?: string): Promise<{ handle: HostHandle; runtime: Runtime }> {
  const runtime = testRuntime();
  handle = await startHost({ runtime, webDir: fakeWebDir(), port: 0, wsPort: 0, ...(listen !== undefined ? { listen } : {}) });
  return { handle, runtime };
}

/** The boot object out of the page the host served, which is the one inline script it carries. */
async function bootOf(port: number): Promise<BootPayload> {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const script = /<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(html);
  return JSON.parse(script![1]!) as BootPayload;
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

/** A code, minted the way wsp pair does: over a socket holding the host's own token. */
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
    expect(listenBeyondLoopbackLine("0.0.0.0")).toContain("wsp pair");
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
  it("records the address it bound so wsp status and wsp pair read it back", async () => {
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
  it("is not a host on this computer alone: no token in the page, and the JSON routes ask for a paired device's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wsp-listen-relay-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    // A relay that is off: what matters is that this host can be reached from beyond this computer at all.
    writeRelayRecord(statePath, { relayUrl: "http://127.0.0.1:1", hostId: "h1", token: "relay-token", name: "box", linkedAt: new Date().toISOString() });
    const lines: string[] = [];
    handle = await serve(quietIO(lines), { port: 0, wsPort: 0, statePath, webDir: fakeWebDir(), runtime: testRuntime() });

    const boot = await bootOf(handle.port);
    expect(boot.token).toBeUndefined();
    expect(boot.paired).toBe(false);
    expect((await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`)).status).toBe(401);
    expect(lines.join("\n")).toContain("pairing is the gate");

    // The one road in still works: a code from the host's own terminal buys a device token.
    const code = await pairCode(handle.wsPort, handle.authToken);
    const redeemed = await redeem(handle.port, code);
    expect(redeemed.deviceToken).toMatch(/\S/);
    const authed = await fetch(`http://127.0.0.1:${handle.port}/api/workspaces`, { headers: { authorization: `Bearer ${redeemed.deviceToken!}` } });
    expect(authed.status).toBe(200);
  });
});
