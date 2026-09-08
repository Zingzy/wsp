// SPDX-License-Identifier: AGPL-3.0-only
// The preferences record over the wire: preferences.get answers the defaults
// until a client sets something, preferences.set lands a patch on the record,
// keeps it in the store so a runtime started later on the same state reads
// it, and pushes the whole record to every subscribed socket; a patch outside
// the record's own values is refused and changes nothing.
import { DEFAULT_PREFERENCES } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, serveRuntime, type RuntimeServer } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient, wsRequest } from "./ws-client.js";

describe("preferences over the wire", () => {
  let srv: RuntimeServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it("reads as the defaults, takes a patch, keeps it for the next runtime on the store, and pushes the record to every socket", async () => {
    const store = memoryStore();
    const rt = createRuntime({ backend: stubBackend(), store, adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: DEFAULT_PREFERENCES });

    const watcher = await WsClient.connect(srv.port, { token: "t" });
    expect((await watcher.request("events.subscribe")).ok).toBe(true);
    const set = await wsRequest(srv.port, "t", { op: "preferences.set", patch: { theme: "light", sidebarWidth: 312, terminalZoom: { ws_a: 2 } } });
    const expected = { ...DEFAULT_PREFERENCES, theme: "light", sidebarWidth: 312, terminalZoom: { ws_a: 2 } };
    expect(set).toMatchObject({ ok: true, preferences: expected });
    await until(() => watcher.events.some(e => e.type === "preferences.changed"));
    expect(watcher.events.find(e => e.type === "preferences.changed")).toMatchObject({ type: "preferences.changed", preferences: expected, seq: expect.any(Number) });
    watcher.close();

    // A second patch lands on the first, and a null width clears the width alone.
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { sidebarMode: "spaces", sidebarWidth: null } })).toMatchObject({
      ok: true,
      preferences: { theme: "light", sidebarMode: "spaces", terminalSize: "app", terminalZoom: { ws_a: 2 } },
    });
    expect((await wsRequest(srv.port, "t", { op: "preferences.get" }))["preferences"]).not.toHaveProperty("sidebarWidth");

    await srv.close();
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {} }), { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: { theme: "light", sidebarMode: "spaces", terminalZoom: { ws_a: 2 } } });
  });

  it("two patches landing at once keep both fields", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    const [a, b] = await Promise.all([rt.preferences.set({ theme: "light" }), rt.preferences.set({ sidebarMode: "spaces" })]);
    expect(a).toMatchObject({ theme: "light" });
    expect(b).toMatchObject({ theme: "light", sidebarMode: "spaces" });
    expect(await rt.preferences.get()).toMatchObject({ theme: "light", sidebarMode: "spaces" });
  });

  it("a patch outside the record's values is refused and the record stands", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { theme: "sepia" } })).toMatchObject({ ok: false });
    expect(await wsRequest(srv.port, "t", { op: "preferences.set", patch: { sidebarWidth: 0 } })).toMatchObject({ ok: false });
    expect(await wsRequest(srv.port, "t", { op: "preferences.get" })).toMatchObject({ ok: true, preferences: DEFAULT_PREFERENCES });
  });
});
