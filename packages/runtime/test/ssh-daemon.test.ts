// SPDX-License-Identifier: AGPL-3.0-only
// The daemon on a machine reached over ssh, as the runtime holds it: the
// deploy that goes on when the machine is recorded, the road through the
// forward that every pane dials, and the folders and tokens that sit under
// that machine's own login rather than under root.
import { describe, expect, it, vi } from "vitest";
import { DAEMON_VERSION, kindWords, noSshDaemonLine, rootsPathIn, sshDaemonPaths } from "@wsp/protocol";
import { createRuntime, type ProjectImportOptions, type Runtime, type SshWiring } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeSsh, fakeSshDaemon, type FakeSshDaemon } from "./fake-ssh.js";
import { stubBackend } from "./stub-backend.js";

const HOME = "/home/dev";
const AT = sshDaemonPaths(HOME);

const runtime = (ssh: SshWiring, store: Store = memoryStore()): Runtime => createRuntime({ backend: stubBackend(), store, adapters: {}, ssh });

/** A host that reaches machines over ssh and can put a daemon on one, with the machine answering the port file
 * with `port` and everything else with nothing. */
function host(over: { port?: string; refuse?: string; store?: Store } = {}): { rt: Runtime; daemon: FakeSshDaemon; carried: { script: string; stdin?: Uint8Array }[] } {
  const daemon = fakeSshDaemon(over.refuse === undefined ? {} : { refuse: over.refuse });
  const { wiring, carried } = fakeSsh(script => (script.startsWith(`cat '${AT.portFile}'`) ? { stdout: over.port ?? "42891\n" } : {}), daemon);
  return { rt: runtime(wiring, over.store ?? memoryStore()), daemon, carried };
}

describe("the daemon goes on when the machine is recorded", () => {
  it("deploys under the login the machine answered with, and the record keeps that it happened", async () => {
    const { rt, daemon } = host();
    const ws = await rt.workspaces.createSsh("dev@box");
    expect(daemon.deploys).toEqual([{ machineId: "ssh://dev@box:22", home: HOME, path: "/home/dev/.local/bin:/usr/bin" }]);
    // The panes ask the record, not the machine: nothing dials a machine to find out whether one is on it, and
    // the road opens from the moment the deploy landed.
    expect((await rt.workspaces.daemonReach(ws.id)).url).toBe("http://127.0.0.1:40000");
    await rt.close();
  });

  it("leaves the record standing when the machine will not take one, and says which verb puts one on later", async () => {
    const { rt, daemon } = host({ refuse: "this machine has no C compiler" });
    const ws = await rt.workspaces.createSsh("dev@box");
    expect(daemon.deploys).toHaveLength(1);
    // The machine is theirs and already answered the dial: what a failed deploy costs them is the panes.
    expect(ws.notice).toContain("this machine has no C compiler");
    expect(ws.notice).toContain("wsp workspaces daemon update box");
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["box"]);
    // With no daemon on it, the panes are refused with the sentence that names both ways out.
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow(noSshDaemonLine("box"));
    expect((await rt.status.list()).find(r => r.id === ws.id)?.reach.state).toBe("unsupported");
    await rt.close();
  });

  it("records nothing about a daemon on a host that wires none, and refuses the panes the same way", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow(noSshDaemonLine("box"));
    await expect(rt.workspaces.updateDaemon(ws.id)).rejects.toThrow("this runtime cannot deploy a daemon");
    await rt.close();
  });
});

