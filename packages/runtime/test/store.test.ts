import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DAEMON_VERSION, STATE_SHAPE, type StateShape } from "@wsp/protocol";
import { jsonFileStore, memoryStore, STATE_SHAPE_KEY, stateWrittenByNewerLine, type Store } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "wsp-store-"));
/** Who a store in this file says wrote its file: every caller names a build, and this one is the suite. */
const WRITER = { wsp: "test", daemon: DAEMON_VERSION, bin: "/usr/local/bin/wsp" };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function roundTrip(name: string, make: () => Store) {
  describe(name, () => {
    it("get/put/list/delete round-trips", async () => {
      const store = make();
      expect(await store.get("workspaces", "a")).toBeUndefined();
      await store.put("workspaces", "a", { id: "a", n: 1 });
      await store.put("workspaces", "b", { id: "b", n: 2 });
      expect(await store.get("workspaces", "a")).toEqual({ id: "a", n: 1 });
      const listed = await store.list("workspaces");
      expect(listed.map(v => (v as { id: string }).id).sort()).toEqual(["a", "b"]);
      await store.delete("workspaces", "a");
      expect(await store.get("workspaces", "a")).toBeUndefined();
      expect(await store.list("goldens")).toEqual([]);
    });
    it("blobs round-trip as bytes, latest write wins, delete forgets", async () => {
      const store = make();
      expect(await store.getBlob("vaults", "ws_1")).toBeUndefined();
      await store.putBlob("vaults", "ws_1", Buffer.from("v1"));
      await store.putBlob("vaults", "ws_1", Buffer.from([0, 255, 7]));
      expect(await store.getBlob("vaults", "ws_1")).toEqual(Buffer.from([0, 255, 7]));
      await store.deleteBlob("vaults", "ws_1");
      expect(await store.getBlob("vaults", "ws_1")).toBeUndefined();
    });
  });
}

roundTrip("memoryStore", () => memoryStore());
roundTrip("jsonFileStore", () => jsonFileStore(join(dir, `s-${Math.random().toString(36).slice(2)}.json`), WRITER));

describe("jsonFileStore persistence", () => {
  it("survives a new instance over the same file and writes real JSON", async () => {
    const path = join(dir, "persist.json");
    const s1 = jsonFileStore(path, WRITER);
    await s1.put("goldens", "default", { head: 1 });
    const s2 = jsonFileStore(path, WRITER);
    expect(await s2.get("goldens", "default")).toEqual({ head: 1 });
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });
  it("keeps blobs as files beside the json, never inside it", async () => {
    const path = join(dir, "blobs-home", "state.json");
    const store = jsonFileStore(path, WRITER);
    await store.putBlob("vaults", "ws_2", Buffer.from("tgz"));
    expect(readFileSync(join(dir, "blobs-home", "blobs", "vaults", "ws_2"), "utf8")).toBe("tgz");
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain("tgz");
    expect(await jsonFileStore(path, WRITER).getBlob("vaults", "ws_2")).toEqual(Buffer.from("tgz"));
  });
});

describe("the shape a state file was written in", () => {
  const writer = { wsp: "0.2.0", daemon: DAEMON_VERSION, bin: "/Users/z/.local/bin/wsp" };

  it("is written beside the collections on every save, and no collection read ever sees it", async () => {
    const path = join(dir, "shape-written.json");
    const store = jsonFileStore(path, writer);
    await store.put("workspaces", "a", { id: "a" });
    const held = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(held[STATE_SHAPE_KEY]).toMatchObject({ shape: STATE_SHAPE, ...writer });
    expect(Date.parse((held[STATE_SHAPE_KEY] as StateShape).at)).toBeGreaterThan(0);
    expect(await store.shape()).toMatchObject({ shape: STATE_SHAPE, ...writer });
    // Every other top-level name is a collection of documents by id; this one is not, so it reads as no collection
    // at all rather than as one whose ids are the document's own fields.
    expect(await store.list(STATE_SHAPE_KEY)).toEqual([]);
    expect(await store.keys(STATE_SHAPE_KEY)).toEqual([]);
    expect(await store.get(STATE_SHAPE_KEY, "shape")).toBeUndefined();
    // A save of a second collection keeps the first: the document sits beside them, it does not replace them.
    await store.put("projects", "p", { id: "p" });
    expect(await store.keys("workspaces")).toEqual(["a"]);
  });

  it("refuses every read and write of a file a newer wsp wrote, in one sentence naming the build, and leaves its bytes alone", async () => {
    const path = join(dir, "shape-newer.json");
    const wrote: StateShape = { shape: STATE_SHAPE + 1, wsp: "0.3.0", daemon: DAEMON_VERSION + 1, bin: "/Applications/wsp.app/Contents/Resources/bin.js", at: "2026-09-18T15:15:00.000Z" };
    writeFileSync(path, JSON.stringify({ workspaces: { a: { id: "a" } }, [STATE_SHAPE_KEY]: wrote }, null, 2));
    const before = readFileSync(path, "utf8");
    const store = jsonFileStore(path, writer);
    const refusal = stateWrittenByNewerLine(path, wrote);
    expect(refusal).toBe(
      `${path} was written by a newer wsp (state shape ${STATE_SHAPE + 1}; this wsp reads ${STATE_SHAPE}; written 2026-09-18T15:15:00.000Z by /Applications/wsp.app/Contents/Resources/bin.js (wsp 0.3.0, daemon ${DAEMON_VERSION + 1})): run that wsp, or move the file aside`,
    );
    await expect(store.get("workspaces", "a")).rejects.toThrow(refusal);
    await expect(store.list("workspaces")).rejects.toThrow(refusal);
    await expect(store.keys("workspaces")).rejects.toThrow(refusal);
    await expect(store.put("workspaces", "b", { id: "b" })).rejects.toThrow(refusal);
    await expect(store.delete("workspaces", "a")).rejects.toThrow(refusal);
    await expect(store.putBlob("vaults", "ws_1", Buffer.from("x"))).rejects.toThrow(refusal);
    expect(readFileSync(path, "utf8")).toBe(before);
    // The document itself is still readable, since the refusal has to name the build that wrote the file.
    expect(await store.shape()).toEqual(wrote);
  });

  it("reads a file written before the document existed as it always did, and writes the document at its next save", async () => {
    const path = join(dir, "shape-older.json");
    writeFileSync(path, JSON.stringify({ workspaces: { a: { id: "a" } } }));
    const store = jsonFileStore(path, writer);
    expect(await store.shape()).toBeUndefined();
    expect(await store.get("workspaces", "a")).toEqual({ id: "a" });
    await store.put("workspaces", "b", { id: "b" });
    expect((await store.shape())?.shape).toBe(STATE_SHAPE);
    expect(await store.keys("workspaces")).toEqual(["a", "b"]);
  });

  it("a store with no file behind it carries none, since the document is about a file another build could write", async () => {
    const store = memoryStore();
    await store.put("workspaces", "a", { id: "a" });
    expect(await store.shape()).toBeUndefined();
  });
});
