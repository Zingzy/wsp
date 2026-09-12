// SPDX-License-Identifier: AGPL-3.0-only
// What the host reads and starts for the workspace that is this computer: the
// figures its Live rows wait on, read in this process off the real readings
// module, and the line whoever runs the host reads when the daemon those rows
// used to ride did not start.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SysSample } from "@wsp/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localWiring, type LocalDaemonStart } from "../src/cli.js";
import { localSysSamples } from "../src/local-readings.js";

/** Short enough that a test is not a wait, long enough that a loaded box still lands the poll after the baseline
 * inside the bound below. */
const TICK_MS = 200;

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise(r => setTimeout(r, 10));
  }
}

let dir: string;
let detaches: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-this-computer-"));
});

afterEach(() => {
  for (const d of detaches) d();
  detaches = [];
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("this computer's own readings", () => {
  it("lands a figure one poll tick after a pane asks, with nothing dialled", async () => {
    const samples: SysSample[] = [];
    const subscribe = localSysSamples({ root: dir, workFolder: () => dir, intervalMs: TICK_MS });
    const asked = Date.now();
    detaches.push(await subscribe(s => samples.push(s)));
    await until(() => samples.length > 0);
    const waited = Date.now() - asked;
    // The first read of the machine is the cpu baseline, which is a delta and has nothing to compare against yet;
    // the poll after it is the figure. So the row fills on the tick, and never on the tick after that.
    expect(waited).toBeGreaterThanOrEqual(TICK_MS);
    expect(waited).toBeLessThan(TICK_MS * 3);
    // The real machine, not a fixture: this box has memory and a filesystem under the folder work lands in.
    expect(samples[0]!.mem.total).toBeGreaterThan(0);
    expect(samples[0]!.mem.used).toBeGreaterThan(0);
    expect(samples[0]!.disk.total).toBeGreaterThan(0);
    expect(samples[0]!.cpu).toBeGreaterThanOrEqual(0);
  });

  it("hands a second pane the same readings rather than starting a second sampler", async () => {
    const a: SysSample[] = [];
    const b: SysSample[] = [];
    const subscribe = localSysSamples({ root: dir, workFolder: () => dir, intervalMs: TICK_MS });
    detaches.push(...(await Promise.all([subscribe(s => a.push(s)), subscribe(s => b.push(s))])));
    await until(() => a.length >= 2 && b.length >= 2);
    // One read of the machine handed to both, not one each: the same sample object, tick for tick.
    expect(b[0]).toBe(a[0]);
    expect(b[1]).toBe(a[1]);
    expect(a.map(s => s.at)).toEqual(b.map(s => s.at));
  });

  it("lets go of a build that failed and says it once, so a later pane is not answered with the first failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let tries = 0;
    const subscribe = localSysSamples({
      root: dir,
      workFolder: () => {
        if (tries++ < 2) throw new Error("the work folder could not be made");
        return dir;
      },
      intervalMs: TICK_MS,
    });
    await expect(subscribe(() => {})).rejects.toThrow("the work folder could not be made");
    await expect(subscribe(() => {})).rejects.toThrow("the work folder could not be made");
    // Two panes, two tries and one line: the failure is not kept, and a page that is waiting does not fill the log.
    expect(tries).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0]).split("\n")).toHaveLength(1);
    expect(String(warn.mock.calls[0]![0])).toContain("the work folder could not be made");
    // The pane after the failure reads the machine, rather than the failure that is over.
    const samples: SysSample[] = [];
    detaches.push(await subscribe(s => samples.push(s)));
    await until(() => samples.length > 0);
    expect(samples[0]!.mem.total).toBeGreaterThan(0);
  });
});

describe("the daemon this computer's panes dial", () => {
  const failing = (tries: { n: number }, message: string): LocalDaemonStart => async () => {
    tries.n++;
    throw new Error(message);
  };

  it("says why it did not start in one line, once, whatever a redialling page asks", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tries = { n: 0 };
    const wiring = localWiring(dir, { HOME: dir }, failing(tries, "node-pty would not load"));
    await expect(wiring.daemonRoad!()).rejects.toThrow("node-pty would not load");
    await expect(wiring.daemonRoad!()).rejects.toThrow("node-pty would not load");
    // The reason is not kept: every dial tries again, and the log reads the same reason once.
    expect(tries.n).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("node-pty would not load");
    expect(line).toMatch(/did not start/);
  });

  it("dials again after a failure rather than answering every later pane with the first one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const road = { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" };
    let tries = 0;
    const start: LocalDaemonStart = async () => {
      if (tries++ === 0) throw new Error("address in use");
      return { road, close: async () => {} } as unknown as Awaited<ReturnType<LocalDaemonStart>>;
    };
    const wiring = localWiring(dir, { HOME: dir }, start);
    await expect(wiring.daemonRoad!()).rejects.toThrow("address in use");
    expect(await wiring.daemonRoad!()).toEqual(road);
    await wiring.close!();
  });
});
