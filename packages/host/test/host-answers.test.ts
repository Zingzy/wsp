// SPDX-License-Identifier: AGPL-3.0-only
// A host whose state file has grown the way a person's does, measured while
// workspaces are made and turns land in them: its loop must keep answering
// inside a second and what it holds must stay bounded. The state file is the
// one an older build left, every workspace's transcript inside it, which is
// where a host sat for minutes answering nothing (measured 2026-09-28, 94 MB
// to 850 MB resident, a gigabyte swinging in and out within seconds).
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeStub } from "../../protocol/test/stub-script.js";
import { DIST, describeWithDists, distOf } from "./built-bin.js";

/** How long the loop may go without turning: a line at a terminal waits five seconds for a host on this computer, and
 * a window reads a host that answers later than this as a host that has stopped. */
const LOOP_STALL_CAP_MS = 1_000;

/** What the host may still hold once it goes quiet: the day of agents memory.test.ts measures, plus each transcript's
 * index and the few opened last. Holding every transcript up to its byte cap came to 54 MB here. */
const HELD_CAP_MB = 48;

/** The workspaces the state file already holds, the bytes of one tool result in their transcripts, and the new work
 * made on top: two workspaces, and turns carrying a file's worth of tool output each. */
const WORKSPACES = 5;
const RESULT_BYTES = 10_000;
const NEW_WORKSPACES = 2;
const TURNS = 6;

const hostScript = (home: string): string => `
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRuntime, jsonFileStore } from ${JSON.stringify(distOf("runtime"))};
import { startHost, localWiring, stateWriterHere } from ${JSON.stringify(DIST)};
import { fakeCopier, NoProviderBackend } from ${JSON.stringify(distOf("engine"))};
import { DAEMON_VERSION } from ${JSON.stringify(distOf("protocol"))};

const home = ${JSON.stringify(home)};
const webDir = join(home, "web");
mkdirSync(join(webDir, "assets"), { recursive: true });
writeFileSync(join(webDir, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>');
const statePath = join(home, "state", "state.json");
mkdirSync(join(home, "state"), { recursive: true });

let nth = 0;
const big = "x".repeat(200_000);
const scripted = () => ({
  steers: false,
  start: ({ onEvent }) => {
    const sessionId = \`00000000-0000-4000-8000-\${String(++nth).padStart(12, "0")}\`;
    const finished = (async () => {
      onEvent({ type: "session.start", sessionId });
      for (let i = 0; i < 20; i++) {
        onEvent({ type: "turn.delta", sessionId, kind: "tool_use", text: JSON.stringify({ file_path: "/src/a.ts", content: big.slice(0, 20_000) }), toolName: "Write", toolUseId: \`t\${nth}-\${i}\` });
        onEvent({ type: "turn.delta", sessionId, kind: "tool_result", text: big, toolUseId: \`t\${nth}-\${i}\` });
        await sleep(0);
      }
      const result = { status: "completed", text: "done" };
      onEvent({ type: "turn.done", sessionId, result });
      onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
      return result;
    })();
    return { localId: sessionId, finished, interrupt: async () => {} };
  },
});
const copier = fakeCopier(ask => {
  cpSync(ask.from, ask.to, { recursive: true });
  return { road: "clonefile", path: ask.to, base: "0".repeat(40), branch: "main", fetched: true, carried: "deps-and-config", excluded: [...ask.exclude], bytes: 1024, ms: 1 };
});
const daemon = async () => ({ version: DAEMON_VERSION, road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }, sysSamples: async () => () => {}, close: async () => {} });
const serve = async () => {
  const runtime = createRuntime({
    backend: new NoProviderBackend(),
    local: localWiring(home, undefined, daemon, statePath, copier),
    store: jsonFileStore(statePath, stateWriterHere()),
    adapters: { claude: scripted },
  });
  return { runtime, host: await startHost({ runtime, webDir, port: 0, statePath }) };
};

// The workspaces a person already has, made the way they were made.
const folder = join(home, "repo");
mkdirSync(folder, { recursive: true });
execFileSync("git", ["init", "-q", folder]);
let { runtime, host } = await serve();
const project = await host.addProject(folder);
const made = [];
for (let i = 0; i < ${WORKSPACES}; i++) made.push(await host.createWorkspace(\`old \${i}\`, undefined, project.id));
await host.close();

// Their transcripts as an older build kept them, inside the state file: each one full, tool output in every event.
const state = JSON.parse(readFileSync(statePath, "utf8"));
const text = "y".repeat(${RESULT_BYTES});
state.transcripts = Object.fromEntries(made.map(w => [w.id, { workspaceId: w.id, events: Array.from({ length: 5000 }, (_, i) => ({ type: "session.delta", workspaceId: w.id, sessionId: "s", threadId: "thr_old", kind: "tool_use", text, toolName: "Read", toolUseId: \`u\${i}\`, at: i })) }]));
writeFileSync(statePath, JSON.stringify(state, null, 2));
const stateMb = readFileSync(statePath).length / 1048576;
state.transcripts = undefined;

({ runtime, host } = await serve());
await runtime.workspaces.list();

// The loop's longest gap from here on, read the way a timer reads it: a timer that fires late is a loop that was held.
let last = performance.now();
let maxLagMs = 0;
const probe = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - last - 20);
  last = now;
}, 20);

const fresh = [];
for (let i = 0; i < ${NEW_WORKSPACES}; i++) fresh.push(await host.createWorkspace(\`new \${i}\`, undefined, project.id));
for (const w of [...fresh, made[0]]) {
  for (let n = 0; n < ${TURNS}; n++) {
    const handle = await runtime.sessions.start(w.id, { prompt: "go", harness: "claude" });
    await handle.finished?.catch(() => {});
  }
}
await host.close();
clearInterval(probe);

const held = () => {
  global.gc();
  global.gc();
  const m = process.memoryUsage();
  return (m.heapUsed + m.external) / 1048576;
};
let before = Infinity;
let after = held();
for (let i = 0; i < 40 && Math.abs(before - after) > 1; i++) {
  await sleep(250);
  before = after;
  after = held();
}
console.log(\`measured \${JSON.stringify({ stateMb: +stateMb.toFixed(0), maxLagMs: Math.round(maxLagMs), heldMb: +after.toFixed(1), rssMb: +(process.memoryUsage().rss / 1048576).toFixed(0) })}\`);
process.exit(0);
`;

