// SPDX-License-Identifier: AGPL-3.0-only
// A slate's command on the thread's own machine: the launcher run by this computer's bash as a machine's would run
// it, the road over a machine whose exec and run are this computer's bash (putFiles and all), and a box thread's run
// reaching its machine through the runtime while one `on` the host stays here.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecResult, Machine, RunOptions } from "@wsp/engine";
import type { Caller } from "@wsp/protocol";
import { boxLauncher, boxLedger, boxRoad, boxSlateDir } from "../src/slate-box.js";
import { FS_HASH_FILES_MAX } from "@wsp/protocol";
import { boxPins, type HashOn, type HashRead } from "../src/slate-files.js";
import { createSlateRuns, type RoadEnd } from "../src/slate-runs.js";
import { SLATES } from "../src/lazy-slates.js";
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
    mkdirSync(p);
    writeFileSync(`${p}/env`, nul(["NAME", value, "SLATE_DIR", "/tmp/s"]));
    writeFileSync(`${p}/args`, nul(["a b", "$(touch pwned-arg)", ""]));
    writeFileSync(`${p}/in`, Buffer.from("in put\nsecond").toString("base64"));
    const cmd = `printf '%s|' "$NAME" "$1" "$2" "$3" "$#" "$SLATE_DIR"; echo; cat; echo; pwd; ls -a ${JSON.stringify(dir)} | grep -c run || true`;
    const out = execFileSync("bash", ["-c", boxLauncher({ payload: p, cwd: dir, cmd })], { cwd: tmpdir(), encoding: "utf8" });
    // The values whole, the arguments counted, stdin as typed, the folder, and no file of the values left behind.
    expect(out).toBe(`${value}|a b|$(touch pwned-arg)||3|/tmp/s|\nin put\nsecond\n${dir}\n0\n`);
    for (const pwned of ["pwned-env", "pwned-env2", "pwned-arg"]) expect(existsSync(join(dir, pwned))).toBe(false);
  });

  it("says plainly when the folder is not on the machine", () => {
    const dir = temp();
    const p = join(dir, ".run-y");
    mkdirSync(p);
    for (const name of ["env", "args", "in"]) writeFileSync(`${p}/${name}`, "");
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

  it("the folder a run's values go up in is the account's alone before they are decoded into it", async () => {
    const base = bashMachine();
    const modes: number[] = [];
    const machine: Machine = {
      ...base,
      run: (script, opts) => {
        const payload = /^p='([^']+)'$/m.exec(script)?.[1];
        if (payload !== undefined) modes.push(statSync(payload).mode & 0o777);
        return base.run(script, opts);
      },
    };
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const end = await ended(done => boxRoad(machine, thread, () => ({})).start({ cmd: "true", args: [], cwd: temp(), env: { TOKEN: "s" }, stdin: "", timeoutS: 20, stream: false }, { line: () => {}, end: done }));
    expect(end).toMatchObject({ code: 0 });
    expect(modes).toEqual([0o700]);
  });

  it("values a box left when it stopped answering go once it answers, and every contact sweeps stale values but a run's in flight", async () => {
    const machine = bashMachine();
    let down = false;
    let gate: (() => void) | undefined;
    const exec = machine.exec.bind(machine);
    const run = machine.run.bind(machine);
    machine.exec = (cmd, opts) => (down ? Promise.reject(new Error("the link went")) : exec(cmd, opts));
    machine.run = async (script, opts) => {
      if (script.includes("LINK_GOES")) {
        down = true;
        throw new Error("the link went");
      }
      if (script.includes("GATED")) await new Promise<void>(r => (gate = r));
      return run(script, opts);
    };
    const ledger = boxLedger(200);
    const [one, two, three] = [1, 2, 3].map(n => `t-${n}-${Date.now()}-${Math.random().toString(36).slice(2)}`) as [string, string, string];
    for (const t of [one, two, three]) made.push(boxSlateDir(t));
    const runsIn = (t: string): string[] => (existsSync(boxSlateDir(t)) ? readdirSync(boxSlateDir(t)).filter(n => n.startsWith(".run-")) : []);
    const go = (t: string, cmd: string, env: Record<string, string> = {}): Promise<RoadEnd> =>
      ended(done => boxRoad(machine, t, () => ({}), async () => {}, ledger).start({ cmd, args: [], cwd: temp(), env, timeoutS: 20, stream: false }, { line: () => {}, end: done }));

    // The link goes after the values went up: they stay, owed, and go on the retry once the box answers again.
    expect((await go(one, "echo LINK_GOES", { TOKEN: "s3cret" })).error?.message).toBe("the link went");
    expect(runsIn(one)).toHaveLength(1);
    expect(ledger.owed(machine)).toHaveLength(1);
    down = false;
    await vi.waitFor(() => expect(runsIn(one)).toHaveLength(0), { timeout: 5_000 });
    expect(ledger.owed(machine)).toHaveLength(0);

    // Stale values in another thread's folder go at the next contact; the values of a run still starting stay.
    mkdirSync(join(boxSlateDir(two), ".run-stale"), { recursive: true });
    writeFileSync(join(boxSlateDir(two), ".run-stale", "env"), "s3cret");
    const gated = go(one, 'echo GATED "$TOKEN"', { TOKEN: "still here" });
    await vi.waitFor(() => expect(gate).toBeDefined());
    expect(runsIn(one)).toHaveLength(1);
    expect((await go(three, "echo hi")).out).toBe("hi\n");
    expect(runsIn(two)).toHaveLength(0);
    expect(runsIn(one)).toHaveLength(1);
    gate!();
    expect((await gated).out).toBe("GATED still here\n");
    expect(runsIn(one)).toHaveLength(0);
    ledger.close();
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

  it("a press on a box whose turns and runs the host is still settling reaches the machine only once that is done", async () => {
    const machine = bashMachine();
    let open!: () => void;
    const settled = { at: false };
    const booted = new Promise<void>(resolve => (open = resolve)).then(() => void (settled.at = true));
    const early: string[] = [];
    const run = machine.run.bind(machine);
    machine.run = (script, opts) => (settled.at ? undefined : early.push(script), run(script, opts));
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const slates = createSlates({
      store: memoryStore(),
      now: () => Date.now(),
      record: () => {},
      emit: () => {},
      thread: () => ({ workspaceId: "w1", rootThreadId: thread, sessionId: "s1", folder: temp(), hostFolder: temp(), computer: "spoo" }),
      machineOf: () => machine,
      wake: () => booted,
      under: lead => [lead],
      threadOfToken: () => thread,
      sources: (threadId, workspaceId) => ({ threadId, workspaceId, now: Date.now(), rows: () => [] }) as never,
      deliver: async () => ({ outcome: "started" }),
      runEnv: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    });
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId: thread, workspaceId: "w1", rootThreadId: thread } };
    await slates.write({ text: `<slate title="Held"><value name="go" start={0} />
  <run name="box" cmd="echo ran" timeout={20} />
  <when change={$go} do={start($box)} />
  <column><output run={$box} /></column>
</slate>` }, asThread);
    await slates.state({ threadId: thread, values: { $go: 1 } });
    for (const ask of (await slates.get(thread))!.asks) await slates.approve({ threadId: thread, key: ask.key, scope: "thread" });
    const value = async () => (await slates.get(thread))!.values["box"] as { state: string; out?: string };
    await new Promise(r => setTimeout(r, 500));
    open();
    for (let i = 0; i < 100 && (await value()).state !== "done"; i++) await new Promise(r => setTimeout(r, 100));
    expect(await value()).toMatchObject({ state: "done", out: "ran\n" });
    expect(early).toEqual([]);
    slates.close();
  }, 30_000);

  it("a then on the box gets the raw result and SLATE_DIR, never the env its command was given", async () => {
    const machine = bashMachine();
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const slates = createSlates({
      store: memoryStore(),
      now: () => Date.now(),
      record: () => {},
      emit: () => {},
      thread: () => ({ workspaceId: "w1", rootThreadId: thread, sessionId: "s1", folder: temp(), hostFolder: temp(), computer: "spoo" }),
      machineOf: () => machine,
      under: lead => [lead],
      threadOfToken: () => thread,
      sources: (threadId, workspaceId) => ({ threadId, workspaceId, now: Date.now(), rows: () => [] }) as never,
      deliver: async () => ({ outcome: "started" }),
      runEnv: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    });
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId: thread, workspaceId: "w1", rootThreadId: thread } };
    await slates.write({ text: `<slate title="Then"><value name="go" start={0} /><value name="token" start="s3cret-token" />
  <run name="fetch" cmd='printf "%s" "$TOKEN" | wc -c' env={{ TOKEN: $token }} then='printf "{\\"raw\\":\\"%s\\",\\"token\\":\\"%s\\",\\"dir\\":\\"%s\\"}" "$(cat | tr -d " \\n")" "$TOKEN" "$SLATE_DIR"' timeout={20} />
  <when change={$go} do={start($fetch)} />
  <column><output run={$fetch} /></column>
</slate>` }, asThread);
    await slates.state({ threadId: thread, values: { $go: 1 } });
    for (const ask of (await slates.get(thread))!.asks) await slates.approve({ threadId: thread, key: ask.key, scope: "thread" });
    const value = async () => (await slates.get(thread))!.values["fetch"] as { state: string; json?: unknown; why?: string };
    for (let i = 0; i < 100 && !["done", "failed"].includes((await value()).state); i++) await new Promise(r => setTimeout(r, 100));
    expect(await value()).toMatchObject({ state: "done", json: { raw: "12", token: "", dir: boxSlateDir(thread) } });
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

