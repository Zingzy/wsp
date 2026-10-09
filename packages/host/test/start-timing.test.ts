// SPDX-License-Identifier: AGPL-3.0-only
// The time from a send to the agent's launch is wsp's own, and the agent's
// startup is the agent's: a send says its agent is starting as soon as it is
// launched, and a host that just started launches its first send as soon as a
// host that has run a while does, on the lists a host before it read, while the
// agent there answers the version they were read off.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HERE_PLACE_ID, type EventUnion, type HarnessCatalogProbe, type KeptAgent } from "@wsp/protocol";
import { HARNESS_ADAPTERS, createRuntime, memoryStore, type HarnessAdapterFactory, type HarnessSession, type HarnessStartOptions, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localWiring } from "../src/cli.js";
import { stubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart } from "./verbs-fixture.js";
import { writeStub } from "../../protocol/test/stub-script.js";

/** Claude Code's own startup before it says its session started: 4.1 s measured on the owner's computer with its
 * hooks and servers, shorter here so the case runs in seconds. */
const AGENT_STARTUP_MS = 1_500;
/** Asking the binary for its lists: three starts of it, 1.7 s measured on a Linux cloud computer. */
const PROBE_MS = 3_000;
const HAIKU = { slug: "claude-haiku-5-5", label: "Haiku", contextWindows: ["200k"], isDefault: true };
const LISTS: HarnessCatalogProbe = { version: "2.1.295", models: [HAIKU], efforts: ["low", "high"], permissionModes: ["default", "bypassPermissions"] };

type Agent = { probeMs: number; lists: HarnessCatalogProbe; startupMs?: number };

/** The real Claude Code adapter with a fake agent in place of its launch: it starts `startupMs` after its launch,
 * then streams its first token and ends, and its process is kept for the thread's next turn. Its version is the one
 * its lists name, and each launch is recorded with when it came. */
const fakeAgent =
  (agent: Agent, launches: { at: number; start: HarnessStartOptions }[]): HarnessAdapterFactory =>
  ctx => {
    const { sessionTitle: _read, titleFor: _make, ...claude } = HARNESS_ADAPTERS.claude(ctx);
    const startup = agent.startupMs ?? AGENT_STARTUP_MS;
    const session = (sessionId: string, onEvent: HarnessStartOptions["onEvent"]): HarnessSession => {
      const result = { status: "completed", text: "ok" } as const;
      const finished = (async () => {
        await new Promise(r => setTimeout(r, startup));
        onEvent({ type: "session.start", sessionId });
        onEvent({ type: "turn.delta", sessionId, kind: "text", text: "ok" });
        onEvent({ type: "turn.done", sessionId, result });
        return result;
      })();
      const kept: KeptAgent<HarnessSession> = { next: turn => session(sessionId, turn.onEvent), close: async () => {}, exited: new Promise(() => {}) };
      return { localId: sessionId, finished, interrupt: async () => {}, kept: () => kept };
    };
    return {
      ...claude,
      probeCatalog: () => new Promise(resolve => setTimeout(() => resolve(agent.lists), agent.probeMs)),
      probeVersion: async () => agent.lists.version,
      start: o => {
        launches.push({ at: Date.now(), start: o });
        return session(o.resume ?? `session-${launches.length}`, o.onEvent);
      },
    };
  };

