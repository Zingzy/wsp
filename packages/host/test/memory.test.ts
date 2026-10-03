// SPDX-License-Identifier: AGPL-3.0-only
// What the host costs the computer it runs on, measured rather than claimed:
// one child process is the host, a scripted day of threads and turns goes
// through it, and what it still holds once it goes quiet is read off V8 after
// a full collection. Resident size is read too and named on a red run, but it
// is not the budget: an empty node is already past this budget in mapped
// binary alone (41 MB on this Linux runner), and resident size follows V8's
// high water mark rather than what the host kept.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT } from "../../protocol/test/source-files.js";
import { DIST, describeWithDists, distOf } from "./built-bin.js";

/** The budget the landing page promises for what the host still holds after a day of agents: change it here and the
 * page goes red until it says the same thing. */
const HOST_MEMORY_BUDGET_MB = 40;

/** What the run is held to, under the promise so a regression is caught while the promise still holds: the host
 * read 31.3 MB on CI when this was first set, main read 35.1 MB on 2026-10-01, and the per-model usage rows, the
 * top threads and the fifteen-minute draw added about 0.1 MB more; the pull request pane's reply, resolve and react
 * shapes took main from 35.9 to 36.1 MB on 2026-10-03. */
const HOST_MEMORY_CAP_MB = 36.5;

/** The one page that quotes the budget. */
const PAGE = join("apps", "www", "src", "sections", "story.tsx");

/** The scripted day: four threads a person keeps open, one of them in a worktree of a branch of its own, thirty turns
 * each, forty deltas a turn, and four subagents a turn that each start, say ten lines and end. That is past the
 * transcript ring's 5000 events, so the host is measured with every cap it has already full and every child the ring
 * still holds kept under its thread. */
const THREADS = 4;
const TURNS_PER_THREAD = 30;
const DELTAS_PER_TURN = 40;
const SUBAGENTS_PER_TURN = 4;
const SUBAGENT_DELTAS = 10;

interface Reading {
  heldMb: number;
  rssMb: number;
  turns: number;
  /** Each collection's figure from the last turn until one freed nothing more. */
  readings?: number[];
}

/** The host as its own process: the wiring `wsp up` builds, a local workspace, and one harness that answers with a
 * turn's worth of events instead of starting an agent, so no machine and no agent is involved in the measurement. */
const hostScript = (home: string): string => `
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRuntime, jsonFileStore } from ${JSON.stringify(distOf("runtime"))};
import { startHost, localWiring, stateWriterHere } from ${JSON.stringify(DIST)};
import { fakeCopier, NoProviderBackend } from ${JSON.stringify(distOf("engine"))};
import { DAEMON_VERSION } from ${JSON.stringify(distOf("protocol"))};

const home = ${JSON.stringify(home)};
const webDir = join(home, "web");
mkdirSync(join(webDir, "assets"), { recursive: true });
writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\\n");
writeFileSync(join(webDir, "index.html"), '<!doctype html><html><head><script type="module" crossorigin src="/assets/app.js"></script></head><body><div id="root"></div><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>');
const statePath = join(home, "state", "state.json");
mkdirSync(join(home, "state"), { recursive: true });

let nth = 0;
const scripted = () => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = \`00000000-0000-4000-8000-\${String(++nth).padStart(12, "0")}\`;
    const finished = (async () => {
      onEvent({ type: "session.start", sessionId });
      for (let i = 0; i < ${DELTAS_PER_TURN}; i++) onEvent({ type: "turn.delta", sessionId, kind: "text", text: "token ".repeat(16) });
      for (let c = 0; c < ${SUBAGENTS_PER_TURN}; c++) {
        const task = \`a\${nth.toString(16).padStart(12, "0")}\${c}\`;
        const parentToolUseId = \`toolu_\${task}\`;
        onEvent({ type: "subagent", sessionId, task, state: "running", parentToolUseId, title: "Count to thirty with one Bash call per number", depth: 1 });
        for (let i = 0; i < ${SUBAGENT_DELTAS}; i++) onEvent({ type: "turn.delta", sessionId, kind: "text", text: "token ".repeat(16), parentToolUseId });
        onEvent({ type: "subagent", sessionId, task, state: "done", parentToolUseId, summary: "COUNT-FINISHED" });
      }
      const result = { status: "completed", text: "done" };
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});

// The worktree road and the daemon beside the host are the fakes: this checkout stages no daemon binary, and what is
// measured is the host's own bookkeeping.
const copier = fakeCopier();
const daemon = async () => ({ version: DAEMON_VERSION, road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }, sysSamples: async () => () => {}, close: async () => {} });
const runtime = createRuntime({
  backend: new NoProviderBackend(),
  local: localWiring(home, undefined, daemon, statePath, copier),
  store: jsonFileStore(statePath, stateWriterHere()),
  adapters: { claude: scripted },
});
const host = await startHost({ runtime, webDir, port: 0, statePath });
// Threads run in the project's folder, and the last of them in a worktree of a branch of its own.
const folder = join(home, "repo");
mkdirSync(folder, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", folder]);
const project = await host.addProject(folder);
const workspace = await host.createWorkspace("here", undefined, project.id);
const worktree = (await runtime.workspaces.folderFor({ project: project.id, branch: "feat/side" })).workspace;

const turn = async (at, thread) => {
  const handle = await runtime.sessions.start(at.id, { prompt: "go", harness: "claude", ...(thread === undefined ? {} : { thread }) });
  await handle.finished?.catch(() => {});
  return { at, thread: handle.view().threadId ?? handle.view().id };
};
const threads = [];
for (let t = 0; t < ${THREADS}; t++) threads.push(await turn(t === ${THREADS} - 1 ? worktree : workspace, undefined));
for (let n = 1; n < ${TURNS_PER_THREAD}; n++) for (const { at, thread } of threads) await turn(at, thread);

// The host writes its index and its transcripts behind a queue. What it holds is only known once it has been left
// alone the way an idle minute leaves it, so this reads until a collection frees nothing more: the drain falls from
// about 41 MB to the floor, and stopping at two reads within a megabyte could stop on the way down.
// external covers the buffers a socket frame and a queued write live in, arrayBuffers among them, which the heap
// alone does not count.
const held = () => {
  global.gc();
  global.gc();
  const m = process.memoryUsage();
  return (m.heapUsed + m.external) / 1048576;
};
let before = Infinity;
let after = held();
const readings = [after];
for (let i = 0; i < 60 && Math.abs(before - after) > 0.1; i++) {
  await sleep(250);
  before = after;
  after = held();
  readings.push(after);
}
console.log(\`measured \${JSON.stringify({ heldMb: +after.toFixed(1), rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), turns: ${THREADS * TURNS_PER_THREAD}, readings: readings.map(r => +r.toFixed(1)) })}\`);
await host.close();
process.exit(0);
`;

