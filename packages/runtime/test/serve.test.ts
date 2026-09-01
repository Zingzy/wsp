import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { WsClient } from "./ws-client.js";
import { stubBackend } from "./stub-backend.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

function rt() {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

describe("serveRuntime auth", () => {
  it("closes 4401 on a wrong auth token", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    void c.request("auth", { token: "wrong" });
    expect(await c.closed()).toBe(4401);
  });

  it("closes 4401 when the first op is not auth", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    void c.request("workspaces.list");
    expect(await c.closed()).toBe(4401);
  });

  it("rejects malformed ops on an authed socket without closing it", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const bad = await c.request("workspaces.create", {}); // missing golden+name
    expect(bad.ok).toBe(false);
    const ok = await c.request("workspaces.list");
    expect(ok.ok).toBe(true);
    c.close();
  });
});

describe("serveRuntime tickets (bearer never rides a URL after the handshake)", () => {
  it("issues a 5-minute single-use connect ticket that authenticates a second socket", async () => {
    let nowMs = 1_000_000;
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", now: () => nowMs });
    const c1 = await WsClient.connect(srv.port, { token: "secret" });
    const issued = await c1.request("ticket.issue", { purpose: "connect" });
    expect(issued.ok).toBe(true);
    const ticket = issued["ticket"] as string;
    expect(ticket).not.toContain("secret");
    expect(issued["expiresAt"]).toBe(nowMs + 300_000);

    const c2 = await WsClient.connect(srv.port, { ticket });
    const res = await c2.request("workspaces.list");
    expect(res.ok).toBe(true);

    // single-use: replaying the same ticket dies at 4401
    const c3 = await WsClient.connect(srv.port, { ticket });
    expect(await c3.closed()).toBe(4401);
    c1.close();
    c2.close();
  });

  it("expires tickets after 5 minutes", async () => {
    let nowMs = 1_000_000;
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", now: () => nowMs });
    const c1 = await WsClient.connect(srv.port, { token: "secret" });
    const issued = await c1.request("ticket.issue", { purpose: "connect" });
    nowMs += 300_001;
    const late = await WsClient.connect(srv.port, { ticket: issued["ticket"] as string });
    expect(await late.closed()).toBe(4401);
    c1.close();
  });
});

describe("serveRuntime events", () => {
  it("fans runtime events out to subscribed sockets only", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const sub = await WsClient.connect(srv.port, { token: "secret" });
    const quiet = await WsClient.connect(srv.port, { token: "secret" });
    await sub.request("events.subscribe");

    const created = await sub.request("workspaces.create", { golden: "snap_g", name: "x" });
    expect(created.ok).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(sub.events.map(e => e.type)).toContain("workspace.created");
    expect(quiet.events).toEqual([]);
    sub.close();
    quiet.close();
  });
});
