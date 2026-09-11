// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { SSH_FACTS_SCRIPT, SSH_READ_SCRIPT, parseSshMachineId } from "@wsp/engine";
import { alreadyRecorded, machineWord, noMachineHomeLine, noSshDaemonLine, OVER_SSH, relayedRecordRefusal, relayedRefusal, sshHostKeyNotice, TURN_TOKEN_ENV, undrivenRefusal, type AdapterEvent, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterContext, type HarnessAdapterFactory, type ProjectImportOptions, type Runtime, type SshWiring } from "../src/runtime.js";
import { memoryStore, type Store } from "../src/store.js";
import { fakeSsh, FAKE_OS, FAKE_UPTIME_S } from "./fake-ssh.js";
import { stubBackend } from "./stub-backend.js";

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
    // The home the machine answered with rides the view, so a client shortens its folders as that login's shell would.
    expect(ws.home).toBe("/home/dev");
    // The size on the row is what the machine answered with, not a default: nothing here bills, so nothing offers one.
    expect((await rt.status.list()).find(r => r.id === ws.id)?.size).toEqual({ cpu: 8, memMb: 16_000 });
    // The record's machine id is the dial itself, so a later host process reaches the same machine from it alone.
    expect(parseSshMachineId(ws.machineId)).toEqual({ user: "dev", host: "box", port: 22 });
    // One dial made the record, and it was the read; the status read above is the second, which is the machine
    // being asked what it is for the rows that say so.
    expect(carried.map(c => c.script)).toEqual([SSH_READ_SCRIPT, SSH_FACTS_SCRIPT]);
    expect((await rt.workspaces.list()).map(w => ({ name: w.name, kind: w.kind }))).toEqual([{ name: "box", kind: "ssh" }]);
  });

  it("the status of a machine somebody owns carries what that machine says it is: its system, its uptime and the folder its commands start in", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("dev@box");
    const status = (await rt.status.list()).find(r => r.id === ws.id);
    expect(status?.facts).toEqual({ os: FAKE_OS, uptimeMs: FAKE_UPTIME_S * 1_000, folder: "/home/dev" });
    // The folder is that machine's own login home, not this computer's and not another machine's.
    const other = await rt.workspaces.createSsh("root@10.0.0.7");
    expect((await rt.status.list()).find(r => r.id === other.id)?.facts?.folder).toBe("/root");
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

  it("a turn over ssh launches with a one-turn token laid over that machine's own login, and no other road on it carries one", async () => {
    const { wiring } = fakeSsh();
    const seen: HarnessAdapterContext[] = [];
    const rt = runtime(wiring, memoryStore(), seen);
    const box = await rt.workspaces.createSsh("dev@box");
    await (await rt.sessions.start(box.id, { prompt: "coordinate" })).finished;
    const launched = seen.filter(c => c.env[TURN_TOKEN_ENV] !== undefined);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.env[TURN_TOKEN_ENV]).toMatch(/^[0-9a-f]{32}$/);
    // The machine's own login is still under it: the token is laid over what the ssh read answered with, not instead.
    expect(launched[0]!.env["HOME"]).toBe("/home/dev");
    expect(launched[0]!.env["PATH"]).toBe("/home/dev/.local/bin:/usr/bin");
    // A machine wsp runs agents on is the sandbox, whoever owns it: IS_SANDBOX=1 rides every road to it, as it does
    // to a cloud fork, so a root login there still takes --dangerously-skip-permissions.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(c => c.env["IS_SANDBOX"] === "1")).toBe(true);
    // Two turns on one machine get two tokens, so neither can be read as the other's thread.
    await (await rt.sessions.start(box.id, { prompt: "coordinate again" })).finished;
    const tokens = seen.map(c => c.env[TURN_TOKEN_ENV]).filter(t => t !== undefined);
    expect(new Set(tokens).size).toBe(2);
  });

  it("a turn reads the store its harness reads on that machine, not the one under its home", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const moved = await rt.workspaces.createSsh("root@moved");
    const plain = await rt.workspaces.createSsh("root@10.0.0.7");
    // The machine's own login shell names CLAUDE_CONFIG_DIR, so the turn reads the folder the person's sign-in is in.
    expect((await (await rt.sessions.start(moved.id, { prompt: "hi" })).finished).text).toContain("/root/.claude-cfg under");
    // A machine that names none keeps the catalog's default under the home it answered with.
    expect((await (await rt.sessions.start(plain.id, { prompt: "hi" })).finished).text).toContain("/root/.claude under");
  });

  it("a home with a space in it runs, because every path built from it is one quoted word", async () => {
    const { wiring, carried } = fakeSsh(script => (script.includes("WSP_LAUNCHED") ? { stdout: "WSP_LAUNCHED\n" } : {}));
    const rt = runtime(wiring);
    const ws = await rt.workspaces.createSsh("john@spaced");
    const stream = await rt.workspaces.execStream(ws.id, ["true"]);
    const launched = async (): Promise<string | undefined> => {
      for (let i = 0; i < 100 && carried.every(c => !c.script.includes("WSP_LAUNCHED")); i++) await new Promise(r => setTimeout(r, 10));
      return carried.map(c => c.script).find(script => script.includes("WSP_LAUNCHED"));
    };
    const script = await launched();
    stream.kill();
    expect(script).toContain("'/Users/John Smith/.wsp/run");
    // With every quoted span cut out, the folder is not there at all: nothing carries it as bare words, where the
    // shell would read the space as the end of the path and a semicolon as the end of the command.
    expect((script ?? "").replace(/'[^']*'/g, "")).not.toContain("/Users/John Smith");
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
    // This host wires no deploy, so nothing put a daemon on the machine and the panes say which verb would.
    await expect(rt.workspaces.daemonReach(ws.id)).rejects.toThrow(noSshDaemonLine("box"));
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

  it("a record with no home for its machine is refused, not run under a folder guessed for it", async () => {
    const { wiring, carried } = fakeSsh();
    const store = memoryStore();
    const rt = runtime(wiring, store);
    const ws = await rt.workspaces.createSsh("dev@box");
    // A record the dial would never have written: the door refuses a machine that names no plain home, so the roads
    // that build a path from it say so in one sentence rather than each landing somewhere of their own.
    const record = (await store.get("workspaces", ws.id)) as { login: Record<string, string> };
    const { HOME: _dropped, ...rest } = record.login;
    await store.put("workspaces", ws.id, { ...record, login: rest });
    const second = runtime(fakeSsh().wiring, store);
    const said = await second.sessions.start(ws.id, { prompt: "hi" }).then(() => "it ran", (e: unknown) => (e as Error).message);
    expect(said).toBe(noMachineHomeLine("box"));
    // Nothing was carried to the machine, and no run folder under a shared /tmp was named.
    expect(carried.every(c => !c.script.includes("/tmp/wsp-run") && !c.script.includes("/tmp/.wsp"))).toBe(true);
  });

  it("an ssh workspace whose dial names this computer answers only this computer, as the local kind does", async () => {
    const { wiring } = fakeSsh();
    const rt = runtime(wiring);
    const here = await rt.workspaces.createSsh("root@127.0.0.1", { name: "loopback" });
    const elsewhere = await rt.workspaces.createSsh("dev@box");
    // It is this computer under another kind's name, so the rule the local kind carries is the rule it gets.
    await expect(rt.workspaces.get(here.id, "relayed")).rejects.toThrow(relayedRefusal("loopback"));
    await expect(rt.workspaces.exec(here.id, "true", undefined, "relayed")).rejects.toThrow(relayedRefusal("loopback"));
    expect((await rt.workspaces.list("relayed")).map(w => w.name)).toEqual(["box"]);
    // Every other machine over ssh is a machine, and a relayed request drives it.
    expect((await rt.workspaces.get(elsewhere.id, "relayed")).name).toBe("box");
    // From this computer both answer.
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["box", "loopback"]);
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
