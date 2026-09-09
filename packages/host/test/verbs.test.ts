// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENTS } from "@wsp/catalog";
import { EMPTY_TASK_LINE, EXIT_CODES, HOST_STOPPING_LINE, NO_SUCH_TURN, TURN_TOKEN_ENV, ThreadView, WorkspaceView, effortsFor, markedDefault, notifyLine, unknownAgentLine, workspaceKind, type HarnessCatalogAnswer } from "@wsp/protocol";
import { createRuntime, harnessCatalog, memoryStore, type HarnessAdapterFactory, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HELP, cli, localWiring, localWorkFolder, serve } from "../src/cli.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { PLAN_ONLY, deleteQuestion, deletedLine, dialHost, messageTo, threadRows } from "../src/verbs.js";
import { withRefused } from "../../runtime/test/fs-refusal.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { guestAnswer, stubBackend, type StubBackend } from "./stub-backend.js";
import { CUT_LINE, EXPORT_SESSION, EXPORT_SOURCE, PAGE, UNREACHED_LINE, bornDeadAgent, captured, doneOnlyAgent, execGuest, exportGuest, heldAgent, launchedScript, launchedScripts, projectBundler, scriptedAgent, stuckAgent, toolingAgent, type Captured } from "./verbs-fixture.js";

// A path the process may not read is refused here and not by chmod: these tests run as root, which reads anything.
vi.mock("node:fs", async importOriginal => (await import("../../runtime/test/fs-refusal.js")).refusingFs(await importOriginal<typeof import("node:fs")>()));

/** What the codex here asks its machine; the stub guest answers nothing to it unless a test puts a catalog there. */
const PROBE_CMD = "codex --describe";

/** An agent whose binary can be made to answer: its probe reads the machine's stdout as the answer itself, so a test
 * can put a machine's own catalog in front of the verbs. Nothing on the guest answers by default, which leaves the
 * runtime's table standing, exactly as an adapter with no probe at all does. */
