// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecStream } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecStream } from "@wsp/protocol";
import { stopOnSignals, type CliIO, type StopProcess } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { grandchild, sweepStrays } from "../../runtime/test/strays.js";

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
const quietIO = (errors: string[] = []): CliIO => ({ log: () => {}, error: l => errors.push(l), ask: noPrompt, askSecret: noPrompt });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

  it("the first signal ends every live turn's group before the close, and exits 0 once the close is done", async () => {
    const host = standInHost();
    let goneWhileClosing: boolean | undefined;
    let closes = 0;
    let pid = 0;
    const handle = {
      close: async () => {
        closes++;
        // A signal reaches this close, not the turn's own group, so a close that takes its time finds the tree
        // already ended rather than still running: the reaper needs a moment after the kill, not the other way round.
        await new Promise(resolve => setTimeout(resolve, 300));
        goneWhileClosing = !alive(pid);
      },
    } as unknown as HostHandle;
    stopOnSignals(handle, quietIO(), host.self);
    const running = await turn("first");
    pid = running.pid;
    host.signal("SIGINT");
    await vi.waitFor(() => expect(host.exits).toEqual([0]), { timeout: 5_000 });
    expect(closes).toBe(1);
    expect(goneWhileClosing).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 20_000);

  it("a second signal while the close hangs takes what is left and exits at once, with the shell's code for it", async () => {
    const host = standInHost();
    let closes = 0;
    const handle = {
      close: () => {
        closes++;
        return new Promise<void>(() => {});
      },
    } as unknown as HostHandle;
    stopOnSignals(handle, quietIO(), host.self);
    const first = await turn("before");
    host.signal("SIGINT");
    await vi.waitFor(() => expect(alive(first.pid)).toBe(false), { timeout: 5_000 });
    expect(host.exits).toEqual([]);
    // A turn that got as far as starting while the close hung is still this host's to end.
    const during = await turn("during");
    host.signal("SIGINT");
    expect(host.exits).toEqual([130]);
    await vi.waitFor(() => expect(alive(during.pid)).toBe(false), { timeout: 5_000 });
    expect(closes).toBe(1);
  }, 20_000);
});
