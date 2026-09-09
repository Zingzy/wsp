// SPDX-License-Identifier: AGPL-3.0-only
// A workspace with its project loaded is snapshotted as a project golden, and forks of that snapshot start with the
// project in place: the record the snapshot keeps, the refusals, what a fork inherits, and the two ops over the wire.
import { gunzipSync } from "node:zlib";
import { tarOf } from "@wsp/engine";
import type { GoldenManifest, ProjectGolden, ProjectPlan } from "@wsp/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type PackedProject, type ProjectBundler, type Runtime } from "../src/runtime.js";
import { serveRuntime, type RuntimeServer } from "../src/serve.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { WsClient } from "./ws-client.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

const SOURCE = "/Users/dev/code/proj";
const DEST = "/root/work/proj";
const T0 = Date.parse("2026-09-06T10:00:00.000Z");
/** templateHost() takes the part after the last colon, so every name this host writes carries the mark "h1". */
const HOST = "box:h1";

/** The golden the workspaces stand on: one sealed desktop version at head, sized above the provider default. */
const MANIFEST: GoldenManifest = {
  head: 12,
  versions: [
    { version: 12, snapshotId: "snap_golden-v12", kind: "desktop", baseTemplate: "base", setupSha: "abc", createdAt: "2026-09-01T00:00:00.000Z", smoke: { cmd: "true", exitCode: 0 }, size: { cpu: 4, memMb: 8192 } },
  ],
};

/** A folder of one file, nothing secret-shaped, no agents. */
function bundler(): ProjectBundler {
  const plan: ProjectPlan = { source: SOURCE, repo: true, files: 1, bytes: 20, secrets: [], excluded: [], skipped: [], agents: [] };
  return {
    plan: async () => plan,
    pack: async (): Promise<PackedProject> => ({ tar: tarOf([{ path: "src/index.ts", mode: 0o644, content: "export const a = 1;\n" }]), files: 1, bytes: 20, cut: [], rewritten: [] }),
    packState: async () => {
      throw new Error("no agent state in this test");
    },
  };
}

async function setup(store: Store = memoryStore()): Promise<{ rt: Runtime; backend: StubBackend; store: Store; advance: (ms: number) => void }> {
  const backend = stubBackend();
  await store.put("goldens", "default", MANIFEST);
  const { clock, advance } = fakeClock(T0);
  const rt = createRuntime({ backend, store, adapters: {}, clock, hostId: HOST });
  return { rt, backend, store, advance };
}

/** A workspace forked from the golden's head with the project landed in it. */
async function loaded(rt: Runtime, advance: (ms: number) => void, name = "task") {
  const ws = await rt.workspaces.create({ golden: "snap_golden-v12", name });
  advance(60_000);
  await rt.projects.import({ workspaceId: ws.id, source: SOURCE, dest: DEST, bundler: bundler() });
  return ws;
}

const PROJECT = { name: "proj", dest: DEST, importedAt: "2026-09-06T10:01:00.000Z", size: 20 };

