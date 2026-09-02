// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GoldenManifest } from "@wsp/engine";
import { createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { checkSetup } from "../src/setup.js";

const SOLARI = "slr_live_fake_desktop_key";
const GOLDEN: GoldenManifest = {
  head: 1,
  versions: [
    {
      version: 1,
      snapshotId: "snap_gold",
      baseTemplate: "base",
      setupSha: "x",
      createdAt: "2026-09-01T00:00:00Z",
      smoke: { cmd: "true", exitCode: 0 },
    },
  ],
};

describe("checkSetup", () => {
  let dir: string;
  let sources: { env: Record<string, string | undefined>; cwd: string; home: string };
  const made: { keys: unknown; statePath: string }[] = [];
  let store: Store;
  let runtime: Runtime;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-desktop-setup-"));
    mkdirSync(join(dir, "cwd"));
    sources = { env: {}, cwd: join(dir, "cwd"), home: join(dir, "home") };
    made.length = 0;
    store = memoryStore();
    runtime = createRuntime({ backend: stubBackend(), store, adapters: {} });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runtimeFor = (keys: unknown, statePath: string): Runtime => {
    made.push({ keys, statePath });
    return runtime;
  };

  it("reports the key missing without prompting or building a runtime", async () => {
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false, missing: "key" });
    expect(made).toEqual([]);
  });

  it("reports the golden missing when the key exists but the store has none", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false, missing: "golden" });
    expect(made).toEqual([{ keys: { solari: SOLARI }, statePath: join(dir, "state.json") }]);
  });

  it("reports the golden missing when the manifest has no head version", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    await store.put("goldens", "default", { ...GOLDEN, head: 2 });
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false, missing: "golden" });
  });

  it("is ready with a key and a golden, handing back the runtime it built", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    await store.put("goldens", "default", GOLDEN);
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime });
  });
});