describe("a box thread's image", () => {
  it("is read through that computer's daemon by its whole path there, a relative one under the thread's folder there, never off this computer's disk", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
    const here = temp();
    writeFileSync(join(here, "home.png"), png);
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const asked: string[] = [];
    const slates = createSlates({
      store: memoryStore(),
      now: () => Date.now(),
      record: () => {},
      emit: () => {},
      thread: () => ({ workspaceId: "w1", rootThreadId: thread, sessionId: "s1", folder: "/root/acme", hostFolder: here, computer: "spoo" }),
      machineOf: () => bashMachine(),
      imageOn: () => ({
        name: "spoo",
        read: async path => {
          asked.push(path);
          if (path === "/root/acme/shots/home.png") return { size: png.length, mediaType: "image/png", content: png.toString("base64") };
          throw Object.assign(new Error(`${path} does not exist`), { code: "not-found" });
        },
      }),
      under: lead => [lead],
      threadOfToken: () => thread,
      sources: (threadId, workspaceId) => ({ threadId, workspaceId, now: Date.now(), rows: () => [] }) as never,
      deliver: async () => ({ outcome: "started" }),
      runEnv: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
    });
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId: thread, workspaceId: "w1", rootThreadId: thread } };
    await slates.write({ text: `<slate><column><image src="shots/home.png" /></column></slate>` }, asThread);
    expect(await slates.image({ threadId: thread, src: "shots/home.png" })).toMatchObject({ mediaType: "image/png", bytes: png.toString("base64") });
    const gone = await slates.image({ threadId: thread, src: join(here, "home.png") });
    expect("problem" in gone && `${gone.problem.code} ${gone.problem.message}`).toBe(`R900 no file at ${join(here, "home.png")}`);
    expect(asked).toEqual(["/root/acme/shots/home.png", join(here, "home.png")]);
    slates.close();
  });
});

