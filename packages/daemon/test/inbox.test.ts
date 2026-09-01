import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { InboxWatcher, type InboxFileEvent } from "../src/inbox.js";

const dir = mkdtempSync(join(tmpdir(), "wsp-inbox-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("InboxWatcher", () => {
  it("emits inbox.file only after a file stops growing", async () => {
    const w = new InboxWatcher({ dir, quietMs: 200, pollMs: 40 });
    const events: InboxFileEvent[] = [];
    w.on("inbox.file", e => events.push(e));
    w.start();

    const file = join(dir, "drop.tar");
    writeFileSync(file, "x".repeat(100));
    await new Promise(r => setTimeout(r, 100));
    appendFileSync(file, "y".repeat(50)); // still growing: quiet window must reset
    await new Promise(r => setTimeout(r, 100));
    expect(events).toHaveLength(0); // half-uploaded files never fire

    await new Promise(r => setTimeout(r, 500));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "inbox.file", path: file, bytes: 150 });

    await new Promise(r => setTimeout(r, 300));
    expect(events).toHaveLength(1); // settled file does not re-fire
    w.stop();
  });
});
