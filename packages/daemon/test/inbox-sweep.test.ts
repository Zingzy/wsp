// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxWatcher, type InboxFileEvent } from "../src/inbox.js";

// fs.watch is replaced by a watcher that reports nothing on its own, so every
// event in this file comes from the sweep unless a test fires the callback itself.
type WatchCb = (event: string, filename: string | null) => void;
let fsWatchCb: WatchCb | null = null;
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    watch: (_dir: string, cb: WatchCb) => {
      fsWatchCb = cb;
      return { close() {} };
    },
  };
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let dir: string;
let w: InboxWatcher;
let events: InboxFileEvent[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-inbox-sweep-"));
  events = [];
  w = new InboxWatcher({ dir, quietMs: 120, pollMs: 30 });
  w.on("inbox.file", e => events.push(e));
});

afterEach(() => {
  w.stop();
  fsWatchCb = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("InboxWatcher sweep", () => {
  it("announces a file fs.watch never reported, once it settles", async () => {
    w.start();
    const file = join(dir, "lost.bin");
    writeFileSync(file, "x".repeat(40));
    await sleep(60);
    appendFileSync(file, "y".repeat(24));
    await sleep(60);
    expect(events).toHaveLength(0);

    await sleep(300);
    expect(events).toEqual([{ type: "inbox.file", path: file, bytes: 64 }]);
  });

  it("reports a file once when fs.watch sees it and then the sweep does", async () => {
    w.start();
    const file = join(dir, "both.bin");
    writeFileSync(file, "z".repeat(8));
    fsWatchCb!("rename", "both.bin");

    await sleep(400);
    expect(events).toEqual([{ type: "inbox.file", path: file, bytes: 8 }]);
  });

  it("does not re-announce a settled file on later sweeps", async () => {
    w.start();
    const file = join(dir, "once.bin");
    writeFileSync(file, "q");
    await sleep(300);
    expect(events).toHaveLength(1);

    await sleep(300);
    expect(events).toHaveLength(1);
  });

  it("leaves files already present at start to rescan", async () => {
    const old = join(dir, "old.png");
    writeFileSync(old, "o".repeat(10));
    w.start();

    await sleep(400);
    expect(events).toHaveLength(0);
    expect((await w.rescan()).map(f => f.path)).toEqual([old]);
  });

  it("announces a file again if it is removed and dropped again", async () => {
    w.start();
    const file = join(dir, "again.bin");
    writeFileSync(file, "1");
    await sleep(300);
    expect(events).toHaveLength(1);

    unlinkSync(file);
    await sleep(100);
    writeFileSync(file, "22");
    await sleep(300);
    expect(events.map(e => e.bytes)).toEqual([1, 2]);
  });
});
