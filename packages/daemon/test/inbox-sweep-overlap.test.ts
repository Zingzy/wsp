// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InboxWatcher, type InboxFileEvent } from "../src/inbox.js";

// stat takes longer than the poll interval, so sweeps would interleave without a guard.
vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, watch: () => ({ close() {} }) };
});
vi.mock("node:fs/promises", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    stat: async (path: string) => {
      await new Promise(r => setTimeout(r, 60));
      return real.stat(path);
    },
  };
});

const dir = mkdtempSync(join(tmpdir(), "wsp-inbox-overlap-"));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("announces a file once even when a sweep outruns the poll interval", async () => {
  const w = new InboxWatcher({ dir, quietMs: 0, pollMs: 10 });
  const events: InboxFileEvent[] = [];
  w.on("inbox.file", e => events.push(e));
  w.start();
  writeFileSync(join(dir, "slow.bin"), "s".repeat(5));

  await new Promise(r => setTimeout(r, 600));
  w.stop();
  expect(events).toEqual([{ type: "inbox.file", path: join(dir, "slow.bin"), bytes: 5 }]);
});
