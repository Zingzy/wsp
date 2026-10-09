// SPDX-License-Identifier: AGPL-3.0-only
// What a pane of a thread in a folder on a computer the person joined carries
// over that computer's one link, and what an add there leaves when it fails.
// The daemon there answers for the whole computer as root, so the channel
// holds a pane to its own folder and its own ptys, reads the computer's ports,
// load and processes for it through watches it shares with every pane there
// (box-panels.test.ts), and refuses a command before the link.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forkOpRefusedLine, rootsPathIn, type DaemonFrame } from "@wsp/protocol";
import { fakeProcTree } from "../../daemon/test/fake-proc.js";
import { daemonUnderTest } from "../../daemon/test/harness.js";
import { openDaemonChannel } from "../src/daemon-channel.js";
import { until } from "./until.js";
import { handedLine, joined } from "./box-fixture.js";

/** A project folder's record on hetzner and a channel into it, with every event the channel hands its pane. */
async function pane() {
  const { rt, project, seen, placeId } = await joined();
  const at = await rt.workspaces.folderFor({ project: project.id });
  const heard: Record<string, unknown>[] = [];
  const channel = await rt.workspaces.daemonChannel(at.workspace.id, e => heard.push(e));
  const sent = (op: string): Record<string, unknown>[] => seen.frames.filter(f => f["op"] === op);
  return { rt, seen, placeId, channel, heard, sent, folder: project.path };
}

describe("a pane of a thread in a folder on a computer you joined", () => {
  it("opens with the folder's own hello, its shell in the project folder, reads that computer's load for it, and lets its ptys go when it closes", async () => {
    const { seen, channel, heard, sent, folder } = await pane();
    expect(folder).toBe("/root/spoo-ts");
    expect(heard).toEqual([expect.objectContaining({ type: "daemon.hello", root: folder })]);

    // The first tab names no folder, and the daemon there would open it in its own home: the folder is filled in.
    const created = await channel.send({ op: "pty.create", cols: 80, rows: 24 });
    expect(sent("pty.create").at(-1)).toMatchObject({ op: "pty.create", cwd: folder, cols: 80 });
    // The daemon answers for the computer itself, so the frame names no machine.
    expect(sent("pty.create").at(-1)).not.toHaveProperty("machineId");
    const own = await channel.send({ op: "pty.create", cols: 80, rows: 24, cwd: `${folder}/docs` });
    expect(sent("pty.create").at(-1)).toMatchObject({ cwd: `${folder}/docs` });
    const killed = await channel.send({ op: "pty.create", cols: 80, rows: 24 });

    // The load that daemon reads is the whole computer's, which a box thread's Computer panel shows: asked once up
    // the link, which keeps sending it for as long as it stands.
    expect(await channel.send({ op: "sys.watch" })).toMatchObject({ ok: true });
    expect(await channel.send({ op: "sys.watch" })).toMatchObject({ ok: true });
    expect(sent("sys.watch")).toHaveLength(1);

    // A pty of another pane on that computer is not this channel's to read.
    const ptyId = String((created as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId });
    seen.push({ type: "pty.data", ptyId: "p99", data: "another pane's" });
    seen.push({ type: "pty.data", ptyId, data: "hello" });
    await until(() => heard.length > 1);
    expect(heard.slice(1)).toEqual([{ type: "pty.data", ptyId, data: "hello" }]);

    // A shell that ended and one this pane killed hold no listener worth taking off; the shell that stands does.
    const exited = String((own as Record<string, unknown>)["ptyId"]);
    const gone = String((killed as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId: exited });
    await channel.send({ op: "pty.attach", ptyId: gone });
    await channel.send({ op: "pty.kill", ptyId: gone });
    seen.push({ type: "pty.exit", ptyId: exited, exitCode: 0 });
    await until(() => heard.some(e => e["type"] === "pty.exit"));

    // Every pane on that computer rides the one link, so a pane that closes takes its own listeners off.
    channel.close();
    await until(() => sent("pty.detach").length > 0);
    expect(sent("pty.detach")).toEqual([expect.objectContaining({ ptyId })]);
  });

  it("sends the computer's process watch, reads and kills up the link naming no machine, since the thread is root there", async () => {
    const { channel, sent } = await pane();
    for (const frame of [{ op: "proc.watch" }, { op: "proc.inspect", pid: 900 }, { op: "proc.kill", pid: 900, signal: "TERM" }]) {
      expect(await channel.send(frame)).toMatchObject({ ok: true });
      expect(sent(frame.op).at(-1)).toMatchObject(frame);
      expect(sent(frame.op).at(-1)).not.toHaveProperty("machineId");
    }
    channel.close();
  });

  it("keeps the readings the computer's own page watches over the shared link off the pane", async () => {
    const { seen, channel, heard } = await pane();
    const ptyId = String(((await channel.send({ op: "pty.create", cols: 80, rows: 24 })) as Record<string, unknown>)["ptyId"]);
    await channel.send({ op: "pty.attach", ptyId });
    seen.push({ type: "proc.snapshot", at: 1, procs: [{ pid: 1, ppid: 0, comm: "init" }] });
    seen.push({ type: "sys.sample", at: 1 });
    seen.push({ type: "ports.changed", ports: [22] });
    seen.push({ type: "pty.data", ptyId, data: "after" });
    await until(() => heard.some(e => e["type"] === "pty.data"));
    expect(heard.map(e => e["type"])).toEqual(["daemon.hello", "pty.data"]);
    channel.close();
  });

  it("refuses a command on the pane's channel before anything reaches the computer, which runs it as root", async () => {
    const { seen, channel } = await pane();
    const before = seen.execs.length;
    expect(await channel.send({ op: "exec", cmd: "kill -9 1" })).toMatchObject({ ok: false, code: "unsupported", error: forkOpRefusedLine("exec", "spoo-ts", "hetzner") });
    expect(seen.execs).toHaveLength(before);
    channel.close();
  });

  it("sends a page's frame up the link under the link's own id, so it cannot answer another request there", async () => {
    const { channel, sent, folder } = await pane();
    const asking = channel.send({ op: "git.status", cwd: folder, id: 4242 });
    await until(() => sent("git.status").length > 0);
    expect(sent("git.status")[0]!["id"]).not.toBe(4242);
    expect(await asking).toMatchObject({ ok: true, branch: { head: "main" } });
    channel.close();
  });
});

