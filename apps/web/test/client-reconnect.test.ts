// SPDX-License-Identifier: AGPL-3.0-only
// The runtime client and store against a real in-process serveRuntime through
// the runtime suite's tcp proxy: a cut socket is what a wsp restart looks like
// from an open tab. jsdom's WebSocket is the browser one here.
import { createRuntime, memoryStore, serveRuntime, type Runtime, type RuntimeServer } from "@wsp/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { makeApi, ProtocolClient, type ConnStatus, type ProtocolEvent } from "../src/protocol/client.js";
import { useStore } from "../src/protocol/store.js";
import { stubBackend } from "../../../packages/runtime/test/stub-backend.js";
import { startTcpProxy, type TcpProxy } from "../../../packages/runtime/test/tcp-proxy.js";

const TOKEN = "runtime-token";

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 25));
  }
}

let srv: RuntimeServer | undefined;
let proxy: TcpProxy | undefined;
let client: ProtocolClient | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  await proxy?.close();
  proxy = undefined;
  await srv?.close();
  srv = undefined;
});

describe("runtime socket reconnect", () => {
  it("a cut socket comes back: re-auth, events restored, list and statuses refetched, conn settles live", async () => {
    const rt: Runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: TOKEN });
    proxy = await startTcpProxy(srv.port);
    useStore.setState({ api: null, conn: "connecting", workspaces: [], statuses: {}, sessions: {}, selectedId: null, ready: false, toast: null });

    const statuses: ConnStatus[] = [];
    client = new ProtocolClient({
      url: `ws://127.0.0.1:${proxy.port}`,
      token: TOKEN,
      onStatus: s => {
        statuses.push(s);
        useStore.getState().setConn(s);
      },
      backoffMs: () => 400,
    });
    const events: ProtocolEvent[] = [];
    client.subscribe(e => events.push(e));
    await client.connect();
    useStore.getState().bind(makeApi(client));
    await until(() => useStore.getState().ready);
    expect(useStore.getState().conn).toBe("live");

    proxy.cutAll();
    await until(() => useStore.getState().conn === "reconnecting");
    // Made while the tab was dark: no event about it will ever reach this socket.
    const dark = await rt.workspaces.create({ golden: "snap_g", name: "made-in-the-dark" });
    expect(events.some(e => e.type === "workspace.created")).toBe(false);

    await until(() => useStore.getState().conn === "live");
    await until(() => useStore.getState().workspaces.some(w => w.id === dark.id));
    await until(() => useStore.getState().statuses[dark.id] !== undefined);

    const lit = await rt.workspaces.create({ golden: "snap_g", name: "after" });
    await until(() => events.some(e => e.type === "workspace.created" && e.workspace.id === lit.id));
    expect(statuses).toEqual(["live", "reconnecting", "live"]);
  }, 15_000);
});
