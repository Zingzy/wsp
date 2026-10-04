// SPDX-License-Identifier: AGPL-3.0-only
// The commands a slate starts, run for real in a temp folder: values reach them as data and never as code, a secret
// leaves only as a run's environment or stdin and comes back scrubbed, an edited command asks again, a cancel and a
// timeout take the whole process group, and the output caps hold.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlateRuns, restartedRecord, rewoundRecord, type CmdRunDecl, type RunInputs, type RunRecord, type RunStart, type SlateRuns, type SlateRunsDeps } from "../src/slate-runs.js";

const THREAD = "t1";

interface Harness {
  runs: SlateRuns;
  records: { run: string; record: RunRecord }[];
  lines: string[];
  timers: string[];
  /** The run's record once it reads one of these states. */
  until(run: string, states: RunRecord["state"][]): Promise<RunRecord>;
  start(run: string, decl: CmdRunDecl, inputs?: RunInputs, by?: RunStart["by"]): ReturnType<SlateRuns["start"]>;
}

let dir: string;
let made: SlateRuns[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "slate-runs-")));
});
afterEach(() => {
  for (const r of made) r.close();
  made = [];
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function harness(over: Partial<SlateRunsDeps> = {}): Harness {
  const records: Harness["records"] = [];
  const lines: string[] = [];
  const timers: string[] = [];
  const waiting: { run: string; states: RunRecord["state"][]; resolve: (r: RunRecord) => void }[] = [];
  const runs = createSlateRuns({
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir }),
    onRecord: (_t, run, record) => {
      records.push({ run, record });
      for (const w of [...waiting]) {
        if (w.run === run && w.states.includes(record.state)) {
          waiting.splice(waiting.indexOf(w), 1);
          w.resolve(record);
        }
      }
    },
    onLine: (_t, _run, line) => lines.push(line),
    onTimer: (_t, run) => timers.push(run),
    ...over,
  });
  made.push(runs);
  return {
    runs,
    records,
    lines,
    timers,
    until: (run, states) => new Promise(resolve => waiting.push({ run, states, resolve })),
    start: (run, decl, inputs = {}, by = "person") => runs.start({ threadId: THREAD, run, decl, by, folder: dir, inputs: () => inputs }),
  };
}

/** Starts it, approves it for the thread, and answers its finished record. */
async function runAllowed(h: Harness, run: string, decl: CmdRunDecl, inputs: RunInputs = {}): Promise<RunRecord> {
  const ended = h.until(run, ["done", "failed", "cancelled"]);
  const first = h.start(run, decl, inputs);
  if (first.outcome === "held") h.runs.approve(THREAD, run, "always");
  return ended;
}

const cmd = (text: string, more: Partial<CmdRunDecl> = {}): CmdRunDecl => ({ kind: "cmd", cmd: text, ...more });

