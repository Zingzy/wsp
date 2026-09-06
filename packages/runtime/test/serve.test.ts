import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AdapterEvent, TurnResult } from "@wsp/adapter-claude";
import type { ForwardEvent, PortForward } from "@wsp/protocol";
import { DAEMON_TOKEN_SET } from "../src/daemon-token.js";
import { createRuntime, type HarnessAdapterFactory, type HarnessSession, type HarnessStartOptions } from "../src/runtime.js";
import { serveRuntime, type ForwardsSource, type RuntimeServer } from "../src/serve.js";
import { memoryStore } from "../src/store.js";
import { WsClient } from "./ws-client.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { fakeClock } from "./fake-clock.js";
import { until } from "./until.js";

let srv: RuntimeServer | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
});

function rt() {
  return createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: {} });
}

const DAEMON_TOKEN = "cafef00d".repeat(3);
/** A guest with a daemon: the runtime's token write lands, everything else is silently fine. */
const tokenGuest = (_m: unknown, cmd: string) => (cmd.includes("/root/.wsp-daemon-token") ? { exitCode: 0, stdout: `${DAEMON_TOKEN_SET}\n`, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });

describe("serveRuntime auth", () => {
  it("closes 4401 on a wrong auth token", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    void c.request("auth", { token: "wrong" });
    expect(await c.closed()).toBe(4401);
  });

  it("closes 4401 when the first op is not auth", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port);
    void c.request("workspaces.list");
    expect(await c.closed()).toBe(4401);
  });

  it("rejects malformed ops on an authed socket without closing it", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const bad = await c.request("workspaces.create", {}); // missing golden+name
    expect(bad.ok).toBe(false);
    const ok = await c.request("workspaces.list");
    expect(ok.ok).toBe(true);
    c.close();
  });
});

describe("serveRuntime tickets (bearer never rides a URL after the handshake)", () => {
  it("issues a 5-minute single-use connect ticket that authenticates a second socket", async () => {
    let nowMs = 1_000_000;
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", now: () => nowMs });
    const c1 = await WsClient.connect(srv.port, { token: "secret" });
    const issued = await c1.request("ticket.issue", { purpose: "connect" });
    expect(issued.ok).toBe(true);
    const ticket = issued["ticket"] as string;
    expect(ticket).not.toContain("secret");
    expect(issued["expiresAt"]).toBe(nowMs + 300_000);

    const c2 = await WsClient.connect(srv.port, { ticket });
    const res = await c2.request("workspaces.list");
    expect(res.ok).toBe(true);

    // single-use: replaying the same ticket dies at 4401
    const c3 = await WsClient.connect(srv.port, { ticket });
    expect(await c3.closed()).toBe(4401);
    c1.close();
    c2.close();
  });

  it("expires tickets after 5 minutes", async () => {
    let nowMs = 1_000_000;
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", now: () => nowMs });
    const c1 = await WsClient.connect(srv.port, { token: "secret" });
    const issued = await c1.request("ticket.issue", { purpose: "connect" });
    nowMs += 300_001;
    const late = await WsClient.connect(srv.port, { ticket: issued["ticket"] as string });
    expect(await late.closed()).toBe(4401);
    c1.close();
  });
});

describe("serveRuntime events", () => {
  it("fans runtime events out to subscribed sockets only", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const sub = await WsClient.connect(srv.port, { token: "secret" });
    const quiet = await WsClient.connect(srv.port, { token: "secret" });
    await sub.request("events.subscribe");

    const created = await sub.request("workspaces.create", { golden: "snap_g", name: "x" });
    expect(created.ok).toBe(true);
    await until(() => sub.events.some(e => e.type === "workspace.created"));
    expect(quiet.events).toEqual([]);
    sub.close();
    quiet.close();
  });
});

describe("serveRuntime capabilities", () => {
  it("capabilities.get returns the backend's flags so the UI degrades on facts, not probes", async () => {
    const backend = stubBackend();
    srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const res = await c.request("capabilities.get");
    expect(res.ok).toBe(true);
    expect(res["capabilities"]).toEqual(backend.capabilities);
    expect(res["capabilities"]).toMatchObject({ containers: true });
    c.close();
  });
});

