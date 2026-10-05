// SPDX-License-Identifier: AGPL-3.0-only
// One agent process serving a thread's turns one after another: the real Claude and Codex adapters over this
// computer's runs, each driving an agent stub that names the process every reply came from.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { createCodexAdapter } from "@wsp/adapter-codex";
import type { AdapterEvent, ExecStreamFactory } from "@wsp/protocol";
import { localExecStream } from "../src/local-exec.js";
import { claudeKeeper, codexKeeper, pidOf } from "./kept-stubs.js";
import { alive, gone, sweepStrays } from "./strays.js";
import { until } from "./until.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wsp-kept-"));
});
afterEach(async () => {
  // A case that failed leaves its agent waiting on a message that never comes; every run under the folder ends here.
  await localExecStream({ root, runDir: join(root, "runs") }).sweep!([]);
  rmSync(root, { recursive: true, force: true });
  sweepStrays();
});

const execHere = (o: { reading?: Set<() => void>; idleMs?: number; deadlineMs?: number } = {}): ExecStreamFactory => localExecStream({ root, runDir: join(root, "runs"), pollMs: 20, ...o });

/** The stubs' switches, beside a PATH the stubs' own commands run on. */
const stubEnv = (env: Record<string, string>) => ({ baseEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env } });

const claude = (o: { exec?: ExecStreamFactory; graceMs?: number; env?: Record<string, string> } = {}) =>
  createClaudeAdapter({ exec: o.exec ?? execHere(), configDir: join(root, ".claude"), launch: { program: claudeKeeper(join(root, "claude")) }, ...(o.graceMs !== undefined ? { interruptGraceMs: o.graceMs } : {}), ...(o.env !== undefined ? stubEnv(o.env) : {}) });
const codex = (o: { exec?: ExecStreamFactory; graceMs?: number; deaf?: boolean; env?: Record<string, string> } = {}) =>
  createCodexAdapter({
    exec: o.exec ?? execHere(),
    home: join(root, ".codex"),
    login: "codex login",
    launch: { program: codexKeeper(join(root, "codex")) },
    ...stubEnv({ ...(o.deaf === true ? { STUB_DEAF: "1" } : {}), ...o.env }),
    ...(o.graceMs !== undefined ? { interruptGraceMs: o.graceMs } : {}),
  });

const noted = () => {
  const events: AdapterEvent[] = [];
  return { events, onEvent: (e: AdapterEvent) => void events.push(e) };
};

