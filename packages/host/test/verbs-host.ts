// SPDX-License-Identifier: AGPL-3.0-only
// The host every wsp verbs file runs its cases against, over the fake runtime, and the fixtures they share.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { type fakeCopier, type MachineBackend } from "@wsp/engine";
import { type AgentRow, type ProjectView, type DaemonErrorCode, HERE_PLACE_ID, type HarnessCatalogAnswer } from "@wsp/protocol";
import { copyKey, createRuntime, memoryStore, type AgentsReader, type DaemonChannel, type HarnessAdapterFactory, type PlaceBackends, type Runtime, type Store } from "@wsp/runtime";
import { afterEach, beforeEach, vi } from "vitest";
import { cli, localWiring, serve } from "../src/cli.js";
import { placeWiring } from "../src/places.js";
import type { HostHandle } from "../src/server.js";
import { type RestartRoad } from "../src/restart.js";
import { SEALED_GOLDEN } from "./sealed-golden.js";
import { stubBackend, type StubBackend } from "./stub-backend.js";
import { copyingFake, fakeDaemonStart, projectOn, PAGE, captured, scriptedAgent, type Captured } from "./verbs-fixture.js";

/** Every fact of a pull request a read answers but its number, link, state and host, which each case names. */
const PR_REST: Omit<import("@wsp/protocol").PullRequest, "number" | "url" | "state" | "host"> = { draft: false, base: "main", branch: "work", headOid: "abc1234", headSubject: "Do the work", mergeable: "unknown", mergeState: "unknown", review: "none", checks: [], additions: 1, deletions: 0, changedFiles: 1, commits: 1 };

/** A daemon inside a workspace that answers the two frames a bring back sends, so the verb's own line is read here
 * without a machine: the push, then the pull request or the sentence that says none was opened. */
function fakeGitDaemon(): { open: () => Promise<DaemonChannel>; pr: { refuse?: { error: string; code?: DaemonErrorCode } } } {
  const state: { refuse?: { error: string; code?: DaemonErrorCode } } = {};
  return {
    pr: state,
    open: async () => ({
      send: async (frame: { op: string; branch?: string }) => {
        // A source a fork is made from reads as on its own branch, tracked and level with the remote, and the fork's copy is
        // put on it.
        if (frame.op === "git.status") return { id: 1, ok: true, branch: { oid: "abc", head: "work", upstream: "origin/work", ahead: 0, behind: 0 }, entries: [], root: "/root/stub" };
        if (frame.op === "git.startOn") return { id: 1, ok: true, branch: frame.branch, oid: "c0ffee" };
        if (frame.op === "git.push") {
          return { id: 1, ok: true, branch: "pricing-page", base: "main", remote: "origin", ahead: 2, uncommitted: 1, stat: [" src/page.tsx | 4 ++--", " 1 file changed, 2 insertions(+), 2 deletions(-)"] };
        }
        if (state.refuse !== undefined) return { id: 1, ok: false as const, ...state.refuse };
        return { id: 1, ok: true, pr: { number: 12, url: "https://github.com/o/r/pull/12", state: "open", host: "github.com", ...PR_REST }, created: true };
      },
      close: () => {},
      // Nothing here ends of its own: the runtime closes the channel when the verb it opened it for is done.
      closed: new Promise(() => {}),
    }),
  };
}

/** This computer, as the places list names it: the word a person types after --on for the place their own agents
 * run on, which is the road wsp new --local used to take. */
const HERE = hostname().toLowerCase();

/** The fingerprint a pairing pinned, which every record written since wsp pinned keys carries. */
const HOST_KEY = "SHA256:MVm4EO/x4dkERU6dZOt1s4N04aW619pwoUo/9Qpz40A";

/** What the codex here asks its machine; the stub guest answers nothing to it unless a test puts a catalog there, and
 * on this computer's own workspace it names no agent's command, so it runs none. */
const PROBE_CMD = "wsp-stub-codex --describe";

/** An agent whose binary can be made to answer: its probe reads the machine's stdout as the answer itself, so a test
 * can put a machine's own catalog in front of the verbs. Nothing on the guest answers by default, which leaves the
 * runtime's table standing, exactly as an adapter with no probe at all does. */
const probing =
  (factory: HarnessAdapterFactory): HarnessAdapterFactory =>
  ctx => ({ ...factory(ctx), probeCatalog: exec => exec(PROBE_CMD).then(out => (out.trim() === "" ? null : (JSON.parse(out) as HarnessCatalogAnswer))) });

/** This computer's agents as a read finds them, two rows and nothing else, so a setup's answer has a row to carry. */
const agentRowHere = (id: string, name: string): AgentRow => ({ id, name, installed: true, version: "1.0.0", road: "own", signIn: "signed-in", signInRoad: "device", wspTools: false });
const AGENTS_HERE: AgentsReader = {
  read: async () => ({ home: "/Users/ada", user: "ada", agents: [agentRowHere("claude", "Claude Code"), agentRowHere("codex", "Codex")], skills: [], servers: [], refused: [] }),
  tools: async () => ({ auth: "open", readAt: "2026-10-01T12:00:00.000Z" }),
};

