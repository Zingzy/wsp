// SPDX-License-Identifier: AGPL-3.0-only
// A slate's command on the thread's own machine: the launcher run by this computer's bash as a machine's would run
// it, the road over a machine whose exec and run are this computer's bash (putFiles and all), and a box thread's run
// reaching its machine through the runtime while one `on` the host stays here.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecResult, Machine, RunOptions } from "@wsp/engine";
import type { Caller } from "@wsp/protocol";
import { boxLauncher, boxRoad, boxSlateDir } from "../src/slate-box.js";
import type { RoadEnd } from "../src/slate-runs.js";
import { createSlates } from "../src/slates.js";
import { memoryStore } from "../src/store.js";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "slate-box-")));
  made.push(dir);
  return dir;
};
const nul = (items: string[]): string => Buffer.from(items.map(i => `${i}\0`).join("")).toString("base64");

/** This computer's bash as a machine: exec runs a command to its end, run runs a script, streaming its lines, killed
 * at its deadline or on its signal as a detached run on a box is. */
function bashMachine(): Machine & { killed: () => boolean } {
  let killed = false;
  return {
    id: "m1",
    kind: "sandbox",
    killed: () => killed,
    async exec(cmd: string, opts?: { stdin?: Uint8Array }): Promise<ExecResult> {
      try {
        const stdout = execFileSync("bash", ["-c", cmd], { input: opts?.stdin, encoding: "utf8" });
        return { exitCode: 0, stdout, stderr: "" };
      } catch (e) {
        const x = e as { status?: number; stdout?: string; stderr?: string };
        return { exitCode: x.status ?? 1, stdout: x.stdout ?? "", stderr: x.stderr ?? "" };
      }
    },
    run(script: string, opts: RunOptions): Promise<ExecResult> {
      return new Promise(resolve => {
        const child = spawn("bash", ["-c", script], { detached: true });
        let out = "";
        let err = "";
        let code: number | undefined;
        const lines = (chunk: Buffer, into: "out" | "err"): void => {
          const text = chunk.toString("utf8");
          if (into === "out") out += text;
          else err += text;
          for (const line of text.split("\n").filter(Boolean)) opts.onLine?.(line);
        };
        child.stdout.on("data", c => lines(c as Buffer, "out"));
        child.stderr.on("data", c => lines(c as Buffer, "err"));
        const end = (exit: number): void => {
          code ??= exit;
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // already gone
          }
        };
        const deadline = setTimeout(() => end(124), opts.deadlineMs);
        opts.signal?.addEventListener("abort", () => {
          killed = true;
          end(130);
        });
        child.on("close", exit => {
          clearTimeout(deadline);
          resolve({ exitCode: code ?? exit ?? -1, stdout: out, stderr: err });
        });
      });
    },
  } as unknown as Machine & { killed: () => boolean };
}

