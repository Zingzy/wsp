// SPDX-License-Identifier: AGPL-3.0-only
// The box's side of the relay: the device code flow that links it to a
// person's account, the tunnel it asks for at every start, the connector child
// it runs against its own loopback port, and the unlink that hands everything
// back. The relay here is a real http server in this process, so the requests,
// the headers and the refusals are real ones.
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliIO } from "../src/cli.js";
import { connectCommand } from "../src/connect.js";
import { dialWindowMs, readHost } from "../src/hosts.js";
import { startConnector, type Connector } from "../src/connector.js";
import { accountHere, publicHostname, readRelayClient, readRelayRecord, relayCommand, relayHostUrl, relayRecordPath, startRelay, type RelayDeps } from "../src/relay-link.js";
import { CLOUDFLARED } from "../src/connector.js";
import type { DialOpts, HostClient } from "../src/verbs.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const io = (log: string[] = [], err: string[] = []): CliIO => ({ log: l => log.push(l), error: l => err.push(l), ask: noPrompt, askSecret: noPrompt });

let dirs: string[] = [];
let servers: Server[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const server of servers) await new Promise<void>(done => server.close(() => done()));
  servers = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Whether a pid this test started is still there; a stop is asked for and the process goes a moment later. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wsp-${tag}-`));
  dirs.push(dir);
  return dir;
}

interface FakeRelay {
  url: string;
  /** Every request the box made: the line and the token it carried. */
  calls: { line: string; token?: string; body: Record<string, unknown> }[];
  /** How many polls answer pending before the person approves. */
  pending: number;
  /** What the tunnel route answers; a hostname of null is a relay with no zone. */
  tunnel: { tunnelToken: string | null; hostname: string | null; why?: string };
  /** What the approval says about who approved it; empty for a relay from before it named one. */
  login: { login?: string };
  hosts: { id: string; name: string; hostname: string | null }[];
  clients: { id: string; name: string; thisOne: boolean }[];
  /** Called as each request arrives, for a test that cares what was already true by then. */
  onCall?: (line: string) => void;
  /** A route answers this refusal instead, once armed. */
  refuse?: { status: number; error: string };
}

/** The one shape a box may report, as the Worker reads it (isQuickTunnel in infra/relay/src/env.ts). */
const isQuickTunnel = (name: string): boolean => /^[a-z0-9-]+\.trycloudflare\.com$/i.test(name);

async function fakeRelay(): Promise<FakeRelay> {
  const state: FakeRelay = { url: "", calls: [], pending: 1, login: { login: "zingzy" }, tunnel: { tunnelToken: null, hostname: null, why: "this relay has no zone" }, hosts: [], clients: [] };
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const path = new URL(req.url ?? "/", "http://box").pathname;
      const line = `${req.method} ${path}`;
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
      state.calls.push({ line, ...(token !== undefined ? { token } : {}), body });
      state.onCall?.(line);
      const send = (status: number, answer: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer));
      };
      if (state.refuse !== undefined && !line.includes("/link/")) return send(state.refuse.status, { error: state.refuse.error });
      if (line === "POST /link/start") {
        return send(200, { code: "ABCD2345", verifyUrl: `${state.url}/link/verify?code=ABCD2345`, pollToken: "poll-token", expiresAt: new Date(Date.now() + 900_000).toISOString(), pollAfterMs: 1 });
      }
      if (line === "POST /link/poll") {
        if (state.pending > 0) {
          state.pending -= 1;
          return send(200, { state: "pending" });
        }
        const started = state.calls.filter(c => c.line === "POST /link/start").at(-1);
        const kind = started?.body["kind"];
        const name = String(started?.body["name"] ?? "");
        return send(200, kind === "client" ? { state: "approved", token: "client-token", name, ...state.login } : { state: "approved", token: "host-token", hostId: "hbox1", name, ...state.login });
      }
      if (line === "POST /hosts/hbox1/tunnel") return send(200, state.tunnel);
      if (line === "POST /hosts/hbox1/heartbeat") {
        // The Worker's own heartbeat rule (hostHeartbeat in infra/relay/src/hosts.ts), in the four parts a box can
        // tell apart: a name is lowercased, only the quick tunnel it was given is allowed, a row already holding a
        // managed name keeps it, and what is left is written onto the row a listing reads. A managed row here is one
        // whose name is not a quick tunnel's, since the zone the Worker derives that name from is the relay's own.
        const said = body["hostname"];
        const reported = typeof said === "string" && said !== "" ? said.toLowerCase() : undefined;
        if (reported !== undefined && !isQuickTunnel(reported)) {
          return send(400, { error: "a host may report the quick tunnel it was given and no other name; a managed hostname is the relay's own" });
        }
        const row = state.hosts.find(h => h.id === "hbox1");
        const managed = row !== undefined && row.hostname !== null && !isQuickTunnel(row.hostname);
        if (row !== undefined && reported !== undefined && !managed) row.hostname = reported;
        return send(200, { ok: true });
      }
      if (line === "GET /hosts") return send(200, { hosts: state.hosts });
      if (line === "GET /clients") return send(200, { clients: state.clients });
      if (line.startsWith("DELETE /clients/")) return send(200, { deleted: true });
      if (line === "DELETE /hosts/hbox1") return send(200, { deleted: true });
      return send(404, { error: `no route: ${line}` });
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  state.url = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  return state;
}

/** A script that says what a quick tunnel says and then waits, so the connector under test is a real child. */
function fakeConnector(dir: string, hostname = "blue-sky-1234.trycloudflare.com"): string {
  const bin = join(dir, "fake-cloudflared");
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${join(dir, "argv")}"\n>&2 echo 'INF |  https://${hostname}  |'\nsleep 30\n`, { mode: 0o755 });
  return bin;
}

