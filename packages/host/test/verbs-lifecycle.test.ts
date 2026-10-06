// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { NapRefusedError } from "@wsp/engine";
import { localFolderRefusal, napRefusedLine, EXIT_CODES, shellLine } from "@wsp/protocol";
import { type HostSsh } from "@wsp/runtime";
import { describe, expect, it, vi } from "vitest";
import { cli, serve } from "../src/cli.js";
import { deleteQuestion, deletedLine, deleting, dialHost, type HostClient } from "../src/verbs.js";
import { SSH_PIPES_HERE_LINE } from "../src/verbs.js";
import { TEST_ENV } from "../../../vitest.env.js";
import { writeStub } from "../../protocol/test/stub-script.js";
import { runningWsp } from "../src/mcp-install.js";
import { wspArgvOf } from "../src/place-report.js";
import { captured, execGuest, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: pause, wake, ssh, rename, forget and delete", () => {
  const h = verbsHost();

  it("pause naps the workspace and says so in the state vocabulary", async () => {
    await h.run("new", "alpha");
    const { code, io } = await h.run("pause", "alpha");
    expect(code).toBe(0);
    expect(io.lines).toEqual(["alpha paused"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("napping");
    const missing = await h.run("pause", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp pause: no workspace nope"]);
  });

  it("pause on a machine the provider will not pause refuses with the sentence that says why, class provider, in one stderr line, and --json carries it", async () => {
    await h.run("new", "alpha");
    const m = h.backend.machines[0]!;
    m.pause = async () => {
      throw new NapRefusedError(m.id, "Not pausable");
    };
    const refused = await h.run("pause", "alpha");
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp pause: ${napRefusedLine("Not pausable")}`]);
    const asJson = await h.run("pause", "alpha", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: napRefusedLine("Not pausable"), class: "provider", exit: EXIT_CODES.provider }]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("wake wakes a paused workspace, one line on stderr while it does, and prints its state after; on a running one the runtime is asked and the state printed is the one read", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const woken = await h.run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.errors).toEqual(["waking alpha"]);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
    expect(h.backend.machines[0]!.paused).toBe(false);
    const again = await h.run("wake", "alpha", "--json");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
    expect(h.json(again.io)).toEqual([{ workspace: expect.objectContaining({ name: "alpha", phase: "running" }) }]);
    const plain = await h.run("wake", "alpha");
    expect(plain.io.lines).toEqual(["alpha running"]);
    const missing = await h.run("wake", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp wake: no workspace nope"]);
  });

  it("wake says a machine that came up and answers nothing is up and not answering yet", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      h.backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const woken = await h.run("wake", "alpha");
      expect(woken.code).toBe(0);
      // The provider started it, so the phase alone would say running; nothing on it answers, so the table says
      // Unreachable, and the wake says the same thing in a sentence rather than a second word for one machine.
      expect(woken.io.lines).toEqual(["alpha is up and not answering yet"]);
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("a machine the provider paused on its own, under a record that says running, is woken by wake and by exec: the runtime's one state read settles it", async () => {
    await h.run("new", "alpha");
    h.backend.machines[0]!.paused = true;
    execGuest(h.backend, "awake-ok\n", 0);
    const ran = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    expect(h.backend.machines[0]!.paused).toBe(false);
    h.backend.machines[0]!.paused = true;
    const woken = await h.run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect(woken.io.errors).toEqual([]);
    expect(h.backend.machines[0]!.paused).toBe(false);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
  });

  /** The host again with this ssh door in place of the relay's, which reaches no machine the stub backend makes. */
  async function withSsh(ssh: HostSsh): Promise<void> {
    await h.handle?.close();
    h.handle = await serve(captured(), { port: 0, statePath: h.statePath, webDir: join(h.dir, "web"), runtime: h.rt, ssh });
  }
  /** wsp ssh as an ssh client runs it, with these bytes on its stdin and its stdout read whole. */
  async function sshLine(ref: string, typed: string): Promise<{ code: number; io: Captured; said: string }> {
    const io = captured();
    const input = new PassThrough();
    const output = new PassThrough();
    const got: Buffer[] = [];
    output.on("data", (d: Buffer) => got.push(d));
    io.bytes = { input, output };
    const ended = cli(["ssh", ref, "--state", h.statePath], io, undefined, h.env);
    input.end(typed);
    return { code: await ended, io, said: Buffer.concat(got).toString() };
  }

  it("ssh pipes its stdin and stdout to the workspace's ssh server through the port the host answers, the workspace named by its alias", async () => {
    await h.run("new", "Cart rounding");
    const echo = createServer(c => {
      c.on("data", d => c.write(`echo: ${String(d)}`));
      c.on("end", () => c.end());
    });
    await new Promise<void>(r => echo.listen(0, "127.0.0.1", r));
    const asked: string[] = [];
    await withSsh({ port: async w => (asked.push(w.name), (echo.address() as AddressInfo).port), include: async () => false, setInclude: async on => on });
    try {
      const { code, io, said } = await sshLine("wsp-cart-rounding", "SSH-2.0-OpenSSH_9.6\r\n");
      expect({ code, said, lines: io.lines, errors: io.errors }).toEqual({ code: 0, said: "echo: SSH-2.0-OpenSSH_9.6\r\n", lines: [], errors: [] });
      expect(asked).toEqual(["Cart rounding"]);
      // Its name works as every other verb's does.
      expect((await sshLine("Cart rounding", "again")).said).toBe("echo: again");
    } finally {
      echo.close();
    }
  });

  it("ssh refuses an alias two workspaces go by, naming both, and writes nothing on stdout", async () => {
    await h.run("new", "Cart rounding");
    await h.run("new", "cart-rounding");
    const asked: string[] = [];
    await withSsh({ port: async w => (asked.push(w.name), 1), include: async () => false, setInclude: async on => on });
    const { code, io, said } = await sshLine("wsp-cart-rounding", "SSH-2.0\r\n");
    const ids = (await h.rt.workspaces.list()).map(w => w.id);
    expect(code).toBe(EXIT_CODES.usage);
    expect(said).toBe("");
    expect(io.lines).toEqual([]);
    for (const id of ids) expect(io.errors.join("\n")).toContain(id);
    expect(asked).toEqual([]);
  });

  it("ssh with no terminal of this computer's to pipe, as on a line carried from a machine, says so and asks the host nothing", async () => {
    await h.run("new", "Cart rounding");
    const asked: string[] = [];
    await withSsh({ port: async w => (asked.push(w.name), 1), include: async () => false, setInclude: async on => on });
    const io = captured();
    expect(await cli(["ssh", "wsp-cart-rounding", "--state", h.statePath], io, undefined, h.env)).toBe(EXIT_CODES.usage);
    expect(io.errors.join("\n")).toContain(SSH_PIPES_HERE_LINE);
    expect(asked).toEqual([]);
  });

  it("writes an ssh config OpenSSH runs on the host's own state, however that state's path is spelled", async () => {
    await h.handle?.close();
    const served = join(h.dir, `it's a "quoted" 100%h state`, "state.json");
    h.handle = await serve(captured(), { port: 0, statePath: served, webDir: join(h.dir, "web"), runtime: h.rt });
    // The include goes into the person's own ~/.ssh/config, under the home this file stubs, which a person always has.
    mkdirSync(join(h.dir, "user"), { recursive: true });
    const client = await dialHost(served);
    try {
      expect(await client.request("ssh.include", { on: true })).toMatchObject({ sshInclude: true });
    } finally {
      client.close();
    }
    const config = join(h.dir, "home", "ssh_config");
    const written = readFileSync(config, "utf8");
    const wsp = `ProxyCommand ${shellLine(wspArgvOf(runningWsp())).replaceAll("%", "%%")} `;
    expect(written).toContain(wsp);
    // The words that run wsp are this test process's own; a stub that prints its arguments takes their place, so what
    // OpenSSH hands the command after them is read back as it arrived.
    const said = join(h.dir, "argv");
    const printer = writeStub(join(h.dir, "print-argv"), `#!/bin/sh\nfor a; do printf '%s\\n' "$a"; done > ${shellLine([said])}\n`);
    writeFileSync(config, written.replace(wsp, `ProxyCommand ${shellLine([printer]).replaceAll("%", "%%")} `));
    spawnSync("ssh", ["-F", config, "-o", "BatchMode=yes", "wsp-cart-rounding", "true"], { env: { ...TEST_ENV, PATH: process.env["PATH"], HOME: join(h.dir, "user") }, encoding: "utf8", timeout: 20_000 });
    expect(readFileSync(said, "utf8").split("\n").slice(0, -1)).toEqual(["--state", served, "ssh", "wsp-cart-rounding"]);
  });

  it("exec on a paused workspace wakes it first, says so on stderr, then runs the command; a running one is not woken", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    execGuest(h.backend, "awake-ok\n", 0);
    const { code, io } = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(code).toBe(0);
    expect(io.errors).toEqual(["waking alpha"]);
    expect(io.lines).toEqual(["awake-ok"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
    const again = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
  });

  it("a record that says paused while the provider runs the machine: exec goes on without a resume and the store ends running; pause pauses for real", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const m = h.backend.machines[0]!;
    // The nap never took at the provider, and a resume on a running machine is refused.
    const runningAtProvider = (): void => {
      m.paused = false;
      m.resume = async () => {
        throw Object.assign(new Error("Sandbox is not paused"), { kind: "conflict", status: 409 });
      };
    };
    runningAtProvider();
    execGuest(h.backend, "awake-ok\n", 0);
    const ran = await h.run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    const [alpha] = await h.rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(await h.store.get("workspaces", alpha!.id)).toMatchObject({ phase: "running" });

    await h.run("pause", "alpha");
    expect(m.paused).toBe(true);
    runningAtProvider();
    const paused = await h.run("pause", "alpha");
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual(["alpha paused"]);
    expect(m.paused).toBe(true);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("napping");
  });

  it("run and send on a paused workspace wake it first, one line on stderr, then run the turn", async () => {
    await h.run("new", "alpha");
    await h.run("pause", "alpha");
    const opened = await h.run("run", "alpha", "hello");
    expect(opened.code).toBe(0);
    expect(opened.io.errors).toEqual(["waking alpha"]);
    expect(opened.io.lines[1]).toBe("re: hello");
    const [row] = await h.rt.sessions.list();
    await h.run("pause", "alpha");
    const sent = await h.run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual(["waking alpha"]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect((await h.rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("rename names the workspace and prints both names; a name another workspace holds and a blank one are refused and nothing is renamed", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    const alpha = (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;

    const named = await h.run("rename", "alpha", "the name he typed");
    expect(named.code).toBe(0);
    expect(named.io.lines).toEqual([`alpha is now the name he typed ${alpha.id}`]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);
    // The name is how a workspace is addressed, so every later verb takes the one it now carries.
    expect((await h.run("pause", "the name he typed")).io.lines).toEqual(["the name he typed paused"]);

    const taken = await h.run("rename", "beta", "the name he typed");
    expect(taken.code).toBe(1);
    expect(taken.io.errors).toEqual(["wsp rename: the name he typed is already a workspace; pick another name, or delete it first"]);
    const blank = await h.run("rename", "beta", "  ");
    expect(blank.code).toBe(1);
    expect(blank.io.errors).toEqual(["wsp rename: a workspace name cannot be blank"]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);

    const asJson = await h.run("rename", "beta", "gamma", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toMatchObject([{ was: "beta", workspace: { name: "gamma" } }]);

    const missing = await h.run("rename", "nope", "a");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp rename: no workspace nope"]);
    const short = await h.run("rename", "gamma");
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp rename takes a workspace and one name. usage: wsp rename <workspace> \"<name>\""]);
  });

  it("forget asks once, naming what goes, drops a workspace whose machine is gone, and is refused with the reason while the machine exists", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    await h.run("run", "alpha", "build it");
    const alpha = (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;
    const live = await h.run("forget", "alpha", "--yes");
    expect(live.code).toBe(1);
    expect(live.io.errors).toEqual(["wsp forget: alpha's machine m1 is still running; pause it or delete it at the provider first"]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    h.backend.machines[0]!.killed = true;
    const kept = await h.answer("no", "forget", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(h.asked).toEqual(["Forget alpha?\nIts record and 1 thread leave this computer; the computer it ran on is already gone."]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    const forgot = await h.answer("yes", "forget", alpha.id);
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot alpha ${alpha.id}: its record and 1 thread are gone from this computer`]);
    expect(forgot.io.errors).toEqual([]);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await h.rt.sessions.list(alpha.id)).toEqual([]);
    expect(await h.store.get("workspaces", alpha.id)).toBeUndefined();
    expect(await h.store.get("transcripts", alpha.id)).toBeUndefined();

    h.backend.machines[1]!.killed = true;
    const beta = (await h.rt.workspaces.list())[0]!;
    const asJson = await h.run("forget", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", threads: 0 }]);
    expect(await h.rt.workspaces.list()).toEqual([]);

    const missing = await h.run("forget", "nope", "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp forget: no workspace nope"]);
  });

  it("the delete question and its line say what the delete does to this kind's machine", () => {
    const workspace = { id: "ws_mine", name: "box", machineId: "m_ab12", phase: "running", kind: "cloud", golden: "", createdAt: "2026-09-08T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" } } as const;
    // This computer took no daemon of wsp's and no line in a login file, so nothing comes off it.
    const here = { ...workspace, kind: "local", machineId: "local" } as const;
    expect(deleteQuestion({ workspace: here, threads: 1 })).toBe("Delete box?\nIts computer is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: here, threads: 1 })).toBe("deleted box ws_mine: its computer is left as it is, and its record and 1 thread are gone from this computer");
    // A record of a worktree wsp made takes the worktree with it; the project folder stays.
    const copied = { ...here, worktree: { path: "/Users/dev/api-fix", branch: "fix", made: true } } as const;
    expect(deleteQuestion({ workspace: copied, threads: 1 })).toBe("Delete box?\nIts worktree at /Users/dev/api-fix is removed and the project folder is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: copied, threads: 1 })).toBe("deleted box ws_mine: its worktree at /Users/dev/api-fix is removed and the project folder is left as it is, and its record and 1 thread are gone from this computer");
    // A fork is wsp's to take away, and its line still names the machine that goes.
    expect(deletedLine({ workspace, threads: 0 })).toBe("deleted box ws_mine: computer m_ab12 is gone in the cloud, and its record and 0 threads are gone from this computer");
  });

  it("a copy on a computer somebody joined is deleted from that computer by the names a person knows, never the cloud or the machine's id", async () => {
    const onSpoo = { id: "ws_fix", name: "fix-login", machineId: "wsp-workspace-ws_fix", phase: "running", kind: "cloud", place: "p_spoo", golden: "", createdAt: "2026-09-27T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "p_spoo" } };
    const spoo = { id: "p_spoo", kind: "computer", name: "spoo", default: false };
    const answers: Record<string, unknown> = { "workspaces.resolve": { workspace: onSpoo }, "sessions.list": { sessions: [] }, "places.list": { places: [spoo] } };
    const client = { request: async (op: string) => (answers[op] ?? Promise.reject(new Error(`no ${op}`))) as never } as unknown as HostClient;
    const d = await deleting(client, "fix-login");
    expect(deleteQuestion(d)).toBe("Delete fix-login?\nIts copy on spoo is deleted; its record and 0 threads leave this computer.");
    expect(deletedLine(d)).toBe("deleted fix-login ws_fix: fix-login is deleted from spoo, and its record and 0 threads are gone from this computer");
    // A caller that may not read the computers' names still never reads the machine's id.
    const unread = { request: async (op: string) => (op === "places.list" ? Promise.reject(new Error("not yours to read")) : answers[op]) as never } as unknown as HostClient;
    expect(deleteQuestion(await deleting(unread, "fix-login"))).toBe("Delete fix-login?\nIts copy on that computer is deleted; its record and 0 threads leave this computer.");
    // A fork at another provider's account is a cloud machine, and its delete takes the cloud's words.
    const cloudPlace = { id: "p_spoo", kind: "provider", name: "ascii", default: false };
    const atCloud = { request: async (op: string) => (op === "places.list" ? { places: [cloudPlace] } : answers[op]) as never } as unknown as HostClient;
    expect(deleteQuestion(await deleting(atCloud, "fix-login"))).not.toContain("copy on");
  });

  it("delete asks once in the words the app shows, kills the machine at the provider, and drops the record and its threads", async () => {
    await h.run("new", "alpha");
    await h.run("new", "beta");
    await h.run("run", "alpha", "build it");
    const alpha = (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;

    // A thread on the machine, by a prefix of its id, goes with its machine, and the line says so.
    const threadId = (await h.rt.sessions.list(alpha.id))[0]!.threadId!;
    const byThread = await h.run("delete", threadId.slice(0, 8), "--yes");
    expect(byThread.code).toBe(EXIT_CODES.usage);
    expect(byThread.io.errors).toEqual(["wsp delete: a thread on alpha goes with its machine; wsp delete alpha takes both"]);
    expect(h.backend.machines[0]!.killed).toBe(false);

    const kept = await h.answer("no", "delete", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(h.asked).toEqual([`Delete alpha?\nIts computer is deleted in the cloud; its record and 1 thread leave this computer.`]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(h.backend.machines[0]!.killed).toBe(false);

    const deleted = await h.answer("yes", "delete", alpha.id);
    expect(deleted.code).toBe(0);
    expect(deleted.io.errors).toEqual([]);
    expect(deleted.io.lines).toEqual([
      `deleted alpha ${alpha.id}: computer ${alpha.machineId} is gone in the cloud, and its record and 1 thread are gone from this computer`,
    ]);
    expect(h.backend.machines[0]!.killed).toBe(true);
    expect((await h.rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await h.rt.sessions.list(alpha.id)).toEqual([]);
    expect(await h.store.get("workspaces", alpha.id)).toBeUndefined();

    const beta = (await h.rt.workspaces.list())[0]!;
    const asJson = await h.run("delete", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", machineId: beta.machineId, threads: 0 }]);
    expect(h.backend.machines[1]!.killed).toBe(true);
    expect(await h.rt.workspaces.list()).toEqual([]);

    const missing = await h.run("delete", "nope", "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp delete: no workspace nope"]);
  });

  it("delete by name takes away a create the provider refused, in words that name no computer going", async () => {
    h.backend.create = async () => {
      throw Object.assign(new Error("Snapshot not found"), { kind: "missing", status: 404 });
    };
    expect((await h.run("new", "fleet-check")).code).not.toBe(0);
    const kept = await h.answer("no", "delete", "fleet-check");
    expect(kept.code).toBe(1);
    expect(h.asked).toEqual(["Delete fleet-check?\nIts create failed before any computer was made, so there is none to delete; its record and 0 threads leave this computer."]);

    const deleted = await h.run("delete", "fleet-check", "--yes");
    expect(deleted.code).toBe(0);
    expect(deleted.io.lines).toEqual([expect.stringMatching(/^deleted fleet-check ws_[0-9a-f]+: its create had made no computer, and its record and 0 threads are gone from this computer$/)]);
    expect((await h.run("delete", "fleet-check", "--yes")).io.errors).toEqual(["wsp delete: no workspace fleet-check"]);
  });

  it("forget and delete named a project's folder on this computer refuse it and send the person to its threads", async () => {
    await h.macProject("mac");
    const here = (await h.rt.workspaces.list())[0]!;
    for (const verb of ["forget", "delete"]) {
      const said = await h.run(verb, "mac", "--yes");
      expect(said.code).toBe(3);
      expect(said.io.errors[0]).toContain(localFolderRefusal("mac"));
    }
    expect((await h.rt.workspaces.list()).map(w => w.id)).toEqual([here.id]);
  });
});
