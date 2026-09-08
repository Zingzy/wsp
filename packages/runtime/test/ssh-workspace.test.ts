// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { SSH_READ_SCRIPT, SshBackend, parseSshAddress, parseSshMachineId, sshIdentity, sshMachineName, type ExecResult, type SshReach, type SshTransport } from "@wsp/engine";
import { OVER_SSH, alreadyRecorded, machineWord, relayedRecordRefusal, relayedRefusal, sshHostKeyNotice, undrivenRefusal, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterContext, type HarnessAdapterFactory, type Runtime, type SshWiring } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend } from "./stub-backend.js";

/** Two machines a person could reach over ssh, each with a home and a PATH of its own, so a road that reads one
 * machine's facts for another is a failure rather than a coincidence. */
const MACHINES: Record<string, { home: string; user: string; path: string; cpu: number; memkb: number; key: string }> = {
  box: { home: "/home/dev", user: "dev", path: "/home/dev/.local/bin:/usr/bin", cpu: 8, memkb: 16_384_000, key: "ssh-ed25519 SHA256:boxboxboxboxboxboxboxboxboxboxboxboxbox" },
  // The same machine as box, under the address a person might use for it instead: one machine, one host key.
  "10.0.0.9": { home: "/home/dev", user: "dev", path: "/home/dev/.local/bin:/usr/bin", cpu: 8, memkb: 16_384_000, key: "ssh-ed25519 SHA256:boxboxboxboxboxboxboxboxboxboxboxboxbox" },
  "10.0.0.7": { home: "/root", user: "root", path: "/root/.bun/bin:/usr/bin", cpu: 2, memkb: 4_096_000, key: "ssh-ed25519 SHA256:sevensevensevensevensevensevenseven" },
};

/** An ssh client that never leaves this computer: each machine answers the read with its own facts, every script it
 * was asked to carry is recorded, and a case scripts the answers. */
function fakeSsh(answer: (script: string, reach: SshReach) => Partial<ExecResult> = () => ({})): { wiring: SshWiring; carried: { reach: SshReach; script: string }[] } {
  const carried: { reach: SshReach; script: string }[] = [];
  const transport: SshTransport = async (reach, script, opts) => {
    carried.push({ reach, script });
    const machine = MACHINES[reach.host];
    if (machine === undefined) return { exitCode: 255, stdout: "", stderr: `ssh: Could not resolve hostname ${reach.host}\n` };
    if (script === SSH_READ_SCRIPT) {
      // The client logs what the connection saw on stderr when the read asks it to; that is where the host key is read.
      const log = opts.hostKey === true ? `debug1: Server host key: ${machine.key}\ndebug1: Authenticating to ${reach.host}\n` : "";
      return { exitCode: 0, stdout: `home ${machine.home}\nuser ${machine.user}\npath ${machine.path}\ncpu ${machine.cpu}\nmemkb ${machine.memkb}\n`, stderr: log };
    }
    return { exitCode: 0, stdout: "", stderr: "", ...answer(script, reach) };
  };
  const backend = new SshBackend({ transport });
  return {
    wiring: {
      backend,
      adopt: async (address, opts) => {
        const reach = parseSshAddress(address, opts);
        const { machine, login, shape, hostKey } = await backend.adopt(reach);
        return { machine, name: sshMachineName(reach), login, shape, ...(hostKey !== undefined ? { identity: sshIdentity(hostKey, login.USER), hostKey } : {}) };
      },
    },
    carried,
  };
}

/** A scripted harness: it answers with the home and the PATH it was handed, so what lands in the chat is what the
 * runtime told the adapter about the machine the thread runs on. */
function scriptedAdapter(seen: HarnessAdapterContext[]): HarnessAdapterFactory {
  return ctx => {
    seen.push(ctx);
    return {
      steers: false,
      start: ({ onEvent }) => {
        const sessionId = "11111111-1111-4111-8111-111111111111";
        const result: TurnResult = { status: "completed", text: `${ctx.home("claude")} under ${ctx.env["PATH"] ?? "no path"}` };
        const finished = (async () => {
          const feed: AdapterEvent[] = [
            { type: "session.start", sessionId },
            { type: "turn.done", sessionId, result },
            { type: "session.end", sessionId, exitCode: 0, sawResult: true },
          ];
          for (const e of feed) onEvent(e);
          return result;
        })();
        return { localId: sessionId, finished, interrupt: async () => {} };
      },
    };
  };
}

