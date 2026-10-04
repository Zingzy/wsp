// SPDX-License-Identifier: AGPL-3.0-only
// A thread's slate on the host, schema 2, end to end in a temp state: the agent writes a setup slate, a window's
// write of the project starts a held run, the person's approval runs it (a real bash in a temp folder), its done
// moves the step with no turn started, a secret reaches a run by its environment and comes back scrubbed, a press
// sends the agent the handle and never the token, and a restart mid-run fails the run and fires its done once.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "@wsp/engine";
import type { AdapterEvent, Caller, EventUnion, SlateView, TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type LocalWiring, type Runtime } from "../src/runtime.js";
import { localExecStream } from "../src/local-exec.js";
import { memoryStore, type Store } from "../src/store.js";
import { stubBackend, testPlatform } from "./stub-backend.js";

const TOKEN = "vcl_tok_9f8e7d6c5b4a3210";

const roots: string[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  for (const at of roots.splice(0)) rmSync(at, { recursive: true, force: true });
});

/** A harness that answers each turn at once and keeps every prompt it was started with. */
function harness(prompts: string[]): HarnessAdapterFactory {
  let n = 0;
  return () => ({
    steers: false,
    resumesAt: true,
    start: o => {
      n += 1;
      prompts.push(o.prompt);
      const sessionId = o.resume ?? `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId },
          { type: "turn.anchor", sessionId, anchor: `a${n}` },
          { type: "turn.done", sessionId, result },
          { type: "session.end", sessionId, exitCode: 0, sawResult: true },
        ];
        for (const e of feed) o.onEvent(e);
        return result;
      });
      return { localId: sessionId, finished, interrupt: async () => {} };
    },
  });
}

/** A host on this computer over a temp root; the store is passed in so a second host can read what the first kept. */
function host(root: string, store: Store, prompts: string[], events: EventUnion[]): Runtime {
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  const local: LocalWiring = {
    backend: new LocalBackend({ root }),
    execStream: o => localExecStream({ root, runDir: join(root, "runs"), ...o }),
    home: () => join(root, ".claude"),
    homeDir: root,
    rootsPath: join(root, "roots"),
    env: () => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root }),
    platform: testPlatform(),
    daemonRoad: async () => ({ url: "http://127.0.0.1:1", expiresAt: Number.MAX_SAFE_INTEGER, daemonToken: "t" }),
  };
  const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: harness(prompts) }, local, statePath: join(state, "state.json") });
  rt.events.on("*", e => events.push(e as EventUnion));
  runtimes.push(rt);
  return rt;
}

const SETUP = `<slate title="Vercel setup">
  <secret name="token" />
  <value name="project" start="" />
  <value name="step" start={1} />
  <value name="fired" start={0} />
  <run name="check" cmd='printf "{\\"name\\":\\"%s\\"}" "$PROJECT"' env={{ PROJECT: $project }} timeout={20} />
  <run name="env" cmd='printf "VERCEL_TOKEN=%s\\n" "$VERCEL_TOKEN" >> .env; echo "wrote $VERCEL_TOKEN"' env={{ VERCEL_TOKEN: $token }} />
  <run name="slow" cmd="sleep 30" timeout={60} />
  <derived name="ok" value={$check.state == 'done' and $check.json.name == $project} />
  <when change={$project} do={start($check)} />
  <when done={$check} do={set($step, 2)} />
  <when done={$slow} do={set($fired, $fired + 1)} />
  <column>
    <input id="tok" label="Vercel token" value={$token} kind="password" />
    <input id="proj" label="Project" value={$project} />
    <text id="found" when={$ok} tone="good">Found {$check.json.name}</text>
    <button id="next" label="Next" variant="primary" when={$ok} onPress={set($step, 3)} />
    <button id="write" label="Write .env" onPress={start($env)} />
    <button id="wait" label="Wait" onPress={start($slow)} />
    <button id="tell" label="Tell the agent" onPress={send("The Vercel setup is done.", $project, $token, $env.out)} />
  </column>
</slate>`;

describe("the slate v2 host", () => {
  it("runs the setup chain without the agent, keeps the secret from it, and fails a run the restart cut off once", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-slates-")));
    roots.push(root);
    const folder = join(root, "project");
    mkdirSync(folder);
    const store = memoryStore();
    const prompts: string[] = [];
    const events: EventUnion[] = [];
    const rt = host(root, store, prompts, events);
    const project = await rt.projects.add({ source: folder });
    const { workspace } = await rt.workspaces.folderFor({ project: project.id });
    const first = await rt.sessions.start(workspace.id, { prompt: "walk me through setting up Vercel in a slate" });
    await first.finished;
    const threadId = first.view().threadId!;
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId } };
    const turnsBefore = prompts.length;

    // The agent writes once.
    const wrote = await rt.slates.write({ text: SETUP }, asThread);
    expect(wrote.version).toBe(1);
    expect(wrote.text).toMatch(/^slate v1/);

    // A window's write of the project starts the check, which waits for the person.
    await rt.slates.state({ threadId, values: { $project: "wsp-landing" } });
    await rt.slates.settled();
    let view = (await rt.slates.get(threadId)) as SlateView;
    expect(view.values["check"]).toMatchObject({ state: "held", why: "needs your approval" });
    expect(view.asks).toHaveLength(1);
    expect(view.asks[0]).toMatchObject({ run: "check", env: { PROJECT: "wsp-landing" }, folder });

    // "Always in this thread": it runs with the name in its environment, and its done moves the step.
    await rt.slates.approve({ threadId, key: view.asks[0]!.key, scope: "thread" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      const v = (await rt.slates.get(threadId))!;
      expect(v.values["check"]).toMatchObject({ state: "done", exit: 0, json: { name: "wsp-landing" } });
      expect(v.values["step"]).toBe(2);
    }, { timeout: 10_000 });
    const afterChain = await rt.slates.read({ threadId, values: ["$ok"] });
    expect(afterChain.values["$ok"]).toBe(true);
    // No turn started anywhere in the chain.
    expect(prompts.length).toBe(turnsBefore);
    // Approved for the thread: a new name runs at once.
    await rt.slates.state({ threadId, values: { $project: "wsp-docs" } });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["check"]).toMatchObject({ state: "done", json: { name: "wsp-docs" } });
    }, { timeout: 10_000 });

    // The secret: an agent cannot write it; the person types it and the record holds a handle.
    await expect(rt.slates.state({ values: { $token: "x" } }, asThread)).rejects.toThrow(/S520/);
    await rt.slates.state({ threadId, values: { $token: TOKEN } });
    await rt.slates.settled();
    view = (await rt.slates.get(threadId))!;
    expect(view.values["token"]).toEqual({ secret: true, set: true, len: TOKEN.length, at: expect.any(Number) });

    // A press that starts an unapproved run is held and answers the sheet; the secret shows as dots.
    const press = await rt.slates.event({ threadId, version: view.version, piece: "write", event: "press", requestId: "r-write" });
    expect(press.outcome).toBe("held");
    expect(press.ask).toMatchObject({ run: "env", env: { VERCEL_TOKEN: "••••" } });
    await rt.slates.approve({ threadId, key: press.ask!.key, scope: "once" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["env"]).toMatchObject({ state: "done", exit: 0 });
    }, { timeout: 10_000 });
    // The run wrote the token to .env through its environment, and its output came back scrubbed.
    expect(readFileSync(join(folder, ".env"), "utf8")).toBe(`VERCEL_TOKEN=${TOKEN}\n`);
    const read = await rt.slates.read({ values: ["$env.out", "$token"] }, asThread);
    expect(read.values["$env.out"]).toBe("wrote [secret:token]\n");
    expect(read.values["$token"]).toMatchObject({ secret: true, set: true });
    expect(JSON.stringify(read)).not.toContain(TOKEN);

    // A press that sends reaches the agent's next turn with the text and the slate: line, the handle, never the token.
    const told = await rt.slates.event({ threadId, version: view.version, piece: "tell", event: "press", requestId: "r-tell" });
    expect(told.outcome).toBe("started");
    await vi.waitFor(() => expect(prompts.length).toBe(turnsBefore + 1));
    const message = prompts.at(-1)!;
    const [text, line] = message.split("\n\n");
    expect(text).toBe("The Vercel setup is done.");
    const sent = JSON.parse(line!.replace(/^slate: /, "")) as Record<string, unknown>;
    expect(sent).toMatchObject({ v: 2, kind: "action", piece: "tell", label: "Tell the agent", event: "press", by: "person", with: { $project: "wsp-docs", $token: { secret: true, set: true, len: TOKEN.length }, "$env.out": "wrote [secret:token]\n" } });
    expect(message).not.toContain(TOKEN);
    // The transcript and the pushes hold no token either.
    expect(JSON.stringify(events)).not.toContain(TOKEN);

    // A run cut off by a restart: approved, running, then the host goes away.
    const wait = await rt.slates.event({ threadId, version: (await rt.slates.get(threadId))!.version, piece: "wait", event: "press", requestId: "r-wait" });
    await rt.slates.approve({ threadId, key: wait.ask!.key, scope: "thread" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["slow"]).toMatchObject({ state: "running" });
    }, { timeout: 10_000 });
    await rt.slates.settled();
    await rt.close();
    runtimes.splice(runtimes.indexOf(rt), 1);

    const again = host(root, store, prompts, events);
    await again.slates.ready();
    await again.slates.settled();
    const restarted = (await again.slates.get(threadId))!;
    expect(restarted.values["slow"]).toMatchObject({ state: "failed", why: "the host restarted while it ran" });
    expect(restarted.values["fired"]).toBe(1);
    // A memory secret is gone with the host; the slate reads it unfilled, and the rest stands.
    expect(restarted.values["token"]).toMatchObject({ set: false });
    expect(restarted.values["step"]).toBe(2);
    await again.close();
    runtimes.splice(runtimes.indexOf(again), 1);

    // A third start finds nothing running: the done fired once.
    const third = host(root, store, prompts, events);
    await third.slates.ready();
    await third.slates.settled();
    expect((await third.slates.get(threadId))!.values["fired"]).toBe(1);
  }, 60_000);

  it("a rewind restores the turn's snapshot, cancels a run in flight with no reaction, and undo rewind puts the slate back", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wsp-slates-")));
    roots.push(root);
    const folder = join(root, "plain");
    mkdirSync(folder);
    const prompts: string[] = [];
    const rt = host(root, memoryStore(), prompts, []);
    const project = await rt.projects.add({ source: folder });
    const { workspace } = await rt.workspaces.folderFor({ project: project.id });
    const first = await rt.sessions.start(workspace.id, { prompt: "one" });
    await first.finished;
    const threadId = first.view().threadId!;
    const asThread: Caller = { origin: "here", by: { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId } };
    await rt.slates.write({ text: SETUP }, asThread);
    const wait = await rt.slates.event({ threadId, version: 1, piece: "wait", event: "press", requestId: "w1" });
    await rt.slates.approve({ threadId, key: wait.ask!.key, scope: "thread" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["slow"]).toMatchObject({ state: "running" });
    }, { timeout: 10_000 });
    // The second turn ends with the run in flight; the third after the person typed a project.
    const second = await rt.sessions.start(workspace.id, { prompt: "two", thread: threadId });
    await second.finished;
    await rt.slates.state({ threadId, values: { $project: "later" } });
    const third = await rt.sessions.start(workspace.id, { prompt: "three", thread: threadId });
    await third.finished;
    await rt.slates.settled();

    await rt.sessions.rewind(threadId, { turnId: second.turnId, files: false });
    await rt.slates.settled();
    const rewound = (await rt.slates.get(threadId))!;
    expect(rewound.values["project"]).toBe("");
    expect(rewound.values["slow"]).toMatchObject({ state: "cancelled", why: "the thread was rewound" });
    expect(rewound.values["fired"]).toBe(0);
    expect(rewound.rewound).toBe(true);
    // The killed command's end is dropped: nothing fires after the restore either.
    await new Promise(r => setTimeout(r, 300));
    await rt.slates.settled();
    expect((await rt.slates.get(threadId))!.values["fired"]).toBe(0);

    await rt.sessions.rewind(threadId, { undo: true });
    await rt.slates.settled();
    const back = (await rt.slates.get(threadId))!;
    expect(back.values["project"]).toBe("later");
    expect(back.values["slow"]).toMatchObject({ state: "cancelled" });

    // A rewind to the turn before the slate existed empties it, keeping approvals.
    await rt.sessions.rewind(threadId, { turnId: first.turnId, files: false });
    const before = (await rt.slates.get(threadId))!;
    expect(before.document).toBeNull();
    expect(before.empty).toBe("rewound-before");
    expect(Object.values(before.approvals).map(a => a.state)).toEqual(["allowed"]);
  }, 60_000);

  it("a timer fires at once when shown, its ticks move no version, a write at the version read passes mid-run, and the clock fills the sketch", async () => {
    const { rt, threadId, asThread } = await threadOn("wsp-slates-timer-");
    const wrote = await rt.slates.write({ text: TICKER }, asThread);
    expect(wrote.version).toBe(1);
    const release = rt.slates.subscribe({ threadId, sources: [] });
    // The first start comes at once, not a period later, and asks the person first.
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["tick"]).toMatchObject({ state: "held" });
    }, { timeout: 2_000 });
    const asked = (await rt.slates.get(threadId))!;
    expect(asked.asks.map(a => a.run)).toEqual(["tick"]);
    await rt.slates.approve({ threadId, key: asked.asks[0]!.key, scope: "thread" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["tick"]).toMatchObject({ state: "running" });
    }, { timeout: 5_000 });

    // While it runs, the agent's write at the version it read passes: the run moved data, not the document.
    const mid = (await rt.slates.get(threadId))!;
    expect(mid.version).toBe(1);
    const patched = await rt.slates.write({ text: `<props id="since" tone="good" />`, ifVersion: 1 }, asThread);
    expect(patched.version).toBe(2);

    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["ticks"]).toBe(1);
    }, { timeout: 10_000 });
    const after = (await rt.slates.get(threadId))!;
    expect(after.version).toBe(2);
    expect(after.revision).toBeGreaterThan(mid.revision);
    // A run's result is the host's to write: no A607, no problem at all.
    expect(after.problems).toEqual([]);
    const pushes = events.filter((e): e is Extract<EventUnion, { type: "slate.values" }> => e.type === "slate.values" && e.threadId === threadId);
    expect(new Set(pushes.map(e => e.version))).toEqual(new Set([1, 2]));
    const revisions = pushes.map(e => e.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));

    // The clock is filled in the sketch, and a function that reads it raises no missing data.
    const read = await rt.slates.read({}, asThread);
    expect(read.text).toMatch(/clock \d{13}/);
    expect(read.text).toMatch(/since \d+d /);
    expect(read.problems).toEqual([]);
    release();
  }, 30_000);

  it("changing how often a command runs, or letting it run hidden, asks again", async () => {
    const { rt, threadId, asThread } = await threadOn("wsp-slates-key-");
    await rt.slates.write({ text: TICKER }, asThread);
    const release = rt.slates.subscribe({ threadId, sources: [] });
    const held = async (): Promise<string> => {
      let key = "";
      await vi.waitFor(async () => {
        await rt.slates.settled();
        const v = (await rt.slates.get(threadId))!;
        expect(v.values["tick"]).toMatchObject({ state: "held" });
        key = v.asks[0]!.key;
      }, { timeout: 5_000 });
      return key;
    };
    const ran = async (n: number): Promise<void> => {
      await vi.waitFor(async () => {
        await rt.slates.settled();
        expect((await rt.slates.get(threadId))!.values["ticks"]).toBe(n);
      }, { timeout: 10_000 });
    };
    const first = await held();
    await rt.slates.approve({ threadId, key: first, scope: "thread" });
    await ran(1);

    // The same declaration written again keeps its timer and its approval: no start, no sheet.
    await rt.slates.write({ text: TICKER }, asThread);
    await rt.slates.settled();
    expect((await rt.slates.get(threadId))!.asks).toEqual([]);

    await rt.slates.write({ text: TICKER.replace("every={60}", "every={120}") }, asThread);
    const slower = await held();
    expect(slower).not.toBe(first);
    await rt.slates.approve({ threadId, key: slower, scope: "thread" });
    await ran(2);

    await rt.slates.write({ text: TICKER.replace("every={60}", "every={120} always") }, asThread);
    const hidden = await held();
    expect([first, slower]).not.toContain(hidden);
    release();
  }, 30_000);

  it("a read answers the JSX-like form by default and the JSON document only when asked", async () => {
    const { rt, asThread } = await threadOn("wsp-slates-read-");
    await rt.slates.write({ text: TICKER }, asThread);
    const plain = await rt.slates.read({}, asThread);
    expect(plain.text).toMatch(/^slate v1/);
    expect(plain.text).toContain(`<slate title="Ticker">`);
    expect(plain.text).toContain(`<run name="tick"`);
    expect(plain.document).toBeUndefined();
    const json = await rt.slates.read({ document: true, text: false }, asThread);
    expect(json.document).toMatchObject({ schema: 2, title: "Ticker" });
    expect(json.text).not.toContain("<slate");

    // A slate that reads the clock only through ago() has it all the same.
    await rt.slates.write({ text: `<slate><value name="at" start={0} /><text id="since">since {ago($at)}</text></slate>` }, asThread);
    const aged = await rt.slates.read({}, asThread);
    expect(aged.text).toMatch(/since \d+d /);
    expect(aged.problems).toEqual([]);
  });

  it("a confirm formula reaches the sheet as its text, read when the run is held", async () => {
    const { rt, threadId, asThread } = await threadOn("wsp-slates-confirm-");
    const text = `<slate>
  <value name="pid" start={19271} />
  <value name="name" start="node" />
  <run name="kill" cmd="true" confirm={\`Kill \${$name} (PID \${$pid})?\`} />
  <button id="kill-it" label="Kill" onPress={start($kill)} />
</slate>`;
    const written = await rt.slates.write({ text }, asThread);
    await rt.slates.event({ threadId, version: written.version, piece: "kill-it", event: "press", requestId: "r-kill" });
    await rt.slates.settled();
    expect((await rt.slates.get(threadId))!.asks).toMatchObject([{ run: "kill", confirm: "Kill node (PID 19271)?" }]);
  });

  it("a check rehearses values and a press on a copy, a bare name writes $name, and a changed command marks its last result stale", async () => {
    const { rt, threadId, asThread } = await threadOn("wsp-slates-rehearse-");
    await rt.slates.write({ text: QUIZ }, asThread);
    const live = (await rt.slates.get(threadId))!;

    // The rehearsal answers the sketch as it would read, and what the press would do; the live slate never moves.
    const tried = await rt.slates.write({ check: true, values: { i: 2 }, press: { piece: "pick", index: 1, action: 0 } }, asThread);
    expect(tried.text).toContain("question 2");
    expect(tried.text).toContain("picked b");
    expect(tried.text).toContain("would start $grade (a press on pick)");
    expect(tried.text).toContain(`would send "Graded."`);
    const after = (await rt.slates.get(threadId))!;
    expect(after.values).toEqual(live.values);
    expect([after.version, after.revision]).toEqual([live.version, live.revision]);
    expect(after.asks).toEqual([]);
    // A rehearsal with a new document sketches that document over the live values, storing nothing.
    const next = await rt.slates.write({ text: QUIZ.replace("question {$i}", "Q{$i}"), check: true, values: { $i: 5 } }, asThread);
    expect(next.text).toContain("Q5");
    expect((await rt.slates.get(threadId))!.version).toBe(live.version);
    await expect(rt.slates.write({ values: { i: 1 } }, asThread)).rejects.toThrow(/only a check/);
    await expect(rt.slates.write({ check: true, press: { piece: "pik" } }, asThread)).rejects.toThrow(/D203.*Did you mean pick/);

    // A bare name is its $name.
    await rt.slates.state({ values: { i: 3 } }, asThread);
    expect((await rt.slates.get(threadId))!.values["i"]).toBe(3);

    // The run's last result, then its command changed: the record stays and says it is stale until it runs again.
    const pressed = await rt.slates.event({ threadId, version: 1, piece: "grade-it", event: "press", requestId: "g1" });
    await rt.slates.approve({ threadId, key: pressed.ask!.key, scope: "once" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["grade"]).toMatchObject({ state: "done", out: "graded paris\n" });
    }, { timeout: 10_000 });
    await rt.slates.write({ text: QUIZ.replace("paris", "rome") }, asThread);
    const stale = (await rt.slates.get(threadId))!;
    expect(stale.values["grade"]).toMatchObject({ state: "done", out: "graded paris\n", stale: true });
    expect((await rt.slates.read({}, asThread)).text).toMatch(/\$grade: done \(exit 0, \d+ ms\), stale: the command changed since it ran/);
    const again = await rt.slates.event({ threadId, version: 3, piece: "grade-it", event: "press", requestId: "g2" });
    await rt.slates.approve({ threadId, key: again.ask!.key, scope: "once" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      const v = (await rt.slates.get(threadId))!.values["grade"];
      expect(v).toMatchObject({ state: "done", out: "graded rome\n" });
      expect(v).not.toHaveProperty("stale");
    }, { timeout: 10_000 });
    // How long it may run is not what it runs: the result stays fresh.
    await rt.slates.write({ text: QUIZ.replace("paris", "rome").replace("timeout={20}", "timeout={30}") }, asThread);
    expect((await rt.slates.get(threadId))!.values["grade"]).not.toHaveProperty("stale");
  }, 30_000);
});