let dir: string;
let home: string;
let bin: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-start-timing-"));
  home = join(dir, "home");
  bin = join(dir, "bin");
  for (const path of [home, bin]) mkdirSync(path, { recursive: true });
});
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A host on this computer over the given store, as `wsp up` makes one, with the fixture's folder first on PATH. */
function host(store: Store, claude: HarnessAdapterFactory): Runtime {
  const wiring = localWiring(home, { HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}` }, fakeDaemonStart, join(home, ".wsp", "state.json"), copyingFake());
  const rt = createRuntime({ backend: stubBackend(), store, adapters: { claude }, local: wiring });
  runtimes.push(rt);
  return rt;
}

async function stopped(rt: Runtime): Promise<void> {
  await rt.close();
  runtimes.splice(runtimes.indexOf(rt), 1);
}

/** One send, timed from the send: when the agent was launched, when the person was told it is starting, and when its
 * first token came. */
async function timedSend(rt: Runtime, workspaceId: string, launches: { at: number }[], requestId: string, thread?: string): Promise<{ launch: number; starting: number | undefined; firstToken: number; threadId: string }> {
  const at = Date.now();
  const launched = launches.length;
  let starting: number | undefined;
  let firstToken: number | undefined;
  const off = rt.events.on("*", (e: EventUnion) => {
    if (e.type === "session.starting" && e.requestId === requestId) starting ??= Date.now() - at;
    if (e.type === "session.delta") firstToken ??= Date.now() - at;
  });
  const handle = await rt.sessions.start(workspaceId, { prompt: "hello", requestId, ...(thread !== undefined ? { thread } : {}) });
  await handle.finished;
  off();
  return { launch: launches.length > launched ? launches.at(-1)!.at - at : Number.NaN, starting, firstToken: firstToken!, threadId: handle.view().threadId! };
}

describe("the time from a send to its agent", () => {
  it("says the agent is starting within a second of a send on a host that has run a while, and its first token comes within the agent's own startup plus a second", async () => {
    const launches: { at: number; start: HarnessStartOptions }[] = [];
    const rt = host(memoryStore(), fakeAgent({ probeMs: PROBE_MS, lists: LISTS }, launches));
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    await timedSend(rt, ws.id, launches, "req_warm");
    const later = await timedSend(rt, ws.id, launches, "req_later");
    expect(later.launch).toBeLessThan(1_000);
    expect(later.starting, "no starting line before the agent's session").toBeDefined();
    expect(later.starting!).toBeLessThan(1_000);
    expect(later.firstToken).toBeLessThan(AGENT_STARTUP_MS + 1_000);
  }, 30_000);

  it("launches the first send after a host start as soon, on the lists the host before it read, while the agent answers the same version", async () => {
    const store = memoryStore();
    const first = host(store, fakeAgent({ probeMs: 0, lists: LISTS }, []));
    const ws = await createOn(first, { on: HERE_PLACE_ID, name: "mac" });
    await timedSend(first, ws.id, [], "req_before");
    await stopped(first);

    const launches: { at: number; start: HarnessStartOptions }[] = [];
    const restarted = host(store, fakeAgent({ probeMs: PROBE_MS, lists: LISTS }, launches));
    const sent = await timedSend(restarted, ws.id, launches, "req_first");
    expect(sent.launch).toBeLessThan(1_000);
    expect(sent.starting!).toBeLessThan(1_000);
    expect(sent.firstToken).toBeLessThan(AGENT_STARTUP_MS + 1_000);
  }, 30_000);

  it("waits for the probe after the agent was updated between two hosts, and opens the new thread on the new default model", async () => {
    const store = memoryStore();
    const first = host(store, fakeAgent({ probeMs: 0, lists: LISTS }, []));
    const ws = await createOn(first, { on: HERE_PLACE_ID, name: "mac" });
    await timedSend(first, ws.id, [], "req_before");
    await stopped(first);

    const sonnet = { slug: "claude-sonnet-5-5", label: "Sonnet", contextWindows: ["200k"], isDefault: true };
    const updated: HarnessCatalogProbe = { ...LISTS, version: "2.1.300", models: [{ ...HAIKU, isDefault: false }, sonnet] };
    const launches: { at: number; start: HarnessStartOptions }[] = [];
    const restarted = host(store, fakeAgent({ probeMs: 500, lists: updated }, launches));
    const sent = await timedSend(restarted, ws.id, launches, "req_updated");
    expect(sent.launch, "launched before the probe answered").toBeGreaterThanOrEqual(500);
    expect(launches[0]!.start).toMatchObject({ model: "claude-sonnet-5-5", version: "2.1.300" });
  }, 30_000);

  it("says nothing on a send its thread's kept process takes, nor for an agent whose session starts at once", async () => {
    const launches: { at: number; start: HarnessStartOptions }[] = [];
    const rt = host(memoryStore(), fakeAgent({ probeMs: 0, lists: LISTS }, launches));
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const opened = await timedSend(rt, ws.id, launches, "req_open");
    expect(opened.starting).toBeDefined();
    const again = await timedSend(rt, ws.id, launches, "req_kept", opened.threadId);
    expect(launches, "the second send launched a process").toHaveLength(1);
    expect(again.starting).toBeUndefined();

    const instant = host(memoryStore(), fakeAgent({ probeMs: 0, lists: LISTS, startupMs: 0 }, []));
    const there = await createOn(instant, { on: HERE_PLACE_ID, name: "linux" });
    expect((await timedSend(instant, there.id, [], "req_instant")).starting).toBeUndefined();
  }, 30_000);
});

/** A claude on PATH whose version is the one its folder's version file says, and which launches a turn the way
 * Claude Code's stream-json does: before 2.1.270 it refuses --forward-subagent-text, as that CLI does. Each line it
 * was started with is logged beside it. */
function standIn(version: string): void {
  writeFileSync(join(bin, "version"), version);
  const models = '[{"value":"default","resolvedModel":"claude-haiku-5-5"},{"value":"claude-haiku-5-5","displayName":"Haiku","supportedEffortLevels":["low","high"]}]';
  writeStub(
    join(bin, "claude"),
    `#!/bin/sh
dir=$(dirname "$0")
version=$(cat "$dir/version")
echo "$*" >> "$dir/launches"
case " $* " in
  *" --version "*) echo "$version (Claude Code)"; exit 0 ;;
  *" --help "*) echo '--permission-mode <mode>  (choices: "default", "bypassPermissions")'; exit 0 ;;
  *" --bare "*) read -r _; echo '{"type":"control_response","response":{"subtype":"success","request_id":"init","response":{"models":${models}}}}'; exit 0 ;;
  *" --input-format stream-json "*) ;;
  *) exit 1 ;;