/** A connector handed a fresh quick tunnel name every time it runs, as cloudflared is: the first child prints one
 * and goes, the next prints another and stays. */
function restartingConnector(dir: string): string {
  const bin = join(dir, "restarting-cloudflared");
  const runs = join(dir, "runs");
  writeFileSync(
    bin,
    `#!/bin/sh\nn=$(cat "${runs}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${runs}"\n>&2 echo "INF |  https://name-$n.trycloudflare.com  |"\nif [ "$n" -ge 2 ]; then sleep 30; else exit 1; fi\n`,
    { mode: 0o755 },
  );
  return bin;
}

/** The connector, restarted fast enough for a test: the two seconds a real box waits are the box's constraint. */
function restarting(dir: string): Partial<RelayDeps> {
  return { cloudflared: async () => restartingConnector(dir), connector: opts => startConnector({ ...opts, restartMs: 20 }) };
}

function deps(dir: string, extra: Partial<RelayDeps> = {}): RelayDeps {
  return {
    fetch: (input, init) => fetch(input as string, init),
    now: () => Date.now(),
    // The half second the poll floor holds a real box to protects it from a relay that answers zero; a test that
    // sat through it would only be measuring the floor.
    sleep: () => Promise.resolve(),
    deviceName: () => "the box",
    cloudflared: async () => fakeConnector(dir),
    connector: startConnector,
    heartbeatMs: 40,
    ...extra,
  };
}

/** A state folder with nothing in it, as a box that has never linked has. */
function box(): { statePath: string; dir: string; home: string } {
  const dir = tempDir("relay-state");
  return { statePath: join(dir, "state.json"), dir, home: tempDir("relay-home") };
}

