// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OPEN_SHIM_SCRIPT as DAEMON_SHIM_SCRIPT, OPEN_SHIM_PATH as DAEMON_SHIM_PATH, startDaemon, type DaemonHandle } from "@wsp/daemon";
import { BROWSER_SHIM_PATH, type GoldenManifest, type Machine } from "@wsp/engine";
import { createRuntime, memoryStore, type Clock, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_SHIM_PATH, OPEN_SHIM_SCRIPT, type ConnectOptions, type DaemonSocket } from "../src/doctor.js";
import { RELAY_CAP_MS, RELAY_MIN_PORT, RELAY_WINDOW_MS, startCallbackRelay, type CallbackRelay } from "../src/relay.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const execFileAsync = promisify(execFile);
const TOKEN = "relay-token";
const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [{ version: 1, snapshotId: "snap_gold", baseTemplate: "base", setupSha: "x", createdAt: "2026-09-01T00:00:00Z", smoke: { cmd: "true", exitCode: 0 } }],
};
const AUTH = (port: number): string => `https://dash.example.com/oauth2/auth?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A${port}%2Foauth%2Fcallback&state=S`;
const DEVICE = "https://github.com/login/device";

function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void; t: number } {
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock = {
    t: start,
    now: () => clock.t,
    schedule(fn: () => void, ms: number) {
      const entry = { at: clock.t + ms, fn, live: true };
      timers.push(entry);
      return () => {
        entry.live = false;
      };
    },
    advance(ms: number) {
      const until = clock.t + ms;
      for (;;) {
        const due = timers.filter(x => x.live && x.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.t = due.at;
        due.live = false;
        due.fn();
      }
      clock.t = until;
    },
  };
  return clock;
}

interface FakeLink extends DaemonSocket {
  ops: { op: string; extra: Record<string, unknown> }[];
  /** What ports.watch answers as the guest's current listeners. */
  ports: number[];
  /** When set, tunnel.open is refused the way a guest with nothing listening refuses it. */
  refuseTunnels: boolean;
  emit(event: Record<string, unknown>): void;
  drop(): void;
}

/** A daemon socket the test drives: records ops, answers ok, pushes events. */
function fakeConnect(): { connect(o: ConnectOptions): Promise<DaemonSocket>; links: FakeLink[]; targets: string[] } {
  const links: FakeLink[] = [];
  const targets: string[] = [];
  return {
    links,
    targets,
    async connect(o) {
      targets.push(o.url);
      let resolveClosed: (c: number) => void = () => {};
      const closed = new Promise<number>(r => (resolveClosed = r));
      let open = true;
      const link: FakeLink = {
        ops: [],
        ports: [],
        refuseTunnels: false,
        async op(op, extra = {}) {
          link.ops.push({ op, extra });
          if (op === "tunnel.open" && link.refuseTunnels) throw new Error("connect ECONNREFUSED 127.0.0.1");
          if (op === "ports.watch") return { ok: true, ports: link.ports.map(port => ({ port, pid: null, inode: port, uid: 0, loopback: true })) };
          return { ok: true };
        },
        close() {
          open = false;
          resolveClosed(1000);
        },
        closed,
        beats: 0,
        get open() {
          return open;
        },
        emit: event => o.onEvent?.(event),
        drop() {
          open = false;
          resolveClosed(1006);
        },
      };
      links.push(link);
      return link;
    },
  };
}

/** Machines answer as a guest with a daemon: a preview route to `guestUrl` and the token file. */
function relayRuntime(guestUrl: string, goldenRecipe?: GoldenRecipe): { rt: Runtime; backend: StubBackend } {
  const backend = stubBackend();
  backend.execImpl = (_m, cmd) => (cmd.startsWith("cat ") ? { exitCode: 0, stdout: `${TOKEN}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  const create = backend.create.bind(backend);
  backend.create = async spec => {
    const m: Machine = await create(spec);
    m.previewUrl = async () => ({ url: guestUrl, token: "pt", expiresAt: Date.now() + 3_600_000 });
    return m;
  };
  const store = memoryStore();
  void store.put("goldens", "default", GOLDEN);
  return { rt: createRuntime({ backend, store, adapters: {}, ...(goldenRecipe !== undefined ? { goldenRecipe } : {}) }), backend };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 10));
  }
}

function dial(port: number, host = "127.0.0.1"): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = connect({ port, host });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function refused(port: number, host = "127.0.0.1"): Promise<boolean> {
  return dial(port, host).then(
    s => {
      s.destroy();
      return false;
    },
    (e: NodeJS.ErrnoException) => e.code === "ECONNREFUSED",
  );
}

describe("the shim the host ships is the daemon's", () => {
  it("script and BROWSER path match the daemon package byte for byte, and the engine's seal probe reads the same path", () => {
    expect(OPEN_SHIM_SCRIPT).toBe(DAEMON_SHIM_SCRIPT);
    expect(OPEN_SHIM_PATH).toBe(DAEMON_SHIM_PATH);
    expect(BROWSER_SHIM_PATH).toBe(DAEMON_SHIM_PATH);
  });
});

describe("callback relay over a fake daemon link", () => {
  let relay: CallbackRelay | undefined;
  const servers: Server[] = [];
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function setup(o: { window?: number; cap?: number; autoOpen?: boolean; guestPorts?: number[]; jitter?: number; openLine?: (workspace: string, hostname: string) => string } = {}) {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const guestPorts = o.guestPorts ?? [];
    const clock = fakeClock();
    const opened: string[] = [];
    const lines: string[] = [];
    const ws = await rt.workspaces.create({ golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => {
        opened.push(url);
        return true;
      },
      log: l => lines.push(l),
      clock,
      connect: async c => {
        const l = (await fake.connect(c)) as FakeLink;
        l.ports = guestPorts;
        return l;
      },
      ...(o.window !== undefined ? { windowMs: o.window } : {}),
      ...(o.cap !== undefined ? { capMs: o.cap } : {}),
      ...(o.autoOpen ? { autoOpen: () => true } : {}),
      ...(o.openLine !== undefined ? { openLine: o.openLine } : {}),
      jitter: () => o.jitter ?? 0,
    });
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "ports.watch"));
    return { rt, fake, clock, opened, lines, ws, link };
  }

  /** wsp init's shape: one workspace plus the builder the wizard prepared, both linked. */
  async function setupWithBuilder() {
    const { rt } = relayRuntime("http://guest.test", { setup: "true", smoke: "true", cpu: 2, memMb: 4096 });
    const fake = fakeConnect();
    const opened: string[] = [];
    const lines: string[] = [];
    await rt.workspaces.create({ golden: "snap_gold", name: "task-1" });
    const builder = await rt.golden.prepare({ name: "default" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => {
        opened.push(url);
        return true;
      },
      log: l => lines.push(l),
      clock: fakeClock(),
      connect: fake.connect,
      autoOpen: () => true,
      builder,
    });
    return { rt, fake, opened, lines };
  }

  it("by default browser.open opens nothing here: one line says a page is ready, and the port is forwarded at once", async () => {
    const { opened, lines, link, ws } = await setup();
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => lines.length === 1);
    expect(lines).toEqual(["task-1: a sign-in page for github.com is ready; open it from the app"]);
    expect(opened).toEqual([]);
    expect(relay!.forwards()).toEqual([]);
    const port = await freePort();
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port }]);
    expect(opened).toEqual([]);
    // The hostname is in the line by ruling; the path and query (the flow's state) never are.
    expect(lines.join("\n")).not.toMatch(/login\/device|redirect_uri|state=/);
  });

  it("the line logged when nothing opens comes from the openLine hook when one is given", async () => {
    const { lines, link } = await setup({ openLine: (workspace, hostname) => `${workspace}: press o on the link above to open ${hostname} here` });
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => lines.length === 1);
    expect(lines).toEqual(["task-1: press o on the link above to open github.com here"]);
  });

  it("with autoOpen on, browser.open opens the URL on this computer and logs the workspace, never the URL", async () => {
    const { opened, lines, link } = await setup({ autoOpen: true });
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => opened.length === 1);
    expect(opened).toEqual([DEVICE]);
    await until(() => lines.some(l => l.includes("opened a sign-in page")));
    expect(lines).toContain("task-1: opened a sign-in page in your browser");
    expect(lines.join("\n")).not.toContain("github.com");
    expect(relay!.forwards()).toEqual([]);
  });

  it("a URL naming a port forwards it on both loopback families and tunnels bytes both ways", async () => {
    const { opened, lines, link, ws } = await setup({ autoOpen: true });
    const port = await freePort();
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    expect(opened).toEqual([AUTH(port)]);
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port }]);
    expect(lines.find(l => l.includes("forwarding"))).toBe(
      `task-1: forwarding localhost:${port} on this computer to the workspace for the sign-in callback (while the workspace listens, 15 min at most)`,
    );

    const v6 = await dial(port, "::1");
    v6.destroy();
    const c = await dial(port);
    await until(() => link.ops.filter(x => x.op === "tunnel.open").length === 2);
    const opens = link.ops.filter(x => x.op === "tunnel.open");
    expect(opens.at(-1)!.extra).toMatchObject({ port });
    const tunnelId = opens.at(-1)!.extra["tunnelId"] as string;
    c.write("GET /oauth/callback?code=abc HTTP/1.1\r\n\r\n");
    await until(() => link.ops.some(x => x.op === "tunnel.write"));
    const write = link.ops.find(x => x.op === "tunnel.write")!;
    expect(Buffer.from(write.extra["data"] as string, "base64").toString()).toBe("GET /oauth/callback?code=abc HTTP/1.1\r\n\r\n");
    expect(write.extra["tunnelId"]).toBe(tunnelId);

    const got: Buffer[] = [];
    c.on("data", d => got.push(d));
    const ended = new Promise<void>(r => c.once("end", () => r()));
    link.emit({ type: "tunnel.data", tunnelId, data: Buffer.from("HTTP/1.1 200 OK\r\n\r\nsigned in").toString("base64") });
    link.emit({ type: "tunnel.end", tunnelId });
    await ended;
    expect(Buffer.concat(got).toString()).toBe("HTTP/1.1 200 OK\r\n\r\nsigned in");
    await until(() => link.ops.some(x => x.op === "tunnel.close" && x.extra["tunnelId"] === tunnelId));
    // The URL stays out of every line.
    expect(lines.join("\n")).not.toContain("dash.example.com");
  });

  it("callback.port after a portless open forwards that port", async () => {
    const { link, ws } = await setup();
    const port = await freePort();
    link.emit({ type: "browser.open", url: DEVICE });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()).toMatchObject([{ targetId: ws.id, port }]);
  });

  it("opens nothing and forwards nothing for a URL that is not http(s), with one line each", async () => {
    const { opened, lines, link } = await setup({ autoOpen: true });
    const port = await freePort();
    const bad = ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "\\\\host\\share"];
    for (const url of bad) link.emit({ type: "browser.open", url, port });
    await until(() => lines.length === bad.length);
    expect(lines).toEqual(bad.map(() => "task-1: ignored a sign-in page that is not an http(s) link"));
    expect(opened).toEqual([]);
    expect(relay!.forwards()).toEqual([]);
    expect(await refused(port)).toBe(true);
    link.emit({ type: "browser.open", url: "HTTPS://GITHUB.COM/LOGIN/DEVICE" });
    await until(() => opened.length === 1);
    expect(opened).toEqual(["HTTPS://GITHUB.COM/LOGIN/DEVICE"]);
  });

  it("browser.open and callback.port for the same port in one tick make one forward and no false refusal", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "browser.open", url: AUTH(port), port });
    link.emit({ type: "callback.port", port });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    await new Promise(r => setTimeout(r, 100));
    expect(lines.filter(l => l.includes("forwarding localhost")).length).toBe(1);
    expect(lines.some(l => l.includes("already in use"))).toBe(false);
    expect(relay!.forwards().length).toBe(1);
  });

  it("a callback the workspace refuses gets a 502 with one sentence, and one line without the URL", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.refuseTunnels = true;
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    const res = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=abc`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(`The sign-in callback reached this computer, but nothing on workspace task-1 answered on port ${port}.\n`);
    await until(() => lines.some(l => l.includes("nothing on the workspace answered")));
    expect(lines).toContain(`task-1: the sign-in callback on port ${port} reached this computer but nothing on the workspace answered`);
    expect(lines.join("\n")).not.toMatch(/redirect_uri|state=|oauth2/);
  });

  it("a port outside 1024..65535 or not an integer is refused with one line and never ends the process", async () => {
    const { lines, link } = await setup();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      for (const port of [70000, 65536, 1.5, -1, 0]) link.emit({ type: "callback.port", port });
      link.emit({ type: "browser.open", url: AUTH(70000), port: 70000 });
      await new Promise(r => setTimeout(r, 200));
      expect(rejections).toEqual([]);
      expect(relay!.forwards()).toEqual([]);
      expect(lines).toEqual([
        ...[70000, 65536, 1.5, -1, 0].map(() => "task-1: ignored a malformed callback.port event from the workspace"),
        "task-1: ignored a malformed browser.open event from the workspace",
      ]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    link.emit({ type: "callback.port", port: 8976 });
    await until(() => relay!.forwards().length === 1 || lines.some(l => l.includes("8976")));
  });

  it("a newcomer this computer cannot bind leaves the working forward alone", async () => {
    const { lines, link } = await setup();
    const a = await freePort();
    link.emit({ type: "callback.port", port: a });
    await until(() => relay!.forwards().length === 1);
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>(r => taken.listen(0, "127.0.0.1", r));
    const b = (taken.address() as { port: number }).port;
    link.emit({ type: "callback.port", port: b });
    await until(() => lines.some(l => l.includes(`port ${b} is already in use`)));
    expect(relay!.forwards()).toMatchObject([{ port: a }]);
    const c = await dial(a);
    await until(() => link.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === a));
    c.destroy();
    expect(lines.some(l => l.includes(`stopped forwarding localhost:${a}`))).toBe(false);
  });

  it("a link replaced while a bind is in flight leaves no stale entry: the next event for that port forwards it", async () => {
    const { fake, clock, link } = await setup();
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    link.drop();
    await new Promise(r => setTimeout(r, 100));
    expect(relay!.forwards()).toEqual([]);
    expect(await refused(port)).toBe(true);
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    await until(() => fake.links[1]!.ops.some(x => x.op === "ports.watch"));
    fake.links[1]!.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
  });

  it("a URL with whitespace, a control character or over the length cap is refused on the host, not only in the guest", async () => {
    const { opened, lines, link } = await setup({ autoOpen: true });
    const bad = ["https://x.test/a b", "https://x.test/a\nb", `https://x.test/${"a".repeat(9000)}`];
    for (const url of bad) link.emit({ type: "browser.open", url });
    await until(() => lines.length === bad.length);
    expect(lines).toEqual(bad.map(() => "task-1: ignored a sign-in page that is not an http(s) link"));
    expect(opened).toEqual([]);
  });

  it("a URL that matches the scheme rule but does not parse is ignored with one line, and nothing throws", async () => {
    const { opened, lines, link } = await setup();
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onRejection);
    try {
      for (const url of ["https://%", "https://[::1", "https://exa%mple.com/x"]) link.emit({ type: "browser.open", url });
      await until(() => lines.length === 3);
      expect(lines).toEqual(Array(3).fill("task-1: ignored a sign-in page that is not an http(s) link"));
      expect(opened).toEqual([]);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onRejection);
    }
  });

  it("refuses ports below 1024 and ports this computer already uses, each with one clear line", async () => {
    const { lines, link } = await setup();
    link.emit({ type: "callback.port", port: 80 });
    await until(() => lines.some(l => l.includes("malformed")));
    expect(lines).toContain("task-1: ignored a malformed callback.port event from the workspace");
    expect(RELAY_MIN_PORT).toBe(1024);

    const taken = createServer();
    servers.push(taken);
    await new Promise<void>(r => taken.listen(0, "::1", r));
    const port = (taken.address() as { port: number }).port;
    link.emit({ type: "callback.port", port });
    await until(() => lines.some(l => l.includes("already in use")));
    expect(lines).toContain(`task-1: port ${port} is already in use on this computer; the sign-in callback is not forwarded`);
    expect(relay!.forwards()).toEqual([]);
    expect(await refused(port, "127.0.0.1")).toBe(true);
  });

  it("with no guest listener seen, a forward closes at the floor, traffic or not", async () => {
    const { clock, lines, link } = await setup({ window: 1_000, cap: 3_000 });
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()[0]).toMatchObject({ listener: false, expiresAt: clock.t + 1_000 });
    clock.advance(900);
    const c = await dial(port);
    await until(() => link.ops.some(x => x.op === "tunnel.open"));
    c.destroy();
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 100);
    clock.advance(99);
    expect(relay!.forwards().length).toBe(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (no listener on the workspace within 0 min)`);
    expect(await refused(port)).toBe(true);
  });

  it("a forward whose port the guest listens on stays open past the floor and ends when that listener closes", async () => {
    const port = await freePort();
    const { clock, lines, link } = await setup({ window: 1_000, cap: 3_000, guestPorts: [port] });
    link.emit({ type: "browser.open", url: AUTH(port), port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()[0]).toMatchObject({ listener: true, expiresAt: clock.t + 3_000 });
    clock.advance(2_000);
    expect(relay!.forwards().length).toBe(1);
    link.emit({ type: "port.close", port: port + 1 });
    await new Promise(r => setTimeout(r, 20));
    expect(relay!.forwards().length).toBe(1);
    link.emit({ type: "port.close", port });
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (the workspace stopped listening)`);
    expect(await refused(port)).toBe(true);
  });

  it("a listener that appears after the forward keeps it open, and nothing outlives the cap", async () => {
    const { clock, lines, link } = await setup({ window: 1_000, cap: 3_000 });
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    clock.advance(500);
    link.emit({ type: "port.open", port, loopback: true });
    await until(() => relay!.forwards()[0]?.listener === true);
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t - 500 + 3_000);
    clock.advance(2_499);
    expect(relay!.forwards().length).toBe(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (open for 0 min, the cap)`);
  });

  it("keeps one forward per workspace: a new port replaces the old, the same port is one forward", async () => {
    const { clock, lines, link } = await setup();
    const a = await freePort();
    const b = await freePort();
    link.emit({ type: "callback.port", port: a });
    await until(() => relay!.forwards().length === 1);
    clock.advance(60_000);
    link.emit({ type: "callback.port", port: a });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toMatchObject([{ port: a, expiresAt: clock.t - 60_000 + RELAY_WINDOW_MS }]);
    expect(lines.filter(l => l.includes("forwarding localhost")).length).toBe(1);
    link.emit({ type: "callback.port", port: b });
    await until(() => relay!.forwards()[0]?.port === b);
    expect(relay!.forwards().length).toBe(1);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${a} (port ${b} replaces it)`);
    expect(await refused(a)).toBe(true);
    expect(RELAY_CAP_MS).toBe(15 * 60_000);
  });

  it("redials with a random fraction added to the wait, so links do not come back in lockstep", async () => {
    const { fake, clock, link } = await setup({ jitter: 1 });
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await new Promise(r => setTimeout(r, 50));
    expect(fake.links.length).toBe(1);
    clock.advance(1_000);
    await until(() => fake.links.length === 2);
  });

  it("a dropped link closes the forward and redials; a napped workspace loses its link, a deleted one for good", async () => {
    const { rt, fake, clock, lines, link, ws } = await setup();
    const port = await freePort();
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    link.drop();
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (the daemon link dropped)`);
    expect(await refused(port)).toBe(true);
    clock.advance(2_000);
    await until(() => fake.links.length === 2);

    await rt.workspaces.nap(ws.id);
    await until(() => !fake.links[1]!.open);
    clock.advance(10_000);
    expect(fake.links.length).toBe(2);
    await rt.workspaces.delete(ws.id);
    clock.advance(10_000);
    expect(fake.links.length).toBe(2);
  });

  it("dials the init builder through its own reach and names it", async () => {
    const { rt, fake, opened, lines } = await setupWithBuilder();
    const builder = (await rt.golden.builders())[0]!;
    await until(() => fake.links.length === 2);
    expect(fake.targets).toEqual(["http://guest.test", "http://guest.test"]);
    // The two links dial in parallel, so each gets the event and the lines name both.
    for (const l of fake.links) l.emit({ type: "browser.open", url: DEVICE });
    await until(() => opened.length === 2);
    await until(() => lines.filter(l => l.includes("opened a sign-in page")).length === 2);
    expect(lines).toContain(`${builder.name} (builder): opened a sign-in page in your browser`);
    expect(lines).toContain("task-1: opened a sign-in page in your browser");
  });

  it("does nothing on a backend without the callbackRelay capability", async () => {
    const backend = stubBackend();
    const rt = createRuntime({ backend: { ...backend, capabilities: { ...backend.capabilities, callbackRelay: false } }, store: memoryStore(), adapters: {} });
    const fake = fakeConnect();
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, connect: fake.connect, clock: fakeClock() });
    await new Promise(r => setTimeout(r, 50));
    expect(fake.links).toEqual([]);
    expect(relay.forwards()).toEqual([]);
  });
});

describe("callback relay end to end through a real daemon", () => {
  let daemon: DaemonHandle | undefined;
  let relay: CallbackRelay | undefined;
  let guest: Server | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await relay?.close();
    await daemon?.close();
    await new Promise<void>(r => (guest ? guest.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
    relay = daemon = guest = dir = undefined;
  });

  it("shim post in the guest opens on the laptop and the callback rides the tunnel back to the guest listener", { timeout: 15_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-relay-e2e-"));
    const sockPath = join(dir, "open.sock");
    daemon = await startDaemon({ host: "127.0.0.1", port: 0, token: TOKEN, openSocketPath: sockPath, portsSource: async () => [] });
    const { rt } = relayRuntime(`http://127.0.0.1:${daemon.port}/?pt_token=ignored`);
    await rt.workspaces.create({ golden: "snap_gold", name: "task-1" });

    // Guest and laptop share this machine's loopback, so the guest tool takes 127.0.0.1 (where the daemon dials first) and the laptop side [::1].
    const seen: string[] = [];
    guest = createServer(s => {
      s.on("data", d => {
        seen.push(d.toString());
        s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
      });
    });
    await new Promise<void>(r => guest!.listen(0, "127.0.0.1", r));
    const port = (guest.address() as { port: number }).port;

    const opened: string[] = [];
    const lines: string[] = [];
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => {
        opened.push(url);
        return true;
      },
      log: l => lines.push(l),
      autoOpen: () => true,
      listenHosts: ["::1"],
    });
    const script = join(dir, "wsp-open");
    writeFileSync(script, OPEN_SHIM_SCRIPT.replace("/root/.wsp/open.sock", sockPath));
    chmodSync(script, 0o755);
    const url = AUTH(port);
    // The link dials in the background; a post before it is up reaches no socket, so post until one lands.
    for (let i = 0; i < 50 && opened.length === 0; i++) {
      await execFileAsync("sh", [script, url]);
      await new Promise(r => setTimeout(r, 100));
    }
    expect(opened[0]).toBe(url);
    await until(() => relay!.forwards().length === 1, 5000);

    const res = await fetch(`http://[::1]:${port}/oauth/callback?code=abc&state=S`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(seen.join("")).toContain("GET /oauth/callback?code=abc&state=S HTTP/1.1");
    expect(lines.join("\n")).not.toContain("dash.example.com");

    // A URL the daemon's own socket lets through but that does not parse must not bring the host down.
    const thrown: unknown[] = [];
    const onThrow = (e: unknown) => thrown.push(e);
    process.on("uncaughtException", onThrow);
    try {
      const before = lines.length;
      const status = (await execFileAsync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--unix-socket", sockPath, "-X", "POST", "--data-binary", "https://%", "http://wsp/open"])).stdout;
      expect(status).toBe("400");
      await new Promise(r => setTimeout(r, 200));
      expect(thrown).toEqual([]);
      expect(lines.slice(before)).toEqual([]);
    } finally {
      process.off("uncaughtException", onThrow);
    }
  });
});