describe("a Claude process kept between turns", () => {
  it("answers the next message itself: the same process replies, and the second turn's cost is its own", async () => {
    const first = claude().start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const r1 = await first.finished;
    expect(r1).toMatchObject({ status: "completed", costUsd: 0.25 });
    const kept = first.kept?.();
    expect(kept, "the process was let go of at its result").toBeDefined();
    expect(alive(pidOf(r1.text))).toBe(true);
    const seen = noted();
    const second = kept!.next({ prompt: "two", onEvent: seen.onEvent });
    const r2 = await second.finished;
    expect(pidOf(r2.text)).toBe(pidOf(r1.text));
    expect(r2.text).toContain("two from");
    // The CLI's totals run on across the process's turns; the turn's own figure is what it added.
    expect(r2.costUsd).toBe(0.25);
    expect(seen.events.map(e => e.type)).toEqual(expect.arrayContaining(["session.start", "turn.done", "session.end"]));
    await kept!.close();
    await gone(pidOf(r1.text));
  }, 20_000);

  it("stops a turn on a kept process with an interrupt: the turn ends interrupted and the same process takes the next message", async () => {
    const first = claude().start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const seen = noted();
    const hung = first.kept!()!.next({ prompt: "hang", onEvent: seen.onEvent });
    await until(() => seen.events.some(e => e.type === "session.start"));
    const asked = Date.now();
    await hung.interrupt();
    expect(await hung.finished).toMatchObject({ status: "interrupted" });
    expect(Date.now() - asked).toBeLessThan(1_000);
    expect(alive(pid)).toBe(true);
    const after = hung.kept?.();
    expect(after).toBeDefined();
    const r3 = await after!.next({ prompt: "three", onEvent: () => {} }).finished;
    expect(pidOf(r3.text)).toBe(pid);
    await after!.close();
  }, 20_000);

  it("ends a stopped turn at its interrupted result though a command of it runs in the background, and stops that command", async () => {
    const heard = join(root, "heard");
    const exec = execHere();
    const adapter = createClaudeAdapter({ exec, configDir: join(root, ".claude"), launch: { program: claudeKeeper(join(root, "claude")) }, interruptGraceMs: 2_000, baseEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", STUB_HEARD: heard } });
    const first = adapter.start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const seen = noted();
    const hung = first.kept!()!.next({ prompt: "hang background", onEvent: seen.onEvent });
    await until(() => seen.events.some(e => e.type === "turn.tasks" && e.running === 1));
    const asked = Date.now();
    await hung.interrupt();
    expect(await hung.finished).toMatchObject({ status: "interrupted" });
    expect(Date.now() - asked).toBeLessThan(1_000);
    expect(alive(pid)).toBe(true);
    await until(() => readFileSync(heard, "utf8").includes("stop_task bg2"));
    const r3 = await hung.kept!()!.next({ prompt: "three", onEvent: () => {} }).finished;
    expect(pidOf(r3.text)).toBe(pid);
    await hung.kept!()!.close();
  }, 20_000);

  it("ends a process that does not answer the interrupt with its tree once the grace passes, as a stop did before", async () => {
    const first = claude({ graceMs: 300 }).start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const seen = noted();
    const hung = first.kept!()!.next({ prompt: "hang deaf", onEvent: seen.onEvent });
    await until(() => seen.events.some(e => e.type === "session.start"));
    await hung.interrupt();
    expect(await hung.finished).toMatchObject({ status: "interrupted" });
    await gone(pid);
    expect(hung.kept?.()).toBeUndefined();
  }, 20_000);

  it("is not cut by the idle limit between turns, and the next turn's wall counts from its own start", async () => {
    // Budgets a loaded computer's turn fits inside, since a turn cut before it rests is not what this case reads.
    const exec = execHere({ idleMs: 2_000, deadlineMs: 4_000 });
    const first = claude({ exec }).start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    // Past both the idle limit and the wall from the launch, with no turn open.
    await new Promise(resolve => setTimeout(resolve, 4_300));
    expect(alive(pid)).toBe(true);
    const r2 = await first.kept!()!.next({ prompt: "two", onEvent: () => {} }).finished;
    expect(r2).toMatchObject({ status: "completed" });
    expect(pidOf(r2.text)).toBe(pid);
    await first.kept!()!.close();
  }, 20_000);

  it("re-opened by the next host mid-turn, reads that turn from its own start and not the turns before it", async () => {
    const reading = new Set<() => void>();
    const gate = join(root, "gate");
    const first = claude({ exec: execHere({ reading }), env: { STUB_GATE: gate } }).start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    await first.finished;
    const second = first.kept!()!.next({ prompt: "two later", onEvent: () => {} });
    expect(second.from).toBeGreaterThan(0);
    // The host goes before the second turn said anything.
    for (const drop of [...reading]) drop();
    writeFileSync(gate, "go\n");
    const reopened = await claude().attach!({ run: second.run!, sessionId: first.claudeSessionId, startedAt: Date.now(), from: second.from!, onEvent: () => {} });
    if (reopened === "gone") throw new Error("the run was gone");
    const r2 = await reopened.finished;
    expect(r2.text).toContain("two later from");
  }, 20_000);

  it("ends what a turn left running in its process group when the turn ends, and keeps the agent and its input", async () => {
    const heard = join(root, "heard");
    const first = claude({ env: { STUB_HEARD: heard } }).start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const second = first.kept!()!.next({ prompt: "leave a child", onEvent: () => {} });
    expect(await second.finished).toMatchObject({ status: "completed" });
    const child = Number(/child (\d+)/.exec(readFileSync(heard, "utf8"))![1]);
    await gone(child);
    expect(alive(pid)).toBe(true);
    const r3 = await second.kept!()!.next({ prompt: "three", onEvent: () => {} }).finished;
    expect(pidOf(r3.text)).toBe(pid);
    await second.kept!()!.close();
  }, 20_000);
});

describe("a Codex app server kept between turns", () => {
  it("re-opened by the next host mid-turn, reads that turn from its own start, announcing the thread it already held", async () => {
    const reading = new Set<() => void>();
    const gate = join(root, "gate");
    const first = codex({ exec: execHere({ reading }), env: { STUB_GATE: gate } }).start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    expect(await first.finished).toMatchObject({ status: "completed" });
    const second = first.kept!()!.next({ prompt: "two later", onEvent: () => {} });
    expect(second.from).toBeGreaterThan(0);
    for (const drop of [...reading]) drop();
    writeFileSync(gate, "go\n");
    const seen = noted();
    const reopened = await codex().attach!({ run: second.run!, sessionId: first.threadId, startedAt: Date.now(), from: second.from!, onEvent: seen.onEvent });
    if (reopened === "gone") throw new Error("the run was gone");
    const r2 = await reopened.finished;
    expect(r2).toMatchObject({ status: "completed" });
    expect(r2.text).toContain("two later from");
    expect(seen.events.find(e => e.type === "session.start")).toMatchObject({ sessionId: first.threadId });
  }, 20_000);

  it("takes the next turn/start on the same server", async () => {
    const first = codex().start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const r1 = await first.finished;
    expect(r1).toMatchObject({ status: "completed" });
    const kept = first.kept?.();
    expect(kept).toBeDefined();
    const seen = noted();
    const r2 = await kept!.next({ prompt: "two", onEvent: seen.onEvent }).finished;
    expect(pidOf(r2.text)).toBe(pidOf(r1.text));
    expect(r2.text).toContain("two from");
    expect(seen.events.find(e => e.type === "session.start")).toMatchObject({ sessionId: "019fd0aa-0000-7000-8000-00000000c0de" });
    await kept!.close();
    await gone(pidOf(r1.text));
  }, 20_000);

  it("stops a turn with turn/interrupt and keeps the server for the next one", async () => {
    const first = codex().start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const seen = noted();
    const hung = first.kept!()!.next({ prompt: "hang", onEvent: seen.onEvent });
    await until(() => seen.events.some(e => e.type === "turn.anchor"));
    await hung.interrupt();
    expect(await hung.finished).toMatchObject({ status: "interrupted" });
    expect(alive(pid)).toBe(true);
    const r3 = await hung.kept!()!.next({ prompt: "three", onEvent: () => {} }).finished;
    expect(pidOf(r3.text)).toBe(pid);
    await hung.kept!()!.close();
  }, 20_000);

  it("lets a turn stopped with a command running take its server down, since turn/interrupt leaves the command running", async () => {
    const heard = join(root, "heard");
    const adapter = createCodexAdapter({ exec: execHere(), home: join(root, ".codex"), login: "codex login", launch: { program: codexKeeper(join(root, "codex")) }, baseEnv: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", STUB_HEARD: heard } });
    const first = adapter.start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const seen = noted();
    const hung = first.kept!()!.next({ prompt: "hang command", onEvent: seen.onEvent });
    await until(() => seen.events.some(e => e.type === "turn.delta" && e.kind === "tool_use"));
    const command = Number(/command (\d+)/.exec(readFileSync(heard, "utf8"))![1]);
    expect(alive(command)).toBe(true);
    await hung.interrupt();
    expect(await hung.finished).toMatchObject({ status: "interrupted" });
    await gone(command);
    await gone(pid);
    expect(hung.kept?.()).toBeUndefined();
  }, 20_000);

  it("ends a server that does not complete the interrupted turn once the grace passes", async () => {
    const first = codex({ graceMs: 300, deaf: true }).start({ prompt: "one", cwd: root, keep: true, onEvent: () => {} });
    const pid = pidOf((await first.finished).text);
    const seen = noted();
    const hung = first.kept!()!.next({ prompt: "hang", onEvent: seen.onEvent });
    await until(() => seen.events.some(e => e.type === "turn.anchor"));
    await hung.interrupt();
    expect(await hung.finished).toMatchObject({ status: "interrupted" });
    await gone(pid);
    expect(hung.kept?.()).toBeUndefined();
  }, 20_000);
});
