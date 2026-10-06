// SPDX-License-Identifier: AGPL-3.0-only
// An agent whose command is a wrapper that installs it on its first run, as
// Omarchy ships every agent: the readers name it as such without running it,
// and a send whose agent is still starting says so within seconds rather than
// waiting in silence for the download.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeHost, type Host } from "@wsp/collect";
import { HERE_PLACE_ID, type EventUnion } from "@wsp/protocol";
import { HARNESS_ADAPTERS, createRuntime, memoryStore, type HarnessAdapterFactory, type Runtime } from "@wsp/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsHere } from "../src/agents-here.js";
import { readAgents } from "../src/agents-reader.js";
import { localWiring } from "../src/cli.js";
import { stubBackend } from "./stub-backend.js";
import { copyingFake, createOn, fakeDaemonStart } from "./verbs-fixture.js";
import { writeStub } from "../../protocol/test/stub-script.js";

const SESSION = "55555555-5555-4555-8555-555555555555";

/** Omarchy's ~/.local/bin/claude, with one line that leaves a mark if anything runs it. */
const OMARCHY_WRAPPER = '#!/bin/bash\n: > "$HOME/wrapper-ran"\nexport MISE_MINIMUM_RELEASE_AGE=0\nmise use -g --quiet "claude" || exit 1\nexec mise x "claude" -- "claude" "$@"\n';

type Probe = NonNullable<ReturnType<HarnessAdapterFactory>["probeCatalog"]>;

/** The real Claude Code adapter with a scripted turn in place of its launch and no title questions, so what is timed
 * is the wait before the turn and the only thing that runs the agent's command is its catalog probe. `launched` holds
 * the turn's session back, as a wrapper's download holds the launch that runs it. */
const scripted =
  (probeCatalog?: Probe, launched: () => Promise<void> = async () => {}): HarnessAdapterFactory =>
  ctx => {
    const { sessionTitle: _read, titleFor: _make, ...claude } = HARNESS_ADAPTERS.claude(ctx);
    return {
      ...claude,
      ...(probeCatalog !== undefined ? { probeCatalog } : {}),
      start: ({ onEvent }) => {
        const result = { status: "completed", text: "ok" } as const;
        const finished = (async () => {
          await launched();
          onEvent({ type: "session.start", sessionId: SESSION });
          onEvent({ type: "turn.done", sessionId: SESSION, result });
          onEvent({ type: "session.end", sessionId: SESSION, exitCode: 0, sawResult: true });
          return result;
        })();
        return { localId: SESSION, finished, interrupt: async () => {} };
      },
    };
  };