describe("serveRuntime session history", () => {
  it("sessions.history returns the persisted session events for one workspace", async () => {
    const runtime = rt();
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const id = (created["workspace"] as { id: string }).id;
    const res = await c.request("sessions.history", { workspaceId: id });
    expect(res.ok).toBe(true);
    expect(res["events"]).toEqual([]);
    const missing = await c.request("sessions.history", { workspaceId: "ws_nope" });
    expect(missing.ok).toBe(false);
    c.close();
  });
});

// A harness that cannot stop the process it owns is not a harness; the port refuses one at compile time.
const noStop = { localId: "s", finished: Promise.resolve<TurnResult>({ status: "completed" }) };
// @ts-expect-error interrupt is required on HarnessSession
noStop satisfies HarnessSession;

/** A harness the test ends by hand. Its interrupt does what the real one does: the turn reports
 * interrupted and the session ends on a later turn of the event loop than interrupt() resolves on. */
function stoppableHarness() {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  let onEvent: ((e: AdapterEvent) => void) | undefined;
  let finish!: (r: TurnResult) => void;
  const finished = new Promise<TurnResult>(r => (finish = r));
  const end = (result: TurnResult): void => {
    onEvent!({ type: "turn.done", sessionId, result });
    onEvent!({ type: "session.end", sessionId, exitCode: 0, sawResult: true });
    finish(result);
  };
  const h = {
    sessionId,
    interrupts: 0,
    steered: [] as string[],
    lastStart: undefined as HarnessStartOptions | undefined,
    complete: () => end({ status: "completed", text: "done" }),
    adapter: (() => ({
      steers: true,
      start: o => {
        onEvent = o.onEvent;
        h.lastStart = o;
        onEvent({ type: "session.start", sessionId, model: "claude-sonnet-4-5" });
        return {
          localId: sessionId,
          finished,
          interrupt: async () => {
            h.interrupts++;
            setImmediate(() => end({ status: "interrupted" }));
          },
          steer: async (prompt: string) => {
            h.steered.push(prompt);
            return "accepted" as const;
          },
        };
      },
    })) as HarnessAdapterFactory,
  };
  return h;
}

describe("serveRuntime harness catalog", () => {
  it("harnesses.list replies with one catalog per harness and sessions.start carries the picks through", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const listed = await c.request("harnesses.list");
    const catalogs = listed["harnesses"] as { harness: string; source: string; efforts: { value: string }[] }[];
    expect(catalogs.find(x => x.harness === "claude")?.efforts.map(o => o.value)).toContain("high");
    expect(catalogs.find(x => x.harness === "claude")?.source).toBe("table");
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    // On a workspace the machine is asked; the stub's binary says nothing, so the table answers, marked as such.
    const scoped = await c.request("harnesses.list", { workspaceId });
    expect((scoped["harnesses"] as { harness: string; source: string }[]).find(x => x.harness === "claude")?.source).toBe("table");
    const missing = await c.request("harnesses.list", { workspaceId: "ws_nope" });
    expect(missing.ok).toBe(false);
    const started = await c.request("sessions.start", { workspaceId, prompt: "go", model: "claude-opus-5", effort: "high", permissionMode: "plan", contextWindow: "1m", requestId: "req_9" });
    expect(started["session"]).toMatchObject({ model: "claude-sonnet-4-5", effort: "high", permissionMode: "plan", contextWindow: "1m" });
    expect(h.lastStart).toMatchObject({ model: "claude-opus-5", effort: "high", permissionMode: "plan", contextWindow: "1m" });
    expect(h.lastStart).not.toHaveProperty("requestId");
    h.complete();
    const history = (await c.request("sessions.history", { workspaceId }))["events"] as { type: string; requestId?: string }[];
    expect(history[0]).toMatchObject({ type: "session.start", requestId: "req_9" });
    c.close();
  });
});