/** The host a verbs file's cases run against, stood up again before each case. Called once at the top of the
 * file's describe, so its hooks run inside that describe; the state reads through `h`, whose fields follow the
 * case that is running. */
export function verbsHost() {
  let dir: string;
  let statePath: string;
  let backend: StubBackend;
  let store: Store;
  /** The copy road this host is wired with: a stand-in, so a second piece of work on a project here is a copy the
   * case can read back and nothing on this machine is actually cloned. */
  let copier: ReturnType<typeof fakeCopier>;
  let rt: Runtime;
  let handle: HostHandle | undefined;
  let claude: ReturnType<typeof scriptedAgent>;
  let codex: ReturnType<typeof scriptedAgent>;
  /** The environment every verb here runs with: this file's, never the shell that started the run, so a builder with
   * WSP_TURN exported does not have every start refused. A case that means a turn writes that turn's token into it. */
  let env: Record<string, string | undefined>;
  let daemon: ReturnType<typeof fakeGitDaemon>;

  beforeEach(async () => {
    asked.length = 0;
    env = {};
    dir = mkdtempSync(join(tmpdir(), "wsp-verbs-"));
    const webDir = join(dir, "web");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "app.js"), "console.log('app')\n");
    writeFileSync(join(webDir, "index.html"), PAGE);
    statePath = join(dir, "state", "state.json");
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    vi.stubEnv("HOME", join(dir, "user"));
    vi.stubEnv("WSP_HOME", join(dir, "home"));
    backend = stubBackend();
    store = memoryStore();
    copier = copyingFake();
    await store.put("goldens", copyKey("default", "default"), SEALED_GOLDEN);
    claude = scriptedAgent(prompt => (prompt === "die" ? "" : `re: ${prompt}`));
    codex = scriptedAgent(prompt => `codex: ${prompt}`);
    daemon = fakeGitDaemon();
    rt = createRuntime({ statePath, backend, store, adapters: { claude: claude.adapter, codex: probing(codex.adapter) }, local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, statePath, copier), placeLinks: placeWiring(statePath), daemonChannel: daemon.open, agentsReader: AGENTS_HERE });
    handle = await serve(captured(), { port: 0, statePath, webDir, runtime: rt });
    // A workspace is one project's copy, so every line that makes one needs a project first; one project here, so
    // wsp new takes the work alone.
    cloud = await projectOn(rt);
    // The host has its keys; the verbs never read any.
    vi.stubEnv("SOLARI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A verb still in flight: its io is readable while it runs, so a test can wait on a line it has already printed.
   * --state goes before any `--`, where exec's command begins. */
  function starting(...argv: string[]): { io: Captured; ended: Promise<number> } {
    const io = captured();
    const cut = argv.indexOf("--");
    const at = cut === -1 ? argv.length : cut;
    return { io, ended: cli([...argv.slice(0, at), "--state", statePath, ...argv.slice(at)], io, undefined, env) };
  }
  async function run(...argv: string[]): Promise<{ code: number; io: Captured }> {
    if (argv[0] === "new") return made(argv.slice(1));
    const { io, ended } = starting(...argv);
    return { code: await ended, io };
  }
  /** A machine on a box, or a project folder's record here, made the way the app makes one: the command line has no
   * verb that makes one, and the cases that need one stand it up through the runtime with the words they used to type. */
  async function made(words: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    const flags = new Map<string, string | true>();
    const named: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i]!;
      if (!word.startsWith("--")) named.push(word);
      else if (["--engine", "--json"].includes(word) || words[i + 1] === undefined) flags.set(word.slice(2), true);
      else flags.set(word.slice(2), words[++i]!);
    }
    const [projectWord, name] = named.length === 2 ? named : [undefined, named[0]!];
    try {
      const projects = await rt.projects.list();
      const project = projectWord === undefined ? projects.find(p => p.computer !== HERE_PLACE_ID) : projects.find(p => p.name === projectWord || p.id === projectWord);
      if (project === undefined) throw new Error(`no project "${projectWord ?? ""}"`);
      const size = typeof flags.get("size") === "string" ? (flags.get("size") as string).split("x").map(Number) : undefined;
      const spawn = flags.get("spawn");
      const cap = flags.get("max-machines");
      const agents = spawn === undefined && cap === undefined ? undefined : { ...(typeof spawn === "string" ? { spawn: spawn === "on" } : {}), ...(typeof cap === "string" ? { maxMachines: Number(cap) } : {}) };
      const from = flags.get("from");
      const golden = project.computer === HERE_PLACE_ID ? undefined : typeof from === "string" ? from : SEALED_GOLDEN.versions.find(v => v.version === SEALED_GOLDEN.head)!.snapshotId;
      const ws = await rt.workspaces.create({
        project: project.id,
        name,
        ...(golden !== undefined ? { golden } : {}),
        ...(size !== undefined ? { cpu: size[0]!, memMb: size[1]! * 1024 } : {}),
        ...(flags.get("engine") === true ? { engine: true } : {}),
        ...(agents !== undefined ? { agents } : {}),
      });
      io.lines.push(flags.get("json") === true ? JSON.stringify(ws) : `created ${ws.name} ${ws.id}`);
      return { code: 0, io };
    } catch (e) {
      io.errors.push(e instanceof Error ? e.message : String(e));
      return { code: 1, io };
    }
  }
  /** The project on the computer this host forks at, recorded for every case: one project, so wsp new takes the
   * work alone until a case records a second. */
  let cloud: ProjectView;

  /** A project on this computer and its workspace: a workspace here is a copy of a folder of the person's, so a
   * test that wants one records a repo of its own first. */
  async function macProject(name: string): Promise<{ code: number; io: Captured; folder: string }> {
    const folder = realpathSync(mkdtempSync(join(dir, `repo-${name}-`)));
    execFileSync("git", ["init", "-q", folder]);
    const project = await projectOn(rt, HERE_PLACE_ID, folder, { name });
    return { ...(await run("new", project.name, name)), folder };
  }

  /** A line exactly as it was typed, with nothing moved or added: where a shared flag sits is the question here, so
   * the helpers that put --state at the end are no use. */
  async function typed(...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    return { code: await cli(argv, io, undefined, env), io };
  }
  const json = (io: Captured): unknown[] => io.lines.map(l => JSON.parse(l) as unknown);
  /** A verb run with a person at the keyboard: every question it asks is recorded and answered with reply. */
  const asked: string[] = [];
  async function answer(reply: string, ...argv: string[]): Promise<{ code: number; io: Captured }> {
    const io = captured();
    io.isTTY = true;
    io.ask = async q => {
      asked.push(q);
      return reply;
    };
    return { code: await cli([...argv, "--state", statePath], io, undefined, env), io };
  }
  const head = (m: typeof SEALED_GOLDEN) => m.versions.find(v => v.version === m.head)!;
  /** An image record with a vault of `bytes`, for the export roads; the hashes are plainly fake. */
  const RECORD = (bytes: number) => ({ name: "default", version: 1, hash: "a".repeat(64), recipeHash: "rh", logins: [{ name: "codex", state: "copied" as const }], sealedAt: "2026-09-12T00:00:00.000Z", sealedFrom: "h1", vault: { sha256: "b".repeat(64), bytes, paths: 2, takenAt: "2026-09-12T00:00:00.000Z" } });

  /** The host again on the same state file, over a runtime with these adapters; the verbs still see no key. */
  async function restartHost(adapters: Parameters<typeof createRuntime>[0]["adapters"], over: Store = store, places?: PlaceBackends, wired: MachineBackend = backend, restart?: RestartRoad): Promise<void> {
    await handle?.close();
    handle = undefined;
    rt = createRuntime({ statePath, backend: wired, store: over, adapters, local: localWiring(join(dir, "user"), process.env, fakeDaemonStart, statePath, copier), placeLinks: placeWiring(statePath), daemonChannel: daemon.open, ...(places !== undefined ? { places } : {}) });
    vi.stubEnv("SOLARI_API_KEY", "slr_live_fake_verbs_key");
    handle = await serve(captured(), { port: 0, statePath, webDir: join(dir, "web"), runtime: rt, ...(restart !== undefined ? { restart } : {}) });
    vi.stubEnv("SOLARI_API_KEY", "");
    // A restart on a fresh store holds no project, and a workspace is one project's copy; one that kept the store
    // keeps the project it already had, since a second would make every wsp new ambiguous.
    const held = await rt.projects.list();
    cloud = held[0] ?? (await projectOn(rt));
  }

  return {
    get dir() {
      return dir;
    },
    get statePath() {
      return statePath;
    },
    get backend() {
      return backend;
    },
    get store() {
      return store;
    },
    get copier() {
      return copier;
    },
    get rt() {
      return rt;
    },
    set rt(value) {
      rt = value;
    },
    get handle() {
      return handle;
    },
    set handle(value) {
      handle = value;
    },
    get claude() {
      return claude;
    },
    get codex() {
      return codex;
    },
    get env() {
      return env;
    },
    get daemon() {
      return daemon;
    },
    starting,
    run,
    made,
    get cloud() {
      return cloud;
    },
    macProject,
    typed,
    json,
    asked,
    answer,
    head,
    RECORD,
    restartHost,
  };
}

export { PR_REST, fakeGitDaemon, HERE, HOST_KEY, PROBE_CMD, probing, agentRowHere, AGENTS_HERE };
