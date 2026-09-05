// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { OPEN_SHIM_SCRIPT as DAEMON_SHIM_SCRIPT, OPEN_SHIM_PATH as DAEMON_SHIM_PATH, startDaemon, type DaemonHandle } from "@wsp/daemon";
import { BROWSER_SHIM_PATH, type GoldenManifest, type Machine } from "@wsp/engine";
import type { ForwardEvent } from "@wsp/protocol";
import { DAEMON_TOKEN_SET, createRuntime, memoryStore, type Clock, type GoldenRecipe, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { OPEN_SHIM_PATH, OPEN_SHIM_SCRIPT, connectDaemonSocket, type ConnectOptions, type DaemonSocket } from "../src/doctor.js";
import { FORWARD_IDLE_MS, FORWARD_MAX_PER_TARGET, RELAY_CAP_MS, RELAY_MIN_PORT, RELAY_WINDOW_MS, startCallbackRelay, type CallbackRelay } from "../src/relay.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const execFileAsync = promisify(execFile);
const TOKEN = "0123456789abcdef".repeat(2);
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
  backend.execImpl = (_m, cmd) => (cmd.includes("/root/.wsp-daemon-token") ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
  const create = backend.create.bind(backend);
  backend.create = async spec => {
    const m: Machine = await create(spec);
    m.previewUrl = async () => ({ url: guestUrl, token: "pt", expiresAt: Date.now() + 3_600_000 });
    return m;
  };
  const store = memoryStore();
  void store.put("goldens", "default", GOLDEN);
  // A wake pings the daemon through the preview route; nothing answers on guest.test, so the wait is kept short.
  return { rt: createRuntime({ backend, store, adapters: {}, wake: { pingTimeoutMs: 100 }, daemonToken: TOKEN, ...(goldenRecipe !== undefined ? { goldenRecipe } : {}) }), backend };
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

  async function setup(o: { window?: number; cap?: number; autoOpen?: boolean; guestPorts?: number[]; jitter?: number; openLine?: (workspace: string, hostname: string, url: string) => string } = {}) {
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

  it("the line logged when nothing opens comes from the openLine hook when one is given, told the page's URL too", async () => {
    const urls: string[] = [];
    const { lines, link } = await setup({ openLine: (workspace, hostname, url) => (urls.push(url), `${workspace}: press o on the link above to open ${hostname} here`) });
    link.emit({ type: "browser.open", url: DEVICE });
    await until(() => lines.length === 1);
    expect(lines).toEqual(["task-1: press o on the link above to open github.com here"]);
    expect(urls).toEqual([DEVICE]);
  });

  it("autoOpen is asked with the target and the page's URL, so a caller can decline one it already opened", async () => {
    const asked: [string, string][] = [];
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const opened: string[] = [];
    const ws = await rt.workspaces.create({ golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async url => (opened.push(url), true),
      log: () => {},
      clock: fakeClock(),
      connect: fake.connect,
      autoOpen: (id, url) => (asked.push([id, url]), url !== DEVICE),
      jitter: () => 0,
    });
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "ports.watch"));
    link.emit({ type: "browser.open", url: DEVICE });
    link.emit({ type: "browser.open", url: "https://auth.example.com/device" });
    await until(() => opened.length === 1);
    expect(asked).toEqual([[ws.id, DEVICE], [ws.id, "https://auth.example.com/device"]]);
    expect(opened).toEqual(["https://auth.example.com/device"]);
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

  it("a dropped link keeps the callback forward: no close, the row stays, and the next callback rides the new link", async () => {
    const port = await freePort();
    const { fake, clock, lines, link } = await setup({ guestPorts: [port] });
    const events: ForwardEvent[] = [];
    relay!.on(e => events.push(e));
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    const before = relay!.forwards()[0]!;
    expect(before.listener).toBe(true);
    clock.advance(3_000);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toEqual([before]);
    expect(lines.some(l => l.includes("stopped forwarding"))).toBe(false);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => lines.some(l => l.includes("the daemon link is back")));
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${port} still forwarded`]);
    expect(relay!.forwards()).toEqual([before]);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);
    expect(events.filter(e => e.type === "forward.open")).toHaveLength(1);
    const c = await dial(port);
    await until(() => second.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === port));
    expect(link.ops.filter(x => x.op === "tunnel.open")).toEqual([]);
    c.destroy();
  });

  it("a redial that finds the callback port no longer listening closes the forward saying so, and the row leaves", async () => {
    const port = await freePort();
    const guestPorts = [port];
    const { fake, clock, lines, link } = await setup({ guestPorts });
    const events: ForwardEvent[] = [];
    relay!.on(e => events.push(e));
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards()[0]?.listener === true);
    guestPorts.splice(0);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (the workspace stopped listening while the daemon link was down)`);
    expect(events.filter(e => e.type === "forward.close").map(e => e.port)).toEqual([port]);
    expect(lines.some(l => l.includes("the daemon link is back"))).toBe(false);
    expect(await refused(port)).toBe(true);
  });

  it("a listener that appears while the link is down is spotted at the redial and keys the window on itself", async () => {
    const port = await freePort();
    const guestPorts: number[] = [];
    const { fake, clock, link } = await setup({ guestPorts, window: 60_000, cap: 600_000 });
    link.emit({ type: "callback.port", port });
    await until(() => relay!.forwards().length === 1);
    const before = relay!.forwards()[0]!;
    expect(before.listener).toBe(false);
    guestPorts.push(port);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    await until(() => relay!.forwards()[0]?.listener === true);
    expect(relay!.forwards()[0]!.expiresAt).toBe(before.expiresAt - 60_000 + 600_000);
  });

  it("a napped workspace loses its link and the redial stops; a deleted one for good", async () => {
    const { rt, fake, clock, link, ws } = await setup();
    link.drop();
    await new Promise(r => setTimeout(r, 50));
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

describe("localhost forwards over a fake daemon link", () => {
  let relay: CallbackRelay | undefined;
  const servers: Server[] = [];
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r()));
  });

  async function setup(o: { idle?: number; guestPorts?: number[] } = {}) {
    const { rt } = relayRuntime("http://guest.test");
    const fake = fakeConnect();
    const clock = fakeClock();
    const lines: string[] = [];
    const events: ForwardEvent[] = [];
    /** What every link's ports.watch answers; a test mutates it before a redial or a wake. */
    const guestPorts = o.guestPorts ?? [];
    const ws = await rt.workspaces.create({ golden: "snap_gold", name: "task-1" });
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async () => true,
      log: l => lines.push(l),
      clock,
      connect: async c => {
        const l = (await fake.connect(c)) as FakeLink;
        l.ports = guestPorts;
        return l;
      },
      ...(o.idle !== undefined ? { idleMs: o.idle } : {}),
      jitter: () => 0,
    });
    relay.on(e => events.push(e));
    await until(() => fake.links.length >= 1);
    const link = fake.links[0]!;
    await until(() => link.ops.some(x => x.op === "ports.watch"));
    return { rt, fake, clock, lines, events, ws, link, guestPorts };
  }

  it("the default idle window is ten minutes", () => {
    expect(FORWARD_IDLE_MS).toBe(10 * 60_000);
  });

  it("localhost.url forwards its port, one per port per workspace, and the app hears each one open", async () => {
    const { lines, events, link, ws, clock } = await setup();
    const a = await freePort();
    const b = await freePort();
    link.emit({ type: "localhost.url", port: a });
    link.emit({ type: "localhost.url", port: b });
    await until(() => relay!.forwards().length === 2);
    expect(relay!.forwards().map(f => ({ port: f.port, kind: f.kind })).sort((x, y) => x.port - y.port)).toEqual([{ port: a, kind: "url" }, { port: b, kind: "url" }].sort((x, y) => x.port - y.port));
    expect(relay!.list()).toEqual(expect.arrayContaining([
      { workspaceId: ws.id, port: a, startedAt: new Date(clock.t).toISOString(), name: "task-1", kind: "url" },
      { workspaceId: ws.id, port: b, startedAt: new Date(clock.t).toISOString(), name: "task-1", kind: "url" },
    ]));
    expect(events.map(e => e.type)).toEqual(["forward.open", "forward.open"]);
    expect(lines).toContain(`task-1: forwarding localhost:${a} on this computer to the workspace (closes after 10 min without traffic)`);

    // The same port again is the same forward: no second bind, no second line, no second event.
    link.emit({ type: "localhost.url", port: a });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toHaveLength(2);
    expect(lines.filter(l => l.includes(`localhost:${a}`))).toHaveLength(1);
    expect(events).toHaveLength(2);

    // Both families listen, and a connection rides the tunnel to the guest.
    const c = await dial(a, "::1");
    await until(() => link.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === a));
    c.destroy();
  });

  it("traffic keeps a url forward alive; the idle window without any closes it and frees the port", async () => {
    const { clock, lines, events, link, ws } = await setup({ idle: 1_000 });
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()[0]).toMatchObject({ kind: "url", expiresAt: clock.t + 1_000 });

    // A connection at 500 ms moves the close to 1500 ms.
    clock.advance(500);
    const c = await dial(port);
    await until(() => link.ops.some(x => x.op === "tunnel.open"));
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 1_000);

    // Bytes from this computer at 900 ms move it to 1900 ms.
    clock.advance(400);
    c.write("GET / HTTP/1.1\r\n\r\n");
    await until(() => link.ops.some(x => x.op === "tunnel.write"));
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 1_000);

    // Bytes from the guest at 1300 ms move it to 2300 ms.
    clock.advance(400);
    const tunnelId = link.ops.find(x => x.op === "tunnel.open")!.extra["tunnelId"] as string;
    link.emit({ type: "tunnel.data", tunnelId, data: Buffer.from("hi").toString("base64") });
    expect(relay!.forwards()[0]!.expiresAt).toBe(clock.t + 1_000);
    c.destroy();
    clock.advance(999);
    expect(relay!.forwards()).toHaveLength(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (no traffic for 0 min)`);
    expect(events.at(-1)).toEqual({ type: "forward.close", workspaceId: ws.id, port });
    expect(await refused(port)).toBe(true);
  });

  it("no cap: a url forward with traffic outlives the callback cap", async () => {
    const { clock, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    for (let i = 0; i < 4; i++) {
      clock.advance(FORWARD_IDLE_MS - 60_000);
      const c = await dial(port);
      await until(() => link.ops.filter(x => x.op === "tunnel.open").length === i + 1);
      c.destroy();
    }
    expect(clock.t - 1_000_000).toBeGreaterThan(RELAY_CAP_MS);
    expect(relay!.forwards()).toHaveLength(1);
  });

  it("a port this computer already uses is refused with one line, no forward and no event; nothing ends the process", async () => {
    const { lines, events, link } = await setup();
    const held = createServer();
    servers.push(held);
    await new Promise<void>(r => held.listen(0, "127.0.0.1", r));
    const port = (held.address() as { port: number }).port;
    const rejections: unknown[] = [];
    const onReject = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onReject);
    try {
      link.emit({ type: "localhost.url", port });
      await until(() => lines.length === 1);
      expect(lines).toEqual([`task-1: port ${port} is already in use on this computer; localhost:${port} here will not reach the workspace`]);
      for (const bad of [80, 1023, 65536, 70000, 1.5, -1, "8123"]) link.emit({ type: "localhost.url", port: bad });
      await until(() => lines.length === 8);
      expect(lines.slice(1)).toEqual(Array(7).fill("task-1: ignored a malformed localhost.url event from the workspace"));
      await new Promise(r => setTimeout(r, 50));
      expect(rejections).toEqual([]);
      expect(relay!.forwards()).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      process.off("unhandledRejection", onReject);
    }
  });

  it("a connection to a forwarded port nothing on the guest answers gets a 502 that names the forward, and one line without a URL", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    link.refuseTunnels = true;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe(`localhost:${port} on this computer is forwarded to workspace task-1, but nothing there answered on port ${port}.\n`);
    await until(() => lines.length === 2);
    expect(lines[1]).toBe(`task-1: a connection to localhost:${port} here reached the workspace but nothing there answered on port ${port}`);
    expect(lines.join("\n")).not.toContain("http://");
  });

  it("at most 16 url forwards per workspace: the next port is refused with one line until one is stopped", async () => {
    const { lines, link, ws } = await setup();
    const ports: number[] = [];
    for (let i = 0; i < FORWARD_MAX_PER_TARGET + 1; i++) ports.push(await freePort());
    for (const port of ports) link.emit({ type: "localhost.url", port });
    await until(() => lines.length === FORWARD_MAX_PER_TARGET + 1, 5000);
    expect(relay!.forwards()).toHaveLength(FORWARD_MAX_PER_TARGET);
    const refusal = lines.find(l => l.includes("stop one first"))!;
    expect(refusal).toMatch(/^task-1: not forwarding localhost:\d+; 16 ports are already forwarded for this workspace, stop one first$/);
    const refusedPort = Number(refusal.match(/localhost:(\d+)/)![1]);
    expect(relay!.forwards().some(f => f.port === refusedPort)).toBe(false);
    // Stopping one makes room.
    expect(relay!.stop(ws.id, ports.find(p => p !== refusedPort)!)).toBe(true);
    link.emit({ type: "localhost.url", port: refusedPort });
    await until(() => relay!.forwards().some(f => f.port === refusedPort));
    expect(relay!.forwards()).toHaveLength(FORWARD_MAX_PER_TARGET);
  });

  it("stop from the app closes the forward and frees the port; a second stop is false", async () => {
    const { lines, events, link, ws } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    expect(relay!.stop(ws.id, port)).toBe(true);
    expect(relay!.forwards()).toEqual([]);
    expect(relay!.list()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (stopped from the app)`);
    expect(events.at(-1)).toEqual({ type: "forward.close", workspaceId: ws.id, port });
    expect(await refused(port)).toBe(true);
    expect(relay!.stop(ws.id, port)).toBe(false);
    expect(relay!.stop("nobody", port)).toBe(false);
  });

  it("a port the callback forward already holds is not forwarded twice; a link drop keeps both kinds in their order and one line names them", async () => {
    const { fake, clock, lines, events, link } = await setup();
    const p = await freePort();
    const q = await freePort();
    link.emit({ type: "callback.port", port: p });
    await until(() => relay!.forwards().length === 1);
    link.emit({ type: "localhost.url", port: p });
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards().map(f => f.kind)).toEqual(["callback"]);
    expect(lines.some(l => l.includes("already in use"))).toBe(false);
    // The app sees the callback forward too, told apart by its kind: a port on this computer the person can stop.
    expect(relay!.list()).toMatchObject([{ port: p, kind: "callback" }]);

    link.emit({ type: "localhost.url", port: q });
    await until(() => relay!.forwards().length === 2);
    const before = relay!.forwards();
    expect(before.map(f => f.port)).toEqual([p, q]);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toEqual(before);
    clock.advance(2_000);
    await until(() => fake.links.length === 2 && lines.some(l => l.includes("the daemon link is back")));
    expect(relay!.forwards()).toEqual(before);
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${p}, localhost:${q} still forwarded`]);
    expect(lines.some(l => l.includes("stopped forwarding"))).toBe(false);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);
    expect(await refused(p)).toBe(false);
    expect(await refused(q)).toBe(false);
  });

  it("a link drop keeps a url forward bound with its idle clock running; a connection meanwhile gets the 502; the redial plumbs it through the new link with one line", async () => {
    const { fake, clock, lines, events, link } = await setup({ idle: 10_000 });
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    const expiresAt = relay!.forwards()[0]!.expiresAt;
    clock.advance(3_000);
    link.drop();
    await new Promise(r => setTimeout(r, 50));
    expect(relay!.forwards()).toMatchObject([{ port, kind: "url", expiresAt }]);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);

    // A tab left open pings once a second: one line for the stretch, not one per connection.
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(502);
      expect(await res.text()).toContain(`localhost:${port} on this computer is forwarded to workspace task-1`);
    }
    expect(lines.filter(l => l.includes("found the workspace unreachable"))).toEqual([`task-1: a connection to localhost:${port} here found the workspace unreachable`]);

    clock.advance(2_000);
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => lines.some(l => l.includes("the daemon link is back")));
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${port} still forwarded`]);
    expect(relay!.forwards()[0]!.expiresAt).toBe(expiresAt);
    expect(events.filter(e => e.type === "forward.open")).toHaveLength(1);
    const c = await dial(port);
    await until(() => second.ops.some(x => x.op === "tunnel.open" && x.extra["port"] === port));
    c.destroy();

    // A second stretch gets its own line.
    second.drop();
    await new Promise(r => setTimeout(r, 50));
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect(lines.filter(l => l.includes("found the workspace unreachable"))).toHaveLength(2);
  });

  it("a connection that resets with the 502 unread, while the workspace refuses the tunnel and then while it is unreachable, does not end the host", async () => {
    const { link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    const thrown: unknown[] = [];
    const onThrow = (e: unknown) => thrown.push(e);
    process.on("uncaughtException", onThrow);
    process.on("unhandledRejection", onThrow);
    // Write a request and answer the reply with a reset instead of reading it, as a browser closing a keep-alive socket does.
    const slam = async (): Promise<void> => {
      const c = await dial(port);
      c.setNoDelay(true);
      c.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await new Promise(r => setImmediate(r));
      c.resetAndDestroy();
      await new Promise(r => setTimeout(r, 60));
    };
    try {
      // Refusing: the link is up and the guest rejects tunnel.open, so plumb ends the socket with the 502.
      link.refuseTunnels = true;
      for (let i = 0; i < 5; i++) await slam();
      await until(() => link.ops.filter(x => x.op === "tunnel.open").length === 5);
      expect(thrown).toEqual([]);
      // Unreachable: no link at all, so onConn ends the socket with the 502.
      link.drop();
      await new Promise(r => setTimeout(r, 50));
      for (let i = 0; i < 5; i++) await slam();
      expect(thrown).toEqual([]);
    } finally {
      process.off("uncaughtException", onThrow);
      process.off("unhandledRejection", onThrow);
    }
    expect(relay!.forwards()).toHaveLength(1);
  });

  it("a stretch where nothing on the guest answers logs one line, and a connection that gets through starts a new stretch", async () => {
    const { lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    link.refuseTunnels = true;
    for (let i = 0; i < 3; i++) expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    const line = `task-1: a connection to localhost:${port} here reached the workspace but nothing there answered on port ${port}`;
    expect(lines.filter(l => l === line)).toHaveLength(1);
    link.refuseTunnels = false;
    const c = await dial(port);
    await until(() => link.ops.filter(x => x.op === "tunnel.open").length === 4);
    c.destroy();
    link.refuseTunnels = true;
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(502);
    expect(lines.filter(l => l === line)).toHaveLength(2);
  });

  it("a nap pauses the idle clock and keeps the row; the wake resumes it, closes a port the workspace no longer listens on, and says so in one line per link", async () => {
    const { rt, fake, clock, lines, events, ws, link, guestPorts } = await setup({ idle: 10_000 });
    const a = await freePort();
    const b = await freePort();
    link.emit({ type: "localhost.url", port: a });
    link.emit({ type: "localhost.url", port: b });
    await until(() => relay!.forwards().length === 2);
    clock.advance(4_000);
    await rt.workspaces.nap(ws.id);
    await until(() => !link.open);
    // Napping: nothing closes, nothing expires, a click here gets the 502 that names the workspace.
    clock.advance(60_000);
    expect(relay!.forwards()).toHaveLength(2);
    expect(events.filter(e => e.type === "forward.close")).toEqual([]);
    const napped = await fetch(`http://127.0.0.1:${a}/`);
    expect(napped.status).toBe(502);

    // The machine kept a; b is gone.
    guestPorts.push(a);
    await rt.workspaces.wake(ws.id);
    await until(() => fake.links.length === 2);
    await until(() => relay!.forwards().length === 1);
    expect(relay!.forwards()).toMatchObject([{ port: a, kind: "url", expiresAt: clock.t + 6_000 }]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${b} (not listening on the workspace after the wake)`);
    // A connection during the nap logged once; a connection after the wake goes through and a later stretch logs again.
    expect(lines.filter(l => l.includes("found the workspace unreachable"))).toEqual([`task-1: a connection to localhost:${a} here found the workspace unreachable`]);
    expect(lines.filter(l => l.includes("awake again"))).toEqual([`task-1: awake again; localhost:${a} still forwarded`]);
    expect(events.filter(e => e.type === "forward.close").map(e => e.port)).toEqual([b]);
    expect(events.filter(e => e.type === "forward.open")).toHaveLength(2);
    expect(await refused(b)).toBe(true);
    // The clock resumes with the 6 s it had left, not a fresh window.
    clock.advance(5_999);
    expect(relay!.forwards()).toHaveLength(1);
    clock.advance(1);
    expect(relay!.forwards()).toEqual([]);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${a} (no traffic for 0 min)`);
  });

  it("a nap closes a callback forward saying the workspace napped; a delete closes a url forward for good", async () => {
    const { rt, fake, lines, ws, link, guestPorts } = await setup();
    const p = await freePort();
    const q = await freePort();
    link.emit({ type: "callback.port", port: p });
    link.emit({ type: "localhost.url", port: q });
    await until(() => relay!.forwards().length === 2);
    await rt.workspaces.nap(ws.id);
    await until(() => relay!.forwards().length === 1);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${p} (the workspace napped)`);
    guestPorts.push(q);
    await rt.workspaces.wake(ws.id);
    await until(() => fake.links.length === 2 && lines.some(l => l.includes("awake again")));
    expect(relay!.forwards()).toMatchObject([{ port: q, kind: "url" }]);
    await rt.workspaces.delete(ws.id);
    await until(() => relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${q} (the workspace was deleted)`);
    expect(await refused(q)).toBe(true);
  });

  it("after the workspace moves to a new machine, a url forward whose port the new machine does not serve closes saying so", async () => {
    const { rt, fake, lines, ws, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    await rt.workspaces.upgrade(ws.id, { cpu: 4 });
    await until(() => fake.links.length === 2 && relay!.forwards().length === 0);
    expect(lines).toContain(`task-1: stopped forwarding localhost:${port} (not listening on the workspace after it moved to a new machine)`);
    expect(await refused(port)).toBe(true);
  });

  it("a callback bind in flight does not count toward the url cap", async () => {
    const { link } = await setup();
    const ports: number[] = [];
    for (let i = 0; i < FORWARD_MAX_PER_TARGET - 1; i++) ports.push(await freePort());
    for (const port of ports) link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === FORWARD_MAX_PER_TARGET - 1);
    const x = await freePort();
    const y = await freePort();
    link.emit({ type: "callback.port", port: x });
    link.emit({ type: "localhost.url", port: y });
    await until(() => relay!.forwards().length === FORWARD_MAX_PER_TARGET + 1);
    expect(relay!.forwards().filter(f => f.kind === "url")).toHaveLength(FORWARD_MAX_PER_TARGET);
    expect(relay!.forwards().find(f => f.port === x)?.kind).toBe("callback");
  });

  it("two workspaces asking for the same laptop port: the second is refused as in use, the first keeps it", async () => {
    const { rt, fake, lines, link } = await setup();
    const port = await freePort();
    link.emit({ type: "localhost.url", port });
    await until(() => relay!.forwards().length === 1);
    await rt.workspaces.create({ golden: "snap_gold", name: "task-2" });
    await until(() => fake.links.length === 2);
    const second = fake.links[1]!;
    await until(() => second.ops.some(x => x.op === "ports.watch"));
    second.emit({ type: "localhost.url", port });
    await until(() => lines.some(l => l.startsWith("task-2:")));
    expect(lines.filter(l => l.startsWith("task-2:"))).toEqual([`task-2: port ${port} is already in use on this computer; localhost:${port} here will not reach the workspace`]);
    expect(relay!.forwards()).toHaveLength(1);
    const c = await dial(port);
    await until(() => link.ops.some(x => x.op === "tunnel.open"));
    c.destroy();
  });
});

