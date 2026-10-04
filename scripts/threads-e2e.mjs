#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Drives real agent threads on a throwaway host and times what a person feels: a send until the agent's first output,
// a stop until the thread takes the next send, and a send that meets a running turn. Every check names a wrong state
// (a lost or doubled message, a row left Working, a stop that did not stop, a queued message that never ran).
//
//   node scripts/threads-e2e.mjs [--agent codex|claude]... [--scenario <name>]... [--runs <n>] [--keep]
//
// Spends real tokens on the agents signed in on this computer. Builds nothing: run the packages' build first, and put
// the daemon binary where the host looks for it (packages/wspx/daemon/<triple>/wsp-daemon), since without it the host
// takes no snapshot and a timing run measures a launch no person gets; the run refuses to start without it. The host
// asks side questions of its own (a thread's title), which can outlive its last turn: the end of a run waits for
// every process under the run's folder and names any still there.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(repo, "packages/host/dist/bin.js");
const { dialHost, daemonBinaryHere } = await import(join(repo, "packages/host/dist/index.js"));

const { values: flags } = parseArgs({
  options: {
    agent: { type: "string", multiple: true },
    scenario: { type: "string", multiple: true },
    runs: { type: "string", default: "1" },
    keep: { type: "boolean", default: false },
  },
});
const agents = flags.agent ?? ["codex", "claude"];
const runs = Number(flags.runs);
try {
  daemonBinaryHere();
} catch (e) {
  console.error(`${e instanceof Error ? e.message : String(e)}; the host takes no snapshot without it, so nothing here would time the launch a person gets`);
  process.exit(1);
}

// A thread launched by wsp carries its host's address and token, and a dial reads those before the state file: the
// host and every line here get an environment with nothing of the caller's in it, so nothing reaches a live host.
const cleanEnv = { HOME: homedir(), PATH: process.env.PATH ?? "/usr/bin:/bin" };

const dir = mkdtempSync(join(tmpdir(), "threads-e2e-"));
const state = join(dir, "state.json");
const proj = join(dir, "proj");
mkdirSync(proj);
writeFileSync(join(proj, "README.md"), "# scratch\n");
execFileSync("git", ["init", "-q"], { cwd: proj });
execFileSync("git", ["-c", "user.email=e2e@wsp.invalid", "-c", "user.name=e2e", "commit", "-qm", "init", "--allow-empty"], { cwd: proj });

const wsp = (...args) => spawnSync(process.execPath, [bin, "--state", state, ...args], { env: cleanEnv, encoding: "utf8" });
let hostPid;
let hostErr = "";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => performance.now();
const ms = t => Math.round(t);

