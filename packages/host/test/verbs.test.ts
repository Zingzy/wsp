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
import { passphraseCipher } from "@wsp/engine";
import { agentsKindRefusal, DEFAULT_PREFERENCES, effortsFor, HOST_TOKEN_ENV, HOST_URL_ENV, noWorkspaceRefusal, spawnReachRefusal, EMPTY_TASK_LINE, EXIT_CODES, IMAGE_NO_VAULT, IMAGE_PASSPHRASE_ENV, IMAGE_PASSPHRASE_MIN, HOST_STOPPING_LINE, IMAGE_ALREADY_NEWEST, IMAGE_MOVE_CONFIRM, imageKeptLine, lastTargetLine, markedDefault, NO_SUCH_TURN, noLastTargetLine, noProjectLine, noReplyLine, noThreadTargetLine, notifyLine, noWorkspaceForFolderLine, fmtSize, kindWords, registeredLine, REGISTERING_LINE, registerTakesNoConsentLine, signInRefusalLine, threadForgetRefusal, threadOpenedLine, threadWithoutIdRefusal, ThreadView, TURN_TOKEN_ENV, unknownAgentLine, workspaceKind, WorkspaceView, type HarnessCatalogAnswer } from "@wsp/protocol";
import { copyKey, createRuntime, harnessCatalog, memoryStore, type HarnessAdapterFactory, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HELP, cli, localWiring, localWorkFolder, serve } from "../src/cli.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import type { HostHandle } from "../src/server.js";
import { CLI_VERBS, PLAN_ONLY, deleteQuestion, deletedLine, dialHost, firstEnded, lastTarget, messageTo, threadRows, threadTree, threadsOf, type HostClient } from "../src/verbs.js";
import { HOST_SIDE_VAULT } from "../src/verbs.js";
import { hostSideOnlyFix, hostSideOnlyLine } from "../src/hosts.js";
import { writeHost } from "../src/hosts.js";
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
  /** The environment every verb here runs with: this file's, never the shell that started the run, so a builder with
   * WSP_TURN exported does not have every start refused. A case that means a turn writes that turn's token into it. */
  let env: Record<string, string | undefined>;

  beforeEach(async () => {
    asked.length = 0;
    env = {};
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
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
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
    return { io, ended: cli([...argv.slice(0, at), "--state", statePath, ...argv.slice(at)], io, undefined, env) };
  }
  async function run(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const { io, ended } = starting(...argv);
    return { code: await ended, io };
  }
  const json = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  /** The workspace column of the table wsp workspaces prints, which is the list a person reads names off. */
  const names = (listed: { io: Captured }): string[] => listed.io.lines[0]!.split("\n").slice(1).map(row => row.split(/\s+/)[0]!);
  /** A verb run with a person at the keyboard: every question it asks is recorded and answered with reply. */
  const asked: string[] = [];
  async function answer(reply: string, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    io.isTTY = true;
    io.ask = async q => {
      asked.push(q);
      return reply;
    };
    return { code: await cli([...argv, "--state", statePath], io, undefined, env), io };
  }
  const head = (m: typeof SEALED_GOLDEN) => m.versions.find(v => v.version === m.head)!;
  /** An image record with a vault of `bytes`, for the export roads; the hashes are plainly fake. */
  const RECORD = (bytes: number) => ({ name: "default", version: 1, hash: "a".repeat(64), recipeHash: "rh", logins: [{ name: "codex", state: "copied" as const }], sealedAt: "2026-09-12T00:00:00.000Z", sealedFrom: "h1", vault: { sha256: "b".repeat(64), bytes, paths: 2, takenAt: "2026-09-12T00:00:00.000Z" } });

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
    expect(odd.io.errors).toEqual([`wsp new: 8x16 is not a size this provider offers; ${list}. Name one of those with --size.`]);
    const word = await run("fork", "big", "--size", "large");
    expect(word.code).toBe(3);
    expect(word.io.errors).toEqual([`wsp fork: large is not a size this provider offers; ${list}. Name one of those with --size.`]);
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

  it("workspaces lists this computer beside a fork, its machine cell the size line its sidebar row reads and its state cell empty, and thread new --in takes it by name like any workspace", async () => {
    await run("new", "alpha");
    await run("new", "--local", "mac");
    const listed = await run("workspaces");
    expect(listed.code).toBe(0);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["WORKSPACE", "ID", "MACHINE", "STATE", "PROJECTS", "AGENTS"]);
    // The fork names its provider machine and its state; this computer's machine cell is its cores and memory, the
    // one size line the app's row reads, and it has no state to name, so that cell falls off the end of the row.
    expect(rows.map(r => r.split(/ {2,}/))).toEqual([
      ["alpha", expect.stringMatching(/^ws_/), expect.stringMatching(/^m\d+$/), "Running"],
      ["mac", expect.stringMatching(/^ws_/), expect.stringMatching(/^\d+\u00a0cores\u00a0·\u00a0\d+\u00a0GB$/)],
    ]);
    expect(listed.io.errors).toEqual([]);

    const raw = await run("workspaces", "--json");
    const rawRows = (json(raw.io)[0] as { workspaces: (WorkspaceView & { size: { cpu: number; memMb: number } })[] }).workspaces;
    expect(rows[1]!.split(/ {2,}/)[2]).toBe(fmtSize(rawRows[1]!.size, kindWords("local").cpu));
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
    // The workspace is on the listing throughout: what the machine is, is the machine's trouble to say, and no verb
    // answers for a machine by calling the workspace missing.
    expect(names(await run("workspaces"))).toEqual(["alpha"]);
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
    expect(refused.io.errors).toEqual(["wsp rebuild: Rebuild replaces a machine wsp cannot get back; this one answers"]);
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
    expect(asJson.io.errors.map(l => JSON.parse(l) as unknown)).toEqual([{ error: "Rebuild replaces a machine wsp cannot get back; this one answers", class: "provider", exit: EXIT_CODES.provider }]);
    const missing = await run("rebuild", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp rebuild: no workspace nope"]);
    const extra = await run("rebuild", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors).toEqual(["wsp rebuild takes one workspace. usage: wsp rebuild <workspace>"]);
  });

  it("wsp image reads the record off the seeded golden's head, says no sign-ins are held, and names the copy at this host's place", async () => {
    const listed = await run("image");
    expect(listed.code).toBe(0);
    const lines = listed.io.lines.join("\n").split("\n");
    expect(lines[0]).toContain("default v1");
    expect(lines[0]).toContain(IMAGE_NO_VAULT);
    expect(lines[0]).not.toContain("sign-in held");
    expect(lines[1]).toMatch(/^default · v1/);
    const [view] = json((await run("image", "--json")).io) as [{ image: { version: number; vault?: unknown }; copies: { place: string }[] }];
    expect(view.image.version).toBe(1);
    expect(view.image.vault).toBeUndefined();
    expect(view.copies.map(c => c.place)).toEqual(["default"]);
  });

  it("wsp image export refuses a record with no sign-ins to export, and says so rather than writing an empty file", async () => {
    env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const dest = join(dir, "image.wsp");
    const refused = await run("image", "export", dest);
    expect(refused.code).not.toBe(0);
    expect(refused.io.errors.at(-1)).toContain("sealed before its sign-ins were held");
    expect(existsSync(dest)).toBe(false);
  });

  it("wsp image export writes one file whose header parses and whose body the passphrase opens back to the vault", async () => {
    const tar = Buffer.from("the person's sign-ins as the seal took them");
    const record = RECORD(tar.length);
    await store.put("images", "default", record);
    await store.putBlob("image-vaults", "default@v1", tar);
    env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const dest = join(dir, "out", "image.wsp");
    const done = await run("image", "export", dest);
    expect(done.code).toBe(0);
    const bytes = readFileSync(dest);
    expect(JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8"))).toMatchObject({ format: "wsp-vault-1", to: "passphrase" });
    // A login the copy road put on the machine counts as held, as one signed in there does.
    expect((await run("image")).io.lines.join("\n")).toContain("1 sign-in held, 2 paths");
    const opened = passphraseCipher.open(bytes, "a-long-enough-passphrase");
    expect(opened.plain.equals(tar)).toBe(true);
    expect(opened.image).toEqual(record);
    expect(bytes.includes(tar)).toBe(false);
    expect(done.io.lines.at(-1)).toContain(dest);
  });

  it("wsp image export asks the passphrase twice at a terminal, and refuses when the second does not match", async () => {
    const tar = Buffer.from("the person's sign-ins as the seal took them");
    await store.put("images", "default", RECORD(tar.length));
    await store.putBlob("image-vaults", "default@v1", tar);
    const asks: string[] = [];
    const typed = async (...answers: string[]): Promise<{ code: number; io: Captured }> => {
      const io = captured();
      io.isTTY = true;
      io.askSecret = async q => {
        asks.push(q.split("\n")[0]!);
        return answers[asks.length - 1] ?? "";
      };
      return { code: await cli(["image", "export", join(dir, `${asks.length}-out.wsp`), "--state", statePath], io, undefined, env), io };
    };
    const mismatched = await typed("a-long-enough-passphrase", "a-different-passphrase");
    expect(mismatched.code).toBe(EXIT_CODES.usage);
    expect(asks).toEqual(["A passphrase for this export", "The same passphrase again"]);
    expect(mismatched.io.errors.at(-1)).toContain("the two passphrases are not the same");

    asks.length = 0;
    const short = await typed("short", "short");
    expect(short.code).toBe(EXIT_CODES.usage);
    expect(asks).toEqual(["A passphrase for this export"]);
    expect(short.io.errors.at(-1)).toContain(`${IMAGE_PASSPHRASE_MIN} characters at least`);

    asks.length = 0;
    const done = await typed("a-long-enough-passphrase", "a-long-enough-passphrase");
    expect(done.code).toBe(0);
    expect(asks).toEqual(["A passphrase for this export", "The same passphrase again"]);
  });

  it("wsp image export aimed at a host on another computer is answered here, and nothing of this computer's crosses to it", async () => {
    // A host this computer really holds, so the answer is the sentence and not the refusal for a name nobody knows.
    // The aim reads the home off the run's own environment, which this file hands every verb.
    env["WSP_HOME"] = join(dir, "home");
    writeHost(join(dir, "home"), "box", { url: "http://box.local:4400", deviceId: "d_box", deviceToken: "tok-box", pairedAt: "2026-09-11T10:00:00.000Z" });
    const dest = join(dir, "elsewhere.wsp");
    const line = `${hostSideOnlyLine("image export", "box")} ${hostSideOnlyFix(HOST_SIDE_VAULT)}`;
    // Every way a line is aimed reads the same: the flag, the variable, and the alias wsp hosts marks.
    const flagged = await run("image", "export", dest, "--host", "box");
    expect(flagged.code).toBe(EXIT_CODES.usage);
    expect(flagged.io.errors.at(-1)).toBe(line);

    env["WSP_HOST"] = "box";
    const named = await run("image", "export", dest);
    expect(named.code).toBe(EXIT_CODES.usage);
    expect(named.io.errors.at(-1)).toBe(line);
    delete env["WSP_HOST"];

    expect(existsSync(dest)).toBe(false);
    delete env["WSP_HOME"];
    // Only the export is held here: wsp image is a reading and answers against whichever host the line names.
    expect(CLI_VERBS.filter(v => "hostSide" in v && v.hostSide !== undefined).map(v => v.name)).toEqual(["image export"]);
  });

  it("wsp image export with nobody at the terminal and no passphrase in the environment refuses before anything is read", async () => {
    const refused = await run("image", "export", join(dir, "image.wsp"));
    expect(refused.code).toBe(EXIT_CODES.usage);
    expect(refused.io.errors.at(-1)).toContain(IMAGE_PASSPHRASE_ENV);
  });

  it("wsp image export refuses a passphrase under the minimum, and a destination that already holds something", async () => {
    env[IMAGE_PASSPHRASE_ENV] = "short";
    const tooShort = await run("image", "export", join(dir, "image.wsp"));
    expect(tooShort.code).toBe(EXIT_CODES.usage);
    expect(tooShort.io.errors.at(-1)).toContain(`${IMAGE_PASSPHRASE_MIN} characters at least`);

    const taken = join(dir, "taken.wsp");
    writeFileSync(taken, "mine");
    env[IMAGE_PASSPHRASE_ENV] = "a-long-enough-passphrase";
    const refused = await run("image", "export", taken);
    expect(refused.code).not.toBe(0);
    expect(readFileSync(taken, "utf8")).toBe("mine");
  });

  it("image move puts the workspace on the newest version, says up front what moves, and names the files of the image's own it kept", async () => {
    const sha = (c: string): string => c.repeat(64);
    const v1 = { ...head(SEALED_GOLDEN), owned: [{ path: ".zshrc", sha256: sha("1") }, { path: ".gitconfig", sha256: sha("2") }] };
    await store.put("goldens", copyKey("default", "default"), { head: 1, versions: [v1] });
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    // The fork rewrote its own gitconfig and left the image's zshrc as it was.
    backend.execImpl = (m, cmd) =>
      cmd.includes("xargs -0 -r sha256sum") ? { exitCode: 0, stdout: `${sha("1")}  .zshrc\n${sha("f")}  .gitconfig\n`, stderr: "" } : guestAnswer(cmd);
    await store.put("goldens", copyKey("default", "default"), {
      head: 2,
      versions: [v1, { ...v1, version: 2, snapshotId: "snap_gold2", owned: [{ path: ".zshrc", sha256: sha("9") }, { path: ".gitconfig", sha256: sha("2") }] }],
    });

    const moved = await run("image", "move", "alpha");
    expect(moved.io.errors).toEqual([IMAGE_MOVE_CONFIRM]);
    expect(moved.code).toBe(0);
    // Said once the workspace resolved, so a name nothing here holds hears the refusal alone.
    expect((await run("image", "move", "nope")).io.errors).toEqual(["wsp image move: no workspace nope"]);
    const after = await rt.workspaces.get(alpha!.id);
    expect(after).toMatchObject({ id: alpha!.id, name: "alpha", phase: "running", golden: "snap_gold2" });
    expect(moved.io.lines).toEqual([`alpha running on ${after.machineId}; ${imageKeptLine([".gitconfig"])}`]);

    // The answer says for itself whether a machine was replaced, so an agent reading the object never has to compare
    // the image it read a moment before against the one it got back.
    const asJson = await run("image", "move", "alpha", "--json");
    expect(json(asJson.io)).toEqual([{ workspace: expect.objectContaining({ golden: "snap_gold2" }), moved: false, kept: [] }]);
    // Nothing to move to now, and the line says that rather than claiming the image's files came across.
    const again = await run("image", "move", "alpha");
    expect(again.code).toBe(0);
    expect(again.io.lines).toEqual([`alpha running on ${after.machineId}; ${IMAGE_ALREADY_NEWEST}`]);
    const extra = await run("image", "move", "alpha", "beta");
    expect(extra.code).toBe(EXIT_CODES.usage);
    expect(extra.io.errors.at(-1)).toBe("wsp image move takes one workspace. usage: wsp image move <workspace>");
  });

  it("fork's help says it makes a new machine from the source's golden version, in wsp --help and wsp fork --help", async () => {
    const line = "a new machine from the source's golden version";
    expect(HELP).toContain(line);
    const { code, io } = await run("fork", "--help");
    expect(code).toBe(0);
    expect(io.lines[0]).toContain(line);
  });

  it("wsp --help names the screens of wsp init in order, as the wizard draws them, with no count since a screen with nothing to pick is not shown", () => {
    expect(HELP).not.toMatch(/(three|five|six) screens/);
    const init = HELP.slice(HELP.indexOf("  wsp init "), HELP.indexOf("  wsp doctor ")).replace(/\s+/g, " ");
    expect(init).toContain("one screen at a time: Agents, Tools, Also on this computer, Sign-ins, wsp for your agents on this computer, each shown when it has a row to pick, then Build");
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
    expect(short.io.errors).toEqual(["wsp rename takes a workspace and one name. usage: wsp rename <workspace> \"<name>\""]);
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
    expect(asked).toEqual(["Forget alpha?\nIts record and 1 thread leave this computer; the computer it ran on is already gone."]);
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

  it("the delete question and its line say what the delete does to this kind's machine, the ssh sweep included", () => {
    const workspace = { id: "ws_mine", name: "box", machineId: "ssh://dev@box:22", phase: "running", kind: "ssh", golden: "", createdAt: "2026-09-08T00:00:00.000Z" } as const;
    // What wsp put on a machine somebody owns comes off with the record; the machine is theirs and stays.
    expect(deleteQuestion({ workspace, threads: 1 })).toBe(
      "Delete box?\nIts daemon, its unit and its login line come off the machine, which is otherwise left as it is; its record and 1 thread leave this computer.",
    );
    expect(deletedLine({ workspace, threads: 1 })).toBe(
      "deleted box ws_mine: its daemon, its unit and its login line come off the machine, which is otherwise left as it is, and its record and 1 thread are gone from this computer",
    );
    // This computer took no daemon of wsp's and no line in a login file, so nothing comes off it.
    const here = { ...workspace, kind: "local", machineId: "local" } as const;
    expect(deleteQuestion({ workspace: here, threads: 1 })).toBe("Delete box?\nIts machine is left as it is; its record and 1 thread leave this computer.");
    expect(deletedLine({ workspace: here, threads: 1 })).toBe("deleted box ws_mine: its machine is left as it is, and its record and 1 thread are gone from this computer");
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
    expect(await cli(["thread", "new", "--in", "alpha", "look around", "--state", statePath], io, undefined, env)).toBe(0);
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
    expect(refused.io.errors).toEqual(['wsp thread new: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
    expect((await rt.workspaces.list())[0]!.phase).toBe("napping");
    expect(await rt.sessions.list()).toHaveLength(1);
  });

  it("fork --send under an agent the host has no adapter for is refused naming the agents it has, and no machine is minted", async () => {
    await run("new", "alpha");
    const refused = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--agent", "gemini");
    expect(refused.code).toBe(3);
    expect(refused.io.errors).toEqual(['wsp fork: no adapter registered for harness "gemini"; agents on this host: claude, codex. Name one of those with --agent.']);
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
      expect(opened.io.errors).toEqual([`wsp thread new: ${EMPTY_TASK_LINE}. Put it in quotes after the flags.`]);
      const forked = await run("fork", "alpha", "--name", "worker", "--send", task);
      expect(forked.code).toBe(3);
      expect(forked.io.errors).toEqual([`wsp fork: ${EMPTY_TASK_LINE}. Put it in quotes after the flags.`]);
      const sent = await run("send", row!.threadId!, task);
      expect(sent.code).toBe(3);
      expect(sent.io.errors).toEqual([`wsp send: ${EMPTY_TASK_LINE}. Put it in quotes after the flags.`]);
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

  it("a turn the agent refused for want of a sign-in reads failed, exits with the auth code and says the refusal once, on the command line and in the read alike", async () => {
    const refusal = `Not logged in · Please run /login; ${signInRefusalLine({ kind: "local" })}`;
    await restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 88, costUsd: 0, error: refusal, refusal: "sign-in" }) });
    await run("new", "alpha");

    const { code, io } = await run("thread", "new", "--in", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.auth);
    expect(io.lines).toEqual([expect.stringMatching(/^thread /)]);
    expect(io.streamed.split("\n").filter(l => l !== "")).toEqual(["failed · Worked for 88ms · $0.0000"]);
    expect(io.errors).toEqual([`wsp thread new: ${refusal}`]);

    const [row] = await rt.sessions.list();
    const read = await run("thread", "read", row!.threadId!);
    expect(read.code).toBe(0);
    expect(read.io.lines.join("\n")).toContain(`failed · Worked for 88ms · $0.0000: ${refusal}`);
    expect(read.io.lines.join("\n").split("Not logged in")).toHaveLength(2);
  });

  it("a refusal the agent named no cause for exits the provider code, so the auth code says a sign-in and nothing else", async () => {
    await restartHost({ claude: toolingAgent([], { status: "failed", durationMs: 40, error: "API Error: 529 overloaded" }) });
    await run("new", "alpha");

    const { code, io } = await run("thread", "new", "--in", "alpha", "say hi");
    expect(code).toBe(EXIT_CODES.provider);
    expect(io.errors).toEqual(["wsp thread new: API Error: 529 overloaded"]);

    const asJson = await run("thread", "new", "--in", "alpha", "again", "--json");
    expect(asJson.code).toBe(EXIT_CODES.provider);
    expect(JSON.parse(asJson.io.errors.at(-1)!)).toMatchObject({ class: "provider", exit: EXIT_CODES.provider });
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

  it("thread forget drops the row a launch that never got going left, and refuses a thread whose turn did work and a row from before threads", async () => {
    const agent = bornDeadAgent(prompt => `re: ${prompt}`);
    await restartHost({ claude: agent.adapter });
    await run("new", "alpha");
    const dead = await run("thread", "new", "--in", "alpha", "hello");
    expect(dead.code).toBe(1);
    expect(dead.io.errors).toEqual([`wsp thread new: ${UNREACHED_LINE}`]);
    const junk = (await rt.sessions.list())[0]!.threadId!;
    expect((await run("threads")).io.lines[0]).toContain(junk);

    const forgot = await run("thread", "forget", junk.slice(0, 8));
    expect(forgot.code).toBe(0);
    expect(forgot.io.lines).toEqual([`forgot thread ${junk}: no turn ever ran on it, so nothing of its work is gone`]);
    expect((await run("threads")).io.lines[0]).not.toContain(junk);
    expect(await rt.sessions.list()).toEqual([]);

    // The next launch works, so its thread is one a turn ran on: the runtime's own sentence comes back.
    await run("thread", "new", "--in", "alpha", "build it");
    const ran = (await rt.sessions.list())[0]!.threadId!;
    const refused = await run("thread", "forget", ran);
    expect(refused.code).toBe(1);
    expect(refused.io.errors).toEqual([`wsp thread forget: ${threadForgetRefusal(ran)}`]);
    expect((await rt.sessions.list()).map(r => r.threadId)).toEqual([ran]);

    const missing = await run("thread", "forget", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp thread forget: no thread nope"]);
    // A turn from before threads folds under its own id and no thread here answers to it; the verb says that
    // rather than dialling for a thread nobody has, which is the guard the app's row makes.
    const alpha = (await rt.workspaces.list())[0]!.id;
    await store.put("sessions", alpha, { workspaceId: alpha, sessions: [{ id: "s_old", workspaceId: alpha, harness: "claude", status: "failed", prompt: "from before threads" }] });
    await restartHost({ claude: agent.adapter });
    const before = await run("thread", "forget", "s_old");
    expect(before.code).toBe(1);
    expect(before.io.errors).toEqual([`wsp thread forget: ${threadWithoutIdRefusal("s_old")}`]);
    const none = await run("thread", "forget");
    expect(none.code).toBe(3);
    expect(none.io.errors).toEqual(["wsp thread forget takes one thread. usage: wsp thread forget <thread>"]);
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

  it("thread new --project starts the thread in that project's folder and is remembered as the workspace's last; --cwd wins over it; a name the workspace lacks is refused before the machine is woken or anything starts", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/spoo", dest: "/root/spoo", bundler: projectBundler() });
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/wsp", dest: "/root/wsp", bundler: projectBundler() });
    const named = await run("thread", "new", "--in", "alpha", "--project", "wsp", "build it");
    expect(named.code).toBe(0);
    expect(named.io.errors).toEqual([]);
    expect(claude.starts.map(s => s.cwd)).toEqual(["/root/wsp"]);
    const both = await run("thread", "new", "--in", "alpha", "--project", "wsp", "--cwd", "/root/elsewhere", "build it");
    expect(both.code).toBe(0);
    expect(claude.starts.at(-1)!.cwd).toBe("/root/elsewhere");
    // The project the last thread landed in is where the next one starts, the same memory the composer's pick writes.
    const remembered = await run("thread", "new", "--in", "alpha", "again");
    expect(remembered.code).toBe(0);
    expect(claude.starts.at(-1)!.cwd).toBe("/root/wsp");
    expect((await rt.preferences.get()).project).toEqual({ [alpha!.id]: "wsp" });

    await rt.workspaces.nap(alpha!.id);
    const projects = (await rt.workspaces.get(alpha!.id)).projects!;
    const missing = await run("thread", "new", "--in", "alpha", "--project", "nope", "build it");
    expect(missing.code).toBe(3);
    expect(missing.io.errors).toEqual([`wsp thread new: ${noProjectLine("nope", projects)}. Run wsp projects <workspace> to read the names it holds.`]);
    expect((await rt.workspaces.get(alpha!.id)).phase).toBe("napping");
    expect(claude.starts).toHaveLength(3);
  });

  it("thread new with no --in, run from inside a registered repo, starts on the workspace that project last ran on and says so on the first line; outside a repo, or in one no workspace holds, it is refused in one line and nothing starts", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const [alpha, beta] = await rt.workspaces.list();
    for (const ws of [alpha!, beta!]) await rt.projects.import({ workspaceId: ws.id, source: "/Users/dev/spoo", dest: "/root/spoo", bundler: projectBundler() });
    // The repo on this computer: its git root is what is matched, from anywhere inside it.
    const repo = join(dir, "code", "spoo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "packages", "api"), { recursive: true });
    const cwd = vi.spyOn(process, "cwd");
    // beta is where a thread last ran in spoo, so that is where the run goes.
    await run("thread", "new", "--in", "beta", "--project", "spoo", "warm up");
    cwd.mockReturnValue(join(repo, "packages", "api"));
    const inferred = await run("thread", "new", "hello from the repo");
    expect(inferred.io.errors).toEqual([]);
    expect(inferred.code).toBe(0);
    const threads = await rt.sessions.list();
    const opened = threads.find(t => t.prompt === "hello from the repo")!;
    expect(opened.workspaceId).toBe(beta!.id);
    expect(inferred.io.lines[0]).toBe(threadOpenedLine(opened.threadId!, "beta", "~/spoo"));
    expect(inferred.io.lines).toEqual([inferred.io.lines[0], "re: hello from the repo"]);
    expect(claude.starts.at(-1)!.cwd).toBe("/root/spoo");
    expect(inferred.io.errors).toEqual([]);
    // --in still wins over the folder the run is in.
    const named = await run("thread", "new", "--in", "alpha", "named anyway");
    expect(named.code).toBe(0);
    expect((await rt.sessions.list()).find(t => t.prompt === "named anyway")!.workspaceId).toBe(alpha!.id);
    expect(named.io.lines).toEqual([expect.stringMatching(/^thread [0-9a-f-]{36}$/), "re: named anyway"]);

    const before = (await rt.sessions.list()).length;
    const other = join(dir, "code", "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    cwd.mockReturnValue(other);
    const unheld = await run("thread", "new", "nowhere to go");
    expect(unheld.code).toBe(1);
    expect(unheld.io.errors).toEqual([`wsp thread new: ${noWorkspaceForFolderLine(other, "--in <workspace>")}`]);
    cwd.mockReturnValue(join(dir, "code"));
    const noRepo = await run("thread", "new", "nowhere to go");
    expect(noRepo.code).toBe(EXIT_CODES.usage);
    expect(noRepo.io.errors[0]).toContain(noThreadTargetLine("--in <workspace>"));
    expect((await rt.sessions.list()).length).toBe(before);
    cwd.mockRestore();
  });

  it("projects lists a workspace's projects, name, folder, size and import date, oldest first, and workspaces carries the count", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const [alpha] = await rt.workspaces.list();
    const none = await run("projects", "alpha");
    expect(none.code).toBe(0);
    expect(none.io.lines).toEqual(["alpha has no projects; wsp import <folder> --to 'alpha' lands one"]);
    expect(json((await run("projects", "alpha", "--json")).io)).toEqual([{ projects: [] }]);

    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/spoo", dest: "/root/spoo", bundler: projectBundler() });
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/wsp", dest: "/root/wsp", bundler: projectBundler() });
    const listed = await run("projects", "alpha");
    expect(listed.code).toBe(0);
    expect(listed.io.errors).toEqual([]);
    const [heading, ...rows] = listed.io.lines[0]!.split("\n");
    expect(heading!.split(/ {2,}/)).toEqual(["PROJECT", "FOLDER", "SIZE", "IMPORTED"]);
    const today = new Date().toISOString().slice(0, 10);
    expect(rows.map(r => r.split(/ {2,}/))).toEqual([["spoo", "/root/spoo", "20 B", today], ["wsp", "/root/wsp", "20 B", today]]);
    const raw = await run("projects", alpha!.id, "--json");
    expect(json(raw.io)).toEqual([{ projects: [expect.objectContaining({ name: "spoo", dest: "/root/spoo", size: 20 }), expect.objectContaining({ name: "wsp", dest: "/root/wsp", size: 20 })] }]);

    const workspaces = await run("workspaces");
    const table = workspaces.io.lines[0]!.split("\n").slice(1).map(r => r.split(/ {2,}/));
    expect(table).toEqual([
      ["alpha", expect.stringMatching(/^ws_/), expect.stringMatching(/^m\d+$/), "Running", "2"],
      ["beta", expect.stringMatching(/^ws_/), expect.stringMatching(/^m\d+$/), "Running"],
    ]);
    const unknown = await run("projects", "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.io.errors).toEqual(["wsp projects: no workspace nope"]);
    const bare = await run("projects");
    expect(bare.code).toBe(3);
    expect(bare.io.errors[0]).toMatch(/^wsp projects takes one workspace/);
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
    expect(model.io.errors).toEqual(['wsp thread new: model "claude-haiku-4-5" is not one claude takes; one of: Fable 5.1 (claude-fable-5-1), Opus 5 (claude-opus-5), Sonnet 5 (claude-sonnet-5). Drop the flag, or give it a value the agent offers.']);
    const effort = await run("thread", "new", "--in", "alpha", "--effort", "ultra", "review it");
    expect(effort.code).toBe(3);
    expect(effort.io.errors).toEqual(['wsp thread new: effort "ultra" is not one claude takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max). Drop the flag, or give it a value the agent offers.']);
    const access = await run("fork", "alpha", "--send", "build it", "--access", "yolo");
    expect(access.code).toBe(3);
    expect(access.io.errors[0]).toMatch(/^wsp fork: access mode "yolo" is not one claude takes; one of: Default \(default\), Accept edits \(acceptEdits\), /);
    // Checked against the table before the fork is minted, for the named agent or the default one.
    const other = await run("fork", "alpha", "--send", "build it", "--agent", "codex", "--effort", "minimal");
    expect(other.code).toBe(3);
    expect(other.io.errors).toEqual([
      'wsp fork: effort "minimal" is not one GPT-5.6-Sol takes; one of: Low (low), Medium (medium), High (high), Extra high (xhigh), Max (max), Ultra (ultra). Drop the flag, or give it a value the agent offers.',
    ]);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
    expect(claude.starts).toEqual([]);
    expect(codex.starts).toEqual([]);
    expect(await rt.sessions.list()).toEqual([]);
    const dangling = await run("fork", "alpha", "--model", "claude-sonnet-5");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --model says how a thread opens, and this line opens none. Add --send "<task>", or drop --model.']);
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
    expect(forked.io.errors).toEqual(['wsp fork: model "gpt-5.5" is not one codex takes; one of: anthropic/claude-sonnet-4.5 (anthropic/claude-sonnet-4.5). Drop the flag, or give it a value the agent offers.']);
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);
  });

  it("a --cwd that is not absolute is refused with the usage line before anything is created, started or dialled; fork's --cwd needs --send", async () => {
    await run("new", "alpha");
    const relative = await run("thread", "new", "--in", "alpha", "--cwd", "packages/host", "look here");
    expect(relative.code).toBe(3);
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: wsp thread new [--in <workspace>] [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, --title, --image <path>, --detach] "<task>"']);
    const forked = await run("fork", "alpha", "--send", "build it", "--cwd", "packages/host");
    expect(forked.code).toBe(3);
    expect(forked.io.errors[0]).toMatch(/^--cwd is a path on the machine, absolute, and got "packages\/host"\..* usage: wsp fork /);
    const dangling = await run("fork", "alpha", "--cwd", "/root/work");
    expect(dangling.code).toBe(3);
    expect(dangling.io.errors).toEqual(['wsp fork: --cwd says how a thread opens, and this line opens none. Add --send "<task>", or drop --cwd.']);
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
    expect(short.io.errors).toEqual(["wsp thread rename takes a thread and one name. usage: wsp thread rename <thread> \"<title>\""]);
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

  it("--notify me run inside a turn names that turn's thread: the command line reads the token off the environment it runs with, and the parent is steered the child's report whole", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const parent = run("thread", "new", "--in", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    // The environment the host launched that turn under is the one a wsp inside it would run with.
    const token = held.envs[0]![TURN_TOKEN_ENV]!;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    env[TURN_TOKEN_ENV] = token;
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

  // The one command line that reads the process's own environment is the one a person runs: every case here hands
  // its environment in, so without this case a refactor could take TURN_TOKEN_ENV away from the real command line and
  // nothing would say so. It sets the variable it reads, in its own process, which is what the environment law asks.
  it("cli called with no environment of its own reads this process's, which is what a shell gives it", async () => {
    const held = heldAgent(true);
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const parent = run("thread", "new", "--in", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const [parentRow] = await rt.sessions.list();
    vi.stubEnv(TURN_TOKEN_ENV, held.envs[0]![TURN_TOKEN_ENV]!);
    // No fourth argument: the default, which is this process's environment and nothing the case handed in.
    const io = captured();
    const kid = cli(["thread", "new", "--in", "alpha", "--notify", "me", "build it", "--state", statePath], io);
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const kidRow = (await rt.sessions.list()).find(r => r.threadId !== parentRow!.threadId)!;
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
    await restartHost({ claude: held.adapter });
    await run("new", "alpha");
    const orchestrator = run("thread", "new", "--in", "alpha", "orchestrate the builders");
    await vi.waitFor(() => expect(held.starts).toHaveLength(1));
    const reviewer = run("thread", "new", "--in", "alpha", "review what lands");
    await vi.waitFor(() => expect(held.starts).toHaveLength(2));
    const rows = await rt.sessions.list();
    const [leadRow, reviewRow] = rows;
    env[TURN_TOKEN_ENV] = held.envs[0]![TURN_TOKEN_ENV]!;
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
    expect(env[TURN_TOKEN_ENV]).toBeUndefined();
    const { code, io } = await run("thread", "new", "--in", "alpha", "--notify", "me", "build it");
    expect(code).toBe(0);
    const [row] = await rt.sessions.list();
    expect(io.errors).toEqual([`thread ${row!.threadId!.slice(0, 8)} finished (completed): re: build it`]);
    const [alpha] = await rt.workspaces.list();
    expect((await rt.sessions.history(alpha!.id)).find(e => e.type === "session.notify")).toMatchObject({ notify: "me" });
  });

  it("a token no turn on this host carries is refused, and nothing starts", async () => {
    await run("new", "alpha");
    env[TURN_TOKEN_ENV] = "f".repeat(32);
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
    expect(soon.io.errors[0]).toContain('--timeout takes seconds, a number above zero, and got "soon".');
    const missing = await run("threads", "wait", a!.threadId!, "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp threads wait: no thread nope"]);
    const stray = await run("threads", "nope");
    expect(stray.code).toBe(3);
    expect(stray.io.errors[0]).toContain("wsp threads takes no positional arguments; wsp threads wait is its one subcommand");
  });

  it("threads wait on a thread whose first turn has not reached the machine blocks for that turn; the same thread once its turn is over comes back at once with its finished line", async () => {
    const held = heldAgent(false);
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    // The harness's own lists come off the machine before the turn is launched: seconds on a real machine, and the
    // window this case is about.
    await restartHost({ claude: ctx => ({ ...held.adapter(ctx), probeCatalog: async () => (await probed, null) }) });
    await run("new", "alpha");
    const [ws] = await rt.workspaces.list();
    const starting = rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await rt.sessions.list())[0]!.threadId!;
    expect(held.starts).toHaveLength(0);

    let answered = false;
    const waiting = run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
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

    const again = await run("threads", "wait", thread);
    expect(again.io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);

    // A thread whose launch never reached the machine has no turn and never will; the wait answers at once for it too.
    await restartHost({ claude: bornDeadAgent(prompt => `re: ${prompt}`).adapter });
    await run("thread", "new", "--in", "alpha", "--detach", "never lands");
    const stillborn = (await rt.sessions.list()).find(r => r.prompt === "never lands")!;
    const atOnce = await run("threads", "wait", stillborn.threadId!);
    expect(atOnce.code).toBe(0);
    expect(atOnce.io.lines).toEqual([`thread ${stillborn.threadId!.slice(0, 8)} finished (failed): ${UNREACHED_LINE}`]);
  });

  it("a wait in flight on a thread whose launch gives up gets that thread's finished line, with the reason the start failed with", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    const WOULD_NOT_LAUNCH = "the agent binary is not on this machine";
    await restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error(WOULD_NOT_LAUNCH);
        },
      }),
    });
    await run("new", "alpha");
    const [ws] = await rt.workspaces.list();
    const giving = rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await rt.sessions.list())[0]!.threadId!;

    let answered = false;
    const waiting = run("threads", "wait", thread, "--timeout", "3600").then(r => ((answered = true), r));
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
    expect(await threadRows(await dialHost(statePath))).toEqual([]);
    const later = await run("threads", "wait", thread);
    expect(later.code).toBe(1);
    expect(later.io.errors).toEqual([`wsp threads wait: no thread ${thread}`]);
  });

  it("a wait whose thread gives up between naming it and subscribing to it answers finished (failed) at once: a named thread with no row on the second read is over", async () => {
    let letProbe!: () => void;
    const probed = new Promise<void>(r => (letProbe = r));
    await restartHost({
      claude: () => ({
        steers: false,
        probeCatalog: async () => (await probed, null),
        start: () => {
          throw new Error("the agent binary is not on this machine");
        },
      }),
    });
    await run("new", "alpha");
    const [ws] = await rt.workspaces.list();
    const giving = rt.sessions.start(ws!.id, { prompt: "build it", startedBy: "cli" });
    await vi.waitFor(async () => expect(await rt.sessions.list()).toHaveLength(1), { timeout: 10_000, interval: 10 });
    const thread = (await rt.sessions.list())[0]!.threadId!;
    const client = await dialHost(statePath);
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
    await restartHost({
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
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "--detach", "build it");
    const thread = (await rt.sessions.list())[0]!.threadId!;
    held.release(0, "the build is green\nall green");
    await vi.waitFor(async () => expect((await rt.sessions.list())[0]!.status).toBe("completed"), { timeout: 10_000, interval: 10 });

    const [ws] = await rt.workspaces.list();
    await expect(rt.sessions.start(ws!.id, { prompt: "and then this", thread })).rejects.toThrow("the harness would not launch");

    // One fact, how the thread's last turn went, and every door still gives the same answer.
    const listed = await threadRows(await dialHost(statePath));
    expect(listed.map(t => [t.id, t.status, t.turns])).toEqual([[thread, "completed", 1]]);
    expect((await run("thread", "read", thread, "--last")).io.lines[0]).toContain("the build is green\nall green");
    expect((await run("thread", "read", thread)).io.lines[0]).toContain("the build is green\nall green");
    expect((await run("threads", "wait", thread)).io.lines).toEqual([`thread ${thread.slice(0, 8)} finished (completed): all green`]);
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

  it("thread read prints the thread's messages as the app lists them, one line per tool call, --last the whole final message alone, and a thread that has not replied says so", async () => {
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "build it");
    const [row] = await rt.sessions.list();
    const id = row!.threadId!;
    const read = await run("thread", "read", id.slice(0, 8));
    expect(read.code).toBe(0);
    expect(read.io.errors).toEqual([]);
    const blocks = read.io.lines[0]!.split("\n\n").map(block => block.split("\n"));
    // Who spoke and the clock head each block; the text of the block is what was said.
    expect(blocks.map(block => block[0])).toEqual(["person", "agent", "tool", "agent", "turn"].map(who => expect.stringMatching(new RegExp(`^${who} \\d\\d:\\d\\d:\\d\\d$`))));
    expect(blocks.map(block => block.slice(1).join("\n"))).toEqual(["build it", "re: ", "$ ls", "build it", "completed"]);
    // The events the app reads are the events this read folded: nothing on the machine was asked for it.
    expect(launchedScripts(backend).filter(script => script.includes("sessions"))).toEqual([]);

    const last = await run("thread", "read", id, "--last", "--json");
    expect(json(last.io)).toEqual([{ threadId: id, messages: [{ who: "agent", at: expect.any(Number), text: "re: build it" }] }]);
    // The whole final message is the one the finished line carries, so a read of the reply and a wait on it agree.
    expect(notifyLine(id, { status: "completed", text: "re: build it" }, "whole")).toContain("re: build it");

    const held = heldAgent(false);
    await restartHost({ claude: held.adapter });
    await run("thread", "new", "--in", "alpha", "--detach", "hold on");
    const pending = (await rt.sessions.list()).find(session => session.prompt === "hold on")!;
    const nothing = await run("thread", "read", pending.threadId!, "--last");
    expect(nothing.code).toBe(0);
    expect(nothing.io.lines).toEqual([noReplyLine(pending.threadId!)]);
    const running = await run("thread", "read", pending.threadId!, "--json");
    expect(json(running.io)).toEqual([{ threadId: pending.threadId, messages: [{ who: "person", at: expect.any(Number), text: "hold on" }] }]);
    held.release(0, "held no longer");

    const none = await run("thread", "read");
    expect(none.code).toBe(3);
    expect(none.io.errors[0]).toContain("wsp thread read takes one thread");
    const missing = await run("thread", "read", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp thread read: no thread nope"]);
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
    expect(bare.io.errors).toEqual(["wsp exec takes a workspace, then -- and the command. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>"]);
  });

  describe("one list behind every verb", () => {
    /** The workspace a thread of this host's runs on, its agents allowed to spawn. */
    async function leadWorkspace(): Promise<WorkspaceView> {
      await run("new", "alpha", "--spawn", "on");
      return (await rt.workspaces.list()).find(w => w.name === "alpha")!;
    }
    /** What a turn's launch hands the thread running on that workspace: the address of this host and a token scoped
     * to the thread, which is the pair a wsp line inside a turn dials with. Every line after this runs as that thread. */
    async function asThread(workspace: WorkspaceView, threadId: string): Promise<void> {
      const scoped = await rt.devices.mint(`thread ${threadId}`, { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId }, Date.now());
      env[HOST_URL_ENV] = `ws://127.0.0.1:${handle!.wsPort}`;
      env[HOST_TOKEN_ENV] = scoped.deviceToken;
    }
    /** A line as that thread types it: no --state, since the pair in its environment says which host it runs against. */
    async function line(...argv: string[]): Promise<{ code: number; io: Captured }> {
      const io = captured();
      return { code: await cli(argv, io, undefined, env), io };
    }

    it("every verb takes the workspaces the caller's own listing prints, by name and by id", async () => {
      const alpha = await leadWorkspace();
      await run("thread", "new", "--in", "alpha", "hello");
      const [row] = await rt.sessions.list();
      await asThread(alpha, "t_lead");
      expect(names(await line("workspaces"))).toEqual(["alpha"]);
      execGuest(backend, "Linux\n", 0);
      expect((await line("exec", "alpha", "--", "uname")).io.lines).toEqual(["Linux"]);
      expect((await line("exec", alpha.id, "--", "uname")).io.lines).toEqual(["Linux"]);
      expect((await line("threads", "--in", "alpha")).code).toBe(0);
      expect((await line("send", row!.threadId!, "and the rest")).code).toBe(0);
    });

    it("a workspace the caller's reach hides is refused by the rule that hides it, never as one that does not exist", async () => {
      const alpha = await leadWorkspace();
      await run("new", "beta");
      const beta = (await rt.workspaces.list()).find(w => w.name === "beta")!;
      await asThread(alpha, "t_lead");
      const hidden = spawnReachRefusal("t_lead", "beta");
      // The listing leaves beta out; every verb that takes a name says why it is not there rather than that it is not.
      expect(names(await line("workspaces"))).toEqual(["alpha"]);
      expect((await line("exec", "beta", "--", "uname")).io.errors).toEqual([`wsp exec: ${hidden}`]);
      expect((await line("exec", beta.id, "--", "uname")).io.errors).toEqual([`wsp exec: ${hidden}`]);
      expect((await line("threads", "--in", "beta")).io.errors).toEqual([`wsp threads: ${hidden}`]);
      // A name nothing here carries is still absent, which is the one thing that sentence says.
      expect((await line("exec", "gamma", "--", "uname")).io.errors).toEqual([`wsp exec: ${noWorkspaceRefusal("gamma")}`]);
    });
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
    expect(relative.io.errors).toEqual(['--cwd is a path on the machine, absolute, and got "packages/host". Give a path that opens with /, since whoever reads it works in a folder this line cannot see. usage: wsp exec <workspace> [--cwd <dir>] -- <command...>']);
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
        await expect(dialHost(statePath, { deadlineMs: 200 })).rejects.toThrow(`the host at 127.0.0.1:${wsPort} did not answer: nothing came back within 200 ms`);
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
    expect(golden).toMatchObject({ projects: [{ name: "proj", dest: "/root/work/proj" }], golden: "snap_gold", version: 1, workspaceId: alpha!.id, workspaceName: "alpha" });
    expect(io.lines).toEqual([`project golden ${golden!.snapshotId}: golden v1 plus proj imported ${golden!.projects[0]!.importedAt.slice(0, 10)}, taken from alpha\nfork it with: wsp new <name> --from proj`]);
    expect(io.errors).toEqual([]);

    const asJson = await run("snapshot", alpha!.id, "--json");
    expect(asJson.code).toBe(0);
    expect(json(asJson.io)).toEqual([{ projectGolden: expect.objectContaining({ projects: golden!.projects, golden: "snap_gold" }) }]);

    await rt.workspaces.nap(alpha!.id);
    await rt.workspaces.wake(alpha!.id);
    const resumed = await run("snapshot", "alpha");
    expect(resumed.code).toBe(1);
    expect(resumed.io.errors).toHaveLength(1);
    expect(resumed.io.errors[0]).toMatch(/^wsp snapshot: snapshot \S+ refused: machine m\d+ is not first-life/);
    expect(await rt.golden.projects()).toHaveLength(2);
  });

  it("new --from forks a project golden by any project name it carries (the newest) or snapshot id, says what the fork gets, and names what it cannot find", async () => {
    await run("new", "alpha");
    const [alpha] = await rt.workspaces.list();
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/proj", dest: "/root/work/proj", bundler: projectBundler() });
    const first = await rt.workspaces.snapshot(alpha!.id);
    await new Promise(r => setTimeout(r, 2));
    await rt.projects.import({ workspaceId: alpha!.id, source: "/Users/dev/spoo", dest: "/root/spoo", bundler: projectBundler() });
    const second = await rt.workspaces.snapshot(alpha!.id);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.projects.map(p => p.name)).toEqual(["proj", "spoo"]);

    const byName = await run("new", "task-a", "--from", "proj");
    expect(byName.code).toBe(0);
    const taskA = (await rt.workspaces.list()).find(w => w.name === "task-a")!;
    expect(taskA).toMatchObject({ golden: second.snapshotId, projects: second.projects });
    expect(byName.io.lines).toEqual([`created task-a ${taskA.id} with proj, spoo in place`]);

    const byId = await run("new", "task-b", "--from", first.snapshotId);
    expect(byId.code).toBe(0);
    const taskB = (await rt.workspaces.list()).find(w => w.name === "task-b")!;
    expect(taskB).toMatchObject({ golden: first.snapshotId, projects: first.projects });
    expect(byId.io.lines).toEqual([`created task-b ${taskB.id} with proj in place`]);
    // A name only the newer golden carries finds it too.
    const bySecondName = await run("new", "task-d", "--from", "spoo");
    expect(bySecondName.code).toBe(0);
    expect((await rt.workspaces.list()).find(w => w.name === "task-d")).toMatchObject({ golden: second.snapshotId });

    const missing = await run("new", "task-c", "--from", "nope");
    expect(missing.code).toBe(1);
    expect(missing.io.errors).toEqual(["wsp new: no project golden named nope; wsp snapshot <workspace> takes one"]);
    expect((await rt.workspaces.list()).map(w => w.name).sort()).toEqual(["alpha", "task-a", "task-b", "task-d"]);
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

  it("import with no --to goes to the workspace the last thread started on and says so; before any thread it is refused in one line", async () => {
    const proj = projectFolder();
    const none = await run("import", proj, "--yes");
    expect(none.code).toBe(EXIT_CODES.usage);
    expect(none.io.errors[0]).toContain(noLastTargetLine("--to <workspace>"));
    await run("new", "alpha");
    await run("new", "beta");
    await run("thread", "new", "--in", "beta", "warm up");
    const [, beta] = await rt.workspaces.list();
    const { code, io } = await run("import", proj, "--yes");
    expect(code).toBe(0);
    expect(io.errors).toEqual([lastTargetLine("beta")]);
    expect((await rt.workspaces.get(beta!.id)).projects?.map(p => p.name)).toEqual(["proj"]);
    expect(landings()).toHaveLength(0);
    expect(backend.machines.find(m => m.id === beta!.machineId)!.runLog.some(s => s.includes("mv "))).toBe(true);
  });

  it("the last target is resolved through the host, so one this caller may not drive is refused in that rule's words and never read as no target", async () => {
    const ops: string[] = [];
    /** A host that holds a last target and answers for that id however this case wants, and that has no listing to
     * scan: a caller that reached for one here is asking the wrong door. */
    const holding = (answer: Record<string, unknown> | Error): HostClient => ({
      request: async (op: string) => {
        ops.push(op);
        if (op === "preferences.get") return { preferences: { ...DEFAULT_PREFERENCES, target: { workspace: "ws_beta" } } } as never;
        if (op !== "workspaces.resolve") throw new Error(`the last target asked this host for ${op}`);
        if (answer instanceof Error) throw answer;
        return answer as never;
      },
      events: async () => {},
      onFrame: () => () => {},
      closed: new Promise<void>(() => {}),
      closeWords: () => "closed",
      close: () => {},
      terminate: () => {},
    });
    const said: string[] = [];
    const hidden = spawnReachRefusal("t_lead", "beta");
    await expect(lastTarget(holding(new Error(hidden)), "--to <workspace>", l => said.push(l))).rejects.toThrow(hidden);
    // Only a target this host no longer holds at all is no last target.
    await expect(lastTarget(holding(new Error(noWorkspaceRefusal("ws_beta"))), "--to <workspace>", l => said.push(l))).rejects.toThrow(noLastTargetLine("--to <workspace>"));
    expect(said).toEqual([]);
    const beta = { id: "ws_beta", name: "beta", machineId: "m1", phase: "running", kind: "cloud", golden: "snap_g", createdAt: "2026-09-12T00:00:00.000Z" };
    expect((await lastTarget(holding({ workspace: beta }), "--to <workspace>", l => said.push(l))).name).toBe("beta");
    expect(said).toEqual([lastTargetLine("beta")]);
    expect([...new Set(ops)]).toEqual(["preferences.get", "workspaces.resolve"]);
  });

  it("import --to this computer registers the folder at its own path with no plan, no question and no copy, says so, and projects lists it", async () => {
    await run("new", "--local", "mac");
    const proj = projectFolder();
    const { code, io } = await run("import", proj, "--to", "mac");
    expect(code).toBe(0);
    expect(io.streamed).toBe(`${REGISTERING_LINE}\n`);
    expect(io.lines).toEqual([registeredLine(proj)]);
    expect(io.errors).toEqual([]);
    expect(asked).toEqual([]);
    const [mac] = await rt.workspaces.list();
    expect(mac!.projects).toEqual([{ name: "proj", dest: proj, importedAt: expect.any(String), size: expect.any(Number) }]);
    const listed = await run("projects", "mac");
    expect(listed.io.lines[0]!.split("\n")[1]!.split(/ {2,}/)[0]).toBe("proj");
    // The consent flags mean nothing where nothing is carried, so they are refused rather than swallowed.
    const kept = await run("import", proj, "--to", "mac", "--keep", ".env", "--agents", "claude");
    expect(kept.code).toBe(EXIT_CODES.usage);
    expect(kept.io.errors[0]).toContain(registerTakesNoConsentLine(["--keep", "--agents"]));
    expect(mac!.projects).toHaveLength(1);
    // --json prints what landed alone: there was no plan to print first.
    const raw = await run("import", proj, "--to", "mac", "--json");
    expect(raw.code).toBe(0);
    expect(json(raw.io)).toEqual([{ imported: expect.objectContaining({ dest: proj, parts: 0, cut: [], agents: [] }) }]);
  });

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
    expect(sepia.io.errors).toEqual(['wsp terminal config: --scheme takes one of light, dark, and got "sepia". Name one of those.']);
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
      return { code: await cli(["import", proj, "--to", "alpha", "--state", statePath], io, undefined, env), io };
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
    expect(ws!.projects).toEqual([{ name: "proj", dest: real, importedAt: expect.any(String), size: 20 }]);

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
    expect(bad.io.errors).toEqual(["wsp import: src/index.ts is not a secret-shaped file in the plan; the plan lists .env. Name one the plan lists, or drop the flag."]);
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
    expect(noSessions.io.errors).toEqual(["wsp import: claude has no sessions for this folder. Name one the plan lists, or drop the flag and let every agent with sessions come."]);
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
    expect(typo.io.errors).toEqual([`wsp export: ${unknownAgentLine("codx", CATALOG_AGENTS.map(a => a.id))}. Name one of those, or drop the flag.`]);
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
    expect(foreign.io.errors).toEqual(['--agent belongs to wsp fork and wsp thread new; wsp send does not read it. usage: wsp send <thread> [--model, --effort, --access <value>] [--image <path>] [--detach] "<message>"']);
    const within = await run("stop", "row_1", "--in", "alpha");
    expect(within.io.errors[0]).toContain("--in belongs to wsp threads and wsp thread new; wsp stop does not read it");
    // A flag spelled like a prototype member is nobody's: the tables are read as own keys, so it gets the parser's line.
    const proto = await run("threads", "--constructor");
    expect(proto.code).toBe(3);
    expect(proto.io.errors[0]).toContain("Unknown option '--constructor'");
    expect(proto.io.errors[0]).not.toContain("belongs to");
    const half = await run("thread");
    expect(half.code).toBe(3);
    expect(half.io.errors).toEqual(['wsp thread opens a line rather than being one. usage: wsp thread new [--in <workspace>] [--agent, --model, --effort, --access, --project <name>, --cwd, --notify, --title, --image <path>, --detach] "<task>"\nusage: wsp thread read <thread> [--last]\nusage: wsp thread rename <thread> "<title>"\nusage: wsp thread forget <thread>']);
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

  describe("what the agents on a workspace may do", () => {
    it("the switch is off until a person turns it on, and the listing and the card read it off the record", async () => {
      await run("new", "alpha");
      const off = await run("workspaces");
      expect(off.io.lines[0]!.split("\n")[1]).not.toContain("machines");
      const on = await run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2");
      expect(on.code).toBe(0);
      expect(on.io.lines).toEqual(["alpha: agents may spawn: up to 2 workspaces"]);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 2, maxDepth: 1 });
      expect((await run("workspaces")).io.lines[0]!).toContain("2 machines");
      const back = await run("workspaces", "agents", "alpha", "--spawn", "off");
      expect(back.io.lines).toEqual(["alpha: agents may not spawn"]);
      // Off keeps the numbers it was given rather than throwing them away, so turning it on again is one word.
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: false, maxMachines: 2, maxDepth: 1 });
    });

    it("a cap with no --spawn beside it is refused, and so is a word that is neither on nor off", async () => {
      await run("new", "alpha");
      const bare = await run("workspaces", "agents", "alpha", "--max-machines", "2");
      expect(bare.code).toBe(EXIT_CODES.usage);
      expect(bare.io.errors[0]).toContain("need --spawn on beside them");
      const wrong = await run("workspaces", "agents", "alpha", "--spawn", "yes");
      expect(wrong.code).toBe(EXIT_CODES.usage);
      expect(wrong.io.errors[0]).toContain("--spawn takes on or off");
      const none = await run("workspaces", "agents", "alpha");
      expect(none.code).toBe(EXIT_CODES.usage);
      expect((await rt.workspaces.list())[0]!.agents).toBeUndefined();
    });

    it("--max-depth 0 is a usage sentence, not a shape the wire refuses", async () => {
      await run("new", "alpha");
      const zero = await run("workspaces", "agents", "alpha", "--spawn", "on", "--max-depth", "0");
      expect(zero.code).toBe(EXIT_CODES.usage);
      expect(zero.io.errors[0]).toBe('wsp workspaces agents: --max-depth takes a whole number of one or more, and got "0". Write it as --max-depth <n>.');
      // Zero machines is a switch that is on and forks nothing, which is a thing a person may mean.
      const none = await run("workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "0");
      expect(none.code).toBe(0);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 0, maxDepth: 1 });
    });

    it("a workspace whose agents could not drive this host is refused the switch at both doors, in one sentence", async () => {
      const local = await run("new", "--local", "mine", "--spawn", "on");
      expect(local.code).toBe(EXIT_CODES.usage);
      expect(local.io.errors[0]).toBe(`wsp new: ${agentsKindRefusal("local")}. Drop --spawn on, or make a cloud workspace instead.`);
      expect(await rt.workspaces.list()).toEqual([]);
      const ssh = await run("new", "--ssh", "maya@box", "--spawn", "on");
      expect(ssh.code).toBe(EXIT_CODES.usage);
      expect(ssh.io.errors[0]).toBe(`wsp new: ${agentsKindRefusal("ssh")}. Drop --spawn on, or make a cloud workspace instead.`);
      // The verb that sets it on a workspace that already exists reads the same rule and says the same thing.
      await run("new", "--local", "mine");
      const set = await run("workspaces", "agents", "mine", "--spawn", "on");
      expect(set.code).toBe(1);
      expect(set.io.errors[0]).toBe(`wsp workspaces agents: ${agentsKindRefusal("local")}`);
      expect((await rt.workspaces.list())[0]!.agents).toBeUndefined();
      // Off is taken wherever it is asked for: a switch that does nothing may be said to do nothing.
      expect((await run("workspaces", "agents", "mine", "--spawn", "off")).code).toBe(0);
    });

    it("wsp new --spawn on turns the switch on at the create", async () => {
      const made = await run("new", "alpha", "--spawn", "on", "--max-machines", "1");
      expect(made.code).toBe(0);
      expect((await rt.workspaces.list())[0]!.agents).toEqual({ spawn: true, maxMachines: 1, maxDepth: 1 });
    });

    it("--tree draws a thread an agent spawned under the thread that spawned it, and stop ends the tree as one", async () => {
      const held = heldAgent(false);
      await restartHost({ claude: held.adapter });
      await run("new", "alpha", "--spawn", "on");
      const alpha = (await rt.workspaces.list())[0]!;
      const lead = await rt.sessions.start(alpha.id, { prompt: "lead" });
      const leadThread = lead.view().threadId!;
      const child = await rt.sessions.start(alpha.id, { prompt: "builder" }, { origin: "relayed", by: { kind: "thread", threadId: leadThread, workspaceId: alpha.id, rootThreadId: leadThread } });
      const childThread = child.view().threadId!;
      const rows = (io: Captured): string[] => io.lines[0]!.split("\n").slice(1);
      expect(rows((await run("threads")).io).some(r => r.startsWith("  "))).toBe(false);
      // The child sits directly under its parent, one step in, whatever the order the sort gave them.
      const drawn = rows((await run("threads", "--tree")).io);
      const at = drawn.findIndex(r => r.trim().startsWith(leadThread));
      expect(drawn[at + 1]).toMatch(new RegExp(`^ {2}${childThread}`));
      // Two rows naming each other are under no top row; the listing prints every row it was given all the same.
      expect(threadTree([
        { id: "a", parentThreadId: "b" },
        { id: "b", parentThreadId: "a" },
      ] as unknown as Parameters<typeof threadTree>[0]).map(t => t.row.id).sort()).toEqual(["a", "b"]);
      const stopped = await run("stop", leadThread);
      expect(stopped.io.lines[0]).toBe(`thread ${leadThread} stopped, and with it 1 thread its agents spawned: ${childThread.slice(0, 8)}`);
      expect((await rt.sessions.list(alpha.id)).every(v => v.status !== "running")).toBe(true);
    });
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
      expect(opened.io.streamed).toContain("[image 1 MB png]");
    });

    it("a path this computer has no file at answers in a sentence, not in the reader's own error", async () => {
      await run("new", "alpha");
      const missing = join(dir, "not-here.png");
      const refused = await run("send", "--image", missing, "x", "y");
      expect(refused.io.errors[0]).not.toContain("ENOENT");
      const opening = await run("thread", "new", "--in", "alpha", "--image", missing, "look");
      expect(opening.code).toBe(EXIT_CODES.usage);
      expect(opening.io.errors).toEqual([`wsp thread new: there is no file at ${missing} on this computer. Name a file that is already here.`]);
      expect(claude.starts).toHaveLength(0);
    });

    it("a folder named where an image should be is refused the same way, rather than failing on the read", async () => {
      await run("new", "alpha");
      const refused = await run("thread", "new", "--in", "alpha", "--image", dir, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp thread new: there is no file at ${dir} on this computer. Name a file that is already here.`]);
    });

    it("a file that is not one of the four types is refused by name, before anything travels", async () => {
      await run("new", "alpha");
      const path = join(dir, "notes.pdf");
      writeFileSync(path, "%PDF-1.7 not an image at all");
      const refused = await run("thread", "new", "--in", "alpha", "--image", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual([`wsp thread new: ${path} is not PNG, JPEG, GIF or WebP; a message carries those four. Name one of those instead.`]);
      expect(claude.starts).toHaveLength(0);
    });

    it("a 12 MB image is refused with the cap in the sentence, and the file is never read whole", async () => {
      await run("new", "alpha");
      const path = pngFile(dir, "huge.png", 12 * 1024 * 1024);
      const refused = await run("thread", "new", "--in", "alpha", "--image", path, "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp thread new: huge.png is 12 MB, over the 10 MB an image may be. Drop that one and send the rest."]);
      expect(claude.starts).toHaveLength(0);
    });

    it("six images are refused with both counts", async () => {
      await run("new", "alpha");
      const paths = Array.from({ length: 6 }, (_, i) => pngFile(dir, `n${i}.png`, 64));
      const refused = await run("thread", "new", "--in", "alpha", ...paths.flatMap(p => ["--image", p]), "look");
      expect(refused.code).toBe(EXIT_CODES.usage);
      expect(refused.io.errors).toEqual(["wsp thread new: only 5 images fit one message; this one carries 6. Drop that one and send the rest."]);
    });
  });
});

describe("messageTo", () => {
  const row: ThreadView = { id: "row_1", workspaceId: "ws_1", harness: "claude", startedBy: "person", status: "failed", title: "hello", sessionId: "row_1", turns: 1, ran: false };
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
