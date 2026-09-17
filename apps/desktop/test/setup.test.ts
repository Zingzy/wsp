// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend, NoProviderBackend, type GoldenManifest } from "@wsp/engine";
import { isLocalWorkspace, type WorkspaceView } from "@wsp/protocol";
import { createRuntime, localExecStream, memoryStore, type LocalWiring, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeSsh } from "../../../packages/runtime/test/fake-ssh.js";
import { stubBackend } from "../../../packages/host/test/stub-backend.js";
import { checkSetup, openThisComputer } from "../src/setup.js";
import type { Keys, ProviderEnv } from "@wsp/host";

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

/** A project on this computer and its workspace, which is what a workspace here is: a folder of the person's own
 * worked in place. */
async function here(rt: Runtime, name: string): Promise<WorkspaceView> {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-desktop-")));
  execFileSync("git", ["init", "-q", folder]);
  const project = await rt.projects.add({ source: folder, name });
  return rt.workspaces.create({ project: project.id, name });
}

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
  const localWiring = (root: string): LocalWiring => ({ backend: new LocalBackend({ root }), execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }), home: () => join(root, ".claude"), homeDir: root, env: () => ({}) });

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

  /** What makeRuntime does with what it is handed: the provider module the environment the keys were read through
   * names, and behind no provider key the one that holds no machine. */
  const runtimeFor = (keys: Keys, statePath: string, env: ProviderEnv): Runtime => {
    made.push({ keys, statePath });
    return (env["SOLARI_API_KEY"] ?? "") === "" ? keyless : keyed;
  };

  it("is not ready, with nothing asked, when there is no key and nothing to show either", async () => {
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
    // A missing provider key is not a missing answer: the state was read anyway, with no key handed to the runtime.
    expect(made).toEqual([{ keys: {}, statePath: join(dir, "state.json") }]);
  });

  it("opens on a computer with no provider key whose state holds this computer", async () => {
    await here(keyless, "thisbox");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
  });

  it("carries the Claude key on that road, since a thread here uses it as a fork would", async () => {
    sources.env = { ANTHROPIC_API_KEY: "sk-ant-x-fake-desktop-key" };
    await here(keyless, "thisbox");
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyless });
    expect(made).toEqual([{ keys: { anthropic: "sk-ant-x-fake-desktop-key" }, statePath: join(dir, "state.json") }]);
  });

  it("is not ready when the key exists but the store has no golden and no workspace", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
    // The provider key is not among the keys the runtime is handed: it rides in the environment it picks from.
    expect(made).toEqual([{ keys: {}, statePath: join(dir, "state.json") }]);
  });

  it("is not ready when the manifest has no head version", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    await store.put("goldens", "default", { ...GOLDEN, head: 2 });
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
  });

  it("is ready with a key and a golden, handing back the runtime it built", async () => {
    sources.env = { SOLARI_API_KEY: SOLARI };
    await store.put("goldens", "default", GOLDEN);
    expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: true, runtime: keyed });
  });

  describe("openThisComputer", () => {
    it("records nothing: a workspace is one project's copy, so a first launch hands back the runtime and no workspace", async () => {
      const opened = await openThisComputer({ statePath: join(dir, "state.json"), sources, runtimeFor });
      expect(opened.runtime).toBe(keyless);
      expect(opened.workspace).toBeNull();
      expect(await keyless.workspaces.list()).toEqual([]);
      // Nothing was made, so the state still has nothing to show and the next launch opens on the same screen.
      expect(await checkSetup({ statePath: join(dir, "state.json"), sources, runtimeFor })).toEqual({ ready: false });
    });

    it("hands back the workspace on this computer where one already stands", async () => {
      const first = await here(keyless, "thisbox");
      const opened = await openThisComputer({ statePath: join(dir, "state.json"), sources, runtimeFor });
      expect(opened.workspace!.id).toBe(first.id);
      expect(isLocalWorkspace(opened.workspace!)).toBe(true);
      expect(await keyless.workspaces.list()).toHaveLength(1);
    });

    it("takes the same road with a provider key and no golden", async () => {
      sources.env = { SOLARI_API_KEY: SOLARI };
      const opened = await openThisComputer({ statePath: join(dir, "state.json"), sources, runtimeFor });
      expect(opened.runtime).toBe(keyed);
      expect(opened.workspace).toBeNull();
    });
  });
});