let dir: string;
let home: string;
let bin: string;
let gate: string;
const runtimes: Runtime[] = [];
const opens: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wsp-first-run-"));
  home = join(dir, "home");
  bin = join(dir, "bin");
  gate = join(dir, "gate");
  for (const path of [home, bin]) mkdirSync(path, { recursive: true });
});
afterEach(async () => {
  for (const open of opens.splice(0)) open();
  writeFileSync(gate, "");
  for (const rt of runtimes.splice(0)) await rt.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Omarchy's wrapper at ~/.local/bin-like PATH folder, a file the readers read and nothing here runs. */
function omarchyWrapper(): void {
  const wrapperAt = join(bin, "claude");
  writeFileSync(wrapperAt, OMARCHY_WRAPPER, { mode: 0o755 });
}

/** ASCII's cloud image: a shim on PATH falling back to a launcher that runs lazy-run, here a stand-in that leaves a
 * mark and fails as the real one does when it cannot take its lock. The reads name it without running it. */
function asciiLazyRun(): void {
  const lib = join(dir, "ascii");
  const launcher = join(lib, "bin", "cursor-agent");
  const shimAt = join(bin, "cursor-agent");
  mkdirSync(join(lib, "bin"), { recursive: true });
  writeFileSync(join(lib, "lazy-run"), '#!/bin/sh\n: > "$HOME/lazy-ran"\necho "lazy-run: line 127: /var/lock/ascii-lazy-cursor.lock: Permission denied" >&2\nexit 1\n');
  writeFileSync(launcher, `#!/bin/sh\n# ascii-lazy-harness cursor\nexec ${lib}/lazy-run cursor cursor-agent "$@"\n`);
  writeFileSync(shimAt, `#!/bin/sh\n# ascii-harness-shim\nu=$(PATH=$(printf %s "$PATH" | tr : "\\n" | grep -vx ${bin} | paste -sd:) command -v cursor-agent 2>/dev/null)\n[ -n "$u" ] && exec "$u" "$@"\nexec ${launcher} "$@"\n`, { mode: 0o755 });
}

/** mise's own record of the tool once its first run installed it. */
function miseInstalled(): void {
  mkdirSync(join(home, ".local", "share", "mise", "installs", "claude", "2.1.289", "bin"), { recursive: true });
}

/** This computer's Host over the fixture: its home, and a PATH with the fixture's folder first. */
function here(): Host {
  const live = nodeHost();
  const path = `${bin}:/usr/bin:/bin`;
  return {
    ...live,
    home,
    exec: {
      which: async name => existsSync(join(bin, name)),
      run: (cmd, args, o) => live.exec.run(cmd, args, { ...o, env: { PATH: path, HOME: home, ...o?.env } }),
    },
  };
}

function runtime(adapter: HarnessAdapterFactory): Runtime {
  const wiring = localWiring(home, { HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}` }, fakeDaemonStart, join(home, ".wsp", "state.json"), copyingFake());
  const rt = createRuntime({ backend: stubBackend(), store: memoryStore(), adapters: { claude: adapter }, local: wiring });
  runtimes.push(rt);
  return rt;
}

/** Every session.starting and session.start the runtime pushes, each with how long after the send it came. */
function heard(rt: Runtime): { said: { e: Record<string, unknown>; after: number }[]; sent: () => void } {
  let at = Date.now();
  const said: { e: Record<string, unknown>; after: number }[] = [];
  rt.events.on("*", (e: EventUnion) => {
    const type = (e as { type: string }).type;
    if (type === "session.starting" || type === "session.start") said.push({ e: e as unknown as Record<string, unknown>, after: Date.now() - at });
  });
  return { said, sent: () => (at = Date.now()) };
}

describe("a send whose agent's first command is slow", () => {
  it("says the agent is starting within five seconds, before the turn has started, while the command still runs", async () => {
    // The command on PATH waits as a wrapper does while it downloads, then hands over to the agent.
    writeStub(join(bin, "claude-real"), "#!/bin/sh\necho '2.1.289 (Claude Code)'\n");
    writeStub(join(bin, "claude"), `#!/bin/sh\nwhile [ -d ${JSON.stringify(dir)} ] && [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.1; done\nexec "$(dirname "$0")/claude-real" "$@"\n`);
    const rt = runtime(scripted());
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const { said, sent } = heard(rt);
    sent();
    const started = rt.sessions.start(ws.id, { prompt: "hello", requestId: "req_1" });
    await vi.waitFor(() => expect(said.map(s => s.e["type"])).toContain("session.starting"), { timeout: 6_000, interval: 50 });
    const starting = said.find(s => s.e["type"] === "session.starting")!;
    expect(starting.after).toBeLessThan(5_000);
    expect(starting.e).toMatchObject({ workspaceId: ws.id, harness: "claude", requestId: "req_1" });
    expect(starting.e["installs"]).toBeUndefined();
    expect(said.map(s => s.e["type"])).toEqual(["session.starting"]);
    writeFileSync(gate, "");
    await (await started).finished;
    expect(said.map(s => s.e["type"])).toEqual(["session.starting", "session.start"]);
  }, 20_000);

  it("says the agent's first run installs it where its command is a wrapper that installs it, and not once it is installed", async () => {
    omarchyWrapper();
    // Where the wrapper is still to install, the start skips the probe and the launch is the wait; once installed, the
    // probe is asked and is the wait. Neither runs the wrapper here.
    const slowProbe = (): Promise<null> => new Promise(resolve => opens.push(() => resolve(null)));
    const slowLaunch = (): Promise<void> => new Promise(resolve => opens.push(resolve));
    for (const installed of [false, true]) {
      if (installed) miseInstalled();
      const rt = runtime(scripted(slowProbe, slowLaunch));
      const ws = await createOn(rt, { on: HERE_PLACE_ID, name: `mac-${String(installed)}` });
      const { said, sent } = heard(rt);
      sent();
      const started = rt.sessions.start(ws.id, { prompt: "hello", requestId: "req_2" });
      await vi.waitFor(() => expect(said.map(s => s.e["type"])).toContain("session.starting"), { timeout: 7_000, interval: 50 });
      const starting = said.find(s => s.e["type"] === "session.starting")!;
      expect(starting.after).toBeLessThan(5_000);
      expect(starting.e["installs"]).toBe(installed ? undefined : true);
      for (const open of opens.splice(0)) open();
      const handle = await started;
      for (const open of opens.splice(0)) open();
      await handle.finished;
    }
    expect(existsSync(join(home, "wrapper-ran")), "the wrapper ran").toBe(false);
  }, 30_000);

  it("says nothing when the agent starts in good time", async () => {
    const rt = runtime(scripted(async () => null));
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const { said } = heard(rt);
    await (await rt.sessions.start(ws.id, { prompt: "hello", requestId: "req_3" })).finished;
    await new Promise(r => setTimeout(r, 4_500));
    expect(said.map(s => s.e["type"])).toEqual(["session.start"]);
  }, 20_000);
});