const probing =
  (factory: HarnessAdapterFactory): HarnessAdapterFactory =>
  ctx => ({ ...factory(ctx), probeCatalog: exec => exec(PROBE_CMD).then(out => (out.trim() === "" ? null : (JSON.parse(out) as HarnessCatalogAnswer))) });

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
    asked.length = 0;
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
    rt = createRuntime({ backend, store, adapters: { claude: claude.adapter, codex: probing(codex.adapter) }, local: localWiring(join(dir, "user")) });
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

  /** A verb still in flight: its io is readable while it runs, so a test can wait on a line it has already printed.
   * --state goes before any `--`, where exec's command begins. */
  function starting(...argv: string[]): { io: Captured; ended: Promise<number> } {
    const io = captured();
    const cut = argv.indexOf("--");
    const at = cut === -1 ? argv.length : cut;
    return { io, ended: cli([...argv.slice(0, at), "--state", statePath, ...argv.slice(at)], io) };
  }
  async function run(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const { io, ended } = starting(...argv);
    return { code: await ended, io };
  }
  const json = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  /** A verb run with a person at the keyboard: every question it asks is recorded and answered with reply. */
  const asked: string[] = [];
  async function answer(reply: string, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    io.isTTY = true;
    io.ask = async q => {
      asked.push(q);
      return reply;
    };
    return { code: await cli([...argv, "--state", statePath], io), io };
  }
  const head = (m: typeof SEALED_GOLDEN) => m.versions.find(v => v.version === m.head)!;

  /** The host again on the same state file, over a runtime with these adapters; the verbs still see no key. */
  async function restartHost(adapters: Parameters<typeof createRuntime>[0]["adapters"], over: Store = store): Promise<void> {
    await handle?.close();
    handle = undefined;
    rt = createRuntime({ backend, store: over, adapters, local: localWiring(join(dir, "user")) });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir: join(dir, "web"), runtime: rt });
    vi.stubEnv("SOLARI_API_KEY", "");
  }

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

  it("new and fork take --size as <cpu>x<memGb>, which reaches the create's size; a size the provider does not offer, or no size at all, is refused in one line naming the list, and nothing is minted", async () => {
    const big = await run("new", "big", "--size", "2x8");
    expect(big.code).toBe(0);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 8192 });
    const [status] = await rt.status.list();
    expect(status).toMatchObject({ name: "big", size: { cpu: 2, memMb: 8192 } });

    const forked = await run("fork", "big", "--name", "wide", "--size", "4x8");
    expect(forked.code).toBe(0);
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 4, memMb: 8192 });
    expect((await rt.status.list()).find(w => w.name === "wide")!.size).toEqual({ cpu: 4, memMb: 8192 });

    const list = "the sizes are 2x4 ($0.11/hr), 2x8 ($0.15/hr), 4x8 ($0.22/hr)";
    const odd = await run("new", "odd", "--size", "8x16");
    expect(odd.code).toBe(3);
    expect(odd.io.errors).toEqual([`wsp new: 8x16 is not a size this provider offers; ${list}`]);
    const word = await run("fork", "big", "--size", "large");
    expect(word.code).toBe(3);
    expect(word.io.errors).toEqual([`wsp fork: large is not a size this provider offers; ${list}`]);
    expect(backend.machines).toHaveLength(2);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["big", "wide"]);

    // Without --size the golden's own size stands.
    await run("new", "plain");
    expect(backend.machines.at(-1)!.spec).toMatchObject({ cpu: 2, memMb: 4096 });
  });

  it("a fork the provider refuses at the machine cap is one line naming the workspaces holding the slots, never the provider's sentence", async () => {
    await run("new", "first");
    await run("new", "t-cap");
    const create = backend.create.bind(backend);
    backend.create = async spec => {
      if (spec.fromSnapshot !== undefined) throw Object.assign(new Error("Too many concurrent sessions"), { kind: "concurrency", status: 429 });
      return create(spec);
    };
    const refused = await run("fork", "first", "--name", "f2");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual(["wsp fork: both machine slots are in use: first, t-cap. Pause one or wait for a nap."]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["first", "t-cap"]);
  });

  it("new --local with no host serving writes the local workspace into the state file, the way in for an empty state", async () => {
    await handle?.close();
    handle = undefined;
    rmSync(lockPathFor(statePath), { force: true });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    const { code, io } = await run("new", "--local", "mac");
    expect(code).toBe(0);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^created mac ws_[0-9a-f]{8} \(this computer\)$/);
    const written = JSON.parse(readFileSync(statePath, "utf8")) as { workspaces: Record<string, { name: string; kind: string; machineId: string }> };
    expect(Object.values(written.workspaces).map(w => [w.name, w.kind, w.machineId])).toEqual([["mac", "local", "local"]]);
  });

  it("workspaces lists this computer beside a fork, its machine cell the kind's own words and its state cell empty, and thread new --in takes it by name like any workspace", async () => {
    await run("new", "alpha");
    await run("new", "--local", "mac");
    const listed = await run("workspaces");
    expect(listed.code).toBe(0);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["WORKSPACE", "ID", "MACHINE", "STATE", "PROJECT"]);
    // The fork names its machine and its state; this computer names neither, so both cells fall off the end of the row.
    expect(rows.map(r => r.split(/ {2,}/))).toEqual([
      ["alpha", expect.stringMatching(/^ws_/), expect.stringMatching(/^m\d+$/), "Running"],
      ["mac", expect.stringMatching(/^ws_/), "this computer"],
    ]);
    expect(listed.io.errors).toEqual([]);

    const raw = await run("workspaces", "--json");
    const rawRows = (json(raw.io)[0] as { workspaces: WorkspaceView[] }).workspaces;
    expect(rawRows.map(w => [w.name, workspaceKind(w), w.golden])).toEqual([
      ["alpha", "cloud", head(SEALED_GOLDEN).snapshotId],
      ["mac", "local", ""],
    ]);

    const opened = await run("thread", "new", "--in", "mac", "say pong");
    expect(opened.code).toBe(0);
    expect(opened.io.errors).toEqual([]);
    const threads = await threadRows(await dialHost(statePath));
    expect(threads.map(t => [t.workspaceName, t.harness, t.startedBy])).toEqual([["mac", "claude", "cli"]]);
    expect(opened.io.lines).toEqual([expect.stringMatching(/^thread /), "re: say pong"]);
  });

  it("the STATE cell reads the machine and the daemon beside the phase: a machine the provider paused says Paused and one whose daemon has gone dark says Unreachable, both while the record still reads running", async () => {
    await run("new", "napped");
    await run("new", "dark");
    // Every cloud machine has an edge route, and a prompt 502 on it is the edge dialling the guest and finding
    // nothing on the daemon's port.
    const edge = createHttpServer((_req, res) => {
      res.writeHead(502).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      const route = async (): Promise<{ url: string; token: string; expiresAt: number }> => ({ url: `http://127.0.0.1:${port}/`, token: "stub", expiresAt: Date.now() + 3_600_000 });
      const [napped, dark] = backend.machines;
      napped!.previewUrl = route;
      dark!.previewUrl = route;
      // A pause the provider made, not one wsp asked for: nothing wrote the record, so its phase still reads running.
      napped!.paused = true;

      const listed = await run("workspaces");
      expect(listed.code).toBe(0);
      expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([
        ["napped", "running"],
        ["dark", "running"],
      ]);
      const [, ...rows] = listed.io.lines[0]!.split("\n");
      expect(rows.map(r => r.split(/ {2,}/).slice(0, 2).concat(r.split(/ {2,}/)[3]!))).toEqual([
        ["napped", expect.stringMatching(/^ws_/), "Paused"],
        ["dark", expect.stringMatching(/^ws_/), "Unreachable"],
      ]);

      // The same two words reach an agent reading the table over the tool, off the machine state and reach the row read.
      const raw = await run("workspaces", "--json");
      const statuses = (json(raw.io)[0] as { workspaces: { name: string; machineState: string; reach: { state: string } }[] }).workspaces;
      expect(statuses.map(w => [w.name, w.machineState, w.reach.state])).toEqual([
        ["napped", "paused", "no-daemon"],
        ["dark", "running", "no-daemon"],
      ]);
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("neither door hands over the route the reach carries: the table and the tool answer the state alone, with no url and no provider token", async () => {
    await run("new", "alpha");
    const edge = createHttpServer((_req, res) => {
      res.writeHead(426).end();
    });
    await new Promise<void>(r => edge.listen(0, "127.0.0.1", r));
    try {
      const port = (edge.address() as AddressInfo).port;
      // What the provider mints: the route with its own bearer in the query and an hour on it.
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${port}/?pt_token=stub-bearer`, token: "stub-bearer", expiresAt: Date.now() + 3_600_000 });

      const raw = await run("workspaces", "--json");
      expect(raw.code).toBe(0);
      const [line] = raw.io.lines;
      expect(line).not.toContain("pt_token");
      expect(line).not.toContain("stub-bearer");
      const rows = (JSON.parse(line!) as { workspaces: { name: string; machineState: string; reach: Record<string, unknown> }[] }).workspaces;
      // The state the row turns on is there; the route it was read over is not.
      expect(rows.map(w => [w.name, w.machineState, w.reach])).toEqual([["alpha", "running", { state: "reachable" }]]);

      const listed = await run("workspaces");
      expect(listed.io.lines[0]).not.toContain("pt_token");
      expect(listed.io.lines[0]!.split("\n")[1]!.split(/ {2,}/)[3]).toBe("Running");
    } finally {
      await new Promise<void>(r => edge.close(() => r()));
    }
  });

  it("new refuses in one line when there is no golden", async () => {
    await restartHost({}, memoryStore());
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
    expect(sent.io.streamed.endsWith("Ready.\nre: \n$ ls\nbuild it\ncompleted\n")).toBe(true);
  });

  it("thread new --title names the thread from the first second, in the agent's own launch and in the table", async () => {
    await run("new", "alpha");
    const opened = await run("thread", "new", "--in", "alpha", "--title", "Ticket 411 review", "build it");
    expect(opened.code).toBe(0);
    expect(claude.starts.at(-1)?.title).toBe("Ticket 411 review");
    const [row] = await rt.sessions.list();
    expect(row).toMatchObject({ harnessTitle: "Ticket 411 review", titleSource: "person" });
    const listed = await run("threads");
    expect(listed.io.lines.join("\n")).toContain("Ticket 411 review");
  });

  it("fork, thread new, exec and wake refuse a workspace whose machine is gone, quoting the provider, with no waking line", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await handle!.close();
    handle = undefined;
    backend.machines[0]!.killed = true; // deleted at the provider while no host ran
    await restartHost({ claude: claude.adapter });
    const words = (await rt.workspaces.get(alpha!.id)).gone!;
    expect(words).toMatch(new RegExp(`^machine ${alpha!.machineId} is gone at the provider: the record load found it gone at \\S+Z \\(404 gone\\)$`));
    const forked = await run("fork", "alpha");
    expect(forked.code).toBe(1);
    expect(forked.io.errors).toEqual([`wsp fork: Workspace machine is gone; rebuild it to fork (${words})`]);
    const opened = await run("thread", "new", "--in", "alpha", "do it");
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual([`wsp thread new: Workspace machine is gone; rebuild it to send (${words})`]);
    const ran = await run("exec", "alpha", "--", "echo", "hi");
    expect(ran.code).toBe(1);
    expect(ran.io.errors).toEqual([`wsp exec: Workspace machine is gone; rebuild it to exec (${words})`]);
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(1);
    expect(woken.io.errors).toEqual([`wsp wake: Workspace machine is gone; rebuild it to wake (${words})`]);
    expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "gone"]]);
  });

  it("rebuild is the road out of gone: a new machine under the same workspace, its id and state printed; a machine that answers is refused in the row's own words", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    const refused = await run("rebuild", "alpha");
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual(["wsp rebuild: Rebuild replaces a gone or zombie machine; this one answers"]);
    expect(backend.machines).toHaveLength(1);

    await handle!.close();
    handle = undefined;
    backend.machines[0]!.killed = true; // deleted at the provider while no host ran
    await restartHost({ claude: claude.adapter });
    expect((await rt.workspaces.get(alpha!.id)).phase).toBe("gone");

    const built = await run("rebuild", "alpha");
    expect(built.code).toBe(0);
    expect(built.io.errors).toEqual([]);
    const after = await rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: alpha!.golden });
    expect(after.machineId).not.toBe(alpha!.machineId);
    expect(built.io.lines).toEqual([`alpha running on ${after.machineId}`]);
    // The verb every other one sends a gone workspace to now answers on it.
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);

    const asJson = await run("rebuild", "alpha", "--json");
    expect(asJson.code).toBe(1);
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: "Rebuild replaces a gone or zombie machine; this one answers", class: "provider", exit: EXIT_CODES.provider }]);
    const missing = await run("rebuild", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp rebuild: no workspace nope"]);
    const extra = await run("rebuild", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors).toEqual(["wsp rebuild: wsp rebuild takes one workspace"]);
  });

  it("fork's help says it makes a new machine from the source's golden version, in wsp --help and wsp fork --help", async () => {
    const line = "a new machine from the source's golden version";
    expect(HELP).toContain(line);
    const { code, io } = await run("fork", "--help");
    expect(code).toBe(0);
    expect(io.lines[0]).toContain(line);
  });

  it("wsp --help names the six screens of wsp init in order, as the wizard draws them", () => {
    expect(HELP).not.toContain("three screens");
    const init = HELP.slice(HELP.indexOf("  wsp init "), HELP.indexOf("  wsp doctor ")).replace(/\s+/g, " ");
    expect(init).toContain("six screens: Agents, Tools, Also on this Mac, Sign-ins, wsp for your agents on this Mac, and Build");
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

  it("wake wakes a paused workspace, one line on stderr while it does, and prints its state after; on a running one the runtime is asked and the state printed is the one read", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.errors).toEqual(["waking alpha"]);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    expect(backend.machines[0]!.paused).toBe(false);
    const again = await run("wake", "alpha", "--json");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
    expect(json(again.io)).toEqual([{ workspace: expect.objectContaining({ name: "alpha", phase: "running" }) }]);
    const plain = await run("wake", "alpha");
    expect(plain.io.lines).toEqual(["alpha running"]);
    const missing = await run("wake", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp wake: no workspace nope"]);
  });

  it("a machine the provider paused on its own, under a record that says running, is woken by wake and by exec: the runtime's one state read settles it", async () => {
    await run("new", "alpha");
    backend.machines[0]!.paused = true;
    execGuest(backend, "awake-ok\n", 0);
    const ran = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    expect(backend.machines[0]!.paused).toBe(false);
    backend.machines[0]!.paused = true;
    const woken = await run("wake", "alpha");
    expect(woken.code).toBe(0);
    expect(woken.io.lines).toEqual(["alpha running"]);
    expect(woken.io.errors).toEqual([]);
    expect(backend.machines[0]!.paused).toBe(false);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("exec on a paused workspace wakes it first, says so on stderr, then runs the command; a running one is not woken", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    execGuest(backend, "awake-ok\n", 0);
    const { code, io } = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(code).toBe(0);
    expect(io.errors).toEqual(["waking alpha"]);
    expect(io.lines).toEqual(["awake-ok"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
    const again = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(again.code).toBe(0);
    expect(again.io.errors).toEqual([]);
  });

  it("a record that says paused while the provider runs the machine: exec goes on without a resume and the store ends running; pause pauses for real", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const m = backend.machines[0]!;
    // The nap never took at the provider, and a resume on a running machine is refused.
    const runningAtProvider = (): void => {
      m.paused = false;
      m.resume = async () => {
        throw Object.assign(new Error("Sandbox is not paused"), { kind: "conflict", status: 409 });
      };
    };
    runningAtProvider();
    execGuest(backend, "awake-ok\n", 0);
    const ran = await run("exec", "alpha", "--", "echo", "awake-ok");
    expect(ran.code).toBe(0);
    expect(ran.io.lines).toEqual(["awake-ok"]);
    const [alpha] = await rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(await store.get("workspaces", alpha!.id)).toMatchObject({ phase: "running" });

    await run("pause", "alpha");
    expect(m.paused).toBe(true);
    runningAtProvider();
    const paused = await run("pause", "alpha");
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual(["alpha paused"]);
    expect(m.paused).toBe(true);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
  });

  it("thread new and send on a paused workspace wake it first, one line on stderr, then run the turn", async () => {
    await run("new", "alpha");
    await run("pause", "alpha");
    const opened = await run("thread", "new", "--in", "alpha", "hello");
    expect(opened.code).toBe(0);
    expect(opened.io.errors).toEqual(["waking alpha"]);
    expect(opened.io.lines[1]).toBe("re: hello");
    const [row] = await rt.sessions.list();
    await run("pause", "alpha");
    const sent = await run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual(["waking alpha"]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect((await rt.workspaces.list())[0]!.phase).toBe("running");
  });

  it("rename names the workspace and prints both names; a name another workspace holds and a blank one are refused and nothing is renamed", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const alpha = (await rt.workspaces.list()).find(w => w.name === "alpha")!;

    const named = await run("rename", "alpha", "the name he typed");
    expect(named.code).toBe(0);
    expect(named.io.lines).toEqual([`alpha is now the name he typed ${alpha.id}`]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);
    // The name is how a workspace is addressed, so every later verb takes the one it now carries.
    expect((await run("pause", "the name he typed")).io.lines).toEqual(["the name he typed paused"]);

    const taken = await run("rename", "beta", "the name he typed");
    expect(taken.code).toBe(1);
    expect(taken.io.errors).toEqual(["wsp rename: the name he typed is already a workspace; pick another name, or delete it first"]);
    const blank = await run("rename", "beta", "  ");
    expect(blank.code).toBe(1);
    expect(blank.io.errors).toEqual(["wsp rename: a workspace name cannot be blank"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["beta", "the name he typed"]);

    const asJson = await run("rename", "beta", "gamma", "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toMatchObject([{ was: "beta", workspace: { name: "gamma" } }]);

    const missing = await run("rename", "nope", "a");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp rename: no workspace nope"]);
    const short = await run("rename", "gamma");
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp rename: wsp rename takes a workspace and one name"]);
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
    expect(json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", threads: 0 }]);
    expect(await rt.workspaces.list()).toEqual([]);

    const missing = await run("forget", "nope", "--yes");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp forget: no workspace nope"]);
  });

  it("a machine wsp did not fork is left as it is: the delete question and its line say so", () => {
    const workspace = { id: "ws_mine", name: "box", machineId: "ssh://dev@box:22", phase: "running", kind: "ssh", golden: "", createdAt: "2026-09-08T00:00:00.000Z" } as const;
    expect(deleteQuestion({ workspace, threads: 1 })).toBe("Delete box?\nIts machine is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace, threads: 1 })).toBe("deleted box ws_mine: its machine is left as it is, and its record and 1 thread are gone from this computer");
    // A fork is wsp's to take away, and its line still names the machine that goes.
    const fork = { ...workspace, kind: "cloud", machineId: "m_ab12" } as const;
    expect(deletedLine({ workspace: fork, threads: 0 })).toBe("deleted box ws_mine: machine m_ab12 is gone at the provider, and its record and 0 threads are gone from this computer");
  });

  it("delete asks once in the words the app shows, kills the machine at the provider, and drops the record and its threads", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    await run("thread", "new", "--in", "alpha", "build it");
    const alpha = (await rt.workspaces.list()).find(w => w.name === "alpha")!;

    const kept = await answer("no", "delete", "alpha");
    expect(kept.code).toBe(1);
    expect(kept.io.errors).toEqual(["alpha kept"]);
    expect(asked).toEqual([`Delete alpha?\nIts machine is deleted at the provider; its record and 1 thread leave this computer.`]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "beta"]);
    expect(backend.machines[0]!.killed).toBe(false);

    const deleted = await answer("yes", "delete", alpha.id);
    expect(deleted.code).toBe(0);
    expect(deleted.io.errors).toEqual([]);
    expect(deleted.io.lines).toEqual([
      `deleted alpha ${alpha.id}: machine ${alpha.machineId} is gone at the provider, and its record and 1 thread are gone from this computer`,
    ]);
    expect(backend.machines[0]!.killed).toBe(true);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["beta"]);
    expect(await rt.sessions.list(alpha.id)).toEqual([]);
    expect(await store.get("workspaces", alpha.id)).toBeUndefined();

    const beta = (await rt.workspaces.list())[0]!;
    const asJson = await run("delete", "beta", "--yes", "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ workspaceId: beta.id, name: "beta", machineId: beta.machineId, threads: 0 }]);
    expect(backend.machines[1]!.killed).toBe(true);
    expect(await rt.workspaces.list()).toEqual([]);

    const missing = await run("delete", "nope", "--yes");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp delete: no workspace nope"]);
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
    expect(io.streamed).toBe("code\n$ ls\nx: write tests\ncompleted\n");
    expect(io.errors).toEqual([]);
  });

  it("a turn's tool calls stream one muted line each as they land, what each answered behind it, and its end reads as the app's status line", async () => {
    await restartHost({
      claude: toolingAgent(
        [
          { toolName: "Bash", input: { command: "git status\n--porcelain" }, output: "On branch main\nnothing to commit" },
          { toolName: "Read", input: { file_path: "packages/engine/src/golden-mcp.ts" }, output: "" },
          { toolName: "Grep", input: { pattern: "shellQuote" }, output: "packages/host/src/exec.ts:12:  shellQuote(argv)" },
          { toolName: "Wombat", input: { fur: "grey" }, output: "no tool by that name", failed: true },
        ],
        { status: "completed", text: "had a look", durationMs: 72_000, costUsd: 0.22 },
      ),
    });
    await run("new", "alpha");
    const io = captured();
    io.muted = text => `~${text}~`;
    expect(await cli(["thread", "new", "--in", "alpha", "look around", "--state", statePath], io)).toBe(0);
    expect(io.streamed.split("\n")).toEqual([
      "~$ git status~",
      "~On branch main~",
      "~read packages/engine/src/golden-mcp.ts~",
      "~searched code for shellQuote~",
      "~packages/host/src/exec.ts:12: shellQuote(argv)~",
      "~Wombat~",
      "~failed: no tool by that name~",
      "~completed · Worked for 1m 12s · $0.22~",
      "",
    ]);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /), "had a look"]);
    expect(io.errors).toEqual([]);

    // --json keeps stdout the raw deltas and writes no line of its own.
    const asJson = await run("thread", "new", "--in", "alpha", "again", "--json");
    expect(asJson.io.streamed).toBe("");
    const calls = (json(asJson.io) as { type?: string; kind?: string; toolName?: string }[]).filter(e => e.type === "session.delta");
    expect(calls.map(e => [e.kind, e.toolName])).toEqual([
      ["tool_use", "Bash"], ["tool_result", undefined],
      ["tool_use", "Read"], ["tool_result", undefined],
      ["tool_use", "Grep"], ["tool_result", undefined],
      ["tool_use", "Wombat"], ["tool_result", undefined],
    ]);
  });

  it("thread new without an agent takes the runtime's default; an agent the host has no adapter for is refused naming the agents it has, before a napping machine is woken", async () => {
    await run("new", "alpha");
    const ok = await run("thread", "new", "--in", "alpha", "hello");
    expect(ok.code).toBe(0);
    expect((await rt.sessions.list())[0]).toMatchObject({ harness: "claude", startedBy: "cli" });
    await run("pause", "alpha");
    const refused = await run("thread", "new", "--in", "alpha", "--agent", "gemini", "hello");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp thread new: no adapter registered for harness "gemini"; agents on this host: claude, codex']);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("fork --send under an agent the host has no adapter for is refused naming the agents it has, and no machine is minted", async () => {
    await run("new", "alpha");
    const refused = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--agent", "gemini");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp fork: no adapter registered for harness "gemini"; agents on this host: claude, codex']);
    expect(refused.io.lines).toEqual([]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(await rt.sessions.list()).toEqual([]);
  });

  it("an empty or whitespace task or message is refused in words by thread new, fork --send and send; no machine is minted or woken and nothing starts", async () => {
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "first");
    const [row] = await rt.sessions.list();
    await run("pause", "alpha");
    for (const task of ["", "  \n\t"]) {
      const opened = await run("thread", "new", "--in", "alpha", task);
      expect(opened.code).toBe(3);
      expect(opened.io.errors).toEqual([`wsp thread new: ${EMPTY_TASK_LINE}`]);
      const forked = await run("fork", "alpha", "--name", "worker", "--send", task);
      expect(forked.code).toBe(3);
      expect(forked.io.errors).toEqual([`wsp fork: ${EMPTY_TASK_LINE}`]);
      const sent = await run("send", row!.threadId!, task);
      expect(sent.code).toBe(3);
      expect(sent.io.errors).toEqual([`wsp send: ${EMPTY_TASK_LINE}`]);
    }
    expect((await rt.workspaces.list()).map(w => [w.name, w.phase])).toEqual([["alpha", "napping"]]);
    expect(claude.starts).toHaveLength(1);
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("a failed turn exits 1 with the error on stderr and no last message", async () => {
    await run("new", "alpha");
    const { code, io } = await run("thread", "new", "--in", "alpha", "die");
    expect(code).toBe(1);
    expect(io.lines).toHaveLength(1);
    expect(io.lines[0]).toMatch(/^thread /);
    expect(io.errors).toEqual(["wsp thread new: the harness died"]);
  });

  it("a send into a thread whose last turn was cut says so on stderr before the reply; the send after that says nothing", async () => {
    await run("new", "alpha");
    const cut = await run("thread", "new", "--in", "alpha", "cut");
    expect(cut.code).toBe(1);
    expect(cut.io.errors).toEqual([`wsp thread new: ${CUT_LINE}`]);
    const [row] = await rt.sessions.list();
    const resumed = await run("send", row!.threadId!, "again");
    expect(resumed.code).toBe(0);
    expect(resumed.io.errors).toEqual(["previous turn was cut; resuming"]);
    expect(resumed.io.lines).toEqual(["re: again"]);
    const next = await run("send", row!.threadId!, "once more");
    expect(next.code).toBe(0);
    expect(next.io.errors).toEqual([]);
    const asJson = await run("send", row!.threadId!, "and json", "--json");
    expect(json(asJson.io).filter(e => (e as { type: string }).type === "session.start")).toEqual([expect.not.objectContaining({ afterCut: true })]);
  });

  it("a send into a thread whose launch never reached the machine runs the message as that thread's first turn, on the same thread, instead of refusing", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter, codex: codex.adapter });
    await run("new", "alpha");
    const dead = await run("thread", "new", "--in", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp thread new: ${UNREACHED_LINE}`]);
    const [row] = await rt.sessions.list();
    expect(row!.claudeSessionId).toBeUndefined();
    const sent = await run("send", row!.threadId!, "again");
    expect(sent.code).toBe(0);
    expect(sent.io.errors).toEqual([]);
    expect(sent.io.lines).toEqual(["re: again"]);
    expect(agent.starts.map(s => s.resume)).toEqual([undefined, undefined]);
    const rows = await rt.sessions.list();
    expect(rows.map(r => [r.prompt, r.status, r.threadId])).toEqual([
      ["hello", "failed", row!.threadId],
      ["again", "completed", row!.threadId],
    ]);
    const more = await run("send", row!.threadId!, "once more");
    expect(more.io.lines).toEqual(["re: once more"]);
    expect(agent.starts[2]!.resume).toBe(rows[1]!.claudeSessionId);
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
    const [{ threads }] = json(scoped.io) as [{ threads: (ThreadView & { workspaceName: string })[] }];
    // The rows the tool answers with: the sidebar's view plus the workspace's name, as the table shows it.
    expect(threads.map(({ workspaceName: _name, ...t }) => ThreadView.parse(t))).toEqual(threads.map(({ workspaceName: _name, ...t }) => t));
    expect(threads).toEqual([expect.objectContaining({ id: b!.threadId, workspaceId: beta!.id, workspaceName: "beta", harness: "codex", startedBy: "person", turns: 1 })]);
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

  it("--model, --effort and --access on thread new, fork --send and send reach the start as the fields the composer sends; a new thread without them runs the catalog's defaults, the ones the composer shows", async () => {
    await run("new", "alpha");
    const picked = await run("thread", "new", "--in", "alpha", "--model", "claude-sonnet-5", "--effort", "low", "--access", "plan", "review it");
    expect(picked.code).toBe(0);
    expect(claude.starts.map(s => [s.model, s.effort, s.permissionMode])).toEqual([["claude-sonnet-5", "low", "plan"]]);

    const bare = await run("thread", "new", "--in", "alpha", "hello");
    expect(bare.code).toBe(0);
    const shown = markedDefault(harnessCatalog("claude")!.models)!.value;
    expect(shown).toBe("claude-opus-5");
    const level = markedDefault(effortsFor(harnessCatalog("claude")!, markedDefault(harnessCatalog("claude")!.models) ?? null))!.value;
    expect(claude.starts.at(-1)).toMatchObject({ model: shown, effort: level });
    // The access is named too, and named explicitly: an unnamed one reached the adapter as nothing, which every
    // adapter here reads as its own skip-everything flag, so the picker's word and the CLI's flag could differ.
    const access = markedDefault(harnessCatalog("claude")!.permissionModes)!.value;
    expect(access).toBe("bypassPermissions");
    expect(claude.starts.at(-1)!.permissionMode).toBe(access);
    const [, thread] = await rt.sessions.list();

    const same = await run("send", thread!.threadId!, "go on");
    expect(same.code).toBe(0);
    // A send that names nothing keeps the thread's own access rather than dropping back to the adapter's default.
    expect(claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, permissionMode: access });
    expect(claude.starts.at(-1)!.model).toBeUndefined();
    const changed = await run("send", thread!.threadId!, "--model", "claude-fable-5-1", "--effort", "max", "--access", "acceptEdits", "now think");
    expect(changed.code).toBe(0);
    expect(claude.starts.at(-1)).toMatchObject({ resume: thread!.claudeSessionId, model: "claude-fable-5-1", effort: "max", permissionMode: "acceptEdits" });

    const forked = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--model", "claude-sonnet-5", "--access", "bypassPermissions");
    expect(forked.code).toBe(0);
    expect(claude.starts.at(-1)).toMatchObject({ model: "claude-sonnet-5", permissionMode: "bypassPermissions", effort: level });
  });

  it("a model, effort or access mode the agent's catalog does not list is refused with that list, in the composer's words, and nothing starts", async () => {
    await run("new", "alpha");
    const model = await run("thread", "new", "--in", "alpha", "--model", "claude-haiku-4-5", "review it");
    expect(model.code).toBe(3);
    expect(model.io.errors).toEqual(['wsp thread new: model "claude-haiku-4-5" is not one claude takes; one of: Fable 5.1 (claude-fable-5-1), Opus 5 (claude-opus-5), Sonnet 5 (claude-sonnet-5)']);
    const effort = await run("thread", "new", "--in", "alpha", "--effort", "ultra", "review it");
    expect(effort.code).toBe(3);
    expect(effort.io.errors).toEqual(['wsp thread new: effort "ultra" is not one claude takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max)']);
    const access = await run("fork", "alpha", "--send", "build it", "--access", "yolo");
    expect(access.code).toBe(3);
    expect(access.io.errors[0]).toMatch(/^wsp fork: access mode "yolo" is not one claude takes; one of: Default \(default\), Accept edits \(acceptEdits\), /);
    // Checked against the table before the fork is minted, for the named agent or the default one.
    const other = await run("fork", "alpha", "--send", "build it", "--agent", "codex", "--effort", "minimal");
    expect(other.code).toBe(3);
    expect(other.io.errors).toEqual([
      'wsp fork: effort "minimal" is not one GPT-5.6-Sol takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max), Ultra (ultra)',
    ]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(claude.starts).toEqual([]);
    expect(codex.starts).toEqual([]);
    expect(await rt.sessions.list()).toEqual([]);
    const dangling = await run("fork", "alpha", "--model", "claude-sonnet-5");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(["wsp fork: --model needs --send"]);
  });

  it("checks a pick against the workspace's own machine, so a model only that machine knows is taken here as the app takes it", async () => {
    await run("new", "alpha");
    // A machine routed to another model provider: its codex names a model no table carries, and the app's composer
    // takes it because sessions.start checks the probed catalog. The command line has to agree with the app.
    const routed = {
      version: "0.153.0",
      models: [{ slug: "anthropic/claude-sonnet-4.5", label: "anthropic/claude-sonnet-4.5", contextWindows: [], isDefault: true }],
      efforts: ["low", "high"],
      permissionModes: ["read-only"],
    };
    backend.execImpl = (_m, cmd) => (cmd === PROBE_CMD ? { exitCode: 0, stdout: JSON.stringify(routed), stderr: "" } : guestAnswer(cmd));
    const opened = await run("thread", "new", "--in", "alpha", "--agent", "codex", "--model", "anthropic/claude-sonnet-4.5", "--effort", "high", "go");
    expect(opened.code).toBe(0);
    expect(codex.starts.at(-1)).toMatchObject({ model: "anthropic/claude-sonnet-4.5", effort: "high" });
    // The same list refuses a table model that machine does not have, naming the machine's own, and a fork checks
    // the workspace it forks from, whose golden the new machine comes from.
    const forked = await run("fork", "alpha", "--send", "go", "--agent", "codex", "--model", "gpt-5.5");
    expect(forked.code).toBe(3);
    expect(forked.io.errors).toEqual(['wsp fork: model "gpt-5.5" is not one codex takes; one of: anthropic/claude-sonnet-4.5 (anthropic/claude-sonnet-4.5)']);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
  });

  it("a --cwd that is not absolute is refused with the usage line before anything is created, started or dialled; fork's --cwd needs --send", async () => {
    await run("new", "alpha");
    const relative = await run("thread", "new", "--in", "alpha", "--cwd", "packages/host", "look here");
    expect(relative.code).toBe(3);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute: got "packages/host"\n\nusage: wsp thread new --in <workspace> [--agent, --model, --effort, --access, --cwd, --notify, --title, --image <path>, --detach] "<task>"']);
    const forked = await run("fork", "alpha", "--send", "build it", "--cwd", "packages/host");
    expect(forked.code).toBe(3);
    expect(forked.io.errors[0]).toMatch(/^--cwd is a path on the machine, absolute: got "packages\/host"\n\nusage: wsp fork /);
    const dangling = await run("fork", "alpha", "--cwd", "/root/work");
    expect(dangling.code).toBe(3);
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

  it("threads shows a multi-paragraph brief as one row, titled by the protocol's rule: its first sentence cut at a word to 48 characters, the same title the sidebar shows", async () => {
    await run("new", "alpha");
    const brief = "You are a builder for the wsp repo, which is at /Users/zingzy/wsp on this machine.\n\nTicket: Zingzy/wsp-map#292.\nBuild: the fix.";
    await run("thread", "new", "--in", "alpha", brief);
    const { io } = await run("threads");
    const rows = io.lines[0]!.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/  You are a builder for the wsp repo, which is at…\s*$/);
    const asJson = await run("threads", "--json");
    const [{ threads }] = json(asJson.io) as [{ threads: ThreadView[] }];
    expect(threads[0]!.title).toBe("You are a builder for the wsp repo, which is at…");
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
    expect(io.streamed).toBe("code\n$ ls\nx: second\ncompleted\n");
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
      [byCli!.threadId, "codex", "cli", "first", 1],
      [byPerson!.threadId, "claude", "person", "from the app", 1],
    ]);

    const prefixed = await run("send", byCli!.threadId!.slice(0, 8), "third");
    expect(prefixed.code).toBe(0);
    const missing = await run("send", "nope", "x");
    expect(missing.io.errors).toEqual(["wsp send: no thread nope"]);
  });

  it("send into a thread whose turn runs joins that turn when the agent steers: one stderr line, the running turn's reply, one session.start and one session.steer", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const first = run("thread", "new", "--in", "alpha", "loop for a minute, then say done");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const sent = run("send", row!.threadId!, "--model", "claude-sonnet-5", "--effort", "low", "end your last line with STEERED");
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
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}`, "done STEERED"]);
    const [alpha] = await rt.workspaces.list();
    const history = await rt.sessions.history(alpha!.id);
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.delta", "session.done", "session.end"]);
    expect(history[1]).toMatchObject({ type: "session.steer", prompt: "end your last line with STEERED", requestId: expect.any(String) });
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("send into a thread whose turn runs on an agent that cannot steer waits for that turn, then starts its own: one stderr line, the second start after the first done", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
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

  it("stop ends the thread's running turn through the runtime and says so; a thread whose turn is over says not running; the machine stays up", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const first = run("thread", "new", "--in", "alpha", "loop forever");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [row] = await rt.sessions.list();
    const stopped = await run("stop", row!.threadId!.slice(0, 8));
    expect(stopped.code).toBe(0);
    expect(stopped.io.lines).toEqual([`thread ${row!.threadId} stopped`]);
    expect(held.interrupted).toEqual([row!.id]);
    const opened = await first;
    expect(opened.code).toBe(1);
    expect(opened.io.errors).toEqual(["wsp thread new: turn interrupted"]);
    expect((await rt.sessions.list())[0]).toMatchObject({ id: row!.id, status: "interrupted" });
    const [alpha] = await rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
    expect(backend.machines[0]).toMatchObject({ paused: false, killed: false });

    const idle = await run("stop", row!.threadId!, "--json");
    expect(idle.code).toBe(0);
    expect(json(idle.io)).toEqual([{ threadId: row!.threadId, outcome: "not-running" }]);
    expect(held.interrupted).toHaveLength(1);
    const missing = await run("stop", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp stop: no thread nope"]);
  });

  it("thread rename names the thread in the agent's own store and says so; an agent that keeps no name, one whose store has no such session, and an unknown thread each say why", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, title => (title === "nowhere" ? { kind: "no-session" } : title === "locked" ? { kind: "failed", error: "database is locked" } : { kind: "written" }));
    await restartHost({ claude: named.adapter, codex: codex.adapter });
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "build it");
    const [row] = await rt.sessions.list();

    const renamed = await run("thread", "rename", row!.threadId!.slice(0, 8), "the name he typed");
    expect(renamed.code).toBe(0);
    expect(renamed.io.lines).toEqual([`thread ${row!.threadId} named the name he typed, in Claude Code too`]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name he typed" }]);
    expect(ThreadView.parse((await threadRows(await dialHost(statePath)))[0]).title).toBe("the name he typed");

    const nowhere = await run("thread", "rename", row!.threadId!, "nowhere", "--json");
    expect(nowhere.code).toBe(0);
    expect(json(nowhere.io)).toEqual([{ threadId: row!.threadId, title: "nowhere", harness: "claude", outcome: "no-session" }]);

    // A store that refused the write says nothing about its sessions, so its own line is the answer, not "no such session".
    const locked = await run("thread", "rename", row!.threadId!, "locked");
    expect(locked.code).toBe(0);
    expect(locked.io.lines).toEqual([`thread ${row!.threadId} not named: database is locked`]);
    expect(json((await run("thread", "rename", row!.threadId!, "locked", "--json")).io)).toEqual([
      { threadId: row!.threadId, title: "locked", harness: "claude", outcome: "failed", error: "database is locked" },
    ]);

    await run("thread", "new", "--in", "alpha", "--agent", "codex", "build it there");
    const codexRow = (await rt.sessions.list()).find(v => v.harness === "codex")!;
    const unsupported = await run("thread", "rename", codexRow.threadId!, "the name");
    expect(unsupported.code).toBe(0);
    expect(unsupported.io.lines).toEqual([`thread ${codexRow.threadId} not named: Codex keeps no name of a person's for a session`]);

    const missing = await run("thread", "rename", "nope", "the name");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp thread rename: no thread nope"]);
    const short = await run("thread", "rename", row!.threadId!);
    expect(short.code).toBe(3);
    expect(short.io.errors).toEqual(["wsp thread rename: wsp thread rename takes a thread and one name"]);
  });

  it("thread rename wakes a napping workspace first, since the name goes into a store on its machine", async () => {
    const named = scriptedAgent(prompt => `re: ${prompt}`, () => ({ kind: "written" }));
    await restartHost({ claude: named.adapter });
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "build it");
    const [row] = await rt.sessions.list();
    await run("pause", "alpha");
    const renamed = await run("thread", "rename", row!.threadId!, "the name");
    expect(renamed.code).toBe(0);
    expect(renamed.io.errors).toEqual(["waking alpha"]);
    expect(named.renames).toEqual([{ sessionId: row!.claudeSessionId, title: "the name" }]);
    const [alpha] = await rt.workspaces.list();
    expect(alpha!.phase).toBe("running");
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
    await restartHost({ claude: held.adapter });
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

  it("--notify me run inside a turn names that turn's thread: the command line reads the token off its own environment, and the parent is steered the child's report whole", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const parent = run("thread", "new", "--in", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    // The environment the host launched that turn under is the one a wsp inside it would run with.
    const token = held.envs[0]![TURN_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    vi.stubEnv(TURN_TOKEN_ENV, token);
    const kid = run("thread", "new", "--in", "alpha", "--notify", "me", "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
    held.release(1, "Ran the gate.\nAll 12 tests green.");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): Ran the gate.\nAll 12 tests green.`;
    await vi.waitFor(() => expect(held.steered).toEqual([line]));
    const built = await kid;
    expect(built.code).toBe(0);
    // The child's own command prints no notice: the line went to the thread that asked for it, not to the person.
    expect(built.io.errors).toEqual([]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ threadId: kidRow.threadId, notify: parentRow!.threadId, text: line });
    held.release(0, "read the report");
    await parent;
  });

  it("--notify repeats: a builder's end reaches the orchestrator that started it and a reviewer thread, each once", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const orchestrator = run("thread", "new", "--in", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const reviewer = run("thread", "new", "--in", "alpha", "review what lands");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const rows = await rt.sessions.list();
    const [leadRow, reviewRow] = rows;
    vi.stubEnv(TURN_TOKEN_ENV, held.envs[0]![TURN_TOKEN_ENV]!);
    const kid = run("thread", "new", "--in", "alpha", "--notify", "me", "--notify", reviewRow!.threadId!.slice(0, 8), "build it");
    await vi.waitFor(() => expect(held.starts).toHaveLength(3));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== leadRow!.threadId && r.threadId !== reviewRow!.threadId)!;
    held.release(2, "all green");
    const line = `thread ${kidRow.threadId!.slice(0, 8)} finished (completed): all green`;
    await vi.waitFor(() => expect(held.steered).toEqual([line, line]));
    expect((await kid).code).toBe(0);
    const [alpha] = await rt.workspaces.list();
    const told = (await rt.sessions.history(alpha!.id)).filter(e => e.type === "session.notify");
    expect(told.map(e => e.notify)).toEqual([leadRow!.threadId, reviewRow!.threadId]);
    expect(told.map(e => e.text)).toEqual([line, line]);
    held.release(0, "read the report");
    held.release(1, "reviewed");
    await orchestrator;
    await reviewer;
  });

  it("--notify me with no token in the environment is still the person's, so a person's own shell and the app are unchanged", async () => {
    await run("new", "alpha");
    expect(process.env[TURN_TOKEN_ENV]).toBeUndefined();
    const { code, io } = await run("thread", "new", "--in", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list();
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ notify: "me" });
  });

  it("a token no turn on this host carries is refused, and nothing starts", async () => {
    await run("new", "alpha");
    vi.stubEnv(TURN_TOKEN_ENV, "f".repeat(32));
    const { code, io } = await run("thread", "new", "--in", "alpha", "--notify", "me", "build it");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual([`wsp thread new: ${NO_SUCH_TURN}`]);
    expect(io.lines).toEqual([]);
    expect(await rt.sessions.list()).toEqual([]);
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
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.done", undefined]);
    expect(events.at(-1)).toEqual({ threadId: first!.threadId, workspaceId: first!.workspaceId, harness: "claude", text: "re: second", outcome: "started" });
    expect(new Set(events.map(e => e.threadId))).toEqual(new Set([first!.threadId]));
    expect(events[1]).toMatchObject({ kind: "text", text: "re: " });
    expect(io.streamed).toBe("");
  });

  it("thread new --detach and send --detach print the thread id and return the moment the turn is started, before it ends; nothing streams", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const opened = await run("thread", "new", "--in", "alpha", "--detach", "build it");
    expect(held.starts).toHaveLength(1);
    const [row] = await rt.sessions.list();
    expect(row).toMatchObject({ status: "running", startedBy: "cli", prompt: "build it" });
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}`]);
    expect(opened.io.errors).toEqual([]);
    expect(opened.io.streamed).toBe("");
    held.release(0, "first done");
    expect((await rt.sessions.list())[0]!.status).toBe("completed");
    const sent = await run("send", row!.threadId!.slice(0, 8), "--detach", "--json", "more");
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more"]);
    expect(sent.code).toBe(0);
    expect(json(sent.io)).toEqual([{ threadId: row!.threadId, workspaceId: row!.workspaceId, harness: "claude", outcome: "started" }]);
    expect((await rt.sessions.list())[0]!.status).toBe("running");
    held.release(1, "second done");
    // A detached send that meets a running turn on an agent that cannot steer waits for its own start, as a followed one does, and says so.
    const third = await run("send", row!.threadId!, "--detach", "third");
    expect(third.io.lines).toEqual([`thread ${row!.threadId}`]);
    expect(held.starts).toHaveLength(3);
    const fourth = starting("send", row!.threadId!, "--detach", "fourth");
    // The waiting line is the runtime's answer that this start is behind the running turn: releasing that turn before
    // the line lands leaves the fourth start nothing to queue behind, so the fact is waited on and not a sleep.
    await vi.waitFor(() => expect(fourth.io.errors).toEqual(["waiting behind the running turn"]), { timeout: 10_000, interval: 10 });
    expect(held.starts).toHaveLength(3);
    held.release(2, "third done");
    await fourth.ended;
    expect(fourth.io.errors).toEqual(["waiting behind the running turn", "queued behind the running turn; it has ended and this turn started"]);
    expect(fourth.io.lines).toEqual([`thread ${row!.threadId}`]);
    expect(held.starts.map(s => s.prompt)).toEqual(["build it", "more", "third", "fourth"]);
    held.release(3, "fourth done");
  });

  it("threads wait returns the first of two threads to finish, in the notify line's words, then the second; a thread already over comes back at once from its transcript; a timeout prints nothing on stdout and says so on stderr", async () => {
    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "--detach", "--notify", "me", "build a");
    await run("thread", "new", "--in", "alpha", "--detach", "build b");
    const [a, b] = await rt.sessions.list();
    const timedOut = await run("threads", "wait", a!.threadId!, b!.threadId!.slice(0, 8), "--timeout", "0.05");
    expect(timedOut.code).toBe(0);
    expect(timedOut.io.lines).toEqual([]);
    expect(timedOut.io.errors).toEqual(["2 threads still running after 50ms"]);
    const asJson = await run("threads", "wait", a!.threadId!, "--timeout", "0.05", "--json");
    expect(json(asJson.io)).toEqual([{ timedOut: true }]);
    expect(asJson.io.errors).toEqual([`thread ${a!.threadId!.slice(0, 8)} still running after 50ms`]);

    const waiting = run("threads", "wait", a!.threadId!, b!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(1, "b is green\nall done for b");
    const first = await waiting;
    expect(first.code).toBe(0);
    expect(first.io.lines).toEqual([`thread ${b!.threadId!.slice(0, 8)} finished (completed): all done for b`]);
    expect(first.io.errors).toEqual([]);
    // b is over, so a wait naming both comes back with b at once, read off the transcript; the JSON is the tool's object.
    const again = await run("threads", "wait", a!.threadId!, b!.threadId!, "--json");
    expect(again.code).toBe(0);
    expect(json(again.io)).toEqual([{ finished: { threadId: b!.threadId, status: "completed", reply: "all done for b" } }]);

    const onlyA = run("threads", "wait", a!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    held.release(0, "a done");
    const second = await onlyA;
    expect(second.io.lines).toEqual([`thread ${a!.threadId!.slice(0, 8)} finished (completed): a done`]);
    // The words are the one formatter's: the line the runtime recorded for a's --notify me is the line the wait printed.
    const history = await rt.sessions.history(a!.workspaceId);
    expect(history.find(e => e.type === "session.notify" && e.threadId === a!.threadId)).toMatchObject({ text: second.io.lines[0] });
    expect(second.io.lines[0]).toBe(notifyLine(a!.threadId!, { status: "completed", text: "a done" }));
    expect(held.starts).toHaveLength(2);

    const none = await run("threads", "wait");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp threads wait takes one thread or more");
    const soon = await run("threads", "wait", a!.threadId!, "--timeout", "soon");
    expect(soon.code).toBe(3);
    expect(soon.io.errors[0]).toContain('--timeout takes seconds, a number above zero, not "soon"');
    const missing = await run("threads", "wait", a!.threadId!, "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp threads wait: no thread nope"]);
    const stray = await run("threads", "nope");
    expect(stray.code).toBe(3);
    expect(stray.io.errors[0]).toContain("wsp threads takes no positional arguments; wsp threads wait is its one subcommand");
  });

  it("threads wait on a turn the runtime ended says failed with the runtime's reason, as the notify line would; a turn the transport cut says the cut line", async () => {
    await restartHost({ claude: stuckAgent() });
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "--detach", "loop forever");
    const [row] = await rt.sessions.list();
    const waiting = run("threads", "wait", row!.threadId!);
    await new Promise(r => setTimeout(r, 30));
    await run("pause", "alpha");
    const paused = await waiting;
    expect(paused.code).toBe(0);
    expect(paused.io.lines).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (failed): machine paused while the agent was working`]);
    const later = await run("threads", "wait", row!.threadId!, "--json");
    expect(json(later.io)).toEqual([{ finished: { threadId: row!.threadId, status: "failed", reply: "machine paused while the agent was working" } }]);

    await restartHost({ claude: claude.adapter });
    await run("thread", "new", "--in", "alpha", "--detach", "cut");
    const cut = (await rt.sessions.list()).find(r => r.prompt === "cut")!;
    const cutWait = await run("threads", "wait", cut.threadId!);
    expect(cutWait.io.lines).toEqual([`thread ${cut.threadId!.slice(0, 8)} finished (failed): ${CUT_LINE}`]);
  });

  it("thread new, send and fork --send return with the reply on the turn's session.done; a session.end that never comes is not waited for", async () => {
    const agent = doneOnlyAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const opened = await run("thread", "new", "--in", "alpha", "first");
    const [row] = await rt.sessions.list();
    expect(opened.code).toBe(0);
    expect(opened.io.lines).toEqual([`thread ${row!.threadId}`, "re: first"]);
    expect(opened.io.errors).toEqual([]);
    const sent = await run("send", row!.threadId!, "second", "--json");
    expect(sent.code).toBe(0);
    expect((json(sent.io) as { type: string }[]).map(e => e.type)).toEqual(["session.start", "session.delta", "session.done", undefined]);
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
      { exitCode: 3 },
    ]);
    const bare = await run("exec", "alpha");
    expect(bare.code).toBe(3);
    expect(bare.io.errors).toEqual(["wsp exec: wsp exec takes a workspace, then -- and the command"]);
  });

  it("exec hands the machine each argument as it was given: a quoted word stays one word", async () => {
    await run("new", "alpha");
    execGuest(backend, "", 0);
    const { code } = await run("exec", "alpha", "--", "grep", "a b", "file.txt");
    expect(code).toBe(0);
    expect(launchedScript(backend)).toContain("\ncd ~ && 'grep' 'a b' 'file.txt'\n");
  });

  it("exec runs in --cwd when given, else in the workspace's imported project folder, else the home; a failing command says on stderr where it ran", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    execGuest(backend, "", 0);
    const home = await run("exec", "alpha", "--", "git", "status");
    expect(home.code).toBe(0);
    expect(home.io.errors).toEqual([]);
    expect(launchedScripts(backend).at(-1)).toContain("\ncd ~ && 'git' 'status'\n");

    const named = await run("exec", "alpha", "--cwd", "/root/work/else where", "--", "git", "status");
    expect(named.code).toBe(0);
    expect(launchedScripts(backend).at(-1)).toContain("\ncd '/root/work/else where' && 'git' 'status'\n");

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    execGuest(backend, "fatal: not a git repository\n", 128);
    const inProject = await run("exec", "alpha", "--", "git", "status");
    expect(inProject.code).toBe(128);
    expect(launchedScripts(backend).at(-1)).toContain("\ncd '/root/work/proj' && 'git' 'status'\n");
    expect(inProject.io.lines).toEqual(["fatal: not a git repository"]);
    expect(inProject.io.errors).toEqual(["ran in /root/work/proj"]);

    const overridden = await run("exec", "alpha", "--cwd", "/root", "--", "git", "status");
    expect(overridden.code).toBe(128);
    expect(launchedScripts(backend).at(-1)).toContain("\ncd '/root' && 'git' 'status'\n");
    expect(overridden.io.errors).toEqual(["ran in /root"]);

    const relative = await run("exec", "alpha", "--cwd", "packages/host", "--", "git", "status");
    expect(relative.code).toBe(3);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute: got "packages/host"\n\nusage: wsp exec <workspace> [--cwd <dir>] -- <command...>']);
  });

  it("a failing exec says the folder the host ran it in, the machine's home on a fork and the workspace's own on this computer", async () => {
    await run("new", "alpha");
    execGuest(backend, "", 2);
    const fork = await run("exec", "alpha", "--", "false");
    expect(fork.code).toBe(2);
    // A fork's kind names no folder, so its shell lands in the machine's own home and the line says so.
    expect(fork.io.errors).toEqual(["ran in the home folder"]);

    // On this computer the host resolved a folder, so the line names it rather than the home the rule used to assume.
    await run("new", "--local", "mac");
    const work = localWorkFolder(join(dir, "user"));
    const local = await run("exec", "mac", "--", "false");
    expect(local.code).toBe(1);
    expect(local.io.errors).toEqual([`ran in ${work}`]);
    const raw = await run("exec", "mac", "--json", "--", "false");
    expect(json(raw.io).at(-1)).toEqual({ exitCode: 1, cwd: work });
  });

  it("a host that stops under a turn says so and that the turn goes on, in one line with exit 1 instead of hanging", async () => {
    await restartHost({ claude: stuckAgent() });
    await run("new", "alpha");
    execGuest(backend, "", undefined);
    const turn = run("thread", "new", "--in", "alpha", "hang");
    const command = run("exec", "alpha", "--", "sleep", "600");
    await new Promise(r => setTimeout(r, 300));
    await handle!.close();
    handle = undefined;
    const [t, c] = await Promise.all([turn, command]);
    expect(t.code).toBe(1);
    expect(t.io.errors).toEqual([`wsp thread new: ${HOST_STOPPING_LINE}`]);
    expect(t.io.lines).toHaveLength(1);
    expect(c.code).toBe(1);
    expect(c.io.errors).toEqual([`wsp exec: ${HOST_STOPPING_LINE}`]);
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
    expect(c.io.errors).toEqual(["wsp exec: machine deleted while the agent was working"]);
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
        const reply = op === "workspaces.list" ? { workspaces: [workspace] } : op === "workspaces.wake" ? { workspace } : op === "harnesses.list" ? { harnesses: [] } : op === "sessions.start" ? { session } : {};
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

  /** A folder on this computer with one source file and one secret-shaped file, not a repository. */
  function projectFolder(): string {
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "index.ts"), "export const a = 1;\n");
    writeFileSync(join(proj, ".env"), "API_TOKEN=sk-ant-x\n");
    return proj;
  }
  const landings = (): string[] => backend.machines[0]!.runLog.filter(s => s.includes("mv "));

  it("folders lists one level of this computer's folders with the repository marked and the hidden ones counted, and refuses a path outside the roots", async () => {
    const home = join(dir, "user");
    mkdirSync(join(home, "code", "spoo", ".git"), { recursive: true });
    mkdirSync(join(home, "code", "notes"), { recursive: true });
    mkdirSync(join(home, "code", ".cache"), { recursive: true });
    const { code, io } = await run("folders", join(home, "code"));
    expect(code).toBe(0);
    const lines = io.lines[0]!.split("\n");
    const cells = (line: string): string[] => line.split(/ {2,}/);
    expect(cells(lines[0]!)).toEqual(["FOLDER", "GIT"]);
    expect(lines.slice(1, 3).map(cells)).toEqual([[join(home, "code", "notes")], [join(home, "code", "spoo"), "git"]]);
    expect(lines.at(-1)).toBe(`2 folders in ${join(home, "code")}, 1 hidden. Browsable: ${home}.`);
    // The dot-named folder is a row only when it is asked for, and --json is the listing the app's picker reads.
    const shown = await run("folders", join(home, "code"), "--hidden", "--json");
    expect(json(shown.io)).toEqual([{ dir: join(home, "code"), roots: [home], folders: [{ path: join(home, "code", ".cache"), repo: false }, { path: join(home, "code", "notes"), repo: false }, { path: join(home, "code", "spoo"), repo: true }], hidden: 1 }]);
    const outside = await run("folders", "/etc");
    expect(outside.code).toBe(1);
    expect(outside.io.errors.join("\n")).toBe(`wsp folders: /etc is outside the folders wsp browses on this computer: ${home}`);
    const many = await run("folders", join(home, "code"), join(home, "Applications"));
    // A line refused before anything was dialled is a usage refusal, which is the code an agent branches on.
    expect(many.code).toBe(3);
    expect(many.io.errors.join("\n")).toContain("takes one folder on this computer at most");
  });

  it("terminal config reads this computer's Ghostty config with its theme, prints it as Ghostty lines or one object, resolves the scheme asked for, and refuses a word outside light and dark", async () => {
    const home = join(dir, "user");
    vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
    mkdirSync(join(home, ".config", "ghostty", "themes"), { recursive: true });
    writeFileSync(join(home, ".config", "ghostty", "config"), "theme = light:Day,dark:Night\nfont-family = Berkeley Mono\nfont-size = 13\nbackground-opacity = 0.9\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Night"), "background = #1e1e2e\nforeground = #cdd6f4\npalette = 1=#f38ba8\n");
    writeFileSync(join(home, ".config", "ghostty", "themes", "Day"), "background = #fafafa\n");
    const { code, io } = await run("terminal", "config");
    expect(code).toBe(0);
    expect(io.lines[0]!.split("\n")).toEqual([
      `Read ${join(home, ".config", "ghostty", "config")}, ${join(home, ".config", "ghostty", "themes", "Night")}`,
      "font-family = Berkeley Mono",
      "font-size = 13",
      "theme = Night",
      "background = #1e1e2e",
      "foreground = #cdd6f4",
      "palette = 1 of 16 colors",
      "background-opacity = 0.9",
    ]);
    const light = await run("terminal", "config", "--scheme", "light", "--json");
    expect(light.code).toBe(0);
    expect(json(light.io)).toEqual([
      expect.objectContaining({ files: [join(home, ".config", "ghostty", "config"), join(home, ".config", "ghostty", "themes", "Day")], theme: "Day", background: { r: 250, g: 250, b: 250 }, fontFamily: ["Berkeley Mono"], fontSize: 13, backgroundOpacity: 0.9 }),
    ]);
    // The same answer the app gets over the host's socket, so the line and the pane never disagree.
    const client = await dialHost(statePath);
    try {
      expect(await client.request("host.terminalConfig", { scheme: "light" })).toMatchObject({ config: json(light.io)[0] });
    } finally {
      client.close();
    }
    const sepia = await run("terminal", "config", "--scheme", "sepia");
    expect(sepia.code).toBe(3);
    expect(sepia.io.errors).toEqual(['wsp terminal config: --scheme takes one of light, dark, not "sepia"']);
    const extra = await run("terminal", "config", "now");
    expect(extra.code).toBe(3);
    // No config at all is not a failure: the empty object says the pane keeps its defaults.
    rmSync(join(home, ".config", "ghostty"), { recursive: true });
    const none = await run("terminal", "config", "--json");
    expect(none.code).toBe(0);
    expect(json(none.io)).toEqual([{ files: [], fontFamily: [], palette: Array<null>(16).fill(null) }]);
  });

  it("a folder inside the roots this Mac will not let the host read comes back as one stderr line at the provider's code, not a usage refusal", async () => {
    const home = join(dir, "user");
    const shut = join(home, "Documents");
    mkdirSync(shut, { recursive: true });
    const words = `EACCES: permission denied, scandir '${shut}'`;
    const refused = await withRefused(shut, () => run("folders", shut));
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp folders: ${words}`]);
    // The machine said no, so the class is the provider's on the JSON door too, where stdout stays empty.
    const asJson = await withRefused(shut, () => run("folders", shut, "--json"));
    expect(asJson.io.lines).toEqual([]);
    expect(asJson.io.errors).toHaveLength(1);
    expect(JSON.parse(asJson.io.errors[0]!)).toEqual({ error: words, class: "provider", exit: 1 });
  });

  it("import off a terminal prints the plan with the .env cut by default, moves nothing without --yes, --keep or --cut, and names --yes on stderr", async () => {
    const proj = projectFolder();
    await run("new", "alpha");
    const { code, io } = await run("import", proj, "--to", "alpha");
    expect(code).toBe(0);
    expect(io.errors).toEqual([PLAN_ONLY]);
    const text = io.lines.join("\n");
    expect(text).toMatch(/^Repository {2,}none$/m);
    expect(text).toMatch(/^Files {2,}2 files, 39 B$/m);
    expect(text).toMatch(/^Caches left behind {2,}none$/m);
    expect(text).toMatch(new RegExp(`^Lands at {2,}${realpathSync(proj)}$`, "m"));
    expect(text).toMatch(/^Secret-shaped {2,}1 file$/m);
    expect(text).toMatch(/^ {2}\.env {2,}name(, \w+)*, 19 B {2,}left out$/m);
    expect(text).toMatch(/^Agents {2,}none with sessions for the folder$/m);
    expect(landings()).toEqual([]);
    expect(io.streamed).toBe("");
  });

  it("import with a person at the terminal prints the plan and asks once, default no: no lands nothing and prints no hint, yes lands the folder", async () => {
    const proj = projectFolder();
    await run("new", "alpha");
    const person = async (reply: string): Promise<{ code: number; io: Captured }> => {
      const io = captured();
      io.isTTY = true;
      io.ask = async q => {
        asked.push(q);
        return reply;
      };
      return { code: await cli(["import", proj, "--to", "alpha", "--state", statePath], io), io };
    };
    const declined = await person("no");
    expect(declined.code).toBe(0);
    expect(declined.io.errors).toEqual([]);
    expect(declined.io.lines.join("\n")).toMatch(/^Secret-shaped {2,}1 file$/m);
    expect(asked).toEqual(["Import now? y/N"]);
    expect(landings()).toEqual([]);
    const accepted = await person("yes");
    expect(accepted.code).toBe(0);
    expect(accepted.io.errors).toEqual([]);
    expect(accepted.io.lines.at(-1)).toBe(`1 file, 20 B, landed at ${realpathSync(proj)}.`);
    expect(asked).toEqual(["Import now? y/N", "Import now? y/N"]);
    expect(landings()).toHaveLength(1);
  });

  it("import --yes packs the folder without the .env, streams the stages, lands it at the same path on the machine and prints the done line; --json prints the plan and the outcome", async () => {
    const proj = projectFolder();
    const real = realpathSync(proj);
    await run("new", "alpha");
    const { code, io } = await run("import", proj, "--to", "alpha", "--yes");
    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    expect(io.lines.at(-1)).toBe(`1 file, 20 B, landed at ${real}.`);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(expect.arrayContaining(["No secret-shaped file travels; cut .env.", "Packing 1 file.", `Landing at ${real}.`]));
    expect(io.streamed).not.toContain("landed at");
    expect(landings()).toHaveLength(1);
    expect(landings()[0]).toMatch(new RegExp(`test ! -e '${real}' \\|\\| exit 66\nmv '${real}\\.wsp-in-[^']+' '${real}'`));
    const [ws] = await rt.workspaces.list();
    expect(ws!.project).toMatchObject({ name: "proj", dest: real });

    const again = await run("import", proj, "--to", "alpha", "--yes", "--replace", "--json");
    expect(again.code).toBe(0);
    expect(again.io.streamed).toBe("");
    const values = json(again.io) as [{ plan: unknown }, { imported: unknown }];
    expect(values).toHaveLength(2);
    expect(values[0]).toEqual({ plan: expect.objectContaining({ source: real, repo: false, files: 2, bytes: 39, excluded: [], agents: [], secrets: [expect.objectContaining({ path: ".env", bytes: 19 })] }) });
    expect(values[1]).toEqual({ imported: { dest: real, files: 1, bytes: 20, parts: 1, cut: [".env"], rewritten: [], agents: [] } });
    expect(landings()[1]).toContain(`rm -rf '${real}'`);
  });

  it("import --keep carries the secret-shaped row and is consent enough; a --keep or --cut path the plan does not list is refused before anything moves", async () => {
    const proj = projectFolder();
    const real = realpathSync(proj);
    await run("new", "alpha");
    const kept = await run("import", proj, "--to", "alpha", "--keep", ".env", "--json");
    expect(kept.code).toBe(0);
    expect(kept.io.errors).toEqual([]);
    expect(json(kept.io).at(-1)).toEqual({ imported: { dest: real, files: 2, bytes: 39, parts: 1, cut: [], rewritten: [], agents: [] } });
    expect(landings()).toHaveLength(1);
    const bad = await run("import", proj, "--to", "alpha", "--cut", "src/index.ts", "--replace");
    expect(bad.code).toBe(3);
    expect(bad.io.lines).toEqual([]);
    expect(bad.io.errors).toEqual(["wsp import: src/index.ts is not a secret-shaped file in the plan; the plan lists .env"]);
    expect(landings()).toHaveLength(1);
  });

  it("import refuses a paused workspace with the protocol's sentence before reading the folder, an --agents id without sessions naming the plan's, and a folder already on the machine in two lines, the second naming --replace", async () => {
    const proj = projectFolder();
    const real = realpathSync(proj);
    await run("new", "alpha");
    await run("pause", "alpha");
    const paused = await run("import", proj, "--to", "alpha", "--yes");
    expect(paused.code).toBe(1);
    expect(paused.io.lines).toEqual([]);
    expect(paused.io.errors).toEqual(["wsp import: Workspace is paused; wake it to import"]);
    await run("wake", "alpha");
    const noSessions = await run("import", proj, "--to", "alpha", "--yes", "--agents", "claude");
    expect(noSessions.code).toBe(3);
    expect(noSessions.io.lines).toEqual([]);
    expect(noSessions.io.errors).toEqual(["wsp import: claude has no sessions for this folder"]);
    const base = backend.execImpl;
    backend.execImpl = (m, cmd) => (cmd.startsWith("test -e ") ? { exitCode: 0, stdout: "yes\n", stderr: "" } : base(m, cmd));
    const taken = await run("import", proj, "--to", "alpha", "--yes");
    expect(taken.code).toBe(1);
    expect(taken.io.errors).toEqual([`wsp import: ${real} already exists on the machine; import with replace to overwrite it\nRun again with --replace to overwrite it.`]);
    expect(landings()).toEqual([]);
  });

  it("import lists the agents with sessions for the folder, sends the ticked ones' sessions keyed to the path on the machine when --agents names them", async () => {
    const proj = projectFolder();
    const real = realpathSync(proj);
    const key = real.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(dir, "user", ".claude", "projects", key), { recursive: true });
    writeFileSync(join(dir, "user", ".claude", "projects", key, "S1.jsonl"), EXPORT_SESSION(real));
    await run("new", "alpha");
    const planned = await run("import", proj, "--to", "alpha");
    expect(planned.io.lines.join("\n")).toMatch(/^Agents {2,}1 agent with sessions for the folder\n {2}Claude Code {2,}1 session {2,}sessions travel$/m);
    const { code, io } = await run("import", proj, "--to", "alpha", "--yes", "--agents", "claude", "--json");
    expect(io.errors).toEqual([]);
    expect(code).toBe(0);
    const { imported } = json(io).at(-1) as { imported: { agents: { agent: string; files: number; outcome: string }[] } };
    expect(imported.agents).toEqual([{ agent: "claude", files: 1, bytes: EXPORT_SESSION(real).length, outcome: "transcript-only" }]);
    const uploads = backend.machines[0]!.runLog.filter(s => s.includes("tar xzf"));
    expect(uploads.at(-1)).toContain("tar xzf - -C '/' --no-same-owner");
    expect(landings()).toHaveLength(1);
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
    expect(json(replaced.io)).toEqual([{ dest, files: 2, bytes: 28, excluded: ["node_modules"], agents: [] }]);
    expect(replaced.io.streamed).toBe("");
    expect(existsSync(join(dest, "old.txt"))).toBe(false);
    expect(guest.sources).toEqual([dest]);
    expect(existsSync(join(dir, "user", ".claude"))).toBe(false);
  });

  it("export refuses an --agents id the catalog does not know before anything reaches the machine, naming it and the ids it knows", async () => {
    const guest = exportGuest(backend);
    await run("new", "alpha");
    const typo = await run("export", "alpha", join(dir, "out", "proj"), "--agents", "claude,codx");
    expect(typo.code).toBe(3);
    expect(typo.io.lines).toEqual([]);
    expect(typo.io.errors).toEqual([`wsp export: ${unknownAgentLine("codx", CATALOG_AGENTS.map(a => a.id))}`]);
    expect(guest.sources).toEqual([]);
    expect(existsSync(join(dir, "out"))).toBe(false);
  });

  it("every verb takes --json and --help; a bad flag prints the usage", async () => {
    for (const verb of [["new"], ["fork"], ["snapshot"], ["pause"], ["wake"], ["forget"], ["delete"], ["threads"], ["threads", "wait"], ["thread", "new"], ["send"], ["stop"], ["exec"], ["import"], ["export"]]) {
      const help = await run(...verb, "--help");
      expect(help.code).toBe(0);
      expect(help.io.lines[0]).toMatch(new RegExp(`^usage: wsp ${verb.join(" ")}`));
      expect(help.io.lines[0]).toContain("--json");
    }
    const bad = await run("threads", "--nope");
    expect(bad.code).toBe(3);
    expect(bad.io.errors[0]).toContain("Unknown option '--nope'");
    expect(bad.io.errors[0]).toContain("usage: wsp threads");
    // A flag another verb reads is refused naming that verb, so the caller is told where it lives: thread new's --agent on send, threads' --in on stop.
    const foreign = await run("send", "row_1", "--agent", "claude", "hello");
    expect(foreign.code).toBe(3);
    expect(foreign.io.errors).toEqual(['--agent belongs to wsp fork and wsp thread new; wsp send does not read it\n\nusage: wsp send <thread> [--model, --effort, --access <value>] [--image <path>] [--detach] "<message>"']);
    const within = await run("stop", "row_1", "--in", "alpha");
    expect(within.io.errors[0]).toContain("--in belongs to wsp threads and wsp thread new; wsp stop does not read it");
    // A flag spelled like a prototype member is nobody's: the tables are read as own keys, so it gets the parser's line.
    const proto = await run("threads", "--constructor");
    expect(proto.code).toBe(3);
    expect(proto.io.errors[0]).toContain("Unknown option '--constructor'");
    expect(proto.io.errors[0]).not.toContain("belongs to");
    const half = await run("thread");
    expect(half.code).toBe(3);
    expect(half.io.errors).toEqual(['usage: wsp thread new --in <workspace> [--agent, --model, --effort, --access, --cwd, --notify, --title, --image <path>, --detach] "<task>"\nusage: wsp thread rename <thread> "<title>"']);
  });

  it("without a host serving the state file every verb refuses in one line before dialling anything", async () => {
    await handle!.close();
    handle = undefined;
    const { code, io } = await run("threads");
    expect(code).toBe(1);
    expect(io.errors).toEqual([`wsp threads: no wsp host is serving ${statePath}; run wsp up first`]);
  });

  it("a wrong token is refused by the host, under the auth class", async () => {
    writeFileSync(join(dir, "state", "host-token"), "not-the-token\n");
    const { code, io } = await run("threads");
    expect(code).toBe(2);
    expect(io.errors).toEqual(["wsp threads: unauthorized"]);
  });

  describe("an image on a message from the command line", () => {
    /** A real PNG head, so the type is read off the bytes as the verbs read it; the rest is filler of a known weight. */
    const pngFile = (dirPath: string, name: string, bytes: number): string => {
      const path = join(dirPath, name);
      writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes - 8, 7)]));
      return path;
    };

    it("wsp send --image reads the file here and sends its bytes, so the machine never reaches back for this computer's files", async () => {
      await run("new", "alpha");
      await run("thread", "new", "--in", "alpha", "hello");
      const [row] = await rt.sessions.list();
      const path = pngFile(dir, "shot.png", 2048);
      const sent = await run("send", row!.threadId!, "--image", path, "what does this show?");
      expect(sent.code).toBe(0);
      const start = claude.starts.at(-1)!;
      expect(start.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
      // The path itself never travels: the agent is handed the bytes, not somewhere on this computer to look.
      expect(JSON.stringify(start)).not.toContain(path);
    });

    it("the flag repeats, and the images reach the agent in the order they were named", async () => {
      await run("new", "alpha");
      await run("thread", "new", "--in", "alpha", "hello");
      const [row] = await rt.sessions.list();
      const one = pngFile(dir, "one.png", 512);
      const two = pngFile(dir, "two.png", 1024);
      const sent = await run("send", row!.threadId!, "--image", one, "--image", two, "these two");
      expect(sent.code).toBe(0);
      expect(claude.starts.at(-1)!.images?.map(i => i.bytes)).toEqual([readFileSync(one).toString("base64"), readFileSync(two).toString("base64")]);
    });

    it("thread new --image opens the thread with the image on its first turn", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "opening.png", 256);
      const opened = await run("thread", "new", "--in", "alpha", "--image", path, "what is this?");
      expect(opened.code).toBe(0);
      expect(claude.starts.at(-1)!.images).toEqual([{ mediaType: "image/png", bytes: readFileSync(path).toString("base64") }]);
    });

    it("the person's turn prints one bracket per image on stderr, since a terminal draws no pixels", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "big.png", 1_258_291);
      const opened = await run("thread", "new", "--in", "alpha", "--image", path, "what is this?");
      expect(opened.io.streamed).toContain("[image 1.2 MB png]");
    });

    it("a path this computer has no file at answers in a sentence, not in the reader's own error", async () => {
      await run("new", "alpha");
      const missing = join(dir, "not-here.png");
      const refused = await run("send", "--image", missing, "x", "y");
      expect(refused.io.errors[0]).not.toContain("ENOENT");
      const opening = await run("thread", "new", "--in", "alpha", "--image", missing, "look");
      expect(opening.code).toBe(EXIT_CODES.usage);
      expect(opening.io.errors).toEqual([`wsp thread new: there is no file at ${missing} on this computer`]);
      expect(claude.starts).toHaveLength(0);
    });

    it("a folder named where an image should be is refused the same way, rather than failing on the read", async () => {
      await run("new", "alpha");
      const refused = await run("thread", "new", "--in", "alpha", "--image", dir, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp thread new: there is no file at ${dir} on this computer`]);
    });

    it("a file that is not one of the four types is refused by name, before anything travels", async () => {
      await run("new", "alpha");
      const path = join(dir, "notes.pdf");
      writeFileSync(path, "%PDF-1.7 not an image at all");
      const refused = await run("thread", "new", "--in", "alpha", "--image", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp thread new: ${path} is not PNG, JPEG, GIF or WebP; a message carries those four`]);
      expect(claude.starts).toHaveLength(0);
    });

    it("a 12 MB image is refused with the cap in the sentence, and the file is never read whole", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "huge.png", 12 * 1024 * 1024);
      const refused = await run("thread", "new", "--in", "alpha", "--image", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp thread new: huge.png is 12.0 MB, over the 10.0 MB an image may be"]);
      expect(claude.starts).toHaveLength(0);
    });

    it("six images are refused with both counts", async () => {
      await run("new", "alpha");
      const paths = Array.from({ length: 6 }, (_, i) => pngFile(dir, `n${i}.png`, 64));
      const refused = await run("thread", "new", "--in", "alpha", ...paths.flatMap(p => ["--image", p]), "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp thread new: only 5 images fit one message; this one carries 6"]);
    });
  });
});

