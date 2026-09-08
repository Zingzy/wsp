// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend, NoProviderBackend, type GoldenManifest } from "@wsp/engine";
import { createRuntime, localExecStream, memoryStore, type LocalWiring, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSsh } from "../../../packages/runtime/test/fake-ssh.js";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { checkSetup } from "../src/setup.js";
import type { Keys } from "@wsp/host";

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
  /** One store, read through the provider module a computer with a key wires and the one a computer without it
   * wires, since which onboarding is wanted is read off that module. */
  let keyed: Runtime;
  let keyless: Runtime;

  /** This computer as the window would hold it: a real local backend over a scratch folder, so a local record
   * hydrates rather than being left as a kind this host wired no module for. */
  const localWiring = (root: string): LocalWiring => ({ backend: new LocalBackend({ root }), execStream: o => localExecStream({ root, ...o }), home: () => join(root, ".claude"), env: {} });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsp-desktop-setup-"));
    mkdirSync(join(dir, "cwd"));
    sources = { env: {}, cwd: join(dir, "cwd"), home: join(dir, "home") };
    made.length = 0;
    store = memoryStore();
    const wiring = { store, adapters: {}, local: localWiring(join(dir, "user")), ssh: fakeSsh().wiring, hostId: "box:h1" };
    keyed = createRuntime({ backend: stubBackend(), ...wiring });
    keyless = createRuntime({ backend: new NoProviderBackend(), ...wiring });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** What makeRuntime does with the keys it is handed: the provider module behind the key, and behind no key the
   * one that holds no machine. */
  const runtimeFor = (keys: Keys, statePath: string): Runtime => {
    made.push({ keys, statePath });
    return keys.solari === undefined ? keyless : keyed;
  };

  it("reports the key missing, with nothing asked, when there is no key and nothing to show either", async () => {
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false, missing: "key" });
    // A missing provider key is not a missing answer: the state was read anyway, with no key handed to the runtime.
    expect(made).toEqual([{ keys: {}, statePath: join(dir, "state.json") }]);
  });

  it("opens on a computer with no provider key whose state holds this computer", async () => {
    await keyless.workspaces.createLocal("thisbox");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
  });

  it("opens on a computer with no provider key whose state holds a machine over ssh", async () => {
    await keyless.workspaces.createSsh("dev@box");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
  });

  it("carries the Claude key on that road, since a thread here uses it as a fork would", async () => {
    sources.env = { ANTHROPIC_API_KEY: "sk-ant-x-fake-desktop-key" };
    await keyless.workspaces.createLocal("thisbox");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
    expect(made).toEqual([{ keys: { anthropic: "sk-ant-x-fake-desktop-key" }, statePath: join(dir, "state.json") }]);
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
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyed });
  });
});
