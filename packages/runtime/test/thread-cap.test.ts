// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import { HERE_PLACE_ID, HOST_TOKEN_ENV, NOTIFY_ME, TURN_TOKEN_ENV, threadMessages, type TurnResult } from "@wsp/protocol";
import { createRuntime, wiredPlace, type HarnessAdapterFactory } from "../src/runtime.js";
import { newPlaceKeyPair } from "../src/places.js";
import { serveRuntime } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { stubBackend, createOn, fakeLocal } from "./stub-backend.js";
import { until } from "./until.js";
import { WsClient } from "./ws-client.js";
import { HERE, wiring } from "./place-join.js";
import { ctx, placesOf } from "./places-fixture.js";
import { joined } from "./box-fixture.js";

/** A harness whose turns run until the test ends them, by prompt, keeping the environment and the order each was
 * started in. */
const heldTurns = () => {
  const ends = new Map<string, () => void>();
  const envs = new Map<string, Record<string, string>>();
  const started: string[] = [];
  const live = new Set<string>();
  let most = 0;
  const adapter: HarnessAdapterFactory = c => ({
    steers: false,
    start: ({ onEvent, prompt }) => {
      if (prompt.startsWith("boom")) throw new Error("the agent would not start");
      const sessionId = randomUUID();
      envs.set(prompt, { ...c.env });
      started.push(prompt);
      live.add(prompt);
      most = Math.max(most, live.size);
      onEvent({ type: "session.start", sessionId });
      const result: TurnResult = { status: "completed", text: "ok" };
      let over = false;
      const end = (): void => {
        if (over) return;
        over = true;
        live.delete(prompt);
        onEvent({ type: "turn.done", sessionId, result });
        onEvent({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
        done(result);
      };
      let done!: (r: TurnResult) => void;
      const finished = new Promise<TurnResult>(r => (done = r));
      ends.set(prompt, end);
      return { localId: sessionId, finished, interrupt: async () => end() };
    },
  });
  return { ends, envs, started, live, most: () => most, adapter };
};

const onHere = async (root: string, adapter: HarnessAdapterFactory, store = memoryStore()) => {
  const backend = stubBackend();
  ctx.runtime = createRuntime({ backend, places: wiredPlace("solari", backend), store, adapters: { claude: adapter, codex: adapter }, placeLinks: wiring(newPlaceKeyPair(), { id: "solari", rateUsdPerHour: 0.11 }), local: fakeLocal(root), agents: { here: { url: "http://127.0.0.1:4801" } } });
  ctx.srv = await serveRuntime(ctx.runtime, { port: 0, authToken: "host-token", devices: ctx.runtime.devices });
  const host = await WsClient.connect(ctx.srv.port, { token: "host-token" });
  const set = (threads: number) => host.request("places.set", { placeId: HERE_PLACE_ID, threads });
  return { host, set };
};

const settled = async <T>(p: Promise<T>, ms: number): Promise<boolean> => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise(r => setTimeout(r, ms));
  return done;
};

const rowsOf = (workspaceId: string) => ctx.runtime!.sessions.list(workspaceId);

describe("a computer's threads at once, with a turn a running thread follows run in that thread's slot", () => {
  it("runs a lead's child on the lead's own computer in the lead's slot, so a lead that waits on its child is never stuck behind itself", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-tree-"));
    const { ends, envs, adapter } = heldTurns();
    try {
      const { host, set } = await onHere(root, adapter);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const asLead = await WsClient.connect(ctx.srv!.port, { token: envs.get("lead")![HOST_TOKEN_ENV]! });
      const child = asLead.request("sessions.start", { prompt: "child" });
      expect(await settled(child, 2000)).toBe(true);
      expect(ends.has("child")).toBe(true);
      expect((await rowsOf(mac.id)).find(r => r.prompt === "child")?.capped).toBeUndefined();
      // The child runs in the lead's slot, and the row still counts both agents, so a thread of another tree waits.
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ running: 2, cap: { threads: 1 } });
      const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
      const outside = ctx.runtime!.sessions.start(other.id, { prompt: "outside" });
      await until(async () => (await rowsOf(other.id)).some(r => r.capped !== undefined));
      expect((await rowsOf(other.id)).find(r => r.capped !== undefined)?.capped).toMatchObject({ running: 2, atOnce: 1 });
      ends.get("lead")!();
      await lead.finished;
      expect(ends.has("outside")).toBe(false);
      ends.get("child")!();
      await outside;
      await until(() => ends.has("outside"));
      asLead.close();
      host.close();
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers a start that asks to hear of its hold the moment it is held, with the wait, and starts it when a slot frees", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-answer-"));
    const { ends, adapter } = heldTurns();
    try {
      const { host, set } = await onHere(root, adapter);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
      const two = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "two" });
      await set(1);
      const first = await ctx.runtime!.sessions.start(mac.id, { prompt: "one" });
      const asked = host.request("sessions.start", { workspaceId: two.id, prompt: "two", requestId: "req_two", answerHeld: true });
      expect(await settled(asked, 1500)).toBe(true);
      const answer = (await asked) as { ok: boolean; outcome: string; turnId: string; session: { capped?: unknown; threadId?: string } };
      expect(answer).toMatchObject({ ok: true, outcome: "held", session: { capped: { placeId: HERE_PLACE_ID, place: HERE.name, running: 1, atOnce: 1 } } });
      expect(ends.has("two")).toBe(false);
      ends.get("one")!();
      await first.finished;
      await until(() => ends.has("two"));
      expect((await rowsOf(two.id)).find(r => r.threadId === answer.session.threadId)).toMatchObject({ status: "running" });
      // A start that does not ask is answered once it starts, as before.
      const unasked = host.request("sessions.start", { workspaceId: mac.id, prompt: "three" });
      expect(await settled(unasked, 500)).toBe(false);
      ends.get("two")!();
      expect(await unasked).toMatchObject({ ok: true, outcome: "started" });
      host.close();
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a held start whose workspace is deleted, and a slot that frees later never launches it", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-delete-"));
    const { ends, adapter } = heldTurns();
    try {
      const { host, set } = await onHere(root, adapter);
      const first = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "first" });
      const second = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "second" });
      await set(1);
      await ctx.runtime!.sessions.start(first.id, { prompt: "one" });
      const two = ctx.runtime!.sessions.start(second.id, { prompt: "two" });
      await until(async () => (await rowsOf(second.id)).some(r => r.capped !== undefined));
      await ctx.runtime!.workspaces.delete(second.id);
      await expect(two).rejects.toThrow(/./);
      ends.get("one")!();
      const three = ctx.runtime!.sessions.start(first.id, { prompt: "three" });
      await three;
      await new Promise(r => setTimeout(r, 200));
      expect(ends.has("two")).toBe(false);
      expect(ends.has("three")).toBe(true);
      host.close();
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says the wait again in the transcript when the count it waits on moves", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-again-"));
    const { ends, adapter } = heldTurns();
    try {
      const { host, set } = await onHere(root, adapter);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
      await set(1);
      await ctx.runtime!.sessions.start(mac.id, { prompt: "one" });
      const two = ctx.runtime!.sessions.start(mac.id, { prompt: "two" });
      await until(async () => (await rowsOf(mac.id)).some(r => r.capped !== undefined));
      const three = ctx.runtime!.sessions.start(mac.id, { prompt: "three" });
      await until(async () => (await rowsOf(mac.id)).filter(r => r.capped !== undefined).length === 2);
      await set(2);
      await two;
      await until(async () => (await rowsOf(mac.id)).find(r => r.prompt === "three")?.capped?.running === 2);
      const threeRow = (await rowsOf(mac.id)).find(r => r.prompt === "three")!;
      const said = (await ctx.runtime!.sessions.history(mac.id)).filter(e => e.type === "session.capped" && e.turnId === threeRow.id) as unknown as { running: number; atOnce: number }[];
      expect(said.map(e => `${e.running} of ${e.atOnce}`)).toEqual(["1 of 1", "2 of 2"]);
      // A wake that moved nothing says nothing more.
      await set(2);
      await new Promise(r => setTimeout(r, 100));
      expect((await ctx.runtime!.sessions.history(mac.id)).filter(e => e.type === "session.capped" && e.turnId === threeRow.id)).toHaveLength(2);
      host.close();
      for (const end of ends.values()) end();
      await three;
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts the line that wakes a lead when its child ends even while its computer is full", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-wake-"));
    const { ends, envs, started, adapter } = heldTurns();
    try {
      const { host, set } = await onHere(root, adapter);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const asLead = await WsClient.connect(ctx.srv!.port, { token: envs.get("lead")![HOST_TOKEN_ENV]! });
      await asLead.request("sessions.start", { prompt: "child", notify: [NOTIFY_ME], turnToken: envs.get("lead")![TURN_TOKEN_ENV]! });
      await until(() => ends.has("child"));
      ends.get("lead")!();
      await lead.finished;
      // A thread of another tree takes the slot the moment the child's ends, and the lead's wake still starts.
      const outside = ctx.runtime!.sessions.start(other.id, { prompt: "outside" });
      await until(async () => (await rowsOf(other.id)).some(r => r.capped !== undefined));
      ends.get("child")!();
      await outside;
      await until(() => started.length === 4);
      expect(started.filter(p => ["lead", "child", "outside"].includes(p))).toHaveLength(3);
      asLead.close();
      host.close();
    } finally {
      for (const end of ends.values()) end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a box's threads at once", () => {
  it("holds a thread in a project's folder on a box past the default the box's own memory and cores give, and starts it when one ends", async () => {
    const { ends, adapter } = heldTurns();
    try {
      // The box reports 4 cores and 4 GB, so 2 at once; the computer the app runs on would take 8.
      const { rt, project } = await joined({ adapters: { claude: adapter } });
      const { workspace } = await rt.workspaces.folderFor({ project: project.id });
      await rt.sessions.start(workspace.id, { prompt: "one", harness: "claude" });
      await rt.sessions.start(workspace.id, { prompt: "two", harness: "claude" });
      const three = rt.sessions.start(workspace.id, { prompt: "three", harness: "claude" });
      await until(async () => (await rt.sessions.list(workspace.id)).some(r => r.capped !== undefined));
      expect((await rt.sessions.list(workspace.id)).find(r => r.capped !== undefined)?.capped).toMatchObject({ place: "hetzner", running: 2, atOnce: 2 });
      expect(ends.has("three")).toBe(false);
      ends.get("one")!();
      await three;
      expect(ends.has("three")).toBe(true);
    } finally {
      for (const end of ends.values()) end();
    }
  });
});