describe("wsp host link", () => {
  it("prints the code and the page, waits for the approval and keeps the token where only this user reads it", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["link", relay.url], {}, deps(dir))).toBe(0);

    expect(log.join("\n")).toContain("ABCD2345");
    expect(log.join("\n")).toContain(`${relay.url}/link/verify?code=ABCD2345`);
    expect(log.join("\n")).not.toContain("host-token");
    expect(relay.calls.map(c => c.line)).toEqual(["POST /link/start", "POST /link/poll", "POST /link/poll"]);
    expect(relay.calls[0]!.body).toMatchObject({ kind: "host", name: "the box" });

    const record = readRelayRecord(statePath)!;
    expect(record).toMatchObject({ relayUrl: relay.url, hostId: "hbox1", token: "host-token", name: "the box" });
    expect(statSync(relayRecordPath(statePath)).mode & 0o777).toBe(0o600);
  });

  it("takes the name to show the person from the line", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], { name: "attic" }, deps(dir));
    expect(relay.calls[0]!.body["name"]).toBe("attic");
    expect(readRelayRecord(statePath)!.name).toBe("attic");
  });

  it("refuses a second link over the first, and a line with no relay to link to", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    await expect(relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir))).rejects.toThrow(/unlink/);
    const fresh = box();
    await expect(relayCommand(io(), { statePath: fresh.statePath, home: fresh.home }, ["link"], {}, deps(fresh.dir))).rejects.toThrow(/address/);
  });
});

