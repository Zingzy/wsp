// SPDX-License-Identifier: AGPL-3.0-only
// A wake never puts another machine under a workspace. The disk of the one it
// has holds the agents' sessions and the work nobody pushed, and a fresh fork
// of the image holds neither. A wake whose machine came back without its
// daemon answering fails and keeps the machine; a machine the provider says is
// gone settles the record gone, and the person is told what went with it.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BOX_BUDGETS } from "@wsp/engine";
import { DAEMON_TOKEN_PATH, goneRefusal, type EventUnion } from "@wsp/protocol";
import { createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { droppingPort } from "./held-port.js";
import { createOn, stubBackend, tokenGuest, type StubBackend } from "./stub-backend.js";

/** A stub that declares what a box does: one wake attempt, a pause that keeps the disk and nothing in memory, and
 * forks off the seller's named snapshots. The guest holds a daemon token, so the wake dials the daemon rather than
 * settling for an exec, and the daemon's wait is shrunk so a silent one is read in a test's time. */
function boat(): StubBackend {
  const backend = stubBackend();
  const bare = backend.execImpl;
  backend.execImpl = (m, cmd) => (cmd.includes(DAEMON_TOKEN_PATH) ? tokenGuest(m, cmd) : bare(m, cmd));
  backend.capabilities.liveCloneForks = false;
  backend.capabilities.pauseMode = "disk";
  backend.lifecycle.budgets = { ...BOX_BUDGETS, daemonAnswersMs: 300 };
  return backend;
}

describe("a wake on a box keeps the workspace's machine", () => {
  it("a daemon that does not answer the wake fails it, and the workspace still names its own machine, which is neither replaced nor killed", async () => {
    const backend = boat();
    const { port, close } = await droppingPort();
    onTestFinished(close);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    onTestFinished(() => rt.close());
    const events: EventUnion[] = [];
    rt.events.on("*", e => void events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    const m1 = backend.machines[0]!;
    m1.previewUrl = async () => ({ url: `ws://127.0.0.1:${port}`, token: "e", expiresAt: Date.now() + 3_600_000 });
    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.wake(ws.id)).rejects.toThrow(/daemon on m1 did not answer within 300 ms/);
    const record = await rt.workspaces.get(ws.id);
    expect(record.machineId).toBe("m1");
    expect(backend.machines.map(m => m.id)).toEqual(["m1"]);
    expect(m1.killed).toBe(false);
    expect(events.some(e => e.type === "workspace.woken" || e.type === "workspace.upgraded")).toBe(false);
  });

  it("a machine the provider says vanished while paused settles the workspace gone: no fresh fork and the refusal says what was lost", async () => {
    const backend = boat();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goneConfirmMs: 0 });
    onTestFinished(() => rt.close());
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    const m1 = backend.machines[0]!;
    await rt.workspaces.nap(ws.id);
    m1.killed = true;
    const refused = await rt.workspaces.wake(ws.id).then(
      () => undefined,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    const record = await rt.workspaces.get(ws.id);
    expect(record.phase).toBe("gone");
    expect(record.machineId).toBe("m1");
    expect(backend.machines.map(m => m.id)).toEqual(["m1"]);
    expect(record.gone).toMatch(/^machine m1 is gone at the provider: the wake found it gone at \S+Z/);
    expect(refused).toBe(goneRefusal("boat", "wake", record.gone));
    expect(refused).toMatch(/^boat's machine is gone with its disk, so work that was not pushed is lost; rebuild it to wake, which brings back its home folder from the last saved nap/);
  });

  // A gateway copy that never held the machine answers 404 while the provider still holds it: the resume's 404 alone
  // settles nothing, and only confirming reads that say gone do.
  it.each([
    ["say the machine is paused", (_backend: StubBackend) => {}],
    ["fail", (backend: StubBackend) => {
      backend.get = async () => {
        throw new Error("fetch failed");
      };
    }],
  ])("a resume the provider answers 404 for, whose confirming reads %s, leaves the workspace napping on its machine", async (_reads, confirming) => {
    const backend = boat();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const rt = createRuntime({ backend, store: memoryStore(), adapters: {}, goneConfirmMs: 0 });
    onTestFinished(() => rt.close());
    const events: EventUnion[] = [];
    rt.events.on("*", e => void events.push(e));
    const ws = await createOn(rt, { golden: "snap_g", name: "boat" });
    const m1 = backend.machines[0]!;
    await rt.workspaces.nap(ws.id);
    m1.resume = async () => {
      throw Object.assign(new Error("Box not found"), { kind: "missing", status: 404 });
    };
    confirming(backend);
    await expect(rt.workspaces.wake(ws.id)).rejects.toMatchObject({ kind: "missing" });
    const record = await rt.workspaces.get(ws.id);
    expect(record).toMatchObject({ phase: "napping", machineId: "m1" });
    expect(record.gone).toBeUndefined();
    expect(backend.machines.map(m => m.id)).toEqual(["m1"]);
    expect(m1.killed).toBe(false);
    expect(events.some(e => e.type === "workspace.gone" || e.type === "workspace.woken" || e.type === "workspace.upgraded")).toBe(false);
  });
});