describe("a computer's threads at once against what one tree opens", () => {
  it("runs the children a lead starts detached one at a time on a computer set to 1, each in a slot of its own", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-fan-"));
    const { ends, envs, live, most, adapter } = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { host, set } = await onHere(root, adapter);
      clients.push(host);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const asLead = await WsClient.connect(ctx.srv!.port, { token: envs.get("lead")![HOST_TOKEN_ENV]! });
      clients.push(asLead);
      for (let i = 0; i < 6; i++) expect(await asLead.request("sessions.start", { prompt: `child-${i}`, answerHeld: true })).toMatchObject({ outcome: "held" });
      await new Promise(r => setTimeout(r, 200));
      expect([...live]).toEqual(["lead"]);
      ends.get("lead")!();
      await lead.finished;
      await until(() => ends.has("child-0"));
      const asChild = await WsClient.connect(ctx.srv!.port, { token: envs.get("child-0")![HOST_TOKEN_ENV]! });
      clients.push(asChild);
      // A child following its own child, as a blocking run does, gets it started in its slot rather than waiting on itself.
      expect(await settled(asChild.request("sessions.start", { prompt: "grand-0" }), 2000)).toBe(true);
      expect(await asChild.request("sessions.start", { prompt: "grand-1", answerHeld: true })).toMatchObject({ outcome: "held" });
      await new Promise(r => setTimeout(r, 200));
      expect([...live].sort()).toEqual(["child-0", "grand-0"]);
      // The row and the waiting line count every agent running there.
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ running: 2, cap: { threads: 1 } });
      ends.get("grand-0")!();
      ends.get("child-0")!();
      await until(() => ends.has("child-1"));
      await new Promise(r => setTimeout(r, 200));
      expect([...live]).toEqual(["child-1"]);
      for (let i = 1; i < 6; i++) {
        await until(() => ends.has(`child-${i}`));
        expect([...live]).toEqual([`child-${i}`]);
        ends.get(`child-${i}`)!();
      }
      await until(() => ends.has("grand-1"));
      expect(most()).toBe(2);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds the reviewer a child opens detached, whatever the lead runs next, so one agent works at a time", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-orphans-"));
    const { ends, envs, live, adapter } = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { host, set } = await onHere(root, adapter);
      clients.push(host);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const asLead = await WsClient.connect(ctx.srv!.port, { token: envs.get("lead")![HOST_TOKEN_ENV]! });
      clients.push(asLead);
      const outside = ctx.runtime!.sessions.start(other.id, { prompt: "outside" });
      outside.catch(() => {});
      await until(async () => (await rowsOf(other.id)).some(r => r.capped !== undefined));
      const seen: string[][] = [];
      for (let i = 0; i < 6; i++) {
        // The lead runs one child and follows it to its end, as a blocking run does.
        await asLead.request("sessions.start", { prompt: `child-${i}`, answerHeld: true, followed: true });
        await until(() => ends.has(`child-${i}`));
        // The child opens its reviewer with notify me and ends its turn, as the skill tells every wsp thread to.
        const asChild = await WsClient.connect(ctx.srv!.port, { token: envs.get(`child-${i}`)![HOST_TOKEN_ENV]! });
        clients.push(asChild);
        expect(await asChild.request("sessions.start", { prompt: `grand-${i}`, notify: [NOTIFY_ME], turnToken: envs.get(`child-${i}`)![TURN_TOKEN_ENV]!, answerHeld: true })).toMatchObject({ outcome: "held" });
        seen.push([...live].sort());
        ends.get(`child-${i}`)!();
        await new Promise(r => setTimeout(r, 50));
        seen.push([...live].sort());
      }
      // The lead waits on each child while it works, so one agent works at a time, and no reviewer starts under it.
      expect(seen.every(agents => agents.length === 1 || (agents.length === 2 && agents[1] === "lead" && agents[0]!.startsWith("child-")))).toBe(true);
      expect([...ends.keys()].filter(p => p.startsWith("grand-"))).toEqual([]);
      expect(ends.has("outside")).toBe(false);
      ends.get("lead")!();
      await lead.finished;
      // Once the lead ends, the line goes in the order it came: the thread of another tree first, then each reviewer.
      await until(() => ends.has("outside"));
      expect([...live]).toEqual(["outside"]);
      ends.get("outside")!();
      await until(() => ends.has("grand-0"));
      expect([...live]).toEqual(["grand-0"]);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a chain of blocking starts four deep on a computer set to 1, each in the slot of the thread waiting on it", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-chain-"));
    const { ends, envs, live, adapter } = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { host, set } = await onHere(root, adapter);
      clients.push(host);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true, maxMachines: 3, maxDepth: 4 } });
      await set(1);
      await ctx.runtime!.sessions.start(mac.id, { prompt: "l0" });
      for (let d = 1; d <= 4; d++) {
        const asParent = await WsClient.connect(ctx.srv!.port, { token: envs.get(`l${d - 1}`)![HOST_TOKEN_ENV]! });
        clients.push(asParent);
        // No answerHeld: the request answers at the launch, so its caller waits on it.
        expect(await settled(asParent.request("sessions.start", { prompt: `l${d}` }), 2000)).toBe(true);
      }
      expect([...live].sort()).toEqual(["l0", "l1", "l2", "l3", "l4"]);
      expect((await placesOf()).find(p => p.id === HERE_PLACE_ID)).toMatchObject({ running: 5, cap: { threads: 1 } });
    } finally {
      for (const c of clients) c.close();
      for (const end of [...ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a followed turn in the slot it borrowed when the thread it borrowed from ends first, so a thread of another tree waits for all of it", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-keeps-"));
    const { ends, envs, adapter } = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { host, set } = await onHere(root, adapter);
      clients.push(host);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
      await set(1);
      await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const asLead = await WsClient.connect(ctx.srv!.port, { token: envs.get("lead")![HOST_TOKEN_ENV]! });
      clients.push(asLead);
      await asLead.request("sessions.start", { prompt: "child", answerHeld: true, followed: true });
      await until(() => ends.has("child"));
      const asChild = await WsClient.connect(ctx.srv!.port, { token: envs.get("child")![HOST_TOKEN_ENV]! });
      clients.push(asChild);
      await asChild.request("sessions.start", { prompt: "grand", answerHeld: true, followed: true });
      await until(() => ends.has("grand"));
      const answer = await host.request("sessions.start", { workspaceId: other.id, prompt: "outside", answerHeld: true });
      expect(answer).toMatchObject({ outcome: "held", session: { capped: { running: 3, atOnce: 1 } } });
      // The child's follow gives up and its turn ends with the grandchild still running: the grandchild holds a slot of
      // its own beside the lead's, and the thread of another tree waits for both.
      for (const p of ["child", "lead"]) {
        ends.get(p)!();
        await new Promise(r => setTimeout(r, 200));
        expect(ends.has("outside")).toBe(false);
      }
      ends.get("grand")!();
      await until(() => ends.has("outside"));
    } finally {
      for (const c of clients) c.close();
      for (const end of [...ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a followed send from a thread into its lead or a thread beside it in the sender's slot", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-ask-"));
    const { ends, envs, live, adapter } = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { host, set } = await onHere(root, adapter);
      clients.push(host);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const leadThread = lead.view().threadId!;
      const asLead = await WsClient.connect(ctx.srv!.port, { token: envs.get("lead")![HOST_TOKEN_ENV]! });
      clients.push(asLead);
      const b = (await asLead.request("sessions.start", { prompt: "b", answerHeld: true, followed: true })) as { session: { threadId: string } };
      await until(() => ends.has("b"));
      ends.get("b")!();
      await asLead.request("sessions.start", { prompt: "a", answerHeld: true, followed: true });
      await until(() => ends.has("a"));
      // The lead's follow gave up and its turn ended: a holds the slot alone.
      ends.get("lead")!();
      await lead.finished;
      const asA = await WsClient.connect(ctx.srv!.port, { token: envs.get("a")![HOST_TOKEN_ENV]! });
      clients.push(asA);
      // a asks its lead, then the thread beside it, and follows each answer, as send without detach does.
      expect(await asA.request("sessions.start", { workspaceId: mac.id, thread: leadThread, prompt: "question for the lead", answerHeld: true, followed: true })).toMatchObject({ outcome: "started" });
      await until(() => ends.has("question for the lead"));
      ends.get("question for the lead")!();
      expect(await asA.request("sessions.start", { workspaceId: mac.id, thread: b.session.threadId, prompt: "question for b", answerHeld: true, followed: true })).toMatchObject({ outcome: "started" });
      await until(() => ends.has("question for b"));
      expect([...live].sort()).toEqual(["a", "question for b"]);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops a held turn whose stop lands between a wake and its next look, and never launches it", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-stop-"));
    const results: string[] = [];
    try {
      for (let offset = 0; offset < 8; offset++) {
        const { ends, envs, live, adapter } = heldTurns();
        const { host, set } = await onHere(root, adapter);
        const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
        const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
        await set(1);
        await ctx.runtime!.sessions.start(mac.id, { prompt: "a" });
        const asA = await WsClient.connect(ctx.srv!.port, { token: envs.get("a")![HOST_TOKEN_ENV]! });
        await asA.request("sessions.start", { prompt: "a2", answerHeld: true, followed: true });
        await until(() => ends.has("a2"));
        const p = ctx.runtime!.sessions.start(other.id, { prompt: "p" }).then(
          () => "started",
          (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
        );
        await until(async () => (await rowsOf(other.id)).some(r => r.capped !== undefined));
        const turn = (await rowsOf(other.id)).find(r => r.capped !== undefined)!.id;
        // a2 ending wakes every held turn, which reads the computer's report before it looks again: the stop is asked
        // some ticks before that end, so across the offsets it reads the wait before, during and after the wake.
        const stop = ctx.runtime!.sessions.interrupt(turn);
        for (let i = 0; i < offset; i++) await Promise.resolve();
        ends.get("a2")!();
        const stopped = await Promise.race([stop.then(r => r.outcome), new Promise<string>(r => setTimeout(() => r("pending"), 1000))]);
        ends.get("a")!();
        await new Promise(r => setTimeout(r, 200));
        results.push(`${offset}: stop ${stopped} | p ${await p} | launched ${ends.has("p")} | running ${live.has("p")}`);
        asA.close();
        host.close();
        for (const end of [...ends.values()]) end();
        await ctx.srv?.close();
        ctx.srv = undefined;
        await ctx.runtime?.close();
        ctx.runtime = undefined;
      }
      expect(results.filter(r => !r.includes("stop accepted | p rejected: stopped before it started") || r.includes("launched true"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("a stop asked while a held turn's slot frees", () => {
  it("never loses to the look that lets the turn through, across 40 timings", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-stop-frees-"));
    const results: string[] = [];
    try {
      for (let offset = 0; offset < 40; offset++) {
        const { ends, adapter } = heldTurns();
        const { host, set } = await onHere(root, adapter);
        const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
        const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
        await set(1);
        await ctx.runtime!.sessions.start(mac.id, { prompt: "a" });
        const p = ctx.runtime!.sessions.start(other.id, { prompt: "p" }).then(
          () => "started",
          (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
        );
        await until(async () => (await rowsOf(other.id)).some(r => r.capped !== undefined));
        const turn = (await rowsOf(other.id)).find(r => r.capped !== undefined)!.id;
        // The stop is asked some ticks before a ends and frees the slot p waits for.
        const stop = ctx.runtime!.sessions.interrupt(turn).then(r => r.outcome);
        for (let i = 0; i < offset; i++) await Promise.resolve();
        ends.get("a")!();
        const said = await Promise.race([stop, new Promise<string>(r => setTimeout(() => r("pending"), 1000))]);
        await new Promise(r => setTimeout(r, 100));
        results.push(`${offset}: stop ${said} | p ${(await p).replace(/running \d of/, "running n of")} | launched ${ends.has("p")}`);
        host.close();
        for (const end of [...ends.values()]) end();
        await ctx.srv?.close();
        ctx.srv = undefined;
        await ctx.runtime?.close();
        ctx.runtime = undefined;
      }
      expect(results.filter(r => !r.includes("stop accepted | p rejected: stopped before it started") || r.includes("launched true"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("a stop asked by a held turn's id once its slot freed", () => {
  it("stops the turn it launched as, wherever between the slot freeing and the launch it lands, across 24 timings", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-stop-after-"));
    const results: string[] = [];
    try {
      for (let offset = 0; offset < 24; offset++) {
        const { ends, live, adapter } = heldTurns();
        const { host, set } = await onHere(root, adapter);
        const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
        const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
        await set(1);
        await ctx.runtime!.sessions.start(mac.id, { prompt: "a" });
        const p = ctx.runtime!.sessions.start(other.id, { prompt: "p" }).then(
          () => "started",
          (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
        );
        await until(async () => (await rowsOf(other.id)).some(r => r.capped !== undefined));
        const turn = (await rowsOf(other.id)).find(r => r.capped !== undefined)!.id;
        // a ends and frees the slot; the person's Stop, sent by the id the waiting line carried, lands some ticks later.
        ends.get("a")!();
        for (let i = 0; i < offset; i++) await Promise.resolve();
        const said = await ctx.runtime!.sessions.interrupt(turn).then(r => r.outcome);
        await new Promise(r => setTimeout(r, 100));
        results.push(`${offset}: stop ${said} | p ${await p} | running ${live.has("p")}`);
        host.close();
        for (const end of [...ends.values()]) end();
        await ctx.srv?.close();
        ctx.srv = undefined;
        await ctx.runtime?.close();
        ctx.runtime = undefined;
      }
      expect(results.filter(r => !r.includes("stop accepted") || r.includes("running true"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("a held start that never launches tells whoever it was to report to", () => {
  const withLead = async (root: string) => {
    const t = heldTurns();
    const { host, set } = await onHere(root, t.adapter);
    const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
    const busy = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "busy" });
    const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
    await set(1);
    const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
    const leadThread = lead.view().threadId!;
    t.ends.get("lead")!();
    await lead.finished;
    await ctx.runtime!.sessions.start(busy.id, { prompt: "busy" });
    return { ...t, host, other, leadThread };
  };
  const woken = (started: readonly string[]) => started.filter(p => !["lead", "busy"].includes(p));

  it("a held start that is stopped wakes the lead it was to tell, with the stop as its end", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-tell-stop-"));
    const t = await withLead(root);
    try {
      const p = ctx.runtime!.sessions.start(t.other.id, { prompt: "p", notify: [t.leadThread] }).catch((e: unknown) => String(e));
      await until(async () => (await rowsOf(t.other.id)).some(r => r.capped !== undefined));
      const row = (await rowsOf(t.other.id)).find(r => r.capped !== undefined)!;
      expect(await ctx.runtime!.sessions.interrupt(row.id)).toMatchObject({ outcome: "accepted" });
      expect(await p).toMatch(/stopped before it started/);
      await until(() => woken(t.started).length > 0);
      expect(woken(t.started)[0]).toMatch(/^thread \S{8} finished \(failed\): stopped before it started, while/);
      expect(t.started).not.toContain("p");
      t.host.close();
    } finally {
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a held start whose workspace is deleted, or whose agent fails to start, wakes the lead it was to tell", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-tell-gone-"));
    const t = await withLead(root);
    try {
      const gone = ctx.runtime!.sessions.start(t.other.id, { prompt: "gone", notify: [t.leadThread] }).catch((e: unknown) => String(e));
      await until(async () => (await rowsOf(t.other.id)).some(r => r.capped !== undefined));
      await ctx.runtime!.workspaces.delete(t.other.id);
      expect(await gone).toMatch(/other was deleted before this turn started/);
      await until(() => woken(t.started).length === 1);
      expect(woken(t.started)[0]).toMatch(/finished \(failed\): other was deleted before this turn started/);
      const third = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "third" });
      // The lead's wake is running now, so the computer is full and the next start waits as well.
      const boom = ctx.runtime!.sessions.start(third.id, { prompt: "boom", notify: [t.leadThread] }).catch((e: unknown) => String(e));
      await until(async () => (await rowsOf(third.id)).some(r => r.capped !== undefined));
      for (const p of [...t.ends.keys()].filter(k => k !== "lead")) t.ends.get(p)!();
      expect(await boom).toMatch(/the agent would not start/);
      await until(() => woken(t.started).length === 2);
      expect(woken(t.started)[1]).toMatch(/finished \(failed\): the agent would not start/);
      t.host.close();
    } finally {
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a send answered held whose agent then fails to start leaves its reason on the thread, which keeps its last turn's end", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-held-failure-"));
    const t = await withLead(root);
    try {
      const mac = (await ctx.runtime!.workspaces.list()).find(w => w.name === "mac")!;
      const asked = (await t.host.request("sessions.start", { workspaceId: mac.id, thread: t.leadThread, prompt: "boom again", answerHeld: true })) as { outcome: string };
      expect(asked.outcome).toBe("held");
      t.ends.get("busy")!();
      await until(async () => (await rowsOf(mac.id)).some(r => r.failure !== undefined));
      expect((await rowsOf(mac.id)).find(r => r.threadId === t.leadThread)).toMatchObject({ status: "completed", lastLine: "ok", failure: "the agent would not start" });
      t.host.close();
    } finally {
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a held start a host restart drops ends on the next host with the restart named, and wakes the lead it was to tell", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-tell-restart-"));
    const store = memoryStore();
    const first = heldTurns();
    let second: ReturnType<typeof heldTurns> | undefined;
    try {
      const { host, set } = await onHere(root, first.adapter, store);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
      const two = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "two" });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const leadThread = lead.view().threadId!;
      first.ends.get("lead")!();
      await lead.finished;
      await ctx.runtime!.sessions.start(mac.id, { prompt: "one" });
      const answer = (await host.request("sessions.start", { workspaceId: two.id, prompt: "two", notify: [leadThread], answerHeld: true })) as { outcome: string; turnId: string };
      expect(answer.outcome).toBe("held");
      host.close();
      await ctx.srv!.close();
      await ctx.runtime!.close();
      second = heldTurns();
      await onHere(root, second.adapter, store);
      await ctx.runtime!.sessions.list();
      const ends = (await ctx.runtime!.sessions.history(two.id)).filter(e => e.type === "session.end" && e.turnId === answer.turnId);
      expect(ends).toMatchObject([{ reason: `the host restarted while this turn waited for a slot on ${HERE.name}; nothing started, so send it again`, unstarted: true }]);
      await until(() => second!.started.length > 0);
      expect(second.started[0]).toMatch(/finished \(failed\): the host restarted while this turn waited for a slot/);
      expect(second.started).not.toContain("two");
      // Once ended it is written down nowhere, so the host after that says nothing more of it.
      expect(await store.list("held-starts")).toEqual([]);
    } finally {
      for (const end of [...first.ends.values(), ...(second?.ends.values() ?? [])]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads back a held send a restart ended as a turn of its own, with the words sent, after a turn that replied", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-read-"));
    const store = memoryStore();
    const first = heldTurns();
    let second: ReturnType<typeof heldTurns> | undefined;
    try {
      const { host, set } = await onHere(root, first.adapter, store);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
      const busy = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "busy" });
      await set(1);
      const one = await ctx.runtime!.sessions.start(mac.id, { prompt: "first message" });
      const thread = one.view().threadId!;
      first.ends.get("first message")!();
      await one.finished;
      await ctx.runtime!.sessions.start(busy.id, { prompt: "busy" });
      expect(await host.request("sessions.start", { workspaceId: mac.id, thread, prompt: "second message", answerHeld: true })).toMatchObject({ outcome: "held" });
      host.close();
      await ctx.srv!.close();
      await ctx.runtime!.close();
      second = heldTurns();
      await onHere(root, second.adapter, store);
      await ctx.runtime!.sessions.list();
      const rows = threadMessages(await ctx.runtime!.sessions.history(mac.id), thread).map(r => [r.who, r.text]);
      expect(rows).toEqual([
        ["person", "first message"],
        ["agent", "ok"],
        ["turn", "completed"],
        ["person", "second message"],
        ["turn", `failed: the host restarted while this turn waited for a slot on ${HERE.name}; nothing started, so send it again`],
      ]);
    } finally {
      for (const end of [...first.ends.values(), ...(second?.ends.values() ?? [])]) end();
      await ctx.srv?.close();
      ctx.srv = undefined;
      await ctx.runtime?.close();
      ctx.runtime = undefined;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a followed send into a thread whose turn is held lends that held turn the sender's slot", () => {
  /** A computer set to 1 with a lead running on it, the lead's token at hand, and a way to speak as any running turn. */
  const leadOnOne = async (root: string, t: ReturnType<typeof heldTurns>, clients: WsClient[]) => {
    const { host, set } = await onHere(root, t.adapter);
    clients.push(host);
    const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
    await set(1);
    const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
    const as = async (prompt: string): Promise<WsClient> => {
      const c = await WsClient.connect(ctx.srv!.port, { token: t.envs.get(prompt)![HOST_TOKEN_ENV]! });
      clients.push(c);
      return c;
    };
    const ask = (from: WsClient, thread: string, prompt: string) => from.request("sessions.start", { workspaceId: mac.id, thread, prompt, answerHeld: true, followed: true });
    return { mac, lead, as, ask };
  };
  type Started = { outcome: string; session: { threadId: string } };

  /** The held turn ahead starts in the sender's slot, and the send runs in it once that turn ends. */
  const movesOn = async (t: ReturnType<typeof heldTurns>, ahead: string, send: Promise<unknown>, asked: string): Promise<void> => {
    await until(() => t.ends.has(ahead));
    expect(t.ends.has(asked)).toBe(false);
    t.ends.get(ahead)!();
    await until(() => t.ends.has(asked));
    expect(await settled(send, 500)).toBe(true);
  };

  it("a lead starts a builder detached, then sends it a follow-up and follows the answer", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-sendheld-"));
    const t = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { as, ask } = await leadOnOne(root, t, clients);
      const asLead = await as("lead");
      const builder = (await asLead.request("sessions.start", { prompt: "builder", answerHeld: true })) as Started;
      expect(builder.outcome).toBe("held");
      const more = ask(asLead, builder.session.threadId, "also do this");
      await movesOn(t, "builder", more, "also do this");
      expect([...t.live].sort()).toEqual(["also do this", "lead"]);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a lead starts a builder detached and follows a reviewer, and the reviewer asks the builder and follows", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-askheld-"));
    const t = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { as, ask } = await leadOnOne(root, t, clients);
      const asLead = await as("lead");
      const builder = (await asLead.request("sessions.start", { prompt: "builder", answerHeld: true })) as Started;
      expect(builder.outcome).toBe("held");
      expect(await asLead.request("sessions.start", { prompt: "reviewer", answerHeld: true, followed: true })).toMatchObject({ outcome: "started" });
      const asked = ask(await as("reviewer"), builder.session.threadId, "question for the builder");
      await movesOn(t, "builder", asked, "question for the builder");
      expect([...t.live].sort()).toEqual(["lead", "question for the builder", "reviewer"]);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a lead follows two children started in one message, and the first asks the second and follows", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-pair-"));
    const t = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { as, ask } = await leadOnOne(root, t, clients);
      const asLead = await as("lead");
      const [one, two] = (await Promise.all(["one", "two"].map(prompt => asLead.request("sessions.start", { prompt, answerHeld: true, followed: true })))) as Started[];
      expect([one!.outcome, two!.outcome].sort()).toEqual(["held", "started"]);
      const [first, second] = one!.outcome === "started" ? (["one", two!] as const) : (["two", one!] as const);
      const asked = ask(await as(first), second.session.threadId, "question across");
      await movesOn(t, first === "one" ? "two" : "one", asked, "question across");
      expect([...t.live].sort()).toEqual([first, "lead", "question across"].sort());
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the person writes into a lead whose turn is over while its child runs, and the child then asks the lead and follows", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-person-"));
    const t = heldTurns();
    const clients: WsClient[] = [];
    try {
      const { mac, lead, as, ask } = await leadOnOne(root, t, clients);
      const leadThread = lead.view().threadId!;
      const asLead = await as("lead");
      await asLead.request("sessions.start", { prompt: "child", notify: [NOTIFY_ME], turnToken: t.envs.get("lead")![TURN_TOKEN_ENV]!, answerHeld: true, followed: true });
      await until(() => t.ends.has("child"));
      t.ends.get("lead")!();
      await lead.finished;
      const person = ctx.runtime!.sessions.start(mac.id, { prompt: "from the person", thread: leadThread });
      person.catch(() => {});
      await until(async () => (await rowsOf(mac.id)).some(r => r.prompt === "from the person" && r.capped !== undefined));
      const asked = ask(await as("child"), leadThread, "question for the lead");
      await movesOn(t, "from the person", asked, "question for the lead");
      expect([...t.live].sort()).toEqual(["child", "question for the lead"]);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** A store whose plan-limits read takes 300 ms once `slow` is set: a codex start reads it between holding its thread and
 * its first look at the computer's threads at once, which holds that window open as an agent's first catalog read would. */
const slowLimits = () => {
  const inner = memoryStore();
  const gate = { slow: false };
  const store: typeof inner = {
    get: (c, id) => inner.get(c, id),
    put: (c, id, v) => inner.put(c, id, v),
    list: async c => {
      if (c === "limits" && gate.slow) await new Promise(r => setTimeout(r, 300));
      return inner.list(c);
    },
    keys: c => inner.keys(c),
    delete: (c, id) => inner.delete(c, id),
    getBlob: (c, id) => inner.getBlob(c, id),
    putBlob: (c, id, b) => inner.putBlob(c, id, b),
    deleteBlob: (c, id) => inner.deleteBlob(c, id),
    statBlob: (c, id) => inner.statBlob(c, id),
    ...(inner.transcripts !== undefined ? { transcripts: inner.transcripts } : {}),
  };
  return { store, gate };
};

/** The stop asked the moment a start is held, before that start has looked at its computer's threads at once. */
const stopOnHeld = (requestId: string, stop: () => Promise<string>): { asked: () => Promise<string> | undefined; off: () => void } => {
  let asked: Promise<string> | undefined;
  const off = ctx.runtime!.events.on("*", e => {
    if (e.type === "session.held" && e.requestId === requestId && asked === undefined) asked = stop();
  });
  return { asked: () => asked, off };
};

const within = <T>(p: Promise<T>, ms: number): Promise<T | "pending"> => Promise.race([p, new Promise<"pending">(r => setTimeout(() => r("pending"), ms))]);

describe("a stop that reaches a held turn before its first look", () => {
  it("the person stops a lead while the child it opened detached is held and has not looked yet: the stop answers and the child never launches", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-prelook-tree-"));
    const t = heldTurns();
    const { store, gate } = slowLimits();
    const clients: WsClient[] = [];
    try {
      const { host, set } = await onHere(root, t.adapter, store);
      clients.push(host);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
      await set(1);
      const lead = await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
      const asLead = await WsClient.connect(ctx.srv!.port, { token: t.envs.get("lead")![HOST_TOKEN_ENV]! });
      clients.push(asLead);
      const stop = stopOnHeld("req_child", () => ctx.runtime!.sessions.interrupt(lead.view().id).then(r => `${r.outcome} under ${String(r.under?.length ?? 0)}`));
      gate.slow = true;
      const child = asLead.request("sessions.start", { prompt: "child", harness: "codex", requestId: "req_child", answerHeld: true });
      await until(() => stop.asked() !== undefined);
      stop.off();
      expect(await within(stop.asked()!, 2000)).toBe("accepted under 1");
      expect(await within(child, 500)).toMatchObject({ ok: false, error: expect.stringContaining("stopped before it started") });
      await new Promise(r => setTimeout(r, 300));
      expect(t.ends.has("child")).toBe(false);
      expect(t.live.has("lead")).toBe(false);
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the person stops a held thread before its first look: the stop answers at once, and a slot freeing later never launches it", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-prelook-"));
    const t = heldTurns();
    const { store, gate } = slowLimits();
    try {
      const { host, set } = await onHere(root, t.adapter, store);
      const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac" });
      const other = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "other" });
      await set(1);
      await ctx.runtime!.sessions.start(mac.id, { prompt: "one" });
      const stop = stopOnHeld("req_p", async () => {
        const p = (await rowsOf(other.id)).find(r => r.prompt === "p");
        return p === undefined ? "no row" : (await ctx.runtime!.sessions.interrupt(p.id)).outcome;
      });
      gate.slow = true;
      const p = ctx.runtime!.sessions.start(other.id, { prompt: "p", harness: "codex", requestId: "req_p" }).then(
        () => "started",
        (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
      );
      await until(() => stop.asked() !== undefined);
      stop.off();
      expect(await within(stop.asked()!, 2000)).toBe("accepted");
      expect(await within(p, 500)).toBe("rejected: stopped before it started");
      t.ends.get("one")!();
      await new Promise(r => setTimeout(r, 300));
      expect(t.ends.has("p")).toBe(false);
      host.close();
    } finally {
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a turn that lent its slot on ends while the turn in its slot runs", () => {
  type Started = { outcome: string; session: { threadId: string } };
  /** A computer set to 2 with a lead on it, and ways to speak as a running turn, follow a thread, stop a turn by its
   * prompt and start a thread of another tree. */
  const onTwo = async (root: string, t: ReturnType<typeof heldTurns>, clients: WsClient[]) => {
    const { host, set } = await onHere(root, t.adapter);
    clients.push(host);
    const mac = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name: "mac", agents: { spawn: true } as never });
    await set(2);
    await ctx.runtime!.sessions.start(mac.id, { prompt: "lead" });
    const as = async (prompt: string): Promise<WsClient> => {
      const c = await WsClient.connect(ctx.srv!.port, { token: t.envs.get(prompt)![HOST_TOKEN_ENV]! });
      clients.push(c);
      return c;
    };
    const run = (from: WsClient, prompt: string, followed: boolean) => from.request("sessions.start", { prompt, answerHeld: true, ...(followed ? { followed: true } : {}) }) as Promise<Started>;
    const ask = (from: WsClient, thread: string, prompt: string) => from.request("sessions.start", { workspaceId: mac.id, thread, prompt, answerHeld: true, followed: true });
    const stop = async (prompt: string): Promise<string> => {
      const row = (await ctx.runtime!.sessions.list()).find(r => r.prompt === prompt && r.status === "running");
      return row === undefined ? "no row" : (await ctx.runtime!.sessions.interrupt(row.id)).outcome;
    };
    const outsider = async (name: string): Promise<boolean> => {
      const ws = await createOn(ctx.runtime!, { on: HERE_PLACE_ID, name });
      ctx.runtime!.sessions.start(ws.id, { prompt: name }).catch(() => {});
      await new Promise(r => setTimeout(r, 400));
      return t.ends.has(name);
    };
    return { as, run, ask, stop, outsider };
  };

  it("a reviewer the lead follows is stopped while the builder it lent its slot to runs: lead and builder each hold a slot, so a third thread waits", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-lent-stop-"));
    const t = heldTurns();
    const clients: WsClient[] = [];
    try {
      const w = await onTwo(root, t, clients);
      expect(await w.outsider("o")).toBe(true);
      const asLead = await w.as("lead");
      const builder = await w.run(asLead, "builder", false);
      expect(builder.outcome).toBe("held");
      expect(await w.run(asLead, "reviewer", true)).toMatchObject({ outcome: "started" });
      await until(() => t.ends.has("reviewer"));
      void w.ask(await w.as("reviewer"), builder.session.threadId, "question for the builder").catch(() => {});
      await until(() => t.ends.has("builder"));
      expect(await w.stop("reviewer")).toBe("accepted");
      expect([...t.live].sort()).toEqual(["builder", "lead", "o"]);
      expect(await w.outsider("x")).toBe(false);
      t.ends.get("o")!();
      await new Promise(r => setTimeout(r, 300));
      expect(t.ends.has("x")).toBe(false);
      t.ends.get("builder")!();
      await until(() => t.ends.has("x"));
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a thread that follows a send into a sibling is stopped while the sibling runs in its slot: a third thread waits", async () => {
    const root = mkdtempSync(joinPath(tmpdir(), "wsp-cap-lent-sib-"));
    const t = heldTurns();
    const clients: WsClient[] = [];
    try {
      const w = await onTwo(root, t, clients);
      const asLead = await w.as("lead");
      const s = await w.run(asLead, "s", true);
      await until(() => t.ends.has("s"));
      t.ends.get("s")!();
      await new Promise(r => setTimeout(r, 150));
      expect(await w.run(asLead, "reviewer", true)).toMatchObject({ outcome: "started" });
      await until(() => t.ends.has("reviewer"));
      void w.ask(await w.as("reviewer"), s.session.threadId, "question for s").catch(() => {});
      await until(() => t.ends.has("question for s"));
      expect(await w.stop("reviewer")).toBe("accepted");
      expect([...t.live].sort()).toEqual(["lead", "question for s"]);
      expect(await w.outsider("x")).toBe(false);
      t.ends.get("question for s")!();
      await until(() => t.ends.has("x"));
    } finally {
      for (const c of clients) c.close();
      for (const end of [...t.ends.values()]) end();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