describe("serveRuntime session interrupt", () => {
  type Harness = ReturnType<typeof stoppableHarness>;
  const table: { name: string; before?: (h: Harness) => void; sessionId?: string; outcome: string; interrupts: number; status?: string }[] = [
    { name: "mid-turn: the harness is told to stop and the turn ends interrupted", outcome: "accepted", interrupts: 1, status: "interrupted" },
    { name: "after the turn: not-running, and the harness is not asked", before: h => h.complete(), outcome: "not-running", interrupts: 0, status: "completed" },
    { name: "unknown session: not-found", sessionId: "ws_nobody", outcome: "not-found", interrupts: 0 },
  ];

  it.each(table)("$name", async row => {
    const h = stoppableHarness();
    const fc = fakeClock();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fc.clock });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const started = await c.request("sessions.start", { workspaceId, prompt: "go" });
    expect(started["session"]).toMatchObject({ id: h.sessionId, status: "running" });
    row.before?.(h);
    // Frames in arrival order, so the check below reads the wire and not a coalesced read of c.events.
    const arrived: string[] = [];
    c.ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as { id?: number; type?: string };
      arrived.push(m.type ?? `reply:${String(m.id)}`);
    });

    const res = await c.request("sessions.interrupt", { sessionId: row.sessionId ?? h.sessionId });
    expect(res).toEqual({ id: expect.any(Number), ok: true, outcome: row.outcome });
    expect(h.interrupts).toBe(row.interrupts);

    if (row.status !== undefined) {
      const listed = await c.request("sessions.list", { workspaceId });
      expect(listed["sessions"]).toMatchObject([{ id: h.sessionId, status: row.status }]);
      const history = (await c.request("sessions.history", { workspaceId }))["events"] as { type: string; result?: { status: string } }[];
      expect(history.map(e => e.type)).toEqual(["session.start", "session.done", "session.end"]);
      expect(history[1]).toMatchObject({ type: "session.done", result: { status: row.status } });
      expect(c.events.filter(e => e.type === "session.done")).toMatchObject([{ result: { status: row.status } }]);
      const reply = `reply:${String(res.id)}`;
      if (row.outcome === "accepted") expect(arrived.slice(0, arrived.indexOf(reply) + 1)).toEqual(["session.done", "session.end", reply]);
    }
    c.close();
  });

  it("sessions.steer round-trips: the session.steer event reaches subscribers before the accepted reply, and history holds it", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    await c.request("sessions.start", { workspaceId, prompt: "go", requestId: "req_1" });
    const arrived: string[] = [];
    c.ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as { id?: number; type?: string };
      arrived.push(m.type ?? `reply:${String(m.id)}`);
    });
    const res = await c.request("sessions.steer", { sessionId: h.sessionId, prompt: "and the tests", requestId: "req_2" });
    expect(res).toEqual({ id: expect.any(Number), ok: true, outcome: "accepted" });
    expect(h.steered).toEqual(["and the tests"]);
    expect(arrived).toEqual(["session.steer", `reply:${String(res.id)}`]);
    expect(c.events.filter(e => e.type === "session.steer")).toMatchObject([{ workspaceId, sessionId: h.sessionId, prompt: "and the tests", requestId: "req_2" }]);
    h.complete();
    const history = (await c.request("sessions.history", { workspaceId }))["events"] as { type: string; turnId?: string }[];
    expect(history.map(e => e.type)).toEqual(["session.start", "session.steer", "session.done", "session.end"]);
    expect(history[1]!.turnId).toBe(history[0]!.turnId);
    expect((await c.request("sessions.steer", { sessionId: h.sessionId, prompt: "late" }))["outcome"]).toBe("not-running");
    expect((await c.request("sessions.steer", { sessionId: "nope", prompt: "x" }))["outcome"]).toBe("not-found");
    expect((await c.request("sessions.steer", { sessionId: h.sessionId })).ok).toBe(false);
    c.close();
  });

  it("interrupting the same turn twice is accepted once, then not-running", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter }, clock: fakeClock().clock });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    await c.request("sessions.start", { workspaceId: (created["workspace"] as { id: string }).id, prompt: "go" });
    expect((await c.request("sessions.interrupt", { sessionId: h.sessionId }))["outcome"]).toBe("accepted");
    expect((await c.request("sessions.interrupt", { sessionId: h.sessionId }))["outcome"]).toBe("not-running");
    expect(h.interrupts).toBe(1);
    c.close();
  });
});

