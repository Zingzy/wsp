// SPDX-License-Identifier: AGPL-3.0-only
// The browser's daemon link against a real in-process daemon, through the
// runtime test suite's tcp proxy when a cut must be staged. jsdom's WebSocket
// is the browser one here.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type DaemonHandle } from "@wsp/daemon";
import type { DaemonEvent, DaemonLinkStatus } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { connectDaemonLink, daemonSocketUrl, DaemonRequestError, type DaemonLink } from "../src/terminal/daemon-link.js";
import { startTcpProxy, type TcpProxy } from "../../../packages/runtime/test/tcp-proxy.js";

const TOKEN = "link-token";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

let daemon: DaemonHandle | undefined;
let proxy: TcpProxy | undefined;
let link: DaemonLink | undefined;
let inboxDir: string | undefined;

async function startTestDaemon(): Promise<DaemonHandle> {
  inboxDir = mkdtempSync(join(tmpdir(), "wsp-link-inbox-"));
  // Its roots file goes in a folder this test owns: the default names the guest's /root, another user's folder here.
  const rootsPath = join(inboxDir, "roots");
  return startDaemon({ port: 0, token: TOKEN, inboxDir, rootsPath, portsSource: async () => [], portsIntervalMs: 1000 });
}

afterEach(async () => {
  link?.close();
  link = undefined;
  await proxy?.close();
  proxy = undefined;
  await daemon?.close();
  daemon = undefined;
  if (inboxDir) rmSync(inboxDir, { recursive: true, force: true });
  inboxDir = undefined;
});

describe("daemonSocketUrl", () => {
  it("turns a previewUrl into a wss url carrying the edge token and never ours", () => {
    expect(daemonSocketUrl("https://abc-7070.preview.getsolari.com/?pt_token=edge")).toBe("wss://abc-7070.preview.getsolari.com/?pt_token=edge");
    expect(daemonSocketUrl("ws://127.0.0.1:7070")).toBe("ws://127.0.0.1:7070/");
  });
});

/** The browser socket with what it dialled and the first frame it sent, per socket. */
function spyingSockets(): { Ctor: typeof WebSocket; dials: { url: string; first: Record<string, unknown> | undefined }[] } {
  const dials: { url: string; first: Record<string, unknown> | undefined }[] = [];
  class Spy extends WebSocket {
    private readonly dial: { url: string; first: Record<string, unknown> | undefined };
    constructor(url: string | URL) {
      super(url);
      this.dial = { url: String(url), first: undefined };
      dials.push(this.dial);
    }
    override send(data: string): void {
      this.dial.first ??= JSON.parse(data) as Record<string, unknown>;
      super.send(data);
    }
  }
  return { Ctor: Spy, dials };
}

