// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { childStartedLine, EXIT_CODES, HOST_STOPPING_LINE, NO_SUCH_TURN, notifyLine, threadStateWord, ThreadView, TURN_TOKEN_ENV, NOT_DELIVERED_LINE } from "@wsp/protocol";
import { describe, expect, it, vi } from "vitest";
import { cli } from "../src/cli.js";
import { dialHost, threadRows } from "../src/verbs.js";
import { THREAD_PREFIX_WORD } from "../src/verbs.js";
import { withDaemonRoads } from "./stub-backend.js";
import { UNREACHED_LINE, bornDeadAgent, captured, heldAgent, scriptedAgent } from "./verbs-fixture.js";
import { runsFromItsOwnFolder } from "./own-folder.js";
import { CLOUD_ON } from "../src/cloud.js";
import { verbsHost } from "./verbs-host.js";

runsFromItsOwnFolder();

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

describe("wsp verbs over the host: send, steer, stop and notify", () => {
  const h = verbsHost();

  it("send resumes the thread's latest session under its own agent; the thread keeps its id and who opened it", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "--agent", "codex", "first");
    await (await h.rt.sessions.start(alpha!.id, { prompt: "from the app", harness: "claude" })).finished;
    const [byCli, byPerson] = await h.rt.sessions.list();
    const { code, io } = await h.run("send", byCli!.threadId!, "second");
    expect(code).toBe(0);
    expect(h.codex.starts.map(s => [s.prompt, s.resume])).toEqual([["first", undefined], ["second", byCli!.claudeSessionId]]);
    expect(io.lines).toEqual(["codex: second"]);
    expect(io.streamed).toBe("code\n$ ls\nx: second\ncompleted\n");
    const followUp = await h.run("send", byPerson!.threadId!, "and this");
    expect(followUp.code).toBe(0);
    expect(h.claude.starts.map(s => [s.prompt, s.resume])).toEqual([["from the app", undefined], ["and this", byPerson!.claudeSessionId]]);

    // Every start the verbs made carries its own request id on the wire and on the recorded start, so an app view with
    // the same text in flight cannot take it for its own; the app's start through the runtime sent none.
    const requestIds = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start").map(e => e.requestId);
    expect(requestIds.map(id => typeof id)).toEqual(["string", "undefined", "string", "string"]);
    expect(new Set(requestIds).size).toBe(4);

    // A resumed turn takes over its thread's row, as the app sees it too: one row per thread, the opener kept.
    const listed = await h.run("threads", "--json");
    const [{ threads }] = h.json(listed.io) as [{ threads: ThreadView[] }];
    expect(threads.map(t => [t.id, t.harness, t.startedBy, t.title, t.turns])).toEqual([
      [byCli!.threadId, "codex", "cli", "first", 1],
      [byPerson!.threadId, "claude", "person", "from the app", 1],
    ]);

    const prefixed = await h.run("send", byCli!.threadId!.slice(0, 8), "third");
    expect(prefixed.code).toBe(0);
    const missing = await h.run("send", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp send: no thread nope"]);
  });

  it("a send whose start the host never answered before it stopped is delivered by the host that comes back, once, and never reads as a turn going on", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "first");
    const [thread] = await h.rt.sessions.list();
    for (const detach of [false, true]) {
      // This host takes the start and never answers it, and records nothing: the window between the send's dial and
      // the start's answer, which a host that stops leaves as it goes.
      let reached = 0;
      h.rt.sessions.start = (() => {
        reached++;
        return new Promise(() => {});
      }) as typeof h.rt.sessions.start;
      const message = detach ? "third" : "second";
      const send = h.starting("send", thread!.threadId!, ...(detach ? ["--detach"] : []), message);
      await vi.waitFor(() => expect(reached).toBe(1), { timeout: 5_000, interval: 10 });
      await h.restartHost({ claude: h.claude.adapter });
      expect(await send.ended).toBe(0);
      expect(send.io.errors.filter(line => line.includes(HOST_STOPPING_LINE))).toEqual([]);
      if (!detach) expect(send.io.lines).toEqual([`re: ${message}`]);
      await vi.waitFor(async () => expect((await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.done" && e.sessionId !== undefined).length).toBe(detach ? 3 : 2), { timeout: 5_000, interval: 10 });
      // One start of the message on the thread, under the one request id the send minted.
      const starts = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start" && e.prompt === message);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({ threadId: thread!.threadId, requestId: expect.any(String) });
    }
  });

  it("a send the host took and stopped before it answered is not sent again: the host that comes back holds it, and the send follows that turn", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "first");
    const [thread] = await h.rt.sessions.list();
    // This host runs the start and records it, then never answers it.
    const took = h.rt.sessions.start.bind(h.rt.sessions);
    let reached = 0;
    h.rt.sessions.start = (async (...args: Parameters<typeof h.rt.sessions.start>) => {
      reached++;
      await took(...args);
      return new Promise(() => {});
    }) as typeof h.rt.sessions.start;
    const send = h.starting("send", thread!.threadId!, "second");
    await vi.waitFor(async () => expect((await h.rt.sessions.history(alpha!.id)).some(e => e.type === "session.start" && e.prompt === "second")).toBe(true), { timeout: 5_000, interval: 10 });
    await h.restartHost({ claude: h.claude.adapter });
    expect(await send.ended).toBe(0);
    expect(reached).toBe(1);
    expect(h.claude.starts.map(s => s.prompt)).toEqual(["first", "second"]);
    const [second] = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start" && e.prompt === "second") as { turnId?: string; requestId?: string }[];
    expect(send.io.errors.filter(line => line.includes(HOST_STOPPING_LINE))).toEqual([]);
    // The rule is the host's: a start under a request id its transcript holds answers with that turn and starts nothing.
    const again = await h.rt.sessions.start(alpha!.id, { prompt: "second", thread: thread!.threadId!, requestId: second!.requestId! });
    expect([again.turnId, again.outcome]).toEqual([second!.turnId, "started"]);
    expect(h.claude.starts.map(s => s.prompt)).toEqual(["first", "second"]);
  });

  it("a run whose host stops under the reads before its start fails in one line saying the task was not delivered", async () => {
    await h.run("new", "alpha");
    let reached = 0;
    h.rt.harnesses.list = (() => {
      reached++;
      return new Promise(() => {});
    }) as typeof h.rt.harnesses.list;
    const started = h.starting("run", "alpha", "build it");
    await vi.waitFor(() => expect(reached).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    await h.handle!.close();
    h.handle = undefined;
    expect(await started.ended).toBe(1);
    expect(started.io.errors).toEqual([`wsp run: ${NOT_DELIVERED_LINE}`]);
  });

  it("a host that boots over an index file written before it kept starts by request id reads the transcript again, so a start sent again is still the one it took", async () => {
    await h.run("new", "alpha");
    const [alpha] = await h.rt.workspaces.list();
    await h.run("run", "alpha", "first");
    const [first] = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start") as { turnId?: string; requestId?: string; threadId?: string }[];
    await h.handle!.close();
    h.handle = undefined;
    // The index as a host of the build before wrote it: every map it kept then, and none by request id.
    const held = await h.store.getBlob("transcript-index", alpha!.id);
    expect(held).toBeDefined();
    const { taken: _taken, ...older } = JSON.parse(held!.toString("utf8")) as Record<string, unknown>;
    await h.store.putBlob("transcript-index", alpha!.id, Buffer.from(JSON.stringify(older)));
    await h.restartHost({ claude: h.claude.adapter });
    const again = await h.rt.sessions.start(alpha!.id, { prompt: "first", thread: first!.threadId!, requestId: first!.requestId! });
    expect(again.turnId).toBe(first!.turnId);
    expect(h.claude.starts.map(s => s.prompt)).toEqual(["first"]);
  });

  it("a send whose host stops before it sent anything fails in one line saying the message was not delivered", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "first");
    const [thread] = await h.rt.sessions.list();
    let reached = 0;
    h.rt.sessions.list = (() => {
      reached++;
      return new Promise(() => {});
    }) as typeof h.rt.sessions.list;
    const send = h.starting("send", thread!.threadId!, "second");
    await vi.waitFor(() => expect(reached).toBeGreaterThan(0), { timeout: 5_000, interval: 10 });
    await h.handle!.close();
    h.handle = undefined;
    expect(await send.ended).toBe(1);
    expect(send.io.errors).toEqual([`wsp send: ${NOT_DELIVERED_LINE}`]);
  });

  it("send into a thread whose turn runs joins that turn when the agent steers: one stderr line, the running turn's reply, one session.start and one session.steer", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "loop for a minute, then say done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const sent = h.run("send", row!.threadId!, "--model", "claude-sonnet-5", "--effort", "low", "end your last line with STEERED");
    await vi.waitFor(() => expect(held.steered).toEqual(["end your last line with STEERED"]));
    expect(held.starts).toHaveLength(1);
    held.release(0, "done STEERED");
    const opened = await first;
    const joined = await sent;
    expect(joined.code).toBe(0);
    // The picks cannot change a turn already running; the one line says which were dropped.
    expect(joined.io.errors).toEqual(["joined the running turn; --model, --effort dropped, it keeps its own model, effort and access"]);
    expect(joined.io.lines).toEqual(["done STEERED"]);
    expect(joined.io.streamed).toBe("done STEERED\ncompleted\n");
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "done STEERED"]);
    const [alpha] = await h.rt.workspaces.list();
    const history = await h.rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history[1]).toMatchObject({ type: "session.steer", prompt: "end your last line with STEERED", requestId: expect.any(String) });
    expect(await h.rt.sessions.list()).toHaveLength(1);
  });

  it("a message that joined a turn stopped on a prompt says the turn is waiting on the person, so the quiet has a reason", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "write it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    held.ask(0, { askId: "a1", toolName: "Write", input: JSON.stringify({ file_path: "kai.txt" }), options: [{ id: "allow", label: "Yes", effect: "allow" }, { id: "deny", label: "No", effect: "deny" }] });
    const [row] = await h.rt.sessions.list();
    const io = captured();
    const sent = cli(["send", row!.threadId!, "yes", "--state", h.statePath], io, undefined, h.env);
    await vi.waitFor(() => expect(io.errors).toEqual(["joined the running turn", `the turn is waiting on a permission; wsp threads shows it as ${threadStateWord("waiting")}`]));
    held.release(0, "done");
    expect(await sent).toBe(0);
    await first;
  });

  it("send into a thread whose turn runs on an agent that cannot steer waits for that turn, then starts its own: one stderr line, the second start after the first done", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const sent = h.run("send", row!.threadId!, "two");
    await new Promise(r => setTimeout(r, 50));
    expect(held.starts).toHaveLength(1);
    held.release(0, "one done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    expect(held.starts.map(s => [s.prompt, s.resume])).toEqual([["one", undefined], ["two", row!.claudeSessionId]]);
    expect((await first).io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "one done"]);
    held.release(1, "two done");
    const queued = await sent;
    expect(queued.code).toBe(0);
    expect(queued.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(queued.io.lines).toEqual(["two done"]);
    const [alpha] = await h.rt.workspaces.list();
    expect((await h.rt.sessions.history(alpha!.id)).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end", "session.start", "session.delta", "session.done", "session.end"]);
    expect(held.steered).toEqual([]);
  });

  it("stop ends the thread's running turn through the runtime and says so; a thread whose turn is over says not running; the machine stays up", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const first = h.run("run", "alpha", "loop forever");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await h.rt.sessions.list();
    const stopped = await h.run("stop", row!.threadId!.slice(0, 8));
    expect(stopped.code).toBe(0);
    expect(stopped.io.lines).toEqual([`thread ${row!.threadId} stopped`]);
    expect(held.interrupted).toEqual([row!.id]);
    const opened = await first;
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual(["wsp run: turn interrupted"]);
    expect((await h.rt.sessions.list())[0]).toMatchObject({ id: row!.id, status: "interrupted" });
    const [alpha] = await h.rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(h.backend.machines[0]).toMatchObject({ paused: false, killed: false });

    const idle = await h.run("stop", row!.threadId!, "--json");
    expect(idle.code).toBe(0);
    expect(h.json(idle.io)).toEqual([{ threadId: row!.threadId, outcome: "not-running" }]);
    expect(held.interrupted).toHaveLength(1);
    const missing = await h.run("stop", "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp stop: no thread nope"]);
  });

  it("an agent's own subagents list under their thread with their task ids, and stop --task stops one of them alone", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    void h.run("run", "alpha", "fan out");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]?.claudeSessionId).toBeDefined());
    held.spawn(0, "a1", "count alpha");
    held.spawn(0, "b2", "count beta");
    const [row] = await h.rt.sessions.list();
    const thread = row!.threadId!;
    const listed = await h.run("threads");
    const cells = listed.io.lines[0]!.split("\n").slice(1).map(r => r.trim().split(/ {2,}/));
    // A child's THREAD and TASK cells are the two words a stop of it takes; its state is its own, and its agent started it.
    expect(cells.map(c => c.slice(2))).toEqual([
      [thread, "claude", "Working", "cli", expect.any(String), "fan out"],
      [thread, "a1", "claude", "Working", "agent", expect.any(String), "count alpha"],
      [thread, "b2", "claude", "Working", "agent", expect.any(String), "count beta"],
    ]);

    const stopped = await h.run("stop", thread.slice(0, 8), "--task", "a1");
    expect(stopped.code).toBe(0);
    expect(stopped.io.lines).toEqual([`thread ${thread} task a1 stopped`]);
    expect(held.tasksStopped).toEqual(["a1"]);
    expect(held.interrupted).toEqual([]);
    await vi.waitFor(async () => expect((await h.rt.sessions.list())[0]!.subagents?.map(c => c.state)).toEqual(["stopped", "running"]));
    const json = await h.run("threads", "--json");
    expect((JSON.parse(json.io.lines.at(-1)!) as { threads: ThreadView[] }).threads[0]!.subagents?.map(c => [c.id, c.state])).toEqual([["a1", "stopped"], ["b2", "running"]]);
    expect((await h.rt.sessions.list())[0]!.status).toBe("running");
    held.release(0, "done");
  });

  it("thread rename names the thread in the agent's own store and says so; an agent that keeps no name, one whose store has no such session, and an unknown thread each say why", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, title => (title === "nowhere" ? { kind: "no-session" } : title === "locked" ? { kind: "failed", error: "database is locked" } : { kind: "written" }));
    await h.restartHost({ claude: named.adapter, codex: h.codex.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const [row] = await h.rt.sessions.list();

    const renamed = await h.run("thread", "rename", row!.threadId!.slice(0, 8), "the name he typed");
    expect(renamed.code).toBe(0);
    expect(renamed.io.lines).toEqual([`thread ${row!.threadId} named the name he typed, in Claude Code too`]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name he typed" }]);
    expect(ThreadView.parse((await threadRows(await dialHost(h.statePath)))[0]).title).toBe("the name he typed");

    const nowhere = await h.run("thread", "rename", row!.threadId!, "nowhere", "--json");
    expect(nowhere.code).toBe(0);
    expect(h.json(nowhere.io)).toEqual([{ threadId: row!.threadId, title: "nowhere", harness: "claude", outcome: "no-session" }]);

    // A store that refused the write says nothing about its sessions, so its own line is the answer, not "no such session".
    const locked = await h.run("thread", "rename", row!.threadId!, "locked");
    expect(locked.code).toBe(0);
    expect(locked.io.lines).toEqual([`thread ${row!.threadId} not named: database is locked`]);
    expect(h.json((await h.run("thread", "rename", row!.threadId!, "locked", "--json")).io)).toEqual([
      { threadId: row!.threadId, title: "locked", harness: "claude", outcome: "failed", error: "database is locked" },
    ]);

    await h.run("run", "alpha", "--agent", "codex", "build it there");
    const codexRow = (await h.rt.sessions.list()).find(v => v.harness === "codex")!;
    const unsupported = await h.run("thread", "rename", codexRow.threadId!, "the name");
    expect(unsupported.code).toBe(0);
    expect(unsupported.io.lines).toEqual([`thread ${codexRow.threadId} not named: Codex keeps no name of a person's for a session`]);

    const missing = await h.run("thread", "rename", "nope", "the name");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp thread rename: no thread nope"]);
    const short = await h.run("thread", "rename", row!.threadId!);
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp thread rename takes a thread and one name. usage: wsp thread rename <thread> \"<title>\""]);
  });

  it("thread rename wakes a napping workspace first, since the name goes into a store on its machine", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, () => ({ kind: "written" }));
    await h.restartHost({ claude: named.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "build it");
    const [row] = await h.rt.sessions.list();
    await h.run("pause", "alpha");
    const renamed = await h.run("thread", "rename", row!.threadId!, "the name");
    expect(renamed.code).toBe(0);
    expect(renamed.io.errors).toEqual(["waking alpha"]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name" }]);
    const [alpha] = await h.rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
  });

  it("run --notify me prints the thread's end once on stderr, after the reply, and records it in the thread", async () => {
    await h.run("new", "alpha");
    const { code, io } = await h.run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await h.rt.sessions.list();
    const line = `thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`;
    expect(io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(io.errors).toEqual([line]);
    const [alpha] = await h.rt.workspaces.list();
    const history = await h.rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.notify", "session.done", "session.end"]);
    expect(history[4]).toMatchObject({ type: "session.notify", notify: "me", text: line, threadId: row!.threadId });

    const later = await h.run("send", row!.threadId!, "and the docs");
    expect(later.io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: and the docs`]);
    expect(later.io.lines).toEqual(["re: and the docs"]);
  });

  it("run --notify <thread> tells that thread, by a prefix of its id, when the child ends: the running parent takes the line as a steer and the child's command prints no notice", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const parent = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await h.rt.sessions.list();
    const kid = h.run("run", "alpha", "--notify", parentRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    expect(built.io.lines).toEqual([`thread ${kidRow.threadId}  ${THREAD_PREFIX_WORD}`, "all green"]);
    expect(built.io.errors).toEqual([]);
    held.release(0, "read the report");
    expect((await parent).io.lines).toEqual([`thread ${parentRow!.threadId}  ${THREAD_PREFIX_WORD}`, "read the report"]);
    expect(held.starts).toHaveLength(2);
    const [alpha] = await h.rt.workspaces.list();
    const history = await h.rt.sessions.history(alpha!.id);
    expect(history.filter(e => e.threadId === parentRow!.threadId).map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ prompt: line });
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });

    const missing = await h.run("run", "alpha", "--notify", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp run: no thread nope"]);
    expect(held.starts).toHaveLength(2);
  });

  it("--notify me run inside a turn names that turn's thread: the command line reads the token off the environment it runs with, and the parent is steered the child's report whole", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const parent = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await h.rt.sessions.list();
    // The environment the host launched that turn under is the one a wsp inside it would run with.
    const token = held.envs[0]![TURN_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    h.env[TURN_TOKEN_ENV] = token;
    const kid = h.run("run", "alpha", "--notify", "me", "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "Ran the gate.\nAll 12 tests green.");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): Ran the gate.\nAll 12 tests green.`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    // The child's own command prints no notice: the line went to the thread that asked for it, not to the person.
    expect(built.io.errors).toEqual([]);
    const [alpha] = await h.rt.workspaces.list();
    expect((await h.rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    held.release(0, "read the report");
    await parent;
  });

  // The one command line that reads the process's own environment is the one a person runs: every case here hands
  // its environment in, so without this case a refactor could take TURN_TOKEN_ENV away from the real command line and
  // nothing would say so. It sets the variable it reads, in its own process, which is what the environment law asks.
  it("cli called with no environment of its own reads this process's, which is what a shell gives it", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const parent = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await h.rt.sessions.list();
    vi.stubEnv(TURN_TOKEN_ENV, held.envs[0]![TURN_TOKEN_ENV]!);
    // No fourth argument: the default, which is this process's environment and nothing the case handed in.
    const io = captured();
    const kid = cli(["run", "alpha", "--notify", "me", "build it", "--state", h.statePath], io);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    // The token arrived: the runtime resolved NOTIFY_ME to the turn it named and steered that thread.
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    expect(await kid).toBe(0);
    held.release(0, "read the report");
    await parent;
  });

  it("--notify repeats: a builder's end reaches the orchestrator that started it and a reviewer thread, each once", async () => {
    const held = heldAgent(true);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const orchestrator = h.run("run", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const reviewer = h.run("run", "alpha", "review what lands");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const rows = await h.rt.sessions.list();
    const [leadRow, reviewRow] = rows;
    h.env[TURN_TOKEN_ENV] = held.envs[0]![TURN_TOKEN_ENV]!;
    const kid = h.run("run", "alpha", "--notify", "me", "--notify", reviewRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    const kidRow = (await h.rt.sessions.list()).find(r => r.threadId !== leadRow!.threadId && r.threadId !== reviewRow!.threadId)!;
    held.release(2, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line, line]));
    expect((await kid).code).toBe(0);
    const [alpha] = await h.rt.workspaces.list();
    const told = (await h.rt.sessions.history(alpha!.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => e.notify)).toEqual([leadRow!.threadId, reviewRow!.threadId]);
    expect(told.map(e => e.text)).toEqual([line, line]);
    held.release(0, "read the report");
    held.release(1, "reviewed");
    await orchestrator;
    await reviewer;
  });

  it("--notify me with no token in the environment is still the person's, so a person's own shell and the app are unchanged", async () => {
    await h.run("new", "alpha");
    expect(h.env[TURN_TOKEN_ENV]).toBeUndefined();
    const { code, io } = await h.run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await h.rt.sessions.list();
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);
    const [alpha] = await h.rt.workspaces.list();
    expect((await h.rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ notify: "me" });
  });

  it("a token no turn on this host carries is refused, and nothing starts", async () => {
    await h.run("new", "alpha");
    h.env[TURN_TOKEN_ENV] = "f".repeat(32);
    const { code, io } = await h.run("run", "alpha", "--notify", "me", "build it");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual([`wsp run: ${NO_SUCH_TURN}`]);
    expect(io.lines).toEqual([]);
    expect(await h.rt.sessions.list()).toEqual([]);
  });

  it.runIf(CLOUD_ON)("fork --send --notify me prints the first turn's end on stderr as run does; a bad --notify fails before any machine is minted", async () => {
    await h.run("new", "alpha");
    withDaemonRoads(h.backend);
    const { code, io } = await h.run("fork", "alpha", "--name", "worker", "--send", "build it", "--notify", "me");
    expect(code).toBe(0);
    const worker = (await h.rt.workspaces.list()).find(w => w.name === "worker")!;
    const [row] = await h.rt.sessions.list(worker.id);
    expect(io.lines).toEqual([`created worker ${worker.id}, a copy of ${worker.project.name} at ${worker.project.path}\n${childStartedLine("worker", "work")}`, `thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`, "re: build it"]);
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);

    const bad = await h.run("fork", "alpha", "--name", "never", "--send", "build it", "--notify", "nope");
    expect(bad.code).toBe(EXIT_CODES.usage);
    expect(bad.io.lines).toEqual([]);
    expect(bad.io.errors).toEqual(["wsp fork: no thread nope"]);
    expect((await h.rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "worker"]);
  });

  it("send --json prints the turn's raw events and nothing else", async () => {
    await h.run("new", "alpha");
    await h.run("run", "alpha", "first");
    const [first] = await h.rt.sessions.list();
    const { code, io } = await h.run("send", first!.threadId!, "second", "--json");
    expect(code).toBe(0);
    const events = h.json(io) as { type: string; threadId?: string; kind?: string; text?: string }[];
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.done", undefined]);
    expect(events.at(-1)).toEqual({ threadId: first!.threadId, workspaceId: first!.workspaceId, harness: "claude", text: "re: second", outcome: "started" });
    expect(new Set(events.map(e => e.threadId))).toEqual(new Set([first!.threadId]));
    expect(events[1]).toMatchObject({ kind: "text", text: "re: " });
    expect(io.streamed).toBe("");
  });

  it("run --detach and send --detach print the thread id and return the moment the turn is started, before it ends; nothing streams", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    const opened = await h.run("run", "alpha", "--detach", "build it");
    expect(held.starts).toHaveLength(1);
    const [row] = await h.rt.sessions.list();
    expect(row).toMatchObject({ status: "running", startedBy: "cli", prompt: "build it" });
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(opened.io.errors).toEqual([]);
    expect(opened.io.streamed).toBe("");
    held.release(0, "first done");
    expect((await h.rt.sessions.list())[0]!.status).toBe("completed");
    const sent = await h.run("send", row!.threadId!.slice(0, 8), "--detach", "--json", "more");
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more"]);
    expect(sent.code).toBe(0);
    expect(h.json(sent.io)).toEqual([{ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", outcome: "started" }]);
    expect((await h.rt.sessions.list())[0]!.status).toBe("running");
    held.release(1, "second done");
    // A detached send that meets a running turn on an agent that cannot steer waits for its own start, as a followed one does, and says so.
    const third = await h.run("send", row!.threadId!, "--detach", "third");
    expect(third.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(held.starts).toHaveLength(3);
    const fourth = h.starting("send", row!.threadId!, "--detach", "fourth");
    // The waiting line is the runtime's answer that this start is behind the running turn: releasing that turn before
    // the line lands leaves the fourth start nothing to queue behind, so the fact is waited on and not a sleep.
    await vi.waitFor(() => expect(fourth.io.errors).toEqual(["waiting behind the running turn"]), { timeout: 10_000, interval: 10 });
    expect(held.starts).toHaveLength(3);
    held.release(2, "third done");
    await fourth.ended;
    expect(fourth.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(fourth.io.lines).toEqual([`thread ${row!.threadId}  ${THREAD_PREFIX_WORD}`]);
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more", "third", "fourth"]);
    held.release(3, "fourth done");
  });

  it("threads wait returns the first of two threads to finish, in the notify line's words, then the second; a thread already over comes back at once from its transcript; a timeout prints nothing on stdout and says so on stderr", async () => {
    const held = heldAgent(false);
    await h.restartHost({ claude: held.adapter });
    await h.run("new", "alpha");
    await h.run("run", "alpha", "--detach", "--notify", "me", "build a");
    await h.run("run", "alpha", "--detach", "build b");
    const [a, b] = await h.rt.sessions.list();
    const timedOut = await h.run("threads", "wait", a!.threadId!, b!.threadId!.slice(0, 8), "--timeout", "0.05");
    expect(timedOut.code).toBe(0);
    expect(timedOut.io.lines).toEqual([]);
    expect(timedOut.io.errors).toEqual(["2 threads still running after 50ms"]);
    const asJson = await h.run("threads", "wait", a!.threadId!, "--timeout", "0.05", "--json");
    expect(h.json(asJson.io)).toEqual([{ timedOut: true }]);
    expect(asJson.io.errors).toEqual([`thread ${a!.threadId!.slice(0, 8)} still running after 50ms`]);
    const now = Date.now;
    let skew = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + (skew += 5));
    const late = await h.run("threads", "wait", a!.threadId!, "--timeout", "0.05").finally(() => clock.mockRestore());
    expect(late.io.errors).toEqual([`thread ${a!.threadId!.slice(0, 8)} still running after 50ms`]);

    const waiting = h.run("threads", "wait", a!.threadId!, b!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(1, "b is green\nall done for b");
    const first = await waiting;
    expect(first.code).toBe(0);
    // The whole reply under the finished line, not its last line: Marco waited on two threads and read a closing
    // remark off one and a code fence off the other, with the answers he was waiting for nowhere on his screen.
    expect(first.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): b is green\nall done for b`]);
    expect(first.io.lines[0]).toBe(notifyLine(b!.threadId!, { status: "completed", text: "b is green\nall done for b" }, "whole"));
    expect(first.io.errors).toEqual([]);
    // --tail is the last line alone, the line a notify sends; b is over, so it comes back at once.
    const tail = await h.run("threads", "wait", b!.threadId!, "--tail");
    expect(tail.code).toBe(0);
    expect(tail.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): all done for b`]);
    // b is over, so a wait naming both comes back with b at once, read off the transcript; the JSON is the tool's object.
    const again = await h.run("threads", "wait", a!.threadId!, b!.threadId!, "--json");
    expect(again.code).toBe(0);
    expect(h.json(again.io)).toEqual([{ finished: { threadId: b!.threadId, status: "completed", reply: "all done for b" } }]);

    const onlyA = h.run("threads", "wait", a!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(0, "a done");
    const second = await onlyA;
    expect(second.io.lines).toEqual([`thread ${a!.threadId!.slice(0, 8)} finished (completed): a done`]);
    // The words are the one formatter's: the line the runtime recorded for a's --notify me is the line the wait printed.
    const history = await h.rt.sessions.history(a!.workspaceId);
    expect(history.find(e => e.type === "session.notify" && e.threadId === a!.threadId)).toMatchObject({ text: second.io.lines[0] });
    expect(second.io.lines[0]).toBe(notifyLine(a!.threadId!, { status: "completed", text: "a done" }));
    expect(held.starts).toHaveLength(2);

    const none = await h.run("threads", "wait");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp threads wait takes one thread or more");
    const soon = await h.run("threads", "wait", a!.threadId!, "--timeout", "soon");
    expect(soon.code).toBe(3);
    expect(soon.io.errors[0]).toContain('--timeout takes seconds, a number above zero, and got "soon".');
    const missing = await h.run("threads", "wait", a!.threadId!, "nope");
    expect(missing.code).toBe(EXIT_CODES.usage);
    expect(missing.io.errors).toEqual(["wsp threads wait: no thread nope"]);
    // One word is the workspace it lists; two is more than the line takes.
    const stray = await h.run("threads", "nope", "also");
    expect(stray.code).toBe(3);
    expect(stray.io.errors[0]).toContain("wsp threads takes at most one project; wsp threads wait is its one subcommand");
    // Marco typed wsp threads read <thread> and this refusal was where he learned there was no such line; it names
    // the one there is.
    expect(stray.io.errors[0]).toContain("wsp thread read <thread> prints what one said");
  });

  it("threads wait on a thread whose first turn has not reached the machine blocks for that turn; the same thread once its turn is over comes back at once with its finished line", async () => {
    const held = heldAgent(false);
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    // The harness's own lists come off the machine before the turn is launched: seconds on a real machine, and the
    // window this case is about.
    await h.restartHost({ claude: ctx => ({ ...held.adapter(ctx), probeCatalog: async () => (await probed, null) }) });
    await h.run("new", "alpha");
    const [ws] = await h.rt.workspaces.list();
    const starting = h.rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await h.rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await h.rt.sessions.list())[0]!.threadId!;
    expect(held.starts).toHaveLength(0);

    let answered = false;
    const waiting = h.run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    letProbe();
    await starting;
    expect(held.starts.map(s => s.prompt)).toEqual(["build it"]);
    // Still nothing: the turn the wait was told to wait for is only now running.
    await new Promise(r => setTimeout(r, 50));
    expect(answered).toBe(false);
    held.release(0, "all green");
    const finished = await waiting;
    expect(finished.code).toBe(0);
    expect(finished.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    const again = await h.run("threads", "wait", thread);
    expect(again.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    // A thread whose launch never reached the machine has no turn and never will; the wait answers at once for it too.
    await h.restartHost({ claude: bornDeadAgent(prompt => `re: ${prompt}`).adapter });
    await h.run("run", "alpha", "--detach", "never lands");
    const stillborn = (await h.rt.sessions.list()).find(r => r.prompt === "never lands")!;
    const atOnce = await h.run("threads", "wait", stillborn.threadId!);
    expect(atOnce.code).toBe(0);
    expect(atOnce.io.lines).toEqual([`thread ${stillborn.threadId!.slice(0, 8)} finished (failed): ${UNREACHED_LINE}`]);
  });
});