describe("a project golden", () => {
  it("an import records the project on the workspace, named by the folder's last segment, and the record outlives the process", async () => {
    const { rt, advance, store, backend } = await setup();
    const ws = await loaded(rt, advance);
    expect(ws).not.toHaveProperty("projects");
    expect(await rt.workspaces.get(ws.id)).toMatchObject({ projects: [PROJECT] });
    expect((await rt.workspaces.list())[0]).toMatchObject({ projects: [PROJECT] });
    const again = createRuntime({ backend, store, adapters: {}, hostId: HOST });
    expect(await again.workspaces.get(ws.id)).toMatchObject({ projects: [PROJECT] });
  });

  it("snapshot takes the disk under the project's name, keeps the record with the golden version, the project and the workspace, and leaves the machine first-life", async () => {
    const { rt, advance, store, backend } = await setup();
    const ws = await loaded(rt, advance);
    advance(5 * 60_000);
    const golden = await rt.workspaces.snapshot(ws.id);
    const expected: ProjectGolden = {
      snapshotId: "snap_wsp-h1-project-proj-2026-09-06T10-06-00-000Z",
      projects: [PROJECT],
      golden: "snap_golden-v12",
      version: 12,
      workspaceId: ws.id,
      workspaceName: "task",
      createdAt: "2026-09-06T10:06:00.000Z",
    };
    expect(golden).toEqual(expected);
    expect(backend.snapshots.map(s => s.id)).toEqual([expected.snapshotId]);
    expect(await store.get("project-goldens", expected.snapshotId)).toEqual(expected);
    expect(await rt.golden.projects()).toEqual([expected]);
    expect(await store.get("workspaces", ws.id)).toMatchObject({ firstLife: true, golden: "snap_golden-v12" });
    advance(60_000);
    const second = await rt.workspaces.snapshot(ws.id);
    expect(second.snapshotId).toBe("snap_wsp-h1-project-proj-2026-09-06T10-07-00-000Z");
    // The mark is what tells a later doctor run this host took it, since a snapshot carries no provider metadata.
    expect(backend.snapshots.map(r => r.name)).toEqual(["wsp-h1-project-proj-2026-09-06T10-06-00-000Z", "wsp-h1-project-proj-2026-09-06T10-07-00-000Z"]);
    expect((await rt.golden.projects()).map(p => p.snapshotId)).toEqual([expected.snapshotId, second.snapshotId]);
  });

  it("a workspace without a project, a napping one and one that was ever resumed are refused in one sentence, and no snapshot is taken", async () => {
    const { rt, advance, backend } = await setup();
    const bare = await rt.workspaces.create({ golden: "snap_golden-v12", name: "bare" });
    await expect(rt.workspaces.snapshot(bare.id)).rejects.toThrow("bare has no project loaded; import one before snapshotting it");
    const ws = await loaded(rt, advance);
    await rt.workspaces.nap(ws.id);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toThrow("task is napping; only a running first-life machine can be snapshotted");
    await rt.workspaces.wake(ws.id);
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toMatchObject({ kind: "notFirstLife", message: expect.stringContaining("snapshot of task refused") });
    await expect(rt.workspaces.snapshot("ws_nope")).rejects.toThrow("no such workspace");
    expect(backend.snapshots).toEqual([]);
    expect(await rt.golden.projects()).toEqual([]);
  });

  it("a fork of a project golden boots from its snapshot as the root version's kind and size, carries the project, and its own snapshot still lists under that version", async () => {
    const { rt, advance, backend } = await setup();
    const ws = await loaded(rt, advance);
    const golden = await rt.workspaces.snapshot(ws.id);
    const fork = await rt.workspaces.create({ golden: golden.snapshotId, name: "task-a" });
    expect(fork).toMatchObject({ golden: golden.snapshotId, projects: [PROJECT] });
    const machine = backend.machines.find(m => m.id === fork.machineId)!;
    expect(machine.spec).toMatchObject({ fromSnapshot: golden.snapshotId, kind: "desktop", cpu: 4, memMb: 8192 });
    expect(backend.puts.filter(p => p.machine === machine.id).some(p => gunzipSync(p.body).toString("utf8").includes("Golden: v12"))).toBe(true);
    const sibling = await rt.workspaces.create({ golden: fork.golden, name: "task-b" });
    expect(sibling).toMatchObject({ golden: golden.snapshotId, projects: [PROJECT] });
    advance(60_000);
    const again = await rt.workspaces.snapshot(fork.id);
    expect(again).toMatchObject({ golden: "snap_golden-v12", version: 12, projects: [PROJECT], workspaceId: fork.id, workspaceName: "task-a" });
    expect(again.snapshotId).not.toBe(golden.snapshotId);
  });

  it("over the wire: workspaces.snapshot replies with the project golden, projectGoldens.list with every one, and a refusal carries its kind", async () => {
    const { rt, advance } = await setup();
    const ws = await loaded(rt, advance);
    srv = await serveRuntime(rt, { port: 0, authToken: "t" });
    const client = await WsClient.connect(srv.port, { token: "t" });
    try {
      const taken = await client.request("workspaces.snapshot", { workspaceId: ws.id });
      expect(taken).toMatchObject({ ok: true, projectGolden: { projects: [PROJECT], golden: "snap_golden-v12", version: 12, workspaceId: ws.id } });
      const listed = await client.request("projectGoldens.list", {});
      expect(listed).toMatchObject({ ok: true, projectGoldens: [taken["projectGolden"]] });
      await rt.workspaces.nap(ws.id);
      await rt.workspaces.wake(ws.id);
      const refused = await client.request("workspaces.snapshot", { workspaceId: ws.id });
      expect(refused).toMatchObject({ ok: false, kind: "notFirstLife" });
    } finally {
      client.close();
    }
  });
});
