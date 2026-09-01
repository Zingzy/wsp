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

  it("rescan lists settled files but skips ones still uploading", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "wsp-inbox-rescan-"));
    const settled = join(d2, "old.png");
    const part = join(d2, "new.part");
    writeFileSync(settled, "o".repeat(10));
    const w = new InboxWatcher({ dir: d2, quietMs: 200, pollMs: 40 });
    w.start();

    // Keep new.part growing until the watcher has it pending and old.png has settled out.
    writeFileSync(part, "n");
    const deadline = Date.now() + 3000;
    let paths: string[] = [];
    do {
      appendFileSync(part, "n");
      await new Promise(r => setTimeout(r, 50));
      paths = (await w.rescan()).map(f => f.path);
    } while ((paths.includes(part) || !paths.includes(settled)) && Date.now() < deadline);

    expect(paths).toEqual([settled]);
    w.stop();
    rmSync(d2, { recursive: true, force: true });
  });
});