describe("values reach a command as data", () => {
  const hostile = (d: string): string => `x"; touch ${d}/p1; echo "$(touch ${d}/p2)\`touch ${d}/p3\`' && touch ${d}/p4 #`;

  it("an env value with shell metacharacters is one word and runs nothing", async () => {
    const h = harness();
    const value = hostile(dir);
    const r = await runAllowed(h, "check", cmd(`printf '%s' "$ID"; echo; echo $ID`, { env: { ID: "$id" } }), { env: { ID: { value } } });
    expect(r.state).toBe("done");
    expect(r.out).toBe(`${value}\n${value}\n`);
    for (const p of ["p1", "p2", "p3", "p4"]) expect(existsSync(join(dir, p))).toBe(false);
  });

  it("a positional parameter and stdin carry it the same way", async () => {
    const h = harness();
    const value = hostile(dir);
    const r = await runAllowed(h, "args", cmd(`printf '%s|' "$1" "$2"; cat`, { args: ["$a", "'x'"], stdin: "$body" }), {
      args: [{ value }, { value: "two words" }],
      stdin: { value },
    });
    expect(r.out).toBe(`${value}|two words|${value}`);
    for (const p of ["p1", "p2", "p3", "p4"]) expect(existsSync(join(dir, p))).toBe(false);
  });

  it("null is unset, a list is JSON, and the run sees the login environment with no WSP_ variable", async () => {
    const h = harness({ env: () => ({ PATH: process.env["PATH"] ?? "", HOME: dir, WSP_HOST_TOKEN: "host-token", WSP_TURN: "turn", WSP_HOST_URL: "http://x", WSP_HOST_KEY: "k", KEPT: "yes" }) });
    const r = await runAllowed(h, "env", cmd(`echo "\${GONE-unset} $LIST $KEPT"; pwd; env`, { env: { GONE: "$g", LIST: "$l" } }), {
      env: { GONE: { value: null }, LIST: { value: [1, "a"] } },
    });
    const [first, cwd] = (r.out ?? "").split("\n");
    expect(first).toBe(`unset [1,"a"] yes`);
    expect(cwd).toBe(dir);
    expect(r.out).not.toMatch(/WSP_/);
    expect(r.out).not.toContain("host-token");
  });

  it("a cwd is read against the thread's folder, and a missing one fails with why", async () => {
    const h = harness();
    execFileSync("mkdir", [join(dir, "notes")]);
    expect((await runAllowed(h, "a", cmd("pwd", { cwd: "notes" }))).out).toBe(`${join(dir, "notes")}\n`);
    const r = await runAllowed(h, "b", cmd("pwd", { cwd: "nowhere" }));
    expect(r).toMatchObject({ state: "failed", why: `the folder ${join(dir, "nowhere")} does not exist` });
  });
});

describe("secrets", () => {
  const TOKEN = "vrcl_Ab+9/zz&q=1 ünï_0123456789";

  it("reach a run through env and stdin and are scrubbed from out, err, lines and the record in every form", async () => {
    const h = harness();
    expect(h.runs.secrets.set(THREAD, "token", TOKEN)).toMatchObject({ secret: true, set: true, len: TOKEN.length });
    const script = [
      `echo "plain $TOKEN"`,
      `printf '%s' "$TOKEN" | base64`,
      `printf 'user:%s' "$TOKEN" | base64`,
      `node -e 'console.log(encodeURIComponent(process.env.TOKEN))'`,
      `node -e 'console.log(Buffer.from(process.env.TOKEN).toString("base64url"))'`,
      `echo "err $TOKEN" >&2`,
      `printf 'stdin '; cat; echo`,
    ].join("; ");
    const r = await runAllowed(h, "leak", cmd(script, { env: { TOKEN: "$token" }, stdin: "$token", stream: true }), {
      env: { TOKEN: { secret: "token" } },
      stdin: { secret: "token" },
    });
    expect(r.state).toBe("done");
    const forms = [
      TOKEN,
      Buffer.from(TOKEN).toString("base64"),
      Buffer.from(TOKEN).toString("base64url"),
      encodeURIComponent(TOKEN),
      Buffer.from(`user:${TOKEN}`).toString("base64"),
    ];
    const everything = JSON.stringify({ records: h.records, lines: h.lines });
    for (const f of forms) expect(everything).not.toContain(f);
    // The Basic-header case keeps no more than the bytes that share a base64 group with "user:".
    for (const f of forms.slice(0, 4)) expect(everything).not.toContain(f.slice(4, 16));
    expect(r.out).toContain("plain [secret:token]");
    expect(r.out).toContain("stdin [secret:token]");
    expect(r.err).toBe("err [secret:token]\n");
    expect(h.lines).toContain("plain [secret:token]");
    expect(r.out?.split("\n")[1]).toBe("[secret:token]");
  });

  it("are refused as a positional parameter, which ps can read", async () => {
    const h = harness();
    h.runs.secrets.set(THREAD, "token", TOKEN);
    const r = await runAllowed(h, "argv", cmd(`echo "$1"`, { args: ["$token"] }), { args: [{ secret: "token" }] });
    expect(r).toMatchObject({ state: "failed", why: expect.stringContaining("never as an argument") });
    expect(r.out).toBeUndefined();
  });

  it("the sheet shows dots, never the value", () => {
    const h = harness();
    h.runs.secrets.set(THREAD, "token", TOKEN);
    const a = h.start("save", cmd(`printf 'T=%s' "$TOKEN" > .env`, { env: { TOKEN: "$token" } }), { env: { TOKEN: { secret: "token" } } });
    expect(a.outcome).toBe("held");
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(a.outcome === "held" && a.ask?.env["TOKEN"]).toBe("••••");
  });

  it("an empty text clears one, a short one is still scrubbed, and other threads' secrets are not this thread's", () => {
    const h = harness();
    h.runs.secrets.set(THREAD, "pin", "4321");
    h.runs.secrets.set("t2", "other", "elsewhere-secret");
    expect(h.runs.secrets.scrub(THREAD, "pin 4321 elsewhere-secret")).toBe("pin [secret:pin] elsewhere-secret");
    expect(h.runs.secrets.set(THREAD, "pin", "")).toEqual({ secret: true, set: false, len: 0, at: null });
    expect(h.runs.secrets.scrub(THREAD, "4321")).toBe("4321");
  });

  it("only kept ones reach the file, at 0600, and a new factory reads them back", () => {
    const file = join(dir, "state", "slates.secrets.json");
    const h = harness({ secretsFile: file });
    h.runs.secrets.set(THREAD, "kept", "kept-secret-value", { keep: true });
    h.runs.secrets.set(THREAD, "memory", "memory-secret-value");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).not.toContain("memory-secret-value");
    const again = harness({ secretsFile: file });
    expect(again.runs.secrets.handle(THREAD, "kept").set).toBe(true);
    expect(again.runs.secrets.handle(THREAD, "memory").set).toBe(false);
    again.runs.drop(THREAD);
    expect(readFileSync(file, "utf8")).toBe("{}");
  });
});

