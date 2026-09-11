// SPDX-License-Identifier: AGPL-3.0-only
// The daemon on a machine reached over ssh, as the runtime holds it: the
// deploy that goes on when the machine is recorded, the road through the
// forward that every pane dials, and the folders and tokens that sit under
// that machine's own login rather than under root.
import { describe, expect, it, vi } from "vitest";
import { DAEMON_INSTALL_FAILED, DAEMON_INSTALLING, DAEMON_UPDATE_FAILED, DAEMON_UPDATING, DAEMON_VERSION, kindWords, NO_BUILD_TOOLS_LINE, noSshDaemonLine, rootsPathIn, sshDaemonPaths, type WorkspaceStatus } from "@wsp/protocol";
import type { Clock } from "../src/clock.js";
import { createRuntime, DAEMON_LACKS_AGAIN_MS, type ProjectImportOptions, type Runtime, type SshWiring } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeClock } from "./fake-clock.js";
import { fakeSsh, fakeSshDaemon, type FakeSshDaemon } from "./fake-ssh.js";
import { stubBackend } from "./stub-backend.js";

const HOME = "/home/dev";
const AT = sshDaemonPaths(HOME);

/** A token this test can look for. Every account on a machine somebody owns can read a running command, so what
 * is checked below is that no command ever carries this string. */
const TOKEN = "d0d0cafed0d0cafed0d0cafe";

const runtime = (ssh: SshWiring, store: Store = memoryStore(), clock?: Clock): Runtime =>
  createRuntime({ backend: stubBackend(), store, adapters: {}, ssh, daemonToken: TOKEN, ...(clock !== undefined ? { clock } : {}) });

/** A host that reaches machines over ssh and can put a daemon on one, with the machine answering the port file
 * with `port` and everything else with nothing. */
function host(over: { port?: string; refuse?: string; lacks?: boolean; refuseRemoval?: string; store?: Store; clock?: Clock } = {}): { rt: Runtime; daemon: FakeSshDaemon; carried: { script: string; stdin?: Uint8Array }[] } {
  const daemon = fakeSshDaemon({
    ...(over.refuse !== undefined ? { refuse: over.refuse } : {}),
    ...(over.lacks !== undefined ? { lacks: over.lacks } : {}),
    ...(over.refuseRemoval !== undefined ? { refuseRemoval: over.refuseRemoval } : {}),
  });
  const { wiring, carried } = fakeSsh(script => (script.startsWith(`cat '${AT.portFile}'`) ? { stdout: over.port ?? "42891\n" } : {}), daemon);
  return { rt: runtime(wiring, over.store ?? memoryStore(), over.clock), daemon, carried };
}