describe("an Always for a box thread's command", () => {
  it("covers the script an on=host command names in this computer's folder, and is not offered for one that names a file on the box", async () => {
    const machine = bashMachine();
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const hereFolder = temp();
    const boxFolder = temp();
    const script = join(boxFolder, ".wsp-system-resources.py");
    writeFileSync(join(hereFolder, "deploy.sh"), "echo one");
    writeFileSync(script, "print('one')");
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
    await slates.write({ text: `<slate title="Deploy">
  <run name="here" cmd="bash deploy.sh" on="host" timeout={20} />
  <run name="there" cmd="python3 ${script}" timeout={20} />
  <column><button id="h" label="Here" onPress={start($here)} /><button id="t" label="There" onPress={start($there)} /></column>
</slate>` }, asThread);
    const press = async (piece: string) => slates.event({ threadId: thread, version: (await slates.get(thread))!.version, piece, event: "press", requestId: `${piece}-${Math.random()}` });
    const done = async (run: string, out: string) => vi.waitFor(async () => expect((await slates.get(thread))!.values[run]).toMatchObject({ state: "done", out }), { timeout: 10_000 });

    const here = await press("h");
    expect(here.ask).not.toHaveProperty("noAlways");
    await slates.approve({ threadId: thread, key: here.ask!.key, scope: "thread" });
    await done("here", "one\n");
    writeFileSync(join(hereFolder, "deploy.sh"), "echo two");
    expect((await press("h")).ask).toBeDefined();

    // The sheet offers Run once and Don't alone, so no choice it offers is refused; Run once runs it on the box.
    const there = await press("t");
    expect(there.ask).toMatchObject({ run: "there", noAlways: true });
    expect((await slates.get(thread))!.asks.find(a => a.run === "there")).toMatchObject({ noAlways: true });
    await slates.approve({ threadId: thread, key: there.ask!.key, scope: "once" });
    await done("there", "one\n");
    // No command line verb or tool approves a slate; another caller of slates.approve that asks for an Always is told why.
    const again = await press("t");
    await expect(slates.approve({ threadId: thread, key: again.ask!.key, scope: "thread" })).rejects.toThrow(/\.wsp-system-resources\.py there, which its computer could not hash/);
    slates.close();
  }, 30_000);
});

