// SPDX-License-Identifier: AGPL-3.0-only
// The wsp verbs against a host over the fake runtime: each one a client of
// the protocol on localhost, authenticated with the token the host wrote,
// reading the same session index the sidebar reads.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnResult } from "@wsp/adapter-claude";
import type { ExecResult } from "@wsp/engine";
import { ThreadView } from "@wsp/protocol";
import { createRuntime, memoryStore, type HarnessAdapterFactory, type HarnessStartOptions, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cli, serve, type CliIO } from "../src/cli.js";
import type { HostHandle } from "../src/server.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";

const PAGE = `<!doctype html>
<html><head><script type="module" crossorigin src="/assets/app.js"></script></head>
<body><div id="root"></div>
<script>window.__WSP__ = window.__WSP__ || { wsPort: 4410, token: "" };</script>
</body></html>
`;

interface Captured extends CliIO {
  lines: string[];
  errors: string[];
  streamed: string;
}

const noPrompt = (q: string): Promise<string> => Promise.reject(new Error(`unexpected prompt: ${q}`));
function captured(): Captured {
  const io: Captured = {
    lines: [],
    errors: [],
    streamed: "",
    log: l => io.lines.push(l),
    error: l => io.errors.push(l),
    stream: t => (io.streamed += t),
    ask: noPrompt,
    askSecret: noPrompt,
  };
  return io;
}

/** A harness that answers every prompt with reply(prompt) in two text deltas, or fails the turn when the reply is
 * empty; a resumed start keeps the session id, as the real one does. */
function scriptedAgent(reply: (prompt: string) => string) {
  const starts: HarnessStartOptions[] = [];
  const adapter: HarnessAdapterFactory = () => ({
    start: o => {
      starts.push(o);
      const sessionId = o.resume ?? randomUUID();
      const text = reply(o.prompt);
      const result: TurnResult = text === "" ? { status: "failed", error: "the harness died" } : { status: "completed", text };
      const finished = Promise.resolve().then(() => {
        o.onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        if (text !== "") {
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(0, 4) });
          o.onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: "ls", toolName: "Bash" });
          o.onEvent({ type: "turn.delta", sessionId, kind: "text", text: text.slice(4) });
        }
        o.onEvent({ type: "turn.done", sessionId, result });
        o.onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        return result;
      });
      return { localId: sessionId, claudeSessionId: sessionId, finished, interrupt: async () => {} };
    },
  });
  return { adapter, starts };
}

/** The guest side of the exec stream: the launch lands, one poll hands over the log with the exit code. */
function execGuest(backend: StubBackend, output: string, exit: number) {
  const base = backend.execImpl;
  backend.execImpl = (m, cmd): Promise<ExecResult> | ExecResult => {
    if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    const sentinel = /(__WSP_EOF_[a-z0-9]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) {
      const from = Number(/tail -c \+(\d+)/.exec(cmd)?.[1] ?? "1") - 1;
      return { exitCode: 0, stdout: `${Buffer.from(output).subarray(from).toString("base64")}\n${sentinel} ${exit} down\n`, stderr: "" };
    }
    return base(m, cmd);
  };
}

describe("wsp verbs over the host", () => {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
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
    const store = memoryStore();
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
    expect(json(again.io)).toEqual([{ workspace: expect.objectContaining({ name: "beta" }) }]);
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

  it("threads is the sidebar's data: one row per thread with agent, state and who opened it, filtered by --in", async () => {
    await run("new", "alpha");
    await run("new", "beta");
    const [alpha, beta] = await rt.workspaces.list();
    await run("thread", "new", "--in", "alpha", "first task");
    await (await rt.sessions.start(beta!.id, { prompt: "from the app", harness: "codex" })).finished;
    const { code, io } = await run("threads");
    expect(code).toBe(0);
    const rows = io.lines[0]!.split("\n");
    expect(rows[0]).toMatch(/^THREAD\s+WORKSPACE\s+AGENT\s+STATE\s+BY\s+TITLE$/);
    const [a] = await rt.sessions.list(alpha!.id);
    const [b] = await rt.sessions.list(beta!.id);
    expect(rows.slice(1)).toEqual([
      `${a!.threadId}  alpha      claude  completed  cli     first task`,
      `${b!.threadId}  beta       codex   completed  person  from the app`,
    ]);

    const scoped = await run("threads", "--in", "beta", "--json");
    expect(scoped.code).toBe(0);
    const [{ threads }] = json(scoped.io) as [{ threads: ThreadView[] }];
    expect(threads.map(t => ThreadView.parse(t))).toEqual(threads);
    expect(threads).toEqual([expect.objectContaining({ id: b!.threadId, workspaceId: beta!.id, harness: "codex", startedBy: "person", turns: 1 })]);
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

  it("send --json prints the turn's raw events and nothing else", async () => {
    await run("new", "alpha");
    await run("thread", "new", "--in", "alpha", "first");
    const [first] = await rt.sessions.list();
    const { code, io } = await run("send", first!.threadId!, "second", "--json");
    expect(code).toBe(0);
    const events = json(io) as { type: string; threadId?: string; kind?: string; text?: string }[];
    expect(events.map(e => e.type)).toEqual(["session.start", "session.delta", "session.delta", "session.delta", "session.done", "session.end"]);
    expect(new Set(events.map(e => e.threadId))).toEqual(new Set([first!.threadId]));
    expect(events[1]).toMatchObject({ kind: "text", text: "re: " });
    expect(io.streamed).toBe("");
  });

  it("exec runs the command on the workspace's machine, streams its output and exits with its code", async () => {
    await run("new", "alpha");
    execGuest(backend, "one\ntwo\n", 3);
    const { code, io } = await run("exec", "alpha", "--", "printf", "'one\\ntwo\\n';", "exit", "3");
    expect(code).toBe(3);
    expect(io.lines).toEqual(["one", "two"]);
    const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
    expect(Buffer.from(/printf '%s' '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8")).toContain("printf 'one\\ntwo\\n'; exit 3");

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

  it("import and export say in one plain line that they are not here yet", async () => {
    const imp = await run("import", "./proj", "--to", "alpha");
    expect(imp.code).toBe(1);
    expect(imp.io.lines).toEqual(["wsp import is not here yet: moving a project folder into a workspace lands with the project bundle."]);
    const exp = await run("export", "alpha", "./proj", "--json");
    expect(exp.code).toBe(1);
    expect(json(exp.io)).toEqual([{ verb: "export", available: false, note: expect.stringContaining("not here yet") }]);
  });

  it("every verb takes --json and --help; a bad flag prints the usage", async () => {
    for (const verb of [["new"], ["fork"], ["pause"], ["threads"], ["thread", "new"], ["send"], ["exec"], ["import"], ["export"]]) {
      const help = await run(...verb, "--help");
      expect(help.code).toBe(0);
      expect(help.io.lines[0]).toMatch(new RegExp(`^usage: wsp ${verb.join(" ")}`));
      expect(help.io.lines[0]).toContain("--json");
    }
    const bad = await run("threads", "--nope");
    expect(bad.code).toBe(1);
    expect(bad.io.errors[0]).toContain("usage: wsp threads");
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