describe("a linked box starting up", () => {
  it("asks for a tunnel, runs the connector against its own loopback port and says where it landed", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    relay.calls.length = 0;

    const lines: string[] = [];
    const up = (await startRelay({ statePath, port: 4400, log: line => lines.push(line) }, deps(dir)))!;
    closers.push(() => up.close());
    const hostname = await up.hostname();

    expect(hostname).toBe("blue-sky-1234.trycloudflare.com");
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("tunnel --no-autoupdate --url http://127.0.0.1:4400");
    expect(lines.join("\n")).toContain("public      https://blue-sky-1234.trycloudflare.com");
    const asked = relay.calls.find(c => c.line === "POST /hosts/hbox1/tunnel")!;
    expect(asked.token).toBe("host-token");
    expect(asked.body).toEqual({ port: 4400 });
    // The hostname a quick tunnel handed out is the box's to report: the relay learns it from the heartbeat.
    await vi.waitUntil(() => relay.calls.some(c => c.line === "POST /hosts/hbox1/heartbeat" && c.body["hostname"] === hostname), { timeout: 4000 });
    expect(readRelayRecord(statePath)!.hostname).toBe(hostname);
  });

  it("says which connector is carrying it, not which wsp asked", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    await up.hostname();
    const beat = await vi.waitUntil(() => relay.calls.find(c => c.line === "POST /hosts/hbox1/heartbeat"), { timeout: 4000 });
    expect(beat.body["version"]).toBe(CLOUDFLARED.version);
  });

  it("names the public address only while a connector this computer started is carrying it", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    const hostname = await up.hostname();
    expect(publicHostname(statePath)).toBe(hostname);

    // wsp status and wsp host pair read this: with the connector stopped, the name in the record serves nothing.
    await up.close();
    expect(publicHostname(statePath)).toBeUndefined();
  });

  it("keeps saying it is there", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, port: 4400, log: () => {} }, deps(dir)))!;
    closers.push(() => up.close());
    await vi.waitUntil(() => relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length >= 2, { timeout: 4000 });
  });

  it("runs the managed tunnel by its token when the relay had a hostname to give", async () => {
    const relay = await fakeRelay();
    relay.tunnel = { tunnelToken: "tunnel-token", hostname: "hbox1.boxes.example" };
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const lines: string[] = [];
    const up = (await startRelay({ statePath, port: 4400, log: line => lines.push(line) }, deps(dir)))!;
    closers.push(() => up.close());

    expect(await up.hostname()).toBe("hbox1.boxes.example");
    // The relay already holds the managed name, so the heartbeat carries none: one that named it would be refused
    // and the box would never read as up.
    const beat = await vi.waitUntil(() => relay.calls.find(c => c.line === "POST /hosts/hbox1/heartbeat"), { timeout: 4000 });
    expect(beat.body).toEqual({ version: CLOUDFLARED.version });
    expect(lines.join("\n")).not.toContain("could not say where this host is");
    await vi.waitUntil(() => existsSync(join(dir, "argv")) && readFileSync(join(dir, "argv"), "utf8").trim() !== "", { timeout: 4000 });
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe("tunnel --no-autoupdate run");
    expect(lines.join("\n")).toContain("public      https://hbox1.boxes.example");
    expect(lines.join("\n")).not.toContain("tunnel-token");
    expect(readRelayRecord(statePath)!.hostname).toBe("hbox1.boxes.example");
  });

  it("reports the fresh name a restarted quick tunnel was given, and is listed under it", async () => {
    const relay = await fakeRelay();
    relay.hosts = [{ id: "hbox1", name: "the box", hostname: null }];
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));

    const lines: string[] = [];
    const up = (await startRelay({ statePath, port: 4400, log: line => lines.push(line) }, deps(dir, restarting(dir))))!;
    closers.push(() => up.close());
    expect(await up.hostname()).toBe("name-1.trycloudflare.com");

    // The first child goes and the next is given another name; nothing else tells the relay the old one is dead.
    await vi.waitUntil(() => readRelayRecord(statePath)!.hostname === "name-2.trycloudflare.com", { timeout: 4000 });
    await vi.waitUntil(() => relay.calls.some(c => c.line === "POST /hosts/hbox1/heartbeat" && c.body["hostname"] === "name-2.trycloudflare.com"), { timeout: 4000 });
    expect(lines.join("\n")).toContain("public      https://name-2.trycloudflare.com");

    relay.pending = 1;
    const listed: string[] = [];
    expect(await relayCommand(io(listed), { statePath, home }, ["linked", relay.url], {}, deps(dir))).toBe(0);
    expect(listed.join("\n")).toContain("https://name-2.trycloudflare.com");
    expect(listed.join("\n")).not.toContain("name-1.trycloudflare.com");
  });

  it("sends no hostname when a managed tunnel's connector restarts, whatever the child prints", async () => {
    const relay = await fakeRelay();
    relay.tunnel = { tunnelToken: "tunnel-token", hostname: "hbox1.boxes.example" };
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));

    const lines: string[] = [];
    const up = (await startRelay({ statePath, port: 4400, log: line => lines.push(line) }, deps(dir, restarting(dir))))!;
    closers.push(() => up.close());
    expect(await up.hostname()).toBe("hbox1.boxes.example");

    // A managed name is the relay's own: it does not change when the child does, and a box that reported one back
    // would be refused and never read as up. This child prints a quick tunnel's line at every start regardless.
    await vi.waitUntil(() => existsSync(join(dir, "runs")) && Number(readFileSync(join(dir, "runs"), "utf8").trim()) >= 2, { timeout: 4000 });
    await vi.waitUntil(() => relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat").length >= 2, { timeout: 4000 });
    for (const beat of relay.calls.filter(c => c.line === "POST /hosts/hbox1/heartbeat")) expect(beat.body).toEqual({ version: CLOUDFLARED.version });
    expect(readRelayRecord(statePath)!.hostname).toBe("hbox1.boxes.example");
    expect(lines.join("\n")).not.toContain("trycloudflare.com");
    expect(lines.join("\n")).not.toContain("could not say where this host is");
  });

  it("puts no record back when a name arrives after the unlink took it away", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));

    // The one moment the guard is for: the record is cleared while a connector child is still coming up, so the
    // name it prints arrives with nothing left on disk to write it into. The connector is a stand-in here, since a
    // child started for a box that has been unlinked is exactly what must not happen.
    let arrived: ((hostname: string) => void) | undefined;
    const stub: Connector = { pid: undefined, hostname: async () => undefined, stop: async () => {} };
    const lines: string[] = [];
    const up = (await startRelay(
      { statePath, port: 4400, log: line => lines.push(line) },
      deps(dir, {
        connector: opts => {
          arrived = opts.onHostname;
          return stub;
        },
      }),
    ))!;
    closers.push(() => up.close());

    expect(await relayCommand(io(), { statePath, home }, ["unlink"], {}, deps(dir))).toBe(0);
    expect(existsSync(relayRecordPath(statePath))).toBe(false);
    relay.calls.length = 0;

    arrived!("late-name-9.trycloudflare.com");
    await new Promise(done => setTimeout(done, 100));
    // The file itself, not what readRelayRecord makes of it: a record put back holding a hostname alone is one the
    // reader rejects, so a box would read as never linked and the file would sit there with nothing to clear it.
    expect(existsSync(relayRecordPath(statePath))).toBe(false);
    expect(lines.join("\n")).not.toContain("late-name-9");
    expect(relay.calls.some(c => c.body["hostname"] === "late-name-9.trycloudflare.com")).toBe(false);
  });

  it("starts nothing at all on a box that never linked", async () => {
    const { statePath, dir } = box();
    expect(await startRelay({ statePath, port: 4400, log: () => {} }, deps(dir))).toBeUndefined();
  });

  it("leaves the host running when the relay is down, and says so once", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    relay.refuse = { status: 500, error: "the relay fell over" };
    const lines: string[] = [];
    expect(await startRelay({ statePath, port: 4400, log: line => lines.push(line) }, deps(dir))).toBeUndefined();
    expect(lines.join("\n")).toContain("relay");
    expect(existsSync(join(dir, "argv"))).toBe(false);
  });
});