describe("an agent whose command is a wrapper that installs it on its first run", () => {
  it("is named so by the agents report, with no version and no sign-in read off a command that would install it", async () => {
    omarchyWrapper();
    const read = await readAgents(here(), { user: "ada", vault: {} });
    const claude = read.agents.find(a => a.id === "claude")!;
    expect(claude).toMatchObject({ installed: true, installsOnFirstRun: true, signIn: "none" });
    expect(claude.version).toBeUndefined();
    expect(existsSync(join(home, "wrapper-ran")), "the wrapper ran").toBe(false);
  }, 20_000);

  it("is named so on the first-run screen's list, which runs nothing either", async () => {
    omarchyWrapper();
    const claude = (await agentsHere(here(), { versions: false })).find(a => a.id === "claude")!;
    expect(claude).toMatchObject({ found: true, installs: true });
    expect(existsSync(join(home, "wrapper-ran")), "the wrapper ran").toBe(false);
  }, 20_000);

  it("is started without the version probe, whose cut at its deadline would leave the download it began", async () => {
    omarchyWrapper();
    const rt = runtime(scripted());
    const ws = await createOn(rt, { on: HERE_PLACE_ID, name: "mac" });
    const { said } = heard(rt);
    await (await rt.sessions.start(ws.id, { prompt: "hello", requestId: "req_4" })).finished;
    expect(said.map(s => s.e["type"])).toContain("session.start");
    expect(existsSync(join(home, "wrapper-ran")), "the probe ran the wrapper").toBe(false);
  }, 20_000);

  it("reads as installed once its first run put the agent there", async () => {
    omarchyWrapper();
    miseInstalled();
    const claude = (await agentsHere(here(), { versions: false })).find(a => a.id === "claude")!;
    expect(claude.found).toBe(true);
    expect(claude.installs).toBeUndefined();
  }, 20_000);
});

describe("an ASCII lazy-run shim, the second installer wsp knows", () => {
  it("is named so by the agents report, and nothing runs lazy-run to ask its version", async () => {
    asciiLazyRun();
    const cursor = (await readAgents(here(), { user: "ada", vault: {} })).agents.find(a => a.id === "cursor")!;
    expect(cursor).toMatchObject({ installed: true, installsOnFirstRun: true });
    expect(cursor.version).toBeUndefined();
    expect(existsSync(join(home, "lazy-ran")), "lazy-run ran").toBe(false);
  }, 20_000);
});

describe("an agent whose --version exits non-zero", () => {
  it("has no version and says it could not be read, and its error is in no cell", async () => {
    writeStub(join(bin, "codex"), '#!/bin/sh\necho "codex: line 3: /var/lock/codex.lock: Permission denied" >&2\nexit 1\n');
    const codex = (await readAgents(here(), { user: "ada", vault: {} })).agents.find(a => a.id === "codex")!;
    expect(codex).toMatchObject({ installed: true, versionUnread: true });
    expect(codex.version).toBeUndefined();
    expect(JSON.stringify(codex)).not.toContain("Permission denied");
  }, 20_000);
});
