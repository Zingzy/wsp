// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { ThreadView } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HELP, cli, serve } from "../src/cli.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { dialHost } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { EXPORT_SESSION, EXPORT_SOURCE, PAGE, captured, execGuest, exportGuest, launchedScript, projectBundler, doneOnlyAgent, heldAgent, scriptedAgent, stuckAgent, type Captured } from "./verbs-fixture.js";

describe("wsp verbs over the host", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let claude: ReturnType<typeof scriptedAgent>;
  let codex: ReturnType<typeof scriptedAgent>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-verbs-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    await store.put("goldens", "default", SEALED_GOLDEN);
    claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`));
    codex = scriptedAgent(prompt => `codex: ${prompt}`);
    rt = createRuntime({ backend, store, adapters: { claude: claude.adapter, codex: codex.adapter } });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
    // The host has its keys; the verbs never read any.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** --state goes before any `--`, where exec's command begins. */
  async function run(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    const cut = argv.indexOf("--");
    const at = cut === -1 ? argv.length : cut;
    const code = await cli([...argv.slice(0, at), "--state", statePath, ...argv.slice(at)], io);
    return { code, io };
  }
  const json = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  const head = (m: typeof SEALED_GOLDEN) => m.versions.find(v => v.version === m.head)!;

  it("new forks the golden's head into a workspace of that name, streams the create's stages and prints the id", async () => {
    const { code, io } = await run("new", "alpha");
    expect(code).toBe(0);
    const [ws] = await rt.workspaces.list();
    expect(ws).toMatchObject({ name: "alpha", golden: head(SEALED_GOLDEN).snapshotId, phase: "running" });
    expect(io.lines).toEqual([`created alpha ${ws!.id}`]);
    expect(io.streamed).toContain("\n");
    expect(io.errors).toEqual([]);

    const again = await run("new", "beta", "--json");
    expect(again.code).toBe(0);
    const values = json(again.io) as { type?: string; name?: string; workspace?: unknown }[];
    expect(values.length).toBeGreaterThan(1);
    expect(values.slice(0, -1).every(v => v.type === "workspace.creating" && v.name === "beta")).toBe(true);
    expect(values.at(-1)).toEqual({ workspace: expect.objectContaining({ name: "beta" }) });
    expect(again.io.streamed).toBe("");
  });

  it("new refuses in one line when there is no golden", async () => {
    await handle!.close();
    handle = undefined;
    rt = createRuntime({ backend, store: memoryStore(), adapters: {} });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    const { code, io } = await run("new", "alpha");
    expect(code).toBe(1);
    expect(io.errors).toEqual(["wsp new: no golden yet; run wsp init"]);
    expect(await rt.workspaces.list()).toEqual([]);
  });

  it("fork makes a sibling from the source's own golden version, by name or id, and --send opens its first thread", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const plain = await run("fork", "alpha");
    expect(plain.code).toBe(0);
    const forks = (await rt.workspaces.list()).filter(w => w.id !== alpha!.id);
    expect(forks.map(w => [w.name, w.golden])).toEqual([["alpha-fork", alpha!.golden]]);
    expect(plain.io.lines).toEqual([`created alpha-fork ${forks[0]!.id}`]);

    const sent = await run("fork", alpha!.id, "--name", "worker", "--send", "build it");
    expect(sent.code).toBe(0);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [thread] = await rt.sessions.list(worker.id);
    expect(thread).toMatchObject({ harness: "claude", startedBy: "cli", prompt: "build it", status: "completed" });
    expect(sent.io.lines).toEqual([`created worker ${worker.id}`, `thread ${thread!.threadId}`, "re: build it"]);
    expect(sent.io.streamed.endsWith("re: build it")).toBe(true);
  });

  it("fork's help says it makes a new machine from the source's golden version, in wsp --help and wsp fork --help", async () => {
    const line = "a new machine from the source's golden version";
    expect(HELP).toContain(line);
    const { code, io } = await run("fork", "--help");
    expect(code).toBe(0);
    expect(io.lines[0]).toContain(line);
  });

  it("every line of wsp --help fits 100 columns", () => {
    const wide = HELP.split("\n").filter(l => l.length > 100);
    expect(wide).toEqual([]);
  });

  it("pause naps the workspace and says so in the state vocabulary", async () => {
    await run("new", "alpha");
    const { code, io } = await run("pause", "alpha");
    expect(code).toBe(0);
    expect(io.lines).toEqual(["alpha paused"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    const missing = await run("pause", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp pause: no workspace nope"]);
  });

  it("forget asks once, naming what goes, drops a workspace whose machine is gone, and is refused with the reason while the machine exists", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    await run("thread", "new", "--in", "alpha", "build it");
    const alpha = (await rt.workspaces.list()).find(w => w.name === "alpha")!;
    const live = await run("forget", "alpha", "--yes");
    expect(live.code).toBe(1);
    expect(live.io.errors).toEqual(["wsp forget: alpha's machine m1 is still running; pause it or delete it at the provider first"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    backend.machines[0]!.killed = true;
    const asked: string[] = [];
    const answer = async (reply: string, ...argv: string[]): Promise<{ code: number; io: Captured }> => {
      const io = captured();
      io.ask = async q => {
        asked.push(q);
        return reply;
      };
      return { code: await cli([...argv, "--state", statePath], io), io };
    };
    const kept = await answer("no", "forget", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(asked).toEqual(["Forget alpha?\nIts record and 1 thread leave this computer; the machine is already gone."]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);

    const forgot = await answer("yes", "forget", alpha.id);
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot alpha ${alpha.id}: its record and 1 thread are gone from this computer`]);
    expect(forgot.io.errors).toEqual([]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await rt.sessions.list(alpha.id)).toEqual([]);
    expect(await store.get("workspaces", alpha.id)).toBeUndefined();
    expect(await store.get("transcripts", alpha.id)).toBeUndefined();

    backend.machines[1]!.killed = true;
    const beta = (await rt.workspaces.list())[0]!;
    const asJson = await run("forget", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ forgot: { workspaceId: beta.id, name: "beta", threads: 0 } }]);
    expect(await rt.workspaces.list()).toEqual([]);

    const missing = await run("forget", "nope", "--yes");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp forget: no workspace nope"]);
  });

  it("thread new opens a thread under the named agent, announces it, streams the reply and prints the last message", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const { code, io } = await run("thread", "new", "--in", "alpha", "--agent", "codex", "write tests");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list(alpha!.id);
    expect(row).toMatchObject({ harness: "codex", startedBy: "cli", prompt: "write tests", status: "completed" });
    expect(codex.starts.map(s => s.prompt)).toEqual(["write tests"]);
    expect(claude.starts).toEqual([]);
    expect(io.lines).toEqual([`thread ${row!.threadId}`, "codex: write tests"]);
    expect(io.streamed).toBe("codex: write tests");
    expect(io.errors).toEqual([]);
  });

  it("thread new without an agent takes the runtime's default; an agent the runtime has no adapter for is refused by the runtime", async () => {
    await run("new", "alpha");
    const ok = await run("thread", "new", "--in", "alpha", "hello");
    expect(ok.code).toBe(0);
    expect((await rt.sessions.list())[0]).toMatchObject({ harness: "claude", startedBy: "cli" });
    const refused = await run("thread", "new", "--in", "alpha", "--agent", "gemini", "hello");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual(['wsp thread new: no adapter registered for harness "gemini"']);
  });

  it("a failed turn exits 1 with the error on stderr and no last message", async () => {
    await run("new", "alpha");
    const { code, io } = await run("thread", "new", "--in", "alpha", "die");
    expect(code).toBe(1);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^thread /);
    expect(io.errors).toEqual(["the harness died"]);
  });

  it("threads is the sidebar's data: one row per thread with agent, state, who opened it and its folder, filtered by --in", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const [alpha, beta] = await rt.workspaces.list();
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    await run("thread", "new", "--in", "alpha", "first task");
    await (await rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const { code, io } = await run("threads");
    expect(code).toBe(0);
    const rows = io.lines[0]!.split("\n");
    expect(rows[0]).toMatch(/^THREAD\s+WORKSPACE\s+AGENT\s+STATE\s+BY\s+FOLDER\s+TITLE$/);
    const [a] = await rt.sessions.list(alpha!.id);
    const [b] = await rt.sessions.list(beta!.id);
    expect(rows.slice(1)).toEqual([
      `${a!.threadId}  alpha      claude  completed  cli     /root/work/proj  first task`,
      `${b!.threadId}  beta       codex   completed  person                   from the app`,
    ]);

    const scoped = await run("threads", "--in", "beta", "--json");
    expect(scoped.code).toBe(0);
    const [{ threads }] = json(scoped.io) as [{ threads: ThreadView[] }];
    expect(threads.map(t => ThreadView.parse(t))).toEqual(threads);
    expect(threads).toEqual([expect.objectContaining({ id: b!.threadId, workspaceId: beta!.id, harness: "codex", startedBy: "person", turns: 1 })]);
  });

  it("thread new --cwd is the folder the turn starts in, the same field the app's composer sends; without it the workspace's project folder, else none and the harness starts in its own home", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const picked = await run("thread", "new", "--in", "alpha", "--agent", "codex", "--cwd", "/root/work/elsewhere", "write tests");
    expect(picked.code).toBe(0);
    expect(codex.starts.map(s => s.cwd)).toEqual(["/root/work/elsewhere"]);

    const bare = await run("thread", "new", "--in", "alpha", "hello");
    expect(bare.code).toBe(0);
    expect(claude.starts.map(s => s.cwd)).toEqual([undefined]);

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const inProject = await run("thread", "new", "--in", "alpha", "hello again");
    expect(inProject.code).toBe(0);
    expect(claude.starts.map(s => s.cwd)).toEqual([undefined, "/root/work/proj"]);
    const rows = await rt.sessions.list(alpha!.id);
    expect(rows.map(r => r.cwd)).toEqual(["/root/work/elsewhere", undefined, "/root/work/proj"]);
  });

  it("fork --send --cwd starts the first thread in that folder; without it, in the project folder the fork inherited, else none", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const picked = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--cwd", "/root/work/site");
    expect(picked.code).toBe(0);
    expect(claude.starts.map(s => s.cwd)).toEqual(["/root/work/site"]);

    const plain = await run("fork", "alpha", "--name", "other", "--send", "build it");
    expect(plain.code).toBe(0);
    expect(claude.starts.map(s => s.cwd)).toEqual(["/root/work/site", undefined]);

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const golden = await rt.workspaces.snapshot(alpha!.id);
    await run("new", "task", "--from", golden.snapshotId);
    const inherited = await run("fork", "task", "--name", "task-fork", "--send", "build it");
    expect(inherited.code).toBe(0);
    expect(claude.starts.at(-1)?.cwd).toBe("/root/work/proj");
  });

  it("a --cwd that is not absolute is refused with the usage line before anything is created, started or dialled; fork's --cwd needs --send", async () => {
    await run("new", "alpha");
    const relative = await run("thread", "new", "--in", "alpha", "--cwd", "packages/host", "look here");
    expect(relative.code).toBe(1);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute: got "packages/host"\n\nusage: wsp thread new --in <workspace> [--agent <name>] [--cwd <path>] [--notify <thread|me>] "<task>"']);
    const forked = await run("fork", "alpha", "--send", "build it", "--cwd", "packages/host");
    expect(forked.code).toBe(1);
    expect(forked.io.errors[0]).toMatch(/^--cwd is a path on the machine, absolute: got "packages\/host"\n\nusage: wsp fork /);
    const dangling = await run("fork", "alpha", "--cwd", "/root/work");
    expect(dangling.code).toBe(1);
    expect(dangling.io.errors).toEqual(["wsp fork: --cwd needs --send"]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await rt.sessions.list()).toEqual([]);
    expect(claude.starts).toEqual([]);
  });

  it("threads shortens a folder that would not fit its column with an ellipsis at the front, keeping the end a person recognises", async () => {
    await run("new", "alpha");
    const deep = "/root/work/a-project-with-a-long-name/packages/host/src";
    await run("thread", "new", "--in", "alpha", "--cwd", deep, "look here");
    const { io } = await run("threads");
    const [, line] = io.lines[0]!.split("\n");
    expect(line).toContain("  …ject-with-a-long-name/packages/host/src  look here");
    expect(line).not.toContain(deep);
    const asJson = await run("threads", "--json");
    const [{ threads }] = json(asJson.io) as [{ threads: ThreadView[] }];
    expect(threads[0]!.cwd).toBe(deep);
  });

  it("send resumes the thread's latest session under its own agent; the thread keeps its id and who opened it", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await run("thread", "new", "--in", "alpha", "--agent", "codex", "first");
    await (await rt.sessions.start(alpha!.id, { prompt: "from the app" })).finished;
    const [byCli, byPerson] = await rt.sessions.list();
    const { code, io } = await run("send", byCli!.threadId!, "second");
    expect(code).toBe(0);
    expect(codex.starts.map(s => [s.prompt, s.resume])).toEqual([["first", undefined], ["second", byCli!.claudeSessionId]]);
    expect(io.lines).toEqual(["codex: second"]);
    expect(io.streamed).toBe("codex: second");
    const followUp = await run("send", byPerson!.threadId!, "and this");
    expect(followUp.code).toBe(0);
    expect(claude.starts.map(s => [s.prompt, s.resume])).toEqual([["from the app", undefined], ["and this", byPerson!.claudeSessionId]]);

    // Every start the verbs made carries its own request id on the wire and on the recorded start, so an app view with
    // the same text in flight cannot take it for its own; the app's start through the runtime sent none.
    const requestIds = (await rt.sessions.history(alpha!.id)).filter(e => e.type === "session.start").map(e => e.requestId);
    expect(requestIds.map(id => typeof id)).toEqual(["string", "undefined", "string", "string"]);
    expect(new Set(requestIds).size).toBe(4);

    // A resumed turn takes over its thread's row, as the app sees it too: one row per thread, the opener kept.
    const listed = await run("threads", "--json");
    const [{ threads }] = json(listed.io) as [{ threads: ThreadView[] }];
    expect(threads.map(t => [t.id, t.harness, t.startedBy, t.title, t.turns])).toEqual([
      [byCli!.threadId, "codex", "cli", "second", 1],
      [byPerson!.threadId, "claude", "person", "and this", 1],
    ]);

    const prefixed = await run("send", byCli!.threadId!.slice(0, 8), "third");
    expect(prefixed.code).toBe(0);
    const missing = await run("send", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp send: no thread nope"]);
  });

  it("send into a thread whose turn runs joins that turn when the agent steers: one stderr line, the running turn's reply, one session.start and one session.steer", async () => {
    const held = heldAgent(true);
    await handle?.close();
    rt = createRuntime({ backend, store, adapters: { claude: held.adapter } });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    await run("new", "alpha");
    const first = run("thread", "new", "--in", "alpha", "loop for a minute, then say done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = run("send", row!.threadId!, "end your last line with STEERED");
    await vi.waitFor(() => expect(held.steered).toEqual(["end your last line with STEERED"]));
    expect(held.starts).toHaveLength(1);
    held.release(0, "done STEERED");
    const opened = await first;
    const joined = await sent;
    expect(joined.code).toBe(0);
    expect(joined.io.errors).toEqual(["joined the running turn"]);
    expect(joined.io.lines).toEqual(["done STEERED"]);
    expect(joined.io.streamed).toBe("done STEERED");
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}`, "done STEERED"]);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history[1]).toMatchObject({ type: "session.steer", prompt: "end your last line with STEERED", requestId: expect.any(String) });
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("send into a thread whose turn runs on an agent that cannot steer waits for that turn, then starts its own: one stderr line, the second start after the first done", async () => {
    const held = heldAgent(false);
    await handle?.close();
    rt = createRuntime({ backend, store, adapters: { claude: held.adapter } });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    await run("new", "alpha");
    const first = run("thread", "new", "--in", "alpha", "one");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = run("send", row!.threadId!, "two");
    await new Promise(r => setTimeout(r, 50));
    expect(held.starts).toHaveLength(1);
    held.release(0, "one done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    expect(held.starts.map(s => [s.prompt, s.resume])).toEqual([["one", undefined], ["two", row!.claudeSessionId]]);
    expect((await first).io.lines).toEqual([`thread ${row!.threadId}`, "one done"]);
    held.release(1, "two done");
    const queued = await sent;
    expect(queued.code).toBe(0);
    expect(queued.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(queued.io.lines).toEqual(["two done"]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", "session.end", "session.start", "session.delta", "session.done", "session.end"]);
    expect(held.steered).toEqual([]);
  });

  it("thread new --notify me prints the thread's end once on stderr, after the reply, and records it in the thread", async () => {
    await run("new", "alpha");
    const { code, io } = await run("thread", "new", "--in", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list();
    const line = `thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`;
    expect(io.lines).toEqual([`thread ${row!.threadId}`, "re: build it"]);
    expect(io.errors).toEqual([line]);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.notify", "session.done", "session.end"]);
    expect(history[4]).toMatchObject({ type: "session.notify", notify: "me", text: line, threadId: row!.threadId });

    const later = await run("send", row!.threadId!, "and the docs");
    expect(later.io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: and the docs`]);
    expect(later.io.lines).toEqual(["re: and the docs"]);
  });

  it("thread new --notify <thread> tells that thread, by a prefix of its id, when the child ends: the running parent takes the line as a steer and the child's command prints no notice", async () => {
    const held = heldAgent(true);
    await handle?.close();
    rt = createRuntime({ backend, store, adapters: { claude: held.adapter } });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    await run("new", "alpha");
    const parent = run("thread", "new", "--in", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    const kid = run("thread", "new", "--in", "alpha", "--notify", parentRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    expect(built.io.lines).toEqual([`thread ${kidRow.threadId}`, "all green"]);
    expect(built.io.errors).toEqual([]);
    held.release(0, "read the report");
    expect((await parent).io.lines).toEqual([`thread ${parentRow!.threadId}`, "read the report"]);
    expect(held.starts).toHaveLength(2);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.filter(e => e.threadId === parentRow!.threadId).map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history.find(e => e.type === "session.steer")).toMatchObject({ prompt: line });
    expect(history.find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });

    const missing = await run("thread", "new", "--in", "alpha", "--notify", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp thread new: no thread nope"]);
    expect(held.starts).toHaveLength(2);
  });

  it("fork --send --notify me prints the first turn's end on stderr as thread new does; a bad --notify fails before any machine is minted", async () => {
    await run("new", "alpha");
    const { code, io } = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--notify", "me");
    expect(code).toBe(0);
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    const [row] = await rt.sessions.list(worker.id);
    expect(io.lines).toEqual([`created worker ${worker.id}`, `thread ${row!.threadId}`, "re: build it"]);
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);

    const bad = await run("fork", "alpha", "--name", "never", "--send", "build it", "--notify", "nope");
    expect(bad.code).toBe(1);
    expect(bad.io.lines).toEqual([]);
    expect(bad.io.errors).toEqual(["wsp fork: no thread nope"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "worker"]);
  });

  it("send --json prints the turn's raw events and nothing else", async () => {
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "first");
    const [first] = await rt.sessions.list();
    const { code, io } = await run("send", first!.threadId!, "second", "--json");
    expect(code).toBe(0);
    const events = json(io) as { type: string; threadId?: string; kind?: string; text?: string }[];
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.done"]);
    expect(new Set(events.map(e => e.threadId))).toEqual(new Set([first!.threadId]));
    expect(events[1]).toMatchObject({ kind: "text", text: "re: " });
    expect(io.streamed).toBe("");
  });

  it("thread new, send and fork --send return with the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await handle?.close();
    rt = createRuntime({ backend, store, adapters: { claude: agent.adapter } });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
    await run("new", "alpha");
    const opened = await run("thread", "new", "--in", "alpha", "first");
    const [row] = await rt.sessions.list();
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}`, "re: first"]);
    expect(opened.io.errors).toEqual([]);
    const sent = await run("send", row!.threadId!, "second", "--json");
    expect(sent.code).toBe(0);
    expect((json(sent.io) as { type: string }[]).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done"]);
    const forked = await run("fork", "alpha", "--name", "worker", "--send", "third");
    expect(forked.code).toBe(0);
    expect(forked.io.lines.slice(1)).toEqual([expect.stringMatching(/^thread /), "re: third"]);
    expect(agent.starts.map(s => s.prompt)).toEqual(["first", "second", "third"]);
    expect((await rt.sessions.history(row!.workspaceId)).map(e => e.type)).not.toContain("session.end");
  });

  it("exec runs the command on the workspace's machine, streams its output and exits with its code", async () => {
    await run("new", "alpha");
    execGuest(backend, "one\ntwo\n", 3);
    const { code, io } = await run("exec", "alpha", "--", "sh", "-c", "printf 'one\\ntwo\\n'; exit 3");
    expect(code).toBe(3);
    expect(io.lines).toEqual(["one", "two"]);
    expect(launchedScript(backend)).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");

    const raw = await run("exec", "alpha", "--json", "--", "true");
    expect(raw.code).toBe(3);
    expect(json(raw.io)).toEqual([
      { type: "exec.output", execId: expect.any(String), text: "one" },
      { type: "exec.output", execId: expect.any(String), text: "two" },
      { type: "exec.exit", execId: expect.any(String), exitCode: 3 },
    ]);
    const bare = await run("exec", "alpha");
    expect(bare.code).toBe(1);
    expect(bare.io.errors).toEqual(["wsp exec: wsp exec takes a workspace, then -- and the command"]);
  });

  it("exec hands the machine each argument as it was given: a quoted word stays one word", async () => {
    await run("new", "alpha");
    execGuest(backend, "", 0);
    const { code } = await run("exec", "alpha", "--", "grep", "a b", "file.txt");
    expect(code).toBe(0);
    expect(launchedScript(backend)).toContain("\n'grep' 'a b' 'file.txt'\n");
  });

  it("the host going away mid-turn fails the verb in one line with exit 1 instead of hanging", async () => {
    await handle!.close();
    handle = undefined;
    rt = createRuntime({ backend, store, adapters: { claude: stuckAgent() } });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    await run("new", "alpha");
    execGuest(backend, "", undefined);
    const turn = run("thread", "new", "--in", "alpha", "hang");
    const command = run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    await handle.close();
    handle = undefined;
    const [t, c] = await Promise.all([turn, command]);
    expect(t.code).toBe(1);
    expect(t.io.errors).toEqual(["wsp thread new: the host closed the connection"]);
    expect(t.io.lines).toHaveLength(1);
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual(["wsp exec: the host closed the connection"]);
  });

  it("the workspace being deleted under a running exec fails the verb with the reason and exit 1", async () => {
    await run("new", "alpha");
    execGuest(backend, "", undefined);
    const command = run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    const [alpha] = await rt.workspaces.list();
    await rt.workspaces.delete(alpha!.id);
    const c = await command;
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual(["machine deleted while the agent was working"]);
  });

  it("a host whose sessions.start reply has no turn id or outcome is refused in one line before the follow, never printed as undefined", async () => {
    await handle!.close();
    handle = undefined;
    const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => old.once("listening", r));
    const wsPort = (old.address() as AddressInfo).port;
    writeFileSync(hostTokenPath(statePath), "tok\n");
    writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
    const workspace = { id: "ws_1", name: "alpha", machineId: "m1", phase: "running", golden: "snap_gold", createdAt: "2026-09-06T00:00:00.000Z" };
    const session = { id: "s_1", workspaceId: "ws_1", harness: "claude", status: "running", threadId: "t_1" };
    old.on("connection", socket => {
      socket.on("message", raw => {
        const { id, op } = JSON.parse(String(raw)) as { id: number; op: string };
        const reply = op === "workspaces.list" ? { workspaces: [workspace] } : op === "sessions.start" ? { session } : {};
        socket.send(JSON.stringify({ id, ok: true, ...reply }));
      });
    });
    try {
      const { code, io } = await run("thread", "new", "--in", "alpha", "first");
      expect(code).toBe(1);
      expect(io.lines).toEqual([]);
      expect(io.streamed).toBe("");
      expect(io.errors).toEqual(["wsp thread new: the host answered sessions.start in a shape this wsp does not read; it runs another version of wsp, restart it with wsp up"]);
    } finally {
      for (const client of old.clients) client.terminate();
      await new Promise(r => old.close(r));
    }
  });

  it("a port that accepts but never answers fails the dial within its deadline, before and after the handshake", async () => {
    await handle!.close();
    handle = undefined;
    const accepted: Socket[] = [];
    const silent = createServer(socket => accepted.push(socket));
    await new Promise<void>(r => silent.listen(0, "127.0.0.1", r));
    const mute = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>(r => mute.once("listening", r));
    writeFileSync(hostTokenPath(statePath), "tok\n");
    try {
      for (const server of [silent, mute]) {
        const wsPort = (server.address() as AddressInfo).port;
        writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
        await expect(dialHost(statePath, 200)).rejects.toThrow(`the host on port ${wsPort} did not answer within 200 ms`);
      }
    } finally {
      for (const client of mute.clients) client.terminate();
      for (const socket of accepted) socket.destroy();
      await new Promise(r => mute.close(r));
      await new Promise(r => silent.close(r));
    }
  });

  it("snapshot takes a project golden of the workspace and says how to fork it; a workspace without a project, and one that was resumed, are refused in one line", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const bare = await run("snapshot", "alpha");
    expect(bare.code).toBe(1);
    expect(bare.io.errors).toEqual(["wsp snapshot: alpha has no project loaded; import one before snapshotting it"]);

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const { code, io } = await run("snapshot", "alpha");
    expect(code).toBe(0);
    const [golden] = await rt.golden.projects();
    expect(golden).toMatchObject({ project: { name: "proj", dest: "/root/work/proj" }, golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(io.lines).toEqual([`project golden ${golden!.snapshotId}: golden v1 plus proj as imported ${golden!.project.importedAt.slice(0, 10)}, taken from alpha\nfork it with: wsp new <name> --from proj`]);
    expect(io.errors).toEqual([]);

    const asJson = await run("snapshot", alpha!.id, "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ projectGolden: expect.objectContaining({ project: golden!.project, golden: "snap_gold" }) }]);

    await rt.workspaces.nap(alpha!.id);
    await rt.workspaces.wake(alpha!.id);
    const resumed = await run("snapshot", "alpha");
    expect(resumed.code).toBe(1);
    expect(resumed.io.errors).toHaveLength(1);
    expect(resumed.io.errors[0]).toMatch(/^wsp snapshot: snapshot of alpha refused: machine m\d+ is not first-life/);
    expect(await rt.golden.projects()).toHaveLength(2);
  });

  it("new --from forks a project golden by project name (the newest) or snapshot id, and names what it cannot find", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const first = await rt.workspaces.snapshot(alpha!.id);
    await new Promise(r => setTimeout(r, 2));
    const second = await rt.workspaces.snapshot(alpha!.id);
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const byName = await run("new", "task-a", "--from", "proj");
    expect(byName.code).toBe(0);
    const taskA = (await rt.workspaces.list()).find(w => w.name === "task-a")!;
    expect(taskA).toMatchObject({ golden: second.snapshotId, project: first.project });
    expect(byName.io.lines).toEqual([`created task-a ${taskA.id}`]);

    const byId = await run("new", "task-b", "--from", first.snapshotId);
    expect(byId.code).toBe(0);
    expect((await rt.workspaces.list()).find(w => w.name === "task-b")).toMatchObject({ golden: first.snapshotId, project: first.project });

    const missing = await run("new", "task-c", "--from", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp new: no project golden named nope; wsp snapshot <workspace> takes one"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "task-a", "task-b"]);
  });

  it("import says in one plain line that it is not here yet", async () => {
    const imp = await run("import", "./proj", "--to", "alpha");
    expect(imp.code).toBe(1);
    expect(imp.io.lines).toEqual([]);
    expect(imp.io.errors).toEqual(["wsp import is not here yet: moving a project folder into a workspace lands with the project bundle."]);
  });

  it("export brings the folder home to the path given, streams the stages, prints the done line, and keys the sessions to the folder in the homes here", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const dest = join(dir, "out", "proj");
    const { code, io } = await run("export", "alpha", dest, "--from", EXPORT_SOURCE);
    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    expect(readFileSync(join(dest, "src", "index.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(readFileSync(join(dest, ".env"), "utf8")).toBe("TOKEN=x\n");
    const real = realpathSync(dest);
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    expect(readFileSync(join(dir, "user", ".claude", "projects", key, "S1.jsonl"), "utf8")).toBe(EXPORT_SESSION(real));
    expect(io.lines).toEqual([`2 files, 28 B, landed at ${dest}; 1 cache left behind; sessions: Claude Code (1 session) moved.`]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(expect.arrayContaining([`Packing ${EXPORT_SOURCE} on the machine.`, "Packing the agents' state for it on the machine.", `Landing at ${dest}.`]));
    expect(io.streamed).not.toContain("landed at");
    expect(guest.sources).toEqual([EXPORT_SOURCE]);
  });

  it("export refuses an existing folder in two lines, the second naming --replace, and replaces it when asked; --from defaults to the folder's own path; --agents narrows; --json prints the result", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const dest = join(dir, "out", "proj");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "old.txt"), "old");
    const refused = await run("export", "alpha", dest);
    expect(refused.code).toBe(1);
    expect(refused.io.lines).toEqual([]);
    expect(refused.io.errors).toEqual([`wsp export: ${dest} already exists on this computer with 1 file; export with replace to overwrite it\nRun again with --replace to overwrite it.`]);
    expect(guest.sources).toEqual([]);
    const replaced = await run("export", "alpha", dest, "--replace", "--agents", "codex,pi", "--json");
    expect(replaced.code).toBe(0);
    expect(replaced.io.errors).toEqual([]);
    expect(json(replaced.io)).toEqual([{ exported: { dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [] } }]);
    expect(replaced.io.streamed).toBe("");
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(guest.sources).toEqual([dest]);
    expect(existsSync(join(dir, "user", ".claude"))).toBe(false);
  });

  it("export refuses an --agents id the catalog does not know before anything reaches the machine, naming it and the ids it knows", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const typo = await run("export", "alpha", join(dir, "out", "proj"), "--agents", "claude,codx");
    expect(typo.code).toBe(1);
    expect(typo.io.lines).toEqual([]);
    expect(typo.io.errors).toEqual([`wsp export: no agent called codx; the catalog knows ${CATALOG_AGENTS.map(a => a.id).join(", ")}`]);
    expect(guest.sources).toEqual([]);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("every verb takes --json and --help; a bad flag prints the usage", async () => {
    for (const verb of [["new"], ["fork"], ["snapshot"], ["pause"], ["forget"], ["threads"], ["thread", "new"], ["send"], ["exec"], ["import"], ["export"]]) {
      const help = await run(...verb, "--help");
      expect(help.code).toBe(0);
      expect(help.io.lines[0]).toMatch(new RegExp(`^usage: wsp ${verb.join(" ")}`));
      expect(help.io.lines[0]).toContain("--json");
    }
    const bad = await run("threads", "--nope");
    expect(bad.code).toBe(1);
    expect(bad.io.errors[0]).toContain("usage: wsp threads");
    const half = await run("thread");
    expect(half.code).toBe(1);
    expect(half.io.errors).toEqual(['usage: wsp thread new --in <workspace> [--agent <name>] [--cwd <path>] [--notify <thread|me>] "<task>"']);
  });

  it("without a host serving the state file every verb refuses in one line before dialling anything", async () => {
    await handle!.close();
    handle = undefined;
    const { code, io } = await run("threads");
    expect(code).toBe(1);
    expect(io.errors).toEqual([`wsp threads: no wsp host is serving ${statePath}; run wsp up first`]);
  });

  it("a wrong token is refused by the host", async () => {
    writeFileSync(join(dir, "state", "host-token"), "not-the-token\n");
    const { code, io } = await run("threads");
    expect(code).toBe(1);
    expect(io.errors).toEqual(["wsp threads: unauthorized"]);
  });
});

describe("the verbs never talk to the provider", () => {
  it("import the protocol and the host's lock file only: no runtime, engine, backend or key loading", () => {
    const source = readFileSync(new URL("../src/verbs.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";$/gm)].map(m => m[1]!);
    expect(imports.filter(i => i.startsWith("@wsp/"))).toEqual(["@wsp/protocol"]);
    expect(imports).not.toContain("@wsp/runtime");
    expect(imports).not.toContain("@wsp/engine");
    expect(source).not.toMatch(/SOLARI|ANTHROPIC|loadKeys|SolariBackend|getsolari/);
  });
});
