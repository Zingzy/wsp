// SPDX-License-Identifier: AGPL-3.0-only
// What the roads that need a daemon answer on a machine reached over ssh. The
// daemon there binds that machine's own loopback, and this host picks no port
// on this computer to carry it: a port here is one any other process on this
// computer can bind first, and whatever answered on it would be handed the
// daemon's token. So the kind says it has no daemon and its road refuses.
import { afterEach, describe, expect, it } from "vitest";
import { sshMachineId } from "@wsp/engine";
import { noSshDaemonLine } from "@wsp/protocol";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { fakeSsh } from "./fake-ssh.js";
import { stubBackend } from "./stub-backend.js";

const MACHINE = sshMachineId({ user: "dev", host: "box", port: 22 });

let rt: Runtime | undefined;

afterEach(async () => {
  await rt?.close();
  rt = undefined;
});

/** A host holding one workspace on a machine somebody owns, with a daemon this host put there recorded on it:
 * the state a deploy leaves behind, and the one a road to that daemon would be opened from. Written into the
 * store by hand, since no create on this host writes a record of this kind. */
async function hostWithOne(): Promise<Runtime> {
  const store = memoryStore();
  await store.put("projects", "pr_1", {
    id: "pr_1",
    name: "box",
    computer: "pl_box",
    source: { kind: "folder" as const, path: "/home/dev/box" },
    path: "/home/dev/box",
    memoryKey: "-home-dev-box",
    memoryDir: "/home/dev/.claude/projects/-home-dev-box/memory",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  await store.put("workspaces", "ws_1a2b3c4d", {
    id: "ws_1a2b3c4d",
    name: "box",
    kind: "ssh",
    project: "pr_1",
    machineId: MACHINE,
    phase: "running",
    golden: "",
    createdAt: "2026-09-01T00:00:00.000Z",
    spec: {},
    size: { cpu: 8, memMb: 16_384 },
    firstLife: true,
    login: { HOME: "/home/dev", PATH: "/usr/bin" },
    daemon: { deployedAt: "2026-09-01T00:00:00.000Z", version: 60 },
  });
  rt = createRuntime({ backend: stubBackend(), store, adapters: {}, ssh: fakeSsh().wiring });
  return rt;
}

describe("the road to a daemon on a machine reached over ssh", () => {
  it("is none: the kind's own sentence to whoever asks, and no port on this computer dialled for the row", async () => {
    const rt = await hostWithOne();
    await expect(rt.workspaces.daemonReach("ws_1a2b3c4d")).rejects.toThrow(noSshDaemonLine("box"));
    // Unsupported is the word for a machine there is no way at all to ask, which is what this kind is now: a
    // row that read anything else would have come off a port this host picked and dialled.
    const [row] = await rt.status.list({ zombieProbe: false });
    expect(row?.reach.state).toBe("unsupported");
  });
});