describe("the daemon goes on when the machine is recorded", () => {
  it("deploys under the login the machine answered with, and the record keeps that it happened", async () => {
    const { rt, daemon } = host();
    const ws = await rt.workspaces.createSsh("dev@box");
    expect(daemon.deploys).toEqual([{ machineId: "ssh://dev@box:22", home: HOME, path: "/home/dev/.local/bin:/usr/bin" }]);
    // The panes ask the record, not the machine: nothing dials a machine to find out whether one is on it, and
    // the road opens from the moment the deploy landed.
    expect((await rt.workspaces.daemonReach(ws.id)).url).toBe("http://127.0.0.1:40000");
    // hasDaemon's true half, which reachOf and the status closure both read: a machine that has one is probed
    // rather than parked at the word a kind with no road gets. Nothing answers the probe in this process, so
    // what it must not be is unsupported.
    expect((await rt.status.list()).find(r => r.id === ws.id)?.reach.state).not.toBe("unsupported");
    await rt.close();
  });

  it("leaves the record standing when the machine will not take one, and says the host tries again", async () => {
    const { rt, daemon } = host({ refuse: "this machine has no C compiler" });
    const ws = await rt.workspaces.createSsh("dev@box");
    expect(daemon.deploys).toHaveLength(1);
    // The machine is theirs and already answered the dial: what a failed deploy costs them is the panes.
    expect(ws.notice).toContain("this machine has no C compiler");
    expect(ws.notice).toContain("this host offers it again later on its own");
    // No line names a verb nobody can type: nothing puts a daemon on a machine already recorded by hand.
    expect(ws.notice).not.toContain("daemon update");
    expect(noSshDaemonLine("box")).not.toContain("daemon update");
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
    // The token rides the view, and the file it came from is under that machine's own home, never the guest constant.
    expect(road.daemonToken).toBe(TOKEN);
    expect(carried.some(c => c.script.includes(`test -f '${AT.tokenPath}'`))).toBe(true);
    expect(carried.some(c => c.script.includes("/root/.wsp-daemon-token"))).toBe(false);
    // No command on that machine ever names it: a command sits in /proc/<pid>/cmdline while it runs and every
    // account there can read it, so the token travels the connection's stdin and the script names only the path.
    expect(carried.filter(c => c.script.includes(TOKEN))).toEqual([]);
    expect(carried.filter(c => c.stdin !== undefined && new TextDecoder().decode(c.stdin) === TOKEN)).toHaveLength(1);
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

  it("sweeps a machine whose deploy never finished, since what it landed first is still there", async () => {
    const { rt, daemon } = host({ refuse: "npm install failed" });
    const ws = await rt.workspaces.createSsh("dev@box");
    expect(((await rt.workspaces.list()).find(w => w.id === ws.id) as { daemon?: unknown } | undefined)?.daemon).toBeUndefined();
    await rt.workspaces.delete(ws.id);
    // The record names no daemon, and the sweep runs anyway: a deploy that failed partway had already landed the
    // bundle and the token, and nothing of wsp's may outlive the record that put it there.
    expect(daemon.removals).toEqual([{ machineId: "ssh://dev@box:22", home: HOME, path: "/home/dev/.local/bin:/usr/bin" }]);
    await rt.close();
  });

  it("frees the forward even when the machine will not let go of its daemon", async () => {
    const { rt, daemon } = host({ refuseRemoval: "the machine did not answer over ssh" });
    const ws = await rt.workspaces.createSsh("dev@box");
    await rt.workspaces.daemonReach(ws.id);
    await rt.workspaces.delete(ws.id);
    // The removal was tried and failed; the child holding the road is this host's own either way, and a port it
    // keeps for a workspace nobody can name is a port held until the host exits.
    expect(daemon.removals).toHaveLength(1);
    expect(daemon.forwards[0]!.dropped).toBe(true);
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
    // The bytes went over the connection, since this machine mints no signed URL: the archive whole, on stdin,
    // under a script that names the path it lands at and nothing of what is in it.
    const wrote = carried.filter(c => c.stdin !== undefined && new TextDecoder().decode(c.stdin) === tar.toString());
    expect(wrote).toHaveLength(1);
    expect(wrote[0]!.script).toContain(`${AT.wsp}/wsp-vault-in-`);
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
    // The rotation looks for the file and then lands the new token's bytes; it never writes the token into a command.
    const after = carried.slice(before);
    expect(after.some(c => c.script.includes(`test -f '${AT.tokenPath}'`))).toBe(true);
    expect(after.filter(c => c.script.includes(TOKEN))).toEqual([]);
    expect(after.filter(c => c.stdin !== undefined && new TextDecoder().decode(c.stdin) === TOKEN)).toHaveLength(1);
    await rt.close();
  });

  it("puts one on a machine whose first deploy failed, at the next host start, since nothing a person types does", async () => {
    const store = memoryStore();
    const first = host({ store, refuse: "this machine has no C compiler" });
    const ws = await first.rt.workspaces.createSsh("dev@box");
    await first.rt.close();
    expect(((await store.get("workspaces", ws.id)) as { daemon?: unknown }).daemon).toBeUndefined();

    // The machine can take one now. The host settles it on hydrate with nobody asking.
    const second = host({ store });
    expect((await second.rt.workspaces.list()).map(w => w.name)).toEqual(["box"]);
    await vi.waitFor(() => expect(second.daemon.deploys).toHaveLength(1));
    await vi.waitFor(async () => expect(((await store.get("workspaces", ws.id)) as { daemon: { version: number } }).daemon.version).toBe(DAEMON_VERSION));
    await second.rt.close();
  });

  it("leaves a machine that answered with what it lacks alone at the next host start, and offers again once its window is out", async () => {
    const store = memoryStore();
    const fc = fakeClock();
    const refusing = { store, clock: fc.clock, refuse: NO_BUILD_TOOLS_LINE, lacks: true };
    const first = host(refusing);
    const ws = await first.rt.workspaces.createSsh("dev@box");
    expect(first.daemon.deploys).toHaveLength(1);
    await first.rt.close();
    // That the machine refused is on the record, so the next process knows without asking the machine again.
    expect(((await store.get("workspaces", ws.id)) as { daemonRefusedAt?: { machineId: string } }).daemonRefusedAt?.machineId).toBe("ssh://dev@box:22");

    const soon = host(refusing);
    expect((await soon.rt.workspaces.list()).map(w => w.name)).toEqual(["box"]);
    // The sync runs detached from hydrate, so the nothing below is given far longer than the deploy at the end of
    // this test takes to show up.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(soon.daemon.deploys).toEqual([]);
    await soon.rt.close();

    // Not never, though: the compiler is theirs to install and nothing on their machine tells this host they did.
    fc.advance(DAEMON_LACKS_AGAIN_MS);
    const later = host(refusing);
    await later.rt.workspaces.list();
    await vi.waitFor(() => expect(later.daemon.deploys).toHaveLength(1));
    await later.rt.close();
  });

  it("stops saying a machine lacks something once a deploy gets past its checks, however that deploy ends", async () => {
    const store = memoryStore();
    const fc = fakeClock();
    const first = host({ store, clock: fc.clock, refuse: NO_BUILD_TOOLS_LINE, lacks: true });
    const ws = await first.rt.workspaces.createSsh("dev@box");
    expect(((await store.get("workspaces", ws.id)) as { daemonRefusedAt?: unknown }).daemonRefusedAt).toBeDefined();
    await first.rt.close();

    // The compiler is on it now and the deploy fails further in, on npm. Whatever else is wrong, the machine no
    // longer lacks what it named, so the record stops saying it does and the next start is free to try again.
    fc.advance(DAEMON_LACKS_AGAIN_MS);
    const second = host({ store, clock: fc.clock, refuse: "daemon deploy failed: NPM_FAIL" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await second.rt.workspaces.list();
      await vi.waitFor(async () => expect(((await store.get("workspaces", ws.id)) as { daemonRefusedAt?: unknown }).daemonRefusedAt).toBeUndefined());
    } finally {
      warn.mockRestore();
    }
    await second.rt.close();
  });

  it("drops a refusal another machine gave, so a machine swapped under the record answers for itself", async () => {
    const store = memoryStore();
    const fc = fakeClock();
    const refusing = { store, clock: fc.clock, refuse: NO_BUILD_TOOLS_LINE, lacks: true };
    const first = host(refusing);
    const ws = await first.rt.workspaces.createSsh("dev@box");
    await first.rt.close();

    // The record now stands on a different machine, with the last one's sentence still on it. Inside the window,
    // so what is proved is the machine check and not the clock.
    const stored = (await store.get("workspaces", ws.id)) as { daemonRefusedAt: { machineId: string } };
    stored.daemonRefusedAt.machineId = "ssh://dev@other:22";
    await store.put("workspaces", ws.id, stored);

    const next = host(refusing);
    await next.rt.workspaces.list();
    await vi.waitFor(() => expect(next.daemon.deploys).toHaveLength(1));
    // The old machine's sentence is off the record; this machine's own went on in its place.
    await vi.waitFor(async () => expect(((await store.get("workspaces", ws.id)) as { daemonRefusedAt: { machineId: string } }).daemonRefusedAt.machineId).toBe("ssh://dev@box:22"));
    await next.rt.close();
  });

  it("says what the machine lacks, rather than that a helper it never had is being updated", async () => {
    const store = memoryStore();
    const fc = fakeClock();
    const refusing = { store, clock: fc.clock, refuse: NO_BUILD_TOOLS_LINE, lacks: true };
    const first = host(refusing);
    const ws = await first.rt.workspaces.createSsh("dev@box");
    await first.rt.close();
    fc.advance(DAEMON_LACKS_AGAIN_MS);

    const second = host(refusing);
    const said: (string | undefined)[] = [];
    second.rt.events.on("workspace.status", e => said.push((e as { status: WorkspaceStatus }).status.daemonNote));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await second.rt.workspaces.list();
      await vi.waitFor(() => expect(said).toContain(NO_BUILD_TOOLS_LINE));
    } finally {
      warn.mockRestore();
    }
    // The row names the thing the machine has not got, which is the one line a person can act on, and nothing in
    // it calls this an update: there was no daemon on that machine to update.
    expect(said).toContain(DAEMON_INSTALLING);
    expect(said).not.toContain(DAEMON_UPDATING);
    expect(said).not.toContain(DAEMON_UPDATE_FAILED);
    // Said once. The next poll shows the machine's own facts again.
    expect((await second.rt.workspaces.get(ws.id)).daemonNote).toBeUndefined();
    await second.rt.close();

    // A machine that took the checks and fell over later gives an npm log, which is hundreds of characters of
    // nothing a person reading a row can act on: that one gets the fixed line and the log goes to this host's own.
    fc.advance(DAEMON_LACKS_AGAIN_MS);
    const third = host({ store, clock: fc.clock, refuse: "daemon deploy failed: NPM_FAIL" });
    const later: (string | undefined)[] = [];
    third.rt.events.on("workspace.status", e => later.push((e as { status: WorkspaceStatus }).status.daemonNote));
    const quiet = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await third.rt.workspaces.list();
      await vi.waitFor(() => expect(later).toContain(DAEMON_INSTALL_FAILED));
    } finally {
      quiet.mockRestore();
    }
    expect(later.every(line => line === undefined || !line.includes("NPM_FAIL"))).toBe(true);
    await third.rt.close();
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