describe("wsp host unlink", () => {
  it("takes the host off the relay, stops the connector it started and forgets the token", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    const up = (await startRelay({ statePath, port: 4400, log: () => {} }, deps(dir)))!;
    await up.hostname();
    const pid = Number(readFileSync(join(dir, "connector.pid"), "utf8").trim());

    // The tunnel cannot be deleted while its connector still holds connections, so the child goes first.
    let childAtDelete: boolean | undefined;
    relay.onCall = line => {
      if (line === "DELETE /hosts/hbox1") childAtDelete = alive(pid);
    };
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["unlink"], {}, deps(dir))).toBe(0);
    expect(relay.calls.some(c => c.line === "DELETE /hosts/hbox1" && c.token === "host-token")).toBe(true);
    expect(childAtDelete).toBe(false);
    expect(readRelayRecord(statePath)).toBeUndefined();
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
    await vi.waitUntil(() => !alive(pid), { timeout: 4000 });
    // The host is still running, and it is what would start another connector; with the record gone it starts none.
    await new Promise(done => setTimeout(done, 300));
    expect(existsSync(join(dir, "connector.pid"))).toBe(false);
    await up.close();
  });

  it("forgets the token even when the relay refuses, and says what is left to do", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    relay.refuse = { status: 401, error: "that token does not name this host" };
    const err: string[] = [];
    expect(await relayCommand(io([], err), { statePath, home }, ["unlink"], {}, deps(dir))).toBe(0);
    expect(readRelayRecord(statePath)).toBeUndefined();
    expect(err.join("\n")).toContain("that token does not name this host");
  });

  it("says there is nothing to unlink on a box that never linked", async () => {
    const { statePath, home, dir } = box();
    await expect(relayCommand(io(), { statePath, home }, ["unlink"], {}, deps(dir))).rejects.toThrow(/wsp host link/);
  });
});