describe("serveRuntime daemon update", () => {
  it("workspaces.updateDaemon runs the deploy and answers ok; a missing workspace is an error reply", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const deployed: string[] = [];
    const recipe = { setup: "true", smoke: "true", deployDaemon: async (m: { id: string }) => void deployed.push(m.id) };
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN, goldenRecipe: recipe });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const id = (created["workspace"] as { id: string }).id;
    const res = await c.request("workspaces.updateDaemon", { workspaceId: id });
    expect(res).toEqual({ id: expect.anything(), ok: true });
    expect(deployed).toEqual(["m1"]);
    const missing = await c.request("workspaces.updateDaemon", { workspaceId: "ws_nobody" });
    expect(missing.ok).toBe(false);
    expect(String(missing["error"])).toContain("no such workspace");
    c.close();
  });
});

describe("serveRuntime daemon reach", () => {
  it("workspaces.daemonReach returns the view a browser dials the daemon with", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, daemonToken: DAEMON_TOKEN });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const id = (created["workspace"] as { id: string }).id;
    backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: 1_800_000_000_000 });
    const res = await c.request("workspaces.daemonReach", { workspaceId: id });
    expect(res.ok).toBe(true);
    expect(res["reach"]).toEqual({ url: "https://m1-7070.preview.example/?pt_token=e", expiresAt: 1_800_000_000_000, daemonToken: DAEMON_TOKEN });
    c.close();
  });
});

