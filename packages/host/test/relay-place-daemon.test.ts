// SPDX-License-Identifier: AGPL-3.0-only
// The callback relay on a joined computer against a real daemon binary run as a place's: a sign-in page whose URL
// names no port is followed by the loopback listener that opens after it, which the relay hears as port.open and
// callback.port over the place's link, and forwards.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { openDaemonChannel, type CallbackForwards, type DaemonChannel, type EventUnion, type Runtime } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { fakeProcTree, setListeners } from "../../daemon/test/fake-proc.js";
import { daemonUnderTest, type DaemonUnderTest } from "../../daemon/test/harness.js";
import { startCallbackRelay, type CallbackRelay } from "../src/relay.js";

const TOKEN = "relay-place-token";
const GH_DEVICE = "https://github.com/login/device";
const execFileAsync = promisify(execFile);

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`waited ${ms}ms and this never came true: ${cond.toString()}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>(r => s.close(() => r()));
  return port;
}

describe("the callback relay on a joined computer, over a real place daemon", () => {
  let daemon: DaemonUnderTest | undefined;
  let relay: CallbackRelay | undefined;
  let dir: string | undefined;
  let tree: string | undefined;
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
    await daemon?.close();
    daemon = undefined;
    for (const made of [dir, tree]) if (made !== undefined) rmSync(made, { recursive: true, force: true });
    dir = undefined;
    tree = undefined;
  });

  it("forwards the callback of a page whose URL names no port, off the listener that opens after it", async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-relay-place-"));
    const sock = join(dir, "open.sock");
    tree = fakeProcTree([]);
    daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: TOKEN, kind: "place", openSocket: sock, procRoot: tree, portsIntervalMs: 20 });
    const heard: string[] = [];
    const asked: string[] = [];
    // The place's link as the runtime's place door hands it out, here one dial of the daemon itself.
    const channel = (onEvent: (e: Record<string, unknown>) => void): DaemonChannel => {
      const opened = openDaemonChannel({
        url: `http://127.0.0.1:${daemon!.port}`,
        token: TOKEN,
        onEvent: e => {
          heard.push(e["port"] === undefined ? String(e["type"]) : `${String(e["type"])}:${String(e["port"])}`);
          onEvent(e);
        },
      });
      return {
        send: async frame => {
          const reply = await (await opened).send(frame);
          asked.push(frame.op);
          return reply;
        },
        close: () => void opened.then(c => c.close(), () => {}),
        closed: opened.then(c => c.closed),
      };
    };
    let forwards: CallbackForwards | undefined;
    const rt = {
      events: { on: (_type: string, _fn: (e: EventUnion) => void) => () => {} },
      backend: { capabilities: { callbackRelay: false } },
      workspaces: { list: async () => [] },
      places: {
        list: async () => [{ id: "pl_1", name: "spoo", kind: "computer" }],
        channel: (_id: string, onEvent: (e: Record<string, unknown>) => void) => channel(onEvent),
        nameOf: () => "spoo",
      },
      agents: {
        forwards: (f: CallbackForwards) => {
          forwards = f;
          return () => (forwards = undefined);
        },
      },
    } as unknown as Runtime;
    relay = startCallbackRelay({ runtime: rt, openUrl: async () => true, log: () => {}, places: true, listenHosts: ["127.0.0.1"] });
    await until(() => asked.includes("ports.watch") && forwards !== undefined);
    // A sign-in runs on that computer, so its page and its callback are the relay's to carry.
    forwards!.open({ placeId: "pl_1" });
    await execFileAsync("curl", ["-s", "-o", "/dev/null", "--unix-socket", sock, "-X", "POST", "--data-binary", GH_DEVICE, "http://wsp/open"]);
    await until(() => heard.includes("browser.open"));
    const port = await freePort();
    setListeners(tree!, [{ port, pid: 2, loopback: true }]);
    await until(() => heard.includes(`port.open:${port}`) && heard.includes(`callback.port:${port}`));
    await until(() => relay!.list().some(f => f.port === port && f.kind === "callback"));
  }, 20_000);
});
