import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { jsonFileStore, memoryStore, type Store } from "../src/store.js";

const dir = mkdtempSync(join(tmpdir(), "wsp-store-"));
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
roundTrip("jsonFileStore", () => jsonFileStore(join(dir, `s-${Math.random().toString(36).slice(2)}.json`)));

describe("jsonFileStore persistence", () => {
  it("survives a new instance over the same file and writes real JSON", async () => {
    const path = join(dir, "persist.json");
    const s1 = jsonFileStore(path);
    await s1.put("goldens", "default", { head: 1 });
    const s2 = jsonFileStore(path);
    expect(await s2.get("goldens", "default")).toEqual({ head: 1 });
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });
  it("keeps blobs as files beside the json, never inside it", async () => {
    const path = join(dir, "blobs-home", "state.json");
    const store = jsonFileStore(path);
    await store.putBlob("vaults", "ws_2", Buffer.from("tgz"));
    expect(readFileSync(join(dir, "blobs-home", "blobs", "vaults", "ws_2"), "utf8")).toBe("tgz");
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").not.toContain("tgz");
    expect(await jsonFileStore(path).getBlob("vaults", "ws_2")).toEqual(Buffer.from("tgz"));
  });
});