describe("connectDaemonLink", () => {
  it("goes live, round-trips pty ops, and delivers pty.data events", async () => {
    daemon = await startTestDaemon();
    const events: DaemonEvent[] = [];
    const statuses: DaemonLinkStatus[] = [];
    link = connectDaemonLink({
      reach: async () => ({ url: `ws://127.0.0.1:${daemon!.port}`, daemonToken: TOKEN }),
      onEvent: e => events.push(e),
      onStatus: s => statuses.push(s),
    });
    await until(() => link!.status() === "live");
    expect(statuses).toEqual(["connecting", "live"]);

    const created = await link.request("pty.create", { cols: 80, rows: 24, shell: "/bin/sh" });
    const ptyId = String(created["ptyId"]);
    await link.request("pty.attach", { ptyId });
    await link.request("pty.write", { ptyId, data: "echo link-mark-$((40 + 2))\r" });
    await until(() => events.some(e => e.type === "pty.data" && e.data.includes("link-mark-42")), 10_000);
  }, 15_000);

  it("a refusal rejects as DaemonRequestError, with the typed code when the op sends one", async () => {
    daemon = await startTestDaemon();
    link = connectDaemonLink({
      reach: async () => ({ url: `ws://127.0.0.1:${daemon!.port}`, daemonToken: TOKEN }),
      onEvent: () => {},
    });
    await until(() => link!.status() === "live");
    const coded = await link.request("fs.list", { path: 7 }).catch((e: unknown) => e);
    expect(coded).toBeInstanceOf(DaemonRequestError);
    expect((coded as DaemonRequestError).code).toBe("bad-request");
    expect((coded as DaemonRequestError).message).toBe("path must be a string");
    const plain = await link.request("pty.write", { ptyId: "nope", data: "x" }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(DaemonRequestError);
    expect((plain as DaemonRequestError).code).toBeUndefined();
  });

  it("a refused token says reauth-needed, then redials with the token the host hands out next", async () => {
    daemon = await startTestDaemon();
    const statuses: DaemonLinkStatus[] = [];
    let dials = 0;
    link = connectDaemonLink({
      reach: async () => {
        dials++;
        return { url: `ws://127.0.0.1:${daemon!.port}`, daemonToken: dials === 1 ? "stale" : TOKEN };
      },
      onEvent: () => {},
      onStatus: s => statuses.push(s),
      backoffMs: () => 40,
    });
    await until(() => link!.status() === "reauth-needed");
    await expect(link.request("ping")).rejects.toThrow("daemon unreachable");
    await until(() => link!.status() === "live");
    expect(statuses).toEqual(["connecting", "reauth-needed", "connecting", "live"]);
    expect(dials).toBe(2);
  });

  it("a token the host keeps handing out and the daemon keeps refusing stays reauth-needed between dials, never live", async () => {
    daemon = await startTestDaemon();
    const statuses: DaemonLinkStatus[] = [];
    let dials = 0;
    link = connectDaemonLink({
      reach: async () => {
        dials++;
        return { url: `ws://127.0.0.1:${daemon!.port}`, daemonToken: "stale" };
      },
      onEvent: () => {},
      onStatus: s => statuses.push(s),
      backoffMs: () => 30,
    });
    await until(() => dials >= 3);
    expect(statuses).not.toContain("live");
    expect(statuses.filter(s => s === "reauth-needed").length).toBeGreaterThanOrEqual(2);
  });

  it("every dial carries the edge url without our token and sends the auth frame first, redials included", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    const { Ctor, dials } = spyingSockets();
    link = connectDaemonLink({
      reach: async () => ({ url: `http://127.0.0.1:${proxy!.port}/?pt_token=edge`, daemonToken: TOKEN }),
      onEvent: () => {},
      WebSocketCtor: Ctor,
      heartbeatMs: 60,
      backoffMs: () => 30,
    });
    await until(() => link!.status() === "live");
    proxy.cutAll();
    await until(() => link!.stats().reconnects >= 1 && link!.status() === "live");
    expect(dials.length).toBeGreaterThanOrEqual(2);
    for (const d of dials) {
      expect(d.url).toBe(`ws://127.0.0.1:${proxy!.port}/?pt_token=edge`);
      expect(new URL(d.url).searchParams.has("token")).toBe(false);
      expect(d.first).toEqual({ id: expect.any(Number), op: "auth", token: TOKEN });
    }
  }, 15_000);

  it("a request in the window between socket open and the auth reply is refused, not put on the wire", async () => {
    // The daemon caps unauthenticated bytes, so a keystroke or paste that
    // reaches the wire before the auth reply would close the socket 4401.
    daemon = await startTestDaemon();
    const wire: string[] = [];
    let inWindow: Promise<unknown> | undefined;
    class Spy extends WebSocket {
      constructor(url: string | URL) {
        super(url);
        // The link's open handler has sent auth by the time this microtask runs; no reply can have arrived yet.
        this.addEventListener("open", () => queueMicrotask(() => {
          inWindow ??= link!.request("pty.write", { ptyId: "nope", data: "x".repeat(8 * 1024) }).catch((e: unknown) => e);
        }));
        this.addEventListener("message", () => wire.push("reply"));
      }
      override send(data: string): void {
        wire.push(`send:${String((JSON.parse(data) as Record<string, unknown>)["op"])}`);
        super.send(data);
      }
    }
    const statuses: DaemonLinkStatus[] = [];
    link = connectDaemonLink({
      reach: async () => ({ url: `ws://127.0.0.1:${daemon!.port}`, daemonToken: TOKEN }),
      onEvent: () => {},
      onStatus: s => statuses.push(s),
      WebSocketCtor: Spy,
    });
    await until(() => link!.status() === "live");
    expect(inWindow).toBeDefined();
    expect(await inWindow).toEqual(new Error("daemon unreachable"));
    expect(wire.slice(0, 2)).toEqual(["send:auth", "reply"]);
    expect(statuses).toEqual(["connecting", "live"]);
    expect((await link.request("ping"))["ok"]).toBe(true);
  });

  it("without a daemon token it keeps waiting and dials once the runtime reports one", async () => {
    daemon = await startTestDaemon();
    let token: string | undefined;
    link = connectDaemonLink({
      reach: async () => ({ url: `ws://127.0.0.1:${daemon!.port}`, ...(token !== undefined ? { daemonToken: token } : {}) }),
      onEvent: () => {},
      backoffMs: () => 30,
    });
    await new Promise(r => setTimeout(r, 150));
    expect(link.status()).toBe("connecting");
    token = TOKEN;
    await until(() => link!.status() === "live");
  });

  it("survives a cut socket: reconnects with a fresh reach and heartbeats keep the idle sweep away", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    let reaches = 0;
    link = connectDaemonLink({
      reach: async () => {
        reaches++;
        return { url: `ws://127.0.0.1:${proxy!.port}`, daemonToken: TOKEN };
      },
      onEvent: () => {},
      heartbeatMs: 60,
      backoffMs: () => 30,
    });
    // A 60ms beat trips on any scheduler stall longer than a beat, so the link
    // may redial on its own at any point: measure from the cut, and read the
    // counters only while live, when no dial is in flight.
    await until(() => link!.status() === "live" && link!.stats().pongsReceived >= 2);
    const before = link.stats();

    proxy.cutAll();
    await until(() => link!.stats().reconnects > before.reconnects && link!.status() === "live");
    const after = link.stats();
    expect(reaches).toBe(after.reconnects + 1);
    await until(() => link!.stats().pongsReceived > after.pongsReceived);
  }, 15_000);

  it("a socket that stops answering heartbeats is abandoned and redialed", async () => {
    daemon = await startTestDaemon();
    proxy = await startTcpProxy(daemon.port);
    link = connectDaemonLink({
      reach: async () => ({ url: `ws://127.0.0.1:${proxy!.port}`, daemonToken: TOKEN }),
      onEvent: () => {},
      heartbeatMs: 60,
      backoffMs: () => 30,
    });
    await until(() => link!.status() === "live");
    const before = link.stats();
    proxy.stall();
    await until(() => link!.status() === "connecting", 3000);
    proxy.resume();
    await until(() => link!.stats().reconnects > before.reconnects && link!.status() === "live");
  }, 15_000);
});