/** A box daemon's fs.hash over this computer's disk: each path under the root where it lands, a regular file, and
 * the paths as handed that land on a file outside it or on one past the cap. */
const hashHere: HashOn = async (root, paths) => {
  const top = realpathSync(root);
  const read = { files: {} as Record<string, string>, outside: [] as string[], past: [] as string[] };
  for (const path of paths) {
    try {
      const at = realpathSync(isAbsolute(path) ? path : join(root, path));
      const rel = relative(top, at);
      if (rel === "" || !statSync(at).isFile() || read.files[rel] !== undefined) continue;
      if (rel.startsWith("..")) read.outside.push(path);
      else if (Object.keys(read.files).length >= FS_HASH_FILES_MAX) read.past.push(path);
      else read.files[rel] = createHash("sha256").update(readFileSync(at)).digest("hex");
    } catch {
      // not there
    }
  }
  return read;
};

describe("an Always for a command on the box, pinned by its daemon's hash", () => {
  const boxThread = (hashOn: HashOn | undefined, o: { asleep?: () => boolean; wake?: () => Promise<void>; here?: true } = {}) => {
    const machine = bashMachine();
    const thread = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    made.push(boxSlateDir(thread));
    const folder = temp();
    const store = memoryStore();
    const open = () =>
      createSlates({
        store,
        now: () => Date.now(),
        record: () => {},
        emit: () => {},
        thread: () => ({ workspaceId: "w1", rootThreadId: thread, sessionId: "s1", folder, hostFolder: temp(), computer: "acme-box" }),
        ...(o.here === true ? {} : { machineOf: () => machine }),
        ...(hashOn !== undefined ? { hashOn: () => hashOn } : {}),
        ...(o.asleep !== undefined ? { asleep: o.asleep } : {}),
        ...(o.wake !== undefined ? { wake: o.wake } : {}),
        under: lead => [lead],
        threadOfToken: () => thread,
        sources: (threadId, workspaceId) => ({ threadId, workspaceId, now: Date.now(), rows: () => [] }) as never,
        deliver: async () => ({ outcome: "started" }),
        runEnv: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin" }),
      });
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId: thread, workspaceId: "w1", rootThreadId: thread } };
    const on = (slates: ReturnType<typeof open>) => ({
      press: async (piece: string) => slates.event({ threadId: thread, version: (await slates.get(thread))!.version, piece, event: "press", requestId: `${piece}-${Math.random()}` }),
      done: async (run: string, runs: number) => vi.waitFor(async () => expect((await slates.get(thread))!.values[run]).toMatchObject({ state: "done", runs }), { timeout: 10_000 }),
      askOf: async (run: string) => (await slates.get(thread))!.asks.find(a => a.run === run),
    });
    return { thread, folder, store, open, asThread, on };
  };

  it("holds across a reopen with no second ask, and asks again once the script on the box changes", async () => {
    const asked: string[][] = [];
    const box = boxThread(async (root, paths) => {
      asked.push(paths);
      return hashHere(root, paths);
    });
    writeFileSync(join(box.folder, "stats.sh"), "echo one");
    let slates = box.open();
    await slates.write({ text: `<slate><run name="stats" cmd="bash stats.sh" timeout={20} /><column><button id="s" label="Stats" onPress={start($stats)} /></column></slate>` }, box.asThread);
    let s = box.on(slates);

    const first = await s.press("s");
    expect(first.ask).toMatchObject({ run: "stats" });
    expect(first.ask).not.toHaveProperty("noAlways");
    expect(await s.askOf("stats")).not.toHaveProperty("noAlways");
    await slates.approve({ threadId: box.thread, key: first.ask!.key, scope: "thread" });
    await s.done("stats", 1);
    expect((await s.press("s")).ask).toBeUndefined();
    await s.done("stats", 2);
    slates.close();

    // A host that opens the same record reads the box again and finds the script the person allowed.
    slates = box.open();
    s = box.on(slates);
    expect((await s.press("s")).ask).toBeUndefined();
    await s.done("stats", 3);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(paths => paths.join() === `${box.folder}/stats.sh`)).toBe(true);

    writeFileSync(join(box.folder, "stats.sh"), "echo two");
    const changed = await s.press("s");
    expect(changed.ask).toMatchObject({ run: "stats" });
    expect(await s.askOf("stats")).toMatchObject({ why: "stats.sh changed since you allowed it, so it asks again" });
    expect(await s.askOf("stats")).not.toHaveProperty("noAlways");
    slates.close();
  }, 30_000);

  it("takes an Always for df -h / and sleep 0.5, which name no file inside the thread's folder", async () => {
    let fails = false;
    const box = boxThread(async (root, paths) => {
      if (fails) throw new Error("the box did not answer");
      return hashHere(root, paths);
    });
    const slates = box.open();
    await slates.write({ text: `<slate><run name="disk" cmd="df -h /" timeout={20} /><run name="nap" cmd="sleep 0.5" timeout={20} /><column><button id="d" label="Disk" onPress={start($disk)} /><button id="n" label="Nap" onPress={start($nap)} /></column></slate>` }, box.asThread);
    const s = box.on(slates);
    for (const [piece, run] of [["d", "disk"], ["n", "nap"]] as const) {
      const held = await s.press(piece);
      expect(held.ask).toMatchObject({ run });
      expect(await s.askOf(run)).not.toHaveProperty("noAlways");
      await slates.approve({ threadId: box.thread, key: held.ask!.key, scope: "thread" });
      await s.done(run, 1);
      expect((await s.press(piece)).ask).toBeUndefined();
      await s.done(run, 2);
    }
    fails = true;
    expect((await s.press("d")).ask).toBeDefined();
    expect(await s.askOf("disk")).toMatchObject({ noAlways: true, why: "/ could not be read on acme-box, so it asks again" });
    slates.close();
  }, 30_000);

  it("offers no Always for a command naming a script where the daemon cannot hash, and refuses one asked for", async () => {
    // What a daemon from before fs.hash answers, measured against one built from the base.
    const box = boxThread(async () => {
      throw new Error("unknown op: fs.hash");
    });
    writeFileSync(join(box.folder, "stats.sh"), "echo one");
    const slates = box.open();
    await slates.write({ text: `<slate><run name="stats" cmd="bash stats.sh" timeout={20} /><column><button id="s" label="Stats" onPress={start($stats)} /></column></slate>` }, box.asThread);
    const s = box.on(slates);
    const held = await s.press("s");
    expect(held.ask).toMatchObject({ run: "stats", noAlways: true });
    expect(await s.askOf("stats")).toMatchObject({ noAlways: true });
    await expect(slates.approve({ threadId: box.thread, key: held.ask!.key, scope: "thread" })).rejects.toThrow(/names stats\.sh there, which its computer could not hash/);
    await slates.approve({ threadId: box.thread, key: held.ask!.key, scope: "once" });
    await s.done("stats", 1);
    expect((await s.press("s")).ask).toMatchObject({ noAlways: true });
    slates.close();
  }, 30_000);

  const STATS = `<slate><run name="stats" cmd="bash stats.sh" timeout={20} /><column><button id="s" label="Stats" onPress={start($stats)} /></column></slate>`;

  it("asks when the read fails, even under an Always given before the script was there", async () => {
    let fails = false;
    const box = boxThread(async (root, paths) => {
      if (fails) throw new Error("unknown op: fs.hash");
      return hashHere(root, paths);
    });
    const slates = box.open();
    await slates.write({ text: STATS }, box.asThread);
    const s = box.on(slates);
    const first = await s.press("s");
    await slates.approve({ threadId: box.thread, key: first.ask!.key, scope: "thread" });
    // No stats.sh yet: bash fails, and the Always holds a key with no script in it.
    await vi.waitFor(async () => expect((await slates.get(box.thread))!.values["stats"]).toMatchObject({ state: "failed", runs: 1 }), { timeout: 10_000 });
    writeFileSync(join(box.folder, "stats.sh"), "echo evil");
    fails = true;
    expect((await s.press("s")).ask).toMatchObject({ run: "stats" });
    expect(await s.askOf("stats")).toMatchObject({ noAlways: true });
    expect((await slates.get(box.thread))!.values["stats"]).toMatchObject({ state: "held" });
    slates.close();
  }, 30_000);

  it("says the script could not be read there, not that it changed, when a read fails under an Always", async () => {
    let fails = false;
    const box = boxThread(async (root, paths) => {
      if (fails) throw new Error("the box did not answer");
      return hashHere(root, paths);
    });
    writeFileSync(join(box.folder, "stats.sh"), "echo one");
    const slates = box.open();
    await slates.write({ text: STATS }, box.asThread);
    const s = box.on(slates);
    const first = await s.press("s");
    await slates.approve({ threadId: box.thread, key: first.ask!.key, scope: "thread" });
    await s.done("stats", 1);
    fails = true;
    expect((await s.press("s")).ask).toBeDefined();
    expect(await s.askOf("stats")).toMatchObject({ noAlways: true, why: "stats.sh could not be read on acme-box, so it asks again" });
    slates.close();
  }, 30_000);

  for (const where of ["box", "here"] as const) {
    it(`reads the scripts of a run with cwd in the folder it runs in, so an edit there asks again (${where})`, async () => {
      const box = boxThread(hashHere, where === "here" ? { here: true } : {});
      mkdirSync(join(box.folder, "scripts"));
      writeFileSync(join(box.folder, "scripts", "stats.sh"), "echo one");
      const slates = box.open();
      await slates.write({ text: `<slate><run name="stats" cmd="bash stats.sh" cwd="scripts" timeout={20} /><column><button id="s" label="Stats" onPress={start($stats)} /></column></slate>` }, box.asThread);
      const s = box.on(slates);
      const first = await s.press("s");
      expect(await s.askOf("stats")).not.toHaveProperty("noAlways");
      await slates.approve({ threadId: box.thread, key: first.ask!.key, scope: "thread" });
      await s.done("stats", 1);
      expect((await s.press("s")).ask).toBeUndefined();
      await s.done("stats", 2);
      writeFileSync(join(box.folder, "scripts", "stats.sh"), "echo evil");
      expect((await s.press("s")).ask).toMatchObject({ run: "stats" });
      expect(await s.askOf("stats")).toMatchObject({ why: "scripts/stats.sh changed since you allowed it, so it asks again" });
      slates.close();
    }, 30_000);
  }

  it("wakes a napping machine for a press and holds to a standing Always there", async () => {
    let asleep = false;
    const seen: string[] = [];
    const box = boxThread(
      async (root, paths) => {
        seen.push(asleep ? "hash asleep" : "hash");
        return hashHere(root, paths);
      },
      {
        asleep: () => asleep,
        wake: async () => {
          seen.push("wake");
          asleep = false;
        },
      },
    );
    writeFileSync(join(box.folder, "stats.sh"), "echo one");
    const slates = box.open();
    await slates.write({ text: STATS }, box.asThread);
    const s = box.on(slates);
    const first = await s.press("s");
    await slates.approve({ threadId: box.thread, key: first.ask!.key, scope: "thread" });
    await s.done("stats", 1);
    asleep = true;
    seen.length = 0;
    expect((await s.press("s")).ask).toBeUndefined();
    await s.done("stats", 2);
    // Woken before the box is read; the road's own wake before the run follows.
    expect(seen.slice(0, 2)).toEqual(["wake", "hash"]);
    expect(seen).not.toContain("hash asleep");
    slates.close();
  }, 30_000);

  it("a held ask keeps its Always across a reopen", async () => {
    const box = boxThread(hashHere);
    writeFileSync(join(box.folder, "stats.sh"), "echo one");
    let slates = box.open();
    await slates.write({ text: STATS }, box.asThread);
    await box.on(slates).press("s");
    expect(await box.on(slates).askOf("stats")).not.toHaveProperty("noAlways");
    slates.close();
    slates = box.open();
    const s = box.on(slates);
    await vi.waitFor(async () => {
      const ask = await s.askOf("stats");
      expect(ask).toBeDefined();
      expect(ask).not.toHaveProperty("noAlways");
    });
    await slates.approve({ threadId: box.thread, key: (await s.askOf("stats"))!.key, scope: "thread" });
    await s.done("stats", 1);
    slates.close();
  }, 30_000);

  /** A slate with one button pressing $run, whose command is cmd. */
  const oneRun = (cmd: string) => `<slate><run name="run" cmd="${cmd}" timeout={20} /><column><button id="r" label="Run" onPress={start($run)} /></column></slate>`;
  /** Scripts s0.sh to s32.sh in the folder, one more than an Always pins, and a command that runs them all. */
  const pastTheCap = (folder: string, write: (n: number) => boolean = () => true): string => {
    const names = Array.from({ length: FS_HASH_FILES_MAX + 1 }, (_, n) => `s${n}.sh`);
    names.forEach((name, n) => write(n) && writeFileSync(join(folder, name), `echo ${n}`));
    return `cat ${names.join(" ")} | bash`;
  };
  const LAST = `s${FS_HASH_FILES_MAX}.sh`;

  for (const where of ["box", "here"] as const) {
    const cases: { name: string; lay: (folder: string) => string; why: string }[] = [
      {
        name: "a script through a link out of the folder",
        lay: folder => {
          writeFileSync(join(folder, "..", `away-${where}.sh`), "echo away");
          symlinkSync(join(folder, "..", `away-${where}.sh`), join(folder, "out.sh"));
          return "bash ./out.sh";
        },
        why: "./out.sh is a link out of the thread's folder, so wsp cannot pin it and it asks every time",
      },
      { name: "a script named outside the folder", lay: () => "bash ../away.sh", why: "../away.sh is outside the thread's folder, so wsp cannot pin it and it asks every time" },
      { name: "an absolute path to a script outside the folder", lay: () => "python3 /opt/acme/stats.py", why: "/opt/acme/stats.py is outside the thread's folder, so wsp cannot pin it and it asks every time" },
      { name: "a script past the 32 files one command pins", lay: folder => pastTheCap(folder), why: `${LAST} is past the 32 files one command can pin, so wsp cannot pin it and it asks every time` },
    ];
    for (const c of cases) {
      it(`offers Don't and Run once only for ${c.name}, saying why, and refuses an Always (${where})`, async () => {
        const box = boxThread(hashHere, where === "here" ? { here: true } : {});
        const slates = box.open();
        await slates.write({ text: oneRun(c.lay(box.folder)) }, box.asThread);
        const s = box.on(slates);
        const held = await s.press("r");
        expect(held.ask).toMatchObject({ run: "run", noAlways: true });
        expect(await s.askOf("run")).toMatchObject({ noAlways: true, why: c.why });
        await expect(slates.approve({ threadId: box.thread, key: held.ask!.key, scope: "thread" })).rejects.toThrow(/names a script wsp cannot pin/);
        await slates.approve({ threadId: box.thread, key: held.ask!.key, scope: "once" });
        await vi.waitFor(async () => expect((await slates.get(box.thread))!.values["run"]).toMatchObject({ runs: 1 }), { timeout: 10_000 });
        expect((await s.press("r")).ask).toMatchObject({ noAlways: true });
        slates.close();
      }, 30_000);
    }

    it(`an Always given while the script was absent stops holding once it is a link out or past the cap (${where})`, async () => {
      for (const [cmd, lay, why] of [
        ["bash ./out.sh", (folder: string) => {
          writeFileSync(join(folder, "..", `away-${where}.sh`), "echo evil");
          symlinkSync(join(folder, "..", `away-${where}.sh`), join(folder, "out.sh"));
        }, "./out.sh is a link out of the thread's folder, so wsp cannot pin it and it asks every time"],
        [undefined, (folder: string) => writeFileSync(join(folder, LAST), "echo evil"), `${LAST} is past the 32 files one command can pin, so wsp cannot pin it and it asks every time`],
      ] as const) {
        const box = boxThread(hashHere, where === "here" ? { here: true } : {});
        const slates = box.open();
        await slates.write({ text: oneRun(cmd ?? pastTheCap(box.folder, n => n < FS_HASH_FILES_MAX)) }, box.asThread);
        const s = box.on(slates);
        const first = await s.press("r");
        expect(first.ask).not.toHaveProperty("noAlways");
        await slates.approve({ threadId: box.thread, key: first.ask!.key, scope: "thread" });
        await vi.waitFor(async () => expect((await slates.get(box.thread))!.values["run"]).toMatchObject({ runs: 1 }), { timeout: 10_000 });
        lay(box.folder);
        expect((await s.press("r")).ask).toMatchObject({ run: "run", noAlways: true });
        expect(await s.askOf("run")).toMatchObject({ why });
        expect((await slates.get(box.thread))!.values["run"]).toMatchObject({ state: "held", runs: 1 });
        slates.close();
      }
    }, 30_000);

    it(`an Always stored before this change for a script outside the folder asks again, naming it (${where})`, async () => {
      const box = boxThread(hashHere, where === "here" ? { here: true } : {});
      writeFileSync(join(box.folder, "..", "away.sh"), "echo evil");
      let slates = box.open();
      await slates.write({ text: oneRun("bash ../away.sh") }, box.asThread);
      slates.close();
      // The key every host before this change gave the command: nothing inside the folder, so no hashes in it.
      const before = createSlateRuns({ env: () => ({}), onRecord: () => {}, onLine: () => {}, onTimer: () => {} });
      const key = before.key({ kind: "cmd", cmd: "bash ../away.sh", timeout: 20 });
      before.close();
      const stored = (await box.store.get(SLATES, box.thread)) as { approvals: Record<string, unknown> };
      await box.store.put(SLATES, box.thread, { ...stored, approvals: { [key]: { state: "allowed", at: Date.now(), run: "run", cmd: "bash ../away.sh" } } });
      slates = box.open();
      const s = box.on(slates);
      expect((await s.press("r")).ask).toMatchObject({ run: "run", noAlways: true });
      expect(await s.askOf("run")).toMatchObject({ why: "../away.sh is outside the thread's folder, so wsp cannot pin it and it asks every time" });
      expect((await slates.get(box.thread))!.values["run"]).toMatchObject({ state: "held" });
      slates.close();
    }, 30_000);
  }

  for (const where of ["box", "here"] as const) {
    it(`keeps an Always for tools and interpreters a command names outside the folder, none of them a script it runs (${where})`, async () => {
      const box = boxThread(hashHere, where === "here" ? { here: true } : {});
      mkdirSync(join(box.folder, ".venv", "bin"), { recursive: true });
      symlinkSync(execFileSync("bash", ["-c", "command -v python3"], { encoding: "utf8" }).trim(), join(box.folder, ".venv", "bin", "python3.12"));
      writeFileSync(join(box.folder, "stats.py"), "print('one')");
      const slates = box.open();
      await slates.write({ text: oneRun("cat /proc/loadavg; /usr/bin/env true; tail -n 1 ../notes.txt; .venv/bin/python3.12 stats.py") }, box.asThread);
      const s = box.on(slates);
      const held = await s.press("r");
      expect(held.ask).not.toHaveProperty("noAlways");
      await slates.approve({ threadId: box.thread, key: held.ask!.key, scope: "thread" });
      await vi.waitFor(async () => expect((await slates.get(box.thread))!.values["run"]).toMatchObject({ runs: 1 }), { timeout: 10_000 });
      expect((await s.press("r")).ask).toBeUndefined();
      slates.close();
    }, 30_000);
  }

  it("leaves a command unpinned where the daemon does not answer in time, and asks nothing of a napping computer", async () => {
    const decl = { kind: "cmd" as const, cmd: "bash stats.sh" };
    let calls = 0;
    const pins = boxPins(
      () => async () => {
        calls += 1;
        return new Promise<HashRead>(() => {});
      },
      20,
    );
    const unpinned = (cmd: typeof decl | { kind: "cmd"; cmd: string }) => pins.pin("t1", "/root/acme", cmd).unpinned.map(u => u.path);
    await pins.read("t1", [{ folder: "/root/acme", decl }], false);
    expect(unpinned(decl)).toEqual(["stats.sh"]);
    await pins.read("t1", [{ folder: "/root/acme", decl }], true);
    expect(calls).toBe(1);
    expect(unpinned({ kind: "cmd", cmd: "df -h" })).toEqual([]);
  });
});