describe("messageTo", () => {
  const row: ThreadView = { id: "row_1", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "failed", title: "hello", sessionId: "row_1", turns: 1 };
  it("names the thread when the row has one, resumes by session when it has only that, and refuses a row with neither instead of minting a thread in silence", () => {
    expect(messageTo({ ...row, threadId: "thr_1", claudeSessionId: "sess_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "thr_1" });
    expect(messageTo({ ...row, threadId: "thr_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", thread: "thr_1" });
    expect(messageTo({ ...row, claudeSessionId: "sess_1" }, "again")).toEqual({ workspaceId: "ws_1", prompt: "again", harness: "claude", resume: "sess_1" });
    expect(() => messageTo(row, "again")).toThrow("thread row_1 has no session to resume yet");
  });
});

describe("the verbs never talk to the provider", () => {
  it("import the protocol, the catalog, the collector for the recipe verbs and the host's lock file only: no runtime, engine, backend or key loading", () => {
    const source = readFileSync(new URL("../src/verbs.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/ from "([^"]+)";$/gm)].map(m => m[1]!);
    // The catalog is rows and ids alone (the agents a thread can take), so the agent argument's list reaches no provider.
    expect(imports.filter(i => i.startsWith("@wsp/"))).toEqual(["@wsp/catalog", "@wsp/collect", "@wsp/protocol"]);
    expect(imports).not.toContain("@wsp/runtime");
    expect(imports).not.toContain("@wsp/engine");
    expect(source).not.toMatch(/SOLARI|ANTHROPIC|loadKeys|SolariBackend|getsolari/);
  });
});