describe("localhost forwards end to end through a real daemon", () => {
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

  it("a URL printed in a workspace pty forwards its port; a request here reaches the guest listener; stop closes it", { timeout: 15_000 }, async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-forward-e2e-"));
    daemon = await startDaemon({ host: "127.0.0.1", port: 0, token: TOKEN, openSocketPath: join(dir, "open.sock"), portsSource: async () => [] });
    const { rt } = relayRuntime(`http://127.0.0.1:${daemon.port}/?pt_token=ignored`);
    const ws = await rt.workspaces.create({ golden: "snap_gold", name: "task-1" });

    // Guest and laptop share this machine's loopback: the guest server takes 127.0.0.1 (where the daemon dials first), the laptop side [::1].
    const seen: string[] = [];
    const body = "<h1>Directory listing</h1>\n";
    guest = createServer(s => {
      s.on("data", d => {
        seen.push(d.toString());
        s.end(`HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
    });
    await new Promise<void>(r => guest!.listen(0, "127.0.0.1", r));
    const port = (guest.address() as { port: number }).port;

    const lines: string[] = [];
    const events: ForwardEvent[] = [];
    let linked = false;
    relay = startCallbackRelay({
      runtime: rt,
      openUrl: async () => true,
      log: l => lines.push(l),
      listenHosts: ["::1"],
      retryMs: 200,
      jitter: () => 0,
      connect: async c => {
        const s = await connectDaemonSocket(c);
        linked = true;
        void s.closed.then(() => {
          linked = false;
        });
        return s;
      },
    });
    relay.on(e => events.push(e));
    // The daemon pushes to the sockets it has; the host's link must be one of them before the tool prints.
    await until(() => linked, 5000);

    // A wsp terminal: a pty on the daemon, the tool prints its URL. The typed line carries the port only
    // as a variable: readline wraps its own echo at the pty width, and a wrap inside a literal URL is not
    // what a tool's output looks like.
    const sock = await connectDaemonSocket({ url: `ws://127.0.0.1:${daemon.port}`, token: TOKEN });
    try {
      const created = await sock.op("pty.create", { shell: "bash" });
      await sock.op("pty.write", { ptyId: created["ptyId"], data: `P=${port}; printf 'Serving HTTP on 0.0.0.0 port %s (http://0.0.0.0:%s/) ...\\n' $P $P\n` });
      await until(() => relay!.forwards().length === 1, 8000);
    } finally {
      sock.close();
    }
    expect(lines).toEqual([`task-1: forwarding localhost:${port} on this computer to the workspace (closes after 10 min without traffic)`]);
    expect(relay.list()).toEqual([{ workspaceId: ws.id, port, startedAt: expect.any(String), name: "task-1", kind: "url" }]);
    expect(events).toEqual([{ type: "forward.open", forward: relay.list()[0] }]);

    const res = await fetch(`http://[::1]:${port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(body);
    expect(seen.join("")).toContain("GET / HTTP/1.1");

    // The daemon goes away and comes back on the same port: the forward is still there and rides the new link.
    const daemonPort = daemon.port;
    await daemon.close();
    daemon = undefined;
    // The link's socket is gone before the daemon comes back; the forward stays.
    await until(() => !linked, 5000);
    expect(relay.forwards()).toMatchObject([{ port, kind: "url" }]);
    for (let i = 0; i < 50 && daemon === undefined; i++) {
      daemon = await startDaemon({ host: "127.0.0.1", port: daemonPort, token: TOKEN, portsSource: async () => [] }).catch(() => undefined);
      if (daemon === undefined) await new Promise(r => setTimeout(r, 100));
    }
    expect(daemon).toBeDefined();
    await until(() => lines.some(l => l.includes("the daemon link is back")), 8000);
    expect(lines.filter(l => l.includes("the daemon link is back"))).toEqual([`task-1: the daemon link is back; localhost:${port} still forwarded`]);
    const again = await fetch(`http://[::1]:${port}/`);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(body);

    expect(relay.stop(ws.id, port)).toBe(true);
    expect(relay.list()).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "forward.close", workspaceId: ws.id, port });
    expect(await refused(port, "::1")).toBe(true);
    expect(lines.join("\n")).not.toContain("http://");
  });
});