esac
case " $* " in *" --forward-subagent-text "*) [ "$version" = "2.1.250" ] && { echo "error: unknown option '--forward-subagent-text'" >&2; exit 1; } ;; esac
session=""; prev=""
for a in "$@"; do [ "$prev" = "--session-id" ] && session=$a; prev=$a; done
while IFS= read -r _; do
  printf '{"type":"system","subtype":"init","session_id":"%s","model":"claude-haiku-5-5","cwd":"/","tools":[]}\\n' "$session"
  printf '{"type":"assistant","session_id":"%s","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}\\n' "$session"
  printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"%s"}\\n' "$session"
done
`,
  );
}

describe("a claude updated between two hosts", () => {
  it("is launched with the flags the claude there takes, not the ones the lists from before name", async () => {
    const claude: HarnessAdapterFactory = ctx => {
      const { sessionTitle: _read, titleFor: _make, ...real } = HARNESS_ADAPTERS.claude(ctx);
      return real;
    };
    standIn("2.1.295");
    const store = memoryStore();
    const first = host(store, claude);
    const ws = await createOn(first, { on: HERE_PLACE_ID, name: "mac" });
    expect((await (await first.sessions.start(ws.id, { prompt: "hello", requestId: "req_before" })).finished).status).toBe("completed");
    await stopped(first);
    expect(readFileSync(join(bin, "launches"), "utf8")).toContain("--forward-subagent-text");

    standIn("2.1.250");
    writeFileSync(join(bin, "launches"), "");
    const restarted = host(store, claude);
    const turn = await (await restarted.sessions.start(ws.id, { prompt: "hello", requestId: "req_after" })).finished;
    const launched = readFileSync(join(bin, "launches"), "utf8").split("\n").filter(l => l.includes("--input-format stream-json") && !l.includes("--bare"));
    expect(launched).toHaveLength(1);
    expect(launched[0]).not.toContain("--forward-subagent-text");
    expect(turn).toMatchObject({ status: "completed", text: "ok" });
  }, 30_000);
});
