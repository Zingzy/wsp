// SPDX-License-Identifier: AGPL-3.0-only
// A child's finished line that cannot start into its lead stays owed until a turn of the lead takes it, and reaches
// the lead once: through a steer whose answer was lost or came late, a launch that failed after its start answered,
// and a host restart, on a clock the case moves. A line that cannot reach the lead within an hour of wall time, one the
// lead's door or its computer refuses, and one whose try the person stopped go to the person instead, on either side of
// a restart. The runtime and the real Claude and Codex adapters, fed by hand, and one launch over a machine's own road.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "@wsp/adapter-claude";
import { createCodexAdapter } from "@wsp/adapter-codex";
import { MachineUnreachableError, MachineUnreached, PlaceAbsentError, type ExecResult } from "@wsp/engine";
import { LINK_RETRY_WINDOW_MS, NOTIFY_ME, TURN_TOKEN_ENV, agentsOffRefusal, notFoundRefusal, usageRefusal, type Caller, type ExecStreamFactory } from "@wsp/protocol";
import type { Clock } from "../src/clock.js";
import { createRuntime, type HarnessAdapterFactory, type Runtime } from "../src/runtime.js";
import { memoryStore } from "../src/store.js";
import { openDaemonChannel } from "../src/daemon-channel.js";
import { NOTIFY_OWED } from "../src/types/internal.js";
import { DeadlineError } from "../src/types/wiring.js";
import { fakeClock } from "./fake-clock.js";
import { fedRuns, init, launchLost, lifecycle, result, said } from "./fed-runs.js";
import { scriptGuest } from "./script-guest.js";
import { createOn, stubBackend } from "./stub-backend.js";
import { until } from "./until.js";

const REPORT = "Parsed 40 files; the suite passes.";
const MIN = 60_000;
const HOUR = 60 * MIN;
const settle = (): Promise<void> => new Promise(r => setTimeout(r, 50));
/** What a provider's refusal of a launch comes to once the stream wraps it: the machine is gone. */
const launchRefused = (): Error => new Error("remote launch failed on m1: gone");
/** A Claude Code that announces no msg_lifecycle_v1, so its turns tell no unread message. */
const oldInit = JSON.stringify({ ...JSON.parse(init), claude_code_version: "2.1.200", capabilities: ["interrupt_receipt_v1"] });
// A Codex app server's lines, as 0.155.1 prints them, trimmed to the fields the adapter reads.
const THREAD_ID = "01a0e2c1-5d10-7b42-9a6e-3f1c2d4b5a60";
const TURN_ID = "01a0e2c1-5e02-7c11-8d3f-9b2a1c0d4e71";
const opened = [
  '{"id":"wsp-initialize","result":{"userAgent":"wsp/0.155.1","codexHome":"/root/.codex","platformFamily":"unix","platformOs":"linux"}}',
  `{"id":"wsp-thread","result":{"thread":{"id":"${THREAD_ID}","model":"gpt-5.6-sol","cwd":"/root/app","turns":[]},"model":"gpt-5.6-sol","cwd":"/root/app","approvalPolicy":"on-request","sandbox":{"type":"workspaceWrite"}}}`,
];
const turnStarted = `{"method":"turn/started","params":{"threadId":"${THREAD_ID}","turn":{"id":"${TURN_ID}","items":[],"status":"inProgress"}}}`;
const agentMessage = `{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"waiting"},"threadId":"${THREAD_ID}","turnId":"${TURN_ID}"}}`;
const completed = `{"method":"turn/completed","params":{"threadId":"${THREAD_ID}","turn":{"id":"${TURN_ID}","items":[],"status":"completed"}}}`;
/** The line a recorded app-server run printed at `line` (1-based), its thread named as this case's. */
const recorded = (fixture: string, line: number): string => {
  const raw = readFileSync(new URL(`../../adapter-codex/test/fixtures/${fixture}`, import.meta.url), "utf8").split("\n")[line - 1]!;
  const named = JSON.parse(raw) as { params: { threadId?: string } };
  return named.params.threadId === undefined ? raw : raw.split(named.params.threadId).join(THREAD_ID);
};
// The warnings two recorded runs printed between the thread's answer and turn/started, and the one a server without
// bubblewrap prints right after initialize.
const WARNINGS = [
  { name: "app-server-turn's warning after the thread answered", line: recorded("app-server-turn.jsonl", 5), early: false },
  { name: "app-server-subagent's warning after the thread answered", line: recorded("app-server-subagent.jsonl", 5), early: false },
  { name: "the startup configWarning before the thread answered", line: recorded("catalog-probe-route.jsonl", 2), early: true },
];

