// SPDX-License-Identifier: AGPL-3.0-only
// Forgetting a workspace whose machine the provider no longer has: the record,
// its transcripts and its sessions leave the store and workspace.deleted
// follows, with nothing asked of the provider; a workspace whose machine still
// exists is refused with the reason and kept whole.
import { describe, expect, it } from "vitest";
import type { EventUnion } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";

describe("workspaces.forget", () => {
  it("drops a workspace whose machine is gone: record, transcripts and sessions leave the store and workspace.deleted follows", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const events: EventUnion[] = [];
    rt.events.on("*", e => events.push(e));
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "first" });
    await store.put("transcripts", ws.id, { events: [{ type: "session.start", sessionId: "s1" }] });
    await store.put("sessions", ws.id, { rows: [{ id: "s1", workspaceId: ws.id, harness: "claude", status: "completed" }] });
    backend.machines[0]!.killed = true;

    await rt.workspaces.forget(ws.id);

    expect(await rt.workspaces.list()).toEqual([]);
    await expect(rt.workspaces.get(ws.id)).rejects.toThrow(`no such workspace: ${ws.id}`);
    expect(await store.get("workspaces", ws.id)).toBeUndefined();
    expect(await store.get("transcripts", ws.id)).toBeUndefined();
    expect(await store.get("sessions", ws.id)).toBeUndefined();
    expect(events.filter(e => e.type === "workspace.deleted")).toMatchObject([{ type: "workspace.deleted", workspaceId: ws.id }]);
  });

  it("refuses a workspace whose machine still exists, running or paused, with the reason, and keeps everything", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const rt = createRuntime({ backend, store, adapters: {} });
    const ws = await rt.workspaces.create({ golden: "snap_g", name: "live" });

    await expect(rt.workspaces.forget(ws.id)).rejects.toMatchObject({
      message: "live's machine m1 is still running; pause it or delete it at the provider first",
      kind: "conflict",
    });
    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.forget(ws.id)).rejects.toThrow("live's machine m1 is still paused; pause it or delete it at the provider first");

    expect(backend.machines[0]!.killed).toBe(false);
    expect((await rt.workspaces.list()).map(w => w.id)).toEqual([ws.id]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ id: ws.id, phase: "napping" });
  });
});
