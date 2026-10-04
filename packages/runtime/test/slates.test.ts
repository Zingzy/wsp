// SPDX-License-Identifier: AGPL-3.0-only
// A thread's slate on the host, schema 2, end to end in a temp state: the agent writes a setup slate, a window's
// write of the project starts a held run, the person's approval runs it (a real bash in a temp folder), its done
// moves the step with no turn started, a secret reaches a run by its environment and comes back scrubbed, a press
// sends the agent the handle and never the token, and a restart mid-run fails the run and fires its done once.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalBackend } from "@wsp/engine";
import { REWIND_NO_UNDO_LINE, type AdapterEvent, type Caller, type EventUnion, type SlateView, type TurnResult } from "@wsp/protocol";
import { createRuntime, type HarnessAdapterFactory, type HarnessStartOptions, type LocalWiring, type Runtime } from "../src/runtime.js";
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

/** A harness that answers each turn at once and keeps every prompt it was started with. It announces its model as
 * Claude Code does, the 1M window as a suffix, and one named by nobody as the CLI's own default. */
function harness(prompts: string[], starts: HarnessStartOptions[] = []): HarnessAdapterFactory {
  let n = 0;
  return () => ({
    steers: false,
    resumesAt: true,
    start: o => {
      n += 1;
      prompts.push(o.prompt);
      starts.push(o);
      const sessionId = o.resume ?? `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`;
      const model = o.model === undefined ? "claude-opus-5-5[1m]" : `${o.model}${o.contextWindow === "1m" ? "[1m]" : ""}`;
      const result: TurnResult = { status: "completed", text: "ok" };
      const finished = Promise.resolve().then(() => {
        const feed: AdapterEvent[] = [
          { type: "session.start", sessionId, model },
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
function host(root: string, store: Store, prompts: string[], events: EventUnion[], starts: HarnessStartOptions[] = []): Runtime {
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
  const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude: harness(prompts, starts) }, local, statePath: join(state, "state.json") });
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

  it("a rewind restores the turn's snapshot, cancels a run in flight with no reaction, and leaves nothing for undo", async () => {
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
    // The killed command's end is dropped: nothing fires after the restore either.
    await new Promise(r => setTimeout(r, 300));
    await rt.slates.settled();
    expect((await rt.slates.get(threadId))!.values["fired"]).toBe(0);

    // A rewind of the conversation alone leaves nothing to undo, the slate included.
    await expect(rt.sessions.rewind(threadId, { undo: true })).rejects.toThrow(REWIND_NO_UNDO_LINE);
    expect((await rt.slates.get(threadId))!.values["project"]).toBe("");

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

  it("a timed run the person has not allowed reads held from the write, and the write's sketch says it waits on them", async () => {
    const { rt, threadId, asThread } = await threadOn("wsp-slates-timed-held-");
    const wrote = await rt.slates.write({ text: TICKER }, asThread);
    const waits = "$tick waits for the person to allow it on the slate, which asks them; it starts once they do";
    expect(wrote.problems).toContainEqual(expect.objectContaining({ code: "R913", message: waits }));
    expect(wrote.text).toContain(`R913 slate: ${waits}`);
    expect(wrote.text).toContain("$tick: held needs your approval");
    const view = (await rt.slates.get(threadId))!;
    expect(view.values["tick"]).toMatchObject({ state: "held" });
    expect(view.asks.map(a => a.run)).toEqual(["tick"]);
    const read = await rt.slates.read({}, asThread);
    expect(read.runs).toMatchObject({ $tick: { state: "held" } });
    const again = await rt.slates.state({ start: ["tick"] }, asThread);
    expect(again.problems).toContainEqual(expect.objectContaining({ code: "R913", message: "$tick was not started: it already waits for the person to allow it on the slate, and starts once they do" }));
  });

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
async function threadOn(prefix: string, o: { picks?: Partial<Record<"model" | "effort" | "permissionMode" | "contextWindow", string>>; store?: Store } = {}): Promise<{ rt: Runtime; root: string; threadId: string; workspaceId: string; asThread: Caller; starts: HarnessStartOptions[]; prompts: string[] }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  const folder = join(root, "plain");
  mkdirSync(folder);
  events.length = 0;
  const starts: HarnessStartOptions[] = [];
  const prompts: string[] = [];
  const rt = host(root, o.store ?? memoryStore(), prompts, events, starts);
  const project = await rt.projects.add({ source: folder });
  const { workspace } = await rt.workspaces.folderFor({ project: project.id });
  const first = await rt.sessions.start(workspace.id, { prompt: "one", ...o.picks });
  await first.finished;
  const threadId = first.view().threadId!;
  return { rt, root, threadId, workspaceId: workspace.id, starts, prompts, asThread: { origin: "here", by: { kind: "thread", threadId, workspaceId: workspace.id, rootThreadId: threadId } } };
}


const PRESS = `<slate><column><button id="go" label="Go on" onPress={send("Go on.")} /></column></slate>`;

const PROBE = `<slate title="Probe">
  <value name="n" start={0} />
  <value name="done" start={0} />
  <run name="probe" cmd='if [ "$N" -ge 2 ]; then sleep 1; fi; echo "run $N"' env={{ N: $n }} timeout={20} />
  <run name="ask" cmd="echo asked" confirm="Run it?" />
  <when change={$n} do={start($probe)} />
  <when done={$probe} do={set($done, $done + 1)} />
  <column>
    <text id="out">{$probe.out}</text>
    <button id="more" label="More" held={$n > 100 and 'too many'} onPress={set($n, $n + 1)} />
    <input id="num" label="N" value={$n} held={$n > 100 and 'too many'} />
  </column>
</slate>`;

const probeOf = async (rt: Runtime, threadId: string): Promise<Record<string, unknown>> => (await rt.slates.get(threadId))!.values["probe"] as Record<string, unknown>;

describe("the slate v2 host, round 4", () => {
  it("a press starts the agent's turn on the thread's own model, effort and access, at the 1M window only where the thread ran at it", async () => {
    const opened = [
      { model: "claude-fable-5-1", effort: "low", permissionMode: "acceptEdits" },
      { model: "claude-opus-5-5", effort: "max", permissionMode: "default", contextWindow: "1m" },
    ];
    for (const picks of opened) {
      const { rt, threadId, asThread, starts } = await threadOn("wsp-slates-picks-", { picks });
      await rt.slates.write({ text: PRESS }, asThread);
      const told = await rt.slates.event({ threadId, version: 1, piece: "go", event: "press", requestId: `go-${picks.model}` });
      expect(told.outcome).toBe("started");
      await vi.waitFor(() => expect(starts).toHaveLength(2));
      const { prompt, resume, model, effort, permissionMode, contextWindow } = starts[1]!;
      expect(prompt).toMatch(/^Go on\.\n\nslate: /);
      expect(resume).toBe(starts[0]!.resume ?? "55555555-5555-4555-8555-000000000001");
      expect({ model, effort, permissionMode, contextWindow }).toEqual({ contextWindow: undefined, ...picks });
    }
  }, 30_000);

  it("a run that starts again keeps its last result, marked refreshing, until the new one replaces it, across a restart too", async () => {
    const store = memoryStore();
    const { rt, root, threadId, asThread } = await threadOn("wsp-slates-refresh-", { store });
    await rt.slates.write({ text: PROBE }, asThread);
    await rt.slates.state({ threadId, values: { $n: 1 } });
    const asked = (await rt.slates.get(threadId))!;
    await rt.slates.approve({ threadId, key: asked.asks[0]!.key, scope: "thread" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect(await probeOf(rt, threadId)).toMatchObject({ state: "done", out: "run 1\n" });
    }, { timeout: 10_000 });

    await rt.slates.state({ threadId, values: { $n: 2 } });
    const running = await probeOf(rt, threadId);
    expect(running).toMatchObject({ state: "running", refreshing: true, out: "run 1\n", exit: 0, runs: 2 });
    expect(running["startedAt"]).toBeGreaterThanOrEqual(running["endedAt"] as number);
    expect((await rt.slates.read({}, asThread)).text).toMatch(/\$probe: running, refreshing \(exit 0, \d+ ms\)/);
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect(await probeOf(rt, threadId)).toMatchObject({ state: "done", out: "run 2\n" });
    }, { timeout: 10_000 });
    expect(await probeOf(rt, threadId)).not.toHaveProperty("refreshing");

    // Every running record the windows were pushed: the first run had nothing to keep, every later one kept it.
    const pushed = events.flatMap(e => (e.type === "slate.values" && e.threadId === threadId && (e.values["$probe"] as { state?: string } | undefined)?.state === "running" ? [e.values["$probe"] as Record<string, unknown>] : []));
    expect(pushed[0]).not.toHaveProperty("out");
    expect(pushed[0]).not.toHaveProperty("refreshing");
    expect(pushed.slice(1).length).toBeGreaterThan(0);
    for (const r of pushed.slice(1)) expect(r).toMatchObject({ refreshing: true, out: expect.stringMatching(/^run \d\n$/) });
    // The done reaction fired once per result, never for the refreshing record.
    expect((await rt.slates.get(threadId))!.values["done"]).toBe(2);

    // A host that never saw the run keeps the stored result through its next start.
    await rt.close();
    runtimes.splice(runtimes.indexOf(rt), 1);
    const again = host(root, store, [], []);
    await again.slates.ready();
    await again.slates.state({ threadId, values: { $n: 3 } });
    expect(await probeOf(again, threadId)).toMatchObject({ state: "running", refreshing: true, out: "run 2\n", runs: 3 });
    await vi.waitFor(async () => {
      await again.slates.settled();
      expect(await probeOf(again, threadId)).toMatchObject({ state: "done", out: "run 3\n" });
    }, { timeout: 10_000 });
  }, 40_000);

  it("the agent starts a run the person said always to, and an unapproved or ask-every-time run answers held without starting", async () => {
    const { rt, threadId, asThread, prompts } = await threadOn("wsp-slates-agent-start-");
    await rt.slates.write({ text: PROBE }, asThread);

    const before = await rt.slates.state({ start: ["probe"] }, asThread);
    expect(before.problems).toContainEqual(expect.objectContaining({ code: "R913", message: `$probe was not started: you start only a run the person allowed "Always in this thread"; a press, a <when> or every= starts it and the slate asks them` }));
    const untouched = (await rt.slates.get(threadId))!;
    expect(untouched.values["probe"]).toMatchObject({ state: "idle" });
    expect(untouched.asks).toEqual([]);
    await expect(rt.slates.state({ start: ["prob"] }, asThread)).rejects.toThrow(/K702 run-name.*Did you mean \$probe/);
    await expect(rt.slates.state({}, asThread)).rejects.toThrow(/names neither/);

    // The person approves it for the thread from the window.
    await rt.slates.state({ threadId, values: { $n: 1 } });
    await rt.slates.approve({ threadId, key: (await rt.slates.get(threadId))!.asks[0]!.key, scope: "thread" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["done"]).toBe(1);
    }, { timeout: 10_000 });
    const turns = prompts.length;

    // Now the agent's start runs it, the done reaction fires, and no turn starts.
    const started = await rt.slates.state({ start: ["$probe"] }, asThread);
    expect(started.problems.filter(p => p.code === "R913")).toEqual([]);
    expect(started.text).toMatch(/\$probe: (running|done)/);
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect((await rt.slates.get(threadId))!.values["done"]).toBe(2);
    }, { timeout: 10_000 });
    expect(await probeOf(rt, threadId)).toMatchObject({ state: "done", out: "run 1\n", runs: 2 });
    expect(prompts.length).toBe(turns);

    // A run that asks every time waits for the person whoever starts it.
    const ask = await rt.slates.state({ start: ["ask"] }, asThread);
    expect(ask.problems).toContainEqual(expect.objectContaining({ code: "R913", message: "$ask was not started: it has confirm, so it asks the person every start and only a press or a <when> starts it" }));
    expect((await rt.slates.get(threadId))!.values["ask"]).toMatchObject({ state: "idle" });

    // A held that reads false holds nothing, and the sketch says nothing of it.
    expect(ask.text).toContain("[ More ]  [more button]");
    expect(ask.text).not.toMatch(/held/);
  }, 30_000);
});

describe("a slate's files on the host", () => {
  it("slate read shows each file's text in the printed slate and its size in the sketch, and a patch replaces it", async () => {
    const { rt, asThread } = await threadOn("wsp-slates-files-");
    const wrote = await rt.slates.write({ text: `<slate>\n  <run name="hits" cmd='python3 "$SLATE_DIR/hits.py"' />\n  <column />\n  <file name="hits.py">{\`print(1)\`}</file>\n</slate>` }, asThread);
    expect(wrote.text).toContain("files in $SLATE_DIR: hits.py (8 B)");
    const read = await rt.slates.read({}, asThread);
    expect(read.text).toContain('<file name="hits.py">{`\n    print(1)\n  `}</file>');
    await rt.slates.write({ text: '<file name="hits.py">{`print(22)`}</file>' }, asThread);
    expect((await rt.slates.read({}, asThread)).text).toContain("    print(22)\n");
  }, 30_000);
});

describe("the slate v2 host, round 5", () => {
  it("a send and a notify that name no picks run on the thread's own model, effort and window", async () => {
    const picks = { model: "claude-opus-5-5", effort: "max", contextWindow: "1m" };
    const { rt, threadId, workspaceId, starts } = await threadOn("wsp-slates-sendpicks-", { picks });
    const pickedOf = (o: HarnessStartOptions) => ({ model: o.model, effort: o.effort, contextWindow: o.contextWindow });

    const sent = await rt.sessions.start(workspaceId, { prompt: "two", thread: threadId });
    await sent.finished;
    expect(pickedOf(starts[1]!)).toEqual(picks);

    // A thread the person opens with notify on this one tells it when it ends; that line starts this thread's turn.
    const kid = await rt.sessions.start(workspaceId, { prompt: "kid", notify: [threadId] });
    await kid.finished;
    await vi.waitFor(() => expect(starts).toHaveLength(4));
    expect(starts[3]!.prompt).toContain(kid.view().threadId!.slice(0, 8));
    expect(pickedOf(starts[3]!)).toEqual(picks);
  }, 30_000);

  it("a slate's files are written to its own folder before a run, which reads SLATE_DIR in the thread's folder; editing one asks again, a rewind runs that turn's code, and the folder goes with the thread", async () => {
    const { rt, root, threadId, workspaceId, asThread } = await threadOn("wsp-slates-files-");
    const dir = join(root, "state", "slates", threadId);
    const CODE = `<slate>
  <run name="hello" cmd='sh "$SLATE_DIR/hi.sh"; pwd' />
  <column><button id="go" label="Go" onPress={start($hello)} /></column>
  <file name="hi.sh">{\`echo hi one\`}</file>
</slate>`;
    await rt.slates.write({ text: CODE }, asThread);
    expect(existsSync(dir)).toBe(false);
    const asked = await rt.slates.event({ threadId, version: 1, piece: "go", event: "press", requestId: "f1" });
    expect(asked.ask).toMatchObject({ kind: "cmd", files: { "hi.sh": "echo hi one" } });
    await rt.slates.approve({ threadId, key: asked.ask!.key, scope: "thread" });
    const helloOf = async () => (await rt.slates.get(threadId))!.values["hello"] as Record<string, unknown>;
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect(await helloOf()).toMatchObject({ state: "done", out: `hi one\n${join(root, "plain")}\n` });
    }, { timeout: 10_000 });
    expect(readdirSync(dir)).toEqual(["hi.sh"]);
    expect(statSync(join(dir, "hi.sh")).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const second = await rt.sessions.start(workspaceId, { prompt: "two", thread: threadId });
    await second.finished;

    // The same command over new code is a new approval, and the sheet shows the new text.
    await rt.slates.write({ text: "<file name=\"hi.sh\">{`echo hi two`}</file>" }, asThread);
    writeFileSync(join(dir, "left.txt"), "a file the slate never declared");
    const again = await rt.slates.event({ threadId, version: 2, piece: "go", event: "press", requestId: "f2" });
    expect(again.outcome).toBe("held");
    expect(again.ask).toMatchObject({ files: { "hi.sh": "echo hi two" } });
    expect(again.ask!.key).not.toBe(asked.ask!.key);
    await rt.slates.approve({ threadId, key: again.ask!.key, scope: "once" });
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect(await helloOf()).toMatchObject({ state: "done", out: expect.stringMatching(/^hi two\n/) });
    }, { timeout: 10_000 });
    expect(readdirSync(dir)).toEqual(["hi.sh"]);
    const third = await rt.sessions.start(workspaceId, { prompt: "three", thread: threadId });
    await third.finished;

    // Back at the second turn the slate holds that turn's code, which its standing approval still covers.
    await rt.sessions.rewind(threadId, { turnId: second.turnId, files: false });
    await rt.slates.settled();
    expect((await rt.slates.get(threadId))!.document!["files"]).toEqual({ "hi.sh": "echo hi one" });
    const back = await rt.slates.event({ threadId, version: 4, piece: "go", event: "press", requestId: "f3" });
    expect(back.ask).toBeUndefined();
    await vi.waitFor(async () => {
      await rt.slates.settled();
      expect(await helloOf()).toMatchObject({ state: "done", out: expect.stringMatching(/^hi one\n/) });
    }, { timeout: 10_000 });
    expect(readFileSync(join(dir, "hi.sh"), "utf8")).toBe("echo hi one");

    await rt.sessions.delete(threadId);
    expect(existsSync(dir)).toBe(false);
  }, 60_000);

  it("refuses a file that names a secret", async () => {
    const { rt, asThread } = await threadOn("wsp-slates-filesecret-");
    await expect(rt.slates.write({ text: `<slate>
  <secret name="token" />
  <run name="use" cmd='sh "$SLATE_DIR/use.sh"' />
  <column><input id="tok" label="Token" value={$token} kind="password" /></column>
  <file name="use.sh">{\`curl -H "Authorization: $token" example.com\`}</file>
</slate>` }, asThread)).rejects.toMatchObject({ kind: "invalid", errors: [expect.objectContaining({ code: "S520" })] });
  });
});