describe("serveRuntime port reach", () => {
  it("workspaces.portReach returns the route a browser frames, without the daemon token; an unknown workspace is refused", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const id = (created["workspace"] as { id: string }).id;
    backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=e`, token: "e", expiresAt: 1_800_000_000_000 });
    const res = await c.request("workspaces.portReach", { workspaceId: id, port: 3000 });
    expect(res.ok).toBe(true);
    expect(res["reach"]).toEqual({ url: "https://m1-3000.preview.example/?pt_token=e", expiresAt: 1_800_000_000_000 });
    const missing = await c.request("workspaces.portReach", { workspaceId: "ws_nobody", port: 3000 });
    expect(missing.ok).toBe(false);
    expect(missing["error"]).toMatch(/no such workspace/);
    c.close();
  });

  it("workspaces.portProbe replies with what the host saw on the port's route; an unknown workspace is refused", async () => {
    const guest = createServer((_req, res) => res.writeHead(403, { "content-type": "text/plain" }).end("Blocked request. This host (m1-5173.preview.example) is not allowed. To allow this host, add it to server.allowedHosts"));
    await new Promise<void>(r => guest.listen(0, "127.0.0.1", r));
    const addr = guest.address();
    const guestPort = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const backend = stubBackend();
      backend.execImpl = tokenGuest;
      srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
      const c = await WsClient.connect(srv.port, { token: "secret" });
      const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
      const id = (created["workspace"] as { id: string }).id;
      backend.machines[0]!.previewUrl = async () => ({ url: `http://127.0.0.1:${guestPort}/?pt_token=e`, token: "e", expiresAt: 1_800_000_000_000 });
      const res = await c.request("workspaces.portProbe", { workspaceId: id, port: 5173 });
      expect(res.ok).toBe(true);
      expect(res["probe"]).toEqual({ status: 403, body: expect.stringContaining("server.allowedHosts") });
      const missing = await c.request("workspaces.portProbe", { workspaceId: "ws_nobody", port: 5173 });
      expect(missing.ok).toBe(false);
      expect(missing["error"]).toMatch(/no such workspace/);
      c.close();
    } finally {
      await new Promise<void>(r => guest.close(() => r()));
    }
  });

  it("workspaces.rebuild replies with the workspace on a fresh golden fork and the old machine is dead", async () => {
    const backend = stubBackend();
    srv = await serveRuntime(createRuntime({ backend, store: memoryStore(), adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const id = (created["workspace"] as { id: string }).id;
    const res = await c.request("workspaces.rebuild", { workspaceId: id });
    expect(res.ok).toBe(true);
    expect(res["workspace"]).toMatchObject({ id, name: "x", machineId: "m2", phase: "running" });
    expect(backend.machines[0]!.killed).toBe(true);
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_g");
    const missing = await c.request("workspaces.rebuild", { workspaceId: "ws_nobody" });
    expect(missing.ok).toBe(false);
    c.close();
  });
});

describe("serveRuntime golden wizard ops", () => {
  const recipe = { setup: "curl install", smoke: "claude --version", envs: { ANTHROPIC_API_KEY: "k" } };

  it("golden.prepare replies with the builder and its screen, golden.seal writes v1 of desktop kind, and no machine survives", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const runtime = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    await c.request("events.subscribe");

    const prepared = await c.request("golden.prepare", { name: "default", kind: "desktop" });
    expect(prepared.ok).toBe(true);
    expect(prepared["builder"]).toMatchObject({ id: "m1", name: "default", kind: "desktop", screen: { streamUrl: "wss://stub/stream/m1" } });
    expect(backend.machines[0]!.spec).toMatchObject({ kind: "desktop", template: "default", envs: { ANTHROPIC_API_KEY: "k" } });
    expect(backend.machines[0]!.spec.labels).toMatchObject({ wsp: "1", "wsp-builder": "1" });
    // The base stage's steps run first, the harness install is the last thing on the builder.
    expect(backend.machines[0]!.execLog.filter(c => c.includes("nodejs.org/dist"))).toHaveLength(1);
    expect(backend.machines[0]!.execLog.at(-1)).toBe("curl install");
    // the builder is not a workspace
    expect((await c.request("workspaces.list"))["workspaces"]).toEqual([]);
    expect(await store.list("builders")).toHaveLength(1);

    const sealed = await c.request("golden.seal", { builderId: "m1" });
    expect(sealed.ok).toBe(true);
    expect(sealed["version"]).toMatchObject({ version: 1, kind: "desktop", snapshotId: "snap_golden-v1", smoke: { cmd: "claude --version", exitCode: 0 } });
    expect((sealed["manifest"] as { head: number }).head).toBe(1);
    expect(backend.machines.map(m => [m.id, m.kind, m.killed])).toEqual([["m1", "desktop", true], ["m2", "desktop", true]]);
    expect(backend.machines[1]!.spec.fromSnapshot).toBe("snap_golden-v1");
    expect(backend.machines[1]!.execLog).toEqual(["claude --version", "test -x /usr/local/bin/wsp-open"]);
    expect(await store.list("builders")).toEqual([]);
    expect((await c.request("golden.get", { name: "default" }))["manifest"]).toEqual(sealed["manifest"]);

    await until(() => c.events.some(e => e.type === "golden.stage" && e["stage"] === "sealed"));
    const stages = c.events.filter(e => e.type === "golden.stage").map(e => e["stage"]);
    expect([...new Set(stages)]).toEqual(["creating", "deploying-daemon", "installing-harness", "ready", "snapshotting", "smoke-forking", "sealed"]);
    expect(c.events.filter(e => e.type === "golden.stage").every(e => e["name"] === "default")).toBe(true);
    c.close();
  });

  it("golden.prepare defaults to a sandbox with no screen, and golden.builderReach hands back its daemon route", async () => {
    const backend = stubBackend();
    backend.execImpl = tokenGuest;
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {}, goldenRecipe: recipe, daemonToken: DAEMON_TOKEN });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });

    const prepared = await c.request("golden.prepare", { name: "default" });
    expect(prepared["builder"]).toMatchObject({ id: "m1", kind: "sandbox" });
    expect(prepared["builder"]).not.toHaveProperty("screen");
    expect(backend.machines[0]!.spec).toMatchObject({ kind: "sandbox", template: "base" });

    backend.machines[0]!.previewUrl = async port => ({ url: `https://m1-${port}.preview.example/?pt_token=edge`, token: "edge", expiresAt: Date.now() + 3_600_000 });
    const reach = await c.request("golden.builderReach", { builderId: "m1" });
    expect(reach.ok).toBe(true);
    expect(reach["reach"]).toEqual({ url: "https://m1-7070.preview.example/?pt_token=edge", expiresAt: expect.any(Number), daemonToken: DAEMON_TOKEN });
    const missing = await c.request("golden.builderReach", { builderId: "m9" });
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/no such builder/) });
    c.close();
  });

  it("golden.seal on a builder hydrated by a later process and found paused is refused as notFirstLife and the builder dies", async () => {
    const backend = stubBackend();
    const store = memoryStore();
    const first = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    const builder = await first.golden.prepare();
    backend.machines[0]!.paused = true;
    const second = createRuntime({ backend, store, adapters: {}, goldenRecipe: recipe });
    srv = await serveRuntime(second, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("golden.prepare", { name: "default" })).ok).toBe(true); // a fresh one is fine
    const refused = await c.request("golden.seal", { builderId: builder.id });
    expect(refused).toMatchObject({ ok: false, kind: "notFirstLife" });
    expect(refused["error"]).toMatch(/first-life/);
    expect(backend.machines[0]!.killed).toBe(true);
    expect(backend.machines.filter(m => !m.killed)).toHaveLength(1);
    expect(await second.golden.get()).toBeUndefined();
    c.close();
  });

  it("golden.prepare fails plainly when the runtime has no recipe", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const res = await c.request("golden.prepare", { name: "default" });
    expect(res.ok).toBe(false);
    expect(res["error"]).toMatch(/no golden recipe/);
    c.close();
  });
});