describe("consent", () => {
  it("holds until approved, once is not remembered, always is, and an edited command is held again", async () => {
    const h = harness();
    const decl = cmd(`echo "$ID"`, { env: { ID: "$id" } });
    const held = h.start("check", decl, { env: { ID: { value: "1" } } });
    expect(held).toMatchObject({ outcome: "held", record: { state: "held", why: "needs your approval" }, ask: { cmd: `echo "$ID"`, env: { ID: "1" }, folder: dir, timeout: 60 } });
    expect(h.runs.held(THREAD).map(a => a.run)).toEqual(["check"]);

    let ended = h.until("check", ["done"]);
    expect(h.runs.approve(THREAD, "check", "once")?.outcome).toBe("running");
    expect((await ended).out).toBe("1\n");
    expect(h.start("check", decl, { env: { ID: { value: "2" } } }).outcome).toBe("held");

    ended = h.until("check", ["done"]);
    h.runs.approve(THREAD, "check", "always");
    expect((await ended).out).toBe("2\n");
    ended = h.until("check", ["done"]);
    expect(h.start("check", decl, { env: { ID: { value: "3" } } }, "reaction").outcome).toBe("running");
    expect((await ended).out).toBe("3\n");

    const edits: CmdRunDecl[] = [
      { ...decl, cmd: `echo "$ID"; curl evil.example` },
      { ...decl, env: { ID: "$other" } },
      { ...decl, env: { ID: "$id", MORE: "$x" } },
      { ...decl, cwd: ".." },
      { ...decl, stdin: "$id" },
    ];
    for (const edited of edits) expect(h.start("check", edited, { env: { ID: { value: "4" } } }, "reaction").outcome).toBe("held");
    expect(h.runs.allowed(THREAD)).toEqual([h.runs.key(decl)]);
  });

  it("a confirm asks every time, Don't ends it cancelled, and a revoke asks again", async () => {
    const h = harness();
    const sure = cmd("true", { confirm: "Delete the preview?" });
    h.start("sure", sure);
    h.runs.approve(THREAD, "sure", "always");
    await h.until("sure", ["done"]);
    expect(h.start("sure", sure).outcome).toBe("held");
    h.runs.deny(THREAD, "sure");
    expect(h.records.at(-1)?.record).toMatchObject({ state: "cancelled", why: "you said not to run it" });

    const plain = cmd("true");
    h.start("plain", plain);
    h.runs.approve(THREAD, "plain", "always");
    await h.until("plain", ["done"]);
    h.runs.revoke(THREAD, h.runs.key(plain));
    expect(h.start("plain", plain).outcome).toBe("held");
  });

  it("reactions and timers start a run at most 12 times a minute; a press is not counted and a release frees it", async () => {
    const h = harness();
    const decl = cmd("true");
    h.start("r", decl);
    h.runs.approve(THREAD, "r", "always");
    for (let i = 0; i < 12; i++) {
      const ended = h.until("r", ["done"]);
      expect(h.start("r", decl, {}, i % 2 === 0 ? "reaction" : "timer").outcome).toBe("running");
      await ended;
    }
    expect(h.start("r", decl, {}, "reaction")).toMatchObject({ outcome: "held", record: { why: "started 12 times in a minute; press to run it again" } });
    expect(h.start("r", decl, {}, "person").outcome).toBe("running");
    await h.until("r", ["done"]);
    h.runs.release(THREAD);
    expect(h.start("r", decl, {}, "reaction").outcome).toBe("running");
  });
});