/** How long a measuring run may take before it is ended, so a host that will not close cannot outlive this file. */
const RUN_CAP_MS = 240_000;

/** Runs a script under a node of its own with collection exposed, and answers with everything it said. */
function ran(script: string, home: string): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], {
      cwd: home,
      env: { ...process.env, HOME: home, WSP_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    const cap = setTimeout(() => child.kill("SIGKILL"), RUN_CAP_MS);
    child.once("error", error => {
      clearTimeout(cap);
      reject(error);
    });
    child.once("exit", code => {
      clearTimeout(cap);
      resolve({ out, code });
    });
  });
}

const reading = (out: string, who: string): Reading => {
  const line = out.split("\n").find(l => l.startsWith("measured "));
  if (line === undefined) throw new Error(`${who} printed no measurement:\n${out}`);
  return JSON.parse(line.slice("measured ".length)) as Reading;
};

describe("the page prints the budget the test guards", () => {
  it("names the same number the host is held to", () => {
    const page = readFileSync(join(ROOT, PAGE), "utf8");
    expect(page, `${PAGE} must quote ${HOST_MEMORY_BUDGET_MB} MB, the budget this file guards`).toMatch(new RegExp(`\\b${HOST_MEMORY_BUDGET_MB} MB\\b`));
  });
});

describeWithDists("what the host loads to start", ["host"], () => {
  it("leaves the tool server's library until a tool server opens", async () => {
    // The library's schemas alone were 8 MB of the budget, held by every host whether or not an agent asked for tools.
    // register, not registerHooks: the engines floor is Node 22.0 and registerHooks came in 22.15. Its hooks run on a
    // thread of their own, so the list is read once the hook has seen the last import, which the port keeps in order.
    const hook = "let port; export const initialize = data => { port = data.port; }; export const load = (url, context, next) => { port.postMessage(url); return next(url, context); };";
    const script = `
import { register } from "node:module";
import { MessageChannel } from "node:worker_threads";
const { port1, port2 } = new MessageChannel();
register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)}, { data: { port: port2 }, transferList: [port2] });
const last = "data:text/javascript,export%20default%200";
const seen = new Promise(done => port1.on("message", url => (console.log(url), url === last && done())));
await import(${JSON.stringify(DIST)});
await import(last);
await seen;
port1.close();
`;
    const run = await ran(script, tmpdir());
    expect(run.code, run.out).toBe(0);
    expect(run.out.split("\n").filter(url => url.includes("@modelcontextprotocol"))).toEqual([]);
  });
});

describeWithDists("what the host holds after a day of agents", ["host", "runtime", "engine"], () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-memory-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(`stays under ${HOST_MEMORY_CAP_MB} MB with ${THREADS * TURNS_PER_THREAD} turns through it, one thread of them in a worktree`, async () => {
    const empty = await ran('global.gc(); console.log(`measured ${JSON.stringify({ heldMb: 0, rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1), turns: 0 })}`)', home);
    expect(empty.code, `an empty node on this runner said: ${empty.out}`).toBe(0);
    const floor = reading(empty.out, "an empty node");
    const run = await ran(hostScript(home), home);
    expect(run.code, run.out).toBe(0);
    const held = reading(run.out, "the host");
    const said = `the host held ${held.heldMb} MB after ${held.turns} turns (resident ${held.rssMb} MB, an empty node on this runner ${floor.rssMb} MB; read ${(held.readings ?? []).join(", ")})`;
    // Printed on a pass too, so the margin a run kept can be read off CI before it is gone.
    console.log(said);
    expect(HOST_MEMORY_CAP_MB).toBeLessThanOrEqual(HOST_MEMORY_BUDGET_MB);
    expect(held.heldMb, said).toBeLessThanOrEqual(HOST_MEMORY_CAP_MB);
  }, 300_000);
});
