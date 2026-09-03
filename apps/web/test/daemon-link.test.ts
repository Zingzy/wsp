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
  return startDaemon({ port: 0, token: TOKEN, inboxDir, portsSource: async () => [], portsIntervalMs: 1000 });
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
  it("turns a previewUrl into a wss url carrying the edge token and ours", () => {
    expect(daemonSocketUrl("https://abc-7070.preview.getsolari.com/?pt_token=edge", "ours")).toBe(
      "wss://abc-7070.preview.getsolari.com/?pt_token=edge&token=ours",
    );
    expect(daemonSocketUrl("ws://127.0.0.1:7070", "ours")).toBe("ws://127.0.0.1:7070/?token=ours");
  });
});

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
    const coded = await link.request("fs.list", { path: ".", depth: 0 }).catch((e: unknown) => e);
    expect(coded).toBeInstanceOf(DaemonRequestError);
    expect((coded as DaemonRequestError).code).toBe("bad-request");
    expect((coded as DaemonRequestError).message).toBe("depth must be a positive integer");
    const plain = await link.request("pty.write", { ptyId: "nope", data: "x" }).catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(DaemonRequestError);
    expect((plain as DaemonRequestError).code).toBeUndefined();
  });

  it("a rejected token is terminal: reauth-needed, no redial", async () => {
    daemon = await startTestDaemon();
    let dials = 0;
    link = connectDaemonLink({
      reach: async () => {
        dials++;
        return { url: `ws://127.0.0.1:${daemon!.port}`, daemonToken: "wrong" };
      },
      onEvent: () => {},
      backoffMs: () => 20,
    });
    await until(() => link!.status() === "reauth-needed");
    await new Promise(r => setTimeout(r, 150));
    expect(dials).toBe(1);
    await expect(link.request("ping")).rejects.toThrow();
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