describe("a terminal of a thread in a folder on a computer you joined", () => {
  it("starts in the project folder there when the pane names none, as a real shell prints it", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsp-box-home-"));
    const inbox = mkdtempSync(join(tmpdir(), "wsp-box-inbox-"));
    const procRoot = fakeProcTree([]);
    const daemon = await daemonUnderTest({ host: "127.0.0.1", port: 0, token: "box-token", inbox, rootsPath: rootsPathIn(inbox), procRoot });
    try {
      let push = (_event: Record<string, unknown>): void => {};
      const real = await openDaemonChannel({ url: `ws://127.0.0.1:${daemon.port}`, token: "box-token", onEvent: event => push(event) });
      const { rt, project, seen } = await joined({ login: { home, owner: "root" }, ptys: async frame => (await real.send(frame as DaemonFrame)) as Record<string, unknown> });
      push = event => void (String(event["type"]).startsWith("pty.") && seen.push(event));
      mkdirSync(project.path);
      const at = await rt.workspaces.folderFor({ project: project.id });
      const heard: Record<string, unknown>[] = [];
      const channel = await rt.workspaces.daemonChannel(at.workspace.id, e => heard.push(e));
      const created = (await channel.send({ op: "pty.create", cols: 200, rows: 24, shell: "/bin/sh" })) as Record<string, unknown>;
      expect(created).toMatchObject({ ok: true });
      const ptyId = String(created["ptyId"]);
      await channel.send({ op: "pty.attach", ptyId });
      await channel.send({ op: "pty.write", ptyId, data: "echo at-$(pwd)-mark\r" });
      const printed = (): string => heard.filter(e => e["type"] === "pty.data" && e["ptyId"] === ptyId).map(e => String(e["data"])).join("");
      await until(() => /at-\/\S*-mark/.test(printed()), 10_000);
      expect(/at-(\/\S*)-mark/.exec(printed())![1]).toBe(project.path);
      channel.close();
      real.close();
    } finally {
      await daemon.close();
      for (const dir of [home, inbox, procRoot]) rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("an add on a computer you joined that fails", () => {
  it("sweeps the folder it claimed as the login, and that folder alone, and records nothing", async () => {
    const { rt, seen } = await joined({ login: { home: "/home/maya", owner: "maya" }, taken: ["/home/maya/spoo-ts"], failClone: true });
    await expect(rt.projects.add({ source: "https://github.com/spoo-me/spoo-ts", on: "hetzner", name: "spoo-ts" })).rejects.toThrow();
    const sweeps = seen.execs.filter(e => handedLine(e.cmd).includes("rm -rf --"));
    expect(sweeps).toHaveLength(1);
    // Handed to the login, so root never removes by name in a folder the login could have put a link in.
    expect(sweeps[0]!.cmd).toMatch(/^runuser -u 'maya' -- bash -c /);
    expect(handedLine(sweeps[0]!.cmd)).toMatch(/; rm -rf -- '\/home\/maya\/spoo-ts-2'$/);
    expect(await rt.projects.list()).toEqual([]);
  });
});