describe("serveRuntime snapshot lineage", () => {
  const version = (n: number) => ({
    version: n,
    snapshotId: `snap_golden-v${n}`,
    baseTemplate: "base",
    setupSha: `sha${n}`,
    createdAt: `2026-08-${10 + n}T00:00:00.000Z`,
    smoke: { cmd: "true", exitCode: 0 },
  });

  it("snapshots.list is the manifest with head; rollback moves head, says existing workspaces are untouched, persists", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 2, versions: [version(1), version(2)] });
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });

    const listed = await c.request("snapshots.list");
    expect(listed.ok).toBe(true);
    expect(listed["lineage"]).toEqual({ name: "default", head: 2, versions: [version(1), version(2)] });

    const rolled = await c.request("snapshots.rollback", { version: 1 });
    expect(rolled.ok).toBe(true);
    expect(rolled["lineage"]).toEqual({ name: "default", head: 1, versions: [version(1), version(2)] });
    expect(rolled["existingWorkspaces"]).toBe("untouched");
    expect((await c.request("golden.get", { name: "default" }))["manifest"]).toEqual({ head: 1, versions: [version(1), version(2)] });

    const empty = await c.request("snapshots.list", { name: "other" });
    expect(empty["lineage"]).toEqual({ name: "other", head: null, versions: [] });
    c.close();
  });

  it("snapshots.rollback to a version outside the manifest is a typed refusal that changes nothing", async () => {
    const store = memoryStore();
    await store.put("goldens", "default", { head: 1, versions: [version(1)] });
    srv = await serveRuntime(createRuntime({ backend: stubBackend(), store, adapters: {} }), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const refused = await c.request("snapshots.rollback", { version: 9 });
    expect(refused).toMatchObject({ ok: false, kind: "missing" });
    expect(String(refused["error"])).toContain("v9");
    expect((await c.request("snapshots.list"))["lineage"]).toMatchObject({ head: 1 });
    c.close();
  });
});

