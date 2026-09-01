// wspx: dev CLI over an embedded createRuntime(). The CLI is the first
// protocol client; it never drives the engine directly, proving the runtime
// embeds cleanly (the hosted control plane wraps the same runtime).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import {
  SolariBackend,
  createRuntime,
  jsonFileStore,
  machineExecStream,
  type EventUnion,
  type Runtime,
  type WorkspaceView,
} from "@wsp/runtime";

const CLAUDE_INSTALL = "curl -fsSL https://claude.ai/install.sh | bash";
const CONFIG_DIR = "/root/.claude-cfg";
const cliLabels = (): Record<string, string> => ({ wsp: "1", "wsp-cli": "1", createdAt: new Date().toISOString() });
const RESERVED = { key: "poc", value: "ttl-test" }; // sleeping experiment: never touch

function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [process.cwd(), join(here, "..", "..", ".."), join(here, "..", "..", "..", "..")]) {
    if (existsSync(join(dir, ".env"))) return dir;
  }
  return process.cwd();
}

function loadEnv(root: string): { SOLARI_API_KEY: string; ANTHROPIC_API_KEY: string } {
  const out: Record<string, string> = {};
  const text = readFileSync(join(root, ".env"), "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && m[2]) out[m[1]!] = m[2]!.trim();
  }
  for (const k of ["SOLARI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (!out[k]) throw new Error(`Missing ${k} in .env at ${root}`);
  }
  return out as { SOLARI_API_KEY: string; ANTHROPIC_API_KEY: string };
}

function claudeEnvs(anthropicKey: string): Record<string, string> {
  return {
    ANTHROPIC_API_KEY: anthropicKey,
    CLAUDE_CONFIG_DIR: CONFIG_DIR,
    IS_SANDBOX: "1",
    PATH: "/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

function makeRuntime(): { rt: Runtime; envs: Record<string, string> } {
  const root = repoRoot();
  const env = loadEnv(root);
  const backend = new SolariBackend({ apiKey: env.SOLARI_API_KEY });
  const rt = createRuntime({
    backend,
    store: jsonFileStore(join(root, ".wsp", "state.json")),
    adapters: {
      claude: ctx =>
        createClaudeAdapter({
          exec: machineExecStream(ctx.machine),
          configDir: CONFIG_DIR,
        }),
    },
  });
  return { rt, envs: claudeEnvs(env.ANTHROPIC_API_KEY) };
}

const t0 = Date.now();
function log(msg: string): void {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${msg}`);
}

function fmtMs(ms: number): string {
  return ms < 10_000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

class Timings {
  rows: { step: string; ms: number; note: string }[] = [];
  async time<T>(step: string, fn: () => Promise<T>, note?: (v: T) => string): Promise<T> {
    const start = Date.now();
    const v = await fn();
    this.rows.push({ step, ms: Date.now() - start, note: note ? note(v) : "" });
    return v;
  }
  add(step: string, ms: number, note = ""): void {
    this.rows.push({ step, ms, note });
  }
  print(): void {
    const w1 = Math.max(...this.rows.map(r => r.step.length), 4) + 2;
    console.log("\n" + "step".padEnd(w1) + "time".padEnd(10) + "note");
    console.log("-".repeat(w1 + 10 + 40));
    for (const r of this.rows) console.log(r.step.padEnd(w1) + fmtMs(r.ms).padEnd(10) + r.note);
    console.log("-".repeat(w1 + 10 + 40));
    console.log("TOTAL".padEnd(w1) + fmtMs(this.rows.reduce((a, r) => a + r.ms, 0)));
  }
}

async function ensureGolden(rt: Runtime, envs: Record<string, string>, timings: Timings): Promise<string> {
  const existing = await rt.golden.get();
  if (existing) {
    const head = existing.versions.find(v => v.version === existing.head);
    if (head) {
      timings.add("golden build", 0, `reused v${head.version} (${head.snapshotId})`);
      return head.snapshotId;
    }
  }
  const { version } = await timings.time(
    "golden build",
    () =>
      rt.golden.build({
        setup: CLAUDE_INSTALL,
        smoke: "claude --version",
        cpu: 2,
        memMb: 4096,
        envs,
        labels: cliLabels(),
      }),
    v => `built v${v.version.version} (${v.version.snapshotId})`,
  );
  return version.snapshotId;
}

async function createWorkspace(
  rt: Runtime,
  envs: Record<string, string>,
  timings: Timings,
  name: string,
  golden: string,
  cpu?: number,
): Promise<WorkspaceView> {
  return timings.time(
    `fork ${name}`,
    async () => {
      try {
        return await rt.workspaces.create({ golden, name, envs, labels: cliLabels(), ...(cpu ? { cpu } : {}) });
      } catch (e) {
        if ((e as { kind?: string }).kind !== "missing") throw e;
        log(`golden snapshot ${golden} is gone; rebuilding`);
        const rebuilt = await rt.golden.build({
          setup: CLAUDE_INSTALL,
          smoke: "claude --version",
          cpu: 2,
          memMb: 4096,
          envs,
          labels: cliLabels(),
        });
        return rt.workspaces.create({ golden: rebuilt.version.snapshotId, name, envs, labels: cliLabels() });
      }
    },
    w => `machine ${w.machineId.slice(0, 24)}…`,
  );
}

function watchEvents(rt: Runtime): void {
  rt.events.on("*", (e: EventUnion) => {
    switch (e.type) {
      case "session.start":
        log(`  ${e.workspaceId} session ${e.sessionId.slice(0, 8)} started (${e.model ?? "?"})`);
        return;
      case "session.delta":
        if (e.kind === "tool_use") log(`  ${e.workspaceId} tool ${e.toolName ?? "?"}`);
        return;
      case "session.done":
        log(`  ${e.workspaceId} turn done: ${e.result.status} (${fmtMs(e.result.durationMs ?? 0)})`);
        return;
      default:
        return;
    }
  });
}

async function listMachines(rt: Runtime): Promise<{ id: string; state: string; labels: Record<string, string> }[]> {
  return (await rt.backend.list()).filter(m => m.labels[RESERVED.key] !== RESERVED.value);
}

async function cmdLs(rt: Runtime): Promise<void> {
  const workspaces = await rt.workspaces.list();
  console.log(`workspaces (${workspaces.length}):`);
  for (const w of workspaces) {
    console.log(`  ${w.id}  ${w.name.padEnd(12)}  ${w.phase.padEnd(8)}  machine=${w.machineId.slice(0, 28)}…`);
  }
  const machines = await listMachines(rt);
  console.log(`machines on the account (${machines.length}):`);
  for (const m of machines) {
    console.log(`  ${m.id.slice(0, 40)}…  ${m.state}  wsp=${m.labels["wsp"] ?? "-"}`);
  }
}

async function cmdSend(rt: Runtime, id: string, prompt: string): Promise<void> {
  const ws = await rt.workspaces.get(id);
  rt.events.on("session.delta", e => {
    if (e.type === "session.delta" && e.kind === "text") process.stdout.write(e.text + "\n");
    if (e.type === "session.delta" && e.kind === "tool_use") log(`tool ${e.toolName ?? "?"}`);
  });
  const handle = await rt.sessions.start(id, {
    prompt,
    cwd: "/root",
    ...(ws.claudeSessionId ? { resume: ws.claudeSessionId } : {}),
  });
  const result = await handle.finished;
  log(`turn ${result.status}${result.costUsd !== undefined ? ` ($${result.costUsd.toFixed(4)})` : ""}`);
  if (result.status !== "completed") process.exitCode = 1;
}

// --- the demo -----------------------------------------------------------------

const ESSAY_TASK =
  "Think step by step and write a thorough 1500-word essay on the history of computing " +
  "directly into /root/essay.txt, then write the single word DONE into /root/done.txt";
const MARKER = "wsp demo continuity marker 4217";
const MARKER_TASK = `Create /root/notes.md containing exactly the line '${MARKER}', then reply done.`;

async function cmdDemo(rt: Runtime, envs: Record<string, string>): Promise<void> {
  const timings = new Timings();
  watchEvents(rt);
  let failed: string | undefined;

  const golden = await ensureGolden(rt, envs, timings);
  const a = await createWorkspace(rt, envs, timings, "demo-a", golden);
  const b = await createWorkspace(rt, envs, timings, "demo-b", golden);

  try {
    // Session A: long multi-step task we will nap MID-TURN (P10 replay).
    let aStarted: () => void = () => {};
    const aStartedAt = new Promise<void>(resolve => (aStarted = resolve));
    let aDone = false;
    rt.events.on("session.start", e => {
      if (e.type === "session.start" && e.workspaceId === a.id) aStarted();
    });
    rt.events.on("session.done", e => {
      if (e.type === "session.done" && e.workspaceId === a.id) aDone = true;
    });
    log("starting session A (essay task, will be napped mid-turn)");
    const sessionA = await rt.sessions.start(a.id, { prompt: ESSAY_TASK, cwd: "/root" });

    log("starting session B (marker task, will be upgraded after)");
    const sessionB = await rt.sessions.start(b.id, { prompt: MARKER_TASK, cwd: "/root" });

    // Nap A mid-turn: 8s after the CLI reports the session live it is
    // mid-generation (a 1500-word essay streams for 20s+, PoC P10).
    await aStartedAt;
    await new Promise(r => setTimeout(r, 8_000));
    if (aDone) {
      failed = "task A finished before the nap; mid-turn window missed";
      throw new Error(failed);
    }
    await timings.time(
      "nap A mid-turn",
      () => rt.workspaces.nap(a.id),
      () => "paused with the turn in flight",
    );

    const resultB = await timings.time(
      "task B completes",
      () => sessionB.finished,
      r => `status=${r.status}`,
    );
    if (resultB.status !== "completed") {
      failed = `task B ended ${resultB.status}: ${resultB.error ?? ""}`;
      throw new Error(failed);
    }

    // Hold the nap long enough that the API stream underneath the turn is dead.
    const napHold = 45_000;
    await timings.time(`hold nap (${napHold / 1000}s)`, () => new Promise(r => setTimeout(r, napHold)));
    await timings.time(
      "wake A",
      () => rt.workspaces.wake(a.id),
      w => (w.machineId === a.machineId ? "same machine, RAM intact" : `RESURRECTED as ${w.machineId}`),
    );

    // P10 semantics: the CLI's own retry recovers the dead stream; give the
    // resumed turn up to 240s.
    const resultA = await timings.time(
      "task A completes after wake",
      () =>
        Promise.race([
          sessionA.finished,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("resumed turn did not finish within 240s")), 240_000),
          ),
        ]),
      r => `status=${r.status}`,
    );
    if (resultA.status !== "completed") {
      failed = `task A ended ${resultA.status} after the mid-turn nap: ${resultA.error ?? ""}`;
      throw new Error(failed);
    }
    const doneTxt = await rt.workspaces.exec(a.id, "cat /root/done.txt 2>/dev/null; wc -w < /root/essay.txt");
    log(`A evidence: done.txt+wordcount -> ${doneTxt.stdout.replaceAll("\n", " | ").trim()}`);
    if (!doneTxt.stdout.includes("DONE")) {
      failed = "task A claimed completion but /root/done.txt is missing";
      throw new Error(failed);
    }

    // Upgrade B: vault export -> kill -> fresh golden fork -> vault import.
    const beforeMachine = (await rt.workspaces.get(b.id)).machineId;
    await timings.time(
      "upgrade B (vault + fresh fork)",
      () => rt.workspaces.upgrade(b.id),
      w => `machine ${beforeMachine.slice(0, 12)}… -> ${w.machineId.slice(0, 12)}…`,
    );
    const notes = await rt.workspaces.exec(b.id, "cat /root/notes.md 2>/dev/null");
    log(`B evidence: notes.md -> ${notes.stdout.trim()}`);
    if (!notes.stdout.includes(MARKER)) {
      failed = "file continuity broken: /root/notes.md lost across the upgrade";
      throw new Error(failed);
    }
    timings.add("file continuity check", 0, "notes.md survived the upgrade");
  } catch (e) {
    failed ??= e instanceof Error ? e.message : String(e);
  } finally {
    await timings.time(
      "teardown (delete + reap)",
      async () => {
        for (const w of await rt.workspaces.list()) {
          if (w.name.startsWith("demo-")) await rt.workspaces.delete(w.id).catch(() => {});
        }
        return rt.reap(0);
      },
      reaped => (reaped.length > 0 ? `reaped strays: ${reaped.join(", ")}` : "no strays"),
    );
    const leftover = (await listMachines(rt)).filter(m => m.state === "running");
    timings.add("running machines after", 0, leftover.length === 0 ? "0 (clean)" : `${leftover.length} LEFT OVER`);
    timings.print();
    if (leftover.length > 0) {
      console.error(`\nDEMO FAIL: machines still running: ${leftover.map(m => m.id).join(", ")}`);
      process.exitCode = 1;
    }
  }
  if (failed) {
    console.error(`\nDEMO FAIL: ${failed}`);
    process.exitCode = 1;
  } else {
    console.log("\nDEMO PASS: mid-turn nap survived, upgrade kept files, zero machines left.");
  }
}

// --- entry ----------------------------------------------------------------------

export const HELP = `wspx - dev CLI for wsp workspaces

usage:
  wspx golden build            build (or version-bump) the golden claude image
  wspx new <name> [--cpu N]    fork a workspace from the golden image
  wspx ls                      list workspaces and account machines
  wspx send <id> "<prompt>"    run a claude turn in a workspace (auto-resumes)
  wspx nap <id>                pause a workspace
  wspx wake <id>               resume a workspace (resurrects if it vanished)
  wspx upgrade <id> [--cpu N]  vault files, replace with a fresh golden fork
  wspx rm <id>                 kill a workspace
  wspx reap                    kill unclaimed wsp-labeled machines
  wspx demo                    end-to-end showpiece with a timing table
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      cpu: { type: "string" },
      mem: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  const [cmd, ...rest] = positionals;
  if (values.help || cmd === undefined) {
    console.log(HELP);
    return;
  }

  const { rt, envs } = makeRuntime();
  const cpu = values.cpu !== undefined ? Number(values.cpu) : undefined;

  switch (cmd) {
    case "golden": {
      if (rest[0] !== "build") throw new Error(`unknown golden subcommand: ${rest[0] ?? ""}`);
      const timings = new Timings();
      const { version } = await rt.golden.build({
        setup: CLAUDE_INSTALL,
        smoke: "claude --version",
        cpu: 2,
        memMb: 4096,
        envs,
        labels: cliLabels(),
      });
      timings.add("golden build", 0, `v${version.version} (${version.snapshotId})`);
      log(`golden v${version.version} ready: ${version.snapshotId}`);
      return;
    }
    case "new": {
      const name = rest[0];
      if (!name) throw new Error("usage: wspx new <name> [--cpu N]");
      const timings = new Timings();
      const golden = await ensureGolden(rt, envs, timings);
      const ws = await createWorkspace(rt, envs, timings, name, golden, cpu);
      log(`workspace ${ws.id} (${ws.name}) on machine ${ws.machineId}`);
      timings.print();
      return;
    }
    case "ls":
      await cmdLs(rt);
      return;
    case "send": {
      const [id, prompt] = rest;
      if (!id || !prompt) throw new Error('usage: wspx send <id> "<prompt>"');
      await cmdSend(rt, id, prompt);
      return;
    }
    case "nap": {
      if (!rest[0]) throw new Error("usage: wspx nap <id>");
      const w = await rt.workspaces.nap(rest[0]);
      log(`${w.id} napping`);
      return;
    }
    case "wake": {
      if (!rest[0]) throw new Error("usage: wspx wake <id>");
      const w = await rt.workspaces.wake(rest[0]);
      log(`${w.id} running on ${w.machineId}`);
      return;
    }
    case "upgrade": {
      if (!rest[0]) throw new Error("usage: wspx upgrade <id> [--cpu N]");
      const w = await rt.workspaces.upgrade(rest[0], {
        ...(cpu ? { cpu } : {}),
        ...(values.mem !== undefined ? { memMb: Number(values.mem) } : {}),
      });
      log(`${w.id} upgraded, now on ${w.machineId}`);
      return;
    }
    case "rm": {
      if (!rest[0]) throw new Error("usage: wspx rm <id>");
      await rt.workspaces.delete(rest[0]);
      log(`${rest[0]} deleted`);
      return;
    }
    case "reap": {
      const reaped = await rt.reap(0);
      log(reaped.length > 0 ? `reaped: ${reaped.join(", ")}` : "nothing to reap");
      return;
    }
    case "demo":
      await cmdDemo(rt, envs);
      return;
    default:
      console.log(HELP);
      throw new Error(`unknown command: ${cmd}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