/** The tree a local workspace copies: a checkout's worth of small files and a few large ones. */
const TREE_FILES = 30_000;
const TREE_LARGE = 3;

/** The tree, a git repo, and the copy verb's stand-in: the daemon's verb copies on a Mac alone, so this child copies
 * with cp and answers the one JSON line the verb answers, which is the road a copy takes out of the host. */
function bigTree(home: string): { folder: string; verb: string } {
  const folder = join(home, "big");
  for (let d = 0; d < TREE_FILES / 1000; d++) {
    mkdirSync(join(folder, "src", String(d)), { recursive: true });
    for (let f = 0; f < 1000; f++) writeFileSync(join(folder, "src", String(d), `${f}.ts`), "export const x = 1;\n".repeat(200));
  }
  for (let i = 0; i < TREE_LARGE; i++) execFileSync("sh", ["-c", `head -c 104857600 /dev/urandom > ${join(folder, `blob${i}.bin`)}`]);
  execFileSync("git", ["init", "-q", folder]);
  const verb = join(home, "copy-verb");
  const report = '{"road":"clonefile","path":"%s","base":"0000000000000000000000000000000000000000","branch":"main","fetched":true,"carried":"deps-and-config","excluded":[],"bytes":1,"ms":1}\\n';
  writeStub(verb, ["#!/bin/sh", "while [ $# -gt 0 ]; do case $1 in --from) from=$2; shift 2;; --to) to=$2; shift 2;; *) shift;; esac; done", 'cp -a "$from" "$to" || exit 1', `printf '${report}' "$to"`, ""].join("\n"));
  return { folder, verb };
}