describe("serveRuntime forwards (the host's, listed and stopped from the app)", () => {
  function fakeForwards() {
    const listeners = new Set<(e: ForwardEvent) => void>();
    const open: PortForward[] = [];
    const stops: [string, number][] = [];
    const source: ForwardsSource = {
      list: () => [...open],
      stop: (workspaceId, port) => {
        stops.push([workspaceId, port]);
        const i = open.findIndex(f => f.workspaceId === workspaceId && f.port === port);
        if (i < 0) return false;
        open.splice(i, 1);
        return true;
      },
      on: fn => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const emit = (e: ForwardEvent): void => {
      for (const fn of listeners) fn(e);
    };
    return { source, open, stops, emit, listeners };
  }

  it("forwards.list is the source's list, forwards.stop closes one and refuses an unknown one", async () => {
    const { source, open, stops } = fakeForwards();
    open.push({ workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" });
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", forwards: source });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("forwards.list"))["forwards"]).toEqual([{ workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" }]);
    expect((await c.request("forwards.stop", { workspaceId: "ws_1", port: 8123 })).ok).toBe(true);
    const again = await c.request("forwards.stop", { workspaceId: "ws_1", port: 8123 });
    expect(again.ok).toBe(false);
    expect(again["error"]).toBe("nothing is forwarding localhost:8123 for that workspace");
    expect(stops).toEqual([["ws_1", 8123], ["ws_1", 8123]]);
    expect((await c.request("forwards.list"))["forwards"]).toEqual([]);
    // Below 1024 never reaches the source: the wire refuses it.
    expect((await c.request("forwards.stop", { workspaceId: "ws_1", port: 80 })).ok).toBe(false);
    expect(stops).toHaveLength(2);
    c.close();
  });

  it("forward events reach subscribed sockets only, and the subscription dies with the socket", async () => {
    const { source, emit, listeners } = fakeForwards();
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret", forwards: source });
    const sub = await WsClient.connect(srv.port, { token: "secret" });
    const quiet = await WsClient.connect(srv.port, { token: "secret" });
    await sub.request("events.subscribe");
    const f = { workspaceId: "ws_1", port: 8123, startedAt: "2026-09-04T10:00:00.000Z", name: "api", kind: "url" as const };
    emit({ type: "forward.open", forward: f });
    emit({ type: "forward.close", workspaceId: "ws_1", port: 8123 });
    await until(() => sub.events.length === 2);
    expect(sub.events).toEqual([{ type: "forward.open", forward: f }, { type: "forward.close", workspaceId: "ws_1", port: 8123 }]);
    expect(quiet.events).toEqual([]);
    sub.close();
    await until(() => listeners.size === 0);
    quiet.close();
  });

  it("without a source the list is empty and a stop is refused", async () => {
    srv = await serveRuntime(rt(), { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    expect((await c.request("forwards.list"))["forwards"]).toEqual([]);
    expect((await c.request("forwards.stop", { workspaceId: "ws_1", port: 8123 })).ok).toBe(false);
    c.close();
  });
});

describe("serveRuntime thread provenance", () => {
  it("sessions.start records who asked, cli when the request says so and person when it says nothing, and sessions.list carries it", async () => {
    const h = stoppableHarness();
    const runtime = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: h.adapter } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const rows = async (): Promise<string[]> => ((await c.request("sessions.list", { workspaceId }))["sessions"] as { startedBy: string }[]).map(s => s.startedBy);
    const byCli = await c.request("sessions.start", { workspaceId, prompt: "go", startedBy: "cli" });
    expect(byCli["session"]).toMatchObject({ startedBy: "cli" });
    expect(await rows()).toEqual(["cli"]);
    h.complete();
    // The stoppable harness reuses one local id, so the second start replaces the first row.
    const byPerson = await c.request("sessions.start", { workspaceId, prompt: "go on" });
    expect(byPerson["session"]).toMatchObject({ startedBy: "person" });
    expect(await rows()).toEqual(["person"]);
    const refused = await c.request("sessions.start", { workspaceId, prompt: "go", startedBy: "app" });
    expect(refused.ok).toBe(false);
    c.close();
  });
});

/** A guest for the exec stream's launch and poll contract: the launch lands, the first poll hands over the whole
 * log, and the leader is up until the exit file is written or the stream signals it. */
function execGuest(backend: StubBackend, output: string, exit: number | undefined) {
  const base = backend.execImpl;
  let alive = true;
  backend.execImpl = (m, cmd) => {
    if (cmd.includes("base64 -d")) return { exitCode: 0, stdout: "WSP_LAUNCHED\n", stderr: "" };
    if (cmd.includes("kill -TERM") || cmd.includes("kill -KILL")) {
      alive = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    const sentinel = /(__WSP_EOF_[a-z0-9]+__)/.exec(cmd)?.[1];
    if (sentinel !== undefined) {
      const from = Number(/tail -c \+(\d+)/.exec(cmd)?.[1] ?? "1") - 1;
      const chunk = Buffer.from(output).subarray(from).toString("base64");
      return { exitCode: 0, stdout: `${chunk}\n${sentinel} ${exit ?? ""} ${alive ? "up" : "down"}\n`, stderr: "" };
    }
    return base(m, cmd);
  };
}

/** A harness that never runs here; it says what a turn on the machine is exported with, which is what exec runs with too. */
const envAdapter = (env: Record<string, string>): HarnessAdapterFactory => () => ({
  steers: false,
  start: () => {
    throw new Error("not started in this test");
  },
  env,
});

describe("serveRuntime workspaces.exec", () => {
  it("replies with an exec id, pushes each output line to the asking socket and the exit code last, and pushes nothing to another socket", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({ CLAUDE_CONFIG_DIR: "/root/.claude", PATH: "/usr/bin" }) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const other = await WsClient.connect(srv.port, { token: "secret" });
    await other.request("events.subscribe");
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "one\ntwo\n", 3);

    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sh", "-c", "printf 'one\\ntwo\\n'; exit 3"] });
    expect(started.ok).toBe(true);
    const execId = started["execId"] as string;
    expect(execId).toMatch(/^[0-9a-f]{12}$/);
    await until(() => c.events.some(e => e.type === "exec.exit"));
    expect(c.events).toEqual([
      { type: "exec.output", execId, text: "one" },
      { type: "exec.output", execId, text: "two" },
      { type: "exec.exit", execId, exitCode: 3 },
    ]);
    expect(other.events.filter(e => String(e.type).startsWith("exec."))).toEqual([]);
    // The command travels base64-encoded inside the launch script, each word quoted for the machine's shell, after
    // the same exports a harness turn gets.
    const launch = backend.machines[0]!.execLog.find(cmd => cmd.includes("base64 -d"))!;
    const script = Buffer.from(/printf %s '([A-Za-z0-9+/=]*)'/.exec(launch)![1]!, "base64").toString("utf8");
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/root/.claude'\nexport PATH='/usr/bin'\n");
    expect(script).toContain("'sh' '-c' 'printf '\\''one\\ntwo\\n'\\''; exit 3'\n");

    const missing = await c.request("workspaces.exec", { workspaceId: "ws_nope", argv: ["true"] });
    expect(missing.ok).toBe(false);
    c.close();
    other.close();
    // A command that has exited is not signalled again when its socket goes.
    await new Promise(r => setTimeout(r, 50));
    expect(backend.machines[0]!.execLog.some(cmd => cmd.includes("kill -TERM"))).toBe(false);
  });

  it("refuses like sessions.start when no adapter is registered for the harness whose environment it would run with", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: {} });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    const refused = await c.request("workspaces.exec", { workspaceId, argv: ["true"] });
    expect(refused).toMatchObject({ ok: false, error: 'no adapter registered for harness "claude"' });
    expect(backend.machines[0]!.execLog.some(cmd => cmd.includes("base64 -d"))).toBe(false);
  });

  it("the asking socket closing ends the command", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({}) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", undefined);
    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sleep", "600"] });
    expect(started.ok).toBe(true);
    const log = backend.machines[0]!.execLog;
    await until(() => log.some(cmd => cmd.includes("__WSP_EOF_")));
    c.close();
    await until(() => log.some(cmd => cmd.includes("kill -TERM")));
  });

  it("deleting the workspace ends a running exec with the deleted reason on the asking socket", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({}) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", undefined);
    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sleep", "600"] });
    const execId = started["execId"] as string;
    const log = backend.machines[0]!.execLog;
    await until(() => log.some(cmd => cmd.includes("__WSP_EOF_")));
    const deleted = await c.request("workspaces.delete", { workspaceId });
    expect(deleted.ok).toBe(true);
    await until(() => c.events.some(e => e.type === "exec.exit"));
    expect(c.events.filter(e => e.type === "exec.exit")).toEqual([
      { type: "exec.exit", execId, exitCode: null, error: "machine deleted while the agent was working" },
    ]);
    c.close();
  });

  it("napping the workspace ends a running exec with the paused reason on the asking socket", async () => {
    const backend = stubBackend();
    const runtime = createRuntime({ backend, store: memoryStore(), adapters: { claude: envAdapter({}) } });
    srv = await serveRuntime(runtime, { port: 0, authToken: "secret" });
    const c = await WsClient.connect(srv.port, { token: "secret" });
    const created = await c.request("workspaces.create", { golden: "snap_g", name: "x" });
    const workspaceId = (created["workspace"] as { id: string }).id;
    execGuest(backend, "", undefined);
    const started = await c.request("workspaces.exec", { workspaceId, argv: ["sleep", "600"] });
    const execId = started["execId"] as string;
    const log = backend.machines[0]!.execLog;
    await until(() => log.some(cmd => cmd.includes("__WSP_EOF_")));
    const napped = await c.request("workspaces.nap", { workspaceId });
    expect(napped.ok).toBe(true);
    await until(() => c.events.some(e => e.type === "exec.exit"));
    expect(c.events.filter(e => e.type === "exec.exit")).toEqual([
      { type: "exec.exit", execId, exitCode: null, error: "machine paused while the agent was working" },
    ]);
    c.close();
  });
});