/** A host on this run's state, its stderr kept beside it, answered once its lock names it. */
async function startHost() {
  const host = spawn(process.execPath, [bin, "up", "--state", state, "--port", "0"], { env: cleanEnv, stdio: ["ignore", "ignore", "pipe"] });
  hostPid = host.pid;
  host.stderr.on("data", d => {
    hostErr += d;
    appendFileSync(join(dir, "host.err"), d);
  });
  for (let i = 0; i < 100; i++) {
    try {
      const lock = JSON.parse(readFileSync(join(dir, "host.lock"), "utf8"));
      if (lock.pid === hostPid && lock.port > 0 && readFileSync(join(dir, "host-token"))) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`host never served: ${hostErr}`);
}

/** The one socket every scenario asks through, its events folded into the run's list. */
async function connect() {
  client = await dialHost(state, { env: {}, home: dir });
  client.onFrame(f => {
    if (typeof f.type === "string" && f.type.startsWith("session.")) onEvent(f);
  });
  await client.events();
}

/** The host goes as a restart takes it down: the turns it runs go on, each in a process of its own. */
async function hostGoes() {
  client.close();
  process.kill(hostPid, "SIGTERM");
  for (let i = 0; i < 100 && isAlive(hostPid); i++) await sleep(100);
  if (isAlive(hostPid)) throw new Error(`host ${hostPid} did not stop on SIGTERM`);
}

/** Every process whose command names this run's folder: the host, its turns and its side questions. Read only. */
const underRun = () =>
  spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(l => l.includes(dir) && !l.includes("ps -axo"));

const findings = [];
const timings = [];
const fault = (agent, scenario, what) => {
  findings.push({ agent, scenario, what });
  console.log(`  FAULT ${agent} ${scenario}: ${what}`);
};
const time = (agent, scenario, metric, value) => {
  timings.push({ agent, scenario, metric, ms: value === undefined ? undefined : ms(value) });
  console.log(`  ${metric.padEnd(28)} ${value === undefined ? "never" : `${ms(value)} ms`}`);
};

let client;
const events = [];
const waiters = new Set();
function onEvent(e) {
  events.push({ at: now(), e });
  for (const w of [...waiters]) if (w.test(e)) (waiters.delete(w), w.done(e));
}
function until(test, timeoutMs = 120_000, label = "event") {
  const seen = events.find(x => test(x.e));
  if (seen) return Promise.resolve(seen.e);
  return new Promise((done, fail) => {
    const w = { test, done: e => (clearTimeout(timer), done(e)) };
    const timer = setTimeout(() => (waiters.delete(w), fail(new Error(`timed out waiting for ${label}`))), timeoutMs);
    waiters.add(w);
  });
}
const firstAfter = (since, test) => events.find(x => x.at >= since && test(x.e));
const OUTPUT = new Set(["text", "thinking", "tool_use"]);
const isOutput = (e, threadId) => e.type === "session.delta" && e.threadId === threadId && OUTPUT.has(e.kind);
const textOf = threadId =>
  events
    .filter(x => x.e.type === "session.delta" && x.e.threadId === threadId && x.e.kind === "text")
    .map(x => x.e.text)
    .join("\n");

const request = (op, params) => client.request(op, params);
const rows = async threadId => (await request("sessions.list", {})).sessions.filter(s => s.threadId === threadId);
const runningRow = async threadId => (await rows(threadId)).find(s => s.status === "running");
const workspaceOf = new Map();
let seq = 0;
const rid = () => `e2e-${process.pid}-${++seq}`;

/** One send the way the app makes it: sessions.start with the thread named, or none to open one. */
async function send(agent, prompt, threadId) {
  const requestId = rid();
  const t0 = now();
  const reply = await request("sessions.start", { prompt, requestId, ...(threadId === undefined ? { project: "proj", harness: agent } : { workspaceId: workspaceOf.get(threadId), thread: threadId }) });
  workspaceOf.set(reply.session.threadId ?? threadId, reply.session.workspaceId);
  return { requestId, t0, replyAt: now(), outcome: reply.outcome, threadId: reply.session.threadId ?? threadId, sessionId: reply.session.id, turnId: reply.turnId };
}

/** Waits for the thread to read idle on the host: its latest turn ended and no row says running. */
async function settled(threadId, timeoutMs = 180_000) {
  const t0 = now();
  for (;;) {
    const list = await rows(threadId);
    if (list.length > 0 && list.every(r => r.status !== "running")) return now() - t0;
    if (now() - t0 > timeoutMs) return undefined;
    await sleep(150);
  }
}

/** The prompts the host took for a thread, by request id: each must be exactly one start or one steer. */
function taken(threadId, requestId) {
  return events.filter(x => (x.e.type === "session.start" || x.e.type === "session.steer") && x.e.threadId === threadId && x.e.requestId === requestId).length;
}

function checkOnce(agent, scenario, threadId, sent) {
  for (const s of sent) {
    const n = taken(threadId, s.requestId);
    if (n !== 1) fault(agent, scenario, `message ${JSON.stringify(s.word)} taken ${n} times (want 1)`);
  }
}

async function checkIdle(agent, scenario, threadId) {
  const left = await settled(threadId, 60_000);
  if (left === undefined) fault(agent, scenario, `a row still reads running 60 s after the last end`);
}

const LONG = secs => `Run exactly this shell command and nothing else: sleep ${secs}. When it finishes reply with the single word FINISHED.`;
const WORD = w => `Reply with the single word ${w} and nothing else. Do not run any tool.`;

/** The process a turn's sleep runs in, found by its unique length; read only, never signalled. */
const sleepAlive = secs => {
  const out = spawnSync("ps", ["-axo", "pid,ppid,pgid,etime,command"], { encoding: "utf8" }).stdout;
  const hits = out.split("\n").filter(l => new RegExp(`(^|\\s|')sleep ${secs}($|\\s|')`).test(l) && !l.includes("ps -axo"));
  if (hits.length > 0) {
    const lineOf = pid => out.split("\n").find(l => l.trim().split(/\s+/)[0] === pid);
    const parentOf = line => line?.trim().split(/\s+/)[1];
    const chain = hits.flatMap(hit => [lineOf(parentOf(hit)), lineOf(parentOf(lineOf(parentOf(hit))))]).filter(l => l !== undefined);
    console.log(`  still there, with the two processes above each:\n    ${[...hits, ...chain].map(l => l.slice(0, 160)).join("\n    ")}`);
  }
  return hits.length > 0;
};

/** When the host spawned the first process after t0: a turn runs as `bash <run folder>/<id>.sh`, and a send's
 * launch comes before the title question its first turn asks. Read off ps every 50 ms, so it is good to that. */
function spawnWatch() {
  const before = new Set(agentLines().map(l => l.pid));
  const t0 = now();
  let seen;
  const timer = setInterval(() => {
    if (seen === undefined && agentLines().some(l => !before.has(l.pid))) seen = now() - t0;
  }, 50);
  return () => (clearInterval(timer), seen);
  function agentLines() {
    const out = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout;
    return out
      .split("\n")
      .filter(l => new RegExp(`^\\s*\\d+ bash ${dir}/\\S+\\.sh`).test(l))
      .map(l => ({ pid: l.trim().split(/\s+/)[0] }));
  }
}

const scenarios = {
  /** A thread's first turn, then a follow-up on the idle thread: the second is the turn's restart. */
  async fresh(agent) {
    const spawnedA = spawnWatch();
    const a = await send(agent, WORD("ALPHA"));
    time(agent, "fresh", "send->host reply", a.replyAt - a.t0);
    await until(e => e.type === "session.start" && e.requestId === a.requestId, 60_000, "start");
    time(agent, "fresh", "send->agent spawned", spawnedA());
    time(agent, "fresh", "send->session.start", firstAfter(a.t0, e => e.type === "session.start" && e.requestId === a.requestId).at - a.t0);
    await until(e => isOutput(e, a.threadId), 120_000, "first output");
    time(agent, "fresh", "send->first output", firstAfter(a.t0, e => isOutput(e, a.threadId)).at - a.t0);
    await until(e => e.type === "session.end" && e.threadId === a.threadId, 120_000, "end");
    time(agent, "fresh", "send->end", firstAfter(a.t0, e => e.type === "session.end" && e.threadId === a.threadId).at - a.t0);
    await settled(a.threadId);
    const spawnedB = spawnWatch();
    const b = await send(agent, WORD("BRAVO"), a.threadId);
    if (b.outcome !== "started") fault(agent, "fresh", `follow-up on an idle thread came back ${b.outcome}`);
    time(agent, "fresh", "follow-up send->host reply", b.replyAt - b.t0);
    await until(e => e.type === "session.start" && e.requestId === b.requestId, 60_000, "follow-up start");
    time(agent, "fresh", "follow-up send->agent spawned", spawnedB());
    time(agent, "fresh", "follow-up send->session.start", firstAfter(b.t0, e => e.type === "session.start" && e.requestId === b.requestId).at - b.t0);
    await until(e => isOutput(e, a.threadId) && events.find(x => x.e === e).at > b.t0, 120_000, "follow-up output");
    time(agent, "fresh", "follow-up send->first output", firstAfter(b.t0, e => isOutput(e, a.threadId)).at - b.t0);
    await until(e => e.type === "session.end" && e.threadId === a.threadId && e.turnId === b.turnId, 120_000, "follow-up end");
    time(agent, "fresh", "follow-up send->end", firstAfter(b.t0, e => e.type === "session.end" && e.turnId === b.turnId).at - b.t0);
    checkOnce(agent, "fresh", a.threadId, [{ ...a, word: "ALPHA" }, { ...b, word: "BRAVO" }]);
    const text = textOf(a.threadId);
    for (const w of ["ALPHA", "BRAVO"]) if (!text.includes(w)) fault(agent, "fresh", `no reply carried ${w}`);
    await checkIdle(agent, "fresh", a.threadId);
    return a.threadId;
  },

  /** A stop mid-command: how long until the stop answers, the turn ends, and the command's process is gone. */
  async stop(agent) {
    const secs = 40 + Math.floor(Math.random() * 50);
    const a = await send(agent, LONG(secs));
    await until(e => e.type === "session.delta" && e.threadId === a.threadId && e.kind === "tool_use", 120_000, "the sleep's tool call");
    await sleep(1500);
    const row = await runningRow(a.threadId);
    if (row === undefined) return fault(agent, "stop", "no running row while the command ran");
    const t0 = now();
    const out = await request("sessions.interrupt", { sessionId: row.id });
    time(agent, "stop", "stop->host reply", now() - t0);
    if (out.outcome !== "accepted") fault(agent, "stop", `stop answered ${out.outcome}`);
    const end = await until(e => e.type === "session.end" && e.threadId === a.threadId, 30_000, "end after stop").catch(() => undefined);
    const done = firstAfter(t0, e => e.type === "session.done" && e.threadId === a.threadId);
    time(agent, "stop", "stop->turn done", done === undefined ? undefined : done.at - t0);
    time(agent, "stop", "stop->session.end", end === undefined ? undefined : firstAfter(t0, e => e === end).at - t0);
    const idle = await settled(a.threadId, 30_000);
    time(agent, "stop", "stop->row idle", idle === undefined ? undefined : now() - t0);
    const answered = now();
    await sleep(1500);
    if (sleepAlive(secs)) fault(agent, "stop", `sleep ${secs} still running after the stop`);
    if (events.some(x => x.at > answered && x.e.threadId === a.threadId && x.e.type === "session.delta")) fault(agent, "stop", "output after the stop answered");
    return a.threadId;
  },

  /** Stop and send at once, the way a person does it: the stop is not awaited before the send. */
  async stopSend(agent) {
    const secs = 40 + Math.floor(Math.random() * 50);
    const a = await send(agent, LONG(secs));
    await until(e => e.type === "session.delta" && e.threadId === a.threadId && e.kind === "tool_use", 120_000, "the sleep's tool call");
    await sleep(1500);
    const row = await runningRow(a.threadId);
    if (row === undefined) return fault(agent, "stopSend", "no running row while the command ran");
    const t0 = now();
    const stopped = request("sessions.interrupt", { sessionId: row.id }).then(o => ({ o, at: now() }));
    const b = await send(agent, WORD("CHARLIE"), a.threadId);
    const s = await stopped;
    time(agent, "stopSend", "stop->host reply", s.at - t0);
    console.log(`  send outcome                 ${b.outcome}`);
    const out = await until(e => isOutput(e, a.threadId) && e.type === "session.delta" && events.find(x => x.e === e).at > b.t0 && e.turnId !== a.turnId, 120_000, "CHARLIE output").catch(() => undefined);
    time(agent, "stopSend", "send->first output", out === undefined ? undefined : firstAfter(b.t0, x => x === out).at - b.t0);
    await settled(a.threadId);
    if (sleepAlive(secs)) fault(agent, "stopSend", `sleep ${secs} still running after the stop`);
    if (!textOf(a.threadId).includes("CHARLIE")) fault(agent, "stopSend", "the send after the stop was never answered");
    checkOnce(agent, "stopSend", a.threadId, [{ ...b, word: "CHARLIE" }]);
    await checkIdle(agent, "stopSend", a.threadId);
    return a.threadId;
  },

  /** A send that meets a running turn: it steers in or queues behind, and is answered either way. */
  async during(agent) {
    const secs = 12 + Math.floor(Math.random() * 8);
    const a = await send(agent, LONG(secs));
    await until(e => e.type === "session.delta" && e.threadId === a.threadId && e.kind === "tool_use", 120_000, "the sleep's tool call");
    const b = await send(agent, "Also, once the command is done, say the word DELTA.", a.threadId);
    time(agent, "during", "send->host reply", b.replyAt - b.t0);
    console.log(`  send outcome                 ${b.outcome}`);
    await settled(a.threadId);
    await sleep(500);
    await settled(a.threadId);
    if (!textOf(a.threadId).includes("DELTA")) fault(agent, "during", "the send during the turn was never answered");
    checkOnce(agent, "during", a.threadId, [{ ...b, word: "DELTA" }]);
    await checkIdle(agent, "during", a.threadId);
    return a.threadId;
  },

  /** A host that goes the moment it took a send, inside the launch's snapshot, and one that comes back on the same
   * state: the turn it re-opens runs once with its own message and ends. Twice, the second on a later turn of the
   * thread, whose row still names the message that opened it. */
  async restart(agent) {
    const a = await send(agent, WORD("INDIA"));
    const words = ["INDIA"];
    for (const next of [undefined, "JULIET"]) {
      if (next !== undefined) {
        await send(agent, WORD(next), a.threadId);
        words.push(next);
      }
      await hostGoes();
      const t0 = now();
      await startHost();
      await connect();
      time(agent, "restart", "host back", now() - t0);
      const idle = await settled(a.threadId, 180_000);
      time(agent, "restart", "host back->row idle", idle === undefined ? undefined : now() - t0);
      if (idle === undefined) return fault(agent, "restart", "the thread still reads running 180 s after the host came back");
      const latest = (await rows(a.threadId)).at(-1);
      if (latest?.status !== "completed") fault(agent, "restart", `the turn ended ${latest?.status}${latest?.reason !== undefined ? `: ${latest.reason}` : ""}`);
    }
    const written = (await request("sessions.history", { workspaceId: workspaceOf.get(a.threadId) })).events;
    for (const w of words) {
      const replies = written.filter(e => e.threadId === a.threadId && e.type === "session.delta" && e.kind === "text" && e.text.includes(w)).length;
      if (replies !== 1) fault(agent, "restart", `the transcript holds ${replies} replies carrying ${w} (want 1)`);
    }
    return a.threadId;
  },

  /** Several sends in a burst on an idle thread: each runs once, in order, and the thread ends idle. */
  async burst(agent) {
    const a = await send(agent, WORD("ECHO"));
    await settled(a.threadId);
    const words = ["FOXTROT", "GOLF", "HOTEL"];
    const sent = await Promise.all(words.map(async (w, i) => ({ ...(await (async () => (await sleep(i * 60), send(agent, WORD(w), a.threadId)))()), word: w })));
    console.log(`  burst outcomes               ${sent.map(s => s.outcome).join(" ")}`);
    const done = await settled(a.threadId, 240_000);
    if (done === undefined) fault(agent, "burst", "the thread never settled after the burst");
    await sleep(800);
    await settled(a.threadId);
    checkOnce(agent, "burst", a.threadId, sent);
    const text = textOf(a.threadId);
    for (const w of words) if (!text.includes(w)) fault(agent, "burst", `no reply carried ${w}`);
    await checkIdle(agent, "burst", a.threadId);
    return a.threadId;
  },
};

const picked = flags.scenario ?? Object.keys(scenarios);
process.once("SIGINT", () => {
  console.log("\ninterrupted: stopping the host and its turns");
  void cleanup().finally(() => process.exit(130));
});
let failed = false;
try {
  await startHost();
  const add = wsp("add", proj);
  if (add.status !== 0) throw new Error(`wsp add failed: ${add.stderr}`);
  await connect();
  for (const agent of agents) {
    for (let run = 0; run < runs; run++) {
      for (const name of picked) {
        console.log(`${agent} ${name}${runs > 1 ? ` run ${run + 1}` : ""}`);
        try {
          await scenarios[name](agent);
        } catch (e) {
          fault(agent, name, `harness: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await cleanup();
}

/** Every turn is over before the host goes, so no agent is left running on a host that no longer reads it. */
async function cleanup() {
  // Bounded, since the socket may be the one a failed scenario left with nothing behind it.
  const stopTurns = async () => {
    const left = (await request("sessions.list", {})).sessions.filter(s => s.status === "running");
    for (const r of left) await request("sessions.interrupt", { sessionId: r.id }).catch(() => {});
  };
  await Promise.race([stopTurns().catch(() => {}), sleep(15_000)]);
  client?.close();
  wsp("down");
  for (let i = 0; i < 50 && isAlive(hostPid); i++) await sleep(100);
  if (isAlive(hostPid)) process.kill(hostPid, "SIGTERM");
  for (let i = 0; i < 300 && underRun().length > 0; i++) await sleep(100);
  for (const line of underRun()) console.log(`still running 30 s after the host went, not signalled: ${line.trim().slice(0, 160)}`);
  writeFileSync(join(dir, "results.json"), JSON.stringify({ timings, findings }, null, 2));
  console.log(`\n${findings.length} fault(s); timings in ${join(dir, "results.json")}, the host's stderr in ${join(dir, "host.err")}`);
  if (!flags.keep) rmSync(proj, { recursive: true, force: true });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
process.exit(failed || findings.length > 0 ? 1 : 0);