describe("the person's own client", () => {
  it("links this computer once and lists the hosts on the account", async () => {
    const relay = await fakeRelay();
    relay.hosts = [
      { id: "hbox1", name: "box", hostname: "hbox1.boxes.example" },
      { id: "hattic", name: "attic", hostname: null },
    ];
    const { statePath, home, dir } = box();
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["linked", relay.url], {}, deps(dir))).toBe(0);

    expect(readRelayClient(home)).toMatchObject({ relayUrl: relay.url, token: "client-token" });
    expect(statSync(join(home, "relay-client.json")).mode & 0o777).toBe(0o600);
    expect(log.join("\n")).toContain("box");
    expect(log.join("\n")).toContain("hbox1.boxes.example");
    expect(log.join("\n")).toContain("attic");
    expect(log.join("\n")).not.toContain("client-token");

    const before = relay.calls.length;
    relay.pending = 1;
    await relayCommand(io(), { statePath, home }, ["linked"], {}, deps(dir));
    // The second listing signs in again for nothing if the token is not kept.
    expect(relay.calls.slice(before).map(c => c.line)).toEqual(["GET /hosts"]);
  });

  it("keeps the person's own token apart from the box's, on a computer that is both", async () => {
    const relay = await fakeRelay();
    relay.hosts = [{ id: "hbox1", name: "box", hostname: "hbox1.boxes.example" }];
    const dir = tempDir("relay-both");
    // The state folder and the wsp home are one and the same by default, which is where these two would collide.
    const statePath = join(dir, "state.json");
    await relayCommand(io(), { statePath, home: dir }, ["link", relay.url], {}, deps(dir));
    relay.pending = 1;
    await relayCommand(io(), { statePath, home: dir }, ["linked", relay.url], {}, deps(dir));

    expect(readRelayRecord(statePath)!.token).toBe("host-token");
    expect(readRelayClient(dir)!.token).toBe("client-token");
    expect(await relayHostUrl(dir, "box", deps(dir))).toBe("https://hbox1.boxes.example");
  });

  it("refuses a second relay rather than overwriting the sign-in this computer holds", async () => {
    const relay = await fakeRelay();
    const other = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["linked", relay.url], {}, deps(dir));
    await expect(relayCommand(io(), { statePath, home }, ["linked", other.url], {}, deps(dir))).rejects.toThrow(relay.url);
    expect(readRelayClient(home)!.relayUrl).toBe(relay.url);
  });

  it("says to sign in again when the relay has taken this computer's sign-in away", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["linked", relay.url], {}, deps(dir));
    relay.refuse = { status: 401, error: "this computer's sign-in was taken away; run wsp host linked <url> to sign in again" };
    const err: string[] = [];
    await expect(relayCommand(io([], err), { statePath, home }, ["linked"], {}, deps(dir))).rejects.toThrow(/sign in again/);
  });

  it("lists the computers signed in to the relay and takes one away", async () => {
    const relay = await fakeRelay();
    relay.clients = [
      { id: "c1", name: "the Mac", thisOne: true },
      { id: "c2", name: "the laptop", thisOne: false },
    ];
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["linked", relay.url], {}, deps(dir));
    const log: string[] = [];
    expect(await relayCommand(io(log), { statePath, home }, ["clients"], {}, deps(dir))).toBe(0);
    expect(log.join("\n")).toContain("the Mac");
    expect(log.join("\n")).toContain("this one");
    expect(log.join("\n")).toContain("the laptop");

    expect(await relayCommand(io(), { statePath, home }, ["clients", "revoke", "c2"], {}, deps(dir))).toBe(0);
    expect(relay.calls.some(c => c.line === "DELETE /clients/c2" && c.token === "client-token")).toBe(true);
  });

  it("names a host's address for wsp host connect, and says so when the relay has none for it", async () => {
    const relay = await fakeRelay();
    relay.hosts = [{ id: "hbox1", name: "box", hostname: "hbox1.boxes.example" }, { id: "hattic", name: "attic", hostname: null }];
    const { home, dir } = box();
    await relayCommand(io(), { statePath: join(dir, "state.json"), home }, ["linked", relay.url], {}, deps(dir));

    expect(await relayHostUrl(home, "box", deps(dir))).toBe("https://hbox1.boxes.example");
    await expect(relayHostUrl(home, "attic", deps(dir))).rejects.toThrow(/attic/);
    await expect(relayHostUrl(home, "cellar", deps(dir))).rejects.toThrow(/box/);

    // Two boxes under one name is not a guess to make: a line that could go to either goes to neither.
    relay.hosts = [
      { id: "hbox1", name: "box", hostname: "hbox1.boxes.example" },
      { id: "hbox2", name: "box", hostname: "hbox2.boxes.example" },
    ];
    await expect(relayHostUrl(home, "box", deps(dir))).rejects.toThrow(/hbox1/);
    expect(await relayHostUrl(home, "hbox2", deps(dir))).toBe("https://hbox2.boxes.example");
  });
});

