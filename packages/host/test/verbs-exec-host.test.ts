// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noProjectImageLine, projectImageInUseRefusal, projectImageRemoveNotice, projectImageRemovedLine, HERE_PLACE_ID, runForTheList, HOST_KEY_ENV, HOST_TOKEN_ENV, HOST_URL_ENV, noWorkspaceRefusal, execOutsideFix, refusalLine, spawnReachRefusal, EXIT_CODES, HOST_STOPPING_LINE, UP_RESTART_LINE, noReplyLine, notifyLine, RuntimeRequest, WorkspaceView } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { cli } from "../src/cli.js";
import { hostKeyHere } from "../src/places.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import { CLI_VERBS, dialHost, firstEnded, noHostServingLine, threadRows, threadsOf, type HostClient } from "../src/verbs.js";
import { HOST_RESTARTING_LINE, hostAgain, hostRestartedLine, THREAD_PREFIX_WORD } from "../src/verbs.js";
import { restartRoads, type RestartRoad } from "../src/restart.js";
import { withDaemonRoads } from "./stub-backend.js";
import { projectOn, CUT_LINE, captured, doneOnlyAgent, execGuest, heldAgent, lastingAgent, launchedScript, launchedScripts, stuckAgent, type Captured } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: wait, read, exec and the host itself", () => {
  const h = verbsHost();

  it("a wait in flight on a thread whose launch gives up gets that thread's finished line, with the reason the start failed with", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const WOULD_NOT_LAUNCH = "the agent binary is not on this machine";
    await h.restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error(WOULD_NOT_LAUNCH);
        },
      }),
    });
    await h.run("new", "alpha");
    const [ws] = await h.rt.workspaces.list();
    const giving = h.rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await h.rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await h.rt.sessions.list())[0]!.threadId!;

    let answered = false;
    const waiting = h.run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    letProbe();
    await expect(giving).rejects.toThrow(WOULD_NOT_LAUNCH);
    // The turn will never run, so the wait is answered rather than left holding a thread that went away under it.
    const finished = await waiting;
    expect(finished.code).toBe(0);
    expect(finished.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (failed): ${WOULD_NOT_LAUNCH}`]);
    expect(finished.io.errors).toEqual([]);
    // No turn ran under it, so the thread is not one the sidebar lists or a later wait can name.
    expect(await threadRows(await dialHost(h.statePath))).toEqual([]);
    const later = await h.run("threads", "wait", thread);
    expect(later.code).toBe(EXIT_CODES.usage);
    expect(later.io.errors).toEqual([`wsp threads wait: no thread ${thread}`]);
  });

  it("a wait whose thread gives up between naming it and subscribing to it answers finished (failed) at once: a named thread with no row on the second read is over", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    await h.restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error("the agent binary is not on this machine");
        },
      }),
    });
    await h.run("new", "alpha");
    const [ws] = await h.rt.workspaces.list();
    const giving = h.rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await h.rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await h.rt.sessions.list())[0]!.threadId!;
    const client = await dialHost(h.statePath);
    try {
      // The verb's two steps, with the give-up between them: the thread is named off one listing, and by the time
      // the wait subscribes and lists again, the row and the end that answered for it are both gone.
      const named = await threadsOf(client, [thread]);
      expect(named.map(t => t.status)).toEqual(["running"]);
      letProbe();
      await expect(giving).rejects.toThrow("the agent binary is not on this machine");
      expect(await firstEnded(client, named, 1_000)).toEqual({ ended: { threadId: thread, result: { status: "failed" } } });
    } finally {
      client.close();
    }
  });

  it("a send that never launches on a thread that has worked leaves every reading of its last turn alone: the table, the read, the reply and the wait all say what that turn came to", async () => {
    const held = heldAgent(false);
    let launches = 0;
    await h.restartHost({
      claude: ctx => {
        const inner = held.adapter(ctx);
        return {
          ...inner,
          start: o => {
            if (++launches > 1) throw new Error("the harness would not launch");
            return inner.start(o);
          },
        };
      },
    });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "build it");
    const thread = (await h.rt.sessions.list())[0]!.threadId!;
    held.release(0, "the build is green\nall green");
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.status).toBe("completed"), { timeout: 10_000, interval: 10 });

    const [ws] = await h.rt.workspaces.list();
    await expect(h.rt.sessions.start(ws!.id, { prompt: "and then this", thread })).rejects.toThrow("the harness would not launch");

    // One fact, how the thread's last turn went, and every door still gives the same answer.
    const listed = await threadRows(await dialHost(h.statePath));
    expect(listed.map(t => [t.id, t.status, t.turns])).toEqual([[thread, "completed", 1]]);
    expect((await h.run("thread", "read", thread, "--last")).io.lines[0]).toContain("the build is green\nall green");
    expect((await h.run("thread", "read", thread)).io.lines[0]).toContain("the build is green\nall green");
    expect((await h.run("threads", "wait", thread)).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): the build is green\nall green`]);
    expect((await h.run("threads", "wait", thread, "--tail")).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);
  });

  it("threads wait on a turn the runtime ended says failed with the runtime's reason, as the notify line would; a turn the transport cut says the cut line", async () => {
    await h.restartHost({ claude: stuckAgent() });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "loop forever");
    const [row] = await h.rt.sessions.list();
    const waiting = h.run("threads", "wait", row!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    await h.run("pause", "alpha");
    const paused = await waiting;
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (failed): machine paused while the agent was working`]);
    const later = await h.run("threads", "wait", row!.threadId!, "--json");
    expect(h.json(later.io)).toEqual([{ finished: { threadId: row!.threadId, status: "failed", reply: "machine paused while the agent was working" } }]);

    await h.restartHost({ claude: h.claude.adapter });
    await h.run("run", "alpha", "--detach", "cut");
    const cut = (await h.rt.sessions.list()).find(r => r.prompt === "cut")!;
    const cutWait = await h.run("threads", "wait", cut.threadId!);
    expect(cutWait.io.lines).toEqual([`thread ${cut.threadId!.slice(0, 8)} finished (failed): ${CUT_LINE}`]);
  });

  it("thread read prints the thread's messages as the app lists them, one line per tool call, --last the whole final message alone, and a thread that has not replied says so", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const [row] = await h.rt.sessions.list();
    const id = row!.threadId!;
    const read = await h.run("thread", "read", id.slice(0, 8));
    expect(read.code).toBe(0);
    expect(read.io.errors).toEqual([]);
    const blocks = read.io.lines[0]!.split("\n\n").map(block => block.split("\n"));
    // Who spoke and the clock head each block; the text of the block is what was said.
    expect(blocks.map(block => block[0])).toEqual(["person", "agent", "tool", "agent", "turn"].map(who => expect.stringMatching(new RegExp(`^${who} \\d\\d:\\d\\d:\\d\\d$`))));
    expect(blocks.map(block => block.slice(1).join("\n"))).toEqual(["build it", "re: ", "$ ls", "build it", "completed"]);
    // The events the app reads are the events this read folded: nothing on the machine was asked for it.
    expect(launchedScripts(h.backend).filter(script => script.includes("sessions"))).toEqual([]);

    const last = await h.run("thread", "read", id, "--last", "--json");
    expect(h.json(last.io)).toEqual([{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }]);
    // The whole final message is the one the finished line carries, so a read of the reply and a wait on it agree.
    expect(notifyLine(id, { status: "completed", text: "re: build it" }, "whole")).toContain("re: build it");

    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("run", "alpha", "--detach", "hold on");
    const pending = (await h.rt.sessions.list()).find(session => session.prompt === "hold on")!;
    const nothing = await h.run("thread", "read", pending.threadId!, "--last");
    expect(nothing.code).toBe(0);
    expect(nothing.io.lines).toEqual([noReplyLine(pending.threadId!)]);
    const running = await h.run("thread", "read", pending.threadId!, "--json");
    expect(h.json(running.io)).toEqual([{ threadId: pending.threadId, messages: [{ who: "person", at: expect.any(Number), text: "hold on" }] }]);
    held.release(0, "held no longer");

    const none = await h.run("thread", "read");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp thread read takes one thread");
    const missing = await h.run("thread", "read", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread read: no thread nope"]);
  });

  it("takes --state wherever it sits: before the verb's words, between them and after them", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const id = (await h.rt.sessions.list())[0]!.threadId!;

    const before = await h.typed("--state", h.statePath, "thread", "read", id);
    const between = await h.typed("thread", "--state", h.statePath, "read", id);
    const after = await h.typed("thread", "read", id, "--state", h.statePath);
    expect([before.code, between.code, after.code]).toEqual([0, 0, 0]);
    expect([before.io.errors, between.io.errors, after.io.errors]).toEqual([[], [], []]);
    expect(before.io.lines).toEqual(after.io.lines);
    expect(between.io.lines).toEqual(after.io.lines);
    expect(after.io.lines[0]).toContain("build it");
  });

  it("takes --json wherever it sits, so a line that asks for JSON before the verb's words prints JSON", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const id = (await h.rt.sessions.list())[0]!.threadId!;
    const answer = [{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }];

    const before = await h.typed("--json", "thread", "read", id, "--last", "--state", h.statePath);
    const between = await h.typed("thread", "--json", "read", id, "--last", "--state", h.statePath);
    const after = await h.typed("thread", "read", id, "--last", "--json", "--state", h.statePath);
    expect([before.code, between.code, after.code]).toEqual([0, 0, 0]);
    expect(h.json(before.io)).toEqual(answer);
    expect(h.json(between.io)).toEqual(answer);
    expect(h.json(after.io)).toEqual(answer);
  });

  it("hands the verb the rest of the line in the order it was typed, so its own flags are read beside a shared one", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const id = (await h.rt.sessions.list())[0]!.threadId!;

    // The shared flag between the verb's words, the verb's own flag at the end.
    const { code, io } = await h.typed("thread", "--state", h.statePath, "read", id, "--last");
    expect(code).toBe(0);
    expect(io.errors).toEqual([]);
    expect(io.lines).toEqual([expect.stringContaining("re: build it")]);
  });

  it("refuses a shared flag left at the end of the line by its own name, never reading the verb's word as its value", async () => {
    for (const name of ["--state", "--host"]) {
      const { code, io } = await h.typed("thread", "read", "th_one", name);
      const refusal = io.errors.join("\n");
      expect(code, name).toBe(EXIT_CODES.usage);
      expect(refusal, name).toContain(`Option '${name} <value>' argument missing`);
      // The word the verb was given is its own, so nothing about it is read back as the flag's value.
      expect(refusal, name).not.toContain("th_one");
    }
  });

  it("refuses a misspelt shared flag by the word that was typed, in two halves, wherever it sits", async () => {
    const threads = CLI_VERBS.find(v => v.name === "threads")!;
    for (const [argv, fix] of [
      [["--stat", h.statePath, "threads"], runForTheList("wsp --help")],
      [["thread", "--stat", h.statePath, "read", "th_one"], runForTheList("wsp --help")],
      [["threads", "--stat", h.statePath], `usage: ${threads.usage}`],
    ] as [string[], string][]) {
      const { code, io } = await h.typed(...argv);
      const refusal = io.errors.join("\n");
      expect(code, argv.join(" ")).toBe(EXIT_CODES.usage);
      // Two halves: the word as it was typed, then what to do about it after it.
      expect(refusal, argv.join(" ")).toContain("--stat'");
      expect(refusal.indexOf(fix), argv.join(" ")).toBeGreaterThan(refusal.indexOf("--stat'"));
    }
  });

  it.runIf(CLOUD_ON)("run, send and fork --send return with the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await h.restartHost({ claude: agent.adapter });
    await h.run("new", "alpha");
    const opened = await h.run("run", "alpha", "first");
    const [row] = await h.rt.sessions.list();
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: first"]);
    expect(opened.io.errors).toEqual([]);
    const sent = await h.run("send", row!.threadId!, "second", "--json");
    expect(sent.code).toBe(0);
    expect((h.json(sent.io) as { type: string }[]).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", undefined]);
    withDaemonRoads(h.backend);
    const forked = await h.run("fork", "alpha", "--name", "worker", "--send", "third");
    expect(forked.code).toBe(0);
    expect(forked.io.lines.slice(1)).toEqual([expect.stringMatching(/^thread /), "re: third"]);
    expect(agent.starts.map(s => s.prompt)).toEqual(["first", "second", "third"]);
    expect((await h.rt.sessions.history(row!.workspaceId)).map(e => e.type)).not.toContain("session.end");
  });

  it("exec runs the command on the workspace's machine, streams its output and exits with its code", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "one\ntwo\n", 3);
    const { code, io } = await h.run("exec", "alpha", "--", "sh", "-c", "printf 'one\\ntwo\\n'; exit 3");
    expect(code).toBe(3);
    expect(io.lines).toEqual(["one", "two"]);
    expect(launchedScript(h.backend)).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");

    const raw = await h.run("exec", "alpha", "--json", "--", "true");
    expect(raw.code).toBe(3);
    expect(h.json(raw.io)).toEqual([
      { type: "exec.output", execId: expect.any(String), text: "one" },
      { type: "exec.output", execId: expect.any(String), text: "two" },
      // The command ran in the workspace's project, and the reply says where rather than restating the rule.
      { exitCode: 3, cwd: (await h.rt.workspaces.list())[0]!.project.path },
    ]);
    const bare = await h.run("exec", "alpha");
    expect(bare.code).toBe(3);
    expect(bare.io.errors).toEqual(["wsp exec takes a workspace, then -- and the command. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
  });

  describe("one list behind every verb", () => {
    /** The workspace a thread of this host's runs on, its agents allowed to spawn. */
    async function leadWorkspace(): Promise<WorkspaceView> {
      await h.run("new", "alpha", "--spawn", "on");
      return (await h.rt.workspaces.list()).find(w => w.name === "alpha")!;
    }
    /** What a turn's launch hands the thread running on that workspace: the address of this host and a token scoped
     * to the thread, which is the pair a wsp line inside a turn dials with. Every line after this runs as that thread. */
    async function asThread(workspace: WorkspaceView, threadId: string): Promise<void> {
      const scoped = await h.rt.devices.mint(`thread ${threadId}`, { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId }, Date.now());
      h.env[HOST_URL_ENV] = `ws://127.0.0.1:${h.handle!.port}`;
      h.env[HOST_TOKEN_ENV] = scoped.deviceToken;
      // The fingerprint of the key this host proves rides the launch beside them, and the line holds the host to
      // it before the token crosses: a turn on a machine reaches this host over a road somebody else carries.
      h.env[HOST_KEY_ENV] = hostKeyHere(h.statePath);
    }
    /** A line as that thread types it: no --state, since the pair in its environment says which host it runs against. */
    async function line(...argv: string[]): Promise<{ code: number; io: Captured }> {
      const io = captured();
      return { code: await cli(argv, io, undefined, h.env), io };
    }

    it("every verb takes the workspaces the caller's own listing prints, by name and by id", async () => {
      const alpha = await leadWorkspace();
      await h.run("run", "alpha", "hello");
      const [row] = await h.rt.sessions.list();
      await asThread(alpha, "t_lead");
      execGuest(h.backend, "Linux\n", 0);
      expect((await line("exec", "alpha", "--", "uname")).io.lines).toEqual(["Linux"]);
      expect((await line("exec", alpha.id, "--", "uname")).io.lines).toEqual(["Linux"]);
      const listedThreads = await line("threads", "alpha", "--json");
      expect(listedThreads.code, listedThreads.io.errors.join("\n")).toBe(0);
      // The person's own thread is another tree on the same workspace: the caller's listing leaves it out and its
      // id reads as no thread at all, so a thread cannot send into one it did not open.
      expect(h.json(listedThreads.io)).toEqual([{ threads: [] }]);
      expect((await line("send", row!.threadId!, "and the rest")).io.errors).toEqual([`wsp send: no thread ${row!.threadId}`]);
      // The thread it opened for itself is the one it drives, on the same ids the same listing prints.
      const opened = await line("run", "alpha", "kid");
      expect(opened.code, opened.io.errors.join("\n")).toBe(0);
      const kid = (await h.rt.sessions.list()).find(r => r.threadId !== row!.threadId)!;
      expect(h.json(await line("threads", "alpha", "--json").then(r => r.io))).toEqual([{ threads: [expect.objectContaining({ threadId: kid.threadId })] }]);
      expect((await line("send", kid.threadId!, "and the rest")).code).toBe(0);
    });

    it("a workspace the caller's reach hides is refused by the tree rule by its whole name or id, and reads as absent by the start of an id", async () => {
      const alpha = await leadWorkspace();
      await h.run("new", "beta");
      const beta = (await h.rt.workspaces.list()).find(w => w.name === "beta")!;
      await asThread(alpha, "t_lead");
      // A whole name or id the person holds is refused by the rule in the word typed, with exec's road on the thread's
      // own machine; the start of an id reads as absent, so walking this host's ids by prefix tells a thread nothing.
      const outside = (word: string): string => `wsp exec: ${refusalLine(spawnReachRefusal("t_lead", word), execOutsideFix("alpha"))}`;
      expect((await line("exec", "beta", "--", "uname")).io.errors).toEqual([outside("beta")]);
      expect((await line("exec", beta.id, "--", "uname")).io.errors).toEqual([outside(beta.id)]);
      // The start has to miss alpha's id too, which a random pair shares for several characters now and then.
      let n = 6;
      while (alpha.id.startsWith(beta.id.slice(0, n))) n++;
      const start = beta.id.slice(0, n);
      expect((await line("exec", start, "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal(start)}`]);
      expect(h.json((await line("threads", "beta", "--json")).io)).toEqual([{ threads: [] }]);
      // A name nothing here carries reads the same, which is the whole of what the two have to say to a thread.
      expect((await line("exec", "gamma", "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal("gamma")}`]);
    });
  });

  it("exec hands the machine each argument as it was given: a quoted word stays one word", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "", 0);
    const { code } = await h.run("exec", "alpha", "--", "grep", "a b", "file.txt");
    expect(code).toBe(0);
    const held = (await h.rt.workspaces.list())[0]!.project.path;
    expect(launchedScript(h.backend)).toContain(`\ncd '${held}' && 'grep' 'a b' 'file.txt'\n`);
  });

  it("exec runs in --cwd when given, else in the workspace's project folder; a failing command says on stderr where it ran", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const held = alpha!.project.path;
    execGuest(h.backend, "", 0);
    const inProject = await h.run("exec", "alpha", "--", "git", "status");
    expect(inProject.code).toBe(0);
    expect(inProject.io.errors).toEqual([]);
    expect(launchedScripts(h.backend).at(-1)).toContain(`\ncd '${held}' && 'git' 'status'\n`);

    const named = await h.run("exec", "alpha", "--cwd", "/root/work/else where", "--", "git", "status");
    expect(named.code).toBe(0);
    expect(launchedScripts(h.backend).at(-1)).toContain("\ncd '/root/work/else where' && 'git' 'status'\n");

    execGuest(h.backend, "fatal: not a git repository\n", 128);
    const failing = await h.run("exec", "alpha", "--", "git", "status");
    expect(failing.code).toBe(128);
    expect(failing.io.lines).toEqual(["fatal: not a git repository"]);
    expect(failing.io.errors).toEqual([`ran in ${held}`]);

    const overridden = await h.run("exec", "alpha", "--cwd", "/root", "--", "git", "status");
    expect(overridden.code).toBe(128);
    expect(launchedScripts(h.backend).at(-1)).toContain("\ncd '/root' && 'git' 'status'\n");
    expect(overridden.io.errors).toEqual(["ran in /root"]);

    const relative = await h.run("exec", "alpha", "--cwd", "packages/host", "--", "git", "status");
    expect(relative.code).toBe(3);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>']);
  });

  it("a failing exec says the folder the host ran it in, which on this computer is the project's folder", async () => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), "wsp-exec-")));
    execFileSync("git", ["init", "-q", folder]);
    const here = await projectOn(h.rt, HERE_PLACE_ID, folder, { name: "mac" });
    await h.run("new", here.name, "mac");
    const local = await h.run("exec", "mac", "--", "false");
    expect(local.code).toBe(1);
    expect(local.io.errors).toEqual([`ran in ${folder}`]);
    const raw = await h.run("exec", "mac", "--json", "--", "false");
    expect(h.json(raw.io).at(-1)).toEqual({ exitCode: 1, cwd: folder });
    rmSync(folder, { recursive: true, force: true });
  });

  it("a host that stops under an exec says so and that the turn goes on, in one line with exit 1 instead of hanging", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "", undefined);
    const command = h.run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    await h.handle!.close();
    h.handle = undefined;
    const c = await command;
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual([`wsp exec: ${HOST_STOPPING_LINE}`]);
  });

  it("a run and a threads wait whose host restarts under them wait for it to come back, and the run prints the reply whole though its stream was cut", async () => {
    const lasting = lastingAgent();
    await h.restartHost({ claude: lasting.adapter });
    await h.run("new", "alpha");
    const turn = h.starting("run", "alpha", "build it");
    turn.io.sameScreen = true;
    await vi.waitFor(() => expect(lasting.started()).toBe(1), { timeout: 5_000, interval: 10 });
    const [row] = await h.rt.sessions.list();
    await vi.waitFor(() => expect(turn.io.lines).toHaveLength(1), { timeout: 5_000, interval: 10 });
    const waited = h.run("threads", "wait", row!.threadId!);
    await new Promise(r => setTimeout(r, 300));
    await h.restartHost({ claude: lasting.adapter });
    // The host that came back has re-opened the run before its lines are sent, so they reach the host now serving.
    await h.rt.sessions.list();
    expect(lasting.attached()).toBe(1);
    lasting.finish("built it");
    const [code, w] = await Promise.all([turn.ended, waited]);
    expect(code).toBe(0);
    // On a person's own screen the streamed copy is the reply, but this one was cut when the host stopped, so the
    // reply is printed whole under the thread's line.
    expect(turn.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "built it"]);
    expect(turn.io.errors).toEqual([HOST_RESTARTING_LINE]);
    expect(w.code).toBe(0);
    expect(w.io.lines).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): built it`]);
    expect(w.io.errors).toEqual([HOST_RESTARTING_LINE]);
  });

  it("restart has the host restart on the road it came up on and answers once the host that replaced it serves, with the threads running on it; a host wsp up holds in a terminal refuses in that road's words", async () => {
    const lasting = lastingAgent();
    // The verb's road as the host takes it: the host closes, and the one that replaces it serves the same state file.
    const road: RestartRoad = { shape: "verb", restart: () => h.restartHost({ claude: lasting.adapter }, h.store, undefined, h.backend, road) };
    await h.restartHost({ claude: lasting.adapter }, h.store, undefined, h.backend, road);
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "build it");
    const [row] = await h.rt.sessions.list();
    const before = h.handle;
    const restarted = await h.run("restart");
    expect(restarted.code).toBe(0);
    expect(h.handle).not.toBe(before);
    expect(restarted.io.lines).toEqual([hostRestartedLine([row!.threadId!])]);
    expect(lasting.attached()).toBe(1);

    const asJson = await h.run("restart", "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ running: [row!.threadId] }]);
    lasting.finish("built it");
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.status).toBe("completed"), { timeout: 5_000, interval: 10 });
    expect((await h.run("restart")).io.lines).toEqual([hostRestartedLine([])]);

    await h.restartHost({ claude: lasting.adapter }, h.store, undefined, h.backend, restartRoads({ exit: () => {}, respawn: async () => {}, log: () => {} }).up);
    const refused = await h.run("restart");
    expect(refused.code).toBe(EXIT_CODES.provider);
    expect(refused.io.errors).toEqual([`wsp restart: ${UP_RESTART_LINE}`]);
    const extra = await h.run("restart", "now");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors).toEqual(["wsp restart takes no arguments. usage: wsp restart"]);
  });

  it("a wait whose host does not come back gives up once its window runs out, with the dial's own refusal, and a dial that hangs is held to what is left", async () => {
    const gone = new Error(noHostServingLine(h.statePath));
    const within: number[] = [];
    let started = Date.now();
    await expect(hostAgain(async left => {
      within.push(left);
      throw gone;
    }, 300)).rejects.toBe(gone);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(within.length).toBeGreaterThan(1);
    expect(within.every(left => left > 0 && left <= 300)).toBe(true);
    // A port that accepts and never answers: each dial waits out the deadline it was handed, and the wait still ends
    // at its window rather than a whole dial window past it.
    started = Date.now();
    await expect(hostAgain(left => new Promise<HostClient>((_, fail) => setTimeout(() => fail(gone), left)), 300)).rejects.toBe(gone);
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("the workspace being deleted under a running exec fails the verb with the reason and exit 1", async () => {
    await h.run("new", "alpha");
    execGuest(h.backend, "", undefined);
    const command = h.run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    const [alpha] = await h.rt.workspaces.list();
    await h.rt.workspaces.delete(alpha!.id);
    const c = await command;
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual(["wsp exec: machine deleted while the agent was working"]);
  });

  it("a host whose sessions.start reply has no turn id or outcome is refused in one line before the follow, never printed as undefined", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const port = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(h.statePath), "tok\n");
    writeFileSync(lockPathFor(h.statePath), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z" };
    const session = { id: "s_1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "t_1" };
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        const reply =
          op === "workspaces.list"
            ? { workspaces: [workspace] }
            : op === "workspaces.resolve" || op === "workspaces.wake"
              ? { workspace }
              : op === "harnesses.list"
                ? { harnesses: [] }
                : op === "sessions.start"
                  ? { session }
                  : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const { code, io } = await h.run("run", "alpha", "first");
      expect(code).toBe(1);
      expect(io.lines).toEqual([]);
      expect(io.streamed).toBe("");
      expect(io.errors).toEqual(["wsp run: the host answered workspaces.resolve in a shape this wsp does not read; it runs another version of wsp, restart it with wsp up"]);
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a request the host's own validator refuses reads as one line naming what it would not take and the form the verb takes, never the wire's schema", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const port = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(h.statePath), "tok\n");
    writeFileSync(lockPathFor(h.statePath), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z", project: { id: "pr_1", name: "api", path: "/root/api", computer: "default" } };
    // The validator's own words, off the very schema the host parses a request with.
    let refusal = RuntimeRequest.safeParse({ id: 1, op: "workspaces.exec" }).error!.message;
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        if (op === "workspaces.exec") return void socket.send(JSON.stringify({ id, ok: false, error: refusal }));
        const reply = op === "workspaces.resolve" || op === "workspaces.wake" ? { workspace } : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const ran = await h.run("exec", "alpha", "--", "ls");
      expect(ran.code).toBe(EXIT_CODES.usage);
      expect(ran.io.errors).toEqual(["wsp exec: the host would not read the workspace and the command on this line. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
      // None of the wire's own words reach the person: not a field name, not a code, not one of the ops it listed.
      expect(ran.io.errors[0]).not.toContain("workspaceId");
      expect(ran.io.errors[0]).not.toContain("invalid_type");

      // An op the host does not know is the two builds differing, which no argument of the line can fix.
      refusal = RuntimeRequest.safeParse({ id: 1, op: "a.verb.this.host.has.never.served" }).error!.message;
      const skewed = await h.run("exec", "alpha", "--", "ls");
      expect(skewed.code).toBe(EXIT_CODES.usage);
      expect(skewed.io.errors).toEqual(["wsp exec: the host does not serve this line; it runs another version of wsp, restart it with wsp up. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
      expect(skewed.io.errors[0]).not.toContain("discriminator");
      expect(skewed.io.errors[0]).not.toContain("workspaces.createLocal");
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a port that accepts but never answers fails the dial within its deadline, before and after the handshake", async () => {
    await h.handle!.close();
    h.handle = undefined;
    const accepted: Socket[] = [];
    const silent = createServer(socket => accepted.push(socket));
    await new Promise<void>(r => silent.listen(0, "127.0.0.1", r));
    const mute = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => mute.once("listening", r));
    writeFileSync(hostTokenPath(h.statePath), "tok\n");
    try {
      for (const server of [silent, mute]) {
        const port = (server.address() as AddressInfo).port;
        writeFileSync(lockPathFor(h.statePath), JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
        await expect(dialHost(h.statePath, { deadlineMs: 200 })).rejects.toThrow(`the host at 127.0.0.1:${port} did not answer: nothing came back within 200 ms`);
      }
    } finally {
      for (const client of mute.clients) client.terminate();
      for (const socket of accepted) socket.destroy();
      await new Promise(r => mute.close(r));
      await new Promise(r => silent.close(r));
    }
  });

  it.runIf(CLOUD_ON)("snapshot takes a project golden of the workspace it names and says how to fork it; a workspace that was resumed is refused in one line", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const { code, io } = await h.run("snapshot", "alpha");
    expect(code, io.errors.join("\n")).toBe(0);
    const [golden] = await h.rt.golden.projects();
    expect(golden).toMatchObject({ projects: [{ name: alpha!.project.name, dest: alpha!.project.path }], golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(io.lines).toEqual([
      `project image ${golden!.snapshotId}: image v1 plus ${alpha!.project.name} imported ${golden!.projects[0]!.importedAt.slice(0, 10)}, taken from alpha`,
    ]);
    expect(io.errors).toEqual([]);

    const asJson = await h.run("snapshot", alpha!.id, "--json");
    expect(asJson.code).toBe(0);
    expect(h.json(asJson.io)).toEqual([{ projectGolden: expect.objectContaining({ projects: golden!.projects, golden: "snap_gold" }) }]);

    await h.rt.workspaces.nap(alpha!.id);
    await h.rt.workspaces.wake(alpha!.id);
    const resumed = await h.run("snapshot", "alpha");
    expect(resumed.code).toBe(1);
    expect(resumed.io.errors).toHaveLength(1);
    expect(resumed.io.errors[0]).toMatch(/^wsp snapshot: snapshot \S+ refused: machine m\d+ is not first-life/);
    expect(await h.rt.golden.projects()).toHaveLength(2);
  });

  it.runIf(CLOUD_ON)("wsp image lists every project image by its id, project, size and date; image remove asks once, deletes the snapshot at the provider and drops the record, and is refused while a workspace stands on it", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    const taken = await h.rt.workspaces.snapshot(alpha!.id);
    const listed = await h.run("image");
    expect(listed.io.lines.join("\n").split("\n")).toContain(`${taken.snapshotId}  project alpha  ${alpha!.project.name}  7.5 GB  ${taken.createdAt}`);

    expect((await h.run("new", h.cloud.name, "task-a", "--from", taken.snapshotId)).code).toBe(0);
    const standing = await h.run("image", "remove", taken.snapshotId, "--yes");
    expect(standing.code).toBe(1);
    expect(standing.io.errors).toEqual([`wsp image remove: ${projectImageInUseRefusal(taken.snapshotId, ["task-a"])}`]);
    expect(h.backend.snapshots.map(s => s.id)).toContain(taken.snapshotId);
    expect((await h.run("delete", "task-a", "--yes")).code).toBe(0);

    const kept = await h.answer("no", "image", "remove", taken.snapshotId);
    const asJson = await h.run("image", "remove", taken.snapshotId, "--json");
    expect(asJson.code).toBe(EXIT_CODES.usage);
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual([`${taken.snapshotId} kept`]);
    expect(h.asked.at(-1)).toBe(`Remove project image ${taken.snapshotId}?\n${projectImageRemoveNotice(taken)}`);
    expect(h.backend.snapshots.map(s => s.id)).toContain(taken.snapshotId);

    const removed = await h.answer("yes", "image", "remove", taken.snapshotId);
    expect(removed.code).toBe(0);
    expect(removed.io.lines).toEqual([projectImageRemovedLine(taken.snapshotId, false)]);
    expect(h.backend.snapshots.map(s => s.id)).not.toContain(taken.snapshotId);
    expect(await h.rt.golden.projects()).toEqual([]);

    const missing = await h.run("image", "remove", taken.snapshotId, "--yes");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual([`wsp image remove: ${noProjectImageLine(taken.snapshotId)}`]);
    // A project's name is no id: a remove never picks one of several images by the newest.
    const named = await h.run("image", "remove", h.cloud.name, "--yes");
    expect(named.code).toBe(EXIT_CODES.usage);
    expect(named.io.errors).toEqual([`wsp image remove: ${noProjectImageLine(h.cloud.name)}`]);
    expect((await h.run("image", "remove")).code).toBe(EXIT_CODES.usage);
  });
});
