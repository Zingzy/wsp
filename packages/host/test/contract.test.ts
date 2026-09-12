// SPDX-License-Identifier: AGPL-3.0-only
// The one contract an agent reads wsp by, held on both doors against a host
// over the fake runtime: with --json stdout is JSON only and ends with the
// object the verb's MCP tool answers with; every refusal is one line on stderr
// and the exit code is its class's, the same class the tool error carries.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { type AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EXIT_CODES, VerbFailure } from "@wsp/protocol";
import { createRuntime, memoryStore, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { cli, jsonCliIO, serve } from "../src/cli.js";
import { placeWiring } from "../src/places.js";
import { hostTokenPath, lockPathFor } from "../src/host-lock.js";
import { mcpServer } from "../src/mcp.js";
import type { HostHandle } from "../src/server.js";
import { CLI_VERBS } from "../src/verbs.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { EXPORT_SOURCE, PAGE, captured, execGuest, exportGuest, scriptedAgent, type Captured } from "./verbs-fixture.js";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

describe("the agent contract on the command line and the tool door", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  let rt: Runtime;
  let handle: HostHandle | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "wsp-contract-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_contract_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    await store.put("goldens", "default", SEALED_GOLDEN);
    const claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`), () => ({ kind: "written" }));
    // The confirming read a gone verdict waits for runs on the same tick: this backend's 404 is the whole truth, so
    // the wait only buys the contract a five second pause on the road to a rebuild.
    rt = createRuntime({ backend, store, adapters: { claude: claude.adapter }, goneConfirmMs: 0, places: placeWiring(statePath, {}, {}) });
    handle = await serve(captured(), { port: 0, wsPort: 0, statePath, webDir, runtime: rt });
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
  const objects = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  const failure = (io: Captured): VerbFailure => {
    expect(io.errors).toHaveLength(1);
    return VerbFailure.parse(JSON.parse(io.errors[0]!));
  };

  it("with --json every command-line verb prints JSON alone on stdout and its last object is the one its MCP tool answers with", async () => {
    const covered = new Map<string, unknown>();
    const last = async (verb: string, ...argv: string[]): Promise<unknown> => {
      const cut = argv.indexOf("--");
      const at = cut === -1 ? argv.length : cut;
      const { code, io } = await run(...argv.slice(0, at), "--json", ...argv.slice(at));
      expect(code, `wsp ${argv.join(" ")}: ${io.errors.join("\n")}`).toBe(0);
      const values = objects(io);
      expect(values.length, `wsp ${argv.join(" ")} printed nothing`).toBeGreaterThan(0);
      covered.set(verb, values.at(-1));
      return values.at(-1);
    };
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "index.ts"), "export const a = 1;\n");
    const guest = exportGuest(backend);
    expect(guest.sources).toEqual([]);

    const created = (await last("new", "new", "alpha")) as { workspace: { id: string } };
    const alpha = created.workspace.id;
    await last("workspaces", "workspaces");
    expect(await last("workspaces agents", "workspaces", "agents", "alpha", "--spawn", "on", "--max-machines", "2")).toEqual({
      workspace: expect.objectContaining({ name: "alpha", agents: { spawn: true, maxMachines: 2, maxDepth: 1 } }),
    });
    await last("workspaces agents", "workspaces", "agents", "alpha", "--spawn", "off");
    await last("threads", "threads");
    await last("places", "places");
    await last("setup", "setup");
    // One level of this computer's own folders: the home folder this test stubbed, with a folder inside it to list.
    mkdirSync(join(dir, "user", "code"), { recursive: true });
    await last("folders", "folders");
    await last("terminal config", "terminal", "config");
    // The streaming verbs: the frames carry a field of the tool's object and the result leaves it out. A plan nobody
    // consented to is the plan frame alone, since nothing is left of the result once the plan is dropped.
    const planned = await run("import", proj, "--to", "alpha", "--json");
    expect(planned.code).toBe(0);
    expect(objects(planned.io)).toEqual([{ plan: expect.objectContaining({ files: 1 }) }]);
    const imported = await run("import", proj, "--to", "alpha", "--yes", "--json");
    expect(imported.code).toBe(0);
    expect(objects(imported.io)).toEqual([{ plan: expect.objectContaining({ files: 1 }) }, { imported: expect.objectContaining({ files: 1 }) }]);
    covered.set("import", objects(imported.io).at(-1));
    expect(await last("projects", "projects", "alpha")).toEqual({ projects: [expect.objectContaining({ name: "proj", size: 20 })] });
    // Renamed and named back, so the rest of this run still addresses it as alpha.
    expect(await last("rename", "rename", "alpha", "renamed")).toMatchObject({ was: "alpha", workspace: { name: "renamed" } });
    await last("rename", "rename", "renamed", "alpha");
    // A snapshot takes a first-life machine, so it comes before the pause that resumes it.
    await last("snapshot", "snapshot", "alpha");
    await last("pause", "pause", "alpha");
    await last("wake", "wake", "alpha");
    // Already on the golden's head, so the move is the answer alone: the workspace untouched and nothing kept.
    expect(await last("image move", "image", "move", "alpha")).toEqual({ workspace: expect.objectContaining({ name: "alpha" }), moved: false, kept: [] });
    const opened = (await last("thread new", "thread", "new", "--in", "alpha", "hello")) as { threadId: string; text: string };
    expect(opened).toMatchObject({ threadId: expect.any(String), text: "re: hello", outcome: "started" });
    await last("send", "send", opened.threadId, "again");
    // The turn is over, so the wait answers off the transcript at once.
    expect(await last("threads wait", "threads", "wait", opened.threadId)).toEqual({ finished: { threadId: opened.threadId, status: "completed", reply: "re: again" } });
    // The read is off the transcript the host holds: the same turn, its rows, and its reply whole under --last.
    expect(await last("thread read", "thread", "read", opened.threadId, "--last")).toEqual({ threadId: opened.threadId, messages: [{ who: "agent", at: expect.any(Number), text: "re: again" }] });
    await last("thread read", "thread", "read", opened.threadId);
    await last("stop", "stop", opened.threadId);
    await last("thread rename", "thread", "rename", opened.threadId, "the name he typed");
    await last("export", "export", "alpha", join(dir, "out", "proj"), "--from", EXPORT_SOURCE);
    execGuest(backend, "ok\n", 0);
    // A streamed verb's frames carry the output and its result leaves it out, so no line prints twice.
    const ran = await run("exec", "alpha", "--json", "--", "true");
    expect(ran.code).toBe(0);
    expect(objects(ran.io)).toEqual([{ type: "exec.output", execId: expect.any(String), text: "ok" }, { exitCode: 0, cwd: realpathSync(proj) }]);
    covered.set("exec", objects(ran.io).at(-1));
    const forked = await run("fork", "alpha", "--name", "worker", "--send", "build it", "--json");
    expect(forked.code).toBe(0);
    const forkLines = objects(forked.io) as Record<string, unknown>[];
    expect(forkLines.filter(o => "workspace" in o)).toEqual([{ workspace: expect.objectContaining({ name: "worker" }) }]);
    expect(forkLines.at(-1)).toEqual({ turn: expect.objectContaining({ text: "re: build it", outcome: "started" }) });
    covered.set("fork", forkLines.at(-1));
    const plain = await run("fork", "alpha", "--name", "sibling", "--json");
    expect(plain.code).toBe(0);
    expect(objects(plain.io).at(-1)).toEqual({ workspace: expect.objectContaining({ name: "sibling" }) });
    // Recipe verbs read the computer HOME and PATH name: an empty one here, so nothing of this box is read.
    const empty = join(dir, "empty");
    mkdirSync(join(empty, "bin"), { recursive: true });
    vi.stubEnv("HOME", empty);
    vi.stubEnv("PATH", join(empty, "bin"));
    await last("recipe scan", "recipe", "scan");
    await last("recipe", "recipe", "--tick", "default");
    for (const m of backend.machines) m.killed = true;
    const worker = (await rt.workspaces.list()).find(w => w.name === "worker")!;
    await last("forget", "forget", worker.id, "--yes");
    // A machine killed at the provider settles its record on the next verb that reads the machine, and gone is the
    // one state a rebuild takes; the workspace comes back on a fresh machine under the same id.
    const stale = await run("wake", "alpha", "--json");
    expect(stale.code).toBe(1);
    const rebuilt = (await last("rebuild", "rebuild", alpha)) as { workspace: { id: string; machineId: string } };
    expect(rebuilt.workspace.id).toBe(alpha);
    await last("delete", "delete", alpha, "--yes");
    expect(CLI_VERBS.filter(v => v.tool.stream !== undefined).map(v => [v.name, v.tool.stream])).toEqual([["fork", ["workspace", "notice"]], ["exec", ["output"]], ["import", ["plan"]]]);

    for (const verb of CLI_VERBS) {
      const value = covered.get(verb.name);
      expect(value, `no --json run of wsp ${verb.name} in this test`).toBeDefined();
      const shape = z.object(verb.tool.output);
      const parsed = shape.omit(Object.fromEntries((verb.tool.stream ?? []).map(field => [field, true]))).strict().safeParse(value);
      expect(parsed.success, `wsp ${verb.name} --json ends with ${JSON.stringify(value)}\n${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
    expect([...covered.keys()].sort()).toEqual(CLI_VERBS.map(v => v.name).sort());
  });

  it("a usage refusal exits 3: the parser's, a verb's own before anything is dialled, and a confirmation nobody is there to give; under --json the one stderr line is the failure object", async () => {
    const flag = await run("threads", "--nope", "--json");
    expect(flag.code).toBe(EXIT_CODES.usage);
    expect(flag.io.lines).toEqual([]);
    expect(failure(flag.io)).toEqual({ error: expect.stringContaining("Unknown option '--nope'"), class: "usage", exit: 3 });

    const bare = await run("new");
    expect(bare.code).toBe(3);
    expect(bare.io.errors).toEqual(["wsp new: wsp new takes one name"]);

    await run("new", "alpha");
    const unasked = await run("delete", "alpha", "--json");
    expect(unasked.code).toBe(3);
    expect(failure(unasked.io)).toEqual({ error: "Delete alpha? There is no terminal to answer on; pass --yes to say yes.", class: "usage", exit: 3 });
    expect((await rt.workspaces.list()).map(w => w.name)).toEqual(["alpha"]);

    const relative = await run("exec", "alpha", "--cwd", "packages", "--json", "--", "true");
    expect(relative.code).toBe(3);
    expect(failure(relative.io).class).toBe("usage");
    const dangling = await run("fork", "alpha", "--model", "claude-sonnet-5", "--json");
    expect(dangling.code).toBe(3);
    expect(failure(dangling.io)).toEqual({ error: "--model needs --send", class: "usage", exit: 3 });
  });

  it("an auth refusal exits 2: the host refusing the token, or no token file to read", async () => {
    writeFileSync(hostTokenPath(statePath), "not-the-token\n");
    const wrong = await run("threads", "--json");
    expect(wrong.code).toBe(EXIT_CODES.auth);
    expect(wrong.io.lines).toEqual([]);
    expect(failure(wrong.io)).toEqual({ error: "unauthorized", class: "auth", exit: 2 });
    const prose = await run("threads");
    expect(prose.code).toBe(2);
    expect(prose.io.errors).toEqual(["wsp threads: unauthorized"]);

    rmSync(hostTokenPath(statePath));
    const missing = await run("threads", "--json");
    expect(missing.code).toBe(2);
    expect(failure(missing.io)).toEqual({ error: `the host's token file is missing: ${hostTokenPath(statePath)}`, class: "auth", exit: 2 });
  });

  it("a host of an older version refuses the token with the close code alone, and that is auth too; a plain refusal that closes normally stays the provider's", async () => {
    await handle!.close();
    handle = undefined;
    writeFileSync(hostTokenPath(statePath), "tok\n");
    const serve = async (answer: (socket: import("ws").WebSocket, id: number) => void): Promise<{ code: number; io: Captured }> => {
      const old = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      await new Promise<void>(r => old.once("listening", r));
      const wsPort = (old.address() as AddressInfo).port;
      writeFileSync(lockPathFor(statePath), JSON.stringify({ pid: process.pid, port: wsPort, wsPort, startedAt: new Date().toISOString() }));
      old.on("connection", socket => socket.once("message", raw => answer(socket, (JSON.parse(String(raw)) as { id: number }).id)));
      try {
        return await run("threads", "--json");
      } finally {
        for (const client of old.clients) client.terminate();
        await new Promise(r => old.close(r));
      }
    };
    const frameThenClose = await serve((socket, id) => {
      socket.send(JSON.stringify({ id, ok: false, error: "unauthorized" }));
      socket.close(4401, "unauthorized");
    });
    expect(frameThenClose.code).toBe(2);
    expect(failure(frameThenClose.io)).toEqual({ error: "unauthorized", class: "auth", exit: 2 });
    const closeAlone = await serve(socket => socket.close(4401, "unauthorized"));
    expect(closeAlone.code).toBe(2);
    expect(failure(closeAlone.io)).toEqual({ error: "the host closed the connection", class: "auth", exit: 2 });
    const refused = await serve((socket, id) => {
      socket.send(JSON.stringify({ id, ok: false, error: "no such op" }));
      socket.close(1000, "done");
    });
    expect(refused.code).toBe(1);
    expect(failure(refused.io)).toEqual({ error: "no such op", class: "provider", exit: 1 });
  });

  it("a provider failure exits 1: the host refusing the name, the machine cap, no host serving, and a turn that failed", async () => {
    const missing = await run("pause", "nope", "--json");
    expect(missing.code).toBe(EXIT_CODES.provider);
    expect(missing.io.lines).toEqual([]);
    expect(failure(missing.io)).toEqual({ error: "no workspace nope", class: "provider", exit: 1 });

    await run("new", "alpha");
    const died = await run("thread", "new", "--in", "alpha", "die");
    expect(died.code).toBe(1);
    expect(died.io.errors).toEqual(["wsp thread new: the harness died"]);

    await handle!.close();
    handle = undefined;
    const gone = await run("threads", "--json");
    expect(gone.code).toBe(1);
    expect(failure(gone.io)).toEqual({ error: `no wsp host is serving ${statePath}; run wsp up first`, class: "provider", exit: 1 });
  });

  it("the shared parse and the commands answer under the same classes: a bad flag, an unknown command and --json on a prose command are usage; a missing key is auth", async () => {
    const io = captured();
    expect(await cli(["--nope"], io)).toBe(3);
    expect(io.errors).toEqual([expect.stringContaining("Unknown option '--nope'")]);
    const unknown = captured();
    expect(await cli(["nope"], unknown)).toBe(3);
    expect(unknown.errors[0]).toContain("unknown command: nope");
    const prose = captured();
    expect(await cli(["status", "--json", "--state", statePath], prose)).toBe(3);
    expect(prose.errors[0]).toContain("Unknown option '--json' for wsp status");
    const both = captured();
    expect(await cli(["init", "--yes", "--json", "--state", statePath], both)).toBe(3);
    expect(both.errors).toEqual([expect.stringContaining("Drop one of them.")]);
    // The host holds the keys; a doctor run here has none to read, and the CLI's own off-terminal IO refuses the key
    // prompt as auth. The IO is the CLI's, since the class is the refusal's, not the command's.
    const err = new PassThrough();
    const said: string[] = [];
    err.on("data", (c: Buffer) => said.push(c.toString()));
    expect(await cli(["doctor", "--state", join(dir, "other.json")], jsonCliIO(err))).toBe(EXIT_CODES.auth);
    expect(said.join("")).toBe("Solari API key: --json asks nothing; set it in the environment, ./.env, or ~/.wsp/.env.\n");
  });

  it("the tool door answers a failure as a tool error whose structured content is the same object with the same class", async () => {
    const server = mcpServer(statePath, { env: {} });
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract", version: "0" });
    await server.connect(toServer);
    await client.connect(toClient);
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const r = await client.callTool({ name, arguments: args });
        return { text: (r.content as { text?: string }[]).map(p => p.text ?? "").join(""), structured: r.structuredContent, isError: r.isError === true };
      };
      expect(await call("pause", { workspace: "nope" })).toEqual({ text: "no workspace nope", structured: { error: "no workspace nope", class: "provider", exit: 1 }, isError: true });
      await call("new", { name: "alpha" });
      const relative = await call("exec", { workspace: "alpha", argv: ["true"], cwd: "packages" });
      expect(relative).toEqual({ text: '--cwd is a path on the machine, absolute: got "packages"', structured: { error: '--cwd is a path on the machine, absolute: got "packages"', class: "usage", exit: 3 }, isError: true });
      writeFileSync(hostTokenPath(statePath), "not-the-token\n");
      const fresh = mcpServer(statePath, { env: {} });
      const [c2, s2] = InMemoryTransport.createLinkedPair();
      const client2 = new Client({ name: "contract-2", version: "0" });
      await fresh.connect(s2);
      await client2.connect(c2);
      try {
        const r = await client2.callTool({ name: "threads", arguments: {} });
        expect(r.isError).toBe(true);
        expect(r.structuredContent).toEqual({ error: "unauthorized", class: "auth", exit: 2 });
      } finally {
        await client2.close();
        await fresh.close();
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("the built bin carries the code out of the process: stdout empty, one JSON line on stderr, exit 3 on a usage refusal and 1 with no host", async () => {
    expect(existsSync(BIN), `${BIN} is missing: run pnpm build first`).toBe(true);
    const exec = promisify(execFile);
    const outcome = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      try {
        const { stdout, stderr } = await exec(process.execPath, [BIN, ...args]);
        return { code: 0, stdout, stderr };
      } catch (e) {
        const failed = e as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    };
    const usage = await outcome(["threads", "--nope", "--json", "--state", join(dir, "none.json")]);
    expect(usage.code).toBe(3);
    expect(usage.stdout).toBe("");
    expect(VerbFailure.parse(JSON.parse(usage.stderr))).toMatchObject({ class: "usage", exit: 3 });
    const noHost = await outcome(["threads", "--json", "--state", join(dir, "none.json")]);
    expect(noHost.code).toBe(1);
    expect(noHost.stdout).toBe("");
    expect(VerbFailure.parse(JSON.parse(noHost.stderr))).toEqual({ error: `no wsp host is serving ${join(dir, "none.json")}; run wsp up first`, class: "provider", exit: 1 });
    const ok = await outcome(["--version"]);
    expect(ok.code).toBe(0);
  });
});
