// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endLocalRuns, localExecStream } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecStream } from "@wsp/protocol";
import { stopOnSignals, type CliIO, type StopProcess } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { alive, gone, grandchild, sweepStrays } from "../../runtime/test/strays.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (errors: string[] = []): CliIO => ({ log: () => {}, error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt });

/** Where the signals arrive and how the process ends, handed to the stop in place of this one: the test runner
 * cannot be sent a real signal, and the stop registers before any turn starts, the way the host does at its start. */
function standInHost(): { self: StopProcess; exits: number[]; signal: (sig: "SIGINT" | "SIGTERM" | "SIGHUP") => void; taken: () => string[] } {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  return {
    self: { on: (sig, listener) => listeners.set(sig, listener), exit: code => void exits.push(code) },
    exits,
    signal: sig => {
      const listener = listeners.get(sig);
      if (listener === undefined) throw new Error(`nothing on this host listens for ${sig}`);
      listener();
    },
    taken: () => [...listeners.keys()],
  };
}

describe("a serving host stopping on a signal", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "wsp-stopsignals-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    sweepStrays();
  });

  /** A local turn whose tree holds a sleeping grandchild, so what is left of the group after a stop can be read. */
  async function turn(name: string): Promise<{ stream: ExecStream; pid: number }> {
    const marker = join(root, `${name}.pid`);
    const stream = localExecStream({ root })(`sleep 30 & echo $! > ${marker}; sleep 30`, { env: {} });
    void (async () => {
      for await (const line of stream.lines) void line;
    })().catch(() => undefined);
    return { stream, pid: await grandchild(marker) };
  }

  it("takes the three stop signals and nothing under it registers one of its own", async () => {
    const host = standInHost();
    stopOnSignals({ close: async () => {} } as unknown as HostHandle, quietIO(), host.self);
    expect(host.taken()).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    const counted = (): number[] => (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(sig => process.listenerCount(sig));
    const before = counted();
    const running = await turn("counted");
    expect(counted()).toEqual(before);
    running.stream.kill();
    await running.stream.exited;
  }, 20_000);

  it("the first signal closes, the close is where this computer's turns end, and it exits 0 after", async () => {
    const host = standInHost();
    let closes = 0;
    // What the wiring's own close does at this point, and the only place a stop ends the turns from.
    const handle = {
      close: async () => {
        closes++;
        await endLocalRuns(20);
      },
    } as unknown as HostHandle;
    stopOnSignals(handle, quietIO(), host.self);
    const running = await turn("first");
    host.signal("SIGINT");
    await vi.waitFor(() => expect(host.exits).toEqual([0]), { timeout: 5_000 });
    expect(closes).toBe(1);
    await gone(running.pid);
  }, 20_000);

  it("a close that hangs holds the turn until a second signal, which ends it without the grace and exits at once", async () => {
    const host = standInHost();
    let closes = 0;
    const handle = {
      close: () => {
        closes++;
        return new Promise<void>(() => {});
      },
    } as unknown as HostHandle;
    stopOnSignals(handle, quietIO(), host.self);
    const running = await turn("hanging");
    host.signal("SIGINT");
    await vi.waitFor(() => expect(closes).toBe(1), { timeout: 5_000 });
    // The close never finishes, so nothing has ended the turn and nothing has exited: this is the escape hatch's road.
    expect(host.exits).toEqual([]);
    expect(alive(running.pid)).toBe(true);
    host.signal("SIGINT");
    await vi.waitFor(() => expect(host.exits).toEqual([130]), { timeout: 5_000 });
    await gone(running.pid);
    expect(closes).toBe(1);
  }, 20_000);
});