/** Every process in a process group, by ps. */
function inGroup(pgid: number): number[] {
  return execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" })
    .split("\n")
    .map(l => l.trim().split(/\s+/).map(Number))
    .filter(([pid, group]) => group === pgid && pid !== undefined)
    .map(([pid]) => pid!);
}

async function settle(check: () => boolean, ms = 3_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return check();
}

describe("process lifetime", () => {
  it("a cancel kills the whole process group and writes cancelled", async () => {
    const h = harness();
    const first = new Promise<number>(resolve => {
      const at = h.lines.length;
      const poll = setInterval(() => {
        if (h.lines.length > at) {
          clearInterval(poll);
          resolve(Number(h.lines[at]));
        }
      }, 20);
    });
    h.start("long", cmd("echo $$; sleep 300 & sleep 301 & bash -c 'sleep 302' & wait", { stream: true }));
    h.runs.approve(THREAD, "long", "always");
    const pgid = await first;
    expect(await settle(() => inGroup(pgid).length >= 4)).toBe(true);
    h.runs.cancel(THREAD, "long");
    expect(h.records.at(-1)?.record).toMatchObject({ state: "cancelled", why: "cancelled", runs: 1 });
    expect(await settle(() => inGroup(pgid).length === 0)).toBe(true);
    expect(inGroup(pgid)).toEqual([]);
  });

  it("a start while it runs restarts it; with once it is a no-op", async () => {
    const h = harness();
    const decl = cmd("echo $$; sleep 300", { stream: true });
    h.start("x", decl);
    h.runs.approve(THREAD, "x", "always");
    await settle(() => h.lines.length === 1);
    const old = Number(h.lines[0]);
    expect(h.start("x", decl).outcome).toBe("running");
    expect(await settle(() => inGroup(old).length === 0)).toBe(true);
    expect(h.start("x", { ...decl, once: true }).outcome).toBe("noop");
    h.runs.stopAll(THREAD, { quiet: true });
  });

  it("a timeout ends the run failed with exit 124 and takes its group", async () => {
    const h = harness();
    const started = Date.now();
    const r = await runAllowed(h, "slow", cmd("echo $$; sleep 30", { timeout: 1 }));
    expect(r).toMatchObject({ state: "failed", exit: 124, why: "timed out after 1 s" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await settle(() => inGroup(Number(r.out?.trim())).length === 0)).toBe(true);
  });

  it("a non-zero exit fails with its code and a JSON out is parsed", async () => {
    const h = harness();
    expect(await runAllowed(h, "bad", cmd("echo nope >&2; exit 3"))).toMatchObject({ state: "failed", exit: 3, why: "exited with 3", err: "nope\n" });
    expect((await runAllowed(h, "json", cmd(`echo '{"id": 7}'`))).json).toEqual({ id: 7 });
  });

  it("keeps the 64 KB tail at a line start, and cuts past 2 MB", async () => {
    const h = harness();
    const r = await runAllowed(h, "big", cmd(`awk 'BEGIN { for (i = 1; i <= 4000; i++) printf "line %05d ${"a".repeat(40)}\\n", i }'`));
    expect(r.out!.length).toBeLessThanOrEqual(64 * 1024);
    expect(r.out!.startsWith("line ")).toBe(true);
    expect(r.out!.trimEnd().endsWith(`line 04000 ${"a".repeat(40)}`)).toBe(true);
    expect(r.cut).toBeUndefined();
    const huge = await runAllowed(h, "huge", cmd("head -c 3000000 /dev/zero | tr '\\0' 'b' | fold -w 99"));
    expect(huge.out!.length).toBeLessThanOrEqual(64 * 1024);
    expect(huge.cut).toBe(true);
  });

  it("a fifth run waits for one of four to end", async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      h.start(`s${i}`, cmd("sleep 0.5"));
      h.runs.approve(THREAD, `s${i}`, "always");
    }
    h.start("fifth", cmd("echo fifth"));
    expect(h.runs.approve(THREAD, "fifth", "always")).toMatchObject({ outcome: "held", record: { why: "4 runs are already running" } });
    expect((await h.until("fifth", ["done"])).out).toBe("fifth\n");
  });

  it("stopAll quiet drops completions and writes nothing; restart and rewind rewrite running records", async () => {
    const h = harness();
    h.start("q", cmd("sleep 300"));
    h.runs.approve(THREAD, "q", "always");
    const count = h.records.length;
    h.runs.stopAll(THREAD, { quiet: true });
    await new Promise(r => setTimeout(r, 300));
    expect(h.records.length).toBe(count);
    const was: RunRecord = { state: "running", runs: 2, startedAt: 1 };
    expect(restartedRecord(was, 9)).toEqual({ state: "failed", why: "the host restarted while it ran", exit: null, runs: 2, startedAt: 1, endedAt: 9 });
    expect(rewoundRecord(was, 9)).toMatchObject({ state: "cancelled", why: "the thread was rewound" });
    expect(restartedRecord({ state: "done", runs: 1 })).toEqual({ state: "done", runs: 1 });
  });
});

describe("timers", () => {
  it("tick only while shown by default, always with always, never under 10 s", () => {
    vi.useFakeTimers();
    const h = harness();
    h.runs.timers(THREAD, [
      { run: "shown", every: 1, key: "k-shown" },
      { run: "always", every: 60, key: "k-always", always: true },
    ]);
    expect(h.timers).toEqual(["always"]);
    vi.advanceTimersByTime(30_000);
    expect(h.timers).toEqual(["always"]);
    h.runs.shown(THREAD, true);
    expect(h.timers.filter(t => t === "shown")).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(h.timers.filter(t => t === "shown")).toHaveLength(4);
    expect(h.timers.filter(t => t === "always")).toHaveLength(2);
    h.runs.shown(THREAD, false);
    vi.advanceTimersByTime(120_000);
    expect(h.timers.filter(t => t === "shown")).toHaveLength(4);
    expect(h.timers.filter(t => t === "always")).toHaveLength(4);
  });
});
