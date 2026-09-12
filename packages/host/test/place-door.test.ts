// SPDX-License-Identifier: AGPL-3.0-only
// The door a computer somebody owns dials: a second listener on the wildcard,
// the same page with no token in it, the same runtime behind it, and the one
// port a place file can name for good.
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { API_UNAUTHORIZED, DEFAULT_PLACE_PORT, DEFAULT_PORT, LOOPBACK, PLACE_PORT_OFFSET, WILDCARD, WS_PATH, doorPortHeldLine, type BootPayload } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type Runtime } from "@wsp/runtime";
import { startHost, type HostHandle } from "../src/server.js";
import { SEALED_GOLDEN as GOLDEN } from "./sealed-golden.js";
import { stubBackend } from "./stub-backend.js";

const DEV_BOOT = `<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>`;
const PAGE = `<!doctype html>\n<html><body><div id="root"></div>\n${DEV_BOOT}\n</body></html>\n`;

let dirs: string[] = [];
let handle: HostHandle | undefined;
let held: Server | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await letGo(held);
  held = undefined;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fakeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wsp-door-web-"));
  dirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), PAGE);
  return dir;
}

function testRuntime(): Runtime {
  const store = memoryStore();
  void store.put("goldens", copyKey("default", "default"), GOLDEN);
  return createRuntime({ backend: stubBackend(), store, adapters: {} });
}

/** Holds a port the way the door holds one: the wildcard, since a loopback bind and a wildcard bind on the same
 * port are a clash on Linux and are not one on macOS, and this test must read the same on both. */
const hold = (port: number): Promise<Server | undefined> =>
  new Promise(done => {
    const server = createServer((_req, res) => res.end("mine"));
    server.once("error", () => done(undefined));
    server.listen(port, WILDCARD, () => done(server));
  });

const letGo = (server: Server | undefined): Promise<void> => (server === undefined ? Promise.resolve() : new Promise(done => server.close(() => done())));

/** An app port whose door port is free too: the door's own is the app's plus the offset and neither is stepped over,
 * so a pair is picked here rather than left to whatever the operating system hands back. Both are probed on the
 * address their real listener binds, so a port this answers for is one both listeners can have. */
async function freePair(): Promise<number> {
  for (let tries = 0; tries < 20; tries += 1) {
    const probe = createServer();
    const port = await new Promise<number>(done => probe.listen(0, LOOPBACK, () => done((probe.address() as { port: number }).port)));
    await new Promise<void>(done => probe.close(() => done()));
    if (port + PLACE_PORT_OFFSET >= 65_535) continue;
    const beside = await hold(port + PLACE_PORT_OFFSET);
    await letGo(beside);
    if (beside !== undefined) return port;
  }
  throw new Error("no free app port whose door port is free beside it");
}

async function up(opts: { port: number; door?: "closed" | "open"; listen?: string } = { port: 0 }): Promise<HostHandle> {
  handle = await startHost({
    runtime: testRuntime(),
    webDir: fakeWebDir(),
    port: opts.port,
    wsPort: 0,
    ...(opts.door !== undefined ? { door: opts.door } : {}),
    ...(opts.listen !== undefined ? { listen: opts.listen } : {}),
  });
  return handle;
}

/** The boot object out of the page a port served, which is the one inline script it carries. */
async function bootOf(port: number): Promise<BootPayload> {
  const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  return JSON.parse(/<script>window\.__WSP__ = ([\s\S]*?);<\/script>/.exec(html)![1]!) as BootPayload;
}

describe("the door a host opens for computers you own", () => {
  it("sits the offset above the app port, serves the page with no token on it, and keeps the token on the loopback page", async () => {
    const port = await freePair();
    const h = await up({ port, door: "open" });
    expect(h.door.port()).toBe(port + PLACE_PORT_OFFSET);
    expect(DEFAULT_PLACE_PORT).toBe(DEFAULT_PORT + PLACE_PORT_OFFSET);
    const door = await bootOf(port + PLACE_PORT_OFFSET);
    expect(door.token).toBeUndefined();
    expect(door.paired).toBe(false);
    const own = await bootOf(port);
    expect(own.token).toBe(h.authToken);
    expect(own.paired).toBe(true);
  });

  it("asks a request on the door for a paired device's token and reaches the one runtime over its own port", async () => {
    const port = await freePair();
    await up({ port, door: "open" });
    const refused = await fetch(`http://127.0.0.1:${port + PLACE_PORT_OFFSET}/api/workspaces`);
    expect(refused.status).toBe(401);
    expect((await refused.json()).error).toBe(API_UNAUTHORIZED);
    // The same route on the person's own port needs nothing, since reaching it already means being on this computer.
    expect((await fetch(`http://127.0.0.1:${port}/api/workspaces`)).status).toBe(200);
    const ws = new WebSocket(`ws://127.0.0.1:${port + PLACE_PORT_OFFSET}${WS_PATH}`);
    await new Promise<void>((done, fail) => {
      ws.once("open", () => done());
      ws.once("error", fail);
    });
    ws.close();
  });

  it("opens none until it is asked, then answers the same view twice, since the place file names the port for good", async () => {
    const port = await freePair();
    const h = await up({ port });
    expect(h.door.port()).toBeUndefined();
    await expect(fetch(`http://127.0.0.1:${port + PLACE_PORT_OFFSET}/`)).rejects.toThrow();
    const first = await h.door.open();
    const second = await h.door.open();
    expect(first).toEqual(second);
    expect(first.port).toBe(port + PLACE_PORT_OFFSET);
    expect(first.addresses.every(at => at.endsWith(`:${port + PLACE_PORT_OFFSET}`))).toBe(true);
  });

  it("says who holds the port rather than stepping to a free one", async () => {
    const port = await freePair();
    held = await hold(port + PLACE_PORT_OFFSET);
    expect(held).toBeDefined();
    const h = await up({ port });
    await expect(h.door.open()).rejects.toThrow(doorPortHeldLine(port + PLACE_PORT_OFFSET));
  });

  it("opens none on a host that already answers beyond this computer, and names that host's own port instead", async () => {
    const port = await freePair();
    const h = await up({ port, listen: "0.0.0.0" });
    const view = await h.door.open();
    expect(h.door.port()).toBeUndefined();
    expect(view.port).toBe(h.port);
    expect(view.addresses.every(at => at.endsWith(`:${h.port}`))).toBe(true);
  });
});