describe("the road to that daemon", () => {
  it("reads the port the machine wrote down and answers with the forwarded one on this computer", async () => {
    const { rt, daemon, carried } = host({ port: "42891\n" });
    const ws = await rt.workspaces.createSsh("dev@box");
    const road = await rt.workspaces.daemonReach(ws.id);
    expect(carried.some(c => c.script === `cat '${AT.portFile}'`)).toBe(true);
    expect(daemon.forwards).toEqual([{ machineId: "ssh://dev@box:22", remotePort: 42891, localPort: 40000, dropped: false }]);
    // The shape a cloud fork's preview route arrives in, so the panes and the status probe read one view.
    expect(road.url).toBe("http://127.0.0.1:40000");
    expect(road.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    // The token rides the view, read off the file under that machine's own home and never off the guest constant.
    expect(carried.some(c => c.script.includes(`${AT.tokenPath}.next`) && c.script.includes(AT.tokenPath))).toBe(true);
    expect(carried.some(c => c.script.includes("/root/.wsp-daemon-token"))).toBe(false);
    await rt.close();
  });

  it("opens one forward however many times the panes dial, and drops it when the workspace goes", async () => {
    const { rt, daemon } = host();
    const ws = await rt.workspaces.createSsh("dev@box");
    await rt.workspaces.daemonReach(ws.id);
    await rt.workspaces.daemonReach(ws.id);
    expect(daemon.forwards).toHaveLength(1);
    await rt.workspaces.delete(ws.id);
    expect(daemon.forwards[0]!.dropped).toBe(true);
    // wsp put the daemon on a machine somebody already owns, so it goes with the record that put it there: what
    // is left standing on their machine is what was on it before wsp reached it.
    expect(daemon.removals).toEqual([{ machineId: "ssh://dev@box:22", home: HOME, path: "/home/dev/.local/bin:/usr/bin" }]);
    await rt.close();
  });

  it("takes nothing off a machine no daemon ever landed on", async () => {
    const { rt, daemon } = host({ refuse: "this machine has no C compiler" });
    const ws = await rt.workspaces.createSsh("dev@box");
    await rt.workspaces.delete(ws.id);
    expect(daemon.removals).toEqual([]);
    await rt.close();
  });

  it("frees every forward when the host closes: a child it started must not outlive it", async () => {
    const { rt, daemon } = host();
    const ws = await rt.workspaces.createSsh("dev@box");
    await rt.workspaces.daemonReach(ws.id);
    expect(daemon.forwards[0]!.dropped).toBe(false);
    await rt.close();
    expect(daemon.closed).toBe(true);
    expect(daemon.forwards[0]!.dropped).toBe(true);
  });

  it("refuses rather than dialling nothing when the machine wrote down no port", async () => {
    const { rt, daemon } = host({ port: "" });
    const ws = await rt.workspaces.createSsh("dev@box");
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow(noSshDaemonLine("box"));
    expect(daemon.forwards).toEqual([]);
    await rt.close();
  });
});

describe("what the daemon on such a machine may browse", () => {
  it("lands a folder over the machine's own byte road and names it beside that machine's home", async () => {
    const { rt, carried } = host();
    const ws = await rt.workspaces.createSsh("dev@box");
    const tar = Buffer.from("a folder, packed");
    const landed = await rt.projects.import({
      workspaceId: ws.id,
      source: "/Users/dev/spoo",
      dest: "/home/dev/spoo",
      bundler: {
        plan: async () => ({ source: "/Users/dev/spoo", repo: false, files: 1, bytes: tar.length, secrets: [], excluded: [], skipped: [], agents: [] }),
        pack: async () => ({ tar, files: 1, bytes: tar.length, cut: [], rewritten: [] }),
      } as unknown as ProjectImportOptions["bundler"],
    });
    expect(landed.dest).toBe("/home/dev/spoo");
    // The bytes went over the connection, since this machine mints no signed URL: one write, the archive on stdin.
    expect(carried.filter(c => c.stdin !== undefined).map(c => c.stdin)).toEqual([new Uint8Array(tar)]);
    // Nothing of wsp's is written in the folder every login on that machine shares.
    expect(carried.filter(c => c.script.includes("/tmp/"))).toEqual([]);
    expect(carried.some(c => c.script.includes(`${AT.wsp}/wsp-vault-in-`))).toBe(true);
    // The roots file the daemon reads sits beside that machine's own home, never beside /root.
    const roots = carried.map(c => c.script).find(s => s.includes(rootsPathIn(HOME)));
    expect(roots).toContain("'/home/dev/spoo'");
    expect(roots).toContain(`mv -f '${rootsPathIn(HOME)}.next' '${rootsPathIn(HOME)}'`);
    expect(carried.some(c => c.script.includes("/root/.wsp/roots"))).toBe(false);
    await rt.close();
  });

  it("says the kind lands folders, reads its load and lists its processes, since the daemon on it does", () => {
    expect(kindWords("ssh")).toMatchObject({ daemon: true, metrics: true, processes: true, imports: "copies" });
  });
});

describe("putting a daemon on a machine already recorded", () => {
  it("deploys again and rotates the token under that machine's own home", async () => {
    const { rt, daemon, carried } = host();
    const ws = await rt.workspaces.createSsh("dev@box");
    const before = carried.length;
    await rt.workspaces.updateDaemon(ws.id);
    expect(daemon.deploys).toHaveLength(2);
    expect(carried.slice(before).some(c => c.script.includes(`test -f ${AT.tokenPath} ||`))).toBe(true);
    await rt.close();
  });

  it("replaces a daemon older than this wsp would deploy, reading the version off the record", async () => {
    const store = memoryStore();
    const first = host({ store });
    const ws = await first.rt.workspaces.createSsh("dev@box");
    await first.rt.close();
    // The machine carries a daemon from an older wsp: the record says which, so nothing is dialled to find out.
    const stored = (await store.get("workspaces", ws.id)) as { daemon: { deployedAt: string; version: number } };
    await store.put("workspaces", ws.id, { ...stored, daemon: { ...stored.daemon, version: DAEMON_VERSION - 1 } });

    const second = host({ store });
    // Hydrating the record settles the daemon: the older one is replaced with this wsp's, and the record moves on.
    expect((await second.rt.workspaces.list()).map(w => w.name)).toEqual(["box"]);
    await vi.waitFor(() => expect(second.daemon.deploys).toHaveLength(1));
    await vi.waitFor(async () => expect(((await store.get("workspaces", ws.id)) as { daemon: { version: number } }).daemon.version).toBe(DAEMON_VERSION));
    await second.rt.close();
  });

  it("marks the record with the daemon this host put there, so a later process knows without dialling", async () => {
    const store = memoryStore();
    const first = host({ store });
    const ws = await first.rt.workspaces.createSsh("dev@box");
    await first.rt.close();
    // A second host process on the same state: the record says a daemon is on the machine, and the road opens.
    const second = host({ store });
    // No deploy ran in this process, and the road still opens: the record is what says a daemon is on the machine.
    expect(second.daemon.deploys).toEqual([]);
    expect((await second.rt.workspaces.daemonReach(ws.id)).url).toBe("http://127.0.0.1:40000");
    await second.rt.close();
    expect(DAEMON_VERSION).toBeGreaterThan(0);
  });
});
