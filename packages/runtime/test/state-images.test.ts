// SPDX-License-Identifier: AGPL-3.0-only
import type { GoldenImport } from "@wsp/engine";
import { describe, expect, it } from "vitest";
import { copyKey, createRuntime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { createOn, stubBackend, type StubBackend } from "./stub-backend.js";

/** Two state files on one computer read the same per-install id. */
const HOST = "box:410e877d";
const imp: GoldenImport = { recipeHash: "h1", recipe: { ticks: [], files: [] }, files: { count: 0, rungs: {}, bytes: 0, lands: [], skipped: [], pack: async () => ({ tar: Buffer.alloc(0), bytes: 0, unpacked: 0, skipped: [], cut: [], silenced: [], macPaths: [] }) }, tools: [], agents: [] };

/** A state file whose golden stands at v1 on the shared account, ready to seal v2. */
async function stateOn(backend: StubBackend, label: string) {
  const store = memoryStore();
  const snapshotId = `${label}-v1`;
  await store.put("goldens", copyKey("default", "default"), {
    head: 1,
    versions: [{ version: 1, snapshotId, baseTemplate: "base", setupSha: "sha1", createdAt: "2026-09-27T21:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, base: [] }],
  });
  await store.put("golden-recipes", copyKey("default", "default@v1"), { ticks: [], files: [] });
  backend.snapshots.push({ id: snapshotId, sizeBytes: 1e9, createdAt: "2026-09-27T21:00:00.000Z" });
  return createRuntime({ backend, store, adapters: {}, hostId: HOST, goldenRecipe: { setup: "true", smoke: "true", import: imp } });
}

describe("images of two states on one computer", () => {
  it("each state seals under a name of its own, and each fork boots the snapshot its own state sealed", async () => {
    const backend = stubBackend();
    backend.namedSnapshots = true;
    backend.execImpl = (_m, cmd) => (cmd.startsWith("df -Pk") ? { exitCode: 0, stdout: `${2000 * 1024}\n`, stderr: "" } : cmd === "echo ok" ? { exitCode: 0, stdout: "ok\n", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    const states = [await stateOn(backend, "fleet"), await stateOn(backend, "app")];
    const sealed: string[] = [];
    for (const rt of states) sealed.push((await rt.golden.upgrade({ delta: { import: { ...imp, recipeHash: "h2" }, retired: [], retiredOnImage: [] } })).version.snapshotId);
    expect(sealed[0]).not.toBe(sealed[1]);
    expect(backend.snapshots.map(r => r.id)).toEqual(expect.arrayContaining(sealed));
    for (const [i, rt] of states.entries()) {
      const before = backend.machines.length;
      await createOn(rt, { name: `fork-${i}` });
      expect(backend.machines.slice(before).map(m => m.spec.fromSnapshot ?? m.spec.template)).toEqual([sealed[i]]);
    }
    for (const rt of states) await rt.close();
  });
});