describe("a child's finished line its lead cannot take yet", () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    for (const rt of runtimes.splice(0)) await rt.close();
  });

  /** `leadNotify` is who the lead's own ends tell, and `resultExitMs` how long a reply held for an open message waits for
   * the CLI before it stands. */
  const setup = async (clock: Clock, o: { leadNotify?: readonly string[]; resultExitMs?: number; leadInit?: string } = {}) => {
    const fed = fedRuns();
    const backend = stubBackend();
    const store = memoryStore();
    // Each run carries the workspace it was launched for, so a case with two leads tells their launches apart.
    const execOn = (workspaceId: string): ExecStreamFactory =>
      Object.assign((command: string, eo: Parameters<ExecStreamFactory>[1]) => fed.factory(command, { ...eo, env: { ...eo.env, LAB_WORKSPACE: workspaceId } }), { attach: fed.factory.attach }) as ExecStreamFactory;
    // Once a case says so, the agent refuses outright to start on the lead's folder, a plain refusal rather than a
    // computer that did not answer; each one it refused is counted.
    const refusing = { on: undefined as string | undefined, refused: 0 };
    const claude = (c: Parameters<HarnessAdapterFactory>[0]) => {
      if (refusing.on !== undefined && c.workspaceId === refusing.on) {
        refusing.refused++;
        throw new Error("claude will not start here");
      }
      return createClaudeAdapter({ exec: execOn(c.workspaceId), configDir: "/root/.claude-cfg", resultExitMs: o.resultExitMs ?? 60_000 });
    };
    const host = (on: Clock): Runtime => {
      const rt = createRuntime({ backend, store, clock: on, adapters: { claude } });
      runtimes.push(rt);
      return rt;
    };
    let rt = host(clock);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true } });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate", ...(o.leadNotify !== undefined ? { notify: [...o.leadNotify] } : {}) });
    await until(() => fed.runOf("orchestrate") !== undefined);
    const leadRun = fed.runOf("orchestrate")!;
    leadRun.push(o.leadInit ?? init);
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.start"));
    const leadThread = lead.view().threadId!;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    let kidThread: string | undefined;
    /** The lead replies and its process exits, as a coordinator's turn ends to wait on its children. */
    const leadWaits = async (): Promise<void> => {
      leadRun.push(said("msg_l", "waiting"), result("waiting"));
      await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
      leadRun.end(0);
      await lead.finished;
    };
    /** The lead replies with a message still open in its turn, so its reply is held until its process exits. */
    const leadExits = async (): Promise<void> => {
      leadRun.push(said("msg_l", "waiting"), result("waiting"));
      await settle();
      leadRun.end(0);
      await lead.finished;
    };
    /** A child opened with the lead as its target, or the targets named, ends with REPORT. */
    const kidEnds = async (o: { caller?: Caller; turnToken?: string; notify?: readonly string[]; meanwhile?: () => Promise<void> } = {}): Promise<void> => {
      const kid = await rt.sessions.start(
        o.caller === undefined ? kidWs.id : leadWs.id,
        { prompt: "parse the files", ...(o.turnToken !== undefined ? { notify: ["me"], turnToken: o.turnToken, startedBy: "agent" as const } : { notify: [...(o.notify ?? [leadThread])] }) },
        o.caller,
      );
      kidThread = kid.view().threadId!;
      await until(() => fed.runOf("parse the files") !== undefined);
      const run = fed.runOf("parse the files")!;
      await o.meanwhile?.();
      run.push(init, said("msg_k", REPORT), result(REPORT));
      await until(async () => (await rt.sessions.history(kid.view().workspaceId)).some(e => e.type === "session.done" && e.threadId === kidThread));
      run.end(0);
      await kid.finished;
      await settle();
    };
    /** The rows the person was given for a thread's lines: the child's by default. */
    const toPerson = async (thread = kidThread): Promise<string[]> =>
      (await rt.sessions.history(kidWs.id)).concat(await rt.sessions.history(leadWs.id)).flatMap(e => (e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === thread ? [e.text] : []));
    /** The lead's runs opened with the child's line, in launch order. */
    const launches = () => fed.runsOf(REPORT);
    /** Every write of the child's line into a running turn of the lead. */
    const steers = () => leadRun.writes.filter(w => w.includes(REPORT));
    /** The clock moves in steps until the lead's nth launch of the line shows. */
    const nextTry = async (on: ReturnType<typeof fakeClock>, n: number): Promise<void> => {
      for (let i = 0; i < 40 && launches().length < n; i++) {
        on.advance(5_000);
        await settle();
      }
      expect(launches()).toHaveLength(n);
    };
    /** A launch the lead's agent took up: it announces itself, answers and exits. */
    const taken = async (n: number): Promise<void> => {
      const run = launches()[n]!;
      run.push(init, said(`msg_t${n}`, "read it"), result("read it"));
      await until(async () => (await rt.sessions.history(leadWs.id)).filter(e => e.type === "session.done").length >= 2);
      run.end(0);
      await settle();
    };
    const owed = async (): Promise<number> => (await store.list(NOTIFY_OWED)).length;
    /** The host goes down and a second one starts on the same store, on a clock that goes on from where the first stood. */
    const restart = async (next: Clock): Promise<void> => {
      await rt.close();
      rt = host(next);
      await rt.sessions.list(leadWs.id);
    };
    /** Steps the clock a minute at a time for `minutes`, failing every launch of the line with `fails` as it shows. */
    const keepFailing = async (on: ReturnType<typeof fakeClock>, minutes: number, fails: () => Error): Promise<void> => {
      const failed = new Set<unknown>();
      for (let i = 0; i < minutes; i++) {
        for (const run of launches()) {
          if (failed.has(run)) continue;
          failed.add(run);
          run.fail(fails());
        }
        await settle();
        on.advance(MIN);
        await settle();
      }
    };
    const refuseStarts = (): void => void (refusing.on = leadWs.id);
    const refusedStarts = (): number => refusing.refused;
    return { fed, store, leadRun, leadWs, lead, leadThread, leadWaits, leadExits, kidEnds, toPerson, launches, steers, nextTry, taken, owed, restart, keepFailing, refuseStarts, refusedStarts, rt: () => rt, kidThread: () => kidThread! };
  };

  it("a steer whose write landed but whose answer was lost reaches the lead once, and the person is told nothing", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    s.leadRun.loses = "landed";
    await s.kidEnds();
    expect(s.steers()).toHaveLength(1);
    const uuid = (JSON.parse(s.steers()[0]!) as { uuid: string }).uuid;
    s.leadRun.push(lifecycle(uuid, "queued"), lifecycle(uuid, "started"), said("msg_1", "read it"), result("read it"), lifecycle(uuid, "completed"));
    await until(async () => (await s.rt().sessions.history(s.leadWs.id)).some(e => e.type === "session.done"));
    s.leadRun.end(0);
    await settle();
    at.advance(2 * HOUR);
    await settle();
    expect(s.steers()).toHaveLength(1);
    expect(s.launches()).toEqual([]);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a steer whose write never landed reaches the lead once, as its next turn, once the turn it was steered into ends", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    s.leadRun.loses = "lost";
    await s.kidEnds();
    expect(s.steers()).toEqual([]);
    // The lead's turn ends without its agent ever taking the message.
    await s.leadExits();
    await until(() => s.launches().length === 1);
    await s.taken(0);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(s.steers()).toEqual([]);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a launch that fails after its start answered keeps the line owed, and the next try reaches the lead once", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    await s.kidEnds();
    expect(s.launches()).toHaveLength(1);
    // The box the lead runs on never answers the launch's posts: the stream fails with no word from the agent.
    s.launches()[0]!.fail(launchLost());
    await settle();
    expect(await s.owed()).toBe(1);
    await s.nextTry(at, 2);
    await s.taken(1);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(2);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a launch that fails after the lead's agent announced itself is not sent again: the agent had the line", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    await s.kidEnds();
    s.launches()[0]!.push(init);
    await until(async () => (await s.rt().sessions.history(s.leadWs.id)).filter(e => e.type === "session.start").length === 2);
    s.launches()[0]!.fail(launchLost());
    await settle();
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a steer whose write never landed is still sent back once when the host restarts before the turn it was steered into ends", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    s.leadRun.loses = "lost";
    await s.kidEnds();
    await s.restart(fakeClock(a.clock.now()).clock);
    // The second host reads the lead's run again; its turn ends without its agent ever taking the message.
    s.leadRun.push(said("msg_l", "waiting"), result("waiting"));
    await settle();
    s.leadRun.end(0);
    await until(() => s.launches().length === 1);
    await s.taken(0);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(s.steers()).toEqual([]);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a launch whose agent had not announced itself when the host restarted is read on the next host, and the line is not sent again", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    expect(s.launches()).toHaveLength(1);
    await s.restart(fakeClock(a.clock.now()).clock);
    await settle();
    expect(s.launches()).toHaveLength(1);
    s.launches()[0]!.push(init, said("msg_t0", "read it"), result("read it"));
    await until(async () => (await s.rt().sessions.history(s.leadWs.id)).filter(e => e.type === "session.done").length >= 2);
    s.launches()[0]!.end(0);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toEqual([]);
    await until(async () => (await s.owed()) === 0);
  });

  it("a line still owed when the host restarts reaches the lead from the next host, once", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    s.launches()[0]!.fail(launchLost());
    await settle();
    // The host stops before the line's next try.
    await s.restart(fakeClock(a.clock.now() + 5 * MIN).clock);
    await until(() => s.launches().length === 2);
    await s.taken(1);
    await settle();
    expect(s.launches()).toHaveLength(2);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a line its lead's computer keeps failing tells the person once, an hour of wall time after it became owed and not an hour of the next host, and is never sent after", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    // Each launch takes long minutes to fail, so the hour holds four tries, two on each host.
    a.advance(20 * MIN);
    s.launches()[0]!.fail(launchLost());
    await settle();
    await s.nextTry(a, 2);
    a.advance(10 * MIN);
    s.launches()[1]!.fail(launchLost());
    await settle();
    expect(await s.toPerson()).toEqual([]);
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await s.nextTry(b, 3);
    b.advance(25 * MIN);
    s.launches()[2]!.fail(launchLost());
    await settle();
    expect(await s.toPerson()).toEqual([]);
    await s.nextTry(b, 4);
    // The fourth try is still out at the hour the line has been owed, half an hour into the second host's own: it is
    // stopped there and the person is told.
    b.advance(10 * MIN);
    s.launches()[3]!.fail(launchLost());
    await until(async () => (await s.toPerson()).length === 1);
    expect(await s.toPerson()).toEqual([expect.stringMatching(new RegExp(`^thread ${s.kidThread().slice(0, 8)} finished \\(completed.*\\): ${REPORT}$`))]);
    b.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(4);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a line whose start the lead's agent refuses goes to the person at once and is never tried again", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    // The agent refuses to start on the lead once the child works, so the line's own start is refused outright.
    await s.kidEnds({ meanwhile: async () => s.refuseStarts() });
    await until(async () => (await s.toPerson()).length === 1);
    expect(s.refusedStarts()).toBe(1);
    at.advance(2 * HOUR);
    await settle();
    expect(s.refusedStarts()).toBe(1);
    expect(s.launches()).toEqual([]);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a start or a launch goes again only where the lead's computer did not answer: a refusal, a plain Error among them, never does", async () => {
    const { computerSilent } = await import("../src/threads/threads.js");
    const { LaunchUnanswered } = await import("../src/machine-exec.js");
    const deadLink = await openDaemonChannel({ url: "ws://127.0.0.1:9", token: "t", onEvent: () => {}, connectTimeoutMs: 2_000 }).catch((e: unknown) => e);
    const lost = new Error("remote launch failed on m1: machine.exec on lab-box was not answered in 35s");
    for (const e of [new MachineUnreached(7, 61_000, new TypeError("fetch failed")), new MachineUnreachableError("m1", "Sandbox is not reachable", 502, "the machine is not reachable"), new PlaceAbsentError("hetzner is away"), new DeadlineError("the launch timed out after 30000 ms"), new LaunchUnanswered(lost.message, { cause: lost }), deadLink]) {
      expect(computerSilent(e), String(e)).toBe(true);
    }
    for (const e of [new Error(agentsOffRefusal("lead", "send")), new Error("the person stopped this send while it waited for hetzner"), usageRefusal("no such agent", "pick one"), notFoundRefusal("no thread t1"), launchRefused(), lost, undefined]) {
      expect(computerSilent(e), String(e)).toBe(false);
    }
  });

  it("a steer whose write outlasts the lead's reply and the window its held reply waits reaches the lead once, as its next turn", async () => {
    const at = fakeClock();
    const s = await setup(at.clock, { resultExitMs: 200 });
    let land!: () => void;
    s.leadRun.gate = new Promise<void>(resolve => (land = resolve));
    await s.kidEnds();
    // The lead's agent gives its last word while the write is on its way, and its held reply stands before the write
    // answers: the turn ends with the message unread.
    s.leadRun.push(said("msg_l", "waiting"), result("waiting"));
    await new Promise(r => setTimeout(r, 600));
    delete s.leadRun.gate;
    land();
    await s.lead.finished;
    await until(() => s.launches().length >= 1);
    await s.taken(0);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a steer whose write outlasts the lead's process reaches the lead once, as its next turn", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    let land!: () => void;
    s.leadRun.gate = new Promise<void>(resolve => (land = resolve));
    await s.kidEnds();
    // The lead replies and its process exits while the write is on its way.
    await s.leadExits();
    await settle();
    delete s.leadRun.gate;
    land();
    await until(() => s.launches().length >= 1);
    await s.taken(0);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a try whose launch the lead's computer never answers is stopped at the line's hour, and the person is told then", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    await s.kidEnds();
    expect(s.launches()).toHaveLength(1);
    // The launch's posts went out and nothing answers either way: the stream neither runs nor fails.
    at.advance(59 * MIN);
    await settle();
    expect(await s.toPerson()).toEqual([]);
    at.advance(2 * MIN);
    await until(async () => (await s.toPerson()).length === 1);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a launch the lead's computer refuses goes to the person at once and is never tried again", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    await s.kidEnds();
    s.launches()[0]!.fail(launchRefused());
    await until(async () => (await s.toPerson()).length === 1);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("the person's stop of the lead's turn carrying the line holds: the line is not launched again, and the person is told it", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    await s.kidEnds();
    expect(s.launches()).toHaveLength(1);
    const row = (await s.rt().sessions.list(s.leadWs.id)).find(v => v.threadId === s.leadThread && v.status === "running");
    await s.rt().sessions.interrupt(row!.id);
    await until(async () => (await s.toPerson()).length === 1);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a lead started with --notify me hears nothing of the line's failed tries, and the person gets the one row of the child's line at the hour", async () => {
    const at = fakeClock();
    const s = await setup(at.clock, { leadNotify: [NOTIFY_ME] });
    await s.leadWaits();
    const before = await s.toPerson(s.leadThread);
    expect(before).toHaveLength(1);
    await s.kidEnds();
    await s.keepFailing(at, 70, launchLost);
    expect(s.launches().length).toBeGreaterThan(5);
    expect(await s.toPerson(s.leadThread)).toEqual(before);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a restart keeps the spacing of the line's tries: the next host does not start it over at the first wait", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    s.launches()[0]!.fail(launchLost());
    await s.nextTry(a, 2);
    s.launches()[1]!.fail(launchLost());
    await s.nextTry(a, 3);
    s.launches()[2]!.fail(launchLost());
    await settle();
    // Three tries failed: the next waits two minutes, and a restart in the middle of that wait keeps it.
    a.advance(30_000);
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    expect(s.launches()).toHaveLength(3);
    b.advance(60_000);
    await settle();
    expect(s.launches()).toHaveLength(3);
    await s.nextTry(b, 4);
    s.launches()[3]!.fail(launchLost());
    await settle();
    // The fourth failure waits four minutes, on the second host as on the first.
    b.advance(200_000);
    await settle();
    expect(s.launches()).toHaveLength(4);
    await s.nextTry(b, 5);
  });

  it("a child's lines into two leads that fall on two hosts tell the person once", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    const otherWs = await createOn(s.rt(), { golden: "snap_g", name: "lead-2", agents: { spawn: true } });
    const other = await s.rt().sessions.start(otherWs.id, { prompt: "coordinate" });
    await until(() => s.fed.runOf("coordinate") !== undefined);
    const otherRun = s.fed.runOf("coordinate")!;
    otherRun.push(init, said("msg_o", "waiting"), result("waiting"));
    await until(async () => (await s.rt().sessions.history(otherWs.id)).some(e => e.type === "session.done"));
    otherRun.end(0);
    await other.finished;
    await s.kidEnds({ notify: [s.leadThread, other.view().threadId!] });
    await until(() => s.launches().length === 2);
    const into = (ws: string) => s.launches().find(r => r.env["LAB_WORKSPACE"] === ws)!;
    // The first lead's computer refuses its launch: the person is told now. The second's never answers.
    into(s.leadWs.id).fail(launchRefused());
    into(otherWs.id).fail(launchLost());
    await until(async () => (await s.toPerson()).length === 1);
    await settle();
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    await s.keepFailing(b, 70, launchLost);
    expect(s.launches().length).toBeGreaterThan(3);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a Codex lead's line whose steer never answered when the host restarted reaches the person when the lead's turn ends, never nobody", async () => {
    const fed = fedRuns();
    const backend = stubBackend();
    const store = memoryStore();
    const host = (on: Clock): Runtime => {
      const rt = createRuntime({
        backend,
        store,
        clock: on,
        adapters: {
          claude: () => createClaudeAdapter({ exec: fed.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 }),
          codex: () => createCodexAdapter({ exec: fed.factory, home: "/root/.codex", login: "codex login" }),
        },
      });
      runtimes.push(rt);
      return rt;
    };
    const a = fakeClock();
    let rt = host(a.clock);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true } });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate", harness: "codex" });
    await until(() => fed.runs.length === 1);
    const leadRun = fed.runs[0]!;
    leadRun.push(...opened);
    await until(() => leadRun.writes.some(w => w.includes("turn/start")));
    leadRun.push(turnStarted);
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.start"));
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    // The child's line steers into the lead's turn, and that write never lands and never answers.
    leadRun.loses = "lost";
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    const kidThread = kid.view().threadId!;
    await until(() => fed.runOf("parse the files") !== undefined);
    const kidRun = fed.runOf("parse the files")!;
    kidRun.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done" && e.threadId === kidThread));
    kidRun.end(0);
    await kid.finished;
    await settle();
    expect(await store.list(NOTIFY_OWED)).toHaveLength(1);
    const runsBefore = fed.runs.length;
    await rt.close();
    rt = host(fakeClock(a.clock.now()).clock);
    await rt.sessions.list(leadWs.id);
    await settle();
    // The lead's turn goes on and ends on the second host; its agent never had the line.
    leadRun.push(agentMessage, completed);
    await settle();
    leadRun.end(0);
    const person = async (): Promise<number> =>
      (await rt.sessions.history(kidWs.id)).concat(await rt.sessions.history(leadWs.id)).filter(e => e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === kidThread).length;
    await until(async () => (await person()) === 1);
    for (const r of fed.runs.slice(runsBefore)) r.push(...opened);
    await settle();
    expect(fed.runs.slice(runsBefore)).toEqual([]);
    expect(fed.runs.reduce((n, r) => n + r.writes.filter(w => w.includes(REPORT)).length, 0)).toBe(0);
    expect(await person()).toBe(1);
    expect(await store.list(NOTIFY_OWED)).toEqual([]);
  });

  it("after a restart, the person's stop of the re-opened turn carrying the line holds: it is not launched again, and the person is told it", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    expect(s.launches()).toHaveLength(1);
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    const row = (await s.rt().sessions.list(s.leadWs.id)).find(v => v.threadId === s.leadThread && v.status === "running");
    await s.rt().sessions.interrupt(row!.id);
    await until(async () => (await s.toPerson()).length === 1);
    b.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("after a restart, a re-opened turn carrying the line that the lead's computer refuses goes to the person at once and is never launched again", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    s.launches()[0]!.fail(launchRefused());
    await until(async () => (await s.toPerson()).length === 1);
    b.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("after a restart, a re-opened turn carrying the line that the lead's computer never answers is stopped at the line's hour, and the person is told then", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    b.advance(59 * MIN);
    await settle();
    expect(await s.toPerson()).toEqual([]);
    b.advance(2 * MIN);
    await until(async () => (await s.toPerson()).length === 1);
    b.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("after a restart, a re-opened turn carrying the line that the lead's computer did not answer goes again on the clock", async () => {
    const a = fakeClock();
    const s = await setup(a.clock);
    await s.leadWaits();
    await s.kidEnds();
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    s.launches()[0]!.fail(launchLost());
    await s.nextTry(b, 2);
    await s.taken(1);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a Claude Code lead whose CLI tells no unread messages: a steer whose write never answered tells the person, as main did, and is never lost", async () => {
    const a = fakeClock();
    const s = await setup(a.clock, { leadInit: oldInit });
    s.leadRun.loses = "lost";
    await s.kidEnds();
    await until(async () => (await s.toPerson()).length === 1);
    const b = fakeClock(a.clock.now());
    await s.restart(b.clock);
    await settle();
    s.leadRun.push(said("msg_l", "waiting"), result("waiting"));
    await settle();
    s.leadRun.end(0);
    for (let i = 0; i < 30; i++) {
      b.advance(5 * MIN);
      await settle();
    }
    expect(s.launches()).toEqual([]);
    expect(s.steers()).toEqual([]);
    expect(await s.toPerson()).toHaveLength(1);
    expect(await s.owed()).toBe(0);
  });

  it("a line whose try failed and whose lead then naps past its hour gets a try at the wake, as a line that never failed does", async () => {
    const at = fakeClock();
    const s = await setup(at.clock);
    await s.leadWaits();
    await s.kidEnds();
    s.launches()[0]!.fail(launchLost());
    await settle();
    await s.rt().workspaces.nap(s.leadWs.id);
    at.advance(2 * HOUR);
    await settle();
    expect(s.launches()).toHaveLength(1);
    await s.rt().workspaces.wake(s.leadWs.id);
    await until(() => s.launches().length === 2);
    await s.taken(1);
    expect(await s.toPerson()).toEqual([]);
    expect(await s.owed()).toBe(0);
  });

  it("a line's try whose launch ran and lost its answer is read as that run while the lead's computer stays dark past the link window, and is never launched twice", async () => {
    const fed = fedRuns();
    const backend = stubBackend();
    const store = memoryStore();
    const guest = scriptGuest(backend, [], async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const inner = backend.execImpl;
    // The machine's own clock, which every wait of the stream runs on; the host's clock is the case's.
    const machineClock = { now: 0 };
    let darkUntil: number | undefined;
    let landed = 0;
    /** Every run a launch was posted for, by its claim folder: a post the launch sends again names the same one. */
    const runs = new Set<string>();
    // The line's launch lands and loses its answer, and nothing about the run answers for two and a half link windows.
    backend.execImpl = async (m, cmd): Promise<ExecResult> => {
      const ofRun = cmd.includes("WSP_LAUNCHED") || cmd.includes("WSP_RUN") || cmd.includes("__WSP_EOF_");
      if (cmd.includes("WSP_LAUNCHED")) {
        runs.add(/mkdir '([^']+\.d)'/.exec(cmd)?.[1] ?? cmd);
        darkUntil ??= machineClock.now + 2.5 * LINK_RETRY_WINDOW_MS;
      }
      if (!ofRun || darkUntil === undefined || machineClock.now >= darkUntil) return inner(m, cmd);
      machineClock.now += 1_000;
      if (cmd.includes("WSP_LAUNCHED") && landed++ === 0) await inner(m, cmd);
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    };
    // Only the line's launches go through the lead's machine; every other run is fed by hand.
    const exec = (c: { execStream: ExecStreamFactory }): ExecStreamFactory =>
      Object.assign((command: string, o: Parameters<ExecStreamFactory>[1]) => (o.input?.[0]?.includes(REPORT) === true ? c.execStream(command, o) : fed.factory(command, o)), { attach: fed.factory.attach }) as ExecStreamFactory;
    const at = fakeClock();
    const rt = createRuntime({
      backend,
      store,
      clock: at.clock,
      machineExec: { pollMs: 5, now: () => machineClock.now, sleep: async (ms: number): Promise<void> => void (machineClock.now += ms) },
      adapters: { claude: c => createClaudeAdapter({ exec: exec(c), configDir: "/root/.claude-cfg", resultExitMs: 60_000 }) },
    });
    runtimes.push(rt);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true } });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate" });
    await until(() => fed.runOf("orchestrate") !== undefined);
    fed.runOf("orchestrate")!.push(init, said("msg_l", "waiting"), result("waiting"));
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    fed.runOf("orchestrate")!.end(0);
    await lead.finished;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    await until(() => fed.runOf("parse the files") !== undefined);
    fed.runOf("parse the files")!.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done"));
    fed.runOf("parse the files")!.end(0);
    await kid.finished;
    // The host's clock moves on meanwhile, past where a try that gave up on the dark would go again.
    for (let i = 0; i < 40 && !(darkUntil !== undefined && machineClock.now >= darkUntil); i++) {
      at.advance(30_000);
      await settle();
    }
    // The machine answers again and holds the run: its agent announces itself under the line's request.
    guest.append(`${init}\n${said("msg_n", "read it")}\n${result("read it")}\n`);
    guest.exit(0);
    for (let i = 0; i < 10; i++) {
      at.advance(MIN);
      await settle();
    }
    await until(async () => (await store.list(NOTIFY_OWED)).length === 0);
    expect(runs.size).toBe(1);
    expect(fed.runsOf(REPORT)).toEqual([]);
  });

  /** A Codex lead whose first turn has ended, and a child of it that ended with REPORT: the line's first try is the
   * lead's third run. */
  const codexLead = async () => {
    const fed = fedRuns();
    const backend = stubBackend();
    const store = memoryStore();
    const at = fakeClock();
    const rt = createRuntime({
      backend,
      store,
      clock: at.clock,
      adapters: {
        claude: () => createClaudeAdapter({ exec: fed.factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 }),
        codex: () => createCodexAdapter({ exec: fed.factory, home: "/root/.codex", login: "codex login" }),
      },
    });
    runtimes.push(rt);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true } });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate", harness: "codex" });
    await until(() => fed.runs.length === 1);
    const leadRun = fed.runs[0]!;
    leadRun.push(...opened);
    await until(() => leadRun.writes.some(w => w.includes("turn/start")));
    leadRun.push(turnStarted, agentMessage, completed);
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    leadRun.end(0);
    await lead.finished;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    const kidThread = kid.view().threadId!;
    await until(() => fed.runOf("parse the files") !== undefined);
    const kidRun = fed.runOf("parse the files")!;
    kidRun.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done" && e.threadId === kidThread));
    kidRun.end(0);
    await kid.finished;
    await settle();
    await until(() => fed.runs.length === 3);
    const toPerson = async (): Promise<number> =>
      (await rt.sessions.history(kidWs.id)).concat(await rt.sessions.history(leadWs.id)).filter(e => e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === kidThread).length;
    const steps = async (n: number, ms: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        at.advance(ms);
        await settle();
      }
    };
    return { fed, store, toPerson, steps, tryRun: fed.runs[2]! };
  };

  it("a Codex lead's server that opens the thread for the line's try and exits before the turn starts leaves the line to the person, never nobody", async () => {
    const c = await codexLead();
    c.tryRun.push(...opened);
    await until(() => c.tryRun.writes.some(w => w.includes("turn/start")));
    await settle();
    c.tryRun.end(1);
    await until(async () => (await c.toPerson()) === 1);
    await c.steps(30, 5 * MIN);
    expect(c.fed.runs).toHaveLength(3);
    expect(await c.toPerson()).toBe(1);
    expect(await c.store.list(NOTIFY_OWED)).toEqual([]);
  });

  it("a Codex lead's server that opens the thread for the line's try and refuses its turn leaves the line to the person, never nobody", async () => {
    const c = await codexLead();
    c.tryRun.push(...opened);
    await until(() => c.tryRun.writes.some(w => w.includes("turn/start")));
    c.tryRun.push('{"id":"wsp-turn","error":{"code":-32603,"message":"the model is not available on this plan"}}');
    await settle();
    c.tryRun.end(0);
    await until(async () => (await c.toPerson()) === 1);
    await c.steps(30, 5 * MIN);
    expect(c.fed.runs).toHaveLength(3);
    expect(await c.toPerson()).toBe(1);
    expect(await c.store.list(NOTIFY_OWED)).toEqual([]);
  });

  it("a Codex lead's launch of the line that its computer never answered is tried again, and the line is taken once the next try's turn starts", async () => {
    const c = await codexLead();
    c.tryRun.fail(launchLost());
    await settle();
    await c.steps(12, 10_000);
    expect(c.fed.runs).toHaveLength(4);
    const next = c.fed.runs[3]!;
    next.push(...opened);
    await until(() => next.writes.some(w => w.includes("turn/start") && w.includes("Parsed 40 files")));
    expect(await c.store.list(NOTIFY_OWED)).toHaveLength(1);
    next.push(turnStarted);
    await until(async () => (await c.store.list(NOTIFY_OWED)).length === 0);
    expect(await c.toPerson()).toBe(0);
  });

  /** A host or two on one store, with the real Claude Code and Codex adapters over runs fed by hand, and an attach
   * the case can make go unanswered, as a computer that is dark when the next host re-opens its runs, or hold until
   * it lets go, as a cloud machine still restoring answers nothing for a while. */
  const twoHosts = () => {
    const fed = fedRuns();
    let dark = false;
    let gate: Promise<void> | undefined;
    let open = (): void => {};
    const factory = Object.assign((command: string, o: Parameters<ExecStreamFactory>[1]) => fed.factory(command, o), {
      attach: async (id: string, o: Parameters<NonNullable<ExecStreamFactory["attach"]>>[1]) => {
        if (gate !== undefined) await gate;
        if (dark) throw new MachineUnreached(7, 61_000, new Error("machine.exec on lab-box was not answered in 35s"));
        return fed.factory.attach!(id, o);
      },
    }) as ExecStreamFactory;
    const backend = stubBackend();
    const store = memoryStore();
    const host = (on: Clock): Runtime => {
      const rt = createRuntime({
        backend,
        store,
        clock: on,
        adapters: {
          claude: () => createClaudeAdapter({ exec: factory, configDir: "/root/.claude-cfg", resultExitMs: 60_000 }),
          codex: () => createCodexAdapter({ exec: factory, home: "/root/.codex", login: "codex login" }),
        },
      });
      runtimes.push(rt);
      return rt;
    };
    const hold = (): void => void (gate = new Promise<void>(r => (open = r)));
    const release = (): void => {
      gate = undefined;
      open();
    };
    return { fed, store, host, goDark: () => (dark = true), hold, release };
  };

  /** A Claude Code lead, kept awake, whose child ended with REPORT; then the host goes down with the line's try out
   * and unannounced, and the next host comes up while the lead's computer answers nothing. */
  const darkRestart = async () => {
    const h = twoHosts();
    const a = fakeClock();
    let rt = h.host(a.clock);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true }, idleWindowMs: null });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate" });
    await until(() => h.fed.runOf("orchestrate") !== undefined);
    h.fed.runOf("orchestrate")!.push(init, said("msg_l", "waiting"), result("waiting"));
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    h.fed.runOf("orchestrate")!.end(0);
    await lead.finished;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    const kidThread = kid.view().threadId!;
    await until(() => h.fed.runOf("parse the files") !== undefined);
    h.fed.runOf("parse the files")!.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done"));
    h.fed.runOf("parse the files")!.end(0);
    await kid.finished;
    await settle();
    expect(h.fed.runsOf(REPORT)).toHaveLength(1);
    h.goDark();
    await rt.close();
    const b = fakeClock(a.clock.now());
    rt = h.host(b.clock);
    await rt.sessions.list(leadWs.id);
    await settle();
    const toPerson = async (): Promise<number> =>
      (await rt.sessions.history(kidWs.id)).concat(await rt.sessions.history(leadWs.id)).filter(e => e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === kidThread).length;
    return { ...h, b, leadWs, toPerson, rt: () => rt };
  };

  it("after a restart whose re-open of the line's try the lead's computer never answers, the person is told at the line's hour and the line is settled", async () => {
    const d = await darkRestart();
    let toldAt: number | undefined;
    for (let minute = 5; minute <= 120; minute += 5) {
      d.b.advance(5 * MIN);
      await settle();
      if (toldAt === undefined && (await d.toPerson()) > 0) toldAt = minute;
    }
    expect(toldAt).toBeDefined();
    expect(toldAt!).toBeLessThanOrEqual(65);
    expect(await d.toPerson()).toBe(1);
    expect(d.fed.runsOf(REPORT)).toHaveLength(1);
    expect(await d.store.list(NOTIFY_OWED)).toEqual([]);
    // The try is out of reach: the host writes no end for it, and the lead's one end is its first turn's.
    expect((await d.rt().sessions.history(d.leadWs.id)).filter(e => e.type === "session.end")).toHaveLength(1);
  });

  it("after a restart whose re-open of the line's try the lead's computer never answers, the person's stop of that row settles the line, tells them, and writes no end for the turn", async () => {
    const d = await darkRestart();
    const row = (await d.rt().sessions.list(d.leadWs.id)).find(v => v.status === "running");
    expect(await d.rt().sessions.interrupt(row!.id)).toEqual({ outcome: "not-running" });
    await until(async () => (await d.toPerson()) === 1);
    for (let i = 0; i < 20; i++) {
      d.b.advance(MIN);
      await settle();
    }
    expect(await d.toPerson()).toBe(1);
    expect(d.fed.runsOf(REPORT)).toHaveLength(1);
    expect(await d.store.list(NOTIFY_OWED)).toEqual([]);
    expect((await d.rt().sessions.history(d.leadWs.id)).filter(e => e.type === "session.end")).toHaveLength(1);
  });

  /** The rows a turn wrote, in order. */
  const rowsOf = (history: readonly { type: string; turnId?: string; kind?: string }[], turnId: string): string[] =>
    history.filter(e => e.turnId === turnId).map(e => (e.type === "session.delta" ? `delta:${e.kind}` : e.type));

  it("a stop the person sends while the next host's re-open of a turn is still out writes no end of its own: the turn ends once, as its agent ends it", async () => {
    const h = twoHosts();
    const a = fakeClock();
    let rt = h.host(a.clock);
    const ws = await createOn(rt, { golden: "snap_g", name: "app", idleWindowMs: null });
    const turn = await rt.sessions.start(ws.id, { prompt: "build the parser" });
    await until(() => h.fed.runOf("build the parser") !== undefined);
    const run = h.fed.runOf("build the parser")!;
    run.push(init, said("msg_1", "Reading the grammar first."));
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.delta"));
    const rowId = (await rt.sessions.list(ws.id)).find(v => v.status === "running")!.id;
    await rt.close();
    h.hold();
    rt = h.host(fakeClock(a.clock.now()).clock);
    const stopping = rt.sessions.interrupt(rowId);
    await settle();
    h.release();
    await stopping;
    await settle();
    run.push(said("msg_2", "Parser done: three files changed."), result("Parser done: three files changed."));
    await settle();
    run.end(0);
    await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.end"));
    for (let i = 0; i < 5; i++) await settle();
    const rows = rowsOf(await rt.sessions.history(ws.id), turn.turnId);
    expect(rows.filter(r => r === "session.end")).toHaveLength(1);
    expect(rows.at(-1)).toBe("session.end");
  });

  /** A lead whose child ended with REPORT; the host goes down with the line's try out, and its agent takes the line
   * and answers it meanwhile. The next host comes up `after` minutes later, and its re-open of the try answers only
   * once a timer due at once has fired, as a cloud machine still restoring does. */
  const upLater = async (after: number) => {
    const h = twoHosts();
    const a = fakeClock();
    let rt = h.host(a.clock);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true }, idleWindowMs: null });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate" });
    await until(() => h.fed.runOf("orchestrate") !== undefined);
    h.fed.runOf("orchestrate")!.push(init, said("msg_l", "waiting"), result("waiting"));
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    h.fed.runOf("orchestrate")!.end(0);
    await lead.finished;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    const kidThread = kid.view().threadId!;
    await until(() => h.fed.runOf("parse the files") !== undefined);
    h.fed.runOf("parse the files")!.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done"));
    h.fed.runOf("parse the files")!.end(0);
    await kid.finished;
    await settle();
    const tryRun = h.fed.runsOf(REPORT)[0]!;
    await rt.close();
    h.hold();
    const b = fakeClock(a.clock.now() + after * MIN);
    rt = h.host(b.clock);
    void rt.sessions.list(leadWs.id);
    await settle();
    b.advance(1);
    await settle();
    h.release();
    await settle();
    tryRun.push(init, said("msg_t", "Read the parser report; merging it next."), result("Read the parser report; merging it next."));
    await settle();
    tryRun.end(0);
    for (let i = 0; i < 10; i++) {
      await settle();
      b.advance(10_000);
    }
    const history = await rt.sessions.history(leadWs.id);
    const tryTurn = history.filter(e => e.type === "session.end").at(-1)!.turnId!;
    const toPerson = (await rt.sessions.history(kidWs.id)).filter(e => e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === kidThread);
    return { rows: rowsOf(history, tryTurn), toPerson, launches: h.fed.runsOf(REPORT).length, owed: (await h.store.list(NOTIFY_OWED)).length };
  };

  for (const after of [61, 30]) {
    it(`a next host that comes up ${after > 60 ? "past" : "within"} the line's hour reads the try only once its re-open answered: the lead took the line, one turn, nobody told it failed`, async () => {
      const r = await upLater(after);
      expect(r.toPerson).toEqual([]);
      expect(r.rows).toEqual(["session.start", "delta:text", "session.done", "session.end"]);
      expect(r.launches).toBe(1);
      expect(r.owed).toBe(0);
    });
  }

  for (const w of WARNINGS) {
    it(`a Codex turn whose server prints ${w.name} writes its start row first, and the note after it`, async () => {
      const { fed, host } = twoHosts();
      const rt = host(fakeClock().clock);
      const ws = await createOn(rt, { golden: "snap_g", name: "lead" });
      const lead = await rt.sessions.start(ws.id, { prompt: "orchestrate", harness: "codex" });
      await until(() => fed.runs.length === 1);
      const run = fed.runs[0]!;
      run.push(...(w.early ? [opened[0]!, w.line, opened[1]!] : [...opened, w.line]));
      await until(() => run.writes.some(x => x.includes("turn/start")));
      run.push(turnStarted, agentMessage, completed);
      await until(async () => (await rt.sessions.history(ws.id)).some(e => e.type === "session.done"));
      run.end(0);
      await lead.finished;
      const rows = (await rt.sessions.history(ws.id)).filter(e => e.type === "session.start" || e.type === "session.delta" || e.type === "session.done");
      expect(rows.map(e => (e.type === "session.delta" ? `delta:${e.kind}` : e.type))).toEqual(["session.start", "delta:note", "delta:text", "session.done"]);
    });
  }

  it("a Codex lead's line try whose server warned after the thread answered, and a host restart before turn/started: the line is taken once, by the turn that starts", async () => {
    const { fed, store, host } = twoHosts();
    const a = fakeClock();
    let rt = host(a.clock);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true } });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate", harness: "codex" });
    await until(() => fed.runs.length === 1);
    const leadRun = fed.runs[0]!;
    leadRun.push(...opened);
    await until(() => leadRun.writes.some(w => w.includes("turn/start")));
    leadRun.push(turnStarted, agentMessage, completed);
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    leadRun.end(0);
    await lead.finished;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    const kidThread = kid.view().threadId!;
    await until(() => fed.runOf("parse the files") !== undefined);
    fed.runOf("parse the files")!.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done" && e.threadId === kidThread));
    fed.runOf("parse the files")!.end(0);
    await kid.finished;
    await settle();
    await until(() => fed.runs.length === 3);
    const tryRun = fed.runs[2]!;
    tryRun.push(...opened, WARNINGS[0]!.line);
    await until(() => tryRun.writes.some(w => w.includes("turn/start") && w.includes("Parsed 40 files")));
    await settle();
    expect(await store.list(NOTIFY_OWED)).toHaveLength(1);
    await rt.close();
    const b = fakeClock(a.clock.now());
    rt = host(b.clock);
    await rt.sessions.list(leadWs.id);
    await settle();
    tryRun.push(turnStarted, agentMessage, completed);
    await until(async () => (await store.list(NOTIFY_OWED)).length === 0);
    tryRun.end(0);
    for (let i = 0; i < 20; i++) {
      b.advance(5 * MIN);
      await settle();
    }
    const history = await rt.sessions.history(leadWs.id);
    expect(history.filter(e => e.type === "session.start")).toHaveLength(2);
    expect((await rt.sessions.history(kidWs.id)).concat(history).filter(e => e.type === "session.notify" && e.notify === NOTIFY_ME && e.threadId === kidThread)).toEqual([]);
    expect(fed.runs).toHaveLength(3);
  });

  it("a Codex lead's line try whose server opened the thread and whose launch then lost its computer is tried again under the same request, as a fresh turn", async () => {
    const c = await codexLead();
    c.tryRun.push(...opened);
    await until(() => c.tryRun.writes.some(w => w.includes("turn/start")));
    c.tryRun.fail(launchLost());
    await settle();
    await c.steps(12, 10_000);
    expect(c.fed.runs).toHaveLength(4);
    const next = c.fed.runs[3]!;
    next.push(...opened);
    await until(() => next.writes.some(w => w.includes("turn/start") && w.includes("Parsed 40 files")));
    next.push(turnStarted);
    await until(async () => (await c.store.list(NOTIFY_OWED)).length === 0);
    expect(await c.toPerson()).toBe(0);
  });

  it("a Codex lead's line try that ended before turn/started still leaves the line untaken on the next host, whose retry launches it fresh", async () => {
    const { fed, store, host } = twoHosts();
    const a = fakeClock();
    let rt = host(a.clock);
    const leadWs = await createOn(rt, { golden: "snap_g", name: "lead", agents: { spawn: true } });
    const lead = await rt.sessions.start(leadWs.id, { prompt: "orchestrate", harness: "codex" });
    await until(() => fed.runs.length === 1);
    fed.runs[0]!.push(...opened);
    await until(() => fed.runs[0]!.writes.some(w => w.includes("turn/start")));
    fed.runs[0]!.push(turnStarted, agentMessage, completed);
    await until(async () => (await rt.sessions.history(leadWs.id)).some(e => e.type === "session.done"));
    fed.runs[0]!.end(0);
    await lead.finished;
    const kidWs = await createOn(rt, { golden: "snap_g", name: "kid" });
    const kid = await rt.sessions.start(kidWs.id, { prompt: "parse the files", notify: [lead.view().threadId!] });
    await until(() => fed.runOf("parse the files") !== undefined);
    fed.runOf("parse the files")!.push(init, said("msg_k", REPORT), result(REPORT));
    await until(async () => (await rt.sessions.history(kidWs.id)).some(e => e.type === "session.done"));
    fed.runOf("parse the files")!.end(0);
    await kid.finished;
    await until(() => fed.runs.length === 3);
    fed.runs[2]!.push(...opened);
    await until(() => fed.runs[2]!.writes.some(w => w.includes("turn/start")));
    fed.runs[2]!.fail(launchLost());
    await settle();
    await rt.close();
    const b = fakeClock(a.clock.now());
    rt = host(b.clock);
    await rt.sessions.list(leadWs.id);
    for (let i = 0; i < 12 && fed.runs.length < 4; i++) {
      b.advance(10_000);
      await settle();
    }
    expect(fed.runs).toHaveLength(4);
    const next = fed.runs[3]!;
    next.push(...opened);
    await until(() => next.writes.some(w => w.includes("turn/start") && w.includes("Parsed 40 files")));
    next.push(turnStarted);
    await until(async () => (await store.list(NOTIFY_OWED)).length === 0);
  });
});