describe("wsp host connect --relay", () => {
  /** A host that answers the redeem, so this test is about which address the dial was handed and nothing else. */
  const paired: HostClient = {
    request: (async () => ({})) as HostClient["request"],
    events: async () => {},
    onFrame: () => () => {},
    closed: Promise.resolve(),
    closeWords: () => "",
    paired: { deviceId: "d_1", deviceToken: "device-token" },
    close: () => {},
    terminate: () => {},
  };

  it("pairs with a host on the relay by the name it has there, over the address the relay named", async () => {
    const relay = await fakeRelay();
    relay.hosts = [{ id: "hbox1", name: "box", hostname: "hbox1.boxes.example" }];
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["linked", relay.url], {}, deps(dir));

    const dialled: DialOpts[] = [];
    const log: string[] = [];
    const code = await connectCommand(io(log), { statePath, home }, { code: "QWAXC5GT", relay: "box" }, [], {
      dial: async (_statePath, opts) => {
        dialled.push(opts);
        return paired;
      },
      now: () => Date.parse("2026-09-11T12:00:00.000Z"),
      deviceName: () => "the Mac",
      relayUrl: (at, name) => relayHostUrl(at, name, deps(dir)),
      window: dialWindowMs,
    });

    expect(code).toBe(0);
    expect(dialled).toHaveLength(1);
    expect(dialled[0]!.host).toBe("https://hbox1.boxes.example");
    expect(dialled[0]!.redeem).toEqual({ code: "QWAXC5GT", name: "the Mac" });
    expect(readHost(home, "box")!.url).toBe("https://hbox1.boxes.example");
    expect(log.join("\n")).not.toContain("device-token");
  });

  it("refuses an address beside the name, since the relay is what says where that host is", async () => {
    const { statePath, home } = box();
    await expect(
      connectCommand(io(), { statePath, home }, { code: "QWAXC5GT", relay: "box" }, ["https://elsewhere.example"], {
        dial: async () => paired,
        now: () => 0,
        deviceName: () => "the Mac",
        relayUrl: async () => "https://never.example",
        window: dialWindowMs,
      }),
    ).rejects.toThrow(/--relay/);
  });
});

describe("who this wsp is signed in to", () => {
  it("reads as no sign-in while neither record is on this computer, and on a host serving no state file", () => {
    const { statePath, home } = box();
    expect(accountHere(statePath, home)).toEqual({ signedIn: false });
    // A bare path must not send the read at whatever relay.json the working folder holds.
    expect(accountHere(undefined, home)).toEqual({ signedIn: false });
    expect(accountHere("", home)).toEqual({ signedIn: false });
  });

  it("names the account the box was linked under", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    expect(accountHere(statePath, home)).toEqual({ signedIn: true, login: "zingzy" });
  });

  it("names the account this computer signed in under, a wsp home apart from the box's state", async () => {
    const relay = await fakeRelay();
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["hosts", relay.url], {}, deps(dir));
    expect(accountHere(statePath, home)).toEqual({ signedIn: true, login: "zingzy" });
  });

  it("says signed in with no name against a relay whose approval names no account", async () => {
    // A relay from before the approval carried a login: the record is a sign-in all the same, and the row says so
    // rather than reading as signed out.
    const relay = await fakeRelay();
    relay.login = {};
    const { statePath, home, dir } = box();
    await relayCommand(io(), { statePath, home }, ["link", relay.url], {}, deps(dir));
    expect(accountHere(statePath, home)).toEqual({ signedIn: true });
  });
});