describe("ssh workspace", () => {
  const runtime = (ssh: SshWiring, store: Store = memoryStore(), seen: HarnessAdapterContext[] = []): Runtime =>
    createRuntime({ backend: stubBackend(), store, adapters: { claude: scriptedAdapter(seen) }, ssh });

  it("wsp new --ssh records a machine that already exists: kind ssh, its own name, no image, the size it answered with", async () => {
    const { wiring, carried } = fakeSsh();
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    expect(ws.kind).toBe("ssh");
    expect(ws.name).toBe("box");
    expect(ws.golden).toBe("");
    expect(ws.phase).toBe("running");
    // The size on the row is what the machine answered with, not a default: nothing here bills, so nothing offers one.
    expect((await rt.status.list()).find(r => r.id === ws.id)?.size).toEqual({ cpu: 8, memMb: 16_000 });
    // The record's machine id is the dial itself, so a later host process reaches the same machine from it alone.
    expect(parseSshMachineId(ws.machineId)).toEqual({ user: "dev", host: "box", port: 22 });
    // One dial made the record, and it was the read.
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT]);
    expect((await rt.workspaces.list()).map(w => ({ name: w.name, kind: w.kind }))).toEqual([{ name: "box", kind: "ssh" }]);
  });

  it("the port and the key the person named ride the dial and the record", async () => {
    const { wiring, carried } = fakeSsh();
    const ws = await runtime(wiring).workspaces.createSsh("dev@box:2222", { name: "mine", keyPath: "/tmp/k/id_ed25519" });
    expect(ws.name).toBe("mine");
    expect(parseSshMachineId(ws.machineId)).toEqual({ user: "dev", host: "box", port: 2222, keyPath: "/tmp/k/id_ed25519" });
    expect(carried[0]?.reach).toEqual({ user: "dev", host: "box", port: 2222, keyPath: "/tmp/k/id_ed25519" });
  });

  it("a machine that does not answer the dial leaves no record and no held name", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    await expect(rt.workspaces.createSsh("dev@nowhere")).rejects.toThrow("did not answer over ssh");
    expect(await rt.workspaces.list()).toEqual([]);
    // The name the failed dial would have taken is free, and the same address works once the machine answers.
    expect((await rt.workspaces.createSsh("dev@box", { name: "nowhere" })).name).toBe("nowhere");
  });

  it("one workspace stands on one machine, whatever address, port or key it was recorded under", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const box = await rt.workspaces.createSsh("dev@box");
    // The machine answers with the same host key each time, so none of these is a second machine: a second key to
    // get in with, a second address for the same host, and a second port to the same sshd.
    await expect(rt.workspaces.createSsh("dev@box", { name: "again", keyPath: "/tmp/k/other" })).rejects.toThrow(alreadyRecorded(OVER_SSH, "box"));
    await expect(rt.workspaces.createSsh("dev@10.0.0.9", { name: "by-address" })).rejects.toThrow(alreadyRecorded(OVER_SSH, "box"));
    await expect(rt.workspaces.createSsh("dev@box:2222", { name: "by-port" })).rejects.toThrow(alreadyRecorded(OVER_SSH, "box"));
    // Two records on one machine would share its home, so one workspace's sweep would end the other's turns.
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["box"]);
    const second = await rt.workspaces.createSsh("root@10.0.0.7");
    expect(second.name).toBe("10.0.0.7");
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["10.0.0.7", "box"]);
    // The name the first record holds is still its own, and the machine it stands on is still reachable.
    expect((await rt.workspaces.get(box.id)).name).toBe("box");
  });

  it("the key the machine answered with is said once, where the person can compare it", async () => {
    const { wiring } = fakeSsh();
    const created = await runtime(wiring).workspaces.createSsh("dev@box");
    expect(created.notice).toBe(sshHostKeyNotice("ssh-ed25519 SHA256:boxboxboxboxboxboxboxboxboxboxboxboxbox"));
  });

  it("a request relayed from a machine records nothing and dials nothing: recording is this computer's own act", async () => {
    const { wiring, carried } = fakeSsh();
    const rt = runtime(wiring);
    // The kind takes relayed requests once it is recorded, and that is not the same as making one: the address and
    // the key would be the machine's to pick, and it could name this computer.
    await expect(rt.workspaces.createSsh("zingzy@127.0.0.1", { keyPath: "/Users/zingzy/.ssh/id_ed25519" }, "relayed")).rejects.toThrow(relayedRecordRefusal("zingzy@127.0.0.1"));
    expect(await rt.workspaces.list()).toEqual([]);
    // Nothing was dialled either: the refusal is read before the address the machine named reaches the ssh client.
    expect(carried).toEqual([]);
    // The same call from this computer records it, and the workspace it made takes relayed requests as a machine does.
    const ws = await rt.workspaces.createSsh("dev@box");
    expect((await rt.workspaces.get(ws.id, "relayed")).name).toBe("box");
  });

  it("a thread runs on the machine the workspace names, under that machine's own home and PATH", async () => {
    const { wiring } = fakeSsh();
    const seen: HarnessAdapterContext[] = [];
    const rt = runtime(wiring, memoryStore(), seen);
    const box = await rt.workspaces.createSsh("dev@box");
    const other = await rt.workspaces.createSsh("root@10.0.0.7");
    expect((await (await rt.sessions.start(box.id, { prompt: "hi" })).finished).text).toBe("/home/dev/.claude under /home/dev/.local/bin:/usr/bin");
    // The second machine's turn reads the second machine's facts: the seam is per workspace, not per kind.
    expect((await (await rt.sessions.start(other.id, { prompt: "hi" })).finished).text).toBe("/root/.claude under /root/.bun/bin:/usr/bin");
    expect(seen.every(c => c.env["USER"] === "dev" || c.env["USER"] === "root")).toBe(true);
  });

  it("exec runs on the machine over the connection and answers with its exit code", async () => {
    const { wiring, carried } = fakeSsh(script => (script === "exit 4" ? { exitCode: 4 } : { stdout: "pong" }));
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    expect((await rt.workspaces.exec(ws.id, "exit 4")).exitCode).toBe(4);
    expect((await rt.workspaces.exec(ws.id, "printf pong")).stdout).toBe("pong");
    expect(carried.map(c => c.script).slice(1)).toEqual(["exit 4", "printf pong"]);
  });

  it("a turn's run files land under the machine's own home, not a folder every login on it shares", async () => {
    const { wiring, carried } = fakeSsh(script => (script.includes("WSP_LAUNCHED") ? { stdout: "WSP_LAUNCHED\n" } : {}));
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    const stream = await rt.workspaces.execStream(ws.id, ["true"]);
    const launch = async (): Promise<string | undefined> => {
      for (let i = 0; i < 100 && carried.every(c => !c.script.includes("WSP_LAUNCHED")); i++) await new Promise(r => setTimeout(r, 10));
      return carried.map(c => c.script).find(script => script.includes("WSP_LAUNCHED"));
    };
    const script = await launch();
    stream.kill();
    expect(script).toContain("/home/dev/.wsp/run/");
    expect(script).not.toContain("/tmp/wsp-run");
  });

  it("every verb its machine cannot take refuses with the kind's own sentence", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    const cannot = (action: string): string => undrivenRefusal("box", OVER_SSH, action);
    await expect(rt.workspaces.nap(ws.id)).rejects.toThrow(cannot("be paused"));
    await expect(rt.workspaces.upgrade(ws.id, { cpu: 4, memMb: 8192 })).rejects.toThrow(cannot("be resized"));
    await expect(rt.workspaces.rebuild(ws.id)).rejects.toThrow(cannot("be rebuilt"));
    await expect(rt.workspaces.updateImage(ws.id)).rejects.toThrow(cannot("move to a newer image"));
    await expect(rt.workspaces.snapshot(ws.id)).rejects.toThrow(cannot("be snapshotted"));
    // A machine wsp does not run is running while the person keeps it on: the wake every thread road sends is a no-op.
    expect((await rt.workspaces.wake(ws.id)).phase).toBe("running");
    // Its terminal, files and ports have no road yet, and the refusal says which machine and why.
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow("box is reached over ssh, which carries no daemon yet");
  });

  it("a machine is a machine: a request relayed from one drives an ssh workspace and sees it in the lists", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    expect((await rt.workspaces.get(ws.id, "relayed")).name).toBe("box");
    expect((await rt.workspaces.list("relayed")).map(w => w.name)).toEqual(["box"]);
    await rt.workspaces.touch(ws.id, "relayed");
    // And the sentence a kind that refuses one gives is not this kind's: nothing here reads it.
    expect(relayedRefusal("box")).not.toContain(OVER_SSH);
  });

  it("delete drops the record and frees the name; the machine is the person's and is never stopped", async () => {
    const { wiring, carried } = fakeSsh();
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    await rt.workspaces.delete(ws.id);
    expect(await rt.workspaces.list()).toEqual([]);
    // Nothing was carried to the machine to stop it: the read that recorded it is still the only script it ran.
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT]);
    expect((await rt.workspaces.createSsh("dev@box")).name).toBe("box");
  });

  it("the record alone reaches the machine again: a second host process drives it with no dial of its own", async () => {
    const { wiring } = fakeSsh();
    const store = memoryStore();
    const first = runtime(wiring, store);
    const ws = await first.workspaces.createSsh("dev@box");
    const second = runtime(fakeSsh().wiring, store);
    const rehydrated = (await second.workspaces.list()).find(w => w.id === ws.id);
    expect(rehydrated?.kind).toBe("ssh");
    expect((await (await second.sessions.start(ws.id, { prompt: "hi" })).finished).text).toBe("/home/dev/.claude under /home/dev/.local/bin:/usr/bin");
  });

  it("a host that wires no ssh backend serves no ssh workspace and says so", async () => {
    const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
    await expect(rt.workspaces.createSsh("dev@box")).rejects.toThrow("this host has no ssh backend wired");
  });

  it("the kind's word is the one every sentence and row reads", () => {
    expect(machineWord("ssh")).toBe(OVER_SSH);
  });
});
