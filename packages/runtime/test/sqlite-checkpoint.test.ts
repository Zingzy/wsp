// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION } from "@wsp/protocol";
import { sqliteStore, stateDbPath, WAL_BOUND_BYTES, WAL_KEPT_BYTES } from "../src/sqlite-store.js";

/** What the next checkpointer thread is: stalled never checkpoints, dies throws on its first line, and refused is a
 * thread that cannot be made at all. The last two happen once. */
const held = vi.hoisted(() => ({ next: "real" as "real" | "stalled" | "dies" | "refused" }));
vi.mock("node:worker_threads", async importOriginal => {
  const real = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends real.Worker {
    constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
      const next = held.next;
      if (next === "dies" || next === "refused") held.next = "real";
      if (next === "refused") throw new Error("no thread to be had");
      if (next === "stalled") super("setInterval(() => {}, 1 << 30)", { eval: true });
      else if (next === "dies") super("throw new Error('a tick that throws')", { eval: true });
      else super(filename, options);
    }
  }
  return { ...real, Worker };
});

const dir = mkdtempSync(join(tmpdir(), "wsp-checkpoint-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const WRITER = { wsp: "test", daemon: DAEMON_VERSION, bin: "/usr/local/bin/wsp" };

/** The WAL's last frame and the last one copied into the database, off the wal-index header SQLite keeps in the
 * shared memory file: mxFrame at byte 16 of the header, nBackfill at byte 96 after its two copies. */
function wal(statePath: string): { frames: number; copied: number } {
  const shm = readFileSync(`${stateDbPath(statePath)}-shm`);
  return { frames: shm.readUInt32LE(16), copied: shm.readUInt32LE(96) };
}

/** Past SQLite's own threshold of 1000 pages in one commit. */
const OVER_THRESHOLD = Buffer.alloc(6 * 1024 * 1024, 1);

describe("the state database's checkpoints", () => {
  it("leaves a commit's WAL to a thread of its own, which copies it into the database within seconds", async () => {
    const statePath = join(mkdtempSync(join(dir, "home-")), "state.json");
    const store = sqliteStore(statePath, WRITER);
    await store.putBlob("transcripts", "w1", OVER_THRESHOLD);
    const after = wal(statePath);
    expect(after.frames).toBeGreaterThan(1000);
    expect(after.copied).toBeLessThan(after.frames);
    await vi.waitFor(() => expect(wal(statePath).copied).toBe(after.frames), { timeout: 4_000, interval: 100 });
  });

  it("checkpoints on a commit once the WAL passes its bound, where the thread never does", async () => {
    held.next = "stalled";
    try {
      const statePath = join(mkdtempSync(join(dir, "home-")), "state.json");
      const store = sqliteStore(statePath, WRITER);
      const largest = { wal: 0, copied: 0 };
      for (let i = 0; i < Math.ceil((WAL_BOUND_BYTES * 1.5) / OVER_THRESHOLD.length); i++) {
        await store.putBlob("transcripts", `w${i}`, OVER_THRESHOLD);
        largest.wal = Math.max(largest.wal, statSync(`${stateDbPath(statePath)}-wal`).size);
        largest.copied = Math.max(largest.copied, wal(statePath).copied);
      }
      expect(largest.copied).toBeGreaterThan(0);
      expect(largest.wal).toBeLessThan(WAL_BOUND_BYTES + 2 * OVER_THRESHOLD.length);
    } finally {
      held.next = "real";
    }
  });

  it.each(["dies", "refused"] as const)("starts the thread again after one that %s, and it checkpoints", async next => {
    held.next = next;
    const statePath = join(mkdtempSync(join(dir, "home-")), "state.json");
    const store = sqliteStore(statePath, WRITER);
    await store.putBlob("transcripts", "w1", OVER_THRESHOLD);
    const after = wal(statePath);
    expect(after.copied).toBeLessThan(after.frames);
    await vi.waitFor(() => expect(wal(statePath).copied).toBe(after.frames), { timeout: 8_000, interval: 100 });
  }, 12_000);

  it("gives the WAL file back past its kept size once a checkpoint has copied it", async () => {
    const statePath = join(mkdtempSync(join(dir, "home-")), "state.json");
    const store = sqliteStore(statePath, WRITER);
    await store.putBlob("transcripts", "w1", Buffer.alloc(WAL_KEPT_BYTES + 8 * 1024 * 1024, 1));
    const walFile = `${stateDbPath(statePath)}-wal`;
    expect(statSync(walFile).size).toBeGreaterThan(WAL_KEPT_BYTES);
    const after = wal(statePath);
    await vi.waitFor(() => expect(wal(statePath).copied).toBe(after.frames), { timeout: 4_000, interval: 100 });
    await store.put("workspaces", "a", { id: "a" });
    expect(statSync(walFile).size).toBeLessThanOrEqual(WAL_KEPT_BYTES);
  });
});