/** The host making two local workspaces of that tree through the verb, with the loop's longest gap read meanwhile. */
const copyScript = (home: string, folder: string, verb: string): string => `
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime, jsonFileStore } from ${JSON.stringify(distOf("runtime"))};
import { startHost, localWiring, stateWriterHere } from ${JSON.stringify(DIST)};
import { verbCopier, NoProviderBackend } from ${JSON.stringify(distOf("engine"))};
import { DAEMON_VERSION } from ${JSON.stringify(distOf("protocol"))};

const home = ${JSON.stringify(home)};
const webDir = join(home, "web");
mkdirSync(webDir, { recursive: true });
writeFileSync(join(webDir, "index.html"), '<!doctype html><html><head></head><body><div id="root"></div><script>window.__WSP__ = window.__WSP__ || { token: "" };</script></body></html>');
const statePath = join(home, "state", "state.json");
mkdirSync(join(home, "state"), { recursive: true });
const daemon = async () => ({ version: DAEMON_VERSION, road: { url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }, sysSamples: async () => () => {}, close: async () => {} });
const runtime = createRuntime({
  backend: new NoProviderBackend(),
  local: localWiring(home, undefined, daemon, statePath, verbCopier(${JSON.stringify(verb)})),
  store: jsonFileStore(statePath, stateWriterHere()),
  adapters: {},
});
const host = await startHost({ runtime, webDir, port: 0, statePath });
const project = await host.addProject(${JSON.stringify(folder)});

let last = performance.now();
let maxLagMs = 0;
const probe = setInterval(() => {
  const now = performance.now();
  maxLagMs = Math.max(maxLagMs, now - last - 20);
  last = now;
}, 20);
const started = performance.now();
for (let i = 0; i < 2; i++) await host.createWorkspace("copy " + i, undefined, project.id);
const copyMs = performance.now() - started;
clearInterval(probe);
const copies = readdirSync(home).filter(name => name.startsWith("big-")).map(name => readdirSync(join(home, name, "src")).length);
await host.close();
console.log("measured " + JSON.stringify({ maxLagMs: Math.round(maxLagMs), copyMs: Math.round(copyMs), copies }));
process.exit(0);
`;

const RUN_CAP_MS = 240_000;

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

describeWithDists("a host whose state file has grown", ["host", "runtime", "engine"], () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "wsp-answers-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it(`keeps its loop turning inside ${LOOP_STALL_CAP_MS} ms and holds under ${HELD_CAP_MB} MB while workspaces are made and turns land`, async () => {
    const run = await ran(hostScript(home), home);
    expect(run.code, run.out).toBe(0);
    const line = run.out.split("\n").find(l => l.startsWith("measured "));
    expect(line, run.out).toBeDefined();
    const m = JSON.parse(line!.slice("measured ".length)) as { stateMb: number; maxLagMs: number; heldMb: number; rssMb: number };
    const said = `a ${m.stateMb} MB state file: the loop was held ${m.maxLagMs} ms at most, and the host held ${m.heldMb} MB after (resident ${m.rssMb} MB)`;
    console.log(said);
    expect(m.maxLagMs, said).toBeLessThan(LOOP_STALL_CAP_MS);
    expect(m.heldMb, said).toBeLessThan(HELD_CAP_MB);
  }, 300_000);

  it(`keeps its loop turning inside ${LOOP_STALL_CAP_MS} ms while it makes local copies of a large tree`, async () => {
    const { folder, verb } = bigTree(home);
    const run = await ran(copyScript(home, folder, verb), home);
    expect(run.code, run.out).toBe(0);
    const line = run.out.split("\n").find(l => l.startsWith("measured "));
    expect(line, run.out).toBeDefined();
    const m = JSON.parse(line!.slice("measured ".length)) as { maxLagMs: number; copyMs: number; copies: number[] };
    const said = `two copies of ${TREE_FILES} files and ${TREE_LARGE * 100} MB took ${m.copyMs} ms, and the loop was held ${m.maxLagMs} ms at most`;
    console.log(said);
    expect(m.copies, said).toEqual([TREE_FILES / 1000, TREE_FILES / 1000]);
    expect(m.maxLagMs, said).toBeLessThan(LOOP_STALL_CAP_MS);
  }, 300_000);
});