describe("the launcher a machine runs", () => {
  it("hands the command its values as environment, positional parameters and stdin, whole, runs none of them, and leaves none on disk", () => {
    const dir = temp();
    const p = join(dir, ".run-x");
    const value = 'two\nlines "$HOME" `touch pwned-env` $(touch pwned-env2)';
    writeFileSync(`${p}.env`, nul(["NAME", value, "SLATE_DIR", "/tmp/s"]));
    writeFileSync(`${p}.args`, nul(["a b", "$(touch pwned-arg)", ""]));
    writeFileSync(`${p}.in`, Buffer.from("in put\nsecond").toString("base64"));
    const cmd = `printf '%s|' "$NAME" "$1" "$2" "$3" "$#" "$SLATE_DIR"; echo; cat; echo; pwd; ls -a ${JSON.stringify(dir)} | grep -c run || true`;
    const out = execFileSync("bash", ["-c", boxLauncher({ payload: p, cwd: dir, cmd })], { cwd: tmpdir(), encoding: "utf8" });
    // The values whole, the arguments counted, stdin as typed, the folder, and no file of the values left behind.
    expect(out).toBe(`${value}|a b|$(touch pwned-arg)||3|/tmp/s|\nin put\nsecond\n${dir}\n0\n`);
    for (const pwned of ["pwned-env", "pwned-env2", "pwned-arg"]) expect(existsSync(join(dir, pwned))).toBe(false);
  });

  it("says plainly when the folder is not on the machine", () => {
    const dir = temp();
    const p = join(dir, ".run-y");
    for (const ext of ["env", "args", "in"]) writeFileSync(`${p}.${ext}`, "");
    let said = "";
    try {
      execFileSync("bash", ["-c", boxLauncher({ payload: p, cwd: "/nowhere/at/all", cmd: "true" })], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      said = String((e as { stderr?: string }).stderr);
    }
    expect(said).toBe("the folder /nowhere/at/all does not exist\n");
  });
});

describe("the road to a thread's machine", () => {
  const ended = (start: (end: (o: RoadEnd) => void) => void): Promise<RoadEnd> => new Promise(resolve => start(resolve));

  it("writes the slate's files to its folder there, sweeping what the record no longer holds, and runs the command with its values, folder and lines", async () => {
    const machine = bashMachine();
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dir = boxSlateDir(thread);
    made.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stale.py"), "old");
    const cwd = temp();
    const road = boxRoad(machine, thread, () => ({ "hi.sh": "echo from the file" }));
    expect(road.slateDir).toBe(dir);
    const lines: string[] = [];
    const end = await ended(done =>
      road.start({ cmd: `sh "$SLATE_DIR/hi.sh"; printf '%s|%s\\n' "$X" "$1"; pwd; cat`, args: ["$(touch nope)"], cwd, env: { SLATE_DIR: dir, X: "x y" }, stdin: "IN", timeoutS: 20, stream: true }, { line: (_s, text) => lines.push(text), end: done }),
    );
    expect(end).toMatchObject({ code: 0, timedOut: false, cut: false });
    expect(end.out).toBe(`from the file\nx y|$(touch nope)\n${cwd}\nIN`);
    expect(lines).toEqual(["from the file", "x y|$(touch nope)", cwd, "IN"]);
    expect(readFileSync(join(dir, "hi.sh"), "utf8")).toBe("echo from the file");
    expect(existsSync(join(dir, "stale.py"))).toBe(false);
    expect(execFileSync("bash", ["-c", `ls -a ${JSON.stringify(dir)}`], { encoding: "utf8" })).not.toContain(".run-");
  });

  it("a kill cancels the command on the machine, and a then reshapes there", async () => {
    const machine = bashMachine();
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const road = boxRoad(machine, thread, () => ({}));
    const t0 = Date.now();
    const end = await ended(done => {
      const started = road.start({ cmd: "sleep 30", args: [], cwd: temp(), env: {}, timeoutS: 60, stream: false }, { line: () => {}, end: done });
      setTimeout(() => started.kill(), 500);
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(machine.killed()).toBe(true);
    expect(end.code).toBe(130);
    const shaped = await road.reshape({ cmd: `printf '{"got":"%s"}' "$(cat)"`, input: "a b", cwd: temp(), env: {}, timeoutS: 20, scrub: t => t }).done;
    expect(shaped).toEqual({ json: { got: "a b" } });
  });
});

describe("a box thread's slate", () => {
  it("runs a command on the thread's own machine, in its folder there with SLATE_DIR there, and one on the host here", async () => {
    const machine = bashMachine();
    const scripts: string[] = [];
    const run = machine.run.bind(machine);
    machine.run = (script, opts) => (scripts.push(script), run(script, opts));
    const boxFolder = temp();
    const hereFolder = temp();
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const slates = createSlates({
      store: memoryStore(),
      now: () => Date.now(),
      record: () => {},
      emit: () => {},
      thread: () => ({ workspaceId: "w1", rootThreadId: thread, sessionId: "s1", folder: boxFolder, hostFolder: hereFolder, computer: "spoo" }),
      machineOf: () => machine,
      under: lead => [lead],
      threadOfToken: () => thread,
      sources: (threadId, workspaceId) => ({ threadId, workspaceId, now: Date.now(), rows: () => [] }) as never,
      deliver: async () => ({ outcome: "started" }),
      runEnv: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    });
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId: thread, workspaceId: "w1", rootThreadId: thread } };
    await slates.write({ text: `<slate title="Where"><value name="go" start={0} />
  <run name="box" cmd='pwd; printf %s "$SLATE_DIR"; cat "$SLATE_DIR/note.txt"' timeout={20} />
  <run name="here" cmd="pwd" on="host" timeout={20} />
  <when change={$go} do={[start($box), start($here)]} />
  <column><output run={$box} /><output run={$here} /></column>
  <file name="note.txt">{\`kept\`}</file>
</slate>` }, asThread);
    await slates.state({ threadId: thread, values: { $go: 1 } });
    for (const ask of (await slates.get(thread))!.asks) await slates.approve({ threadId: thread, key: ask.key, scope: "thread" });
    const value = async (run: string) => (await slates.get(thread))!.values[run] as { state: string; out?: string };
    for (let i = 0; i < 100 && ((await value("box")).state !== "done" || (await value("here")).state !== "done"); i++) await new Promise(r => setTimeout(r, 100));
    expect(await value("box")).toMatchObject({ state: "done", out: `${boxFolder}\n${boxSlateDir(thread)}kept` });
    expect(await value("here")).toMatchObject({ state: "done", out: `${hereFolder}\n` });
    // One launcher reached the machine, the box run's; the host run never went there.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain(`exec bash -c 'pwd; printf %s "$SLATE_DIR"; cat "$SLATE_DIR/note.txt"'`);
    slates.close();
  }, 30_000);

  it("a tick on a napping box wakes nothing and runs nothing, saying so, and a press wakes it and runs there", async () => {
    const machine = bashMachine();
    const scripts: string[] = [];
    const run = machine.run.bind(machine);
    machine.run = (script, opts) => (scripts.push(script), run(script, opts));
    let asleep = true;
    let woke = 0;
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const folder = temp();
    const slates = createSlates({
      store: memoryStore(),
      now: () => Date.now(),
      record: () => {},
      emit: () => {},
      thread: () => ({ workspaceId: "w1", rootThreadId: thread, sessionId: "s1", folder, hostFolder: folder, computer: "spoo" }),
      machineOf: () => machine,
      asleep: () => asleep,
      wake: async () => {
        woke += 1;
        asleep = false;
      },
      under: lead => [lead],
      threadOfToken: () => thread,
      sources: (threadId, workspaceId) => ({ threadId, workspaceId, now: Date.now(), rows: () => [] }) as never,
      deliver: async () => ({ outcome: "started" }),
      runEnv: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    });
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId: thread, workspaceId: "w1", rootThreadId: thread } };
    const wrote = await slates.write({ text: `<slate title="Feed"><run name="feed" cmd="echo fed" every={60} timeout={20} /><column><output run={$feed} /><button id="go" label="Now" onPress={start($feed)} /></column></slate>` }, asThread);
    // Shown: the timer ticks at once, onto a napping box.
    slates.subscribe({ threadId: thread, sources: [] });
    const feed = async () => (await slates.get(thread))!.values["feed"] as { state: string; why?: string; out?: string };
    for (let i = 0; i < 50 && (await feed()).state !== "held"; i++) await new Promise(r => setTimeout(r, 50));
    expect(await feed()).toMatchObject({ state: "held", why: "the box was asleep, so this tick did not wake it; press to run it now" });
    expect((await slates.get(thread))!.asks).toEqual([]);
    expect({ woke, scripts: scripts.length }).toEqual({ woke: 0, scripts: 0 });
    // The person presses: approved, the box wakes once, and the command runs there.
    const pressed = await slates.event({ threadId: thread, version: wrote.version, piece: "go", event: "press", requestId: "p1" });
    await slates.approve({ threadId: thread, key: pressed.ask!.key, scope: "thread" });
    for (let i = 0; i < 100 && (await feed()).state !== "done"; i++) await new Promise(r => setTimeout(r, 50));
    expect(await feed()).toMatchObject({ state: "done", out: "fed\n" });
    expect({ woke, scripts: scripts.length }).toEqual({ woke: 1, scripts: 1 });
    slates.close();
  }, 30_000);
});