const QUIZ = `<slate title="Quiz">
  <value name="i" start={0} />
  <value name="picked" start="" />
  <run name="grade" cmd="echo graded paris" timeout={20} />
  <column>
    <text id="q">question {$i}</text>
    <text id="p">picked {$picked}</text>
    <table id="pick" items={['a', 'b', 'c']}>
      <col title="Answer" value={item} />
      <action label="Pick" onPress={[set($picked, item), start($grade), send("Graded.", $picked)]} />
    </table>
    <button id="grade-it" label="Grade" onPress={start($grade)} />
  </column>
</slate>`;

const TICKER = `<slate title="Ticker">
  <value name="ticks" start={0} />
  <value name="at" start={0} />
  <run name="tick" cmd="sleep 1; echo tick" every={60} timeout={20} />
  <when done={$tick} do={set($ticks, $ticks + 1)} />
  <column>
    <text id="clock">clock {time.now}</text>
    <text id="since">since {ago($at)}</text>
  </column>
</slate>`;

const events: EventUnion[] = [];

/** A host over a temp root with one finished thread on a plain folder, and that thread as a caller. */
async function threadOn(prefix: string): Promise<{ rt: Runtime; threadId: string; asThread: Caller }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  const folder = join(root, "plain");
  mkdirSync(folder);
  events.length = 0;
  const rt = host(root, memoryStore(), [], events);
  const project = await rt.projects.add({ source: folder });
  const { workspace } = await rt.workspaces.folderFor({ project: project.id });
  const first = await rt.sessions.start(workspace.id, { prompt: "one" });
  await first.finished;
  const threadId = first.view().threadId!;
  return { rt, threadId, asThread: { origin: "here", by: { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId } } };
}

