// SPDX-License-Identifier: AGPL-3.0-only
// What a pane of a thread in a folder on a computer the person joined carries
// over that computer's one link, and what an add there leaves when it fails.
// The daemon there answers for the whole computer as root, so the channel
// holds a pane to its own folder and its own ptys, and refuses before the link
// anything that would read or act on the computer as a whole.
import { describe, expect, it } from "vitest";
import { forkOpRefusedLine, forkProcsUnreadLine, placeWatchesItselfLine } from "@wsp/protocol";
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
  it("opens with the folder's own hello, its shell in the project folder, keeps that computer's readings off it, and lets its ptys go when it closes", async () => {
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

    // The ports and the load that daemon reads are the whole computer's: answered here, nothing goes up the link.
    for (const op of ["ports.watch", "sys.watch"]) {
      const before = sent(op).length;
      expect(await channel.send({ op })).toMatchObject({ ok: false, code: "unsupported", error: placeWatchesItselfLine("hetzner") });
      expect(sent(op)).toHaveLength(before);
    }

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

  it("refuses the computer's process watch, reads and kills before anything reaches it", async () => {
    const { channel, sent } = await pane();
    // The daemon there acts on any pid it is handed, the computer's own and every other thread's included.
    for (const frame of [{ op: "proc.kill", pid: 1, signal: "KILL" }, { op: "proc.inspect", pid: 1 }, { op: "proc.watch" }, { op: "proc.unwatch" }]) {
      const before = sent(frame.op).length;
      expect(await channel.send(frame)).toMatchObject({ ok: false, code: "unsupported", error: forkProcsUnreadLine("spoo-ts", "hetzner") });
      expect(sent(frame.op)).toHaveLength(before);
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
    expect(await asking).toMatchObject({ ok: true, branch: "main" });
    channel.close();
  });
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
